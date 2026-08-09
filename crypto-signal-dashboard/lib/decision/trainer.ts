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
import { CURRENT_OUTCOME_RECONCILIATION_VERSION } from "@/lib/decision/learningTypes";
import { makeOperatorTrainingBaselineProfile } from "@/lib/decision/operatorTrainingBaseline";
import { OPERATOR_TRAINING_BASELINE } from "@/lib/decision/operatorTrainingBaselineConstants";
import { BASE_INDICATOR_SETTINGS } from "@/lib/signal/indicators";
import {
  createOperatorActivatedProfitableScalpBaseline,
  updateScalpLearningProfile,
} from "@/lib/decision/scalpTrainer";
import { DEFAULT_SCALP_LEARNING_PROFILE, SCALP_POLICY_VERSION } from "@/lib/perps/scalpEngine";

const MIN_TRAINING_SAMPLE = 50;
const MIN_VALIDATION_SAMPLE = 10;
const AUTO_RETRAIN_INTERVAL_MS = 24 * 60 * 60 * 1_000;

const BASE_THRESHOLDS: Record<LearningAsset, { trend: number; breakout: number }> = {
  BTC: { trend: OPERATOR_TRAINING_BASELINE.signalParams.trendThreshold, breakout: OPERATOR_TRAINING_BASELINE.signalParams.breakoutPercent },
  ETH: { trend: OPERATOR_TRAINING_BASELINE.signalParams.trendThreshold, breakout: OPERATOR_TRAINING_BASELINE.signalParams.breakoutPercent },
  SOL: { trend: OPERATOR_TRAINING_BASELINE.signalParams.trendThreshold, breakout: OPERATOR_TRAINING_BASELINE.signalParams.breakoutPercent },
};

export async function resetWalletScalpToProfitableProfile(input: {
  walletAddress: string;
  source: "manual-training";
}) {
  const [active, history, storedOutcomes] = await Promise.all([
    getActiveDecisionLearningProfile(input.walletAddress),
    listDecisionLearningProfileHistory(input.walletAddress),
    listTradeLearningOutcomes(input.walletAddress),
  ]);
  if (!active) throw new Error("No active learning profile is available to preserve Smart Trade settings.");
  const outcomes = storedOutcomes.filter((outcome) => (
    outcome.trainingEligible !== false
    && outcome.reconciliationVersion === CURRENT_OUTCOME_RECONCILIATION_VERSION
  ));
  const version = Math.max(active.version, ...history.map((profile) => profile.version)) + 1;
  const scalpProfile = createOperatorActivatedProfitableScalpBaseline(outcomes);
  const next = {
    ...active,
    profileId: `learn_${crypto.randomUUID()}`,
    version,
    status: "candidate" as const,
    source: input.source,
    createdAt: new Date().toISOString(),
    promotedAt: null,
    scalpProfile,
    summary: `${active.summary} Scalp profile was operator-reset from compatible post-fee winners and reactivated at conservative risk; Smart settings were preserved.`,
  } satisfies DecisionLearningProfile;
  const profile = await saveDecisionLearningProfile(next, true);
  return {
    profile,
    activated: true,
    outcomeCount: outcomes.length,
    profitableBaselineCount: scalpProfile.validation.trainingSize,
  };
}

export async function resetWalletScalpToLastOperatorBaseline(input: {
  walletAddress: string;
  source: "manual-training";
}) {
  const [active, history] = await Promise.all([
    getActiveDecisionLearningProfile(input.walletAddress),
    listDecisionLearningProfileHistory(input.walletAddress),
  ]);
  if (!active) throw new Error("No active learning profile is available to preserve Smart Trade settings.");
  const baseline = history
    .filter((profile) => {
      const scalp = profile.scalpProfile;
      return Boolean(
        scalp?.operatorActivation
        && scalp.learnedFromClosedTrades === scalp.operatorActivation.baselineOutcomeCount
      );
    })
    .sort((left, right) => right.version - left.version)[0] ?? null;
  if (!baseline?.scalpProfile) {
    throw new Error("No previous operator-activated profitable scalp baseline is available.");
  }
  const version = Math.max(active.version, ...history.map((profile) => profile.version)) + 1;
  const scalpProfile = structuredClone(baseline.scalpProfile);
  scalpProfile.consecutiveLosses = 0;
  const next = {
    ...active,
    profileId: `learn_${crypto.randomUUID()}`,
    version,
    status: "candidate" as const,
    source: input.source,
    createdAt: new Date().toISOString(),
    promotedAt: null,
    scalpProfile,
    summary: `${active.summary} Scalp learning was restored to operator baseline ${baseline.profileId}; Smart settings were preserved.`,
  } satisfies DecisionLearningProfile;
  const profile = await saveDecisionLearningProfile(next, true);
  return {
    profile,
    activated: true,
    restoredFromProfileId: baseline.profileId,
    baselineOutcomeCount: scalpProfile.operatorActivation?.baselineOutcomeCount
      ?? scalpProfile.policyOutcomeOffset,
  };
}

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
    trendThreshold: Number(clamp(quantile(trendMagnitudes, 0.25) || base.trend, 1.4, 2).toFixed(2)),
    breakoutPercent: Number(clamp(quantile(breakoutMagnitudes, 0.25) || base.breakout, 0.3, 0.5).toFixed(2)),
    leverageMultiplier: Number(clamp((quantile(winners.map((outcome) => outcome.leverage), 0.6) || leverageCap) / leverageCap, 0.75, 1).toFixed(3)),
    allocationMultiplier: Number(clamp(stats.profitFactor >= 1.25 ? 1 : stats.profitFactor >= 1 ? 0.9 : 0.8, 0.75, 1).toFixed(3)),
  };
}

function deriveIndicatorSettings(outcomes: TradeLearningOutcome[]) {
  const winners = outcomes.filter((outcome) => outcome.netPnlUsd > 0);
  const longRsi = winners.filter((outcome) => outcome.side === "long").flatMap((outcome) => outcome.rsi == null ? [] : [outcome.rsi]);
  const shortRsi = winners.filter((outcome) => outcome.side === "short").flatMap((outcome) => outcome.rsi == null ? [] : [outcome.rsi]);
  const adx = winners.flatMap((outcome) => outcome.adx == null ? [] : [outcome.adx]);
  const volume = winners.flatMap((outcome) => outcome.volumeRatio == null ? [] : [outcome.volumeRatio]);
  const scores = winners.flatMap((outcome) => outcome.indicatorScore == null ? [] : [outcome.indicatorScore]);
  return {
    longRsiMin: Number(clamp(quantile(longRsi, 0.15) || BASE_INDICATOR_SETTINGS.longRsiMin, 45, 55).toFixed(1)),
    longRsiMax: Number(clamp(quantile(longRsi, 0.85) || BASE_INDICATOR_SETTINGS.longRsiMax, 65, 74).toFixed(1)),
    shortRsiMin: Number(clamp(quantile(shortRsi, 0.15) || BASE_INDICATOR_SETTINGS.shortRsiMin, 26, 35).toFixed(1)),
    shortRsiMax: Number(clamp(quantile(shortRsi, 0.85) || BASE_INDICATOR_SETTINGS.shortRsiMax, 45, 55).toFixed(1)),
    minimumAdx: Number(clamp(quantile(adx, 0.2) || BASE_INDICATOR_SETTINGS.minimumAdx, 18, 25).toFixed(1)),
    minimumVolumeRatio: Number(clamp(quantile(volume, 0.2) || BASE_INDICATOR_SETTINGS.minimumVolumeRatio, 0.9, 1.25).toFixed(2)),
    minimumScore: Number(clamp(quantile(scores, 0.2) || BASE_INDICATOR_SETTINGS.minimumScore, 2.5, 4).toFixed(1)),
  };
}

function passesIndicatorSettings(outcome: TradeLearningOutcome, settings: ReturnType<typeof deriveIndicatorSettings>) {
  const hasIndicatorHistory = outcome.indicatorScore != null || outcome.rsi != null || outcome.adx != null || outcome.volumeRatio != null;
  if (!hasIndicatorHistory) return true;
  if (outcome.indicatorScore != null && outcome.indicatorScore < settings.minimumScore) return false;
  if (outcome.adx != null && outcome.adx < settings.minimumAdx) return false;
  if (outcome.volumeRatio != null && outcome.volumeRatio < settings.minimumVolumeRatio) return false;
  if (outcome.rsi != null) {
    return outcome.side === "long"
      ? outcome.rsi >= settings.longRsiMin && outcome.rsi <= settings.longRsiMax
      : outcome.rsi >= settings.shortRsiMin && outcome.rsi <= settings.shortRsiMax;
  }
  return true;
}

function createLearnedCandidate(
  walletAddress: string,
  version: number,
  source: DecisionLearningProfile["source"],
  training: TradeLearningOutcome[],
  validation: TradeLearningOutcome[]
) {
  const allOutcomes = [...training, ...validation];
  const smartTraining = training.filter((outcome) => outcome.signalType !== "scalp");
  const smartValidation = validation.filter((outcome) => outcome.signalType !== "scalp");
  const scalpOutcomes = allOutcomes.filter((outcome) => outcome.signalType === "scalp");
  const winners = smartTraining.filter((outcome) => outcome.netPnlUsd > 0);
  const losers = smartTraining.filter((outcome) => outcome.netPnlUsd <= 0);
  const winnerConfidence = mean(winners.flatMap((outcome) => outcome.signalConfidence === null ? [] : [outcome.signalConfidence]));
  const loserConfidence = mean(losers.flatMap((outcome) => outcome.signalConfidence === null ? [] : [outcome.signalConfidence]));
  const minimumConfidence = winnerConfidence > 0 && loserConfidence > 0
    ? clamp((winnerConfidence + loserConfidence) / 2, 0.62, 0.75)
    : OPERATOR_TRAINING_BASELINE.minimumConfidence;
  const leverageCap = OPERATOR_TRAINING_BASELINE.leverageCap;
  const takeProfitRoes = winners.flatMap((outcome) => {
    const value = plannedRoe(outcome, outcome.takeProfitPrice);
    return value ? [value] : [];
  });
  const stopLossRoePercent = OPERATOR_TRAINING_BASELINE.stopLossRoePercent;
  const takeProfitRoePercent = clamp(quantile(takeProfitRoes, 0.5) || OPERATOR_TRAINING_BASELINE.takeProfitRoePercent, 20, 30);
  const volatilityCeilingPercent = clamp(
    quantile(winners.flatMap((outcome) => outcome.volatilityPercent === null ? [] : [outcome.volatilityPercent]), 0.85) || 5,
    2.5,
    7
  );
  const trendWindow = Math.round(clamp(
    quantile(winners.flatMap((outcome) => outcome.trendWindow === null ? [] : [outcome.trendWindow]), 0.5)
      || OPERATOR_TRAINING_BASELINE.signalParams.trendWindow,
    120,
    180
  ));
  const cooldownSeconds = Math.round(clamp(
    quantile(winners.flatMap((outcome) => outcome.cooldownSeconds === null ? [] : [outcome.cooldownSeconds]), 0.5)
      || OPERATOR_TRAINING_BASELINE.signalParams.cooldownSeconds,
    OPERATOR_TRAINING_BASELINE.signalParams.cooldownSeconds,
    43_200
  ));
  const preferredDirection = derivePreferredDirection(smartTraining);
  const indicatorSettings = deriveIndicatorSettings(smartTraining);

  const admittedValidation = smartValidation.filter((outcome) => (
    (outcome.signalConfidence === null || outcome.signalConfidence >= minimumConfidence)
    && (outcome.volatilityPercent === null || outcome.volatilityPercent <= volatilityCeilingPercent)
    && (preferredDirection === "balanced" || (preferredDirection === "bullish" ? outcome.side === "long" : outcome.side === "short"))
    && passesIndicatorSettings(outcome, indicatorSettings)
  ));
  const stats = calculateStats(admittedValidation);
  const baselineStats = calculateStats(smartValidation);
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
    learnedFromClosedTrades: allOutcomes.length,
    outcomeDataVersion: CURRENT_OUTCOME_RECONCILIATION_VERSION,
    strategyBaselineVersion: OPERATOR_TRAINING_BASELINE.version,
    minimumConfidence: Number(minimumConfidence.toFixed(4)),
    leverageFloor: OPERATOR_TRAINING_BASELINE.leverageFloor,
    leverageCap: Number(leverageCap.toFixed(2)),
    leverageQualityExponent: OPERATOR_TRAINING_BASELINE.leverageQualityExponent,
    leverageVolatilityPenalty: OPERATOR_TRAINING_BASELINE.leverageVolatilityPenalty,
    leverageLossStepdown: OPERATOR_TRAINING_BASELINE.leverageLossStepdown,
    consecutiveLosses: 0,
    maximumAllocationPercent: OPERATOR_TRAINING_BASELINE.maximumAllocationPercent,
    targetWalletRiskPercent: OPERATOR_TRAINING_BASELINE.targetWalletRiskPercent,
    preferredDirection,
    trendWindow,
    cooldownSeconds,
    takeProfitRoePercent: Number(takeProfitRoePercent.toFixed(2)),
    stopLossRoePercent: Number(stopLossRoePercent.toFixed(2)),
    minimumRewardRiskRatio: 1,
    atrLookback: 14,
    atrStopMultiplier: 1.5,
    volatilityCeilingPercent: Number(volatilityCeilingPercent.toFixed(2)),
    indicatorSettings,
    scalpProfile: updateScalpLearningProfile(DEFAULT_SCALP_LEARNING_PROFILE, scalpOutcomes),
    assetAdjustments: {
      SOL: deriveAssetAdjustment("SOL", smartTraining, leverageCap),
      ETH: deriveAssetAdjustment("ETH", smartTraining, leverageCap),
      BTC: deriveAssetAdjustment("BTC", smartTraining, leverageCap),
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

function createIncrementalProfile(
  active: DecisionLearningProfile,
  version: number,
  source: "automatic" | "manual-training",
  outcomes: TradeLearningOutcome[]
) {
  const newOutcomes = outcomes.slice(active.learnedFromClosedTrades);
  const newSmartOutcomes = newOutcomes.filter((outcome) => outcome.signalType !== "scalp");
  const allSmartOutcomes = outcomes.filter((outcome) => outcome.signalType !== "scalp");
  const allScalpOutcomes = outcomes.filter((outcome) => outcome.signalType === "scalp");
  let minimumConfidence = active.minimumConfidence;
  let volatilityCeilingPercent = active.volatilityCeilingPercent;
  let consecutiveLosses = active.consecutiveLosses ?? 0;
  const assetAdjustments = structuredClone(active.assetAdjustments);

  for (const outcome of newSmartOutcomes) {
    const adjustment = assetAdjustments[outcome.asset];
    if (outcome.netPnlUsd > 0) {
      consecutiveLosses = 0;
      minimumConfidence = clamp(minimumConfidence - 0.0005, 0.62, 0.75);
      adjustment.leverageMultiplier = clamp(adjustment.leverageMultiplier + 0.005, 0.75, 1);
      adjustment.allocationMultiplier = clamp(adjustment.allocationMultiplier + 0.005, 0.75, 1);
      if (outcome.trendStrengthPercent != null) {
        const observed = Math.abs(outcome.trendStrengthPercent);
        adjustment.trendThreshold = clamp(adjustment.trendThreshold + clamp(observed - adjustment.trendThreshold, -0.02, 0.02) * 0.1, 1.4, 2);
      }
      if (outcome.breakoutStrengthPercent != null) {
        const observed = Math.abs(outcome.breakoutStrengthPercent);
        adjustment.breakoutPercent = clamp(adjustment.breakoutPercent + clamp(observed - adjustment.breakoutPercent, -0.02, 0.02) * 0.1, 0.3, 0.5);
      }
    } else {
      consecutiveLosses = Math.min(3, consecutiveLosses + 1);
      minimumConfidence = clamp(minimumConfidence + 0.004, 0.62, 0.75);
      adjustment.trendThreshold = clamp(adjustment.trendThreshold * 1.005, 1.4, 2);
      adjustment.breakoutPercent = clamp(adjustment.breakoutPercent * 1.005, 0.3, 0.5);
      adjustment.leverageMultiplier = clamp(adjustment.leverageMultiplier - 0.015, 0.75, 1);
      adjustment.allocationMultiplier = clamp(adjustment.allocationMultiplier - 0.02, 0.75, 1);
      if (outcome.volatilityPercent != null && outcome.volatilityPercent <= volatilityCeilingPercent) {
        volatilityCeilingPercent = clamp(volatilityCeilingPercent - 0.02, 1.5, 10);
      }
    }
  }

  for (const adjustment of Object.values(assetAdjustments)) {
    adjustment.trendThreshold = Number(adjustment.trendThreshold.toFixed(3));
    adjustment.breakoutPercent = Number(adjustment.breakoutPercent.toFixed(3));
    adjustment.leverageMultiplier = Number(adjustment.leverageMultiplier.toFixed(3));
    adjustment.allocationMultiplier = Number(adjustment.allocationMultiplier.toFixed(3));
  }

  const stats = calculateStats(allSmartOutcomes);
  const scalpProfile = updateScalpLearningProfile(active.scalpProfile, allScalpOutcomes);
  const now = new Date().toISOString();
  return {
    ...active,
    profileId: `learn_${crypto.randomUUID()}`,
    version,
    status: "candidate" as const,
    source,
    createdAt: now,
    promotedAt: null,
    learnedFromClosedTrades: outcomes.length,
    outcomeDataVersion: CURRENT_OUTCOME_RECONCILIATION_VERSION,
    strategyBaselineVersion: OPERATOR_TRAINING_BASELINE.version,
    minimumConfidence: Number(minimumConfidence.toFixed(4)),
    leverageFloor: OPERATOR_TRAINING_BASELINE.leverageFloor,
    leverageCap: OPERATOR_TRAINING_BASELINE.leverageCap,
    leverageQualityExponent: OPERATOR_TRAINING_BASELINE.leverageQualityExponent,
    leverageVolatilityPenalty: OPERATOR_TRAINING_BASELINE.leverageVolatilityPenalty,
    leverageLossStepdown: OPERATOR_TRAINING_BASELINE.leverageLossStepdown,
    consecutiveLosses,
    maximumAllocationPercent: OPERATOR_TRAINING_BASELINE.maximumAllocationPercent,
    targetWalletRiskPercent: OPERATOR_TRAINING_BASELINE.targetWalletRiskPercent,
    preferredDirection: derivePreferredDirection(allSmartOutcomes),
    volatilityCeilingPercent: Number(volatilityCeilingPercent.toFixed(2)),
    scalpProfile,
    assetAdjustments,
    validation: {
      sampleSize: outcomes.length,
      trainingSize: outcomes.length,
      validationSize: 0,
      winRate: Number(stats.winRate.toFixed(4)),
      expectancyUsd: Number(stats.expectancyUsd.toFixed(4)),
      profitFactor: Number(stats.profitFactor.toFixed(4)),
      maxDrawdownUsd: Number(stats.maxDrawdownUsd.toFixed(4)),
      passed: true,
      reasons: [`Applied bounded Smart-only learning from ${newSmartOutcomes.length} new Smart trade${newSmartOutcomes.length === 1 ? "" : "s"} and isolated scalp learning from ${newOutcomes.length - newSmartOutcomes.length} scalp trade${newOutcomes.length - newSmartOutcomes.length === 1 ? "" : "s"}; full holdout validation remains scheduled separately.`],
    },
    summary: `Online profile update after ${outcomes.length} closed trades. Smart trend/breakout learning and scalp range/reversal learning were updated independently within bounded safety limits.`,
  } satisfies DecisionLearningProfile;
}

export async function trainWalletDecisionProfile(input: {
  walletAddress: string;
  config: PerpsAutomationConfig | null;
  source: "automatic" | "manual-training";
  force?: boolean;
}) {
  const [active, history, storedOutcomes] = await Promise.all([
    getActiveDecisionLearningProfile(input.walletAddress),
    listDecisionLearningProfileHistory(input.walletAddress),
    listTradeLearningOutcomes(input.walletAddress),
  ]);
  const requiresOutcomeMigration = Boolean(
    active && (active.outcomeDataVersion ?? 1) < CURRENT_OUTCOME_RECONCILIATION_VERSION
  );
  const outcomes = storedOutcomes.filter((outcome) => (
    outcome.trainingEligible !== false
    && outcome.reconciliationVersion === CURRENT_OUTCOME_RECONCILIATION_VERSION
  ));
  const excludedOutcomeCount = storedOutcomes.length - outcomes.length;
  const version = Math.max(0, ...history.map((profile) => profile.version)) + 1;
  if (
    active
    && (
      (active.strategyBaselineVersion ?? 1) < OPERATOR_TRAINING_BASELINE.version
      || requiresOutcomeMigration
    )
  ) {
    const migratedBaseline = await saveDecisionLearningProfile(
      makeOperatorTrainingBaselineProfile(input.walletAddress, version),
      true
    );
    if (outcomes.length === 0) {
      return { profile: migratedBaseline, activated: true, outcomeCount: 0, excludedOutcomeCount, skipped: false, migrated: true };
    }
    if (outcomes.length >= MIN_TRAINING_SAMPLE) {
      const smartOutcomeCount = outcomes.filter((outcome) => outcome.signalType !== "scalp").length;
      if (smartOutcomeCount < MIN_TRAINING_SAMPLE) {
        const incremental = createIncrementalProfile(migratedBaseline, version + 1, input.source, outcomes);
        const profile = await saveDecisionLearningProfile(incremental, true);
        return {
          profile,
          activated: true,
          outcomeCount: outcomes.length,
          excludedOutcomeCount,
          skipped: false,
          incremental: true,
          migrated: true,
          activeAsset: input.config ? getActivePerpsAsset(input.config) : null,
        };
      }
      const splitIndex = Math.max(MIN_TRAINING_SAMPLE - MIN_VALIDATION_SAMPLE, Math.floor(outcomes.length * 0.8));
      const candidate = createLearnedCandidate(
        input.walletAddress,
        version + 1,
        input.source,
        outcomes.slice(0, splitIndex),
        outcomes.slice(splitIndex)
      );
      const profile = await saveDecisionLearningProfile(candidate, candidate.validation.passed);
      return {
        profile,
        activated: candidate.validation.passed,
        outcomeCount: outcomes.length,
        excludedOutcomeCount,
        skipped: false,
        migrated: true,
        activeAsset: input.config ? getActivePerpsAsset(input.config) : null,
      };
    }
    const incremental = createIncrementalProfile(migratedBaseline, version + 1, input.source, outcomes);
    const profile = await saveDecisionLearningProfile(incremental, true);
    return {
      profile,
      activated: true,
      outcomeCount: outcomes.length,
      excludedOutcomeCount,
      skipped: false,
      incremental: true,
      migrated: true,
      activeAsset: input.config ? getActivePerpsAsset(input.config) : null,
    };
  }
  if (
    active
    && (active.scalpProfile?.policyVersion ?? 1) < SCALP_POLICY_VERSION
  ) {
    const refreshedProfile = {
      ...active,
      profileId: `learn_${crypto.randomUUID()}`,
      version,
      status: "candidate" as const,
      source: input.source,
      createdAt: new Date().toISOString(),
      promotedAt: null,
      scalpProfile: updateScalpLearningProfile(active.scalpProfile, outcomes),
      summary: `${active.summary} Scalp profile migrated to the operator-selected median baseline; prior outcomes remain auditable and Smart profile settings were preserved.`,
    } satisfies DecisionLearningProfile;
    const profile = await saveDecisionLearningProfile(refreshedProfile, true);
    return {
      profile,
      activated: true,
      outcomeCount: outcomes.length,
      excludedOutcomeCount,
      skipped: false,
      scalpPolicyMigrated: true,
      activeAsset: input.config ? getActivePerpsAsset(input.config) : null,
    };
  }
  if (!input.force && active && outcomes.length > active.learnedFromClosedTrades) {
    const incremental = createIncrementalProfile(active, version, input.source, outcomes);
    const profile = await saveDecisionLearningProfile(incremental, true);
    return {
      profile,
      activated: true,
      outcomeCount: outcomes.length,
      excludedOutcomeCount,
      skipped: false,
      incremental: true,
      activeAsset: input.config ? getActivePerpsAsset(input.config) : null,
    };
  }
  const latestAttempt = history[0] ?? active;
  if (!input.force && latestAttempt && Date.now() - Date.parse(latestAttempt.createdAt) < AUTO_RETRAIN_INTERVAL_MS) {
    return { profile: active ?? latestAttempt, activated: false, outcomeCount: outcomes.length, excludedOutcomeCount, skipped: true };
  }
  if (outcomes.length < MIN_TRAINING_SAMPLE) {
    if (active && !input.force) {
      return { profile: active, activated: false, outcomeCount: outcomes.length, excludedOutcomeCount, skipped: true };
    }
    const baseline = makeOperatorTrainingBaselineProfile(input.walletAddress, version);
    const savedBaseline = await saveDecisionLearningProfile(baseline, true);
    if (outcomes.length > 0) {
      const incremental = createIncrementalProfile(savedBaseline, version + 1, input.source, outcomes);
      const profile = await saveDecisionLearningProfile(incremental, true);
      return {
        profile,
        activated: true,
        outcomeCount: outcomes.length,
        excludedOutcomeCount,
        skipped: false,
        incremental: true,
        activeAsset: input.config ? getActivePerpsAsset(input.config) : null,
      };
    }
    const profile = savedBaseline;
    return { profile, activated: true, outcomeCount: outcomes.length, excludedOutcomeCount, skipped: false };
  }

  const smartOutcomeCount = outcomes.filter((outcome) => outcome.signalType !== "scalp").length;
  if (smartOutcomeCount < MIN_TRAINING_SAMPLE) {
    const baseline = active ?? await saveDecisionLearningProfile(
      makeOperatorTrainingBaselineProfile(input.walletAddress, version),
      true
    );
    const incremental = createIncrementalProfile(
      baseline,
      active ? version : version + 1,
      input.source,
      outcomes
    );
    const profile = await saveDecisionLearningProfile(incremental, true);
    return {
      profile,
      activated: true,
      outcomeCount: outcomes.length,
      excludedOutcomeCount,
      skipped: false,
      incremental: true,
      activeAsset: input.config ? getActivePerpsAsset(input.config) : null,
    };
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
    excludedOutcomeCount,
    skipped: false,
    activeAsset: input.config ? getActivePerpsAsset(input.config) : null,
  };
}
