import { describe, expect, it } from "vitest";

import { runConfigSchema } from "@/lib/domain/validation";

describe("run config validation", () => {
  it("accepts the retired random-short-com style and expands it", () => {
    const parsed = runConfigSchema.parse({
      selectedTlds: ["io", "ai"],
      enabledStyles: ["random-short-com"],
      wordSourceIds: [],
      targetHits: 25,
      concurrency: 2,
      scoreThreshold: 58,
    });

    expect(parsed.enabledStyles).toEqual([
      "random-3-com",
      "random-4-com",
      "random-5-com",
    ]);
  });
});
