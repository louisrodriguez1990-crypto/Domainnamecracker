import { describe, expect, it, vi } from "vitest";

import type { HistoryPayload } from "@/lib/domain/types";
import { getDashboardData } from "@/lib/server/dashboard-data";
import { getDomainService } from "@/lib/server/domain-service";
import { getAvailabilityProviderStatus } from "@/lib/domain/availability";

vi.mock("@/lib/server/domain-service", () => ({
  getDomainService: vi.fn(),
}));

vi.mock("@/lib/domain/availability", () => ({
  getAvailabilityProviderStatus: vi.fn(),
}));

const historyPayload: HistoryPayload = {
  wordSources: [],
  recentRuns: [],
  recentHits: [],
};

describe("getDashboardData", () => {
  it("loads history before requesting the latest snapshot", async () => {
    let releaseHistory = () => {};

    const historyReady = new Promise<void>((resolve) => {
      releaseHistory = resolve;
    });

    const service = {
      getHistory: vi.fn(async () => {
        await historyReady;
        return historyPayload;
      }),
      getLatestSnapshot: vi.fn(async () => null),
      getRunSnapshot: vi.fn(),
      listWordSources: vi.fn(),
      getSetupMessage: vi.fn(() => null),
      createUploadSource: vi.fn(),
      startRun: vi.fn(),
      stopRun: vi.fn(),
    };

    vi.mocked(getDomainService).mockReturnValue(service);
    vi.mocked(getAvailabilityProviderStatus).mockReturnValue({
      nameComConfigured: false,
      nameComSetupMessage: "missing",
      externalCheckerConfigured: false,
      defaultProvider: "rdap",
      fallbackProvider: "rdap",
    });

    const dashboardPromise = getDashboardData();
    await Promise.resolve();

    expect(service.getHistory).toHaveBeenCalledOnce();
    expect(service.getLatestSnapshot).not.toHaveBeenCalled();

    releaseHistory();

    const result = await dashboardPromise;

    expect(service.getLatestSnapshot).toHaveBeenCalledOnce();
    expect(result).toEqual({
      history: historyPayload,
      currentRun: null,
      setupMessage: null,
      providerStatus: {
        nameComConfigured: false,
        nameComSetupMessage: "missing",
        externalCheckerConfigured: false,
        defaultProvider: "rdap",
        fallbackProvider: "rdap",
      },
    });
  });
});
