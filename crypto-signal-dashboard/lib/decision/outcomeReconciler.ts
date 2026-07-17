import type { TradeDecisionRecord } from "@/lib/decision/types";
import { saveTradeLearningOutcomes } from "@/lib/decision/learningStore";
import type { TradeLearningOutcome } from "@/lib/decision/learningTypes";
import type { JupiterPerpsAccountSnapshot, JupiterPerpsTrade } from "@/lib/jupiterPerps";
import type { PerpsUserExecution } from "@/lib/perps/sessionTypes";

function tradeTimestamp(trade: JupiterPerpsTrade) {
  return trade.createdAt ?? trade.lastUpdated ?? 0;
}

function isExitTrade(trade: JupiterPerpsTrade) {
  const label = `${trade.action} ${trade.orderType}`.toLowerCase();
  return /close|decrease|liquidat|take.?profit|stop.?loss/.test(label);
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
    .sort((a, b) => Math.abs(Date.parse(a.payload.createdAt) - Date.parse(execution.createdAt)) - Math.abs(Date.parse(b.payload.createdAt) - Date.parse(execution.createdAt)))[0]
    ?? null;
}

export async function reconcileTradeLearningOutcomes(input: {
  walletAddress: string;
  executions: PerpsUserExecution[];
  decisions: TradeDecisionRecord[];
  snapshot: JupiterPerpsAccountSnapshot;
}) {
  const openPositionIds = new Set(
    input.snapshot.positions.flatMap((position) => position.accountRef ? [position.accountRef] : [])
  );
  const outcomes: TradeLearningOutcome[] = [];

  for (const execution of input.executions) {
    if (execution.walletAddress !== input.walletAddress || execution.mode !== "live" || !execution.positionPubkey) continue;
    if (openPositionIds.has(execution.positionPubkey)) continue;
    const openedAtMs = Date.parse(execution.createdAt);
    const matchingTrades = input.snapshot.recentTrades
      .filter((trade) => trade.positionPubkey === execution.positionPubkey && tradeTimestamp(trade) >= openedAtMs - 60_000)
      .sort((a, b) => tradeTimestamp(a) - tradeTimestamp(b));
    const exitTrades = matchingTrades.filter(isExitTrade);
    const finalExit = exitTrades[exitTrades.length - 1];
    if (!finalExit) continue;

    const entryTrade = matchingTrades.find((trade) => !isExitTrade(trade)) ?? matchingTrades[0] ?? null;
    const feesUsd = matchingTrades.reduce((sum, trade) => sum + Math.max(0, trade.feeUsd ?? 0), 0);
    const grossPnlUsd = exitTrades.reduce((sum, trade) => sum + (trade.pnl ?? 0) + (trade.feeUsd ?? 0), 0);
    const netPnlUsd = grossPnlUsd - feesUsd;
    const closedAtMs = tradeTimestamp(finalExit) || Date.now();
    const decision = findDecision(execution, input.decisions);
    const strategy = decision?.payload.strategyContext ?? null;

    outcomes.push({
      outcomeId: `${input.walletAddress}:${execution.executionId}`,
      walletAddress: input.walletAddress,
      executionId: execution.executionId,
      decisionId: decision?.payload.decisionId ?? execution.decisionId ?? null,
      signalId: execution.signalId,
      asset: execution.asset,
      side: execution.side,
      openedAt: execution.createdAt,
      closedAt: new Date(closedAtMs).toISOString(),
      positionPubkey: execution.positionPubkey,
      entryPrice: entryTrade?.price ?? decision?.payload.marketContext.spotPrice ?? null,
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
      signalType: strategy?.signalType ?? null,
      trendWindow: strategy?.trendWindow ?? null,
      trendThreshold: strategy?.trendThreshold ?? null,
      breakoutPercent: strategy?.breakoutPercent ?? null,
      cooldownSeconds: strategy?.cooldownSeconds ?? null,
      trendStrengthPercent: strategy?.trendStrengthPercent ?? decision?.payload.marketContext.recentPriceChangePercent ?? null,
      breakoutStrengthPercent: strategy?.breakoutStrengthPercent ?? null,
      volatilityPercent: decision?.payload.marketContext.volatilityPercent ?? null,
      atrPercent: strategy?.atrPercent ?? null,
      trendBias: decision?.payload.marketContext.trendBias ?? null,
      createdAt: new Date().toISOString(),
    });
  }

  return saveTradeLearningOutcomes(outcomes);
}
