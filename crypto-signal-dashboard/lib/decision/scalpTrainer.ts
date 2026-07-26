import type { ScalpLearningProfile, TradeLearningOutcome } from "@/lib/decision/learningTypes";
import { DEFAULT_SCALP_LEARNING_PROFILE } from "@/lib/perps/scalpEngine";

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function expectancy(outcomes: TradeLearningOutcome[]) {
  return outcomes.length > 0
    ? outcomes.reduce((sum, outcome) => sum + outcome.netPnlUsd, 0) / outcomes.length
    : 0;
}

function directionPreference(outcomes: TradeLearningOutcome[]) {
  const longs = outcomes.filter((outcome) => outcome.side === "long");
  const shorts = outcomes.filter((outcome) => outcome.side === "short");
  if (longs.length < 8 || shorts.length < 8) return "balanced" as const;
  const longExpectancy = expectancy(longs);
  const shortExpectancy = expectancy(shorts);
  if (longExpectancy > 0 && longExpectancy > shortExpectancy * 1.25) return "bullish" as const;
  if (shortExpectancy > 0 && shortExpectancy > longExpectancy * 1.25) return "bearish" as const;
  return "balanced" as const;
}

function stats(outcomes: TradeLearningOutcome[]) {
  const wins = outcomes.filter((outcome) => outcome.netPnlUsd > 0);
  const losses = outcomes.filter((outcome) => outcome.netPnlUsd < 0);
  const grossWins = wins.reduce((sum, outcome) => sum + outcome.netPnlUsd, 0);
  const grossLosses = Math.abs(losses.reduce((sum, outcome) => sum + outcome.netPnlUsd, 0));
  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  outcomes.forEach((outcome) => {
    equity += outcome.netPnlUsd;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
  });
  return {
    winRate: outcomes.length > 0 ? wins.length / outcomes.length : 0,
    expectancyUsd: expectancy(outcomes),
    profitFactor: grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? 99 : 0,
    maxDrawdownUsd: maxDrawdown,
  };
}

export function updateScalpLearningProfile(
  current: ScalpLearningProfile | null | undefined,
  allScalpOutcomes: TradeLearningOutcome[]
): ScalpLearningProfile {
  const profile = structuredClone(current ?? DEFAULT_SCALP_LEARNING_PROFILE);
  const ordered = allScalpOutcomes
    .filter((outcome) => outcome.signalType === "scalp")
    .sort((left, right) => Date.parse(left.closedAt) - Date.parse(right.closedAt));
  const newOutcomes = ordered.slice(profile.learnedFromClosedTrades);
  const setupAdjustmentKey = (outcome: TradeLearningOutcome) => outcome.scalpSetupType === "range-reversal"
    ? "rangeReversal" as const
    : outcome.scalpSetupType === "liquidity-sweep"
      ? "liquiditySweep" as const
      : outcome.scalpSetupType === "v-reversal"
        ? "vReversal" as const
        : outcome.scalpSetupType === "double-reversal"
          ? "doubleReversal" as const
          : null;

  for (const outcome of newOutcomes) {
    const won = outcome.netPnlUsd > 0;
    const setupKey = setupAdjustmentKey(outcome);
    if (won) {
      profile.consecutiveLosses = 0;
      profile.minimumConfidence = clamp(profile.minimumConfidence - 0.002, 0.58, 0.78);
      profile.minimumPriceActionScore = clamp(profile.minimumPriceActionScore - 0.002, 0.52, 0.76);
      profile.riskMultiplier = clamp(profile.riskMultiplier + 0.01, 0.5, 1);
      profile.cooldownSeconds = Math.round(clamp(profile.cooldownSeconds - 15, 900, 3_600));
      if (setupKey) {
        profile.setupConfidenceAdjustments[setupKey] = clamp(
          profile.setupConfidenceAdjustments[setupKey] - 0.004,
          -0.08,
          0.15
        );
      }
      if (outcome.side === "long" && outcome.rsi != null) {
        profile.longRsiMaximum = clamp(profile.longRsiMaximum + clamp(outcome.rsi - profile.longRsiMaximum, -1, 1) * 0.05, 38, 58);
      }
      if (outcome.side === "short" && outcome.rsi != null) {
        profile.shortRsiMinimum = clamp(profile.shortRsiMinimum + clamp(outcome.rsi - profile.shortRsiMinimum, -1, 1) * 0.05, 42, 62);
      }
      if (outcome.adx != null) {
        profile.maximumAdx = clamp(profile.maximumAdx + clamp(outcome.adx - profile.maximumAdx, -0.5, 0.5) * 0.05, 16, 32);
      }
      if (outcome.volumeRatio != null) {
        profile.minimumVolumeRatio = clamp(profile.minimumVolumeRatio + clamp(outcome.volumeRatio - profile.minimumVolumeRatio, -0.02, 0.02) * 0.05, 0.65, 1.25);
      }
    } else {
      profile.consecutiveLosses = Math.min(5, profile.consecutiveLosses + 1);
      profile.minimumConfidence = clamp(profile.minimumConfidence + 0.008, 0.58, 0.82);
      profile.minimumPriceActionScore = clamp(profile.minimumPriceActionScore + 0.01, 0.52, 0.8);
      profile.strongReversalScore = clamp(profile.strongReversalScore + 0.004, 0.68, 0.9);
      profile.riskMultiplier = clamp(profile.riskMultiplier - 0.05, 0.5, 1);
      profile.cooldownSeconds = Math.round(clamp(profile.cooldownSeconds + 60, 900, 4_800));
      if (setupKey) {
        profile.setupConfidenceAdjustments[setupKey] = clamp(
          profile.setupConfidenceAdjustments[setupKey] + 0.015,
          -0.08,
          0.15
        );
      }
      if (outcome.side === "long") {
        if (outcome.rsi != null && outcome.rsi > profile.longRsiMaximum - 5) {
          profile.longRsiMaximum = clamp(profile.longRsiMaximum - 0.4, 38, 58);
        }
        if (outcome.bollingerPosition != null && outcome.bollingerPosition > profile.longBollingerMaximum - 0.08) {
          profile.longBollingerMaximum = clamp(profile.longBollingerMaximum - 0.008, -0.1, 0.35);
        }
      } else {
        if (outcome.rsi != null && outcome.rsi < profile.shortRsiMinimum + 5) {
          profile.shortRsiMinimum = clamp(profile.shortRsiMinimum + 0.4, 42, 62);
        }
        if (outcome.bollingerPosition != null && outcome.bollingerPosition < profile.shortBollingerMinimum + 0.08) {
          profile.shortBollingerMinimum = clamp(profile.shortBollingerMinimum + 0.008, 0.65, 1.1);
        }
      }
      if (outcome.adx != null && outcome.adx >= profile.maximumAdx - 3) {
        profile.maximumAdx = clamp(profile.maximumAdx - 0.35, 16, 32);
      }
      if (outcome.volumeRatio != null && outcome.volumeRatio < profile.minimumVolumeRatio + 0.15) {
        profile.minimumVolumeRatio = clamp(profile.minimumVolumeRatio + 0.01, 0.65, 1.25);
      }
    }
  }

  const validationStart = Math.max(0, Math.floor(ordered.length * 0.8));
  const validationOutcomes = ordered.length >= 20 ? ordered.slice(validationStart) : [];
  const measured = stats(validationOutcomes.length > 0 ? validationOutcomes : ordered);
  const validationPassed = validationOutcomes.length < 4
    || (measured.expectancyUsd > 0 && measured.profitFactor >= 1.05);
  if (!validationPassed) {
    profile.riskMultiplier = clamp(profile.riskMultiplier, 0.5, 0.65);
    profile.minimumConfidence = clamp(profile.minimumConfidence + 0.01, 0.58, 0.82);
    profile.minimumPriceActionScore = clamp(profile.minimumPriceActionScore + 0.01, 0.52, 0.8);
  }
  profile.learnedFromClosedTrades = ordered.length;
  profile.preferredDirection = directionPreference(ordered);
  profile.minimumConfidence = Number(profile.minimumConfidence.toFixed(4));
  profile.longRsiMaximum = Number(profile.longRsiMaximum.toFixed(2));
  profile.shortRsiMinimum = Number(profile.shortRsiMinimum.toFixed(2));
  profile.longBollingerMaximum = Number(profile.longBollingerMaximum.toFixed(3));
  profile.shortBollingerMinimum = Number(profile.shortBollingerMinimum.toFixed(3));
  profile.maximumAdx = Number(profile.maximumAdx.toFixed(2));
  profile.minimumVolumeRatio = Number(profile.minimumVolumeRatio.toFixed(3));
  profile.minimumPriceActionScore = Number(profile.minimumPriceActionScore.toFixed(3));
  profile.strongReversalScore = Number(profile.strongReversalScore.toFixed(3));
  profile.riskMultiplier = Number(profile.riskMultiplier.toFixed(3));
  Object.keys(profile.setupConfidenceAdjustments).forEach((key) => {
    const typedKey = key as keyof typeof profile.setupConfidenceAdjustments;
    profile.setupConfidenceAdjustments[typedKey] = Number(profile.setupConfidenceAdjustments[typedKey].toFixed(3));
  });
  profile.validation = {
    sampleSize: ordered.length,
    trainingSize: validationOutcomes.length > 0 ? validationStart : ordered.length,
    validationSize: validationOutcomes.length,
    winRate: Number(measured.winRate.toFixed(4)),
    expectancyUsd: Number(measured.expectancyUsd.toFixed(4)),
    profitFactor: Number(measured.profitFactor.toFixed(4)),
    maxDrawdownUsd: Number(measured.maxDrawdownUsd.toFixed(4)),
    passed: validationPassed,
    reasons: !validationPassed
      ? ["Recent chronological scalp holdout expectancy or profit factor deteriorated; scalp risk and admission thresholds were automatically tightened."]
      : newOutcomes.length > 0
        ? [`Applied bounded scalp-only learning from ${newOutcomes.length} new closed scalp trade${newOutcomes.length === 1 ? "" : "s"}; Smart Trade parameters were untouched.`]
        : ["No new closed scalp outcomes were available."],
  };
  return profile;
}
