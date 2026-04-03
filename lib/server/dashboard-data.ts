import {
  getAvailabilityProviderStatus,
} from "@/lib/domain/availability";
import type {
  AvailabilityProviderStatus,
  HistoryPayload,
  RunSnapshot,
} from "@/lib/domain/types";
import { getDomainService } from "@/lib/server/domain-service";

export type DashboardData = {
  history: HistoryPayload;
  currentRun: RunSnapshot | null;
  setupMessage: string | null;
  providerStatus: AvailabilityProviderStatus;
};

export async function getDashboardData(): Promise<DashboardData> {
  const service = getDomainService();
  // Hosted mode deliberately uses a single Postgres connection. Fetching both
  // dashboard queries in parallel can stall that client, so keep them ordered.
  const history = await service.getHistory();
  const currentRun = await service.getLatestSnapshot();

  return {
    history,
    currentRun,
    setupMessage: service.getSetupMessage(),
    providerStatus: getAvailabilityProviderStatus(),
  };
}
