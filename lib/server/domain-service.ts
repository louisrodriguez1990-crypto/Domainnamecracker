import type {
  HistoryPayload,
  RunConfig,
  RunSnapshot,
  WordSource,
} from "@/lib/domain/types";
import { getPublicBuiltInSources } from "@/lib/domain/builtins";
import { RunManager, getRunManager } from "@/lib/server/run-manager";
import {
  getHostedDatabaseSetupMessage,
  isHostedRuntime,
  isVercelDeployment,
} from "@/lib/server/runtime";
import { getVercelDomainService } from "@/lib/server/vercel-service";

export type DomainService = {
  getHistory(): Promise<HistoryPayload>;
  getLatestSnapshot(): Promise<RunSnapshot | null>;
  getRunSnapshot(runId: string): Promise<RunSnapshot | null>;
  listWordSources(): Promise<WordSource[]>;
  getSetupMessage(): string | null;
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

  getSetupMessage() {
    return null;
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

class SetupDomainService implements DomainService {
  private readonly message = getHostedDatabaseSetupMessage();

  async getHistory() {
    return {
      wordSources: getPublicBuiltInSources(),
      recentRuns: [],
      recentHits: [],
    };
  }

  async getLatestSnapshot() {
    return null;
  }

  async getRunSnapshot() {
    return null;
  }

  async listWordSources() {
    return getPublicBuiltInSources();
  }

  getSetupMessage() {
    return this.message;
  }

  async createUploadSource(
    input: {
      name: string;
      description: string;
      words: string[];
    },
  ): Promise<WordSource> {
    void input;
    throw new Error(this.message);
  }

  async startRun(config: RunConfig): Promise<RunSnapshot> {
    void config;
    throw new Error(this.message);
  }

  async stopRun(runId: string): Promise<RunSnapshot | null> {
    void runId;
    return null;
  }
}

declare global {
  var __domainHunterLocalService: LocalDomainService | undefined;
  var __domainHunterSetupService: SetupDomainService | undefined;
}

function getLocalDomainService() {
  if (!global.__domainHunterLocalService) {
    global.__domainHunterLocalService = new LocalDomainService(getRunManager());
  }

  return global.__domainHunterLocalService;
}

function getSetupDomainService() {
  if (!global.__domainHunterSetupService) {
    global.__domainHunterSetupService = new SetupDomainService();
  }

  return global.__domainHunterSetupService;
}

export function getDomainService(): DomainService {
  if (isHostedRuntime()) {
    return getVercelDomainService();
  }

  if (isVercelDeployment()) {
    return getSetupDomainService();
  }

  return getLocalDomainService();
}
