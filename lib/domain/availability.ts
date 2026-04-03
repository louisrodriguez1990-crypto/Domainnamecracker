import type { AvailabilityResult } from "@/lib/domain/types";

type FetchLike = typeof fetch;
type RdapBootstrap = {
  services: Array<[string[], string[]]>;
};

type ProviderFactoryOptions = {
  fetchImpl?: FetchLike;
};

type RdapClassification = Omit<AvailabilityResult, "domain" | "checkedAt" | "provider">;

type NameComZonePayload = {
  results?: Array<{
    domainName?: string;
    available?: boolean;
  }>;
  total?: number;
  removed?: number;
};

type NameComAvailabilityPayload = {
  results?: Array<{
    domainName?: string;
    purchasable?: boolean;
    premium?: boolean;
    purchasePrice?: number;
    purchaseType?: string;
    renewalPrice?: number;
    reason?: string;
  }>;
};

const NAMECOM_DEFAULT_BASE_URL = "https://api.name.com";
const NAMECOM_BURST_LIMIT = 20;
const NAMECOM_HOURLY_LIMIT = 3_000;
const SECOND_WINDOW_MS = 1_000;
const HOUR_WINDOW_MS = 60 * 60 * 1000;

export const NAMECOM_ZONE_BATCH_SIZE = 500;
export const NAMECOM_CHECK_BATCH_SIZE = 50;
export const NAMECOM_PRELIMINARY_TTL_MS = 18 * 60 * 60 * 1000;

export interface AvailabilityProvider {
  readonly name: string;
  checkDomain(domain: string): Promise<AvailabilityResult>;
  checkDomains?(domains: string[]): Promise<AvailabilityResult[]>;
  screenDomains?(domains: string[]): Promise<AvailabilityResult[]>;
}

export interface HybridAvailabilityProvider extends AvailabilityProvider {
  checkDomains(domains: string[]): Promise<AvailabilityResult[]>;
  screenDomains(domains: string[]): Promise<AvailabilityResult[]>;
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

class RollingWindowRateLimiter {
  private readonly secondWindow: number[] = [];
  private readonly hourWindow: number[] = [];

  async waitForSlot() {
    while (true) {
      const now = Date.now();
      this.prune(now);

      const secondDelayMs =
        this.secondWindow.length >= NAMECOM_BURST_LIMIT
          ? SECOND_WINDOW_MS - (now - this.secondWindow[0]!)
          : 0;
      const hourDelayMs =
        this.hourWindow.length >= NAMECOM_HOURLY_LIMIT
          ? HOUR_WINDOW_MS - (now - this.hourWindow[0]!)
          : 0;
      const waitMs = Math.max(secondDelayMs, hourDelayMs, 0);

      if (waitMs <= 0) {
        this.secondWindow.push(now);
        this.hourWindow.push(now);
        return;
      }

      await sleep(waitMs);
    }
  }

  private prune(now: number) {
    while (
      this.secondWindow.length > 0 &&
      now - this.secondWindow[0]! >= SECOND_WINDOW_MS
    ) {
      this.secondWindow.shift();
    }

    while (
      this.hourWindow.length > 0 &&
      now - this.hourWindow[0]! >= HOUR_WINDOW_MS
    ) {
      this.hourWindow.shift();
    }
  }
}

declare global {
  var __domainHunterNameComRateLimiter: RollingWindowRateLimiter | undefined;
}

function getNameComRateLimiter() {
  if (!global.__domainHunterNameComRateLimiter) {
    global.__domainHunterNameComRateLimiter = new RollingWindowRateLimiter();
  }

  return global.__domainHunterNameComRateLimiter;
}

function toUnknownBatchResults(
  domains: string[],
  provider: string,
  note: string,
  checkedAt: string,
  retryAfterMs: number | null = null,
  stage: AvailabilityResult["stage"] = "definitive",
): AvailabilityResult[] {
  return domains.map((domain) => ({
    domain,
    status: "unknown",
    provider,
    checkedAt,
    confidence: retryAfterMs ? 0.2 : 0.18,
    note,
    stage,
    retryAfterMs,
  }));
}

function normalizeBaseUrl(baseUrl: string | undefined) {
  const trimmed = baseUrl?.trim();

  if (!trimmed) {
    return NAMECOM_DEFAULT_BASE_URL;
  }

  return trimmed.replace(/\/+$/, "");
}

async function readResponsePayload(response: Response) {
  const contentType = response.headers.get("content-type") ?? "";

  if (contentType.includes("json")) {
    return response.json().catch(() => null);
  }

  return response.text().catch(() => null);
}

function extractNameComError(payload: unknown, fallback: string) {
  if (!payload || typeof payload !== "object") {
    return fallback;
  }

  const message = (payload as { message?: string }).message?.trim();
  const details = (payload as { details?: string }).details?.trim();

  if (message && details) {
    return `${message}: ${details}`;
  }

  return message ?? details ?? fallback;
}

function formatMoney(value: number | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }

  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(value);
}

function formatPurchasableNote(result: NonNullable<NameComAvailabilityPayload["results"]>[number]) {
  const parts = ["Name.com says the domain is purchasable."];
  const purchasePrice = formatMoney(result.purchasePrice);
  const renewalPrice = formatMoney(result.renewalPrice);

  if (purchasePrice) {
    parts.push(`Purchase ${purchasePrice}.`);
  }

  if (renewalPrice) {
    parts.push(`Renewal ${renewalPrice}.`);
  }

  if (result.premium) {
    parts.push("Premium listing.");
  }

  if (result.purchaseType) {
    parts.push(`Type: ${result.purchaseType}.`);
  }

  return parts.join(" ");
}

function buildPreliminaryExpiry(checkedAt: string) {
  return new Date(
    new Date(checkedAt).getTime() + NAMECOM_PRELIMINARY_TTL_MS,
  ).toISOString();
}

function mapByDomain<T extends { domainName?: string }>(items: T[] | undefined) {
  return new Map(
    (items ?? [])
      .filter((item) => typeof item.domainName === "string")
      .map((item) => [item.domainName!.toLowerCase(), item] as const),
  );
}

export function createNameComAuthorizationHeader(username: string, token: string) {
  return `Basic ${Buffer.from(`${username}:${token}`).toString("base64")}`;
}

export function classifyNameComZonePayload(
  domains: string[],
  payload: unknown,
  checkedAt = new Date().toISOString(),
): AvailabilityResult[] {
  const resultsByDomain = mapByDomain((payload as NameComZonePayload | null)?.results);

  return domains.map((domain) => {
    const result = resultsByDomain.get(domain.toLowerCase());

    if (!result || typeof result.available !== "boolean") {
      return {
        domain,
        status: "unknown",
        provider: "namecom-core",
        checkedAt,
        confidence: 0.24,
        note: "Name.com zone check did not return a usable result for this domain.",
        stage: "preliminary",
      } satisfies AvailabilityResult;
    }

    if (result.available) {
      return {
        domain,
        status: "available",
        provider: "namecom-core",
        checkedAt,
        confidence: 0.82,
        note: "Name.com zone check suggests the domain may be available.",
        stage: "preliminary",
      } satisfies AvailabilityResult;
    }

    return {
      domain,
      status: "taken",
      provider: "namecom-core",
      checkedAt,
      confidence: 0.78,
      note: "Name.com zone check found the domain in cached zone data.",
      stage: "preliminary",
      expiresAt: buildPreliminaryExpiry(checkedAt),
    } satisfies AvailabilityResult;
  });
}

export function classifyNameComAvailabilityPayload(
  domains: string[],
  payload: unknown,
  checkedAt = new Date().toISOString(),
): AvailabilityResult[] {
  const resultsByDomain = mapByDomain(
    (payload as NameComAvailabilityPayload | null)?.results,
  );

  return domains.map((domain) => {
    const result = resultsByDomain.get(domain.toLowerCase());

    if (!result || typeof result.purchasable !== "boolean") {
      return {
        domain,
        status: "unknown",
        provider: "namecom-core",
        checkedAt,
        confidence: 0.22,
        note: "Name.com check availability did not return a usable result for this domain.",
        stage: "definitive",
      } satisfies AvailabilityResult;
    }

    if (result.purchasable) {
      return {
        domain,
        status: "available",
        provider: "namecom-core",
        checkedAt,
        confidence: 0.99,
        note: formatPurchasableNote(result),
        stage: "definitive",
      } satisfies AvailabilityResult;
    }

    return {
      domain,
      status: "taken",
      provider: "namecom-core",
      checkedAt,
      confidence: 0.97,
      note:
        result.reason?.trim() ||
        "Name.com says the domain is not currently purchasable.",
      stage: "definitive",
    } satisfies AvailabilityResult;
  });
}

export function parseRetryAfterHeader(value: string | null, nowMs = Date.now()) {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();

  if (!trimmed) {
    return null;
  }

  const seconds = Number(trimmed);

  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }

  const retryAt = Date.parse(trimmed);

  if (!Number.isNaN(retryAt)) {
    return Math.max(retryAt - nowMs, 0);
  }

  return null;
}

function extractRdapNote(payload: unknown, fallback: string): string {
  if (!payload || typeof payload !== "object") {
    return fallback;
  }

  const description = Array.isArray((payload as { description?: unknown }).description)
    ? (payload as { description: string[] }).description.join(" ")
    : null;

  return (
    (payload as { title?: string }).title ??
    description ??
    (payload as { errorCode?: number }).errorCode?.toString() ??
    fallback
  );
}

export function classifyRdapPayload(
  responseStatus: number,
  payload: unknown,
  retryAfterMs: number | null = null,
): RdapClassification {
  if (responseStatus === 404 || responseStatus === 410 || responseStatus === 204) {
    return {
      status: "available",
      confidence: 0.92,
      note: extractRdapNote(payload, "RDAP returned a not found response."),
      stage: "definitive",
    };
  }

  if (responseStatus === 429) {
    return {
      status: "unknown",
      confidence: 0.2,
      note: extractRdapNote(payload, "RDAP rate limited the request."),
      stage: "definitive",
      retryAfterMs: retryAfterMs ?? 60_000,
    };
  }

  if (responseStatus >= 500) {
    return {
      status: "unknown",
      confidence: 0.28,
      note: "RDAP returned a server error.",
      stage: "definitive",
      retryAfterMs,
    };
  }

  if (
    responseStatus >= 200 &&
    responseStatus < 300 &&
    payload &&
    typeof payload === "object" &&
    ("ldhName" in payload || "objectClassName" in payload)
  ) {
    return {
      status: "taken",
      confidence: 0.96,
      note: "RDAP returned an active domain object.",
      stage: "definitive",
    };
  }

  if (
    payload &&
    typeof payload === "object" &&
    (payload as { errorCode?: number }).errorCode === 404
  ) {
    return {
      status: "available",
      confidence: 0.88,
      note: extractRdapNote(payload, "RDAP payload reports domain not found."),
      stage: "definitive",
    };
  }

  return {
    status: "unknown",
    confidence: 0.35,
    note: extractRdapNote(payload, "RDAP returned an unexpected response."),
    stage: "definitive",
  };
}

class NameComProvider implements HybridAvailabilityProvider {
  readonly name = "namecom-core";
  private readonly fetchImpl: FetchLike;
  private readonly authorization: string;
  private readonly baseUrl: string;
  private readonly rateLimiter = getNameComRateLimiter();

  constructor(options: {
    fetchImpl: FetchLike;
    username: string;
    token: string;
    baseUrl?: string;
  }) {
    this.fetchImpl = options.fetchImpl;
    this.authorization = createNameComAuthorizationHeader(
      options.username,
      options.token,
    );
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
  }

  async checkDomain(domain: string) {
    const [result] = await this.checkDomains([domain]);

    return (
      result ??
      {
        domain,
        status: "unknown",
        provider: this.name,
        checkedAt: new Date().toISOString(),
        confidence: 0.12,
        note: "Name.com did not return a result for this domain.",
        stage: "definitive",
      }
    );
  }

  async screenDomains(domains: string[]) {
    return this.requestZoneCheck(domains);
  }

  async checkDomains(domains: string[]) {
    return this.requestCheckAvailability(domains);
  }

  private async requestZoneCheck(domains: string[]) {
    return this.postNameComBatch(
      "/core/v1/zonecheck",
      domains,
      NAMECOM_ZONE_BATCH_SIZE,
      "preliminary",
      classifyNameComZonePayload,
      "Name.com zone check",
    );
  }

  private async requestCheckAvailability(domains: string[]) {
    return this.postNameComBatch(
      "/core/v1/domains:checkAvailability",
      domains,
      NAMECOM_CHECK_BATCH_SIZE,
      "definitive",
      classifyNameComAvailabilityPayload,
      "Name.com check availability",
    );
  }

  private async postNameComBatch(
    path: string,
    domains: string[],
    maxBatchSize: number,
    stage: AvailabilityResult["stage"],
    classify: (
      domains: string[],
      payload: unknown,
      checkedAt?: string,
    ) => AvailabilityResult[],
    label: string,
  ) {
    if (domains.length === 0) {
      return [];
    }

    if (domains.length > maxBatchSize) {
      throw new Error(`${label} accepts at most ${maxBatchSize} domains per request.`);
    }

    await this.rateLimiter.waitForSlot();

    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: {
        authorization: this.authorization,
        "content-type": "application/json",
      },
      body: JSON.stringify({ domainNames: domains }),
      cache: "no-store",
    });
    const checkedAt = new Date().toISOString();
    const retryAfterMs = parseRetryAfterHeader(response.headers.get("retry-after"));
    const payload = await readResponsePayload(response);

    if (!response.ok) {
      const note = extractNameComError(
        payload,
        `${label} returned status ${response.status}.`,
      );

      return toUnknownBatchResults(
        domains,
        this.name,
        note,
        checkedAt,
        response.status === 429 ? retryAfterMs ?? 60_000 : retryAfterMs,
        stage,
      );
    }

    return classify(domains, payload, checkedAt);
  }
}

class BootstrapRdapProvider implements AvailabilityProvider {
  readonly name = "iana-rdap";
  private readonly fetchImpl: FetchLike;
  private bootstrapPromise: Promise<Map<string, string[]>> | null = null;
  private bootstrapExpiresAt = 0;

  constructor(fetchImpl: FetchLike) {
    this.fetchImpl = fetchImpl;
  }

  private async getBootstrap(): Promise<Map<string, string[]>> {
    const now = Date.now();

    if (this.bootstrapPromise && now < this.bootstrapExpiresAt) {
      return this.bootstrapPromise;
    }

    this.bootstrapExpiresAt = now + 1000 * 60 * 60 * 12;
    this.bootstrapPromise = this.fetchImpl("https://data.iana.org/rdap/dns.json", {
      headers: {
        accept: "application/json",
      },
      cache: "no-store",
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`RDAP bootstrap failed with status ${response.status}.`);
        }

        const payload = (await response.json()) as RdapBootstrap;
        const services = new Map<string, string[]>();

        for (const [tlds, urls] of payload.services ?? []) {
          for (const tld of tlds) {
            services.set(tld.toLowerCase(), urls);
          }
        }

        return services;
      })
      .catch((error) => {
        this.bootstrapPromise = null;
        this.bootstrapExpiresAt = 0;
        throw error;
      });

    return this.bootstrapPromise;
  }

  async checkDomain(domain: string): Promise<AvailabilityResult> {
    const checkedAt = new Date().toISOString();
    const tld = domain.split(".").pop()?.toLowerCase();

    if (!tld) {
      return {
        domain,
        status: "unknown",
        provider: this.name,
        checkedAt,
        confidence: 0,
        note: "Unable to determine the top-level domain.",
        stage: "definitive",
      };
    }

    const bootstrap = await this.getBootstrap();
    const baseUrls = bootstrap.get(tld);

    if (!baseUrls || baseUrls.length === 0) {
      return {
        domain,
        status: "unknown",
        provider: this.name,
        checkedAt,
        confidence: 0.1,
        note: `No RDAP service is published for .${tld}.`,
        stage: "definitive",
      };
    }

    for (const baseUrl of baseUrls) {
      const response = await this.fetchImpl(new URL(`domain/${domain}`, baseUrl), {
        headers: {
          accept: "application/rdap+json, application/json",
        },
        cache: "no-store",
      });
      const payload = await readResponsePayload(response);
      const retryAfterMs = parseRetryAfterHeader(response.headers.get("retry-after"));
      const classification = classifyRdapPayload(
        response.status,
        payload,
        retryAfterMs,
      );

      if (
        classification.status !== "unknown" ||
        response.status < 500 ||
        classification.retryAfterMs
      ) {
        return {
          domain,
          provider: this.name,
          checkedAt,
          ...classification,
        };
      }
    }

    return {
      domain,
      status: "unknown",
      provider: this.name,
      checkedAt,
      confidence: 0.22,
      note: "All RDAP endpoints failed to return a usable result.",
      stage: "definitive",
    };
  }
}

class ExternalRegistrarProvider implements AvailabilityProvider {
  readonly name = "external-registrar";
  private readonly fetchImpl: FetchLike;
  private readonly url: string;
  private readonly token: string | undefined;

  constructor(fetchImpl: FetchLike, url: string, token?: string) {
    this.fetchImpl = fetchImpl;
    this.url = url;
    this.token = token;
  }

  async checkDomain(domain: string): Promise<AvailabilityResult> {
    const response = await this.fetchImpl(this.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      },
      body: JSON.stringify({ domain }),
      cache: "no-store",
    });
    const retryAfterMs = parseRetryAfterHeader(response.headers.get("retry-after"));

    if (!response.ok) {
      return {
        domain,
        status: "unknown",
        provider: this.name,
        checkedAt: new Date().toISOString(),
        confidence: 0.16,
        note:
          response.status === 429
            ? "External registrar rate limited the request."
            : `External registrar returned status ${response.status}.`,
        stage: "definitive",
        retryAfterMs:
          response.status === 429
            ? retryAfterMs ?? 60_000
            : retryAfterMs,
      };
    }

    const payload = (await response.json()) as Partial<AvailabilityResult>;

    return {
      domain,
      status: payload.status ?? "unknown",
      provider: payload.provider ?? this.name,
      checkedAt: payload.checkedAt ?? new Date().toISOString(),
      confidence: payload.confidence ?? 0.5,
      note: payload.note ?? "External registrar response.",
      stage: payload.stage ?? "definitive",
      expiresAt: payload.expiresAt ?? null,
      retryAfterMs: payload.retryAfterMs ?? retryAfterMs,
    };
  }
}

export function isHybridAvailabilityProvider(
  provider: AvailabilityProvider,
): provider is HybridAvailabilityProvider {
  return (
    typeof provider.screenDomains === "function" &&
    typeof provider.checkDomains === "function"
  );
}

export async function checkDomainsWithProvider(
  provider: AvailabilityProvider,
  domains: string[],
) {
  if (typeof provider.checkDomains === "function") {
    return provider.checkDomains(domains);
  }

  return Promise.all(domains.map((domain) => provider.checkDomain(domain)));
}

export function createAvailabilityProvider(
  options: ProviderFactoryOptions = {},
): AvailabilityProvider {
  const fetchImpl = options.fetchImpl ?? fetch;
  const nameComUsername = process.env.NAMECOM_API_USERNAME?.trim();
  const nameComToken = process.env.NAMECOM_API_TOKEN?.trim();

  if (nameComUsername && nameComToken) {
    return new NameComProvider({
      fetchImpl,
      username: nameComUsername,
      token: nameComToken,
      baseUrl: process.env.NAMECOM_API_BASE_URL,
    });
  }

  if (process.env.DOMAIN_CHECK_HTTP_URL) {
    return new ExternalRegistrarProvider(
      fetchImpl,
      process.env.DOMAIN_CHECK_HTTP_URL,
      process.env.DOMAIN_CHECK_HTTP_TOKEN,
    );
  }

  return new BootstrapRdapProvider(fetchImpl);
}
