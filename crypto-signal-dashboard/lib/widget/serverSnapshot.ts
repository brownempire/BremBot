import { getAgentWalletForOwner } from "@/lib/perps/agentWallet";
import { fetchJupiterPerpsAccountSnapshot, type JupiterPerpsPosition } from "@/lib/jupiterPerps";
import { getPerpsSession } from "@/lib/perps/sessionStore";
import type { PerpsAutomationSession } from "@/lib/perps/sessionTypes";
import { getWalletUsdcBalance } from "@/lib/perps/walletBalance";
import { fetchCoinbaseMinuteCandles } from "@/lib/price/coinbase";
import type { PricePoint } from "@/lib/price/simulated";

export type WidgetChartCandle = {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
};

export type WidgetServerSnapshot = {
  title: string;
  openPerpLabel: string;
  openPerpDetail: string;
  openPerpPnlUsd: number | null;
  openPerpPnlPercent: number | null;
  openPerpMarket: string | null;
  openPerpSide: "long" | "short" | null;
  openPerpPositionValueUsd: number | null;
  openPerpCollateralUsd: number | null;
  openPerpEntryPrice: number | null;
  openPerpMarkPrice: number | null;
  openPerpLeverage: number | null;
  openPerpLiquidationPrice: number | null;
  openPerpTakeProfitPrice: number | null;
  openPerpStopLossPrice: number | null;
  openPerpTakeProfitPnlUsd: number | null;
  openPerpStopLossPnlUsd: number | null;
  chartSymbol: string | null;
  chartCandles: WidgetChartCandle[];
  walletBalanceUsd: number | null;
  mainWalletBalanceUsd: number | null;
  agentWalletBalanceUsd: number | null;
  perpsAutoTradeStatus: string;
  perpsSessionState: string;
  perpsMode: string;
  perpsExecutionModel: string;
  updatedAt: number;
  targetURL: string;
};

type WidgetSnapshotInput = {
  agentPositions: JupiterPerpsPosition[];
  mainPositions?: JupiterPerpsPosition[];
  mainAvailableUsdc: number | null;
  agentAvailableUsdc: number | null;
  session: PerpsAutomationSession | null;
  chartSymbol?: string | null;
  chartPoints?: PricePoint[];
  now?: Date;
};

function finiteOrNull(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function formatUsd(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function getLivePositions(positions: JupiterPerpsPosition[]) {
  return positions.filter((position) => position.source !== "mock" && position.source !== "rpc-placeholder");
}

function getChartAsset(position: JupiterPerpsPosition | null) {
  const source = [position?.marketSymbol, position?.marketName]
    .filter((value): value is string => Boolean(value))
    .join(" ")
    .toUpperCase();
  if (/\bSOL(?:ANA)?\b/.test(source)) return "SOL";
  if (/\bETH(?:EREUM)?\b/.test(source)) return "ETH";
  if (/\bBTC\b|\bBITCOIN\b/.test(source)) return "BTC";
  return null;
}

function buildChartCandles(points: PricePoint[] = []): WidgetChartCandle[] {
  return points
    .flatMap((point) => {
      const close = finiteOrNull(point.v);
      if (close === null || close <= 0) return [];
      const open = finiteOrNull(point.o) ?? close;
      const high = Math.max(finiteOrNull(point.h) ?? close, open, close);
      const low = Math.min(finiteOrNull(point.l) ?? close, open, close);
      if (!Number.isFinite(point.t) || point.t <= 0 || low <= 0) return [];
      return [{ timestamp: Math.round(point.t / 1_000), open, high, low, close }];
    })
    .sort((left, right) => left.timestamp - right.timestamp)
    .slice(-60);
}

function calculateExpectedPnl(position: JupiterPerpsPosition | null, targetPrice: number | null | undefined) {
  const entryPrice = finiteOrNull(position?.entryPrice);
  const positionSize = finiteOrNull(position?.positionSize);
  const target = finiteOrNull(targetPrice);
  if (!position || entryPrice === null || positionSize === null || target === null || positionSize <= 0) {
    return null;
  }

  const priceDelta = position.side === "long" ? target - entryPrice : entryPrice - target;
  return Number((priceDelta * positionSize).toFixed(2));
}

function calculatePerpsWalletEquity(availableUsdc: number | null, positions: JupiterPerpsPosition[]) {
  const equityParts = [
    finiteOrNull(availableUsdc),
    ...positions.map((position) => {
      const collateral = finiteOrNull(position.collateralValue);
      const pnl = finiteOrNull(position.unrealizedPnl) ?? 0;
      return collateral === null ? null : collateral + pnl;
    }),
  ].filter((value): value is number => value !== null);

  return equityParts.length > 0
    ? equityParts.reduce((sum, value) => sum + value, 0)
    : null;
}

export function buildWidgetServerSnapshot({
  agentPositions,
  mainPositions = [],
  mainAvailableUsdc,
  agentAvailableUsdc,
  session,
  chartSymbol = null,
  chartPoints = [],
  now = new Date(),
}: WidgetSnapshotInput): WidgetServerSnapshot {
  const liveAgentPositions = getLivePositions(agentPositions);
  const liveMainPositions = getLivePositions(mainPositions);
  const position = liveAgentPositions[0] ?? liveMainPositions[0] ?? null;
  const positionPnl = finiteOrNull(position?.unrealizedPnl);
  const positionCollateral = finiteOrNull(position?.collateralValue);
  const pnlPercent = positionPnl !== null && positionCollateral !== null && positionCollateral > 0
    ? (positionPnl / positionCollateral) * 100
    : null;
  const mainWalletBalanceUsd = calculatePerpsWalletEquity(mainAvailableUsdc, liveMainPositions);
  const agentWalletBalanceUsd = calculatePerpsWalletEquity(agentAvailableUsdc, liveAgentPositions);

  let openPerpLabel = "No open perps";
  let openPerpDetail = "Agent is monitoring for the next setup.";
  if (position) {
    const market = position.marketSymbol.replace(/\s+/g, "").toUpperCase();
    openPerpLabel = `${market} ${position.side.toUpperCase()}`;
    const details = [
      finiteOrNull(position.positionValue) !== null
        ? `${formatUsd(position.positionValue!)} position`
        : null,
      finiteOrNull(position.markPrice) !== null
        ? `${formatUsd(position.markPrice!)} mark`
        : null,
      finiteOrNull(position.leverage) !== null
        ? `${position.leverage!.toFixed(1).replace(/\.0$/, "")}x leverage`
        : null,
    ].filter((value): value is string => value !== null);
    openPerpDetail = details.join(" • ") || "Live Jupiter Perps position";
  }

  const clockedIn = session?.sessionState === "clocked_in";

  return {
    title: "BremLogic",
    openPerpLabel,
    openPerpDetail,
    openPerpPnlUsd: positionPnl,
    openPerpPnlPercent: finiteOrNull(pnlPercent),
    openPerpMarket: position ? position.marketSymbol.replace(/\s+/g, "").toUpperCase() : null,
    openPerpSide: position?.side ?? null,
    openPerpPositionValueUsd: finiteOrNull(position?.positionValue),
    openPerpCollateralUsd: positionCollateral,
    openPerpEntryPrice: finiteOrNull(position?.entryPrice),
    openPerpMarkPrice: finiteOrNull(position?.markPrice),
    openPerpLeverage: finiteOrNull(position?.leverage),
    openPerpLiquidationPrice: finiteOrNull(position?.liquidationPrice),
    openPerpTakeProfitPrice: finiteOrNull(position?.takeProfit),
    openPerpStopLossPrice: finiteOrNull(position?.stopLoss),
    openPerpTakeProfitPnlUsd: calculateExpectedPnl(position, position?.takeProfit),
    openPerpStopLossPnlUsd: calculateExpectedPnl(position, position?.stopLoss),
    chartSymbol: position ? chartSymbol ?? getChartAsset(position) : null,
    chartCandles: position ? buildChartCandles(chartPoints) : [],
    walletBalanceUsd: finiteOrNull(agentWalletBalanceUsd),
    mainWalletBalanceUsd: finiteOrNull(mainWalletBalanceUsd),
    agentWalletBalanceUsd: finiteOrNull(agentWalletBalanceUsd),
    perpsAutoTradeStatus: clockedIn ? "Agent monitoring is active" : "Perps auto-trade is off",
    perpsSessionState: clockedIn ? "Clocked In" : "Clocked Out",
    perpsMode: session?.mode === "live" ? "Live mode" : "Paper mode",
    perpsExecutionModel: session?.executionModel ?? "approval-assisted",
    updatedAt: now.getTime() / 1_000,
    targetURL: "bremlogic://open?target=%2Fsignals-bot%3Ftab%3Dperps",
  };
}

export async function loadWidgetServerSnapshot() {
  const ownerWallet = process.env.PERPS_AGENT_OWNER_WALLET?.trim();
  const agentWallet = getAgentWalletForOwner(ownerWallet);
  if (!ownerWallet || !agentWallet) {
    throw new Error("The server widget wallet association is not configured.");
  }

  const [agentPortfolioResult, mainPortfolioResult, mainBalanceResult, agentBalanceResult, sessionResult] = await Promise.allSettled([
    fetchJupiterPerpsAccountSnapshot(agentWallet),
    fetchJupiterPerpsAccountSnapshot(ownerWallet),
    getWalletUsdcBalance(ownerWallet),
    getWalletUsdcBalance(agentWallet),
    getPerpsSession(ownerWallet),
  ]);

  if (agentPortfolioResult.status === "rejected" && mainPortfolioResult.status === "rejected") {
    throw new Error("The live Perps portfolio is temporarily unavailable.");
  }

  const agentPositions = agentPortfolioResult.status === "fulfilled" ? agentPortfolioResult.value.positions : [];
  const mainPositions = mainPortfolioResult.status === "fulfilled" ? mainPortfolioResult.value.positions : [];
  const chartPosition = getLivePositions(agentPositions)[0] ?? getLivePositions(mainPositions)[0] ?? null;
  const chartSymbol = getChartAsset(chartPosition);
  const chartPoints = chartSymbol
    ? await fetchCoinbaseMinuteCandles(`${chartSymbol}-USD`, 61).catch(() => [])
    : [];

  return buildWidgetServerSnapshot({
    agentPositions,
    mainPositions,
    mainAvailableUsdc: mainBalanceResult.status === "fulfilled" ? mainBalanceResult.value : null,
    agentAvailableUsdc: agentBalanceResult.status === "fulfilled" ? agentBalanceResult.value : null,
    session: sessionResult.status === "fulfilled" ? sessionResult.value : null,
    chartSymbol,
    chartPoints,
  });
}
