import { buildScalpAgentOverlaySnapshot } from "@/lib/chart/scalpAgentOverlay";
import { getActiveDecisionLearningProfile, listTradeLearningOutcomes } from "@/lib/decision/learningStore";
import { getPerpsAutomationConfig } from "@/lib/perps/automationConfigStore";
import { getScalpLearningProfile } from "@/lib/perps/scalpEngine";
import { getAuthorizedWalletAddress } from "@/lib/perps/sessionAuth";
import { fetchCoinbaseMinuteCandles } from "@/lib/price/coinbase";
import { BASE_INDICATOR_SETTINGS } from "@/lib/signal/indicators";
import { getRedisClient } from "@/lib/server/redis";

export const dynamic = "force-dynamic";

const LAST_SIGNAL_KEY = "brembot:perps:automation:last-signal";
const MARKETS = {
  "COINBASE:SOLUSD": { asset: "SOL", product: "SOL-USD" },
  "COINBASE:ETHUSD": { asset: "ETH", product: "ETH-USD" },
  "COINBASE:BTCUSD": { asset: "BTC", product: "BTC-USD" },
} as const;

export async function GET(request: Request) {
  const walletAddress = await getAuthorizedWalletAddress(request);
  if (!walletAddress) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(request.url);
  const symbol = String(url.searchParams.get("symbol") || "").trim().toUpperCase() as keyof typeof MARKETS;
  const market = MARKETS[symbol];
  if (!market) return Response.json({ error: "Unsupported scalp overlay market" }, { status: 400 });

  try {
    const [profile, config, points, outcomes, redis] = await Promise.all([
      getActiveDecisionLearningProfile(walletAddress),
      getPerpsAutomationConfig(walletAddress),
      fetchCoinbaseMinuteCandles(market.product, 180),
      listTradeLearningOutcomes(walletAddress),
      getRedisClient().catch(() => null),
    ]);
    const scalpProfile = getScalpLearningProfile(profile);
    const latestClosed = [...outcomes].reverse().find((outcome) => (
      outcome.signalType === "scalp" || outcome.scalpSetupType !== null
    )) ?? null;
    const rawLastSignal = redis
      ? await redis.hGet(LAST_SIGNAL_KEY, `${walletAddress}:${market.asset}:scalp`).catch(() => null)
      : null;
    const parsedLastSignal = Number(rawLastSignal);
    const activeSlot = config?.settings.slots.find((slot) => slot.id === config.settings.perpsActiveSlotId) ?? null;
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
      lastSignalAt: Number.isFinite(parsedLastSignal) && parsedLastSignal > 0 ? parsedLastSignal : null,
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
