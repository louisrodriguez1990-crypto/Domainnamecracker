import type { SupportedTld, WordBuckets } from "@/lib/domain/types";

const LETTERS_ONLY = /[^a-z]/g;
const DIACRITICS = /[\u0300-\u036f]/g;

export function normalizeWord(raw: string): string | null {
  const normalized = raw
    .normalize("NFKD")
    .replace(DIACRITICS, "")
    .toLowerCase()
    .replace(LETTERS_ONLY, "");

  if (normalized.length < 2 || normalized.length > 14) {
    return null;
  }

  return normalized;
}

export function normalizeWords(words: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const word of words) {
    const nextWord = normalizeWord(word);

    if (!nextWord || seen.has(nextWord)) {
      continue;
    }

    seen.add(nextWord);
    normalized.push(nextWord);
  }

  return normalized;
}

export function parseWordUpload(rawText: string): string[] {
  const splitWords = rawText
    .split(/[\s,\n\r\t;]+/g)
    .map((value) => value.trim())
    .filter(Boolean);

  return normalizeWords(splitWords);
}

export function createUploadBuckets(words: string[]): WordBuckets {
  const normalized = normalizeWords(words).slice(0, 500);

  return {
    adjectives: [],
    nouns: [],
    verbs: [],
    modifiers: [],
    cores: [],
    general: normalized,
  };
}

export function normalizeManualDomain(input: string): {
  label: string;
  domain: string | null;
  tld: SupportedTld | null;
} | null {
  const cleaned = input.trim().toLowerCase();

  if (!cleaned) {
    return null;
  }

  const match = cleaned.match(/^([a-z0-9-]+)(?:\.(com|io|ai))?$/);

  if (!match) {
    return null;
  }

  const label = normalizeWord(match[1]);

  if (!label) {
    return null;
  }

  const tld = (match[2] ?? null) as SupportedTld | null;

  return {
    label,
    domain: tld ? `${label}.${tld}` : null,
    tld,
  };
}
