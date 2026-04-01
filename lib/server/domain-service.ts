import type {
  HistoryPayload,
  RunConfig,
  RunSnapshot,
  WordSource,
} from "@/lib/domain/types";
import { RunManager, getRunManager } from "@/lib/server/run-manager";
import { isHostedRuntime } from "@/lib/server/runtime";
import { getVercelDomainService } from "@/lib/server/vercel-service";

export type DomainService = {
  getHistory(): Promise<HistoryPayload>;
  getLatestSnapshot(): Promise<RunSnapshot | null>;
  getRunSnapshot(runId: string): Promise<RunSnapshot | null>;
  listWordSources(): Promise<WordSource[]>;
  createUploadSource(input: {
    name: string;
    description: string;
    words: string[];
  }): Promise<WordSource>;
  startRun(config: RunConfig): Promise<RunSnapshot>;
  stopRun(runId: string): Promise<RunSnapshot | null>;
};

class LocalDomainService implements DomainService {
  constructor(private readonly manager: RunManager) {}

  async getHistory() {
    return this.manager.getHistory();
  }

  async getLatestSnapshot() {
    return this.manager.getLatestSnapshot();
  }

  async getRunSnapshot(runId: string) {
    return this.manager.getRunSnapshot(runId);
  }

  async listWordSources() {
    return this.manager.listWordSources();
  }

  async createUploadSource(input: {
    name: string;
    description: string;
    words: string[];
  }) {
    return this.manager.createUploadSource(input);
  }

  async startRun(config: RunConfig) {
    return this.manager.startRun(config);
  }

  async stopRun(runId: string) {
    return this.manager.stopRun(runId);
  }
}

declare global {
  var __domainHunterLocalService: LocalDomainService | undefined;
}

function getLocalDomainService() {
  if (!global.__domainHunterLocalService) {
    global.__domainHunterLocalService = new LocalDomainService(getRunManager());
  }

  return global.__domainHunterLocalService;
}

export function getDomainService(): DomainService {
  if (isHostedRuntime()) {
    return getVercelDomainService();
  }

  return getLocalDomainService();
}
