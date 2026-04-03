import {
  DICTIONARY_SOURCE_ID,
  type Candidate,
  type RunConfig,
  type SupportedTld,
  type WordBuckets,
  type WordSource,
} from "@/lib/domain/types";
import { normalizeManualDomain, normalizeWords } from "@/lib/domain/normalization";

type CandidatePools = {
  adjectives: string[];
  nouns: string[];
  verbs: string[];
  modifiers: string[];
  cores: string[];
  general: string[];
};

const MAX_POOL_SIZE = 72;
const MAX_STANDALONE_WORDS = 300000;
const MAX_CANDIDATES = 18000;
const VOWELS = new Set(["a", "e", "i", "o", "u"]);
const WEIGHTED_VOWELS = "aaaaaeeeeiiiooouu";
const WEIGHTED_CONSONANTS = "bbbccddffgghhklllmmmnnnppprrrssstttvvwyyzz";
const RANDOM_SHORT_STYLE_CONFIG = {
  "random-3-com": {
    patterns: ["cvc", "vcv"] as const,
    maxCandidates: 1200,
    baseCount: 360,
  },
  "random-4-com": {
    patterns: ["cvcv", "cvvc", "vcvc", "cvcc"] as const,
    maxCandidates: 2400,
    baseCount: 720,
  },
  "random-5-com": {
    patterns: ["cvcvc", "cvccv", "vcvcv", "cvcvv"] as const,
    maxCandidates: 3600,
    baseCount: 960,
  },
} as const;
const VALUE_TERMS = new Set([
  "ai",
  "agent",
  "alpha",
  "auto",
  "boost",
  "core",
  "data",
  "flow",
  "forge",
  "growth",
  "hub",
  "lab",
  "loop",
  "pilot",
  "signal",
  "stack",
  "studio",
]);

function capAndSort(words: string[]): string[] {
  return [...normalizeWords(words)]
    .sort((left, right) => left.length - right.length || left.localeCompare(right))
    .slice(0, MAX_POOL_SIZE);
}

function compilePools(sources: WordSource[]): CandidatePools {
  const merged = sources
    .filter((source) => source.id !== DICTIONARY_SOURCE_ID)
    .reduce<WordBuckets>(
      (accumulator, source) => ({
        adjectives: [...accumulator.adjectives, ...source.buckets.adjectives],
        nouns: [...accumulator.nouns, ...source.buckets.nouns],
        verbs: [...accumulator.verbs, ...source.buckets.verbs],
        modifiers: [...accumulator.modifiers, ...source.buckets.modifiers],
        cores: [...accumulator.cores, ...source.buckets.cores],
        general: [...accumulator.general, ...source.buckets.general],
      }),
      {
        adjectives: [],
        nouns: [],
        verbs: [],
        modifiers: [],
        cores: [],
        general: [],
      },
    );

  const general = capAndSort(merged.general);

  return {
    adjectives: capAndSort([...merged.adjectives, ...general]),
    nouns: capAndSort([...merged.nouns, ...general]),
    verbs: capAndSort([...merged.verbs, ...general]),
    modifiers: capAndSort([...merged.modifiers, ...general]),
    cores: capAndSort([...merged.cores, ...general]),
    general,
  };
}

function compileStandaloneWords(sources: WordSource[]): string[] {
  return [...normalizeWords([
    ...sources.flatMap((source) => source.buckets.general),
    ...sources.flatMap((source) => source.buckets.nouns),
    ...sources.flatMap((source) => source.buckets.cores),
    ...sources.flatMap((source) => source.buckets.verbs),
    ...sources.flatMap((source) => source.buckets.adjectives),
    ...sources.flatMap((source) => source.buckets.modifiers),
  ])]
    .filter((word) => word.length >= 4 && word.length <= 14)
    .sort((left, right) => {
      const valueBoost =
        Number(VALUE_TERMS.has(right)) - Number(VALUE_TERMS.has(left));

      return valueBoost || left.length - right.length || left.localeCompare(right);
    })
    .slice(0, MAX_STANDALONE_WORDS);
}

function hasAwkwardCluster(value: string): boolean {
  return /[^aeiou]{4,}/.test(value);
}

function vowelRatio(value: string): number {
  let vowels = 0;

  for (const character of value) {
    if (VOWELS.has(character)) {
      vowels += 1;
    }
  }

  return vowels / value.length;
}

export function scoreCandidate(label: string, sourceWords: string[]): number {
  if (label.length < 3 || label.length > 14) {
    return 0;
  }

  let score = 46;
  const ratio = vowelRatio(label);
  const primarySource = sourceWords[0] ?? label;
  const secondarySource = sourceWords[1] ?? null;

  if (label.length >= 5 && label.length <= 12) {
    score += 16;
  } else if (label.length === 4) {
    score += 12;
  } else if (label.length === 3) {
    score += 8;
  } else {
    score -= 8;
  }

  const minimumRatio = label.length === 3 ? 0.2 : 0.28;
  const maximumRatio = label.length === 3 ? 0.8 : 0.62;

  if (ratio >= minimumRatio && ratio <= maximumRatio) {
    score += 12;
  } else {
    score -= 10;
  }

  if (hasAwkwardCluster(label)) {
    score -= 15;
  }

  if (/(.)\1\1/.test(label)) {
    score -= 16;
  }

  if (/([a-z]{2,})\1/.test(label)) {
    score -= 10;
  }

  if (secondarySource && primarySource === secondarySource) {
    score -= 14;
  }

  if (
    VALUE_TERMS.has(primarySource) ||
    (secondarySource ? VALUE_TERMS.has(secondarySource) : false)
  ) {
    score += 8;
  }

  if (/q[^u]|jj|vv|yy/.test(label)) {
    score -= 12;
  }

  return Math.max(0, Math.min(100, score));
}

function addCandidate(
  candidates: Candidate[],
  seenLabels: Set<string>,
  selectedTlds: SupportedTld[],
  label: string,
  sourceWords: string[],
  style: Candidate["style"],
  scoreThreshold: number,
  targetTlds = selectedTlds,
  maxCandidates = MAX_CANDIDATES,
) {
  if (candidates.length >= maxCandidates || seenLabels.has(label)) {
    return;
  }

  const score = scoreCandidate(label, sourceWords);

  if (score < scoreThreshold) {
    return;
  }

  seenLabels.add(label);
  candidates.push({
    label,
    style,
    sourceWords,
    score,
    fullDomains: targetTlds.map((tld) => `${label}.${tld}`),
  });
}

function prefixFragment(word: string): string | null {
  if (word.length < 4) {
    return null;
  }

  return word.slice(0, Math.min(4, Math.max(2, Math.ceil(word.length / 2))));
}

function suffixFragment(word: string): string | null {
  if (word.length < 4) {
    return null;
  }

  return word.slice(-Math.min(4, Math.max(2, Math.floor(word.length / 2))));
}

function leftBlend(word: string): string {
  return word.slice(0, Math.max(2, Math.ceil(word.length / 2)));
}

function rightBlend(word: string): string {
  return word.slice(Math.max(1, Math.floor(word.length / 2)));
}

function pickWeightedLetter(pool: string): string {
  return pool[Math.floor(Math.random() * pool.length)] ?? "a";
}

function buildPronounceableShortLabel(pattern: string) {
  let label = "";

  for (const slot of pattern) {
    label += slot === "v"
      ? pickWeightedLetter(WEIGHTED_VOWELS)
      : pickWeightedLetter(WEIGHTED_CONSONANTS);
  }

  if (/q/.test(label) && !/qu/.test(label)) {
    return null;
  }

  if (/(.)\1\1/.test(label)) {
    return null;
  }

  return label;
}

function buildRandomShortCandidates(
  candidates: Candidate[],
  seenLabels: Set<string>,
  config: RunConfig,
  style: keyof typeof RANDOM_SHORT_STYLE_CONFIG,
  scoreThreshold: number,
) {
  const styleConfig = RANDOM_SHORT_STYLE_CONFIG[style];
  const randomStartCount = candidates.length;
  const targetCount = Math.min(
    styleConfig.maxCandidates,
    Math.max(config.targetHits * 160, styleConfig.baseCount),
  );
  const maxAttempts = targetCount * 12;
  let attempts = 0;

  while (
    candidates.length - randomStartCount < targetCount &&
    attempts < maxAttempts
  ) {
    const pattern =
      styleConfig.patterns[
        Math.floor(Math.random() * styleConfig.patterns.length)
      ];
    const label = pattern ? buildPronounceableShortLabel(pattern) : null;

    attempts += 1;

    if (!label) {
      continue;
    }

    addCandidate(
      candidates,
      seenLabels,
      config.selectedTlds,
      label,
      [label],
      style,
      scoreThreshold,
      config.selectedTlds,
      MAX_CANDIDATES,
    );
  }
}

export function buildCandidates(
  config: RunConfig,
  sources: WordSource[],
): Candidate[] {
  const scoreThreshold = config.scoreThreshold ?? 56;
  const pools = compilePools(sources);
  const standaloneWords = compileStandaloneWords(sources);
  const exhaustiveStandalone = sources.some(
    (source) => source.id === DICTIONARY_SOURCE_ID,
  );
  const candidates: Candidate[] = [];
  const seenLabels = new Set<string>();

  if (config.enabledStyles.includes("keyword")) {
    for (const adjective of pools.adjectives) {
      for (const noun of pools.nouns) {
        addCandidate(
          candidates,
          seenLabels,
          config.selectedTlds,
          `${adjective}${noun}`,
          [adjective, noun],
          "keyword",
          scoreThreshold,
        );
      }
    }

    for (const verb of pools.verbs) {
      for (const noun of pools.nouns) {
        addCandidate(
          candidates,
          seenLabels,
          config.selectedTlds,
          `${verb}${noun}`,
          [verb, noun],
          "keyword",
          scoreThreshold,
        );
      }
    }

    for (const noun of pools.nouns) {
      for (const otherNoun of pools.cores) {
        addCandidate(
          candidates,
          seenLabels,
          config.selectedTlds,
          `${noun}${otherNoun}`,
          [noun, otherNoun],
          "keyword",
          scoreThreshold,
        );
      }
    }

    for (const modifier of pools.modifiers) {
      for (const core of pools.cores) {
        addCandidate(
          candidates,
          seenLabels,
          config.selectedTlds,
          `${modifier}${core}`,
          [modifier, core],
          "keyword",
          scoreThreshold,
        );
      }
    }
  }

  if (config.enabledStyles.includes("brandable")) {
    for (const modifier of pools.modifiers) {
      const prefix = prefixFragment(modifier);
      const suffix = suffixFragment(modifier);

      for (const word of [...pools.cores, ...pools.nouns]) {
        if (prefix) {
          addCandidate(
            candidates,
            seenLabels,
            config.selectedTlds,
            `${prefix}${word}`,
            [modifier, word],
            "brandable",
            scoreThreshold,
          );
        }

        if (suffix) {
          addCandidate(
            candidates,
            seenLabels,
            config.selectedTlds,
            `${word}${suffix}`,
            [word, modifier],
            "brandable",
            scoreThreshold,
          );
        }
      }
    }

    for (const left of [...pools.general, ...pools.modifiers]) {
      for (const right of [...pools.cores, ...pools.nouns]) {
        addCandidate(
          candidates,
          seenLabels,
          config.selectedTlds,
          `${leftBlend(left)}${rightBlend(right)}`,
          [left, right],
          "brandable",
          scoreThreshold,
        );
      }
    }
  }

  if (config.enabledStyles.includes("single-word-com")) {
    for (const word of standaloneWords) {
      addCandidate(
        candidates,
        seenLabels,
        config.selectedTlds,
        word,
        [word],
        "single-word-com",
        exhaustiveStandalone ? 0 : scoreThreshold,
        config.selectedTlds,
        MAX_STANDALONE_WORDS,
      );
    }
  }

  if (config.enabledStyles.includes("random-3-com")) {
    buildRandomShortCandidates(
      candidates,
      seenLabels,
      config,
      "random-3-com",
      scoreThreshold,
    );
  }

  if (config.enabledStyles.includes("random-4-com")) {
    buildRandomShortCandidates(
      candidates,
      seenLabels,
      config,
      "random-4-com",
      scoreThreshold,
    );
  }

  if (config.enabledStyles.includes("random-5-com")) {
    buildRandomShortCandidates(
      candidates,
      seenLabels,
      config,
      "random-5-com",
      scoreThreshold,
    );
  }

  return candidates.sort(
    (left, right) => right.score - left.score || left.label.localeCompare(right.label),
  );
}

export function buildManualCandidates(
  config: RunConfig,
  inputs: string[],
): Candidate[] {
  const seen = new Set<string>();
  const candidates: Candidate[] = [];

  for (const input of inputs) {
    const normalized = normalizeManualDomain(input);

    if (!normalized) {
      continue;
    }

    const domains = normalized.domain
      ? [normalized.domain]
      : config.selectedTlds.map((tld) => `${normalized.label}.${tld}`);

    if (seen.has(`${normalized.label}:${domains.join(",")}`)) {
      continue;
    }

    seen.add(`${normalized.label}:${domains.join(",")}`);
    candidates.push({
      label: normalized.label,
      style: "manual",
      sourceWords: [normalized.label, normalized.label],
      score: 100,
      fullDomains: domains,
    });
  }

  return candidates;
}
