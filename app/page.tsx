import { Dashboard } from "@/components/dashboard";
import { getDashboardData } from "@/lib/server/dashboard-data";

export const dynamic = "force-dynamic";

export default function Home() {
  const { currentRun, history } = getDashboardData();

  return <Dashboard initialHistory={history} initialRun={currentRun} />;
}
