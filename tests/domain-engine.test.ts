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

  it("can generate standalone .com candidates without adding other tlds", () => {
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
          candidate.fullDomains.length === 1 && candidate.fullDomains[0]?.endsWith(".com"),
      ),
    ).toBe(true);
  });

  it("builds pronounceable random short .com candidates without word sources", () => {
    const candidates = buildCandidates(
      {
        selectedTlds: ["com"],
        enabledStyles: ["random-short-com"],
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
          candidate.fullDomains.length === 1 &&
          candidate.fullDomains[0]?.endsWith(".com") &&
          candidate.label.length >= 3 &&
          candidate.label.length <= 5 &&
          /[aeiou]/.test(candidate.label),
      ),
    ).toBe(true);
    expect(new Set(candidates.map((candidate) => candidate.label)).size).toBe(
      candidates.length,
    );
  });

  it("keeps the large dictionary source out of the dashboard payload buckets", () => {
    const dictionarySource = getPublicBuiltInSources().find(
      (source) => source.id === DICTIONARY_SOURCE_ID,
    );

    expect(dictionarySource).toBeDefined();
    expect(dictionarySource?.wordCount).toBeGreaterThan(200000);
    expect(dictionarySource?.buckets.general).toEqual([]);
  });

  it("treats dictionary-backed single-word .com scans as exhaustive", () => {
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
        selectedTlds: ["com"],
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
      candidates.every((candidate) => candidate.fullDomains[0]?.endsWith(".com")),
    ).toBe(true);
  });
});
