import { getAgentWalletForOwner } from "@/lib/perps/agentWallet";
import { type JupiterPerpsPosition } from "@/lib/jupiterPerps";
import { loadAccountedPerpsSnapshot } from "@/lib/perps/pnlAccountingServer";
import { summarizeNetExitPnl, projectedNetExitPnl } from "@/lib/perps/pnlAccounting";
import { getPerpsSession } from "@/lib/perps/sessionStore";
import type { PerpsAutomationSession, PerpsUserExecution } from "@/lib/perps/sessionTypes";
import { listUserPerpsExecutions } from "@/lib/perps/userExecutionAudit";
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
  openPerpStrategy: "smart" | "scalp" | null;
  openPerpPositionValueUsd: number | null;
  openPerpCollateralUsd: number | null;
  openPerpEntryPrice: number | null;
  openPerpEntryTimestamp: number | null;
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
  executions?: PerpsUserExecution[];
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
  return position ? projectedNetExitPnl(position, targetPrice) : null;
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

function marketAsset(market: string) {
  const normalized = market.toUpperCase();
  if (normalized.includes("BTC")) return "BTC";
  if (normalized.includes("ETH")) return "ETH";
  return "SOL";
}

function findPositionExecution(
  position: JupiterPerpsPosition | null,
  executions: PerpsUserExecution[] = []
) {
  if (!position) return null;
  const direct = position.accountRef
    ? executions.find((execution) => execution.positionPubkey === position.accountRef)
    : null;
  if (direct) return direct;

  const asset = marketAsset(position.marketSymbol);
  return executions
    .filter((execution) => (
      execution.asset === asset
      && execution.side === position.side
      && ["prepared", "submitted", "confirmed"].includes(execution.status)
    ))
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0]
    ?? null;
}

function executionTimestamp(execution: PerpsUserExecution | null) {
  if (!execution) return null;
  const timestamp = Date.parse(execution.createdAt);
  return Number.isFinite(timestamp) && timestamp > 0 ? Math.round(timestamp / 1_000) : null;
}

export function buildWidgetServerSnapshot({
  agentPositions,
  mainPositions = [],
  mainAvailableUsdc,
  agentAvailableUsdc,
  session,
  executions = [],
  chartSymbol = null,
  chartPoints = [],
  now = new Date(),
}: WidgetSnapshotInput): WidgetServerSnapshot {
  const liveAgentPositions = getLivePositions(agentPositions);
  const liveMainPositions = getLivePositions(mainPositions);
  const preferredPosition = liveAgentPositions[0] ?? liveMainPositions[0] ?? null;
  const marketPositions = [...new Map([...liveAgentPositions, ...liveMainPositions]
    .filter(p=>getChartAsset(p) === (chartSymbol ?? getChartAsset(preferredPosition)))
    .map(p=>[p.accountRef ?? p.id,p])).values()];
  const position = marketPositions[0] ?? null;
  const singlePosition = marketPositions.length === 1 ? position : null;
  const positionExecution = findPositionExecution(position, executions);
  const estimate = summarizeNetExitPnl(marketPositions);
  const positionPnl = estimate?.estimatedNetPnlUsd ?? null;
  const positionCollateral = marketPositions.length && marketPositions.every(p=>finiteOrNull(p.collateralValue)!==null)
    ? marketPositions.reduce((sum,p)=>sum+p.collateralValue!,0) : null;
  const pnlPercent = estimate?.estimatedNetRoePercent ?? null;
  const mainWalletBalanceUsd = calculatePerpsWalletEquity(mainAvailableUsdc, liveMainPositions);
  const agentWalletBalanceUsd = calculatePerpsWalletEquity(agentAvailableUsdc, liveAgentPositions);
  const chartCandles = buildChartCandles(chartPoints);
  const latestChartPrice = chartCandles.at(-1)?.close ?? null;

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
    if (marketPositions.length > 1) {
      openPerpLabel = `${market} · ${marketPositions.length} positions`;
      openPerpDetail = "Combined estimated net PnL across Main and Agent positions in this market.";
    }
  }

  const clockedIn = session?.sessionState === "clocked_in";

  return {
    title: "BremLogic",
    openPerpLabel,
    openPerpDetail,
    openPerpPnlUsd: positionPnl,
    openPerpPnlPercent: finiteOrNull(pnlPercent),
    openPerpMarket: position ? position.marketSymbol.replace(/\s+/g, "").toUpperCase() : null,
    openPerpSide: marketPositions.every(p=>p.side===position?.side) ? position?.side ?? null : null,
    openPerpStrategy: singlePosition ? positionExecution?.strategyClass ?? null : null,
    openPerpPositionValueUsd: marketPositions.length && marketPositions.every(p=>finiteOrNull(p.positionValue)!==null)
      ? marketPositions.reduce((sum,p)=>sum+p.positionValue!,0) : null,
    openPerpCollateralUsd: positionCollateral,
    openPerpEntryPrice: finiteOrNull(singlePosition?.entryPrice),
    openPerpEntryTimestamp: singlePosition ? executionTimestamp(positionExecution) : null,
    // The mark doubles as the current market price in the idle dashboard. It
    // does not imply that a position is open; openPerpMarket remains null.
    openPerpMarkPrice: finiteOrNull(position?.markPrice) ?? latestChartPrice,
    openPerpLeverage: finiteOrNull(singlePosition?.leverage),
    openPerpLiquidationPrice: finiteOrNull(singlePosition?.liquidationPrice),
    openPerpTakeProfitPrice: finiteOrNull(singlePosition?.takeProfit),
    openPerpStopLossPrice: finiteOrNull(singlePosition?.stopLoss),
    openPerpTakeProfitPnlUsd: calculateExpectedPnl(singlePosition, singlePosition?.takeProfit),
    openPerpStopLossPnlUsd: calculateExpectedPnl(singlePosition, singlePosition?.stopLoss),
    chartSymbol: chartSymbol ?? getChartAsset(position),
    chartCandles,
    walletBalanceUsd: finiteOrNull(agentWalletBalanceUsd),
    mainWalletBalanceUsd: finiteOrNull(mainWalletBalanceUsd),
    agentWalletBalanceUsd: finiteOrNull(agentWalletBalanceUsd),
    perpsAutoTradeStatus: clockedIn ? "Agent monitoring is active" : "Perps auto-trade is off",
    perpsSessionState: clockedIn ? "Clocked In" : "Clocked Out",
    perpsMode: session?.mode === "live" ? "Live mode" : "Paper mode",
    perpsExecutionModel: session?.executionModel ?? "approval-assisted",
    updatedAt: now.getTime() / 1_000,
    targetURL: "bremlogic://open?target=%2Fsignals-bot%3Ftab%3Dsignals",
  };
}

export async function loadWidgetServerSnapshot() {
  const ownerWallet = process.env.PERPS_AGENT_OWNER_WALLET?.trim();
  const agentWallet = getAgentWalletForOwner(ownerWallet);
  if (!ownerWallet || !agentWallet) {
    throw new Error("The server widget wallet association is not configured.");
  }

  const [agentPortfolioResult, mainPortfolioResult, mainBalanceResult, agentBalanceResult, sessionResult, executionsResult] = await Promise.allSettled([
    loadAccountedPerpsSnapshot(agentWallet),
    loadAccountedPerpsSnapshot(ownerWallet),
    getWalletUsdcBalance(ownerWallet),
    getWalletUsdcBalance(agentWallet),
    getPerpsSession(ownerWallet),
    listUserPerpsExecutions(ownerWallet),
  ]);

  if (agentPortfolioResult.status === "rejected" && mainPortfolioResult.status === "rejected") {
    throw new Error("The live Perps portfolio is temporarily unavailable.");
  }

  const agentPositions = agentPortfolioResult.status === "fulfilled" ? agentPortfolioResult.value.positions : [];
  const mainPositions = mainPortfolioResult.status === "fulfilled" ? mainPortfolioResult.value.positions : [];
  const chartPosition = getLivePositions(agentPositions)[0] ?? getLivePositions(mainPositions)[0] ?? null;
  // SOL is the strategy's primary monitored market, so continue feeding its
  // chart while the agent is idle. Position fields stay empty until a real
  // Jupiter position exists.
  const chartSymbol = getChartAsset(chartPosition) ?? "SOL";
  const chartPoints = await fetchCoinbaseMinuteCandles(`${chartSymbol}-USD`, 61).catch(() => []);

  return buildWidgetServerSnapshot({
    agentPositions,
    mainPositions,
    mainAvailableUsdc: mainBalanceResult.status === "fulfilled" ? mainBalanceResult.value : null,
    agentAvailableUsdc: agentBalanceResult.status === "fulfilled" ? agentBalanceResult.value : null,
    session: sessionResult.status === "fulfilled" ? sessionResult.value : null,
    executions: executionsResult.status === "fulfilled" ? executionsResult.value : [],
    chartSymbol,
    chartPoints,
  });
}
