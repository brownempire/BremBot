import type {
  DecisionLearningProfile,
  ScalpLearningProfile,
  ScalpSetupType,
} from "@/lib/decision/learningTypes";
import type { PricePoint } from "@/lib/price/simulated";
import type { IndicatorSnapshot } from "@/lib/signal/indicators";

export const SCALP_STANDARD_COOLDOWN_SECONDS = 25 * 60;
export const SCALP_PROFIT_COOLDOWN_SECONDS = 5 * 60;
export const SCALP_EXCEPTIONAL_REVERSAL_SCORE = 0.9;
export const SCALP_REVERSAL_MAX_ADX = 40;
export const SCALP_TRADE_LEVERAGE = 50;
export const SCALP_POLICY_VERSION = 3;

export const DEFAULT_SCALP_LEARNING_PROFILE: ScalpLearningProfile = {
  policyVersion: SCALP_POLICY_VERSION,
  policyOutcomeOffset: 0,
  learnedFromClosedTrades: 0,
  minimumConfidence: 0.62,
  cooldownSeconds: SCALP_STANDARD_COOLDOWN_SECONDS,
  longRsiMaximum: 46,
  shortRsiMinimum: 54,
  longBollingerMaximum: 0.22,
  shortBollingerMinimum: 0.78,
  maximumAdx: 22,
  maximumEmaSpreadPercent: 0.45,
  minimumAtrPercent: 0.02,
  minimumBandwidthPercent: 0.1,
  minimumVolumeRatio: 0.75,
  minimumPriceActionScore: 0.56,
  strongReversalScore: 0.74,
  minimumSweepPercent: 0.04,
  minimumReclaimPercent: 0.08,
  setupConfidenceAdjustments: {
    rangeReversal: 0,
    liquiditySweep: 0,
    vReversal: 0,
    doubleReversal: 0,
  },
  riskMultiplier: 1,
  preferredDirection: "balanced",
  consecutiveLosses: 0,
  operatorActivation: null,
  validation: {
    sampleSize: 0,
    trainingSize: 0,
    validationSize: 0,
    winRate: 0,
    expectancyUsd: 0,
    profitFactor: 0,
    maxDrawdownUsd: 0,
    passed: true,
    reasons: ["Scalp baseline is active while closed scalp outcomes are collected."],
  },
};

export type ScalpPriceAction = {
  direction: "bullish" | "bearish" | null;
  setupType: ScalpSetupType | null;
  score: number;
  strong: boolean;
  confirmed: boolean;
  tags: string[];
  sweepPercent: number;
  reclaimPercent: number;
};

export type ScalpSignal = {
  id: string;
  symbol: string;
  type: "scalp";
  direction: "bullish" | "bearish";
  confidence: number;
  summary: string;
  timestamp: number;
  setupType: ScalpSetupType;
  priceActionScore: number;
  priceActionTags: string[];
  indicatorBypass: boolean;
};

export type RecentClosedScalpTrade = {
  openedAt: number;
  closedAt: number;
  side: "long" | "short";
  netPnlUsd: number;
};

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function percent(numerator: number, denominator: number) {
  return denominator > 0 ? numerator / denominator * 100 : 0;
}

function candleHigh(point: PricePoint) {
  return point.h ?? Math.max(point.o ?? point.v, point.v);
}

function candleLow(point: PricePoint) {
  return point.l ?? Math.min(point.o ?? point.v, point.v);
}

function average(values: number[]) {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function recentVolumeRatio(points: PricePoint[]) {
  const volumes = points.flatMap((point) => Number.isFinite(point.volume) ? [point.volume as number] : []);
  if (volumes.length < 6) return null;
  const latest = average(volumes.slice(-2));
  const baseline = average(volumes.slice(-12, -2));
  return baseline > 0 ? latest / baseline : null;
}

function computeTrendBias(points: PricePoint[]) {
  const first = points[0]?.v ?? 0;
  const last = points[points.length - 1]?.v ?? 0;
  const change = first > 0 ? percent(last - first, first) : 0;
  return change >= 1 ? "bullish" : change <= -1 ? "bearish" : "sideways";
}

export function getScalpTrendBias(points: PricePoint[]) {
  return computeTrendBias(points);
}

function wickRejection(points: PricePoint[], direction: "bullish" | "bearish") {
  return points.slice(-3).some((point) => {
    const high = candleHigh(point);
    const low = candleLow(point);
    const range = high - low;
    if (range <= 0) return false;
    const open = point.o ?? point.v;
    const bodyHigh = Math.max(open, point.v);
    const bodyLow = Math.min(open, point.v);
    return direction === "bullish"
      ? (bodyLow - low) / range >= 0.42 && point.v >= low + range * 0.5
      : (high - bodyHigh) / range >= 0.42 && point.v <= high - range * 0.5;
  });
}

function momentumTurn(points: PricePoint[], direction: "bullish" | "bearish") {
  if (points.length < 7) return false;
  const earlier = points[points.length - 7]?.v ?? 0;
  const pivot = points[points.length - 4]?.v ?? 0;
  const latest = points[points.length - 1]?.v ?? 0;
  if (earlier <= 0 || pivot <= 0) return false;
  const before = percent(pivot - earlier, earlier);
  const after = percent(latest - pivot, pivot);
  return direction === "bullish"
    ? before < -0.08 && after > 0.08
    : before > 0.08 && after < -0.08;
}

function doubleReversal(points: PricePoint[], direction: "bullish" | "bearish") {
  const recent = points.slice(-16);
  if (recent.length < 10) return false;
  const extrema = recent.map((point) => direction === "bullish" ? candleLow(point) : candleHigh(point));
  const sortedIndexes = extrema
    .map((value, index) => ({ value, index }))
    .sort((left, right) => direction === "bullish" ? left.value - right.value : right.value - left.value);
  const first = sortedIndexes[0];
  const second = sortedIndexes.find((candidate) => first && Math.abs(candidate.index - first.index) >= 3);
  if (!first || !second || first.value <= 0) return false;
  const separation = Math.abs(percent(second.value - first.value, first.value));
  const between = recent.slice(Math.min(first.index, second.index), Math.max(first.index, second.index) + 1);
  const middleMove = direction === "bullish"
    ? percent(Math.max(...between.map(candleHigh)) - Math.min(first.value, second.value), first.value)
    : percent(Math.max(first.value, second.value) - Math.min(...between.map(candleLow)), first.value);
  return separation <= 0.25 && middleMove >= 0.12;
}

export function getScalpLearningProfile(profile: DecisionLearningProfile | null): ScalpLearningProfile {
  return profile?.scalpProfile
    ? structuredClone(profile.scalpProfile)
    : structuredClone(DEFAULT_SCALP_LEARNING_PROFILE);
}

export function scalpProfileAllowsLiveEntries(profile: ScalpLearningProfile) {
  return profile.policyVersion === SCALP_POLICY_VERSION
    && (profile.validation.passed || profile.operatorActivation !== null);
}

export function analyzeScalpPriceAction(
  points: PricePoint[],
  profile: ScalpLearningProfile = DEFAULT_SCALP_LEARNING_PROFILE
): ScalpPriceAction {
  const recent = points.slice(-24);
  if (recent.length < 10) {
    return { direction: null, setupType: null, score: 0, strong: false, confirmed: false, tags: [], sweepPercent: 0, reclaimPercent: 0 };
  }
  const latest = recent[recent.length - 1]!;
  const reference = recent.slice(0, -4);
  const reaction = recent.slice(-6);
  const referenceLow = Math.min(...reference.map(candleLow));
  const referenceHigh = Math.max(...reference.map(candleHigh));
  const reactionLow = Math.min(...reaction.map(candleLow));
  const reactionHigh = Math.max(...reaction.map(candleHigh));
  const bullishSweep = reactionLow < referenceLow
    && percent(referenceLow - reactionLow, referenceLow) >= profile.minimumSweepPercent
    && latest.v > referenceLow;
  const bearishSweep = reactionHigh > referenceHigh
    && percent(reactionHigh - referenceHigh, referenceHigh) >= profile.minimumSweepPercent
    && latest.v < referenceHigh;
  const bullishReclaim = percent(latest.v - reactionLow, reactionLow);
  const bearishReclaim = percent(reactionHigh - latest.v, reactionHigh);
  const bullishMomentum = momentumTurn(recent, "bullish");
  const bearishMomentum = momentumTurn(recent, "bearish");
  const bullishWick = wickRejection(recent, "bullish");
  const bearishWick = wickRejection(recent, "bearish");
  const bullishDouble = doubleReversal(recent, "bullish");
  const bearishDouble = doubleReversal(recent, "bearish");
  const volumeRatio = recentVolumeRatio(recent);

  const scoreDirection = (direction: "bullish" | "bearish") => {
    const sweep = direction === "bullish" ? bullishSweep : bearishSweep;
    const reclaim = direction === "bullish" ? bullishReclaim : bearishReclaim;
    const momentum = direction === "bullish" ? bullishMomentum : bearishMomentum;
    const wick = direction === "bullish" ? bullishWick : bearishWick;
    const double = direction === "bullish" ? bullishDouble : bearishDouble;
    const tags: string[] = [];
    let score = 0;
    if (sweep) { score += 0.34; tags.push("PRICE_LIQUIDITY_SWEEP_RECLAIM"); }
    if (reclaim >= profile.minimumReclaimPercent) {
      score += clamp(reclaim / Math.max(profile.minimumReclaimPercent * 4, 0.01), 0.08, 0.2);
      tags.push("PRICE_RECLAIM");
    }
    if (momentum) { score += 0.2; tags.push("PRICE_MOMENTUM_TURN"); }
    if (wick) { score += 0.1; tags.push("PRICE_WICK_REJECTION"); }
    if (double) { score += 0.12; tags.push(direction === "bullish" ? "PRICE_DOUBLE_BOTTOM" : "PRICE_DOUBLE_TOP"); }
    if (volumeRatio !== null && volumeRatio >= profile.minimumVolumeRatio) {
      score += 0.1;
      tags.push("PRICE_VOLUME_CONFIRMATION");
    }
    return { score: clamp(score, 0, 1), tags, sweep, reclaim, momentum, double };
  };

  const bullish = scoreDirection("bullish");
  const bearish = scoreDirection("bearish");
  const direction = bullish.score === bearish.score
    ? null
    : bullish.score > bearish.score ? "bullish" as const : "bearish" as const;
  const selected = direction === "bullish" ? bullish : bearish;
  if (!direction || selected.score < profile.minimumPriceActionScore) {
    return {
      direction: null,
      setupType: null,
      score: Number(Math.max(bullish.score, bearish.score).toFixed(3)),
      strong: false,
      confirmed: false,
      tags: [],
      sweepPercent: 0,
      reclaimPercent: 0,
    };
  }
  const setupType: ScalpSetupType = selected.sweep
    ? "liquidity-sweep"
    : selected.double
      ? "double-reversal"
      : "v-reversal";
  const reclaimHeld = direction === "bullish"
    ? recent.slice(-2).every((point) => point.v > referenceLow)
    : recent.slice(-2).every((point) => point.v < referenceHigh);
  const confirmed = selected.momentum
    && (!selected.sweep || reclaimHeld);
  return {
    direction,
    setupType,
    score: Number(selected.score.toFixed(3)),
    strong: selected.score >= profile.strongReversalScore,
    confirmed,
    tags: selected.tags,
    sweepPercent: Number((direction === "bullish"
      ? percent(referenceLow - reactionLow, referenceLow)
      : percent(reactionHigh - referenceHigh, referenceHigh)).toFixed(4)),
    reclaimPercent: Number(selected.reclaim.toFixed(4)),
  };
}

export function detectAdaptiveScalpSignal(options: {
  symbol: string;
  points: PricePoint[];
  indicators: IndicatorSnapshot;
  profile: ScalpLearningProfile;
  lastSignalAt?: number | null;
  recentClosedTrade?: RecentClosedScalpTrade | null;
}): ScalpSignal | null {
  const { points, indicators, profile } = options;
  const latest = points[points.length - 1];
  if (!latest || points.length < 3) return null;

  const priceAction = analyzeScalpPriceAction(points, profile);
  const rangeLong = computeTrendBias(points) === "sideways"
    && indicators.bollingerPosition !== null
    && indicators.bollingerPosition <= profile.longBollingerMaximum
    && indicators.rsi !== null
    && indicators.rsi <= profile.longRsiMaximum;
  const rangeShort = computeTrendBias(points) === "sideways"
    && indicators.bollingerPosition !== null
    && indicators.bollingerPosition >= profile.shortBollingerMinimum
    && indicators.rsi !== null
    && indicators.rsi >= profile.shortRsiMinimum;
  const rangeDirection = rangeLong ? "bullish" as const : rangeShort ? "bearish" as const : null;
  const rangeIndicatorsReady = indicators.adx !== null
    && indicators.adx <= profile.maximumAdx
    && indicators.emaSpreadPercent !== null
    && Math.abs(indicators.emaSpreadPercent) <= profile.maximumEmaSpreadPercent
    && indicators.atrPercent !== null
    && indicators.atrPercent >= profile.minimumAtrPercent
    && indicators.bollingerBandwidthPercent !== null
    && indicators.bollingerBandwidthPercent >= profile.minimumBandwidthPercent
    && (indicators.volumeRatio === null || indicators.volumeRatio >= profile.minimumVolumeRatio);

  const exceptionalReversal = priceAction.direction !== null
    && priceAction.confirmed
    && priceAction.score >= SCALP_EXCEPTIONAL_REVERSAL_SCORE;
  const reversalIndicatorsReady = priceAction.direction !== null
    && priceAction.confirmed
    && indicators.adx !== null
    && indicators.adx <= SCALP_REVERSAL_MAX_ADX
    && indicators.emaSpreadPercent !== null
    && Math.abs(indicators.emaSpreadPercent) <= Math.min(1.5, profile.maximumEmaSpreadPercent + 0.55)
    && indicators.rsi !== null
    && (priceAction.direction === "bullish" ? indicators.rsi <= 62 : indicators.rsi >= 38);
  const strongReversal = !exceptionalReversal && priceAction.strong && reversalIndicatorsReady;
  const moderateReversal = !priceAction.strong && reversalIndicatorsReady;
  const direction = exceptionalReversal || strongReversal || moderateReversal
    ? priceAction.direction
    : rangeIndicatorsReady ? rangeDirection : null;
  if (!direction) return null;
  if (profile.preferredDirection !== "balanced" && direction !== profile.preferredDirection) return null;

  if (options.lastSignalAt && latest.t - options.lastSignalAt < profile.cooldownSeconds * 1_000) {
    const recentTrade = options.recentClosedTrade;
    const previousDirection = recentTrade?.side === "long" ? "bullish" : "bearish";
    const tradeMatchesLastSignal = Boolean(
      recentTrade
      && recentTrade.openedAt >= options.lastSignalAt - 2 * 60_000
      && recentTrade.openedAt <= options.lastSignalAt + 5 * 60_000
      && recentTrade.closedAt >= recentTrade.openedAt
    );
    const profitableOppositeReversalReady = Boolean(
      exceptionalReversal
      && recentTrade
      && recentTrade.netPnlUsd > 0
      && tradeMatchesLastSignal
      && direction !== previousDirection
      && latest.t - recentTrade.closedAt >= SCALP_PROFIT_COOLDOWN_SECONDS * 1_000
    );
    if (!profitableOppositeReversalReady) return null;
  }

  const setupType = exceptionalReversal || strongReversal || moderateReversal
    ? priceAction.setupType!
    : "range-reversal";
  const setupAdjustment = setupType === "range-reversal"
    ? profile.setupConfidenceAdjustments.rangeReversal
    : setupType === "liquidity-sweep"
      ? profile.setupConfidenceAdjustments.liquiditySweep
      : setupType === "v-reversal"
        ? profile.setupConfidenceAdjustments.vReversal
        : profile.setupConfidenceAdjustments.doubleReversal;
  const requiredConfidence = clamp(profile.minimumConfidence + setupAdjustment, 0.55, 0.9);
  const rangeExtremity = direction === "bullish"
    ? clamp((profile.longBollingerMaximum - (indicators.bollingerPosition ?? profile.longBollingerMaximum)) / 0.3, 0, 1)
    : clamp(((indicators.bollingerPosition ?? profile.shortBollingerMinimum) - profile.shortBollingerMinimum) / 0.3, 0, 1);
  const rawConfidence = exceptionalReversal || strongReversal || moderateReversal
    ? 0.55 + priceAction.score * 0.35
    : 0.6 + rangeExtremity * 0.22;
  if (rawConfidence < requiredConfidence) return null;
  const confidence = clamp(rawConfidence, 0, exceptionalReversal || strongReversal || moderateReversal ? 0.9 : 0.82);
  const tags = exceptionalReversal || strongReversal || moderateReversal
    ? [
        ...priceAction.tags,
        exceptionalReversal
          ? "EXCEPTIONAL_CONFIRMED_PRICE_ACTION"
          : strongReversal
            ? "INDICATORS_CONFIRMED_STRONG_PRICE_ACTION"
            : "INDICATORS_CONFIRMED_PRICE_ACTION",
      ]
    : ["SCALP_RANGE", direction === "bullish" ? "SCALP_RANGE_LOW" : "SCALP_RANGE_HIGH"];

  return {
    id: `${options.symbol}-scalp-${latest.t}`,
    symbol: options.symbol,
    type: "scalp",
    direction,
    confidence: Number(confidence.toFixed(3)),
    summary: setupType === "range-reversal"
      ? `${direction === "bullish" ? "Range-low" : "Range-high"} scalp setup with adaptive indicator confirmation.`
      : `${direction === "bullish" ? "Bullish" : "Bearish"} ${setupType.replace(/-/g, " ")} detected from real-time candle structure.`,
    timestamp: latest.t,
    setupType,
    priceActionScore: setupType === "range-reversal" ? Number((0.55 + rangeExtremity * 0.2).toFixed(3)) : priceAction.score,
    priceActionTags: tags,
    indicatorBypass: exceptionalReversal,
  };
}
