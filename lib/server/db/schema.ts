import { index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const wordSourcesTable = sqliteTable("word_sources", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  kind: text("kind").notNull(),
  description: text("description").notNull(),
  payload: text("payload").notNull(),
  wordCount: integer("word_count").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const runsTable = sqliteTable(
  "runs",
  {
    id: text("id").primaryKey(),
    status: text("status").notNull(),
    selectedTlds: text("selected_tlds").notNull(),
    enabledStyles: text("enabled_styles").notNull(),
    wordSourceIds: text("word_source_ids").notNull(),
    targetHits: integer("target_hits").notNull(),
    concurrency: integer("concurrency").notNull(),
    preferNameCom: integer("prefer_namecom").notNull().default(1),
    scoreThreshold: real("score_threshold"),
    generatedCount: integer("generated_count").notNull().default(0),
    checkedCount: integer("checked_count").notNull().default(0),
    skippedCount: integer("skipped_count").notNull().default(0),
    availableCount: integer("available_count").notNull().default(0),
    currentCandidate: text("current_candidate"),
    lastError: text("last_error"),
    stopRequested: integer("stop_requested").notNull().default(0),
    manualDomains: text("manual_domains").notNull().default("[]"),
    startedAt: text("started_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    finishedAt: text("finished_at"),
  },
  (table) => ({
    statusIndex: index("runs_status_idx").on(table.status),
    startedAtIndex: index("runs_started_at_idx").on(table.startedAt),
  }),
);

export const candidatesTable = sqliteTable(
  "candidates",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    runId: text("run_id").notNull(),
    label: text("label").notNull(),
    style: text("style").notNull(),
    sourceWords: text("source_words").notNull(),
    score: real("score").notNull(),
    fullDomains: text("full_domains").notNull(),
    generatedAt: text("generated_at").notNull(),
  },
  (table) => ({
    runIdIndex: index("candidates_run_id_idx").on(table.runId),
  }),
);

export const checkedDomainsTable = sqliteTable("checked_domains", {
  domain: text("domain").primaryKey(),
  label: text("label").notNull(),
  tld: text("tld").notNull(),
  style: text("style").notNull(),
  sourceWords: text("source_words").notNull(),
  score: real("score").notNull(),
  status: text("status").notNull(),
  stage: text("stage").notNull().default("definitive"),
  provider: text("provider").notNull(),
  confidence: real("confidence").notNull(),
  note: text("note").notNull(),
  checkedAt: text("checked_at").notNull(),
  expiresAt: text("expires_at"),
  lastRunId: text("last_run_id").notNull(),
});

export const runResultsTable = sqliteTable(
  "run_results",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    runId: text("run_id").notNull(),
    domain: text("domain").notNull(),
    label: text("label").notNull(),
    tld: text("tld").notNull(),
    style: text("style").notNull(),
    sourceWords: text("source_words").notNull(),
    score: real("score").notNull(),
    status: text("status").notNull(),
    provider: text("provider").notNull(),
    confidence: real("confidence").notNull(),
    note: text("note").notNull(),
    checkedAt: text("checked_at").notNull(),
    cached: integer("cached").notNull().default(0),
    manual: integer("manual").notNull().default(0),
  },
  (table) => ({
    runIdIndex: index("run_results_run_id_idx").on(table.runId),
    statusIndex: index("run_results_status_idx").on(table.status),
    checkedAtIndex: index("run_results_checked_at_idx").on(table.checkedAt),
  }),
);
