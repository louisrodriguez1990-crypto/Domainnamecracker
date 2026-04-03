export const SUPPORTED_TLDS = ["com", "io", "ai"] as const;
export const STYLE_OPTIONS = [
  "keyword",
  "brandable",
  "single-word-com",
  "random-3-com",
  "random-4-com",
  "random-5-com",
] as const;
export const DICTIONARY_SOURCE_ID = "builtin-dictionary";

export type SupportedTld = (typeof SUPPORTED_TLDS)[number];
export type GeneratedCandidateStyle = (typeof STYLE_OPTIONS)[number];
export type CandidateStyle = GeneratedCandidateStyle | "manual";
const SOURCE_FREE_STYLES = new Set<GeneratedCandidateStyle>([
  "random-3-com",
  "random-4-com",
  "random-5-com",
]);
const COM_ONLY_STYLES = new Set<GeneratedCandidateStyle>([
  "single-word-com",
  "random-3-com",
  "random-4-com",
  "random-5-com",
]);
export type RunStatus =
  | "running"
  | "completed"
  | "stopped"
  | "interrupted"
  | "exhausted";
export type AvailabilityStatus = "available" | "taken" | "unknown";
export type WordSourceKind = "builtin" | "upload";

export type WordBuckets = {
  adjectives: string[];
  nouns: string[];
  verbs: string[];
  modifiers: string[];
  cores: string[];
  general: string[];
};

export type WordSource = {
  id: string;
  name: string;
  kind: WordSourceKind;
  description: string;
  wordCount: number;
  buckets: WordBuckets;
  createdAt: string;
  updatedAt: string;
};

export type Candidate = {
  label: string;
  style: CandidateStyle;
  sourceWords: string[];
  score: number;
  fullDomains: string[];
};

export type AvailabilityResult = {
  domain: string;
  status: AvailabilityStatus;
  provider: string;
  checkedAt: string;
  confidence: number;
  note: string;
  retryAfterMs?: number | null;
};

export type RunConfig = {
  selectedTlds: SupportedTld[];
  enabledStyles: GeneratedCandidateStyle[];
  wordSourceIds: string[];
  targetHits: number;
  concurrency: number;
  scoreThreshold?: number;
  manualDomains?: string[];
  recheckExisting?: boolean;
};

export function allowsSourceFreeRun(
  config: Pick<RunConfig, "enabledStyles" | "manualDomains">,
) {
  return Boolean(config.manualDomains?.length) ||
    (config.enabledStyles.length > 0 &&
      config.enabledStyles.every((style) => SOURCE_FREE_STYLES.has(style)));
}

export function requiresComOnlyStyles(
  config: Pick<RunConfig, "enabledStyles">,
) {
  return (
    config.enabledStyles.length > 0 &&
    config.enabledStyles.every((style) => COM_ONLY_STYLES.has(style))
  );
}

export type RunRecord = {
  id: string;
  status: RunStatus;
  selectedTlds: SupportedTld[];
  enabledStyles: GeneratedCandidateStyle[];
  wordSourceIds: string[];
  targetHits: number;
  concurrency: number;
  scoreThreshold: number | null;
  generatedCount: number;
  checkedCount: number;
  skippedCount: number;
  availableCount: number;
  currentCandidate: string | null;
  lastError: string | null;
  stopRequested: boolean;
  manualDomains: string[];
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
};

export type RunResultRecord = {
  id: number;
  runId: string;
  domain: string;
  label: string;
  tld: SupportedTld;
  style: CandidateStyle;
  sourceWords: string[];
  score: number;
  status: AvailabilityStatus;
  provider: string;
  confidence: number;
  note: string;
  checkedAt: string;
  cached: boolean;
  manual: boolean;
};

export type RunSnapshot = {
  run: RunRecord;
  topHits: RunResultRecord[];
  recentResults: RunResultRecord[];
};

export type HistoryPayload = {
  wordSources: WordSource[];
  recentRuns: RunRecord[];
  recentHits: RunResultRecord[];
};
