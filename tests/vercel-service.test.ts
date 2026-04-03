import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RunConfig, RunSnapshot } from "@/lib/domain/types";

const startMock = vi.fn();
const getRunMock = vi.fn();
const storeMock = {
  getHistory: vi.fn(),
  getLatestSnapshot: vi.fn(),
  getRunSnapshot: vi.fn(),
  listWordSources: vi.fn(),
  createUploadSource: vi.fn(),
  hasActiveRun: vi.fn(),
  ensureRun: vi.fn(),
  requestStop: vi.fn(),
  finishRun: vi.fn(),
};

vi.mock("workflow/api", () => ({
  start: startMock,
  getRun: getRunMock,
}));

vi.mock("@/workflows/domain-scan", () => ({
  domainScanWorkflow: vi.fn(),
}));

vi.mock("@/lib/server/vercel-store", () => ({
  getVercelStore: () => storeMock,
}));

function createSnapshot(lastError: string | null = null): RunSnapshot {
  return {
    run: {
      id: "wrun_1",
      status: "running",
      selectedTlds: ["com"],
      enabledStyles: ["keyword"],
      wordSourceIds: [],
      targetHits: 1,
      concurrency: 1,
      preferNameCom: true,
      scoreThreshold: 0,
      generatedCount: 0,
      checkedCount: 0,
      skippedCount: 0,
      availableCount: 0,
      currentCandidate: null,
      lastError,
      stopRequested: false,
      manualDomains: [],
      startedAt: "2026-04-03T12:00:00.000Z",
      updatedAt: "2026-04-03T12:00:00.000Z",
      finishedAt: null,
    },
    topHits: [],
    recentResults: [],
  };
}

describe("vercel domain service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storeMock.getHistory.mockResolvedValue({ wordSources: [], recentRuns: [], recentHits: [] });
    storeMock.getLatestSnapshot.mockResolvedValue(null);
    storeMock.getRunSnapshot.mockReset();
    storeMock.listWordSources.mockResolvedValue([]);
    storeMock.createUploadSource.mockReset();
    storeMock.hasActiveRun.mockResolvedValue(false);
    storeMock.ensureRun.mockResolvedValue(undefined);
    storeMock.requestStop.mockResolvedValue(undefined);
    storeMock.finishRun.mockResolvedValue(undefined);
  });

  it("uses failed workflow return values to persist staged interrupt messages", async () => {
    const stagedError = "[resolve-provider-context] Name.com auth bootstrap failed.";
    const failedReturnValue = Promise.reject(new Error(stagedError));
    failedReturnValue.catch(() => undefined);
    storeMock.getRunSnapshot
      .mockResolvedValueOnce(createSnapshot(null))
      .mockResolvedValueOnce({
        ...createSnapshot(stagedError),
        run: {
          ...createSnapshot(stagedError).run,
          status: "interrupted",
          lastError: stagedError,
        },
      });
    getRunMock.mockReturnValue({
      status: Promise.resolve("failed"),
      returnValue: failedReturnValue,
      cancel: vi.fn(),
    });

    const { VercelDomainService } = await import("@/lib/server/vercel-service");
    const service = new VercelDomainService();

    const snapshot = await service.getRunSnapshot("wrun_1");

    expect(storeMock.finishRun).toHaveBeenCalledWith(
      "wrun_1",
      "interrupted",
      stagedError,
    );
    expect(snapshot?.run.lastError).toBe(stagedError);
  });

  it("keeps existing staged errors instead of replacing them with generic workflow failures", async () => {
    const stagedError = "[persist-definitive-result] Hosted Postgres write failed.";
    const failedReturnValue = Promise.reject(new Error("Workflow run failed"));
    failedReturnValue.catch(() => undefined);
    storeMock.getRunSnapshot
      .mockResolvedValueOnce(createSnapshot(stagedError))
      .mockResolvedValueOnce({
        ...createSnapshot(stagedError),
        run: {
          ...createSnapshot(stagedError).run,
          status: "interrupted",
          lastError: stagedError,
        },
      });
    getRunMock.mockReturnValue({
      status: Promise.resolve("failed"),
      returnValue: failedReturnValue,
      cancel: vi.fn(),
    });

    const { VercelDomainService } = await import("@/lib/server/vercel-service");
    const service = new VercelDomainService();

    const snapshot = await service.getRunSnapshot("wrun_1");

    expect(storeMock.finishRun).toHaveBeenCalledWith(
      "wrun_1",
      "interrupted",
      stagedError,
    );
    expect(snapshot?.run.lastError).toBe(stagedError);
  });

  it("starts hosted runs through workflow api and seeds the run record", async () => {
    const config: RunConfig = {
      selectedTlds: ["com"],
      enabledStyles: ["keyword"],
      wordSourceIds: [],
      targetHits: 1,
      concurrency: 1,
      preferNameCom: true,
      scoreThreshold: 0,
    };
    startMock.mockResolvedValue({ runId: "wrun_1" });
    storeMock.getRunSnapshot.mockResolvedValue(createSnapshot(null));

    const { VercelDomainService } = await import("@/lib/server/vercel-service");
    const service = new VercelDomainService();

    const snapshot = await service.startRun(config);

    expect(startMock).toHaveBeenCalled();
    expect(storeMock.ensureRun).toHaveBeenCalledWith("wrun_1", config, 0);
    expect(snapshot.run.id).toBe("wrun_1");
  });
});
