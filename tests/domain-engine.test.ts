import { describe, expect, it } from "vitest";

import { getBuiltInSources, getPublicBuiltInSources } from "@/lib/domain/builtins";
import { DICTIONARY_SOURCE_ID, type WordSource } from "@/lib/domain/types";
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

  it("can generate standalone candidates across every selected tld", () => {
    const candidates = buildCandidates(
      {
        selectedTlds: ["com", "io"],
        enabledStyles: ["single-word-com"],
        wordSourceIds: ["builtin-ai"],
        targetHits: 25,
        concurrency: 2,
        scoreThreshold: 58,
      },
      getBuiltInSources().filter((source) => source.id === "builtin-ai"),
    );

    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.some((candidate) => candidate.label === "signal")).toBe(true);
    expect(
      candidates.every(
        (candidate) =>
          candidate.fullDomains.length === 2 &&
          candidate.fullDomains.some((domain) => domain.endsWith(".com")) &&
          candidate.fullDomains.some((domain) => domain.endsWith(".io")),
      ),
    ).toBe(true);
  });

  it("builds separate pronounceable 3, 4, and 5 letter candidate sets across selected tlds", () => {
    const styleExpectations = [
      { style: "random-3-com" as const, length: 3 },
      { style: "random-4-com" as const, length: 4 },
      { style: "random-5-com" as const, length: 5 },
    ];

    for (const { style, length } of styleExpectations) {
      const candidates = buildCandidates(
        {
          selectedTlds: ["com", "io", "ai"],
          enabledStyles: [style],
          wordSourceIds: [],
          targetHits: 25,
          concurrency: 2,
          scoreThreshold: 58,
        },
        [],
      );

      expect(candidates.length).toBeGreaterThan(100);
      expect(
        candidates.every(
          (candidate) =>
            candidate.fullDomains.length === 3 &&
            candidate.fullDomains.some((domain) => domain.endsWith(".com")) &&
            candidate.fullDomains.some((domain) => domain.endsWith(".io")) &&
            candidate.fullDomains.some((domain) => domain.endsWith(".ai")) &&
            candidate.label.length === length &&
            /[aeiou]/.test(candidate.label),
        ),
      ).toBe(true);
      expect(
        new Set(candidates.map((candidate) => candidate.label)).size,
      ).toBe(candidates.length);
    }
  });

  it("keeps the large dictionary source out of the dashboard payload buckets", () => {
    const dictionarySource = getPublicBuiltInSources().find(
      (source) => source.id === DICTIONARY_SOURCE_ID,
    );

    expect(dictionarySource).toBeDefined();
    expect(dictionarySource?.wordCount).toBeGreaterThan(200000);
    expect(dictionarySource?.buckets.general).toEqual([]);
  });

  it("treats dictionary-backed single-word scans as exhaustive across selected tlds", () => {
    const dictionarySource: WordSource = {
      id: DICTIONARY_SOURCE_ID,
      name: "Dictionary Sweep",
      kind: "builtin",
      description: "Test dictionary source.",
      wordCount: 2,
      buckets: {
        adjectives: [],
        nouns: [],
        verbs: [],
        modifiers: [],
        cores: [],
        general: ["rareword", "signal"],
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const candidates = buildCandidates(
      {
        selectedTlds: ["com", "io", "ai"],
        enabledStyles: ["single-word-com"],
        wordSourceIds: [DICTIONARY_SOURCE_ID],
        targetHits: 25,
        concurrency: 2,
        scoreThreshold: 100,
      },
      [dictionarySource],
    );

    expect(candidates.some((candidate) => candidate.label === "rareword")).toBe(
      true,
    );
    expect(
      candidates.every(
        (candidate) =>
          candidate.fullDomains.length === 3 &&
          candidate.fullDomains.some((domain) => domain.endsWith(".com")) &&
          candidate.fullDomains.some((domain) => domain.endsWith(".io")) &&
          candidate.fullDomains.some((domain) => domain.endsWith(".ai")),
      ),
    ).toBe(true);
  });
});
