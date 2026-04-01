import type { HistoryPayload, RunSnapshot } from "@/lib/domain/types";
import { getRunManager } from "@/lib/server/run-manager";

export type DashboardData = {
  history: HistoryPayload;
  currentRun: RunSnapshot | null;
};

export function getDashboardData(): DashboardData {
  const manager = getRunManager();

  return {
    history: manager.getHistory(),
    currentRun: manager.getLatestSnapshot(),
  };
}
