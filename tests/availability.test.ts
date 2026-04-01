import { describe, expect, it } from "vitest";

import { classifyRdapPayload } from "@/lib/domain/availability";

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
    const result = classifyRdapPayload(429, {});

    expect(result.status).toBe("unknown");
  });
});
