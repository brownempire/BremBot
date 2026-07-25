import { runLockedAutonomousPerpsMonitor } from "@/lib/perps/autonomousMonitor";
import { runPerpsTradeNotificationWatch } from "@/lib/perps/tradeNotifications";
import { runLiveActivityUpdateWatch } from "@/lib/push/liveActivityWatch";

export const dynamic = "force-dynamic";
export const maxDuration = 55;

function isAuthorizedCron(request: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return false;
  return request.headers.get("authorization") === `Bearer ${secret}`;
}
export async function GET(request: Request) {
  if (!isAuthorizedCron(request)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await runLockedAutonomousPerpsMonitor();
    const [notificationResult, liveActivityResult] = await Promise.all([
      runPerpsTradeNotificationWatch().catch((error) => ({
        ok: false,
        error: error instanceof Error ? error.message : "Perps notification watcher failed.",
        wallets: 0,
        notifications: 0,
        sent: 0,
      })),
      runLiveActivityUpdateWatch().catch((error) => ({
        ok: false,
        error: error instanceof Error ? error.message : "Live Activity update watcher failed.",
        tokens: 0,
        sent: 0,
        ended: 0,
      })),
    ]);
    return Response.json({
      ...result,
      tradeNotifications: notificationResult,
      liveActivities: liveActivityResult,
    }, {
      status: result.ok ? 200 : 207,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return Response.json({
      error: error instanceof Error ? error.message : "Autonomous Perps monitor failed.",
    }, { status: 500 });
  }
}
