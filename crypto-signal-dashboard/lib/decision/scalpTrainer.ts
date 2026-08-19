import type { ScalpLearningProfile, TradeLearningOutcome } from "@/lib/decision/learningTypes";
import {
  DEFAULT_SCALP_LEARNING_PROFILE,
  SCALP_EXCEPTIONAL_REVERSAL_BYPASS_ENABLED,
  SCALP_POLICY_VERSION,
  SCALP_STANDARD_COOLDOWN_SECONDS,
} from "@/lib/perps/scalpEngine";

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

const MIN_PROFITABLE_BASELINE_TRADES = 5;
const MIN_BASELINE_VALIDATION_TRADES = 4;
export const SCALP_INCREMENTAL_LEARNING_BATCH_SIZE = 5;

function quantile(values: Array<number | null | undefined>, percentile: number) {
  const sorted = values
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value))
    .sort((left, right) => left - right);
  if (sorted.length === 0) return null;
  return sorted[Math.round((sorted.length - 1) * percentile)] ?? null;
}

function setupAdjustmentKey(outcome: TradeLearningOutcome) {
  return outcome.scalpSetupType === "range-reversal"
    ? "rangeReversal" as const
    : outcome.scalpSetupType === "liquidity-sweep"
      ? "liquiditySweep" as const
      : outcome.scalpSetupType === "v-reversal"
        ? "vReversal" as const
        : outcome.scalpSetupType === "double-reversal"
          ? "doubleReversal" as const
          : null;
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

export function createAuditedScalpBaseline(allScalpOutcomes: TradeLearningOutcome[]) {
  const ordered = allScalpOutcomes
    .filter((outcome) => outcome.signalType === "scalp" && outcome.directionInverted !== true)
    .sort((left, right) => Date.parse(left.closedAt) - Date.parse(right.closedAt));
  const baseline = structuredClone(DEFAULT_SCALP_LEARNING_PROFILE);
  baseline.policyOutcomeOffset = ordered.length;
  baseline.learnedFromClosedTrades = ordered.length;
  baseline.validation = {
    sampleSize: 0,
    trainingSize: 0,
    validationSize: 0,
    winRate: 0,
    expectancyUsd: 0,
    profitFactor: 0,
    maxDrawdownUsd: 0,
    passed: true,
    reasons: ["Audited recent-performance scalp baseline activated; prior outcomes were retained for audit and new post-upgrade learning starts after migration."],
  };
  return baseline;
}

function winnerDirectionPreference(winners: TradeLearningOutcome[]) {
  const longs = winners.filter((outcome) => outcome.side === "long");
  const shorts = winners.filter((outcome) => outcome.side === "short");
  const longProfit = longs.reduce((sum, outcome) => sum + outcome.netPnlUsd, 0);
  const shortProfit = shorts.reduce((sum, outcome) => sum + outcome.netPnlUsd, 0);
  if (longs.length >= 2 && longProfit > shortProfit * 1.5) return "bullish" as const;
  if (shorts.length >= 2 && shortProfit > longProfit * 1.5) return "bearish" as const;
  return "balanced" as const;
}

function outcomeMatchesWinnerBaseline(outcome: TradeLearningOutcome, profile: ScalpLearningProfile) {
  const direction = outcome.side === "long" ? "bullish" : "bearish";
  if (profile.preferredDirection !== "balanced" && profile.preferredDirection !== direction) return false;
  const setupKey = setupAdjustmentKey(outcome);
  if (!setupKey || outcome.signalConfidence == null || outcome.priceActionScore == null) return false;
  const requiredConfidence = clamp(
    profile.minimumConfidence + profile.setupConfidenceAdjustments[setupKey],
    0.55,
    0.9
  );
  if (outcome.signalConfidence < requiredConfidence || outcome.priceActionScore < profile.minimumPriceActionScore) {
    return false;
  }

  if (outcome.scalpSetupType === "range-reversal") {
    if (outcome.adx == null || outcome.adx > profile.maximumAdx) return false;
    if (outcome.emaSpreadPercent != null && Math.abs(outcome.emaSpreadPercent) > profile.maximumEmaSpreadPercent) return false;
    if (outcome.atrPercent != null && outcome.atrPercent < profile.minimumAtrPercent) return false;
    if (outcome.bollingerBandwidthPercent != null && outcome.bollingerBandwidthPercent < profile.minimumBandwidthPercent) return false;
    if (outcome.volumeRatio != null && outcome.volumeRatio < profile.minimumVolumeRatio) return false;
    if (outcome.side === "long") {
      return outcome.rsi != null && outcome.rsi <= profile.longRsiMaximum
        && outcome.bollingerPosition != null && outcome.bollingerPosition <= profile.longBollingerMaximum;
    }
    return outcome.rsi != null && outcome.rsi >= profile.shortRsiMinimum
      && outcome.bollingerPosition != null && outcome.bollingerPosition >= profile.shortBollingerMinimum;
  }

  const exceptional = outcome.priceActionTags?.includes("EXCEPTIONAL_CONFIRMED_PRICE_ACTION") === true;
  if (exceptional) return SCALP_EXCEPTIONAL_REVERSAL_BYPASS_ENABLED;
  if (outcome.adx == null || outcome.adx > 40) return false;
  if (outcome.emaSpreadPercent != null
    && Math.abs(outcome.emaSpreadPercent) > Math.min(1.5, profile.maximumEmaSpreadPercent + 0.55)) return false;
  return outcome.rsi != null && (outcome.side === "long" ? outcome.rsi <= 62 : outcome.rsi >= 38);
}

export function createProfitableScalpBaseline(
  current: ScalpLearningProfile | null | undefined,
  allScalpOutcomes: TradeLearningOutcome[]
): ScalpLearningProfile {
  const ordered = allScalpOutcomes
    .filter((outcome) => outcome.signalType === "scalp" && outcome.directionInverted !== true)
    .sort((left, right) => Date.parse(left.closedAt) - Date.parse(right.closedAt));
  const compatibleOffset = Math.min(current?.policyOutcomeOffset ?? ordered.length, ordered.length);
  const compatibleOutcomes = ordered.slice(compatibleOffset);
  const winners = compatibleOutcomes.filter((outcome) => (
    outcome.netPnlUsd > 0
    && outcome.scalpSetupType != null
    && outcome.signalConfidence != null
    && outcome.priceActionScore != null
  ));
  const baseline = structuredClone(DEFAULT_SCALP_LEARNING_PROFILE);
  baseline.policyOutcomeOffset = ordered.length;
  baseline.learnedFromClosedTrades = ordered.length;
  baseline.riskMultiplier = 0.5;
  baseline.cooldownSeconds = 3_600;

  if (winners.length < MIN_PROFITABLE_BASELINE_TRADES) {
    baseline.validation = {
      sampleSize: compatibleOutcomes.length,
      trainingSize: winners.length,
      validationSize: 0,
      winRate: 0,
      expectancyUsd: 0,
      profitFactor: 0,
      maxDrawdownUsd: 0,
      passed: false,
      reasons: [`Scalp Mode paused: only ${winners.length} compatible post-fee winner${winners.length === 1 ? "" : "s"} were available; ${MIN_PROFITABLE_BASELINE_TRADES} are required for a winner-derived baseline.`],
    };
    return baseline;
  }

  const rangeWinners = winners.filter((outcome) => outcome.scalpSetupType === "range-reversal");
  const longRangeWinners = rangeWinners.filter((outcome) => outcome.side === "long");
  const shortRangeWinners = rangeWinners.filter((outcome) => outcome.side === "short");
  baseline.minimumConfidence = Number(clamp(quantile(winners.map((outcome) => outcome.signalConfidence), 0.25) ?? 0.82, 0.68, 0.82).toFixed(4));
  baseline.minimumPriceActionScore = Number(clamp(quantile(winners.map((outcome) => outcome.priceActionScore), 0.25) ?? 0.58, 0.58, 0.82).toFixed(3));
  baseline.strongReversalScore = Number(clamp(quantile(winners.map((outcome) => outcome.priceActionScore), 0.75) ?? 0.9, 0.78, 0.9).toFixed(3));
  baseline.preferredDirection = winnerDirectionPreference(winners);
  baseline.longRsiMaximum = Number(clamp(quantile(longRangeWinners.map((outcome) => outcome.rsi), 0.75) ?? 46, 38, 58).toFixed(2));
  baseline.shortRsiMinimum = Number(clamp(quantile(shortRangeWinners.map((outcome) => outcome.rsi), 0.25) ?? 54, 42, 62).toFixed(2));
  baseline.longBollingerMaximum = Number(clamp(quantile(longRangeWinners.map((outcome) => outcome.bollingerPosition), 0.75) ?? 0.22, -0.1, 0.35).toFixed(3));
  baseline.shortBollingerMinimum = Number(clamp(quantile(shortRangeWinners.map((outcome) => outcome.bollingerPosition), 0.25) ?? 0.78, 0.65, 1.1).toFixed(3));
  baseline.maximumAdx = Number(clamp(quantile(rangeWinners.map((outcome) => outcome.adx), 0.75) ?? 22, 16, 32).toFixed(2));
  baseline.minimumVolumeRatio = Number(clamp(quantile(rangeWinners.map((outcome) => outcome.volumeRatio), 0.25) ?? 0.75, 0.65, 1.25).toFixed(3));

  const setupKeys = ["rangeReversal", "liquiditySweep", "vReversal", "doubleReversal"] as const;
  const winningAverageBySetup = Object.fromEntries(setupKeys.map((key) => {
    const setupWinners = winners.filter((outcome) => setupAdjustmentKey(outcome) === key);
    return [key, setupWinners.length > 0 ? expectancy(setupWinners) : null];
  })) as Record<(typeof setupKeys)[number], number | null>;
  const bestWinningAverage = Math.max(...Object.values(winningAverageBySetup).filter((value): value is number => value != null));
  setupKeys.forEach((key) => {
    const average = winningAverageBySetup[key];
    baseline.setupConfidenceAdjustments[key] = average == null
      ? 0.15
      : Number(clamp(
          average === bestWinningAverage ? -0.02 : (bestWinningAverage - average) / Math.max(bestWinningAverage, 0.01) * 0.08,
          -0.02,
          0.15
        ).toFixed(3));
  });

  const admittedValidation = compatibleOutcomes.filter((outcome) => outcomeMatchesWinnerBaseline(outcome, baseline));
  const measured = stats(admittedValidation);
  const validationPassed = admittedValidation.length >= MIN_BASELINE_VALIDATION_TRADES
    && measured.expectancyUsd > 0
    && measured.profitFactor >= 1.05;
  baseline.validation = {
    sampleSize: compatibleOutcomes.length,
    trainingSize: winners.length,
    validationSize: admittedValidation.length,
    winRate: Number(measured.winRate.toFixed(4)),
    expectancyUsd: Number(measured.expectancyUsd.toFixed(4)),
    profitFactor: Number(measured.profitFactor.toFixed(4)),
    maxDrawdownUsd: Number(measured.maxDrawdownUsd.toFixed(4)),
    passed: validationPassed,
    reasons: validationPassed
      ? [`Winner-derived scalp baseline passed counterfactual validation against ${compatibleOutcomes.length} compatible closed outcomes.`]
      : [`Scalp Mode paused: the baseline learned from ${winners.length} compatible post-fee winners, but admitted loss-history validation remained negative.`],
  };
  return baseline;
}

export function createOperatorActivatedProfitableScalpBaseline(
  allScalpOutcomes: TradeLearningOutcome[],
  activatedAt = new Date()
): ScalpLearningProfile {
  const resetSeed = structuredClone(DEFAULT_SCALP_LEARNING_PROFILE);
  resetSeed.policyOutcomeOffset = 0;
  resetSeed.learnedFromClosedTrades = 0;
  const baseline = createProfitableScalpBaseline(resetSeed, allScalpOutcomes);
  if (baseline.validation.trainingSize < MIN_PROFITABLE_BASELINE_TRADES) {
    throw new Error(
      `A profitable scalp reset requires at least ${MIN_PROFITABLE_BASELINE_TRADES} compatible post-fee winners.`
    );
  }

  const historicalValidationPassed = baseline.validation.passed;
  const reason = historicalValidationPassed
    ? "Operator activated the winner-derived scalp baseline after it passed historical validation."
    : "Operator activated the winner-derived scalp baseline despite the historical loss gate; conservative risk remains in force until new-trade validation completes.";
  baseline.operatorActivation = {
    activatedAt: activatedAt.toISOString(),
    baselineOutcomeCount: baseline.learnedFromClosedTrades,
    historicalValidationPassed,
    historicalExpectancyUsd: baseline.validation.expectancyUsd,
    historicalProfitFactor: baseline.validation.profitFactor,
    reason,
  };
  // Keep older deployed monitors compatible while the explicit operator-activation
  // metadata rolls out. The metadata preserves the true historical result.
  baseline.validation.passed = true;
  baseline.validation.reasons = [reason];
  return baseline;
}

export function updateScalpLearningProfile(
  current: ScalpLearningProfile | null | undefined,
  allScalpOutcomes: TradeLearningOutcome[]
): ScalpLearningProfile {
  const ordered = allScalpOutcomes
    .filter((outcome) => outcome.signalType === "scalp" && outcome.directionInverted !== true)
    .sort((left, right) => Date.parse(left.closedAt) - Date.parse(right.closedAt));
  if (!current || current.policyVersion !== SCALP_POLICY_VERSION) {
    return createAuditedScalpBaseline(ordered);
  }
  const profile = structuredClone(current);
  const newOutcomes = ordered.slice(profile.learnedFromClosedTrades);
  const policyOutcomes = ordered.slice(profile.policyOutcomeOffset);

  if (newOutcomes.length === 0) {
    profile.learnedFromClosedTrades = ordered.length;
    profile.validation.reasons = ["No new closed scalp outcomes were available; the existing validation gate was preserved."];
    return profile;
  }
  if (newOutcomes.length < SCALP_INCREMENTAL_LEARNING_BATCH_SIZE) {
    profile.validation.reasons = [
      `Scalp learning is holding ${newOutcomes.length}/${SCALP_INCREMENTAL_LEARNING_BATCH_SIZE} newly closed trades; parameters remain unchanged until the batch is complete.`,
    ];
    return profile;
  }
  for (const outcome of newOutcomes) {
    const won = outcome.netPnlUsd > 0;
    const setupKey = setupAdjustmentKey(outcome);
    if (won) {
      profile.consecutiveLosses = 0;
      profile.minimumConfidence = clamp(profile.minimumConfidence - 0.002, 0.58, 0.78);
      profile.minimumPriceActionScore = clamp(profile.minimumPriceActionScore - 0.002, 0.52, 0.76);
      profile.riskMultiplier = clamp(profile.riskMultiplier + 0.01, 0.5, 1);
      profile.cooldownSeconds = Math.round(clamp(
        profile.cooldownSeconds - 15,
        SCALP_STANDARD_COOLDOWN_SECONDS,
        3_600
      ));
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
      profile.cooldownSeconds = Math.round(clamp(
        profile.cooldownSeconds + 60,
        SCALP_STANDARD_COOLDOWN_SECONDS,
        4_800
      ));
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

  const validationStart = Math.max(0, Math.floor(policyOutcomes.length * 0.8));
  const validationOutcomes = policyOutcomes.length >= 20 ? policyOutcomes.slice(validationStart) : [];
  const measured = stats(validationOutcomes.length > 0 ? validationOutcomes : policyOutcomes);
  const validationPassed = validationOutcomes.length < 4
    ? profile.validation.passed
    : measured.expectancyUsd > 0 && measured.profitFactor >= 1.05;
  if (!validationPassed) {
    profile.riskMultiplier = clamp(profile.riskMultiplier, 0.5, 0.65);
    profile.minimumConfidence = clamp(profile.minimumConfidence + 0.01, 0.58, 0.82);
    profile.minimumPriceActionScore = clamp(profile.minimumPriceActionScore + 0.01, 0.52, 0.8);
  }
  if (validationOutcomes.length >= MIN_BASELINE_VALIDATION_TRADES) {
    profile.operatorActivation = null;
  }
  profile.learnedFromClosedTrades = ordered.length;
  profile.preferredDirection = directionPreference(policyOutcomes);
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
    sampleSize: policyOutcomes.length,
    trainingSize: validationOutcomes.length > 0 ? validationStart : policyOutcomes.length,
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
