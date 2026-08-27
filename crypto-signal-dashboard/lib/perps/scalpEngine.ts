import type {
  DecisionLearningProfile,
  ScalpLearningProfile,
  ScalpSetupType,
} from "@/lib/decision/learningTypes";
import type { PricePoint } from "@/lib/price/simulated";
import {
  computeIndicatorSnapshot,
  type IndicatorSnapshot,
} from "@/lib/signal/indicators";
import { SCALP_NORMAL_MAXIMUM_LEVERAGE } from "@/lib/perps/scalpLeverage";
import { resolveScalpRolloutTimeout } from "@/lib/perps/scalpTimeoutPolicy";

export {
  SCALP_EXCEPTIONAL_MAXIMUM_LEVERAGE,
  SCALP_MINIMUM_LEVERAGE,
  SCALP_NORMAL_MAXIMUM_LEVERAGE,
} from "@/lib/perps/scalpLeverage";

// Policy v8 only routes completed, structurally confirmed entries. A rejected
// candidate never starts this timer: the cooldown begins only when an actual
// scalp trade closes.
export const SCALP_STANDARD_COOLDOWN_SECONDS = 7 * 60;
export const SCALP_EXCEPTIONAL_REVERSAL_SCORE = 0.9;
export const SCALP_EXCEPTIONAL_REVERSAL_BYPASS_ENABLED: boolean = true;
export const SCALP_EXCEPTIONAL_REVERSAL_MAX_ADX = 45;
export const SCALP_REVERSAL_MIN_VOLUME_RATIO = 0.75;
export const SCALP_REVERSAL_MAX_ADX = 40;
export const SCALP_CONTINUATION_MIN_ADX = 20;
export const SCALP_CONTINUATION_MAX_ADX = 45;
export const SCALP_CONTINUATION_MIN_PRICE_ACTION_SCORE = 0.64;
export const SCALP_CONTINUATION_STANDARD_PRICE_ACTION_SCORE = 0.72;
export const SCALP_CONTINUATION_PREVIOUS_MIN_PRICE_ACTION_SCORE = 0.58;
export const SCALP_CONTINUATION_MIN_CONFIRMATION_GROUPS = 3;
export const SCALP_BREAKOUT_RETEST_MIN_PRICE_ACTION_SCORE = 0.72;
export const SCALP_RANGE_REVERSAL_SIGNAL_CONFIDENCE = 0.82;
export const SCALP_CONTINUATION_MAX_EMA_SPREAD_PERCENT = 0.45;
export const SCALP_CONTINUATION_MIN_ATR_PERCENT = 0.1;
export const SCALP_CONTINUATION_MIN_VOLUME_RATIO = 1.15;
export const SCALP_CONTINUATION_LONG_BOLLINGER_MAXIMUM = 0.72;
export const SCALP_CONTINUATION_SHORT_BOLLINGER_MINIMUM = 0.28;
export const SCALP_CONTINUATION_LONG_RSI_MIN = 55;
export const SCALP_CONTINUATION_LONG_RSI_MAX = 82;
export const SCALP_CONTINUATION_SHORT_RSI_MIN = 18;
export const SCALP_CONTINUATION_SHORT_RSI_MAX = 45;
export const SCALP_CONTINUATION_MIN_PROJECTED_ROE_PERCENT = 10;
// Every independently confirmed scalp path is authorized for live routing.
// Path-specific indicator, persistence, economics, circuit, and order-protection
// checks still apply; these flags only prevent a qualified path from being
// silently downgraded to diagnostics/shadow mode.
export const SCALP_CONTINUATION_LIVE_ENABLED = true;
export const SCALP_RANGE_REVERSAL_LIVE_ENABLED = true;
export const SCALP_REVERSAL_LIVE_ENABLED = true;
export const SCALP_BREAKOUT_RETEST_MIN_ATR_PERCENT = 0.09;
export const SCALP_EXHAUSTION_LOOKBACK_MINUTES = 145;
export const SCALP_MAX_145M_NET_OR_RANGE_PERCENT = 2;
// Keep the 145-minute regime measurement for diagnostics and learning, but do
// not use a wide historical range as a blanket live veto. Fresh path-specific
// confirmation determines whether an entry is actionable.
export const SCALP_EXHAUSTION_BLOCK_ENABLED = false;
// Normal scalp setups are quality-scaled from 25-40x. This compatibility
// export remains the planning/UI ceiling; independently exceptional setups may
// use the separately enforced 50x cap.
export const SCALP_TRADE_LEVERAGE = SCALP_NORMAL_MAXIMUM_LEVERAGE;
export const SCALP_POLICY_VERSION = 8;

export const DEFAULT_SCALP_LEARNING_PROFILE: ScalpLearningProfile = {
  policyVersion: SCALP_POLICY_VERSION,
  policyOutcomeOffset: 0,
  learnedFromClosedTrades: 0,
  processedPolicyOutcomeIds: [],
  minimumConfidence: 0.77,
  cooldownSeconds: SCALP_STANDARD_COOLDOWN_SECONDS,
  longRsiMaximum: 40.62,
  shortRsiMinimum: 58.85,
  longBollingerMaximum: 0.14,
  shortBollingerMinimum: 0.876,
  maximumAdx: 17.36,
  maximumEmaSpreadPercent: 0.45,
  minimumAtrPercent: 0.02,
  minimumBandwidthPercent: 0.1,
  minimumVolumeRatio: 1.037,
  minimumPriceActionScore: 0.58,
  strongReversalScore: 0.856,
  minimumSweepPercent: 0.04,
  minimumReclaimPercent: 0.08,
  setupConfidenceAdjustments: {
    rangeReversal: 0.023,
    liquiditySweep: 0.036,
    vReversal: 0.075,
    doubleReversal: 0.02,
  },
  riskMultiplier: 0.5,
  preferredDirection: "balanced",
  consecutiveLosses: 0,
  operatorActivation: null,
  // A live rollout boundary is wallet state, not a module-load timestamp. The
  // monitor persists it through ensureWalletScalpPolicyProfile before v8 can
  // account outcomes or admit live scalp entries.
  policyRollout: null,
  validation: {
    sampleSize: 0,
    trainingSize: 0,
    validationSize: 0,
    winRate: 0,
    expectancyUsd: 0,
    profitFactor: 0,
    maxDrawdownUsd: 0,
    passed: false,
    reasons: ["Policy v8 requires a persisted wallet rollout before live probation can begin."],
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

export type ScalpCandidatePath = "breakout-retest" | "continuation" | "reversal" | "range-reversal" | "none";

export function scalpCandidatePathAllowsLiveSignal(path: ScalpCandidatePath) {
  if (path === "breakout-retest") return true;
  if (path === "continuation") return SCALP_CONTINUATION_LIVE_ENABLED;
  if (path === "range-reversal") return SCALP_RANGE_REVERSAL_LIVE_ENABLED;
  if (path === "reversal") return SCALP_REVERSAL_LIVE_ENABLED;
  return false;
}

export type ScalpCandidateDiagnostic = {
  path: ScalpCandidatePath;
  direction: "bullish" | "bearish" | null;
  score: number;
  accepted: boolean;
  rejectionReasons: string[];
  tags: string[];
  entryPrice: number | null;
  timestamp: number | null;
  regime: ScalpMarketRegime;
};

export type ScalpCandidateEvaluation = {
  signal: ScalpSignal | null;
  candidate: ScalpCandidateDiagnostic;
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

type Direction = "bullish" | "bearish";

export type ScalpRegimeHorizon = {
  minutes: 5 | 15 | 60;
  direction: Direction | "sideways";
  netMovePercent: number;
  atrPercent: number;
  emaFast: number | null;
  emaSlow: number | null;
  plusDi: number | null;
  minusDi: number | null;
};

export type ScalpMarketRegime = {
  bias: Direction | "sideways";
  trending: boolean;
  exhausted: boolean;
  netMove145mPercent: number;
  range145mPercent: number;
  horizons: ScalpRegimeHorizon[];
};

function emaLast(values: number[], period: number) {
  if (values.length < period || period < 1) return null;
  let current = average(values.slice(0, period));
  const multiplier = 2 / (period + 1);
  for (const value of values.slice(period)) current = (value - current) * multiplier + current;
  return current;
}

function directionalMovement(points: PricePoint[], period: number) {
  if (points.length < 3) return { plusDi: null, minusDi: null };
  const window = points.slice(-(Math.min(period, points.length - 1) + 1));
  let trueRange = 0;
  let plus = 0;
  let minus = 0;
  for (let index = 1; index < window.length; index += 1) {
    const current = window[index]!;
    const previous = window[index - 1]!;
    const high = candleHigh(current);
    const low = candleLow(current);
    const previousHigh = candleHigh(previous);
    const previousLow = candleLow(previous);
    trueRange += Math.max(high - low, Math.abs(high - previous.v), Math.abs(low - previous.v));
    const upMove = high - previousHigh;
    const downMove = previousLow - low;
    if (upMove > downMove && upMove > 0) plus += upMove;
    if (downMove > upMove && downMove > 0) minus += downMove;
  }
  return {
    plusDi: trueRange > 0 ? plus / trueRange * 100 : 0,
    minusDi: trueRange > 0 ? minus / trueRange * 100 : 0,
  };
}

function horizonRegime(points: PricePoint[], minutes: 5 | 15 | 60): ScalpRegimeHorizon {
  const window = points.slice(-Math.min(points.length, minutes + 1));
  const values = window.map((point) => point.v);
  const first = values[0] ?? 0;
  const latest = values[values.length - 1] ?? 0;
  const netMovePercent = first > 0 ? percent(latest - first, first) : 0;
  const trueRanges = window.slice(1).map((point, index) => {
    const previous = window[index]!;
    return Math.max(
      candleHigh(point) - candleLow(point),
      Math.abs(candleHigh(point) - previous.v),
      Math.abs(candleLow(point) - previous.v),
    );
  });
  const atrPercent = latest > 0 && trueRanges.length > 0
    ? average(trueRanges) / latest * 100
    : 0;
  const fastPeriod = minutes === 5 ? 2 : minutes === 15 ? 5 : 9;
  const slowPeriod = minutes === 5 ? 4 : minutes === 15 ? 10 : 21;
  const emaFast = emaLast(values, fastPeriod);
  const emaSlow = emaLast(values, slowPeriod);
  const dmi = directionalMovement(window, Math.min(14, Math.max(2, window.length - 1)));
  const minimumDirectionalMove = Math.max(0.02, atrPercent * 0.5);
  const bullish = netMovePercent >= minimumDirectionalMove
    && emaFast !== null
    && emaSlow !== null
    && emaFast > emaSlow
    && dmi.plusDi !== null
    && dmi.minusDi !== null
    && dmi.plusDi > dmi.minusDi;
  const bearish = netMovePercent <= -minimumDirectionalMove
    && emaFast !== null
    && emaSlow !== null
    && emaFast < emaSlow
    && dmi.plusDi !== null
    && dmi.minusDi !== null
    && dmi.minusDi > dmi.plusDi;
  return {
    minutes,
    direction: bullish ? "bullish" : bearish ? "bearish" : "sideways",
    netMovePercent: Number(netMovePercent.toFixed(4)),
    atrPercent: Number(atrPercent.toFixed(4)),
    emaFast,
    emaSlow,
    plusDi: dmi.plusDi,
    minusDi: dmi.minusDi,
  };
}

export function classifyScalpMarketRegime(points: PricePoint[]): ScalpMarketRegime {
  const horizons = ([5, 15, 60] as const).map((minutes) => horizonRegime(points, minutes));
  const bullishVotes = horizons.filter((horizon) => horizon.direction === "bullish").length;
  const bearishVotes = horizons.filter((horizon) => horizon.direction === "bearish").length;
  const bias: ScalpMarketRegime["bias"] = bullishVotes >= 2
    ? "bullish"
    : bearishVotes >= 2
      ? "bearish"
      : "sideways";
  const exhaustionWindow = points.slice(-SCALP_EXHAUSTION_LOOKBACK_MINUTES);
  const first = exhaustionWindow[0]?.v ?? 0;
  const latest = exhaustionWindow.at(-1)?.v ?? 0;
  const netMove145mPercent = first > 0 ? Math.abs(percent(latest - first, first)) : 0;
  const high = exhaustionWindow.length > 0 ? Math.max(...exhaustionWindow.map(candleHigh)) : 0;
  const low = exhaustionWindow.length > 0 ? Math.min(...exhaustionWindow.map(candleLow)) : 0;
  const range145mPercent = first > 0 ? percent(high - low, first) : 0;
  return {
    bias,
    trending: bias !== "sideways",
    exhausted: netMove145mPercent > SCALP_MAX_145M_NET_OR_RANGE_PERCENT
      || range145mPercent > SCALP_MAX_145M_NET_OR_RANGE_PERCENT,
    netMove145mPercent: Number(netMove145mPercent.toFixed(4)),
    range145mPercent: Number(range145mPercent.toFixed(4)),
    horizons,
  };
}

function computeTrendBias(points: PricePoint[]) {
  return classifyScalpMarketRegime(points).bias;
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

export function normalizeScalpLearningProfileForLiveOperation(
  profile: ScalpLearningProfile
): ScalpLearningProfile {
  const scalpProfile = structuredClone(profile);
  // A completed range-reversal state emits a fixed 0.82 confidence. Never let
  // learning raise its required confidence above that reachable value.
  const reachableRangeAdjustment = Math.floor(
    (SCALP_RANGE_REVERSAL_SIGNAL_CONFIDENCE - scalpProfile.minimumConfidence + Number.EPSILON) * 1_000
  ) / 1_000;
  scalpProfile.setupConfidenceAdjustments.rangeReversal = Number(clamp(
    scalpProfile.setupConfidenceAdjustments.rangeReversal,
    -0.08,
    reachableRangeAdjustment
  ).toFixed(3));
  scalpProfile.cooldownSeconds = SCALP_STANDARD_COOLDOWN_SECONDS;
  return scalpProfile;
}

export function getScalpLearningProfile(profile: DecisionLearningProfile | null): ScalpLearningProfile {
  const scalpProfile = profile?.scalpProfile
    ? structuredClone(profile.scalpProfile)
    : structuredClone(DEFAULT_SCALP_LEARNING_PROFILE);
  // The operator-selected post-close cooldown is fixed at seven minutes.
  // Normalize persisted profiles immediately so deployment does not wait for
  // another learning batch or policy migration to take effect.
  return normalizeScalpLearningProfileForLiveOperation(scalpProfile);
}

export function scalpProfileAllowsLiveEntries(
  profile: ScalpLearningProfile,
  evaluatedAt: Date | number | string = Date.now()
) {
  const rollout = profile.policyRollout;
  if (profile.policyVersion !== SCALP_POLICY_VERSION) return false;
  if (rollout?.status === "paused") {
    return !resolveScalpRolloutTimeout(rollout, evaluatedAt).timedOut;
  }
  return (
      profile.validation.passed
      || profile.operatorActivation !== null
      || (
        rollout?.status === "probation"
        && rollout.liveTradingAuthorized
        && rollout.authorization === "operator-approved-live-rollout"
      )
    );
}

export type ScalpTrendContinuationEvaluation = {
  qualified: boolean;
  reasons: string[];
  confirmationGroupsPassed: number;
  confirmationTags: string[];
};

export type ScalpReversalSafetyEvaluation = {
  qualified: boolean;
  reasons: string[];
};

export type ScalpStructuredEntryEvaluation = {
  qualified: boolean;
  direction: Direction | null;
  setupType: ScalpSetupType | null;
  score: number;
  tags: string[];
  reasons: string[];
};

export function evaluateScalpReversalSafety(options: {
  priceAction: ScalpPriceAction;
  previousPriceAction: ScalpPriceAction;
  indicators: IndicatorSnapshot;
  profile: ScalpLearningProfile;
}): ScalpReversalSafetyEvaluation {
  const { priceAction, previousPriceAction, indicators, profile } = options;
  const direction = priceAction.direction;
  const reasons: string[] = [];
  const genuineDefinedLevelSweep = priceAction.setupType === "liquidity-sweep"
    && priceAction.tags.includes("PRICE_LIQUIDITY_SWEEP_RECLAIM")
    && priceAction.tags.includes("PRICE_RECLAIM")
    && priceAction.tags.includes("PRICE_MOMENTUM_TURN")
    && priceAction.sweepPercent >= profile.minimumSweepPercent
    && priceAction.reclaimPercent >= profile.minimumReclaimPercent;
  if (!genuineDefinedLevelSweep) {
    reasons.push("Live reversal requires a defined-level liquidity sweep, reclaim, directional turn, and two reclaimed closes.");
  }
  const persisted = direction !== null
    && priceAction.confirmed
    && previousPriceAction.direction === direction
    && previousPriceAction.confirmed
    && previousPriceAction.score >= profile.minimumPriceActionScore;
  if (!persisted) reasons.push("The reversal has not remained confirmed across two completed candles.");

  if (indicators.volumeRatio === null || indicators.volumeRatio < SCALP_REVERSAL_MIN_VOLUME_RATIO) {
    reasons.push(`Closed-candle volume must reach ${SCALP_REVERSAL_MIN_VOLUME_RATIO.toFixed(2)}× its recent average.`);
  }
  if (indicators.adx === null || indicators.adx > SCALP_EXCEPTIONAL_REVERSAL_MAX_ADX) {
    reasons.push(`Reversal ADX must not exceed ${SCALP_EXCEPTIONAL_REVERSAL_MAX_ADX}.`);
  }

  const bullish = direction === "bullish";
  const emaOpposes = direction !== null
    && indicators.emaFast !== null
    && indicators.emaSlow !== null
    && (bullish ? indicators.emaFast < indicators.emaSlow : indicators.emaFast > indicators.emaSlow);
  const directionalMovementOpposes = direction !== null
    && indicators.plusDi !== null
    && indicators.minusDi !== null
    && (bullish ? indicators.minusDi > indicators.plusDi : indicators.plusDi > indicators.minusDi);
  if (emaOpposes && directionalMovementOpposes) {
    reasons.push("EMA 9/21 and directional movement both oppose the reversal direction.");
  }

  return { qualified: reasons.length === 0, reasons };
}

export function evaluateScalpTrendContinuation(options: {
  priceAction: ScalpPriceAction;
  previousPriceAction?: ScalpPriceAction;
  points?: PricePoint[];
  trendBias: "bullish" | "bearish" | "sideways";
  indicators: IndicatorSnapshot;
  profile: ScalpLearningProfile;
  regime?: ScalpMarketRegime;
}): ScalpTrendContinuationEvaluation {
  const { priceAction, previousPriceAction, points, trendBias, indicators, profile } = options;
  const regime = options.regime ?? (points ? classifyScalpMarketRegime(points) : null);
  const direction = priceAction.direction;
  const bullish = direction === "bullish";
  const reasons: string[] = [];
  const continuationFloor = SCALP_CONTINUATION_MIN_PRICE_ACTION_SCORE;
  if (priceAction.score < continuationFloor) {
    reasons.push(`Price-action score ${priceAction.score.toFixed(2)} is below the live continuation floor ${continuationFloor.toFixed(2)}.`);
  }
  if (!direction || !priceAction.confirmed) reasons.push("Momentum and reclaim have not confirmed a direction.");
  const persisted = direction !== null
    && previousPriceAction?.direction === direction
    && previousPriceAction.confirmed
    && previousPriceAction.score >= SCALP_CONTINUATION_PREVIOUS_MIN_PRICE_ACTION_SCORE;
  if (!persisted) reasons.push("Continuation must persist in the same direction across two completed candles.");
  if (direction && trendBias !== direction) reasons.push(`The ${trendBias} trend does not align with the ${direction} setup.`);
  if (SCALP_EXHAUSTION_BLOCK_ENABLED && regime?.exhausted) {
    reasons.push(`The 145-minute move or range exceeds the ${SCALP_MAX_145M_NET_OR_RANGE_PERCENT.toFixed(0)}% exhaustion limit.`);
  }
  const emaAligned = direction !== null
    && indicators.emaFast !== null
    && indicators.emaSlow !== null
    && (bullish ? indicators.emaFast > indicators.emaSlow : indicators.emaFast < indicators.emaSlow)
    && indicators.emaSlopePercent !== null
    && (bullish ? indicators.emaSlopePercent > 0 : indicators.emaSlopePercent < 0);
  const emaSpreadReady = indicators.emaSpreadPercent !== null
    && Math.abs(indicators.emaSpreadPercent) <= SCALP_CONTINUATION_MAX_EMA_SPREAD_PERCENT;
  const emaGroupReady = emaAligned && emaSpreadReady;
  const rsiReady = direction !== null
    && indicators.rsi !== null
    && (bullish
      ? indicators.rsi >= SCALP_CONTINUATION_LONG_RSI_MIN && indicators.rsi <= SCALP_CONTINUATION_LONG_RSI_MAX
      : indicators.rsi >= SCALP_CONTINUATION_SHORT_RSI_MIN && indicators.rsi <= SCALP_CONTINUATION_SHORT_RSI_MAX);
  const directionalMovementReady = direction !== null
    && indicators.plusDi !== null
    && indicators.minusDi !== null
    && (bullish ? indicators.plusDi > indicators.minusDi : indicators.minusDi > indicators.plusDi);
  const adxReady = indicators.adx !== null
    && indicators.adx >= SCALP_CONTINUATION_MIN_ADX
    && indicators.adx <= SCALP_CONTINUATION_MAX_ADX;
  const dmiGroupReady = directionalMovementReady && adxReady;
  const macdReady = direction !== null
    && indicators.macdLine !== null
    && indicators.macdSignal !== null
    && indicators.macdHistogram !== null
    && indicators.macdHistogramChange !== null
    && (bullish
      ? indicators.macdLine > indicators.macdSignal
        && indicators.macdHistogram > 0
        && indicators.macdHistogramChange > 0
      : indicators.macdLine < indicators.macdSignal
        && indicators.macdHistogram < 0
        && indicators.macdHistogramChange < 0);
  const bollingerReady = direction !== null
    && indicators.bollingerPosition !== null
    && (bullish
      ? indicators.bollingerPosition <= SCALP_CONTINUATION_LONG_BOLLINGER_MAXIMUM
      : indicators.bollingerPosition >= SCALP_CONTINUATION_SHORT_BOLLINGER_MINIMUM);
  const volumeReady = indicators.volumeRatio !== null
    && indicators.volumeRatio >= SCALP_CONTINUATION_MIN_VOLUME_RATIO;
  const locationParticipationReady = [rsiReady, bollingerReady, volumeReady]
    .filter(Boolean).length >= 2;
  const confirmationGroups = [
    [emaGroupReady, "CONTINUATION_EMA_CONFIRMED"],
    [dmiGroupReady, "CONTINUATION_DMI_ADX_CONFIRMED"],
    [macdReady, "CONTINUATION_MACD_CONFIRMED"],
    [locationParticipationReady, "CONTINUATION_LOCATION_PARTICIPATION_CONFIRMED"],
  ] as const;
  const confirmationTags = confirmationGroups
    .filter(([qualified]) => qualified)
    .map(([, tag]) => tag);
  const confirmationGroupsPassed = confirmationTags.length;
  if (confirmationGroupsPassed < SCALP_CONTINUATION_MIN_CONFIRMATION_GROUPS) {
    reasons.push(`Continuation confirmation passed ${confirmationGroupsPassed} of 4 groups; at least ${SCALP_CONTINUATION_MIN_CONFIRMATION_GROUPS} are required.`);
  }

  const emaOpposes = direction !== null
    && indicators.emaFast !== null
    && indicators.emaSlow !== null
    && (bullish ? indicators.emaFast < indicators.emaSlow : indicators.emaFast > indicators.emaSlow);
  const dmiOpposes = direction !== null
    && indicators.plusDi !== null
    && indicators.minusDi !== null
    && (bullish ? indicators.minusDi > indicators.plusDi : indicators.plusDi > indicators.minusDi);
  if (emaOpposes && dmiOpposes) {
    reasons.push("EMA 9/21 and directional movement both materially oppose the continuation direction.");
  }
  const rsiExtreme = direction !== null
    && indicators.rsi !== null
    && (bullish ? indicators.rsi > 90 : indicators.rsi < 10);
  if (rsiExtreme) reasons.push("RSI is at an extreme that invalidates a new continuation entry.");
  const projectedRoePercent = indicators.atrPercent === null
    ? 0
    : indicators.atrPercent * 2 * SCALP_TRADE_LEVERAGE;
  if (indicators.atrPercent === null
    || indicators.atrPercent < SCALP_CONTINUATION_MIN_ATR_PERCENT
    || projectedRoePercent < SCALP_CONTINUATION_MIN_PROJECTED_ROE_PERCENT) {
    reasons.push(`Two ATRs must project at least ${SCALP_CONTINUATION_MIN_PROJECTED_ROE_PERCENT}% ROE at ${SCALP_TRADE_LEVERAGE}×.`);
  }
  if (!points || !direction || !hasPullbackRetestResumption(points, direction, indicators)) {
    reasons.push("A completed pullback, EMA retest, and directional resumption are required before continuation entry.");
  }
  return {
    qualified: reasons.length === 0,
    reasons,
    confirmationGroupsPassed,
    confirmationTags,
  };
}

function hasPullbackRetestResumption(
  points: PricePoint[],
  direction: Direction,
  indicators: IndicatorSnapshot,
) {
  if (points.length < 10 || indicators.emaFast === null) return false;
  const recent = points.slice(-10);
  const latest = recent.at(-1)!;
  const previous = recent.at(-2)!;
  const beforePrevious = recent.at(-3)!;
  const structureWindow = recent.slice(0, -3);
  const swingIndex = structureWindow.reduce((selected, point, index) => {
    const candidate = direction === "bullish" ? candleHigh(point) : candleLow(point);
    const current = direction === "bullish"
      ? candleHigh(structureWindow[selected]!)
      : candleLow(structureWindow[selected]!);
    return direction === "bullish" ? candidate > current ? index : selected : candidate < current ? index : selected;
  }, 0);
  const pullbackWindow = structureWindow.slice(swingIndex + 1);
  if (pullbackWindow.length < 2) return false;
  const swingPrice = direction === "bullish"
    ? candleHigh(structureWindow[swingIndex]!)
    : candleLow(structureWindow[swingIndex]!);
  const tolerancePercent = Math.max((indicators.atrPercent ?? 0) * 1.25, 0.08);
  const tolerance = latest.v * tolerancePercent / 100;
  const hadCounterCandle = pullbackWindow.some((point, index) => {
    const prior = index === 0 ? structureWindow[swingIndex]! : pullbackWindow[index - 1]!;
    return direction === "bullish" ? point.v < prior.v : point.v > prior.v;
  });
  const retestPrice = direction === "bullish"
    ? Math.min(...pullbackWindow.map(candleLow))
    : Math.max(...pullbackWindow.map(candleHigh));
  const retestedEma = Math.abs(retestPrice - indicators.emaFast) <= tolerance * 2;
  const pullbackPercent = swingPrice > 0
    ? Math.abs(percent(retestPrice - swingPrice, swingPrice))
    : 0;
  const resumed = direction === "bullish"
    ? latest.v > previous.v
      && previous.v > beforePrevious.v
      && latest.v > (latest.o ?? previous.v)
      && latest.v > indicators.emaFast
    : latest.v < previous.v
      && previous.v < beforePrevious.v
      && latest.v < (latest.o ?? previous.v)
      && latest.v < indicators.emaFast;
  return hadCounterCandle && retestedEma && pullbackPercent >= 0.03 && resumed;
}

function emptyStructuredEvaluation(reasons: string[]): ScalpStructuredEntryEvaluation {
  return { qualified: false, direction: null, setupType: null, score: 0, tags: [], reasons };
}

function indicatorsAlign(indicators: IndicatorSnapshot, direction: Direction) {
  const bullish = direction === "bullish";
  return indicators.emaFast !== null
    && indicators.emaSlow !== null
    && (bullish ? indicators.emaFast > indicators.emaSlow : indicators.emaFast < indicators.emaSlow)
    && indicators.emaSlopePercent !== null
    && (bullish ? indicators.emaSlopePercent > 0 : indicators.emaSlopePercent < 0)
    && indicators.plusDi !== null
    && indicators.minusDi !== null
    && (bullish ? indicators.plusDi > indicators.minusDi : indicators.minusDi > indicators.plusDi)
    && indicators.macdLine !== null
    && indicators.macdSignal !== null
    && indicators.macdHistogram !== null
    && indicators.macdHistogramChange !== null
    && (bullish
      ? indicators.macdLine > indicators.macdSignal
        && indicators.macdHistogram > 0
        && indicators.macdHistogramChange > 0
      : indicators.macdLine < indicators.macdSignal
        && indicators.macdHistogram < 0
        && indicators.macdHistogramChange < 0);
}

export function evaluateScalpBreakoutRetest(options: {
  points: PricePoint[];
  indicators: IndicatorSnapshot;
  regime?: ScalpMarketRegime;
}): ScalpStructuredEntryEvaluation {
  const { points, indicators } = options;
  const regime = options.regime ?? classifyScalpMarketRegime(points);
  if (points.length < 36) return emptyStructuredEvaluation(["At least 36 completed candles are required to validate a breakout and retest."]);
  if (SCALP_EXHAUSTION_BLOCK_ENABLED && regime.exhausted) {
    return emptyStructuredEvaluation([`The 145-minute move or range exceeds the ${SCALP_MAX_145M_NET_OR_RANGE_PERCENT.toFixed(0)}% exhaustion limit.`]);
  }
  if (indicators.atrPercent === null || indicators.atrPercent < SCALP_BREAKOUT_RETEST_MIN_ATR_PERCENT) {
    return emptyStructuredEvaluation([`Breakout/retest ATR must reach ${SCALP_BREAKOUT_RETEST_MIN_ATR_PERCENT.toFixed(2)}% before live entry.`]);
  }
  const latestIndex = points.length - 1;
  for (const direction of ["bullish", "bearish"] as const) {
    if (regime.bias !== direction || !indicatorsAlign(indicators, direction)) continue;
    for (let breakoutIndex = latestIndex - 8; breakoutIndex <= latestIndex - 3; breakoutIndex += 1) {
      const reference = points.slice(Math.max(0, breakoutIndex - 20), breakoutIndex);
      if (reference.length < 16) continue;
      const level = direction === "bullish"
        ? Math.max(...reference.map(candleHigh))
        : Math.min(...reference.map(candleLow));
      const breakout = points[breakoutIndex]!;
      const breakoutDistance = level > 0 ? Math.abs(percent(breakout.v - level, level)) : 0;
      const brokeLevel = direction === "bullish"
        ? breakout.v > level && breakout.v > (breakout.o ?? level)
        : breakout.v < level && breakout.v < (breakout.o ?? level);
      if (!brokeLevel || breakoutDistance < 0.03) continue;
      const breakoutIndicators = computeIndicatorSnapshot(points.slice(0, breakoutIndex + 1));
      if (breakoutIndicators.volumeRatio === null || breakoutIndicators.volumeRatio < 1) continue;
      const retestTolerance = level * Math.max(0.0006, (indicators.atrPercent ?? 0.08) / 100 * 0.8);
      const retest = points.slice(breakoutIndex + 1, latestIndex).find((point) => direction === "bullish"
        ? candleLow(point) <= level + retestTolerance && point.v >= level - retestTolerance * 0.25
        : candleHigh(point) >= level - retestTolerance && point.v <= level + retestTolerance * 0.25);
      if (!retest) continue;
      const latest = points[latestIndex]!;
      const previous = points[latestIndex - 1]!;
      const resumed = direction === "bullish"
        ? latest.v > previous.v && latest.v > (latest.o ?? previous.v) && latest.v > level
        : latest.v < previous.v && latest.v < (latest.o ?? previous.v) && latest.v < level;
      if (!resumed) continue;
      const breakoutVolumeRatio = breakoutIndicators.volumeRatio;
      const atrQuality = clamp(
        (indicators.atrPercent - SCALP_BREAKOUT_RETEST_MIN_ATR_PERCENT) / 0.11,
        0,
        1
      );
      const distanceQuality = clamp((breakoutDistance - 0.03) / 0.15, 0, 1);
      const volumeQuality = clamp((breakoutVolumeRatio - 0.75) / 0.75, 0, 1);
      return {
        qualified: true,
        direction,
        setupType: "v-reversal",
        score: Number(clamp(
          SCALP_BREAKOUT_RETEST_MIN_PRICE_ACTION_SCORE
            + atrQuality * 0.08
            + distanceQuality * 0.04
            + volumeQuality * 0.02,
          SCALP_BREAKOUT_RETEST_MIN_PRICE_ACTION_SCORE,
          0.86
        ).toFixed(3)),
        tags: [
          "PRICE_BREAKOUT",
          "PRICE_BREAKOUT_RETEST",
          "PRICE_BREAKOUT_RESUMPTION",
          "INDICATORS_CONFIRMED_BREAKOUT_RETEST",
          "BREAKOUT_ATR_CONFIRMED",
        ],
        reasons: [],
      };
    }
  }
  return emptyStructuredEvaluation(["Waiting for a completed breakout, retest of the broken level, and directional resumption."]);
}

export function evaluateScalpRangeReversal(options: {
  points: PricePoint[];
  indicators: IndicatorSnapshot;
  profile: ScalpLearningProfile;
  regime?: ScalpMarketRegime;
}): ScalpStructuredEntryEvaluation {
  const { points, indicators, profile } = options;
  const regime = options.regime ?? classifyScalpMarketRegime(points);
  if (points.length < 45) return emptyStructuredEvaluation(["At least 45 completed candles are required to validate a range reversal sequence."]);
  if (regime.trending || (SCALP_EXHAUSTION_BLOCK_ENABLED && regime.exhausted)) {
    return emptyStructuredEvaluation([SCALP_EXHAUSTION_BLOCK_ENABLED && regime.exhausted
      ? `The 145-minute move or range exceeds the ${SCALP_MAX_145M_NET_OR_RANGE_PERCENT.toFixed(0)}% exhaustion limit.`
      : `Multi-horizon EMA, ATR, and DMI classify the market as ${regime.bias}, not range-bound.`]);
  }
  const latestIndex = points.length - 1;
  const latest = points[latestIndex]!;
  const previous = points[latestIndex - 1]!;
  for (const direction of ["bullish", "bearish"] as const) {
    for (let extremeIndex = Math.max(35, latestIndex - 12); extremeIndex <= latestIndex - 3; extremeIndex += 1) {
      const extremeIndicators = computeIndicatorSnapshot(points.slice(0, extremeIndex + 1));
      const extremeReached = extremeIndicators.bollingerPosition !== null
        && extremeIndicators.rsi !== null
        && (direction === "bullish"
          ? extremeIndicators.bollingerPosition <= profile.longBollingerMaximum
            && extremeIndicators.rsi <= profile.longRsiMaximum
          : extremeIndicators.bollingerPosition >= profile.shortBollingerMinimum
            && extremeIndicators.rsi >= profile.shortRsiMinimum);
      if (!extremeReached) continue;
      const reentry = Array.from(
        { length: latestIndex - extremeIndex - 1 },
        (_, offset) => extremeIndex + offset + 1,
      ).find((index) => {
        const snapshot = computeIndicatorSnapshot(points.slice(0, index + 1));
        return snapshot.bollingerPosition !== null && (direction === "bullish"
          ? snapshot.bollingerPosition > profile.longBollingerMaximum + 0.03
          : snapshot.bollingerPosition < profile.shortBollingerMinimum - 0.03);
      });
      if (reentry === undefined) continue;
      const rsiTurned = indicators.rsi !== null && extremeIndicators.rsi !== null && (direction === "bullish"
        ? indicators.rsi >= extremeIndicators.rsi + 3
        : indicators.rsi <= extremeIndicators.rsi - 3);
      const macdTurned = indicators.macdHistogram !== null
        && indicators.macdHistogramChange !== null
        && (direction === "bullish"
          ? indicators.macdHistogram > 0 && indicators.macdHistogramChange > 0
          : indicators.macdHistogram < 0 && indicators.macdHistogramChange < 0);
      const confirmingCandle = direction === "bullish"
        ? latest.v > previous.v && latest.v > (latest.o ?? previous.v)
        : latest.v < previous.v && latest.v < (latest.o ?? previous.v);
      const rangeIndicatorsReady = indicators.adx !== null
        && indicators.adx <= profile.maximumAdx
        && indicators.emaSpreadPercent !== null
        && Math.abs(indicators.emaSpreadPercent) <= profile.maximumEmaSpreadPercent
        && indicators.atrPercent !== null
        && indicators.atrPercent >= profile.minimumAtrPercent
        && indicators.bollingerBandwidthPercent !== null
        && indicators.bollingerBandwidthPercent >= profile.minimumBandwidthPercent
        && indicators.volumeRatio !== null
        && indicators.volumeRatio >= profile.minimumVolumeRatio;
      if (!rsiTurned || !macdTurned || !confirmingCandle || !rangeIndicatorsReady) continue;
      return {
        qualified: true,
        direction,
        setupType: "range-reversal",
        score: 1,
        tags: [
          "SCALP_RANGE",
          direction === "bullish" ? "SCALP_RANGE_LOW" : "SCALP_RANGE_HIGH",
          "RANGE_EXTREME_OBSERVED",
          "RANGE_BAND_REENTRY",
          "RANGE_RSI_MACD_TURN",
          "RANGE_CONFIRMING_CANDLE",
        ],
        reasons: [],
      };
    }
  }
  return emptyStructuredEvaluation(["Waiting for range extreme, band re-entry, RSI/MACD turn, and a confirming completed candle."]);
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

export type AdaptiveScalpSignalOptions = {
  symbol: string;
  points: PricePoint[];
  indicators: IndicatorSnapshot;
  profile: ScalpLearningProfile;
  recentClosedTrade?: RecentClosedScalpTrade | null;
};

export function evaluateAdaptiveScalpCandidate(options: AdaptiveScalpSignalOptions): ScalpCandidateEvaluation {
  const { points, indicators, profile } = options;
  const latest = points[points.length - 1];
  const regime = classifyScalpMarketRegime(points);
  if (!latest || points.length < 3) {
    return {
      signal: null,
      candidate: {
        path: "none",
        direction: null,
        score: 0,
        accepted: false,
        rejectionReasons: ["At least three completed candles are required to evaluate a scalp candidate."],
        tags: [],
        entryPrice: latest?.v ?? null,
        timestamp: latest?.t ?? null,
        regime,
      },
    };
  }

  const priceAction = analyzeScalpPriceAction(points, profile);
  const previousPriceAction = analyzeScalpPriceAction(points.slice(0, -1), profile);
  const trendBias = regime.bias;
  const breakoutRetest = evaluateScalpBreakoutRetest({ points, indicators, regime });
  const rangeReversal = evaluateScalpRangeReversal({ points, indicators, profile, regime });

  const exceptionalReversalCandidate = priceAction.direction !== null
    && priceAction.confirmed
    && priceAction.score >= SCALP_EXCEPTIONAL_REVERSAL_SCORE;
  const continuationEvaluation = evaluateScalpTrendContinuation({
    priceAction,
    previousPriceAction,
    points,
    trendBias,
    indicators,
    profile,
    regime,
  });
  const trendContinuation = continuationEvaluation.qualified;
  const reversalSafety = evaluateScalpReversalSafety({
    priceAction,
    previousPriceAction,
    indicators,
    profile,
  });
  const exceptionalReversal = SCALP_EXCEPTIONAL_REVERSAL_BYPASS_ENABLED
    && exceptionalReversalCandidate
    && (!SCALP_EXHAUSTION_BLOCK_ENABLED || !regime.exhausted)
    && reversalSafety.qualified;
  const reversalIndicatorsReady = priceAction.direction !== null
    && priceAction.confirmed
    && reversalSafety.qualified
    && (!SCALP_EXHAUSTION_BLOCK_ENABLED || !regime.exhausted)
    && indicators.adx !== null
    && indicators.adx <= SCALP_REVERSAL_MAX_ADX
    && indicators.emaSpreadPercent !== null
    && Math.abs(indicators.emaSpreadPercent) <= Math.min(1.5, profile.maximumEmaSpreadPercent + 0.55)
    && indicators.rsi !== null
    && (priceAction.direction === "bullish" ? indicators.rsi <= 62 : indicators.rsi >= 38);
  const strongReversal = !trendContinuation && priceAction.strong && reversalIndicatorsReady;
  const moderateReversal = !trendContinuation && !priceAction.strong && reversalIndicatorsReady;
  const direction = breakoutRetest.qualified
    ? breakoutRetest.direction
    : exceptionalReversal || trendContinuation || strongReversal || moderateReversal
      ? priceAction.direction
      : rangeReversal.qualified ? rangeReversal.direction : null;
  const inferredRangeDirection = indicators.bollingerPosition !== null
    ? indicators.bollingerPosition <= profile.longBollingerMaximum
      ? "bullish" as const
      : indicators.bollingerPosition >= profile.shortBollingerMinimum
        ? "bearish" as const
        : null
    : null;
  const diagnosticDirection = direction ?? priceAction.direction ?? inferredRangeDirection;
  const diagnosticPath: ScalpCandidatePath = breakoutRetest.qualified
    ? "breakout-retest"
    : trendContinuation
      ? "continuation"
      : exceptionalReversal || strongReversal || moderateReversal || priceAction.direction !== null
        ? regime.bias === priceAction.direction ? "continuation" : "reversal"
        : inferredRangeDirection !== null ? "range-reversal" : "none";
  const diagnosticScore = breakoutRetest.qualified
    ? breakoutRetest.score
    : rangeReversal.qualified
      ? rangeReversal.score
      : priceAction.score;
  const diagnosticTags = breakoutRetest.qualified
    ? breakoutRetest.tags
    : rangeReversal.qualified
      ? rangeReversal.tags
      : priceAction.tags;
  const reject = (rejectionReasons: string[]): ScalpCandidateEvaluation => ({
    signal: null,
    candidate: {
      path: diagnosticPath,
      direction: diagnosticDirection,
      score: diagnosticScore,
      accepted: false,
      rejectionReasons: [...new Set(rejectionReasons)].slice(0, 12),
      tags: diagnosticTags,
      entryPrice: latest.v,
      timestamp: latest.t,
      regime,
    },
  });
  if (!direction) {
    const rejectionReasons = diagnosticPath === "continuation"
      ? continuationEvaluation.reasons
      : diagnosticPath === "reversal"
        ? reversalSafety.reasons
        : diagnosticPath === "range-reversal"
          ? rangeReversal.reasons
          : [...breakoutRetest.reasons, ...rangeReversal.reasons];
    return reject(rejectionReasons.length > 0 ? rejectionReasons : ["No complete scalp entry path qualified."]);
  }
  const qualifiedPath: ScalpCandidatePath = breakoutRetest.qualified
    ? "breakout-retest"
    : trendContinuation
      ? "continuation"
      : rangeReversal.qualified
        ? "range-reversal"
        : "reversal";
  if (!scalpCandidatePathAllowsLiveSignal(qualifiedPath)) {
    return reject([
      `${qualifiedPath} is shadow-only until path-specific after-fee validation passes.`,
    ]);
  }
  if (profile.preferredDirection !== "balanced" && direction !== profile.preferredDirection) {
    return reject([`The learned profile currently permits ${profile.preferredDirection} entries only.`]);
  }

  const recentTrade = options.recentClosedTrade;
  if (
    recentTrade
    && recentTrade.closedAt >= recentTrade.openedAt
    && latest.t - recentTrade.closedAt < profile.cooldownSeconds * 1_000
  ) {
    return reject(["The qualifying setup remains inside the post-close scalp cooldown."]);
  }

  const structuredPriceAction = breakoutRetest.qualified
    || exceptionalReversal
    || trendContinuation
    || strongReversal
    || moderateReversal;
  const setupType = breakoutRetest.qualified
    ? breakoutRetest.setupType!
    : exceptionalReversal || trendContinuation || strongReversal || moderateReversal
      ? priceAction.setupType!
      : "range-reversal";
  const setupAdjustment = setupType === "range-reversal"
    ? profile.setupConfidenceAdjustments.rangeReversal
    : setupType === "liquidity-sweep"
      ? profile.setupConfidenceAdjustments.liquiditySweep
      : setupType === "v-reversal"
        ? profile.setupConfidenceAdjustments.vReversal
        : profile.setupConfidenceAdjustments.doubleReversal;
  const requiredConfidence = breakoutRetest.qualified
    ? SCALP_BREAKOUT_RETEST_MIN_PRICE_ACTION_SCORE
    : clamp(profile.minimumConfidence + setupAdjustment, 0.55, 0.9);
  const rawConfidence = breakoutRetest.qualified
    ? breakoutRetest.score
    : trendContinuation
      ? 0.72 + priceAction.score * 0.2
      : exceptionalReversal || strongReversal || moderateReversal
      ? 0.55 + priceAction.score * 0.35
      : SCALP_RANGE_REVERSAL_SIGNAL_CONFIDENCE;
  if (rawConfidence < requiredConfidence && !trendContinuation) {
    return reject([`Raw confidence ${rawConfidence.toFixed(3)} is below the required ${requiredConfidence.toFixed(3)}.`]);
  }
  const confidence = clamp(rawConfidence, 0, structuredPriceAction ? 0.9 : 0.82);
  const tags = breakoutRetest.qualified
    ? [...breakoutRetest.tags, "SCALP_EXHAUSTION_GUARD_PASSED"]
    : structuredPriceAction
      ? [
        ...priceAction.tags,
        exceptionalReversal
          ? "EXCEPTIONAL_CONFIRMED_PRICE_ACTION"
          : trendContinuation
            ? "INDICATORS_CONFIRMED_TREND_CONTINUATION"
            : strongReversal
              ? "INDICATORS_CONFIRMED_STRONG_PRICE_ACTION"
              : "INDICATORS_CONFIRMED_PRICE_ACTION",
        ...(trendContinuation
          ? [
              "CONTINUATION_TWO_CANDLE_CONFIRMATION",
              "CONTINUATION_PULLBACK_RETEST_RESUMPTION",
              "CONTINUATION_CONFIRMATION_CONSENSUS",
              ...continuationEvaluation.confirmationTags,
              ...(priceAction.score < SCALP_CONTINUATION_STANDARD_PRICE_ACTION_SCORE
                ? ["CONTINUATION_PROBATION"]
                : ["CONTINUATION_STANDARD"]),
            ]
          : ["REVERSAL_TWO_CANDLE_CONFIRMATION"]),
        "SCALP_EXHAUSTION_GUARD_PASSED",
      ]
      : [...rangeReversal.tags, "SCALP_EXHAUSTION_GUARD_PASSED"];

  const signal: ScalpSignal = {
    id: `${options.symbol}-scalp-${latest.t}`,
    symbol: options.symbol,
    type: "scalp",
    direction,
    confidence: Number(confidence.toFixed(3)),
    summary: setupType === "range-reversal"
      ? `${direction === "bullish" ? "Range-low" : "Range-high"} scalp setup confirmed after band re-entry and momentum turn.`
      : breakoutRetest.qualified
        ? `${direction === "bullish" ? "Bullish" : "Bearish"} breakout retest resumed with multi-horizon trend confirmation.`
        : trendContinuation
        ? `${direction === "bullish" ? "Bullish" : "Bearish"} momentum continuation confirmed by price action, trend, and volume.`
      : `${direction === "bullish" ? "Bullish" : "Bearish"} ${setupType.replace(/-/g, " ")} detected from real-time candle structure.`,
    timestamp: latest.t,
    setupType,
    priceActionScore: breakoutRetest.qualified
      ? breakoutRetest.score
      : setupType === "range-reversal" ? rangeReversal.score : priceAction.score,
    priceActionTags: tags,
    indicatorBypass: exceptionalReversal,
  };
  return {
    signal,
    candidate: {
      path: breakoutRetest.qualified
        ? "breakout-retest"
        : trendContinuation
          ? "continuation"
          : setupType === "range-reversal" ? "range-reversal" : "reversal",
      direction,
      score: signal.priceActionScore,
      accepted: true,
      rejectionReasons: [],
      tags,
      entryPrice: latest.v,
      timestamp: latest.t,
      regime,
    },
  };
}

export function detectAdaptiveScalpSignal(options: AdaptiveScalpSignalOptions): ScalpSignal | null {
  return evaluateAdaptiveScalpCandidate(options).signal;
}
