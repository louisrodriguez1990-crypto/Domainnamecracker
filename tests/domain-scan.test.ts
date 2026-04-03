import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("domain scan workflow", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("tags provider-resolution failures with the workflow stage and logs an identifying marker", async () => {
    const finishRun = vi.fn().mockResolvedValue(undefined);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    vi.doMock("workflow", () => ({
      getWorkflowMetadata: () => ({ workflowRunId: "wrun_1" }),
      sleep: vi.fn().mockResolvedValue(undefined),
    }));

    vi.doMock("@/lib/server/vercel-store", () => ({
      getVercelStore: () => ({
        ensureRun: vi.fn().mockResolvedValue(undefined),
        getWordSourcesByIds: vi.fn().mockResolvedValue([]),
        updateGeneratedCount: vi.fn().mockResolvedValue(undefined),
        finishRun,
      }),
    }));

    vi.doMock("@/lib/domain/generator", () => ({
      buildCandidates: vi.fn(() => []),
      buildManualCandidates: vi.fn(() => []),
    }));

    vi.doMock("@/lib/domain/pacing", () => ({
      formatCooldownMessage: vi.fn((message: string) => message),
      getCooldownDelayMs: vi.fn(() => 0),
      getRetryAfterMs: vi.fn(() => null),
      getScanPacing: vi.fn(() => ({
        workerCount: 1,
        baseCooldownMs: 1_000,
        interTaskDelayBaseMs: 0,
        interTaskDelayVariationMs: 0,
        unknownRetryBaseMs: 0,
        unknownRetryVariationMs: 0,
      })),
    }));

    vi.doMock("@/lib/domain/availability", () => ({
      NAMECOM_CHECK_BATCH_SIZE: 50,
      NAMECOM_ZONE_BATCH_SIZE: 500,
      checkDomainsWithProvider: vi.fn(),
      createAvailabilityProvider: vi.fn(() => {
        throw new Error("Name.com auth bootstrap failed.");
      }),
      isHybridAvailabilityProvider: vi.fn(() => false),
    }));

    const { domainScanWorkflow } = await import("@/workflows/domain-scan");

    await expect(
      domainScanWorkflow({
        selectedTlds: ["com"],
        enabledStyles: ["keyword"],
        wordSourceIds: [],
        targetHits: 1,
        concurrency: 1,
        preferNameCom: true,
        scoreThreshold: 0,
      }),
    ).rejects.toThrow(
      "[resolve-provider-context] Name.com auth bootstrap failed.",
    );

    expect(finishRun).toHaveBeenCalledWith(
      "wrun_1",
      "interrupted",
      "[resolve-provider-context] Name.com auth bootstrap failed.",
    );
    expect(consoleError).toHaveBeenCalledWith(
      "[domainScanWorkflow] failed",
      expect.objectContaining({
        stage: "resolve-provider-context",
        error:
          "[resolve-provider-context] Name.com auth bootstrap failed.",
      }),
    );
  });
});
