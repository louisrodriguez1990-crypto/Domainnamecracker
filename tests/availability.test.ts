import { describe, expect, it } from "vitest";

import {
  classifyRdapPayload,
  parseRetryAfterHeader,
} from "@/lib/domain/availability";

describe("RDAP classification", () => {
  it("parses Retry-After values from seconds and dates", () => {
    expect(parseRetryAfterHeader("45")).toBe(45_000);
    expect(
      parseRetryAfterHeader("Wed, 01 Apr 2026 12:00:30 GMT", Date.UTC(2026, 3, 1, 12, 0, 0)),
    ).toBe(30_000);
  });

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
