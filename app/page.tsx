import { Dashboard } from "@/components/dashboard";
import { getDashboardData } from "@/lib/server/dashboard-data";

export const dynamic = "force-dynamic";

export default async function Home() {
  const { currentRun, history } = await getDashboardData();

  return <Dashboard initialHistory={history} initialRun={currentRun} />;
}
