import { getWorkflowMetadata, sleep } from "workflow";

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
  RunConfig,
  WordSource,
} from "@/lib/domain/types";
import { getVercelStore } from "@/lib/server/vercel-store";

type ScanTask = {
  candidate: Candidate;
  domain: string;
  manual: boolean;
};

type ProviderContext = {
  providerName: string;
  usesHybridBatching: boolean;
};

type WorkflowStage =
  | "start-run"
  | "persist-run-record"
  | "load-word-sources"
  | "build-candidates"
  | "update-generated-count"
  | "resolve-provider-context"
  | "read-run"
  | "screen-batch"
  | "persist-preliminary-results"
  | "live-check-batch"
  | "persist-definitive-result"
  | "direct-batch"
  | "finalize-run";

function jitter(base: number, variation: number): number {
  return base + Math.floor(Math.random() * variation);
}

function delay(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function getErrorMessage(error: unknown) {
  return error instanceof Error
    ? error.message
    : typeof error === "string" && error.trim()
      ? error
      : "Unexpected workflow error.";
}

export function formatWorkflowStageError(stage: WorkflowStage, error: unknown) {
  return `[${stage}] ${getErrorMessage(error)}`;
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

async function loadWordSources(wordSourceIds: string[]): Promise<WordSource[]> {
  "use step";

  console.log("[domainScanWorkflow] load word sources:start", {
    wordSourceCount: wordSourceIds.length,
  });
  const sources = await getVercelStore().getWordSourcesByIds(wordSourceIds);
  console.log("[domainScanWorkflow] load word sources:done", {
    resolvedSourceCount: sources.length,
  });

  return sources;
}

async function buildWorkflowCandidates(
  config: RunConfig,
  sources: WordSource[],
): Promise<Candidate[]> {
  "use step";

  console.log("[domainScanWorkflow] build candidates:start", {
    manualDomainCount: config.manualDomains?.length ?? 0,
    sourceCount: sources.length,
  });
  const candidates =
    config.manualDomains && config.manualDomains.length > 0
      ? buildManualCandidates(config, config.manualDomains)
      : buildCandidates(config, sources);
  console.log("[domainScanWorkflow] build candidates:done", {
    candidateCount: candidates.length,
  });

  return candidates;
}

async function ensureRunRecord(runId: string, config: RunConfig) {
  "use step";

  console.log("[domainScanWorkflow] ensure run record:start", { runId });
  await getVercelStore().ensureRun(runId, config, 0);
  console.log("[domainScanWorkflow] ensure run record:done", { runId });
}

async function updateGeneratedCount(runId: string, generatedCount: number) {
  "use step";

  console.log("[domainScanWorkflow] update generated count:start", {
    runId,
    generatedCount,
  });
  await getVercelStore().updateGeneratedCount(runId, generatedCount);
  console.log("[domainScanWorkflow] update generated count:done", {
    runId,
    generatedCount,
  });
}

async function readRun(runId: string) {
  "use step";

  return getVercelStore().getRun(runId);
}

async function finalizeRun(
  runId: string,
  status: "completed" | "stopped" | "interrupted" | "exhausted",
  lastError: string | null,
) {
  "use step";

  console.log("[domainScanWorkflow] finalize run:start", {
    runId,
    status,
    lastError,
  });
  await getVercelStore().finishRun(runId, status, lastError);
  console.log("[domainScanWorkflow] finalize run:done", {
    runId,
    status,
  });
}

async function updateRunError(runId: string, message: string | null) {
  "use step";

  await getVercelStore().setLastError(runId, message);
}

async function getCheckedDomain(domain: string) {
  "use step";

  return getVercelStore().getCheckedDomain(domain);
}

async function incrementSkipped(runId: string, domain: string) {
  "use step";

  await getVercelStore().incrementSkipped(runId, domain);
}

async function setCurrentCandidate(runId: string, domain: string) {
  "use step";

  await getVercelStore().setCurrentCandidate(runId, domain);
}

async function checkWithRetries(
  domain: string,
  pacing: ReturnType<typeof getScanPacing>,
  preferNameCom = true,
) {
  "use step";

  const provider = createAvailabilityProvider({ preferNameCom });
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

    await delay(
      jitter(
        pacing.unknownRetryBaseMs * (attempt + 1),
        pacing.unknownRetryVariationMs,
      ),
    );
  }

  return lastUnknown;
}

async function resolveProviderContext(preferNameCom = true): Promise<ProviderContext> {
  "use step";

  console.log("[domainScanWorkflow] resolve provider context:start", {
    preferNameCom,
  });
  const provider = createAvailabilityProvider({ preferNameCom });
  const context = {
    providerName: provider.name,
    usesHybridBatching: isHybridAvailabilityProvider(provider),
  } satisfies ProviderContext;

  console.log("[domainScanWorkflow] resolve provider context:done", context);

  return context;
}

async function screenDomainsBatch(domains: string[]) {
  "use step";

  console.log("[domainScanWorkflow] screen batch:start", {
    domainCount: domains.length,
  });
  const provider = createAvailabilityProvider({ preferNameCom: true });

  if (!isHybridAvailabilityProvider(provider)) {
    throw new Error("Batch screening requires a hybrid availability provider.");
  }

  const results = await provider.screenDomains(domains);
  console.log("[domainScanWorkflow] screen batch:done", {
    domainCount: domains.length,
    resultCount: results.length,
  });

  return results;
}

async function checkDomainsBatch(domains: string[]) {
  "use step";

  console.log("[domainScanWorkflow] live batch:start", {
    domainCount: domains.length,
  });
  const provider = createAvailabilityProvider({ preferNameCom: true });
  const results = await checkDomainsWithProvider(provider, domains);
  console.log("[domainScanWorkflow] live batch:done", {
    domainCount: domains.length,
    resultCount: results.length,
  });

  return results;
}

async function recordPreliminaryBatch(input: {
  runId: string;
  screens: Array<{
    candidate: Candidate;
    domain: string;
    result: AvailabilityResult;
  }>;
  checkedCountIncrement: number;
  currentCandidate: string;
}) {
  "use step";

  console.log("[domainScanWorkflow] record preliminary:start", {
    runId: input.runId,
    screenCount: input.screens.length,
    checkedCountIncrement: input.checkedCountIncrement,
  });
  await getVercelStore().recordPreliminaryBatch(input);
  console.log("[domainScanWorkflow] record preliminary:done", {
    runId: input.runId,
    screenCount: input.screens.length,
  });
}

async function recordDefinitiveCheckResult(input: {
  runId: string;
  candidate: Candidate;
  domain: string;
  result: AvailabilityResult;
  manual: boolean;
  incrementChecked?: boolean;
}) {
  "use step";

  console.log("[domainScanWorkflow] record definitive:start", {
    runId: input.runId,
    domain: input.domain,
    status: input.result.status,
  });
  await getVercelStore().recordCheckResult(input);
  console.log("[domainScanWorkflow] record definitive:done", {
    runId: input.runId,
    domain: input.domain,
    status: input.result.status,
  });
}

async function processBatch(
  runId: string,
  tasks: ScanTask[],
  pacing: ReturnType<typeof getScanPacing>,
  recheckExisting = false,
  preferNameCom = true,
) {
  "use step";

  const store = getVercelStore();

  const handleTask = async (task: ScanTask) => {
    const run = await store.getRun(runId);

    if (!run || run.stopRequested || run.availableCount >= run.targetHits) {
      return;
    }

    if (!recheckExisting && !task.manual) {
      const cached = await store.getCheckedDomain(task.domain);

      if (cached) {
        await store.incrementSkipped(runId, task.domain);
        return;
      }
    }

    await store.setCurrentCandidate(runId, task.domain);
    const result = await checkWithRetries(task.domain, pacing, preferNameCom);

    await store.recordCheckResult({
      runId,
      candidate: task.candidate,
      domain: task.domain,
      result,
      manual: task.manual,
    });

    return result;
  };

  const results = await Promise.all(tasks.map((task) => handleTask(task)));
  const rateLimitedResults = results.filter(
    (result): result is AvailabilityResult => {
      if (!result) {
        return false;
      }

      return Boolean(getRetryAfterMs(result));
    },
  );
  const cooldownHintMs =
    rateLimitedResults.length > 0
      ? Math.max(
          ...rateLimitedResults.map((result) => getRetryAfterMs(result) ?? 0),
        )
      : null;

  const run = await store.getRun(runId);

  return {
    shouldStop: !run || run.stopRequested || run.availableCount >= run.targetHits,
    lastError: run?.lastError ?? null,
    cooldownHintMs,
    cooldownNote: rateLimitedResults[0]?.note ?? null,
  };
}

export async function domainScanWorkflow(config: RunConfig) {
  "use workflow";

  const { workflowRunId } = getWorkflowMetadata();
  let currentStage: WorkflowStage = "start-run";

  try {
    console.log("[domainScanWorkflow] start", {
      workflowRunId,
      preferNameCom: config.preferNameCom ?? true,
      manualDomainCount: config.manualDomains?.length ?? 0,
    });
    currentStage = "persist-run-record";
    await ensureRunRecord(workflowRunId, config);

    currentStage = "load-word-sources";
    const sources =
      config.manualDomains && config.manualDomains.length > 0
        ? []
        : await loadWordSources(config.wordSourceIds);

    currentStage = "build-candidates";
    const candidates = await buildWorkflowCandidates(config, sources);

    currentStage = "update-generated-count";
    await updateGeneratedCount(workflowRunId, candidates.length);

    const pacing = getScanPacing(config);
    currentStage = "resolve-provider-context";
    const providerContext = await resolveProviderContext(
      config.preferNameCom ?? true,
    );

    if (
      providerContext.usesHybridBatching &&
      (!config.manualDomains || config.manualDomains.length === 0)
    ) {
      console.log("[domainScanWorkflow] entering hybrid batch mode", {
        workflowRunId,
        provider: providerContext.providerName,
        candidateCount: candidates.length,
      });
      let candidateIndex = 0;
      let domainIndex = 0;
      let consecutiveRateLimits = 0;

      const nextTask = (): ScanTask | null => {
        while (candidateIndex < candidates.length) {
          const candidate = candidates[candidateIndex];
          const domain = candidate?.fullDomains[domainIndex];

          if (candidate && domain) {
            domainIndex += 1;

            return {
              candidate,
              domain,
              manual: false,
            };
          }

          candidateIndex += 1;
          domainIndex = 0;
        }

        return null;
      };

      while (true) {
        currentStage = "read-run";
        const run = await readRun(workflowRunId);

        if (!run || run.stopRequested || run.availableCount >= run.targetHits) {
          break;
        }

        const screenBatch: ScanTask[] = [];

        while (screenBatch.length < NAMECOM_ZONE_BATCH_SIZE) {
          const task = nextTask();

          if (!task) {
            break;
          }

          if (!config.recheckExisting) {
            const cached = await getCheckedDomain(task.domain);

            if (cached) {
              await incrementSkipped(workflowRunId, task.domain);
              continue;
            }
          }

          screenBatch.push(task);
        }

        if (screenBatch.length === 0) {
          break;
        }

        currentStage = "screen-batch";
        await setCurrentCandidate(workflowRunId, screenBatch[0].domain);
        const screenResults = await screenDomainsBatch(
          screenBatch.map((task) => task.domain),
        );
        const screenResultsByDomain = new Map(
          screenResults.map((result) => [result.domain, result] as const),
        );
        const screenRateLimitedResult =
          screenResults.find((result) => Boolean(getRetryAfterMs(result))) ?? null;
        const preliminaryScreens: Array<{
          candidate: Candidate;
          domain: string;
          result: AvailabilityResult;
        }> = [];
        const definitiveTasks: ScanTask[] = [];
        let screenedCount = 0;

        for (const task of screenBatch) {
          const result = screenResultsByDomain.get(task.domain);

          if (!result) {
            continue;
          }

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

          await updateRunError(workflowRunId, result.note);
        }

        if (screenedCount > 0) {
          currentStage = "persist-preliminary-results";
          await recordPreliminaryBatch({
            runId: workflowRunId,
            screens: preliminaryScreens,
            checkedCountIncrement: screenedCount,
            currentCandidate: screenBatch[screenBatch.length - 1]!.domain,
          });
        }

        if (screenRateLimitedResult) {
          consecutiveRateLimits += 1;
          const cooldownMs = getCooldownDelayMs(
            getRetryAfterMs(screenRateLimitedResult),
            consecutiveRateLimits,
            pacing.baseCooldownMs,
          );

          await updateRunError(
            workflowRunId,
            formatCooldownMessage(screenRateLimitedResult.note, cooldownMs),
          );
          await sleep(`${cooldownMs}ms`);
        } else if (consecutiveRateLimits > 0) {
          consecutiveRateLimits = 0;
        }

        for (
          let index = 0;
          index < definitiveTasks.length;
          index += NAMECOM_CHECK_BATCH_SIZE
        ) {
          currentStage = "read-run";
          const liveRun = await readRun(workflowRunId);

          if (
            !liveRun ||
            liveRun.stopRequested ||
            liveRun.availableCount >= liveRun.targetHits
          ) {
            break;
          }

          const batch = definitiveTasks.slice(
            index,
            index + NAMECOM_CHECK_BATCH_SIZE,
          );

          if (batch.length === 0) {
            continue;
          }

          currentStage = "live-check-batch";
          await setCurrentCandidate(workflowRunId, batch[0].domain);
          const liveResults = await checkDomainsBatch(
            batch.map((task) => task.domain),
          );
          const liveResultsByDomain = new Map(
            liveResults.map((result) => [result.domain, result] as const),
          );
          const liveRateLimitedResult =
            liveResults.find((result) => Boolean(getRetryAfterMs(result))) ?? null;

          for (const task of batch) {
            const result =
              liveResultsByDomain.get(task.domain) ??
              toUnknownResult(
                task.domain,
                "Availability check did not produce a stable result.",
                providerContext.providerName,
              );

            currentStage = "persist-definitive-result";
            await recordDefinitiveCheckResult({
              runId: workflowRunId,
              candidate: task.candidate,
              domain: task.domain,
              result: {
                ...result,
                stage: result.stage ?? "definitive",
              },
              manual: false,
              incrementChecked: false,
            });
          }

          if (liveRateLimitedResult) {
            consecutiveRateLimits += 1;
            const cooldownMs = getCooldownDelayMs(
              getRetryAfterMs(liveRateLimitedResult),
              consecutiveRateLimits,
              pacing.baseCooldownMs,
            );

            await updateRunError(
              workflowRunId,
              formatCooldownMessage(liveRateLimitedResult.note, cooldownMs),
            );
            await sleep(`${cooldownMs}ms`);
          } else if (consecutiveRateLimits > 0) {
            consecutiveRateLimits = 0;
          }
        }
      }

      const finalRun = await readRun(workflowRunId);

      if (!finalRun) {
        return { runId: workflowRunId };
      }

      currentStage = "finalize-run";
      if (finalRun.availableCount >= finalRun.targetHits) {
        await finalizeRun(workflowRunId, "completed", finalRun.lastError);
      } else if (finalRun.stopRequested) {
        await finalizeRun(workflowRunId, "stopped", finalRun.lastError);
      } else {
        await finalizeRun(workflowRunId, "exhausted", finalRun.lastError);
      }

      return { runId: workflowRunId };
    }

    const batchSize = Math.max(1, pacing.workerCount);
    console.log("[domainScanWorkflow] entering direct-check mode", {
      workflowRunId,
      provider: providerContext.providerName,
      batchSize,
      candidateCount: candidates.length,
    });
    let candidateIndex = 0;
    let domainIndex = 0;
    let consecutiveRateLimits = 0;

    const nextTask = (): ScanTask | null => {
      while (candidateIndex < candidates.length) {
        const candidate = candidates[candidateIndex];
        const domain = candidate?.fullDomains[domainIndex];

        if (candidate && domain) {
          domainIndex += 1;

          return {
            candidate,
            domain,
            manual: candidate.style === "manual",
          };
        }

        candidateIndex += 1;
        domainIndex = 0;
      }

      return null;
    };

    while (true) {
      currentStage = "read-run";
      const run = await readRun(workflowRunId);

      if (!run) {
        break;
      }

      if (run.stopRequested || run.availableCount >= run.targetHits) {
        break;
      }

      const batch: ScanTask[] = [];

      for (let index = 0; index < batchSize; index += 1) {
        const task = nextTask();

        if (!task) {
          break;
        }

        batch.push(task);
      }

      if (batch.length === 0) {
        break;
      }

      currentStage = "direct-batch";
      const outcome = await processBatch(
        workflowRunId,
        batch,
        pacing,
        config.recheckExisting ?? false,
        config.preferNameCom ?? true,
      );

      if (outcome.shouldStop) {
        break;
      }

      if (outcome.cooldownHintMs) {
        consecutiveRateLimits += 1;
        const cooldownMs = getCooldownDelayMs(
          outcome.cooldownHintMs,
          consecutiveRateLimits,
          pacing.baseCooldownMs,
        );

        await updateRunError(
          workflowRunId,
          formatCooldownMessage(
            outcome.cooldownNote ?? "Availability provider asked us to retry later.",
            cooldownMs,
          ),
        );
        await sleep(`${cooldownMs}ms`);
        continue;
      }

      if (consecutiveRateLimits > 0) {
        consecutiveRateLimits = 0;
      }

      await sleep(
        `${jitter(pacing.interTaskDelayBaseMs, pacing.interTaskDelayVariationMs)}ms`,
      );
    }

    currentStage = "read-run";
    const finalRun = await readRun(workflowRunId);

    if (!finalRun) {
      return { runId: workflowRunId };
    }

    currentStage = "finalize-run";
    if (finalRun.availableCount >= finalRun.targetHits) {
      await finalizeRun(workflowRunId, "completed", finalRun.lastError);
    } else if (finalRun.stopRequested) {
      await finalizeRun(workflowRunId, "stopped", finalRun.lastError);
    } else {
      await finalizeRun(workflowRunId, "exhausted", finalRun.lastError);
    }

    return { runId: workflowRunId };
  } catch (error) {
    const taggedError = formatWorkflowStageError(currentStage, error);
    console.error("[domainScanWorkflow] failed", {
      workflowRunId,
      stage: currentStage,
      error: taggedError,
      stack: error instanceof Error ? error.stack : undefined,
    });

    try {
      currentStage = "finalize-run";
      await finalizeRun(workflowRunId, "interrupted", taggedError);
    } catch (finalizeError) {
      console.error("[domainScanWorkflow] failed to persist interrupted run", {
        workflowRunId,
        error: formatWorkflowStageError("finalize-run", finalizeError),
      });
    }

    throw new Error(taggedError, {
      cause: error instanceof Error ? error : undefined,
    });
  }
}
