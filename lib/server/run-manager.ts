import type { AvailabilityProvider } from "@/lib/domain/availability";
import { createAvailabilityProvider } from "@/lib/domain/availability";
import { buildCandidates, buildManualCandidates } from "@/lib/domain/generator";
import type {
  Candidate,
  HistoryPayload,
  RunConfig,
  RunSnapshot,
  WordBuckets,
  WordSource,
} from "@/lib/domain/types";
import { createUploadBuckets } from "@/lib/domain/normalization";
import { DomainHunterStore } from "@/lib/server/store";

type ActiveRun = {
  stopRequested: boolean;
  promise: Promise<void>;
};

type RunTask = {
  candidate: Candidate;
  domain: string;
  manual: boolean;
};

function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function jitter(base: number, variation: number): number {
  return base + Math.floor(Math.random() * variation);
}

function toUnknownResult(domain: string, note: string, provider: string) {
  return {
    domain,
    status: "unknown" as const,
    provider,
    checkedAt: new Date().toISOString(),
    confidence: 0.12,
    note,
  };
}

export class RunManager {
  private readonly store: DomainHunterStore;
  private readonly provider: AvailabilityProvider;
  private readonly sleeper: typeof sleep;
  private readonly activeRuns = new Map<string, ActiveRun>();

  constructor(options?: {
    store?: DomainHunterStore;
    provider?: AvailabilityProvider;
    sleeper?: typeof sleep;
  }) {
    this.store = options?.store ?? new DomainHunterStore();
    this.provider = options?.provider ?? createAvailabilityProvider();
    this.sleeper = options?.sleeper ?? sleep;
  }

  getHistory(): HistoryPayload {
    return this.store.getHistory();
  }

  getLatestSnapshot(): RunSnapshot | null {
    return this.store.getLatestSnapshot();
  }

  getRunSnapshot(runId: string): RunSnapshot | null {
    return this.store.getRunSnapshot(runId);
  }

  listWordSources(): WordSource[] {
    return this.store.listWordSources();
  }

  createUploadSource(input: {
    name: string;
    description: string;
    words: string[];
  }): WordSource {
    const buckets: WordBuckets = createUploadBuckets(input.words);

    return this.store.createUploadSource({
      name: input.name,
      description: input.description,
      buckets,
    });
  }

  async startRun(config: RunConfig): Promise<RunSnapshot> {
    if (this.activeRuns.size > 0) {
      throw new Error("A scan is already running. Stop it before starting another.");
    }

    const selectedSources = this.store.getWordSourcesByIds(config.wordSourceIds);

    if (selectedSources.length === 0 && !(config.manualDomains?.length ?? 0)) {
      throw new Error("Select at least one word source before starting a scan.");
    }

    const candidates =
      config.manualDomains && config.manualDomains.length > 0
        ? buildManualCandidates(config, config.manualDomains)
        : buildCandidates(config, selectedSources);

    const run = this.store.createRun(config, candidates.length);
    this.store.storeCandidates(run.id, candidates);

    const activeRun: ActiveRun = {
      stopRequested: false,
      promise: Promise.resolve(),
    };

    this.activeRuns.set(run.id, activeRun);
    activeRun.promise = this.processRun(run.id, config, candidates);
    void activeRun.promise;

    return this.store.getRunSnapshot(run.id)!;
  }

  stopRun(runId: string): RunSnapshot | null {
    const activeRun = this.activeRuns.get(runId);

    if (activeRun) {
      activeRun.stopRequested = true;
    }

    this.store.requestStop(runId);
    return this.store.getRunSnapshot(runId);
  }

  private async processRun(runId: string, config: RunConfig, candidates: Candidate[]) {
    const activeRun = this.activeRuns.get(runId);

    if (!activeRun) {
      return;
    }

    const tasks: RunTask[] = candidates.flatMap((candidate) =>
      candidate.fullDomains.map((domain) => ({
        candidate,
        domain,
        manual: candidate.style === "manual",
      })),
    );

    let index = 0;

    const nextTask = () => {
      if (index >= tasks.length) {
        return null;
      }

      const task = tasks[index];
      index += 1;
      return task;
    };

    const worker = async () => {
      while (!activeRun.stopRequested) {
        const run = this.store.getRun(runId);

        if (!run || run.stopRequested || run.availableCount >= run.targetHits) {
          activeRun.stopRequested = activeRun.stopRequested || Boolean(run?.stopRequested);
          return;
        }

        const task = nextTask();

        if (!task) {
          return;
        }

        await this.processTask(runId, task, config);
        await this.sleeper(jitter(320, 240));
      }
    };

    try {
      await Promise.all(
        Array.from({ length: Math.min(config.concurrency, 2) }, () => worker()),
      );

      const finalRun = this.store.getRun(runId);

      if (!finalRun) {
        return;
      }

      if (finalRun.availableCount >= finalRun.targetHits) {
        this.store.finishRun(runId, "completed");
      } else if (finalRun.stopRequested || activeRun.stopRequested) {
        this.store.finishRun(runId, "stopped", finalRun.lastError);
      } else {
        this.store.finishRun(runId, "exhausted", finalRun.lastError);
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unexpected run failure.";
      this.store.finishRun(runId, "interrupted", message);
    } finally {
      this.activeRuns.delete(runId);
    }
  }

  private async processTask(runId: string, task: RunTask, config: RunConfig) {
    if (!config.recheckExisting && !task.manual && this.store.getCheckedDomain(task.domain)) {
      this.store.incrementSkipped(runId, task.domain);
      return;
    }

    this.store.setCurrentCandidate(runId, task.domain);
    const result = await this.checkWithRetries(task.domain);

    this.store.recordCheckResult({
      runId,
      candidate: task.candidate,
      domain: task.domain,
      result,
      manual: task.manual,
    });

    const run = this.store.getRun(runId);

    if (run?.availableCount && run.availableCount >= run.targetHits) {
      const activeRun = this.activeRuns.get(runId);

      if (activeRun) {
        activeRun.stopRequested = true;
      }
    }
  }

  private async checkWithRetries(domain: string) {
    const providerName = this.provider.name;
    let lastUnknown = toUnknownResult(
      domain,
      "Availability check did not produce a stable result.",
      providerName,
    );

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const result = await this.provider.checkDomain(domain);

        if (result.status !== "unknown" || attempt === 2) {
          return result;
        }

        lastUnknown = toUnknownResult(domain, result.note, result.provider);
      } catch (error) {
        lastUnknown = toUnknownResult(
          domain,
          error instanceof Error ? error.message : "Availability request failed.",
          providerName,
        );
      }

      await this.sleeper(jitter(450 * (attempt + 1), 250));
    }

    return lastUnknown;
  }
}

declare global {
  var __domainHunterRunManager: RunManager | undefined;
}

export function getRunManager() {
  if (!global.__domainHunterRunManager) {
    global.__domainHunterRunManager = new RunManager();
  }

  return global.__domainHunterRunManager;
}
