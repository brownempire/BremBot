import type { TradeDecisionRecord } from "@/lib/decision/types";
import {
  replaceTradeLearningOutcomesForWallet,
  saveTradeLearningOutcomes,
} from "@/lib/decision/learningStore";
import {
  CURRENT_OUTCOME_RECONCILIATION_VERSION,
  type TradeLearningOutcome,
} from "@/lib/decision/learningTypes";
import type { JupiterPerpsAccountSnapshot, JupiterPerpsTrade } from "@/lib/jupiterPerps";
import type { PerpsUserExecution } from "@/lib/perps/sessionTypes";

const ENTRY_MATCH_TOLERANCE_MS = 60_000;
const LEGACY_OUTLIER_OPENED_AT_MS = Date.parse("2026-07-20T23:04:22Z");
const LEGACY_OUTLIER_WINDOW_MS = 1_000;
const LEGACY_OUTLIER_MINIMUM_LOSS_USD = 75;

function tradeTimestamp(trade: JupiterPerpsTrade) {
  return trade.createdAt ?? trade.lastUpdated ?? 0;
}

function executionTimestamp(execution: PerpsUserExecution) {
  const timestamp = Date.parse(execution.createdAt);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function isExitTrade(trade: JupiterPerpsTrade) {
  const label = `${trade.action} ${trade.orderType}`.toLowerCase();
  return /close|decrease|liquidat|take.?profit|stop.?loss/.test(label);
}

function isEntryTrade(trade: JupiterPerpsTrade) {
  return !isExitTrade(trade);
}

function inferExitReason(execution: PerpsUserExecution, trade: JupiterPerpsTrade): TradeLearningOutcome["exitReason"] {
  const label = `${trade.action} ${trade.orderType}`.toLowerCase();
  if (/liquidat/.test(label)) return "liquidation";
  if (/take.?profit|\btp\b/.test(label)) return "take-profit";
  if (/stop.?loss|\bsl\b/.test(label)) return "stop-loss";
  if (trade.price && execution.takeProfitPrice) {
    const tolerance = execution.takeProfitPrice * 0.003;
    if (Math.abs(trade.price - execution.takeProfitPrice) <= tolerance) return "take-profit";
  }
  if (trade.price && execution.stopLossPrice) {
    const tolerance = execution.stopLossPrice * 0.003;
    if (Math.abs(trade.price - execution.stopLossPrice) <= tolerance) return "stop-loss";
  }
  return /close|decrease/.test(label) ? "manual" : "unknown";
}

function findDecision(execution: PerpsUserExecution, decisions: TradeDecisionRecord[]) {
  if (execution.decisionId) {
    const direct = decisions.find((record) => record.payload.decisionId === execution.decisionId);
    if (direct) return direct;
  }
  return decisions
    .filter((record) => record.payload.signalId === execution.signalId)
    .sort((a, b) => Math.abs(Date.parse(a.payload.createdAt) - executionTimestamp(execution)) - Math.abs(Date.parse(b.payload.createdAt) - executionTimestamp(execution)))[0]
    ?? null;
}

function resolveTrainingEligibility(input: {
  execution: PerpsUserExecution;
  signalType: TradeLearningOutcome["signalType"];
  netPnlUsd: number;
}) {
  const openedAtMs = executionTimestamp(input.execution);
  const isKnownLegacyOutlier = input.execution.asset === "SOL"
    && input.netPnlUsd <= -LEGACY_OUTLIER_MINIMUM_LOSS_USD
    && Math.abs(openedAtMs - LEGACY_OUTLIER_OPENED_AT_MS) <= LEGACY_OUTLIER_WINDOW_MS
    && (input.signalType === "scalp" || input.execution.strategyClass === "scalp");
  return isKnownLegacyOutlier
    ? {
        trainingEligible: false,
        trainingExclusionReason: "Legacy pre-upgrade scalp outlier retained for PnL, audit, and tail-risk reporting.",
      }
    : {
        trainingEligible: true,
        trainingExclusionReason: null,
      };
}

function sameMarket(execution: PerpsUserExecution, trade: JupiterPerpsTrade) {
  return trade.positionPubkey === execution.positionPubkey
    && trade.side === execution.side
    && trade.marketSymbol.toUpperCase() === execution.asset;
}

function findEntryTrade(
  execution: PerpsUserExecution,
  trades: JupiterPerpsTrade[],
  nextExecutionAtMs: number
) {
  const exactTransaction = execution.txid
    ? trades.find((trade) => trade.txHash === execution.txid && isEntryTrade(trade))
    : null;
  if (exactTransaction) return exactTransaction;

  const openedAtMs = executionTimestamp(execution);
  return trades.find((trade) => (
    isEntryTrade(trade)
    && tradeTimestamp(trade) >= openedAtMs - ENTRY_MATCH_TOLERANCE_MS
    && tradeTimestamp(trade) < nextExecutionAtMs
  )) ?? null;
}

export async function reconcileTradeLearningOutcomes(input: {
  walletAddress: string;
  executions: PerpsUserExecution[];
  decisions: TradeDecisionRecord[];
  snapshot: JupiterPerpsAccountSnapshot;
  replaceWalletHistory?: boolean;
}) {
  const executions = [...new Map(
    input.executions
      .filter((execution) => (
        execution.walletAddress === input.walletAddress
        && execution.mode === "live"
        && Boolean(execution.positionPubkey)
        && executionTimestamp(execution) > 0
      ))
      .map((execution) => [execution.executionId, execution])
  ).values()].sort((left, right) => executionTimestamp(left) - executionTimestamp(right));
  const tradesByPosition = new Map<string, JupiterPerpsTrade[]>();
  input.snapshot.recentTrades.forEach((trade) => {
    if (!trade.positionPubkey || tradeTimestamp(trade) <= 0) return;
    const existing = tradesByPosition.get(trade.positionPubkey) ?? [];
    existing.push(trade);
    tradesByPosition.set(trade.positionPubkey, existing);
  });
  tradesByPosition.forEach((trades) => trades.sort((left, right) => tradeTimestamp(left) - tradeTimestamp(right)));

  const outcomes: TradeLearningOutcome[] = [];
  for (let index = 0; index < executions.length; index += 1) {
    const execution = executions[index];
    if (!execution?.positionPubkey) continue;
    const samePositionTrades = (tradesByPosition.get(execution.positionPubkey) ?? [])
      .filter((trade) => sameMarket(execution, trade));
    const nextExecution = executions
      .slice(index + 1)
      .find((candidate) => candidate.positionPubkey === execution.positionPubkey);
    const nextExecutionAtMs = nextExecution
      ? executionTimestamp(nextExecution)
      : Number.POSITIVE_INFINITY;
    const entryTrade = findEntryTrade(execution, samePositionTrades, nextExecutionAtMs);
    if (!entryTrade) continue;

    const entryAtMs = tradeTimestamp(entryTrade);
    const episodeTrades = samePositionTrades.filter((trade) => (
      tradeTimestamp(trade) >= entryAtMs
      && tradeTimestamp(trade) < nextExecutionAtMs
    ));
    const exitTrades = episodeTrades.filter((trade) => isExitTrade(trade) && tradeTimestamp(trade) >= entryAtMs);
    const finalExit = exitTrades[exitTrades.length - 1];
    if (!finalExit) continue;

    const feesUsd = episodeTrades.reduce((sum, trade) => sum + Math.max(0, trade.feeUsd ?? 0), 0);
    // Jupiter's mapped trade PnL is net of that trade's fee. Add exit fees back
    // to reconstruct gross PnL, then subtract all episode fees exactly once.
    const grossPnlUsd = exitTrades.reduce((sum, trade) => sum + (trade.pnl ?? 0) + Math.max(0, trade.feeUsd ?? 0), 0);
    const netPnlUsd = grossPnlUsd - feesUsd;
    const openedAtMs = executionTimestamp(execution);
    const closedAtMs = tradeTimestamp(finalExit);
    const decision = findDecision(execution, input.decisions);
    const strategy = decision?.payload.strategyContext ?? null;
    const signalType = strategy?.signalType ?? null;
    const eligibility = resolveTrainingEligibility({ execution, signalType, netPnlUsd });
    const entryReference = entryTrade.txHash?.trim() || entryTrade.id;

    outcomes.push({
      outcomeId: `${input.walletAddress}:${execution.executionId}`,
      episodeId: `${input.walletAddress}:${execution.executionId}:${entryReference}`,
      reconciliationVersion: CURRENT_OUTCOME_RECONCILIATION_VERSION,
      ...eligibility,
      walletAddress: input.walletAddress,
      executionId: execution.executionId,
      decisionId: decision?.payload.decisionId ?? execution.decisionId ?? null,
      signalId: execution.signalId,
      asset: execution.asset,
      side: execution.side,
      openedAt: execution.createdAt,
      closedAt: new Date(closedAtMs).toISOString(),
      positionPubkey: execution.positionPubkey,
      entryPrice: entryTrade.price ?? decision?.payload.marketContext.spotPrice ?? null,
      exitPrice: finalExit.price,
      collateralUsd: execution.collateralUsd,
      sizeUsd: execution.sizeUsd,
      leverage: execution.leverage,
      takeProfitPrice: execution.takeProfitPrice,
      stopLossPrice: execution.stopLossPrice,
      grossPnlUsd: Number(grossPnlUsd.toFixed(6)),
      feesUsd: Number(feesUsd.toFixed(6)),
      netPnlUsd: Number(netPnlUsd.toFixed(6)),
      returnOnCollateralPercent: Number(((netPnlUsd / execution.collateralUsd) * 100).toFixed(6)),
      durationMinutes: Number((Math.max(0, closedAtMs - openedAtMs) / 60_000).toFixed(2)),
      exitReason: inferExitReason(execution, finalExit),
      signalConfidence: decision?.payload.signalConfidence ?? execution.decisionConfidence ?? null,
      signalType,
      trendWindow: strategy?.trendWindow ?? null,
      trendThreshold: strategy?.trendThreshold ?? null,
      breakoutPercent: strategy?.breakoutPercent ?? null,
      cooldownSeconds: strategy?.cooldownSeconds ?? null,
      trendStrengthPercent: strategy?.trendStrengthPercent ?? decision?.payload.marketContext.recentPriceChangePercent ?? null,
      breakoutStrengthPercent: strategy?.breakoutStrengthPercent ?? null,
      volatilityPercent: decision?.payload.marketContext.volatilityPercent ?? null,
      atrPercent: strategy?.atrPercent ?? null,
      indicatorScore: strategy?.indicatorScore ?? null,
      emaSpreadPercent: strategy?.indicators?.emaSpreadPercent ?? null,
      emaSlopePercent: strategy?.indicators?.emaSlopePercent ?? null,
      rsi: strategy?.indicators?.rsi ?? null,
      macdHistogram: strategy?.indicators?.macdHistogram ?? null,
      macdHistogramChange: strategy?.indicators?.macdHistogramChange ?? null,
      adx: strategy?.indicators?.adx ?? null,
      plusDi: strategy?.indicators?.plusDi ?? null,
      minusDi: strategy?.indicators?.minusDi ?? null,
      volumeRatio: strategy?.indicators?.volumeRatio ?? null,
      bollingerBandwidthPercent: strategy?.indicators?.bollingerBandwidthPercent ?? null,
      bollingerPosition: strategy?.indicators?.bollingerPosition ?? null,
      scalpSetupType: strategy?.scalpSetupType ?? null,
      priceActionScore: strategy?.priceActionScore ?? null,
      priceActionTags: strategy?.priceActionTags ?? [],
      detectedDirection: strategy?.detectedDirection,
      directionInverted: strategy?.directionInverted,
      directionExperimentId: strategy?.directionExperimentId,
      directionExperimentTradeNumber: strategy?.directionExperimentTradeNumber,
      trendBias: decision?.payload.marketContext.trendBias ?? null,
      createdAt: new Date().toISOString(),
    });
  }

  return input.replaceWalletHistory
    ? replaceTradeLearningOutcomesForWallet(input.walletAddress, outcomes)
    : saveTradeLearningOutcomes(outcomes);
}
