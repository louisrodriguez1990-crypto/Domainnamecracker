import { afterEach, describe, expect, it } from "vitest";

import {
  classifyNameComAvailabilityPayload,
  classifyNameComZonePayload,
  classifyRdapPayload,
  createAvailabilityProvider,
  createNameComAuthorizationHeader,
  getAvailabilityProviderStatus,
  isHybridAvailabilityProvider,
  parseRetryAfterHeader,
} from "@/lib/domain/availability";

const originalEnv = { ...process.env };

function resetNameComEnv() {
  process.env = {
    ...originalEnv,
    NAMECOM_API_USERNAME: undefined,
    NAMECOM_API_TOKEN: undefined,
    NAMECOM_API_BASE_URL: undefined,
    DOMAIN_CHECK_HTTP_URL: undefined,
    DOMAIN_CHECK_HTTP_TOKEN: undefined,
  };
}

describe("availability providers", () => {
  afterEach(() => {
    resetNameComEnv();
  });

  it("parses Retry-After values from seconds and dates", () => {
    expect(parseRetryAfterHeader("45")).toBe(45_000);
    expect(
      parseRetryAfterHeader(
        "Wed, 01 Apr 2026 12:00:30 GMT",
        Date.UTC(2026, 3, 1, 12, 0, 0),
      ),
    ).toBe(30_000);
  });

  it("builds the Name.com basic auth header from username and token", () => {
    expect(createNameComAuthorizationHeader("alice", "token-123")).toBe(
      "Basic YWxpY2U6dG9rZW4tMTIz",
    );
  });

  it("classifies Name.com zone check results into preliminary candidates and negatives", () => {
    const checkedAt = "2026-04-03T12:00:00.000Z";
    const results = classifyNameComZonePayload(
      ["alpha.com", "beta.com"],
      {
        results: [
          { domainName: "alpha.com", available: true },
          { domainName: "beta.com", available: false },
        ],
      },
      checkedAt,
    );

    expect(results[0]).toMatchObject({
      domain: "alpha.com",
      status: "available",
      stage: "preliminary",
    });
    expect(results[1]).toMatchObject({
      domain: "beta.com",
      status: "taken",
      stage: "preliminary",
    });
    expect(results[1]?.expiresAt).toBeTruthy();
  });

  it("classifies Name.com live availability results and keeps pricing in the note", () => {
    const results = classifyNameComAvailabilityPayload(
      ["alpha.com", "beta.com"],
      {
        results: [
          {
            domainName: "alpha.com",
            purchasable: true,
            purchasePrice: 12.99,
            renewalPrice: 15.99,
            premium: true,
          },
          {
            domainName: "beta.com",
            purchasable: false,
            reason: "Domain is unavailable.",
          },
        ],
      },
      "2026-04-03T12:00:00.000Z",
    );

    expect(results[0]).toMatchObject({
      domain: "alpha.com",
      status: "available",
      stage: "definitive",
    });
    expect(results[0]?.note).toContain("$12.99");
    expect(results[1]).toMatchObject({
      domain: "beta.com",
      status: "taken",
      stage: "definitive",
      note: "Domain is unavailable.",
    });
  });

  it("prefers Name.com over the external checker when credentials are configured", async () => {
    resetNameComEnv();
    process.env.NAMECOM_API_USERNAME = "alice";
    process.env.NAMECOM_API_TOKEN = "token-123";
    process.env.DOMAIN_CHECK_HTTP_URL = "https://example.com/check";

    const provider = createAvailabilityProvider({
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            results: [{ domainName: "alpha.com", purchasable: true }],
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
    });

    expect(isHybridAvailabilityProvider(provider)).toBe(true);

    const result = await provider.checkDomain("alpha.com");

    expect(result.provider).toBe("namecom-core");
    expect(result.status).toBe("available");
  });

  it("lets callers opt out of Name.com even when credentials are configured", async () => {
    resetNameComEnv();
    process.env.NAMECOM_API_USERNAME = "alice";
    process.env.NAMECOM_API_TOKEN = "token-123";
    process.env.DOMAIN_CHECK_HTTP_URL = "https://example.com/check";

    const provider = createAvailabilityProvider({
      preferNameCom: false,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            status: "taken",
            provider: "external-registrar",
            checkedAt: "2026-04-03T12:00:00.000Z",
            confidence: 0.8,
            note: "external result",
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
    });

    expect(isHybridAvailabilityProvider(provider)).toBe(false);

    const result = await provider.checkDomain("alpha.com");

    expect(result.provider).toBe("external-registrar");
    expect(result.note).toBe("external result");
  });

  it("reports provider setup status for the dashboard", () => {
    resetNameComEnv();
    process.env.NAMECOM_API_USERNAME = "alice";
    process.env.NAMECOM_API_TOKEN = "token-123";

    expect(getAvailabilityProviderStatus()).toEqual({
      nameComConfigured: true,
      nameComSetupMessage: null,
      externalCheckerConfigured: false,
      defaultProvider: "namecom",
      fallbackProvider: "rdap",
    });
  });

  it("returns retry hints for Name.com 429 responses", async () => {
    resetNameComEnv();
    process.env.NAMECOM_API_USERNAME = "alice";
    process.env.NAMECOM_API_TOKEN = "token-123";

    const provider = createAvailabilityProvider({
      fetchImpl: async () =>
        new Response(
          JSON.stringify({ message: "Too Many Requests" }),
          {
            status: 429,
            headers: {
              "content-type": "application/json",
              "retry-after": "15",
            },
          },
        ),
    });

    expect(isHybridAvailabilityProvider(provider)).toBe(true);

    const results = await provider.screenDomains(["alpha.com", "beta.com"]);

    expect(results.every((result) => result.status === "unknown")).toBe(true);
    expect(results.every((result) => result.retryAfterMs === 15_000)).toBe(true);
  });

  it("surfaces Name.com 403 responses such as two-factor auth errors", async () => {
    resetNameComEnv();
    process.env.NAMECOM_API_USERNAME = "alice";
    process.env.NAMECOM_API_TOKEN = "token-123";

    const provider = createAvailabilityProvider({
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            message: "Permission Denied",
            details: "Account has two-step verification enabled.",
          }),
          {
            status: 403,
            headers: {
              "content-type": "application/json",
            },
          },
        ),
    });

    expect(isHybridAvailabilityProvider(provider)).toBe(true);

    const [result] = await provider.checkDomains(["alpha.com"]);

    expect(result.status).toBe("unknown");
    expect(result.note).toContain("two-step verification");
  });

  it("surfaces malformed Name.com batch requests as unknown results", async () => {
    resetNameComEnv();
    process.env.NAMECOM_API_USERNAME = "alice";
    process.env.NAMECOM_API_TOKEN = "token-123";

    const provider = createAvailabilityProvider({
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            message: "Invalid Argument",
            details: "Too many domains requested.",
          }),
          {
            status: 422,
            headers: {
              "content-type": "application/json",
            },
          },
        ),
    });

    expect(isHybridAvailabilityProvider(provider)).toBe(true);

    const [result] = await provider.screenDomains(["alpha.com"]);

    expect(result.status).toBe("unknown");
    expect(result.note).toContain("Too many domains requested");
  });
});

describe("RDAP classification", () => {
  it("treats not found as available", () => {
    const result = classifyRdapPayload(404, { title: "Not Found" });

    expect(result.status).toBe("available");
    expect(result.confidence).toBeGreaterThan(0.8);
  });

  it("treats returned domain objects as taken", () => {
    const result = classifyRdapPayload(200, {
      objectClassName: "domain",
      ldhName: "signalforge.com",
    });

    expect(result.status).toBe("taken");
  });

  it("keeps throttled or broken responses as unknown", () => {
    const result = classifyRdapPayload(429, {}, 15_000);

    expect(result.status).toBe("unknown");
    expect(result.retryAfterMs).toBe(15_000);
  });
});
