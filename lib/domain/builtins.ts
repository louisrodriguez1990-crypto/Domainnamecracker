import fs from "node:fs";

import wordListPath from "word-list";

import {
  DICTIONARY_SOURCE_ID,
  type WordBuckets,
  type WordSource,
} from "@/lib/domain/types";
import { normalizeWords } from "@/lib/domain/normalization";

type BuiltinDefinition = Omit<
  WordSource,
  "createdAt" | "updatedAt" | "wordCount"
> & { buckets: WordBuckets };

const LARGE_SOURCE_BUCKETS: WordBuckets = {
  adjectives: [],
  nouns: [],
  verbs: [],
  modifiers: [],
  cores: [],
  general: [],
};

const PUBLIC_BUCKET_LIMIT = 5000;

let cachedDictionaryWords: string[] | null = null;

function normalizeBuckets(buckets: WordBuckets): WordBuckets {
  return {
    adjectives: normalizeWords(buckets.adjectives),
    nouns: normalizeWords(buckets.nouns),
    verbs: normalizeWords(buckets.verbs),
    modifiers: normalizeWords(buckets.modifiers),
    cores: normalizeWords(buckets.cores),
    general: normalizeWords(buckets.general),
  };
}

function getDictionaryWords(): string[] {
  if (!cachedDictionaryWords) {
    const rawWords = fs.readFileSync(wordListPath, "utf8").split(/\r?\n/g);

    cachedDictionaryWords = normalizeWords(rawWords).filter(
      (word) => word.length >= 4 && word.length <= 14,
    );
  }

  return cachedDictionaryWords;
}

const CURATED_BUILTIN_DEFINITIONS: BuiltinDefinition[] = [
  {
    id: "builtin-ai",
    name: "AI Momentum",
    kind: "builtin",
    description: "Model, automation, and intelligence-flavored building blocks.",
    buckets: normalizeBuckets({
      adjectives: [
        "adaptive",
        "autonomous",
        "cognitive",
        "contextual",
        "dynamic",
        "neural",
        "precision",
        "predictive",
        "smart",
        "synthetic",
      ],
      nouns: [
        "agent",
        "atlas",
        "bot",
        "brain",
        "canvas",
        "grid",
        "lab",
        "logic",
        "model",
        "signal",
      ],
      verbs: [
        "align",
        "amplify",
        "decode",
        "infer",
        "optimize",
        "orchestrate",
        "predict",
        "scale",
        "train",
        "vectorize",
      ],
      modifiers: [
        "auto",
        "co",
        "hyper",
        "meta",
        "multi",
        "omni",
        "proto",
        "quant",
        "ultra",
        "xeno",
      ],
      cores: [
        "flow",
        "forge",
        "frame",
        "layer",
        "loop",
        "mesh",
        "pilot",
        "stack",
        "sync",
        "vision",
      ],
      general: [
        "ai",
        "cluster",
        "cortex",
        "data",
        "embed",
        "intent",
        "machine",
        "prompt",
        "tensor",
        "vision",
      ],
    }),
  },
  {
    id: "builtin-business",
    name: "Business Utility",
    kind: "builtin",
    description: "Clear, commercial words for products, operations, and growth.",
    buckets: normalizeBuckets({
      adjectives: [
        "agile",
        "bold",
        "clear",
        "fast",
        "lean",
        "prime",
        "solid",
        "steady",
        "trusted",
        "vital",
      ],
      nouns: [
        "bridge",
        "craft",
        "desk",
        "engine",
        "growth",
        "market",
        "ops",
        "path",
        "pilot",
        "studio",
      ],
      verbs: [
        "boost",
        "build",
        "chart",
        "close",
        "grow",
        "launch",
        "ship",
        "solve",
        "streamline",
        "win",
      ],
      modifiers: [
        "bright",
        "core",
        "direct",
        "first",
        "front",
        "north",
        "peak",
        "spark",
        "up",
        "zen",
      ],
      cores: [
        "base",
        "bridge",
        "dock",
        "forge",
        "hub",
        "lane",
        "lift",
        "pulse",
        "spring",
        "track",
      ],
      general: [
        "brand",
        "client",
        "founder",
        "growth",
        "launch",
        "revenue",
        "sales",
        "signal",
        "team",
        "venture",
      ],
    }),
  },
  {
    id: "builtin-creator",
    name: "Creator Tools",
    kind: "builtin",
    description: "Words that feel productized, creative, and internet-native.",
    buckets: normalizeBuckets({
      adjectives: [
        "crisp",
        "electric",
        "fresh",
        "golden",
        "lively",
        "lunar",
        "modern",
        "rapid",
        "vivid",
        "wild",
      ],
      nouns: [
        "arc",
        "beam",
        "camp",
        "dock",
        "mint",
        "orbit",
        "pixel",
        "raft",
        "wave",
        "yard",
      ],
      verbs: [
        "blend",
        "capture",
        "craft",
        "draft",
        "frame",
        "ignite",
        "launch",
        "make",
        "mix",
        "spark",
      ],
      modifiers: [
        "clip",
        "echo",
        "micro",
        "nova",
        "snap",
        "stereo",
        "super",
        "turbo",
        "verve",
        "vita",
      ],
      cores: [
        "cast",
        "deck",
        "flow",
        "nest",
        "press",
        "room",
        "scope",
        "shift",
        "spark",
        "trail",
      ],
      general: [
        "audio",
        "canvas",
        "creator",
        "design",
        "media",
        "signal",
        "story",
        "studio",
        "trend",
        "viral",
      ],
    }),
  },
];

function createDictionaryDefinition(): BuiltinDefinition {
  return {
    id: DICTIONARY_SOURCE_ID,
    name: "Dictionary Sweep",
    kind: "builtin",
    description:
      "A full English word list for exhaustive single-word domain sweeps.",
    buckets: {
      ...LARGE_SOURCE_BUCKETS,
      general: getDictionaryWords(),
    },
  };
}

function toWordSource(
  source: BuiltinDefinition,
  now: string,
  publicSummary: boolean,
): WordSource {
  const wordCount = Object.values(source.buckets).reduce(
    (total, bucket) => total + bucket.length,
    0,
  );
  const buckets =
    publicSummary && wordCount > PUBLIC_BUCKET_LIMIT
      ? LARGE_SOURCE_BUCKETS
      : source.buckets;

  return {
    ...source,
    buckets,
    wordCount,
    createdAt: now,
    updatedAt: now,
  };
}

export function sortWordSources<T extends Pick<WordSource, "kind" | "name">>(
  sources: T[],
): T[] {
  return [...sources].sort(
    (left, right) =>
      right.kind.localeCompare(left.kind) || left.name.localeCompare(right.name),
  );
}

export function getBuiltInSources(now = new Date().toISOString()): WordSource[] {
  return [
    ...CURATED_BUILTIN_DEFINITIONS.map((source) => toWordSource(source, now, false)),
    toWordSource(createDictionaryDefinition(), now, false),
  ];
}

export function getPublicBuiltInSources(
  now = new Date().toISOString(),
): WordSource[] {
  return [
    ...CURATED_BUILTIN_DEFINITIONS.map((source) => toWordSource(source, now, true)),
    toWordSource(createDictionaryDefinition(), now, true),
  ];
}
