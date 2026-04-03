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
import { getPostgresClient } from "@/lib/server/postgres-client";

type PostgresPrimitive = string | number | boolean | Date | null;

type WordSourceRow = {
  id: string;
  name: string;
  kind: WordSource["kind"];
  description: string;
  payload: WordBuckets;
  word_count: number;
  created_at: PostgresPrimitive;
  updated_at: PostgresPrimitive;
};

type RunRow = {
  id: string;
  status: RunStatus;
  selected_tlds: SupportedTld[];
  enabled_styles: string[];
  word_source_ids: string[];
  target_hits: number;
  concurrency: number;
  prefer_namecom: boolean;
  score_threshold: number | null;
  generated_count: number;
  checked_count: number;
  skipped_count: number;
  available_count: number;
  current_candidate: string | null;
  last_error: string | null;
  stop_requested: boolean;
  manual_domains: string[];
  started_at: PostgresPrimitive;
  updated_at: PostgresPrimitive;
  finished_at: PostgresPrimitive;
};

type RunResultRow = {
  id: number;
  run_id: string;
  domain: string;
  label: string;
  tld: SupportedTld;
  style: CandidateStyle;
  source_words: string[];
  score: number;
  status: RunResultRecord["status"];
  provider: string;
  confidence: number;
  note: string;
  checked_at: PostgresPrimitive;
  cached: boolean;
  manual: boolean;
};

type CheckedDomainRow = {
  domain: string;
  label: string;
  tld: SupportedTld;
  style: CandidateStyle;
  source_words: string[];
  score: number;
  status: RunResultRecord["status"];
  stage: "preliminary" | "definitive";
  provider: string;
  confidence: number;
  note: string;
  checked_at: PostgresPrimitive;
  expires_at: PostgresPrimitive;
  last_run_id: string;
};

function toIso(value: PostgresPrimitive): string {
  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value === "string") {
    return new Date(value).toISOString();
  }

  return new Date().toISOString();
}

function mapWordSource(row: WordSourceRow): WordSource {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    description: row.description,
    wordCount: row.word_count,
    buckets: row.payload,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function mapRun(row: RunRow): RunRecord {
  return {
    id: row.id,
    status: row.status,
    selectedTlds: row.selected_tlds,
    enabledStyles: coerceEnabledStyles(row.enabled_styles),
    wordSourceIds: row.word_source_ids,
    targetHits: row.target_hits,
    concurrency: row.concurrency,
    preferNameCom: row.prefer_namecom,
    scoreThreshold: row.score_threshold,
    generatedCount: row.generated_count,
    checkedCount: row.checked_count,
    skippedCount: row.skipped_count,
    availableCount: row.available_count,
    currentCandidate: row.current_candidate,
    lastError: row.last_error,
    stopRequested: row.stop_requested,
    manualDomains: row.manual_domains,
    startedAt: toIso(row.started_at),
    updatedAt: toIso(row.updated_at),
    finishedAt: row.finished_at ? toIso(row.finished_at) : null,
  };
}

function mapRunResult(row: RunResultRow): RunResultRecord {
  return {
    id: row.id,
    runId: row.run_id,
    domain: row.domain,
    label: row.label,
    tld: row.tld,
    style: row.style,
    sourceWords: row.source_words,
    score: row.score,
    status: row.status,
    provider: row.provider,
    confidence: row.confidence,
    note: row.note,
    checkedAt: toIso(row.checked_at),
    cached: row.cached,
    manual: row.manual,
  };
}

function isExpiredPreliminaryResult(row: CheckedDomainRow) {
  return (
    row.stage === "preliminary" &&
    row.expires_at !== null &&
    new Date(toIso(row.expires_at)).getTime() <= Date.now()
  );
}

export class VercelStore {
  private readonly sql = getPostgresClient();
  private initialized: Promise<void> | null = null;

  private async init() {
    if (!this.initialized) {
      this.initialized = this.initialize();
    }

    await this.initialized;
  }

  private async initialize() {
    await this.sql`
      create table if not exists word_sources (
        id text primary key,
        name text not null,
        kind text not null,
        description text not null,
        payload jsonb not null,
        word_count integer not null,
        created_at timestamptz not null,
        updated_at timestamptz not null
      );
    `;

    await this.sql`
      create table if not exists runs (
        id text primary key,
        status text not null,
        selected_tlds jsonb not null,
        enabled_styles jsonb not null,
        word_source_ids jsonb not null,
        target_hits integer not null,
        concurrency integer not null,
        prefer_namecom boolean not null default true,
        score_threshold double precision null,
        generated_count integer not null default 0,
        checked_count integer not null default 0,
        skipped_count integer not null default 0,
        available_count integer not null default 0,
        current_candidate text null,
        last_error text null,
        stop_requested boolean not null default false,
        manual_domains jsonb not null default '[]'::jsonb,
        started_at timestamptz not null,
        updated_at timestamptz not null,
        finished_at timestamptz null
      );
    `;

    await this.sql`
      alter table runs
      add column if not exists prefer_namecom boolean not null default true
    `;

    await this.sql`
      create table if not exists checked_domains (
        domain text primary key,
        label text not null,
        tld text not null,
        style text not null,
        source_words jsonb not null,
        score double precision not null,
        status text not null,
        stage text not null default 'definitive',
        provider text not null,
        confidence double precision not null,
        note text not null,
        checked_at timestamptz not null,
        expires_at timestamptz null,
        last_run_id text not null
      );
    `;

    await this.sql`
      alter table checked_domains
      add column if not exists stage text not null default 'definitive'
    `;
    await this.sql`
      alter table checked_domains
      add column if not exists expires_at timestamptz null
    `;

    await this.sql`
      create table if not exists run_results (
        id bigserial primary key,
        run_id text not null,
        domain text not null,
        label text not null,
        tld text not null,
        style text not null,
        source_words jsonb not null,
        score double precision not null,
        status text not null,
        provider text not null,
        confidence double precision not null,
        note text not null,
        checked_at timestamptz not null,
        cached boolean not null default false,
        manual boolean not null default false
      );
    `;

    await this.sql`create index if not exists runs_status_idx on runs(status)`;
    await this.sql`create index if not exists runs_started_at_idx on runs(started_at desc)`;
    await this.sql`create index if not exists run_results_run_id_idx on run_results(run_id)`;
    await this.sql`create index if not exists run_results_status_idx on run_results(status)`;
    await this.sql`create index if not exists run_results_checked_at_idx on run_results(checked_at desc)`;

  }

  async hasActiveRun(): Promise<boolean> {
    await this.init();
    const rows = await this.sql<{ count: string }[]>`
      select count(*)::text as count
      from runs
      where status = 'running'
    `;
    return Number(rows[0]?.count ?? 0) > 0;
  }

  async listWordSources(): Promise<WordSource[]> {
    await this.init();
    const builtInIds = new Set(getBuiltInSources().map((source) => source.id));
    const uploads = await this.sql<WordSourceRow[]>`
      select *
      from word_sources
      order by kind desc, name asc
    `;

    return sortWordSources([
      ...getPublicBuiltInSources(),
      ...uploads.map(mapWordSource).filter((source) => !builtInIds.has(source.id)),
    ]);
  }

  async getWordSourcesByIds(ids: string[]) {
    await this.init();
    if (ids.length === 0) {
      return [];
    }

    const builtInSources = new Map(
      getBuiltInSources().map((source) => [source.id, source] as const),
    );
    const uploads = await this.sql<WordSourceRow[]>`
      select *
      from word_sources
      where id = any(${ids})
    `;
    const uploadsById = new Map(
      uploads
        .map((row) => {
        const source = mapWordSource(row);
        return [source.id, source] as const;
      })
        .filter(([id]) => !builtInSources.has(id)),
    );

    return ids
      .map((id) => builtInSources.get(id) ?? uploadsById.get(id) ?? null)
      .filter((source): source is WordSource => Boolean(source));
  }

  async createUploadSource(input: {
    name: string;
    description: string;
    buckets: WordBuckets;
  }): Promise<WordSource> {
    await this.init();
    const now = new Date().toISOString();
    const id = `upload-${crypto.randomUUID()}`;
    const wordCount = Object.values(input.buckets).reduce(
      (total, bucket) => total + bucket.length,
      0,
    );

    const [row] = await this.sql<WordSourceRow[]>`
      insert into word_sources (
        id, name, kind, description, payload, word_count, created_at, updated_at
      )
      values (
        ${id},
        ${input.name},
        ${"upload"},
        ${input.description},
        ${this.sql.json(input.buckets)},
        ${wordCount},
        ${now},
        ${now}
      )
      returning *
    `;

    return mapWordSource(row);
  }

  async ensureRun(runId: string, config: RunConfig, generatedCount = 0) {
    await this.init();
    const now = new Date().toISOString();

    await this.sql`
      insert into runs (
        id, status, selected_tlds, enabled_styles, word_source_ids, target_hits,
        concurrency, prefer_namecom, score_threshold, generated_count, checked_count, skipped_count,
        available_count, current_candidate, last_error, stop_requested, manual_domains,
        started_at, updated_at, finished_at
      )
      values (
        ${runId},
        ${"running"},
        ${this.sql.json(config.selectedTlds)},
        ${this.sql.json(config.enabledStyles)},
        ${this.sql.json(config.wordSourceIds)},
        ${config.targetHits},
        ${config.concurrency},
        ${config.preferNameCom ?? true},
        ${config.scoreThreshold ?? null},
        ${generatedCount},
        0,
        0,
        0,
        ${null},
        ${null},
        ${false},
        ${this.sql.json(config.manualDomains ?? [])},
        ${now},
        ${now},
        ${null}
      )
      on conflict (id) do update set
        status = excluded.status,
        selected_tlds = excluded.selected_tlds,
        enabled_styles = excluded.enabled_styles,
        word_source_ids = excluded.word_source_ids,
        target_hits = excluded.target_hits,
        concurrency = excluded.concurrency,
        prefer_namecom = excluded.prefer_namecom,
        score_threshold = excluded.score_threshold,
        generated_count = greatest(runs.generated_count, excluded.generated_count),
        updated_at = excluded.updated_at
    `;
  }

  async updateGeneratedCount(runId: string, generatedCount: number) {
    await this.init();
    await this.sql`
      update runs
      set generated_count = ${generatedCount},
          updated_at = now()
      where id = ${runId}
    `;
  }

  async getCheckedDomain(domain: string): Promise<CheckedDomainRow | null> {
    await this.init();
    const rows = await this.sql<CheckedDomainRow[]>`
      select *
      from checked_domains
      where domain = ${domain}
      limit 1
    `;
    const row = rows[0] ?? null;

    if (!row) {
      return null;
    }

    if (isExpiredPreliminaryResult(row)) {
      await this.sql`
        delete from checked_domains
        where domain = ${domain}
      `;
      return null;
    }

    return row;
  }

  async setCurrentCandidate(runId: string, domain: string) {
    await this.init();
    await this.sql`
      update runs
      set current_candidate = ${domain},
          updated_at = now()
      where id = ${runId}
    `;
  }

  async incrementSkipped(runId: string, domain: string) {
    await this.init();
    await this.sql`
      update runs
      set skipped_count = skipped_count + 1,
          current_candidate = ${domain},
          updated_at = now()
      where id = ${runId}
    `;
  }

  async requestStop(runId: string) {
    await this.init();
    await this.sql`
      update runs
      set stop_requested = true,
          updated_at = now()
      where id = ${runId}
    `;
  }

  async setLastError(runId: string, message: string | null) {
    await this.init();
    await this.sql`
      update runs
      set last_error = ${message},
          updated_at = now()
      where id = ${runId}
    `;
  }

  async incrementChecked(runId: string, amount: number, currentCandidate: string) {
    await this.init();

    if (amount <= 0) {
      return;
    }

    await this.sql`
      update runs
      set checked_count = checked_count + ${amount},
          current_candidate = ${currentCandidate},
          updated_at = now()
      where id = ${runId}
    `;
  }

  async recordPreliminaryBatch(input: {
    runId: string;
    screens: Array<{
      candidate: Candidate;
      domain: string;
      result: AvailabilityResult;
    }>;
    checkedCountIncrement: number;
    currentCandidate: string;
  }) {
    await this.init();

    for (const screen of input.screens) {
      const tld = screen.domain.split(".").pop() as SupportedTld;

      await this.sql`
        insert into checked_domains (
          domain, label, tld, style, source_words, score, status, stage, provider,
          confidence, note, checked_at, expires_at, last_run_id
        )
        values (
          ${screen.domain},
          ${screen.candidate.label},
          ${tld},
          ${screen.candidate.style},
          ${this.sql.json(screen.candidate.sourceWords)},
          ${screen.candidate.score},
          ${screen.result.status},
          ${screen.result.stage ?? "preliminary"},
          ${screen.result.provider},
          ${screen.result.confidence},
          ${screen.result.note},
          ${screen.result.checkedAt},
          ${screen.result.expiresAt ?? null},
          ${input.runId}
        )
        on conflict (domain) do update set
          label = excluded.label,
          tld = excluded.tld,
          style = excluded.style,
          source_words = excluded.source_words,
          score = excluded.score,
          status = excluded.status,
          stage = excluded.stage,
          provider = excluded.provider,
          confidence = excluded.confidence,
          note = excluded.note,
          checked_at = excluded.checked_at,
          expires_at = excluded.expires_at,
          last_run_id = excluded.last_run_id
      `;
    }

    await this.incrementChecked(
      input.runId,
      input.checkedCountIncrement,
      input.currentCandidate,
    );
  }

  async recordCheckResult(input: {
    runId: string;
    candidate: Candidate;
    domain: string;
    result: AvailabilityResult;
    manual: boolean;
    incrementChecked?: boolean;
  }) {
    await this.init();
    const tld = input.domain.split(".").pop() as SupportedTld;
    const cached = false;
    const incrementChecked = input.incrementChecked ?? true;

    await this.sql`
      insert into checked_domains (
        domain, label, tld, style, source_words, score, status, stage, provider,
        confidence, note, checked_at, expires_at, last_run_id
      )
      values (
        ${input.domain},
        ${input.candidate.label},
        ${tld},
        ${input.candidate.style},
        ${this.sql.json(input.candidate.sourceWords)},
        ${input.candidate.score},
        ${input.result.status},
        ${input.result.stage ?? "definitive"},
        ${input.result.provider},
        ${input.result.confidence},
        ${input.result.note},
        ${input.result.checkedAt},
        ${input.result.expiresAt ?? null},
        ${input.runId}
      )
      on conflict (domain) do update set
        label = excluded.label,
        tld = excluded.tld,
        style = excluded.style,
        source_words = excluded.source_words,
        score = excluded.score,
        status = excluded.status,
        stage = excluded.stage,
        provider = excluded.provider,
        confidence = excluded.confidence,
        note = excluded.note,
        checked_at = excluded.checked_at,
        expires_at = excluded.expires_at,
        last_run_id = excluded.last_run_id
    `;

    await this.sql`
      insert into run_results (
        run_id, domain, label, tld, style, source_words, score,
        status, provider, confidence, note, checked_at, cached, manual
      )
      values (
        ${input.runId},
        ${input.domain},
        ${input.candidate.label},
        ${tld},
        ${input.candidate.style},
        ${this.sql.json(input.candidate.sourceWords)},
        ${input.candidate.score},
        ${input.result.status},
        ${input.result.provider},
        ${input.result.confidence},
        ${input.result.note},
        ${input.result.checkedAt},
        ${cached},
        ${input.manual}
      )
    `;

    await this.sql`
      update runs
      set checked_count = checked_count + ${incrementChecked ? 1 : 0},
          available_count = available_count + ${
            input.result.status === "available" &&
            (input.result.stage ?? "definitive") === "definitive"
              ? 1
              : 0
          },
          current_candidate = ${input.domain},
          last_error = ${input.result.status === "unknown" ? input.result.note : null},
          updated_at = ${input.result.checkedAt}
      where id = ${input.runId}
    `;
  }

  async finishRun(runId: string, status: RunStatus, lastError: string | null = null) {
    await this.init();
    await this.sql`
      update runs
      set status = ${status},
          current_candidate = ${null},
          last_error = ${lastError},
          updated_at = now(),
          finished_at = now()
      where id = ${runId}
    `;
  }

  async getRun(runId: string): Promise<RunRecord | null> {
    await this.init();
    const rows = await this.sql<RunRow[]>`
      select *
      from runs
      where id = ${runId}
      limit 1
    `;
    return rows[0] ? mapRun(rows[0]) : null;
  }

  async getRunSnapshot(runId: string): Promise<RunSnapshot | null> {
    await this.init();
    const run = await this.getRun(runId);

    if (!run) {
      return null;
    }

    const topHits = await this.sql<RunResultRow[]>`
      select *
      from run_results
      where run_id = ${runId} and status = 'available'
      order by score desc, checked_at desc
      limit 12
    `;

    const recentResults = await this.sql<RunResultRow[]>`
      select *
      from run_results
      where run_id = ${runId}
      order by checked_at desc, id desc
      limit 20
    `;

    return {
      run,
      topHits: topHits.map(mapRunResult),
      recentResults: recentResults.map(mapRunResult),
    };
  }

  async getHistory(): Promise<HistoryPayload> {
    await this.init();
    // Hosted mode intentionally uses a single Postgres connection to stay gentle on
    // pooled/serverless databases. Running these reads in parallel can stall on that
    // single-connection client, so keep the dashboard history fetches sequential.
    const wordSources = await this.listWordSources();
    const recentRuns = await this.sql<RunRow[]>`
      select *
      from runs
      order by started_at desc
      limit 12
    `;
    const recentHits = await this.sql<RunResultRow[]>`
      select *
      from run_results
      where status = 'available'
      order by checked_at desc, id desc
      limit 25
    `;

    return {
      wordSources,
      recentRuns: recentRuns.map(mapRun),
      recentHits: recentHits.map(mapRunResult),
    };
  }

  async getLatestSnapshot(): Promise<RunSnapshot | null> {
    await this.init();
    const rows = await this.sql<{ id: string }[]>`
      select id
      from runs
      order by started_at desc
      limit 1
    `;

    if (!rows[0]?.id) {
      return null;
    }

    return this.getRunSnapshot(rows[0].id);
  }
}

declare global {
  var __domainHunterVercelStore: VercelStore | undefined;
}

export function getVercelStore() {
  if (!globalThis.__domainHunterVercelStore) {
    globalThis.__domainHunterVercelStore = new VercelStore();
  }

  return globalThis.__domainHunterVercelStore;
}
