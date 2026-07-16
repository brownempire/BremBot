import { getLastAutonomousMonitorRun } from "@/lib/perps/autonomousMonitor";
import { getAuthorizedWalletAddress } from "@/lib/perps/sessionAuth";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const walletAddress = await getAuthorizedWalletAddress(request);
  if (!walletAddress) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const lastRun = await getLastAutonomousMonitorRun().catch(() => null);
  const walletResult = lastRun?.results.find((result) => result.walletAddress === walletAddress) ?? null;
  return Response.json({
    lastRunAt: lastRun?.completedAt ?? null,
    monitorHealthy: lastRun?.ok ?? null,
    walletResult,
  }, { headers: { "Cache-Control": "no-store" } });
}
