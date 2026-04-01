import { describe, expect, it } from "vitest";

import { getBuiltInSources } from "@/lib/domain/builtins";
import { buildCandidates, scoreCandidate } from "@/lib/domain/generator";
import { normalizeWord, parseWordUpload } from "@/lib/domain/normalization";

describe("domain generator", () => {
  it("normalizes uploaded words into lowercase ascii tokens", () => {
    expect(normalizeWord("Caf\u00e9-99")).toBe("cafe");
    expect(parseWordUpload("Alpha,\nBETA; 123 growth")).toEqual([
      "alpha",
      "beta",
      "growth",
    ]);
  });

  it("scores cleaner names higher than awkward clusters", () => {
    expect(scoreCandidate("growthpilot", ["growth", "pilot"])).toBeGreaterThan(
      scoreCandidate("qzzzkraft", ["qzzz", "kraft"]),
    );
  });

  it("builds unique candidates with supported domains", () => {
    const candidates = buildCandidates(
      {
        selectedTlds: ["com", "io"],
        enabledStyles: ["keyword", "brandable"],
        wordSourceIds: ["builtin-ai"],
        targetHits: 25,
        concurrency: 2,
        scoreThreshold: 58,
      },
      getBuiltInSources().filter((source) => source.id === "builtin-ai"),
    );

    expect(candidates.length).toBeGreaterThan(25);
    expect(new Set(candidates.map((candidate) => candidate.label)).size).toBe(
      candidates.length,
    );
    expect(candidates[0]?.fullDomains.every((domain) => /\.(com|io)$/.test(domain))).toBe(
      true,
    );
  });
});
