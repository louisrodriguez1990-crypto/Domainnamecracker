import { getWorkflowMetadata, sleep } from "workflow";

import { createAvailabilityProvider } from "@/lib/domain/availability";
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

async function loadWordSources(wordSourceIds: string[]): Promise<WordSource[]> {
  "use step";

  return getVercelStore().getWordSourcesByIds(wordSourceIds);
}

async function ensureRunRecord(runId: string, config: RunConfig) {
  "use step";

  await getVercelStore().ensureRun(runId, config, 0);
}

async function updateGeneratedCount(runId: string, generatedCount: number) {
  "use step";

  await getVercelStore().updateGeneratedCount(runId, generatedCount);
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

  await getVercelStore().finishRun(runId, status, lastError);
}

async function updateRunError(runId: string, message: string | null) {
  "use step";

  await getVercelStore().setLastError(runId, message);
}

async function checkWithRetries(
  domain: string,
  pacing: ReturnType<typeof getScanPacing>,
) {
  "use step";

  const provider = createAvailabilityProvider();
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

    await new Promise((resolve) => {
      setTimeout(
        resolve,
        jitter(
          pacing.unknownRetryBaseMs * (attempt + 1),
          pacing.unknownRetryVariationMs,
        ),
      );
    });
  }

  return lastUnknown;
}

async function processBatch(
  runId: string,
  tasks: ScanTask[],
  pacing: ReturnType<typeof getScanPacing>,
  recheckExisting = false,
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
    const result = await checkWithRetries(task.domain, pacing);

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

  try {
    await ensureRunRecord(workflowRunId, config);

    const sources =
      config.manualDomains && config.manualDomains.length > 0
        ? []
        : await loadWordSources(config.wordSourceIds);

    const candidates =
      config.manualDomains && config.manualDomains.length > 0
        ? buildManualCandidates(config, config.manualDomains)
        : buildCandidates(config, sources);

    await updateGeneratedCount(workflowRunId, candidates.length);

    const pacing = getScanPacing(config);
    const batchSize = Math.max(1, pacing.workerCount);
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

      const outcome = await processBatch(
        workflowRunId,
        batch,
        pacing,
        config.recheckExisting ?? false,
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

    const finalRun = await readRun(workflowRunId);

    if (!finalRun) {
      return { runId: workflowRunId };
    }

    if (finalRun.availableCount >= finalRun.targetHits) {
      await finalizeRun(workflowRunId, "completed", finalRun.lastError);
    } else if (finalRun.stopRequested) {
      await finalizeRun(workflowRunId, "stopped", finalRun.lastError);
    } else {
      await finalizeRun(workflowRunId, "exhausted", finalRun.lastError);
    }

    return { runId: workflowRunId };
  } catch (error) {
    await finalizeRun(
      workflowRunId,
      "interrupted",
      error instanceof Error ? error.message : "Unexpected workflow error.",
    );
    throw error;
  }
}
