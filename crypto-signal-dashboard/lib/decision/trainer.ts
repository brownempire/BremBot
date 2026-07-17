import crypto from "node:crypto";

import { getActivePerpsAsset, type PerpsAutomationConfig } from "@/lib/perps/automationConfig";
import {
  getActiveDecisionLearningProfile,
  listDecisionLearningProfileHistory,
  listTradeLearningOutcomes,
  saveDecisionLearningProfile,
} from "@/lib/decision/learningStore";
import type {
  DecisionLearningProfile,
  LearningAsset,
  TradeLearningOutcome,
} from "@/lib/decision/learningTypes";

const MIN_TRAINING_SAMPLE = 50;
const MIN_VALIDATION_SAMPLE = 10;
const AUTO_RETRAIN_INTERVAL_MS = 24 * 60 * 60 * 1_000;

const BASE_THRESHOLDS: Record<LearningAsset, { trend: number; breakout: number }> = {
  BTC: { trend: 1, breakout: 0.8 },
  ETH: { trend: 1.2, breakout: 1 },
  SOL: { trend: 1.5, breakout: 1.2 },
};

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function mean(values: number[]) {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function quantile(values: number[], percentile: number) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * percentile)));
  return sorted[index] ?? 0;
}

function calculateStats(outcomes: TradeLearningOutcome[]) {
  const pnls = outcomes.map((outcome) => outcome.netPnlUsd);
  const wins = pnls.filter((pnl) => pnl > 0);
  const losses = pnls.filter((pnl) => pnl < 0);
  const grossWins = wins.reduce((sum, pnl) => sum + pnl, 0);
  const grossLosses = Math.abs(losses.reduce((sum, pnl) => sum + pnl, 0));
  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  pnls.forEach((pnl) => {
    equity += pnl;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
  });
  return {
    sampleSize: outcomes.length,
    winRate: outcomes.length > 0 ? wins.length / outcomes.length : 0,
    expectancyUsd: mean(pnls),
    profitFactor: grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? 99 : 0,
    maxDrawdownUsd: maxDrawdown,
  };
}

function plannedRoe(outcome: TradeLearningOutcome, trigger: number | null) {
  if (!trigger || !outcome.entryPrice) return null;
  return Math.abs(trigger - outcome.entryPrice) / outcome.entryPrice * 100 * outcome.leverage;
}

function makeBaselineProfile(walletAddress: string, version: number, source: DecisionLearningProfile["source"]): DecisionLearningProfile {
  const now = new Date().toISOString();
  return {
    profileId: `learn_${crypto.randomUUID()}`,
    walletAddress,
    version,
    status: "candidate",
    source,
    createdAt: now,
    promotedAt: null,
    learnedFromClosedTrades: 0,
    minimumConfidence: 0.62,
    leverageCap: 50,
    maximumAllocationPercent: 80,
    targetWalletRiskPercent: 1.6,
    preferredDirection: "balanced",
    trendWindow: 15,
    cooldownSeconds: 300,
    takeProfitRoePercent: 4,
    stopLossRoePercent: 2,
    minimumRewardRiskRatio: 2,
    atrLookback: 14,
    atrStopMultiplier: 1.5,
    volatilityCeilingPercent: 5,
    assetAdjustments: {
      SOL: { trendThreshold: 0.5, breakoutPercent: 0.3, leverageMultiplier: 1, allocationMultiplier: 1 },
      ETH: { trendThreshold: 0.5, breakoutPercent: 0.3, leverageMultiplier: 1, allocationMultiplier: 1 },
      BTC: { trendThreshold: 0.5, breakoutPercent: 0.3, leverageMultiplier: 1, allocationMultiplier: 1 },
    },
    validation: {
      sampleSize: 0,
      trainingSize: 0,
      validationSize: 0,
      winRate: 0,
      expectancyUsd: 0,
      profitFactor: 0,
      maxDrawdownUsd: 0,
      passed: true,
      reasons: ["Operator-selected baseline activated while BremLogic collects enough closed trades for walk-forward training."],
    },
    summary: "Operator baseline: 15-minute window, 0.5% trend, 0.3% breakout, 300-second cooldown, 80% allocation cap, 4% TP, 2% SL, and 50x leverage cap.",
  };
}

function derivePreferredDirection(outcomes: TradeLearningOutcome[]) {
  const long = outcomes.filter((outcome) => outcome.side === "long");
  const short = outcomes.filter((outcome) => outcome.side === "short");
  if (long.length < 10 || short.length < 10) return "balanced" as const;
  const longExpectancy = calculateStats(long).expectancyUsd;
  const shortExpectancy = calculateStats(short).expectancyUsd;
  if (longExpectancy > 0 && longExpectancy > shortExpectancy * 1.2) return "bullish" as const;
  if (shortExpectancy > 0 && shortExpectancy > longExpectancy * 1.2) return "bearish" as const;
  return "balanced" as const;
}

function deriveAssetAdjustment(asset: LearningAsset, outcomes: TradeLearningOutcome[], leverageCap: number) {
  const assetOutcomes = outcomes.filter((outcome) => outcome.asset === asset);
  const winners = assetOutcomes.filter((outcome) => outcome.netPnlUsd > 0);
  const base = BASE_THRESHOLDS[asset];
  const trendMagnitudes = winners.flatMap((outcome) => {
    const value = Math.abs(outcome.trendStrengthPercent ?? 0);
    return value > 0 ? [value] : [];
  });
  const breakoutMagnitudes = winners.flatMap((outcome) => {
    const value = Math.abs(outcome.breakoutStrengthPercent ?? 0);
    return value > 0 ? [value] : [];
  });
  const stats = calculateStats(assetOutcomes);
  return {
    trendThreshold: Number(clamp(quantile(trendMagnitudes, 0.25) || base.trend, base.trend * 0.8, base.trend * 1.6).toFixed(2)),
    breakoutPercent: Number(clamp(quantile(breakoutMagnitudes, 0.25) || base.breakout, base.breakout * 0.8, base.breakout * 1.6).toFixed(2)),
    leverageMultiplier: Number(clamp((quantile(winners.map((outcome) => outcome.leverage), 0.6) || leverageCap) / leverageCap, 0.65, 1).toFixed(3)),
    allocationMultiplier: Number(clamp(stats.profitFactor >= 1.25 ? 1 : stats.profitFactor >= 1 ? 0.9 : 0.75, 0.5, 1).toFixed(3)),
  };
}

function createLearnedCandidate(
  walletAddress: string,
  version: number,
  source: DecisionLearningProfile["source"],
  training: TradeLearningOutcome[],
  validation: TradeLearningOutcome[]
) {
  const winners = training.filter((outcome) => outcome.netPnlUsd > 0);
  const losers = training.filter((outcome) => outcome.netPnlUsd <= 0);
  const winnerConfidence = mean(winners.flatMap((outcome) => outcome.signalConfidence === null ? [] : [outcome.signalConfidence]));
  const loserConfidence = mean(losers.flatMap((outcome) => outcome.signalConfidence === null ? [] : [outcome.signalConfidence]));
  const minimumConfidence = winnerConfidence > 0 && loserConfidence > 0
    ? clamp((winnerConfidence + loserConfidence) / 2, 0.58, 0.75)
    : 0.62;
  const leverageCap = clamp(quantile(winners.map((outcome) => outcome.leverage), 0.75) || 3, 1, 3);
  const stopRoes = training.flatMap((outcome) => {
    const value = plannedRoe(outcome, outcome.stopLossPrice);
    return value ? [value] : [];
  });
  const takeProfitRoes = winners.flatMap((outcome) => {
    const value = plannedRoe(outcome, outcome.takeProfitPrice);
    return value ? [value] : [];
  });
  const stopLossRoePercent = clamp(quantile(stopRoes, 0.5) || 2.5, 1.5, 4);
  const takeProfitRoePercent = clamp(Math.max(quantile(takeProfitRoes, 0.5) || 6, stopLossRoePercent * 2), 4, 8);
  const volatilityCeilingPercent = clamp(
    quantile(winners.flatMap((outcome) => outcome.volatilityPercent === null ? [] : [outcome.volatilityPercent]), 0.85) || 5,
    2.5,
    7
  );
  const trendWindow = Math.round(clamp(quantile(winners.flatMap((outcome) => outcome.trendWindow === null ? [] : [outcome.trendWindow]), 0.5) || 30, 15, 60));
  const cooldownSeconds = Math.round(clamp(quantile(winners.flatMap((outcome) => outcome.cooldownSeconds === null ? [] : [outcome.cooldownSeconds]), 0.5) || 600, 300, 900));
  const preferredDirection = derivePreferredDirection(training);

  const admittedValidation = validation.filter((outcome) => (
    (outcome.signalConfidence === null || outcome.signalConfidence >= minimumConfidence)
    && (outcome.volatilityPercent === null || outcome.volatilityPercent <= volatilityCeilingPercent)
    && (preferredDirection === "balanced" || (preferredDirection === "bullish" ? outcome.side === "long" : outcome.side === "short"))
  ));
  const stats = calculateStats(admittedValidation);
  const baselineStats = calculateStats(validation);
  const reasons: string[] = [];
  if (admittedValidation.length < MIN_VALIDATION_SAMPLE) reasons.push(`Only ${admittedValidation.length} validation trades passed the candidate filters; ${MIN_VALIDATION_SAMPLE} are required.`);
  if (stats.expectancyUsd <= 0) reasons.push("Validation expectancy was not positive after fees.");
  if (stats.profitFactor < 1.05) reasons.push("Validation profit factor was below 1.05.");
  if (stats.expectancyUsd < baselineStats.expectancyUsd) reasons.push("Candidate expectancy did not improve on the unfiltered validation history.");
  const passed = reasons.length === 0;
  const now = new Date().toISOString();

  return {
    profileId: `learn_${crypto.randomUUID()}`,
    walletAddress,
    version,
    status: "candidate" as const,
    source,
    createdAt: now,
    promotedAt: null,
    learnedFromClosedTrades: training.length + validation.length,
    minimumConfidence: Number(minimumConfidence.toFixed(4)),
    leverageCap: Number(leverageCap.toFixed(2)),
    maximumAllocationPercent: 10,
    targetWalletRiskPercent: 0.35,
    preferredDirection,
    trendWindow,
    cooldownSeconds,
    takeProfitRoePercent: Number(takeProfitRoePercent.toFixed(2)),
    stopLossRoePercent: Number(stopLossRoePercent.toFixed(2)),
    minimumRewardRiskRatio: 2,
    atrLookback: 14,
    atrStopMultiplier: 1.5,
    volatilityCeilingPercent: Number(volatilityCeilingPercent.toFixed(2)),
    assetAdjustments: {
      SOL: deriveAssetAdjustment("SOL", training, leverageCap),
      ETH: deriveAssetAdjustment("ETH", training, leverageCap),
      BTC: deriveAssetAdjustment("BTC", training, leverageCap),
    },
    validation: {
      sampleSize: training.length + validation.length,
      trainingSize: training.length,
      validationSize: admittedValidation.length,
      winRate: Number(stats.winRate.toFixed(4)),
      expectancyUsd: Number(stats.expectancyUsd.toFixed(4)),
      profitFactor: Number(stats.profitFactor.toFixed(4)),
      maxDrawdownUsd: Number(stats.maxDrawdownUsd.toFixed(4)),
      passed,
      reasons: passed ? ["Candidate passed chronological holdout validation after fees."] : reasons,
    },
    summary: passed
      ? `Promoted from ${training.length} training trades and ${admittedValidation.length} qualifying holdout trades. Net expectancy ${stats.expectancyUsd.toFixed(2)} USD, win rate ${(stats.winRate * 100).toFixed(1)}%, profit factor ${stats.profitFactor.toFixed(2)}.`
      : `Candidate retained for review and not activated. ${reasons.join(" ")}`,
  } satisfies DecisionLearningProfile;
}

export async function trainWalletDecisionProfile(input: {
  walletAddress: string;
  config: PerpsAutomationConfig | null;
  source: "automatic" | "manual-training";
  force?: boolean;
}) {
  const [active, history, outcomes] = await Promise.all([
    getActiveDecisionLearningProfile(input.walletAddress),
    listDecisionLearningProfileHistory(input.walletAddress),
    listTradeLearningOutcomes(input.walletAddress),
  ]);
  const latestAttempt = history[0] ?? active;
  if (!input.force && latestAttempt && Date.now() - Date.parse(latestAttempt.createdAt) < AUTO_RETRAIN_INTERVAL_MS) {
    return { profile: active ?? latestAttempt, activated: false, outcomeCount: outcomes.length, skipped: true };
  }
  const version = Math.max(0, ...history.map((profile) => profile.version)) + 1;
  if (outcomes.length < MIN_TRAINING_SAMPLE) {
    if (active) {
      return { profile: active, activated: false, outcomeCount: outcomes.length, skipped: true };
    }
    const baseline = makeBaselineProfile(input.walletAddress, version, "operator-baseline");
    const profile = await saveDecisionLearningProfile(baseline, true);
    return { profile, activated: true, outcomeCount: outcomes.length, skipped: false };
  }

  const splitIndex = Math.max(MIN_TRAINING_SAMPLE - MIN_VALIDATION_SAMPLE, Math.floor(outcomes.length * 0.8));
  const training = outcomes.slice(0, splitIndex);
  const validation = outcomes.slice(splitIndex);
  const candidate = createLearnedCandidate(input.walletAddress, version, input.source, training, validation);
  const profile = await saveDecisionLearningProfile(candidate, candidate.validation.passed);
  return {
    profile,
    activated: candidate.validation.passed,
    outcomeCount: outcomes.length,
    skipped: false,
    activeAsset: input.config ? getActivePerpsAsset(input.config) : null,
  };
}
