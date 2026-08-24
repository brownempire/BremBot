import { buildScalpAgentOverlaySnapshot } from "@/lib/chart/scalpAgentOverlay";
import { getActiveDecisionLearningProfile, listTradeLearningOutcomes } from "@/lib/decision/learningStore";
import { getPerpsAutomationConfig } from "@/lib/perps/automationConfigStore";
import { getLastAutonomousMonitorRun } from "@/lib/perps/autonomousMonitor";
import { getScalpLearningProfile } from "@/lib/perps/scalpEngine";
import { getAuthorizedWalletAddress } from "@/lib/perps/sessionAuth";
import { fetchCoinbaseMinuteCandles } from "@/lib/price/coinbase";
import { BASE_INDICATOR_SETTINGS } from "@/lib/signal/indicators";

export const dynamic = "force-dynamic";

const MARKETS = {
  "COINBASE:SOLUSD": { asset: "SOL", product: "SOL-USD" },
  "COINBASE:ETHUSD": { asset: "ETH", product: "ETH-USD" },
  "COINBASE:BTCUSD": { asset: "BTC", product: "BTC-USD" },
} as const;

const MONITOR_STALE_AFTER_MS = 7 * 60_000;

export async function GET(request: Request) {
  const walletAddress = await getAuthorizedWalletAddress(request);
  if (!walletAddress) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(request.url);
  const symbol = String(url.searchParams.get("symbol") || "").trim().toUpperCase() as keyof typeof MARKETS;
  const market = MARKETS[symbol];
  if (!market) return Response.json({ error: "Unsupported scalp overlay market" }, { status: 400 });

  try {
    const [profile, config, points, outcomes, lastRun] = await Promise.all([
      getActiveDecisionLearningProfile(walletAddress),
      getPerpsAutomationConfig(walletAddress),
      fetchCoinbaseMinuteCandles(market.product, 240),
      listTradeLearningOutcomes(walletAddress),
      getLastAutonomousMonitorRun(),
    ]);
    const scalpProfile = getScalpLearningProfile(profile);
    const latestClosed = [...outcomes].reverse().find((outcome) => (
      outcome.signalType === "scalp" || outcome.scalpSetupType !== null
    )) ?? null;
    const activeSlot = config?.settings.slots.find((slot) => slot.id === config.settings.perpsActiveSlotId) ?? null;
    const walletResults = lastRun?.results.filter((result) => result.walletAddress === walletAddress) ?? [];
    const walletResult = walletResults.find((result) => result.status === "failed")
      ?? walletResults.at(-1)
      ?? null;
    const lastRunAt = lastRun?.completedAt ?? null;
    const lastRunTimestamp = lastRunAt ? Date.parse(lastRunAt) : Number.NaN;
    const stale = !Number.isFinite(lastRunTimestamp)
      || Date.now() - lastRunTimestamp > MONITOR_STALE_AFTER_MS;
    const consecutiveFailureCount = lastRun?.walletFailureStreaks?.[walletAddress]
      ?? (walletResult?.status === "failed" ? 1 : 0);
    const monitorHealthy = !stale
      && walletResult !== null
      && walletResult.status !== "failed";
    const snapshot = buildScalpAgentOverlaySnapshot({
      symbol,
      points,
      profile: scalpProfile,
      indicatorSettings: {
        ...BASE_INDICATOR_SETTINGS,
        ...(profile?.indicatorSettings ?? {}),
      },
      scalpModeEnabled: config?.settings.scalpModeEnabled === true,
      isActiveAsset: activeSlot?.token === market.asset,
      monitorHealth: {
        healthy: monitorHealthy,
        stale,
        lastRunAt,
        consecutiveFailureCount,
        code: walletResult?.code ?? null,
        message: stale
          ? "The autonomous monitor has not completed a recent cycle; new entries are blocked."
          : walletResult?.status === "failed"
            ? walletResult.message
            : null,
      },
      recentClosedTrade: latestClosed
        ? {
            openedAt: Date.parse(latestClosed.openedAt),
            closedAt: Date.parse(latestClosed.closedAt),
            side: latestClosed.side,
            netPnlUsd: latestClosed.netPnlUsd,
          }
        : null,
    });
    return Response.json(snapshot, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({
      error: error instanceof Error ? error.message : "Unable to build the scalp chart overlay.",
    }, { status: 503 });
  }
}
