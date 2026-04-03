import type {
  AvailabilityProvider,
  HybridAvailabilityProvider,
} from "@/lib/domain/availability";
import {
  NAMECOM_CHECK_BATCH_SIZE,
  NAMECOM_ZONE_BATCH_SIZE,
  checkDomainsWithProvider,
  createAvailabilityProvider,
  isHybridAvailabilityProvider,
} from "@/lib/domain/availability";
import { buildCandidates, buildManualCandidates } from "@/lib/domain/generator";
import {
  formatCooldownMessage,
  getCooldownDelayMs,
  getRetryAfterMs,
  getScanPacing,
} from "@/lib/domain/pacing";
import type {
  AvailabilityResult,
  Candidate,
  HistoryPayload,
  RunConfig,
  RunSnapshot,
  WordBuckets,
  WordSource,
} from "@/lib/domain/types";
import { allowsSourceFreeRun } from "@/lib/domain/types";
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

const MAX_STORED_CANDIDATES = 25000;

function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function jitter(base: number, variation: number): number {
  return base + Math.floor(Math.random() * variation);
}

function toUnknownResult(
  domain: string,
  note: string,
  provider: string,
): AvailabilityResult {
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
  private readonly providerFactory: (config: RunConfig) => AvailabilityProvider;
  private readonly sleeper: typeof sleep;
  private readonly activeRuns = new Map<string, ActiveRun>();

  constructor(options?: {
    store?: DomainHunterStore;
    provider?: AvailabilityProvider;
    providerFactory?: (config: RunConfig) => AvailabilityProvider;
    sleeper?: typeof sleep;
  }) {
    this.store = options?.store ?? new DomainHunterStore();
    this.providerFactory = options?.providerFactory ??
      (options?.provider
        ? (() => options.provider!)
        : ((config) =>
            createAvailabilityProvider({
              preferNameCom: config.preferNameCom ?? true,
            })));
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

    if (selectedSources.length === 0 && !allowsSourceFreeRun(config)) {
      throw new Error("Select at least one word source before starting a scan.");
    }

    const candidates =
      config.manualDomains && config.manualDomains.length > 0
        ? buildManualCandidates(config, config.manualDomains)
        : buildCandidates(config, selectedSources);

    const run = this.store.createRun(config, candidates.length);

    if (candidates.length <= MAX_STORED_CANDIDATES) {
      this.store.storeCandidates(run.id, candidates);
    }

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
    const pacing = getScanPacing(config);
    const provider = this.providerFactory(config);

    if (!activeRun) {
      return;
    }

    const hybridProvider = isHybridAvailabilityProvider(provider)
      ? provider
      : null;

    if (hybridProvider && (!config.manualDomains || config.manualDomains.length === 0)) {
      return this.processHybridRun(
        runId,
        config,
        candidates,
        activeRun,
        pacing,
        hybridProvider,
      );
    }

    let candidateIndex = 0;
    let domainIndex = 0;
    let cooldownUntilMs = 0;
    let consecutiveRateLimits = 0;

    const nextTask = () => {
      while (candidateIndex < candidates.length) {
        const candidate = candidates[candidateIndex];
        const domain = candidate?.fullDomains[domainIndex];

        if (candidate && domain) {
          domainIndex += 1;

          return {
            candidate,
            domain,
            manual: candidate.style === "manual",
          } satisfies RunTask;
        }

        candidateIndex += 1;
        domainIndex = 0;
      }

      return null;
    };

    const waitForCooldown = async () => {
      while (!activeRun.stopRequested) {
        const remainingMs = cooldownUntilMs - Date.now();

        if (remainingMs <= 0) {
          return;
        }

        const chunkMs = Math.min(remainingMs, 1_000);
        const startedAt = Date.now();

        await this.sleeper(chunkMs);

        const elapsedMs = Date.now() - startedAt;

        if (elapsedMs < chunkMs) {
          cooldownUntilMs -= chunkMs - elapsedMs;
        }
      }
    };

    const handleRateLimitHint = (result: AvailabilityResult | null) => {
      const retryAfterMs = result ? getRetryAfterMs(result) : null;

      if (!retryAfterMs) {
        if (consecutiveRateLimits > 0 && Date.now() >= cooldownUntilMs) {
          consecutiveRateLimits = 0;
        }

        return;
      }

      consecutiveRateLimits += 1;
      const cooldownMs = getCooldownDelayMs(
        retryAfterMs,
        consecutiveRateLimits,
        pacing.baseCooldownMs,
      );

      cooldownUntilMs = Math.max(cooldownUntilMs, Date.now() + cooldownMs);
      this.store.setLastError(
        runId,
        formatCooldownMessage(result?.note ?? "Availability provider asked us to retry later.", cooldownMs),
      );
    };

    const worker = async () => {
      while (!activeRun.stopRequested) {
        await waitForCooldown();
        const run = this.store.getRun(runId);

        if (!run || run.stopRequested || run.availableCount >= run.targetHits) {
          activeRun.stopRequested = activeRun.stopRequested || Boolean(run?.stopRequested);
          return;
        }

        const task = nextTask();

        if (!task) {
          return;
        }

        const result = await this.processTask(runId, task, config, pacing, provider);
        handleRateLimitHint(result);

        if (result) {
          await this.sleeper(
            jitter(pacing.interTaskDelayBaseMs, pacing.interTaskDelayVariationMs),
          );
        }
      }
    };

    try {
      await Promise.all(
        Array.from({ length: pacing.workerCount }, () => worker()),
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

  private async processHybridRun(
    runId: string,
    config: RunConfig,
    candidates: Candidate[],
    activeRun: ActiveRun,
    pacing: ReturnType<typeof getScanPacing>,
    provider: HybridAvailabilityProvider,
  ) {
    let candidateIndex = 0;
    let domainIndex = 0;
    let cooldownUntilMs = 0;
    let consecutiveRateLimits = 0;

    const nextTask = () => {
      while (candidateIndex < candidates.length) {
        const candidate = candidates[candidateIndex];
        const domain = candidate?.fullDomains[domainIndex];

        if (candidate && domain) {
          domainIndex += 1;

          return {
            candidate,
            domain,
            manual: false,
          } satisfies RunTask;
        }

        candidateIndex += 1;
        domainIndex = 0;
      }

      return null;
    };

    const waitForCooldown = async () => {
      while (!activeRun.stopRequested) {
        const remainingMs = cooldownUntilMs - Date.now();

        if (remainingMs <= 0) {
          return;
        }

        const chunkMs = Math.min(remainingMs, 1_000);
        const startedAt = Date.now();

        await this.sleeper(chunkMs);

        const elapsedMs = Date.now() - startedAt;

        if (elapsedMs < chunkMs) {
          cooldownUntilMs -= chunkMs - elapsedMs;
        }
      }
    };

    const handleRateLimitHint = (result: AvailabilityResult | null) => {
      const retryAfterMs = result ? getRetryAfterMs(result) : null;

      if (!retryAfterMs) {
        if (consecutiveRateLimits > 0 && Date.now() >= cooldownUntilMs) {
          consecutiveRateLimits = 0;
        }

        return;
      }

      consecutiveRateLimits += 1;
      const cooldownMs = getCooldownDelayMs(
        retryAfterMs,
        consecutiveRateLimits,
        pacing.baseCooldownMs,
      );

      cooldownUntilMs = Math.max(cooldownUntilMs, Date.now() + cooldownMs);
      this.store.setLastError(
        runId,
        formatCooldownMessage(
          result?.note ?? "Availability provider asked us to retry later.",
          cooldownMs,
        ),
      );
    };

    try {
      while (!activeRun.stopRequested) {
        await waitForCooldown();
        const run = this.store.getRun(runId);

        if (!run || run.stopRequested || run.availableCount >= run.targetHits) {
          activeRun.stopRequested = activeRun.stopRequested || Boolean(run?.stopRequested);
          break;
        }

        const screenBatch: RunTask[] = [];

        while (screenBatch.length < NAMECOM_ZONE_BATCH_SIZE) {
          const task = nextTask();

          if (!task) {
            break;
          }

          if (!config.recheckExisting && this.store.getCheckedDomain(task.domain)) {
            this.store.incrementSkipped(runId, task.domain);
            continue;
          }

          screenBatch.push(task);
        }

        if (screenBatch.length === 0) {
          break;
        }

        this.store.setCurrentCandidate(runId, screenBatch[0].domain);
        const screenResults = await provider.screenDomains(
          screenBatch.map((task) => task.domain),
        );
        const screenResultsByDomain = new Map(
          screenResults.map((result) => [result.domain, result] as const),
        );
        const definitiveTasks: RunTask[] = [];
        const preliminaryScreens: Array<{
          candidate: Candidate;
          domain: string;
          result: AvailabilityResult;
        }> = [];
        let screenedCount = 0;

        for (const task of screenBatch) {
          const result = screenResultsByDomain.get(task.domain);

          if (!result) {
            continue;
          }

          handleRateLimitHint(result);

          if (result.status === "taken") {
            screenedCount += 1;
            preliminaryScreens.push({
              candidate: task.candidate,
              domain: task.domain,
              result,
            });
            continue;
          }

          if (result.status === "available") {
            screenedCount += 1;
            definitiveTasks.push(task);
            continue;
          }

          if (!getRetryAfterMs(result)) {
            this.store.setLastError(runId, result.note);
          }
        }

        if (screenedCount > 0) {
          this.store.recordPreliminaryBatch({
            runId,
            screens: preliminaryScreens,
            checkedCountIncrement: screenedCount,
            currentCandidate: screenBatch[screenBatch.length - 1]!.domain,
          });
        }

        for (let index = 0; index < definitiveTasks.length; index += NAMECOM_CHECK_BATCH_SIZE) {
          await waitForCooldown();
          const liveRun = this.store.getRun(runId);

          if (
            activeRun.stopRequested ||
            !liveRun ||
            liveRun.stopRequested ||
            liveRun.availableCount >= liveRun.targetHits
          ) {
            activeRun.stopRequested =
              activeRun.stopRequested || Boolean(liveRun?.stopRequested);
            break;
          }

          const batch = definitiveTasks.slice(
            index,
            index + NAMECOM_CHECK_BATCH_SIZE,
          );

          if (batch.length === 0) {
            continue;
          }

          this.store.setCurrentCandidate(runId, batch[0].domain);
          const liveResults = await checkDomainsWithProvider(
            provider,
            batch.map((task) => task.domain),
          );
          const liveResultsByDomain = new Map(
            liveResults.map((result) => [result.domain, result] as const),
          );

          for (const task of batch) {
            const result =
              liveResultsByDomain.get(task.domain) ??
              toUnknownResult(
                task.domain,
                "Availability check did not produce a stable result.",
                provider.name,
              );

            handleRateLimitHint(result);
            this.store.recordCheckResult({
              runId,
              candidate: task.candidate,
              domain: task.domain,
              result: {
                ...result,
                stage: result.stage ?? "definitive",
              },
              manual: false,
              incrementChecked: false,
            });

            const updatedRun = this.store.getRun(runId);

            if (updatedRun?.availableCount && updatedRun.availableCount >= updatedRun.targetHits) {
              activeRun.stopRequested = true;
              break;
            }
          }
        }
      }

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

  private async processTask(
    runId: string,
    task: RunTask,
    config: RunConfig,
    pacing: ReturnType<typeof getScanPacing>,
    provider: AvailabilityProvider,
  ) {
    if (!config.recheckExisting && !task.manual && this.store.getCheckedDomain(task.domain)) {
      this.store.incrementSkipped(runId, task.domain);
      return null;
    }

    this.store.setCurrentCandidate(runId, task.domain);
    const result = await this.checkWithRetries(task.domain, pacing, provider);

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

    return result;
  }

  private async checkWithRetries(
    domain: string,
    pacing: ReturnType<typeof getScanPacing>,
    provider: AvailabilityProvider,
  ) {
    const providerName = provider.name;
    let lastUnknown = toUnknownResult(
      domain,
      "Availability check did not produce a stable result.",
      providerName,
    );

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const result = await provider.checkDomain(domain);

        if (getRetryAfterMs(result) || result.status !== "unknown" || attempt === 2) {
          return result;
        }

        lastUnknown = {
          ...toUnknownResult(domain, result.note, result.provider),
          retryAfterMs: result.retryAfterMs ?? null,
        };
      } catch (error) {
        lastUnknown = toUnknownResult(
          domain,
          error instanceof Error ? error.message : "Availability request failed.",
          providerName,
        );
      }

      await this.sleeper(
        jitter(pacing.unknownRetryBaseMs * (attempt + 1), pacing.unknownRetryVariationMs),
      );
    }

    return lastUnknown;
  }
}

declare global {
  var __domainHunterRunManager: RunManager | undefined;
}

export function getRunManager() {
  if (!globalThis.__domainHunterRunManager) {
    globalThis.__domainHunterRunManager = new RunManager();
  }

  return globalThis.__domainHunterRunManager;
}
