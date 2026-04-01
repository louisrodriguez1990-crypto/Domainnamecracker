import { getRun, start } from "workflow/api";

import type {
  HistoryPayload,
  RunConfig,
  RunSnapshot,
  WordSource,
} from "@/lib/domain/types";
import { domainScanWorkflow } from "@/workflows/domain-scan";
import { getVercelStore } from "@/lib/server/vercel-store";

function mapWorkflowStatus(
  workflowStatus: "pending" | "running" | "completed" | "failed" | "cancelled",
  snapshot: RunSnapshot,
): RunSnapshot["run"]["status"] {
  if (workflowStatus === "failed") {
    return "interrupted";
  }

  if (workflowStatus === "cancelled") {
    return "stopped";
  }

  if (workflowStatus === "pending" || workflowStatus === "running") {
    return "running";
  }

  return snapshot.run.availableCount >= snapshot.run.targetHits
    ? "completed"
    : "exhausted";
}

export class VercelDomainService {
  private readonly store = getVercelStore();

  async getHistory(): Promise<HistoryPayload> {
    return this.store.getHistory();
  }

  async getLatestSnapshot(): Promise<RunSnapshot | null> {
    const snapshot = await this.store.getLatestSnapshot();

    if (!snapshot) {
      return null;
    }

    return this.syncSnapshot(snapshot.run.id);
  }

  async getRunSnapshot(runId: string): Promise<RunSnapshot | null> {
    return this.syncSnapshot(runId);
  }

  async listWordSources(): Promise<WordSource[]> {
    return this.store.listWordSources();
  }

  async createUploadSource(input: {
    name: string;
    description: string;
    words: string[];
  }) {
    const { createUploadBuckets } = await import("@/lib/domain/normalization");

    return this.store.createUploadSource({
      name: input.name,
      description: input.description,
      buckets: createUploadBuckets(input.words),
    });
  }

  async startRun(config: RunConfig): Promise<RunSnapshot> {
    if (await this.store.hasActiveRun()) {
      throw new Error("A scan is already running. Stop it before starting another.");
    }

    const run = await start(domainScanWorkflow, [config]);

    await this.store.ensureRun(run.runId, config, 0);

    return (await this.store.getRunSnapshot(run.runId))!;
  }

  async stopRun(runId: string): Promise<RunSnapshot | null> {
    const snapshot = await this.store.getRunSnapshot(runId);

    if (!snapshot) {
      return null;
    }

    await this.store.requestStop(runId);
    await getRun(runId).cancel().catch(() => undefined);
    await this.store.finishRun(runId, "stopped", snapshot.run.lastError);

    return this.store.getRunSnapshot(runId);
  }

  private async syncSnapshot(runId: string): Promise<RunSnapshot | null> {
    const snapshot = await this.store.getRunSnapshot(runId);

    if (!snapshot || snapshot.run.status !== "running") {
      return snapshot;
    }

    const workflowRun = getRun(runId);
    const workflowStatus = (await workflowRun.status.catch(
      () => "running" as const,
    )) as "pending" | "running" | "completed" | "failed" | "cancelled";
    const mappedStatus = mapWorkflowStatus(workflowStatus, snapshot);

    if (mappedStatus !== "running") {
      await this.store.finishRun(runId, mappedStatus, snapshot.run.lastError);
      return this.store.getRunSnapshot(runId);
    }

    return snapshot;
  }
}

declare global {
  var __domainHunterVercelService: VercelDomainService | undefined;
}

export function getVercelDomainService() {
  if (!global.__domainHunterVercelService) {
    global.__domainHunterVercelService = new VercelDomainService();
  }

  return global.__domainHunterVercelService;
}
