import type { HistoryPayload, RunSnapshot } from "@/lib/domain/types";
import { getDomainService } from "@/lib/server/domain-service";

export type DashboardData = {
  history: HistoryPayload;
  currentRun: RunSnapshot | null;
  setupMessage: string | null;
};

export async function getDashboardData(): Promise<DashboardData> {
  const service = getDomainService();
  const [history, currentRun] = await Promise.all([
    service.getHistory(),
    service.getLatestSnapshot(),
  ]);

  return {
    history,
    currentRun,
    setupMessage: service.getSetupMessage(),
  };
}
