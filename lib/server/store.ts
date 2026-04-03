import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";

import {
  getBuiltInSources,
  getPublicBuiltInSources,
  sortWordSources,
} from "@/lib/domain/builtins";
import type {
  AvailabilityResult,
  Candidate,
  CandidateStyle,
  HistoryPayload,
  RunConfig,
  RunRecord,
  RunResultRecord,
  RunSnapshot,
  RunStatus,
  SupportedTld,
  WordBuckets,
  WordSource,
} from "@/lib/domain/types";
import { coerceEnabledStyles } from "@/lib/domain/types";
import {
  candidatesTable,
  checkedDomainsTable,
  runResultsTable,
  runsTable,
  wordSourcesTable,
} from "@/lib/server/db/schema";

type DatabaseShape = ReturnType<typeof drizzle<typeof import("./db/schema")>>;
type RunRow = typeof runsTable.$inferSelect;
type WordSourceRow = typeof wordSourcesTable.$inferSelect;
type RunResultRow = typeof runResultsTable.$inferSelect;
type CheckedDomainRow = typeof checkedDomainsTable.$inferSelect;

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function createDataDirectory(dbPath: string) {
  if (dbPath === ":memory:") {
    return;
  }

  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
}

function mapWordSource(row: WordSourceRow): WordSource {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind as WordSource["kind"],
    description: row.description,
    wordCount: row.wordCount,
    buckets: parseJson<WordBuckets>(row.payload, {
      adjectives: [],
      nouns: [],
      verbs: [],
      modifiers: [],
      cores: [],
      general: [],
    }),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapRun(row: RunRow): RunRecord {
  const rawEnabledStyles = parseJson<string[]>(row.enabledStyles, []);

  return {
    id: row.id,
    status: row.status as RunStatus,
    selectedTlds: parseJson<SupportedTld[]>(row.selectedTlds, []),
    enabledStyles: coerceEnabledStyles(rawEnabledStyles),
    wordSourceIds: parseJson<string[]>(row.wordSourceIds, []),
    targetHits: row.targetHits,
    concurrency: row.concurrency,
    scoreThreshold: row.scoreThreshold,
    generatedCount: row.generatedCount,
    checkedCount: row.checkedCount,
    skippedCount: row.skippedCount,
    availableCount: row.availableCount,
    currentCandidate: row.currentCandidate,
    lastError: row.lastError,
    stopRequested: Boolean(row.stopRequested),
    manualDomains: parseJson<string[]>(row.manualDomains, []),
    startedAt: row.startedAt,
    updatedAt: row.updatedAt,
    finishedAt: row.finishedAt,
  };
}

function mapRunResult(row: RunResultRow): RunResultRecord {
  return {
    id: row.id,
    runId: row.runId,
    domain: row.domain,
    label: row.label,
    tld: row.tld as SupportedTld,
    style: row.style as CandidateStyle,
    sourceWords: parseJson<string[]>(row.sourceWords, []),
    score: row.score,
    status: row.status as RunResultRecord["status"],
    provider: row.provider,
    confidence: row.confidence,
    note: row.note,
    checkedAt: row.checkedAt,
    cached: Boolean(row.cached),
    manual: Boolean(row.manual),
  };
}

function chunk<T>(values: T[], size: number): T[][] {
  const groups: T[][] = [];

  for (let index = 0; index < values.length; index += size) {
    groups.push(values.slice(index, index + size));
  }

  return groups;
}

function isExpiredPreliminaryResult(row: CheckedDomainRow) {
  return (
    row.stage === "preliminary" &&
    typeof row.expiresAt === "string" &&
    row.expiresAt.length > 0 &&
    Date.parse(row.expiresAt) <= Date.now()
  );
}

export class DomainHunterStore {
  readonly sqlite: Database.Database;
  readonly db: DatabaseShape;

  constructor(dbPath = path.join(process.cwd(), "data", "domain-hunter.sqlite")) {
    createDataDirectory(dbPath);
    this.sqlite = new Database(dbPath);
    this.sqlite.pragma("journal_mode = WAL");
    this.sqlite.pragma("foreign_keys = ON");
    this.db = drizzle(this.sqlite);
    this.initialize();
  }

  close() {
    this.sqlite.close();
  }

  private initialize() {
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS word_sources (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        description TEXT NOT NULL,
        payload TEXT NOT NULL,
        word_count INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        selected_tlds TEXT NOT NULL,
        enabled_styles TEXT NOT NULL,
        word_source_ids TEXT NOT NULL,
        target_hits INTEGER NOT NULL,
        concurrency INTEGER NOT NULL,
        score_threshold REAL,
        generated_count INTEGER NOT NULL DEFAULT 0,
        checked_count INTEGER NOT NULL DEFAULT 0,
        skipped_count INTEGER NOT NULL DEFAULT 0,
        available_count INTEGER NOT NULL DEFAULT 0,
        current_candidate TEXT,
        last_error TEXT,
        stop_requested INTEGER NOT NULL DEFAULT 0,
        manual_domains TEXT NOT NULL DEFAULT '[]',
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        finished_at TEXT
      );

      CREATE TABLE IF NOT EXISTS candidates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        label TEXT NOT NULL,
        style TEXT NOT NULL,
        source_words TEXT NOT NULL,
        score REAL NOT NULL,
        full_domains TEXT NOT NULL,
        generated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS checked_domains (
        domain TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        tld TEXT NOT NULL,
        style TEXT NOT NULL,
        source_words TEXT NOT NULL,
        score REAL NOT NULL,
        status TEXT NOT NULL,
        stage TEXT NOT NULL DEFAULT 'definitive',
        provider TEXT NOT NULL,
        confidence REAL NOT NULL,
        note TEXT NOT NULL,
        checked_at TEXT NOT NULL,
        expires_at TEXT,
        last_run_id TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS run_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        domain TEXT NOT NULL,
        label TEXT NOT NULL,
        tld TEXT NOT NULL,
        style TEXT NOT NULL,
        source_words TEXT NOT NULL,
        score REAL NOT NULL,
        status TEXT NOT NULL,
        provider TEXT NOT NULL,
        confidence REAL NOT NULL,
        note TEXT NOT NULL,
        checked_at TEXT NOT NULL,
        cached INTEGER NOT NULL DEFAULT 0,
        manual INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS runs_status_idx ON runs(status);
      CREATE INDEX IF NOT EXISTS runs_started_at_idx ON runs(started_at);
      CREATE INDEX IF NOT EXISTS candidates_run_id_idx ON candidates(run_id);
      CREATE INDEX IF NOT EXISTS run_results_run_id_idx ON run_results(run_id);
      CREATE INDEX IF NOT EXISTS run_results_status_idx ON run_results(status);
      CREATE INDEX IF NOT EXISTS run_results_checked_at_idx ON run_results(checked_at);
    `);

    this.ensureCheckedDomainColumns();
    this.markInterruptedRuns();
  }

  private ensureCheckedDomainColumns() {
    const columns = this.sqlite
      .prepare<[], { name: string }>("pragma table_info(checked_domains)")
      .all()
      .map((column) => column.name);

    if (!columns.includes("stage")) {
      this.sqlite.exec(
        "ALTER TABLE checked_domains ADD COLUMN stage TEXT NOT NULL DEFAULT 'definitive'",
      );
    }

    if (!columns.includes("expires_at")) {
      this.sqlite.exec("ALTER TABLE checked_domains ADD COLUMN expires_at TEXT");
    }
  }

  private markInterruptedRuns() {
    const now = new Date().toISOString();

    this.db
      .update(runsTable)
      .set({
        status: "interrupted",
        lastError: "Process restarted while the search was still active.",
        updatedAt: now,
        finishedAt: now,
        currentCandidate: null,
      })
      .where(eq(runsTable.status, "running"))
      .run();
  }

  listWordSources(): WordSource[] {
    const builtInIds = new Set(getBuiltInSources().map((source) => source.id));
    const uploads = this.db
      .select()
      .from(wordSourcesTable)
      .orderBy(desc(wordSourcesTable.kind), wordSourcesTable.name)
      .all()
      .map(mapWordSource);

    return sortWordSources([
      ...getPublicBuiltInSources(),
      ...uploads.filter((source) => !builtInIds.has(source.id)),
    ]);
  }

  getWordSourcesByIds(ids: string[]): WordSource[] {
    if (ids.length === 0) {
      return [];
    }

    const builtInSources = new Map(
      getBuiltInSources().map((source) => [source.id, source] as const),
    );
    const uploads = this.db
      .select()
      .from(wordSourcesTable)
      .where(inArray(wordSourcesTable.id, ids))
      .all()
      .map(mapWordSource)
      .filter((source) => !builtInSources.has(source.id));
    const uploadsById = new Map(
      uploads.map((source) => [source.id, source] as const),
    );

    return ids
      .map((id) => builtInSources.get(id) ?? uploadsById.get(id) ?? null)
      .filter((source): source is WordSource => Boolean(source));
  }

  createUploadSource(input: {
    name: string;
    description: string;
    buckets: WordBuckets;
  }): WordSource {
    const now = new Date().toISOString();
    const wordCount = Object.values(input.buckets).reduce(
      (total, bucket) => total + bucket.length,
      0,
    );
    const id = `upload-${crypto.randomUUID()}`;

    this.db
      .insert(wordSourcesTable)
      .values({
        id,
        name: input.name,
        kind: "upload",
        description: input.description,
        payload: JSON.stringify(input.buckets),
        wordCount,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    const row = this.db
      .select()
      .from(wordSourcesTable)
      .where(eq(wordSourcesTable.id, id))
      .get();

    return mapWordSource(row!);
  }

  createRun(config: RunConfig, generatedCount: number): RunRecord {
    const now = new Date().toISOString();
    const id = crypto.randomUUID();

    this.db
      .insert(runsTable)
      .values({
        id,
        status: "running",
        selectedTlds: JSON.stringify(config.selectedTlds),
        enabledStyles: JSON.stringify(config.enabledStyles),
        wordSourceIds: JSON.stringify(config.wordSourceIds),
        targetHits: config.targetHits,
        concurrency: config.concurrency,
        scoreThreshold: config.scoreThreshold ?? null,
        generatedCount,
        checkedCount: 0,
        skippedCount: 0,
        availableCount: 0,
        currentCandidate: null,
        lastError: null,
        stopRequested: 0,
        manualDomains: JSON.stringify(config.manualDomains ?? []),
        startedAt: now,
        updatedAt: now,
        finishedAt: null,
      })
      .run();

    return this.getRun(id)!;
  }

  storeCandidates(runId: string, candidates: Candidate[]) {
    if (candidates.length === 0) {
      return;
    }

    const generatedAt = new Date().toISOString();

    for (const group of chunk(candidates, 200)) {
      this.db
        .insert(candidatesTable)
        .values(
          group.map((candidate) => ({
            runId,
            label: candidate.label,
            style: candidate.style,
            sourceWords: JSON.stringify(candidate.sourceWords),
            score: candidate.score,
            fullDomains: JSON.stringify(candidate.fullDomains),
            generatedAt,
          })),
        )
        .run();
    }
  }

  getCheckedDomain(domain: string): CheckedDomainRow | undefined {
    const row = this.db
      .select()
      .from(checkedDomainsTable)
      .where(eq(checkedDomainsTable.domain, domain))
      .get();

    if (!row) {
      return undefined;
    }

    if (isExpiredPreliminaryResult(row)) {
      this.db
        .delete(checkedDomainsTable)
        .where(eq(checkedDomainsTable.domain, domain))
        .run();
      return undefined;
    }

    return row;
  }

  setCurrentCandidate(runId: string, domain: string) {
    this.db
      .update(runsTable)
      .set({
        currentCandidate: domain,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(runsTable.id, runId))
      .run();
  }

  incrementSkipped(runId: string, domain: string) {
    this.db
      .update(runsTable)
      .set({
        skippedCount: sql`${runsTable.skippedCount} + 1`,
        currentCandidate: domain,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(runsTable.id, runId))
      .run();
  }

  requestStop(runId: string) {
    this.db
      .update(runsTable)
      .set({
        stopRequested: 1,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(runsTable.id, runId))
      .run();
  }

  setLastError(runId: string, message: string | null) {
    this.db
      .update(runsTable)
      .set({
        lastError: message,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(runsTable.id, runId))
      .run();
  }

  incrementChecked(runId: string, amount: number, currentCandidate: string) {
    if (amount <= 0) {
      return;
    }

    this.db
      .update(runsTable)
      .set({
        checkedCount: sql`${runsTable.checkedCount} + ${amount}`,
        currentCandidate,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(runsTable.id, runId))
      .run();
  }

  recordPreliminaryBatch(input: {
    runId: string;
    screens: Array<{
      candidate: Candidate;
      domain: string;
      result: AvailabilityResult;
    }>;
    checkedCountIncrement: number;
    currentCandidate: string;
  }) {
    const transaction = this.sqlite.transaction(() => {
      for (const screen of input.screens) {
        const tld = screen.domain.split(".").pop() as SupportedTld;

        this.db
          .insert(checkedDomainsTable)
          .values({
            domain: screen.domain,
            label: screen.candidate.label,
            tld,
            style: screen.candidate.style,
            sourceWords: JSON.stringify(screen.candidate.sourceWords),
            score: screen.candidate.score,
            status: screen.result.status,
            stage: screen.result.stage ?? "preliminary",
            provider: screen.result.provider,
            confidence: screen.result.confidence,
            note: screen.result.note,
            checkedAt: screen.result.checkedAt,
            expiresAt: screen.result.expiresAt ?? null,
            lastRunId: input.runId,
          })
          .onConflictDoUpdate({
            target: checkedDomainsTable.domain,
            set: {
              label: screen.candidate.label,
              tld,
              style: screen.candidate.style,
              sourceWords: JSON.stringify(screen.candidate.sourceWords),
              score: screen.candidate.score,
              status: screen.result.status,
              stage: screen.result.stage ?? "preliminary",
              provider: screen.result.provider,
              confidence: screen.result.confidence,
              note: screen.result.note,
              checkedAt: screen.result.checkedAt,
              expiresAt: screen.result.expiresAt ?? null,
              lastRunId: input.runId,
            },
          })
          .run();
      }

      this.db
        .update(runsTable)
        .set({
          checkedCount: sql`${runsTable.checkedCount} + ${input.checkedCountIncrement}`,
          currentCandidate: input.currentCandidate,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(runsTable.id, input.runId))
        .run();
    });

    transaction();
  }

  recordCheckResult(input: {
    runId: string;
    candidate: Candidate;
    domain: string;
    result: AvailabilityResult;
    manual: boolean;
    incrementChecked?: boolean;
  }) {
    const tld = input.domain.split(".").pop() as SupportedTld;
    const incrementChecked = input.incrementChecked ?? true;

    const transaction = this.sqlite.transaction(() => {
      this.db
        .insert(checkedDomainsTable)
        .values({
          domain: input.domain,
          label: input.candidate.label,
          tld,
          style: input.candidate.style,
          sourceWords: JSON.stringify(input.candidate.sourceWords),
          score: input.candidate.score,
          status: input.result.status,
          stage: input.result.stage ?? "definitive",
          provider: input.result.provider,
          confidence: input.result.confidence,
          note: input.result.note,
          checkedAt: input.result.checkedAt,
          expiresAt: input.result.expiresAt ?? null,
          lastRunId: input.runId,
        })
        .onConflictDoUpdate({
          target: checkedDomainsTable.domain,
          set: {
            label: input.candidate.label,
            tld,
            style: input.candidate.style,
            sourceWords: JSON.stringify(input.candidate.sourceWords),
            score: input.candidate.score,
            status: input.result.status,
            stage: input.result.stage ?? "definitive",
            provider: input.result.provider,
            confidence: input.result.confidence,
            note: input.result.note,
            checkedAt: input.result.checkedAt,
            expiresAt: input.result.expiresAt ?? null,
            lastRunId: input.runId,
          },
        })
        .run();

      this.db
        .insert(runResultsTable)
        .values({
          runId: input.runId,
          domain: input.domain,
          label: input.candidate.label,
          tld,
          style: input.candidate.style,
          sourceWords: JSON.stringify(input.candidate.sourceWords),
          score: input.candidate.score,
          status: input.result.status,
          provider: input.result.provider,
          confidence: input.result.confidence,
          note: input.result.note,
          checkedAt: input.result.checkedAt,
          cached: 0,
          manual: input.manual ? 1 : 0,
        })
        .run();

      this.db
        .update(runsTable)
        .set({
          checkedCount: incrementChecked
            ? sql`${runsTable.checkedCount} + 1`
            : sql`${runsTable.checkedCount}`,
          availableCount:
            input.result.status === "available" &&
            (input.result.stage ?? "definitive") === "definitive"
              ? sql`${runsTable.availableCount} + 1`
              : sql`${runsTable.availableCount}`,
          currentCandidate: input.domain,
          lastError:
            input.result.status === "unknown" ? input.result.note : null,
          updatedAt: input.result.checkedAt,
        })
        .where(eq(runsTable.id, input.runId))
        .run();
    });

    transaction();
  }

  finishRun(runId: string, status: RunStatus, lastError: string | null = null) {
    const now = new Date().toISOString();

    this.db
      .update(runsTable)
      .set({
        status,
        currentCandidate: null,
        lastError,
        updatedAt: now,
        finishedAt: now,
      })
      .where(eq(runsTable.id, runId))
      .run();
  }

  getRun(runId: string): RunRecord | null {
    const row = this.db
      .select()
      .from(runsTable)
      .where(eq(runsTable.id, runId))
      .get();

    return row ? mapRun(row) : null;
  }

  getRunSnapshot(runId: string): RunSnapshot | null {
    const run = this.getRun(runId);

    if (!run) {
      return null;
    }

    const topHits = this.db
      .select()
      .from(runResultsTable)
      .where(
        and(
          eq(runResultsTable.runId, runId),
          eq(runResultsTable.status, "available"),
        ),
      )
      .orderBy(desc(runResultsTable.score), desc(runResultsTable.checkedAt))
      .limit(12)
      .all()
      .map(mapRunResult);

    const recentResults = this.db
      .select()
      .from(runResultsTable)
      .where(eq(runResultsTable.runId, runId))
      .orderBy(desc(runResultsTable.checkedAt), desc(runResultsTable.id))
      .limit(20)
      .all()
      .map(mapRunResult);

    return {
      run,
      topHits,
      recentResults,
    };
  }

  getHistory(): HistoryPayload {
    return {
      wordSources: this.listWordSources(),
      recentRuns: this.db
        .select()
        .from(runsTable)
        .orderBy(desc(runsTable.startedAt))
        .limit(12)
        .all()
        .map(mapRun),
      recentHits: this.db
        .select()
        .from(runResultsTable)
        .where(eq(runResultsTable.status, "available"))
        .orderBy(desc(runResultsTable.checkedAt), desc(runResultsTable.id))
        .limit(25)
        .all()
        .map(mapRunResult),
    };
  }

  getLatestSnapshot(): RunSnapshot | null {
    const latest = this.db
      .select()
      .from(runsTable)
      .orderBy(desc(runsTable.startedAt))
      .limit(1)
      .get();

    return latest ? this.getRunSnapshot(latest.id) : null;
  }
}
