import { getWorkflowMetadata, sleep } from "workflow";

import { createAvailabilityProvider } from "@/lib/domain/availability";
import { buildCandidates, buildManualCandidates } from "@/lib/domain/generator";
import type { Candidate, RunConfig, WordSource } from "@/lib/domain/types";
import { getVercelStore } from "@/lib/server/vercel-store";

type ScanTask = {
  candidate: Candidate;
  domain: string;
  manual: boolean;
};

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

async function checkWithRetries(domain: string) {
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

    await new Promise((resolve) => {
      setTimeout(resolve, jitter(450 * (attempt + 1), 250));
    });
  }

  return lastUnknown;
}

async function processBatch(runId: string, tasks: ScanTask[], recheckExisting = false) {
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
    const result = await checkWithRetries(task.domain);

    await store.recordCheckResult({
      runId,
      candidate: task.candidate,
      domain: task.domain,
      result,
      manual: task.manual,
    });
  };

  await Promise.all(tasks.map((task) => handleTask(task)));

  const run = await store.getRun(runId);

  return {
    shouldStop: !run || run.stopRequested || run.availableCount >= run.targetHits,
    lastError: run?.lastError ?? null,
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

    const tasks: ScanTask[] = candidates.flatMap((candidate) =>
      candidate.fullDomains.map((domain) => ({
        candidate,
        domain,
        manual: candidate.style === "manual",
      })),
    );

    const batchSize = Math.max(1, Math.min(config.concurrency, 2));

    for (let index = 0; index < tasks.length; index += batchSize) {
      const run = await readRun(workflowRunId);

      if (!run) {
        break;
      }

      if (run.stopRequested || run.availableCount >= run.targetHits) {
        break;
      }

      const batch = tasks.slice(index, index + batchSize);
      const outcome = await processBatch(
        workflowRunId,
        batch,
        config.recheckExisting ?? false,
      );

      if (outcome.shouldStop) {
        break;
      }

      await sleep(`${jitter(320, 240)}ms`);
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
