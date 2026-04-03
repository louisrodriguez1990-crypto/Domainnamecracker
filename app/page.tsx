import { Dashboard } from "@/components/dashboard";
import { getDashboardData } from "@/lib/server/dashboard-data";

export const dynamic = "force-dynamic";

export default async function Home() {
  const { currentRun, history, setupMessage, providerStatus } = await getDashboardData();

  return (
    <Dashboard
      initialHistory={history}
      initialRun={currentRun}
      setupMessage={setupMessage}
      providerStatus={providerStatus}
    />
  );
}
