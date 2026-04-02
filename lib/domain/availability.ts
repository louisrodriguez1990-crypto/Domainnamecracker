import type { AvailabilityResult } from "@/lib/domain/types";

type FetchLike = typeof fetch;
type RdapBootstrap = {
  services: Array<[string[], string[]]>;
};

export interface AvailabilityProvider {
  readonly name: string;
  checkDomain(domain: string): Promise<AvailabilityResult>;
}

type ProviderFactoryOptions = {
  fetchImpl?: FetchLike;
};

type RdapClassification = Omit<AvailabilityResult, "domain" | "checkedAt" | "provider">;

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
    };
  }

  if (responseStatus === 429) {
    return {
      status: "unknown",
      confidence: 0.2,
      note: extractRdapNote(payload, "RDAP rate limited the request."),
      retryAfterMs: retryAfterMs ?? 60_000,
    };
  }

  if (responseStatus >= 500) {
    return {
      status: "unknown",
      confidence: 0.28,
      note: "RDAP returned a server error.",
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
    };
  }

  return {
    status: "unknown",
    confidence: 0.35,
    note: extractRdapNote(payload, "RDAP returned an unexpected response."),
  };
}

class BootstrapRdapProvider implements AvailabilityProvider {
  readonly name = "iana-rdap";
  private fetchImpl: FetchLike;
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
      };
    }

    for (const baseUrl of baseUrls) {
      const response = await this.fetchImpl(new URL(`domain/${domain}`, baseUrl), {
        headers: {
          accept: "application/rdap+json, application/json",
        },
        cache: "no-store",
      });

      const contentType = response.headers.get("content-type") ?? "";
      const payload = contentType.includes("json")
        ? await response.json().catch(() => null)
        : await response.text().catch(() => null);
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
    };
  }
}

class ExternalRegistrarProvider implements AvailabilityProvider {
  readonly name = "external-registrar";
  private fetchImpl: FetchLike;
  private url: string;
  private token: string | undefined;

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
      provider: this.name,
      checkedAt: payload.checkedAt ?? new Date().toISOString(),
      confidence: payload.confidence ?? 0.5,
      note: payload.note ?? "External registrar response.",
      retryAfterMs: payload.retryAfterMs ?? retryAfterMs,
    };
  }
}

export function createAvailabilityProvider(
  options: ProviderFactoryOptions = {},
): AvailabilityProvider {
  const fetchImpl = options.fetchImpl ?? fetch;

  if (process.env.DOMAIN_CHECK_HTTP_URL) {
    return new ExternalRegistrarProvider(
      fetchImpl,
      process.env.DOMAIN_CHECK_HTTP_URL,
      process.env.DOMAIN_CHECK_HTTP_TOKEN,
    );
  }

  return new BootstrapRdapProvider(fetchImpl);
}
