import type { ScalpLearningProfile, ScalpSetupType } from "@/lib/decision/learningTypes";
import {
  analyzeScalpPriceAction,
  classifyScalpMarketRegime,
  detectAdaptiveScalpSignal,
  evaluateScalpBreakoutRetest,
  evaluateScalpRangeReversal,
  evaluateScalpReversalSafety,
  evaluateScalpTrendContinuation,
  getScalpTrendBias,
  SCALP_CONTINUATION_MAX_ADX,
  SCALP_CONTINUATION_MAX_EMA_SPREAD_PERCENT,
  SCALP_CONTINUATION_LONG_BOLLINGER_MAXIMUM,
  SCALP_CONTINUATION_MIN_ADX,
  SCALP_CONTINUATION_MIN_ATR_PERCENT,
  SCALP_CONTINUATION_MIN_PRICE_ACTION_SCORE,
  SCALP_CONTINUATION_MIN_VOLUME_RATIO,
  SCALP_CONTINUATION_SHORT_BOLLINGER_MINIMUM,
  SCALP_EXCEPTIONAL_REVERSAL_BYPASS_ENABLED,
  SCALP_EXCEPTIONAL_REVERSAL_MAX_ADX,
  SCALP_EXCEPTIONAL_REVERSAL_SCORE,
  SCALP_EXHAUSTION_LOOKBACK_MINUTES,
  SCALP_MAX_145M_NET_OR_RANGE_PERCENT,
  SCALP_REVERSAL_MIN_VOLUME_RATIO,
  SCALP_REVERSAL_MAX_ADX,
  scalpProfileAllowsLiveEntries,
  type RecentClosedScalpTrade,
} from "@/lib/perps/scalpEngine";
import type { PricePoint } from "@/lib/price/simulated";
import {
  computeIndicatorSnapshot,
  type IndicatorSettings,
  type IndicatorSnapshot,
} from "@/lib/signal/indicators";

export type ScalpOverlayMarker = {
  time: number;
  price: number;
  direction: "bullish" | "bearish";
  setupType: ScalpSetupType;
  score: number;
  confidence: number;
  tags: string[];
};

export type ScalpMonitorHealth = {
  healthy: boolean;
  stale: boolean;
  lastRunAt: string | null;
  consecutiveFailureCount: number;
  code: string | null;
  message: string | null;
};

export type ScalpAgentOverlaySnapshot = {
  generatedAt: string;
  timeframe: "1";
  state: "ready" | "blocked" | "watching" | "disabled";
  headline: string;
  detail: string;
  reasons: string[];
  trendBias: "bullish" | "bearish" | "sideways";
  setupType: ScalpSetupType | null;
  direction: "bullish" | "bearish" | null;
  score: number;
  confidence: number | null;
  tags: string[];
  profilePassed: boolean;
  scalpModeEnabled: boolean;
  isActiveAsset: boolean;
  monitorHealth: ScalpMonitorHealth | null;
  indicators: IndicatorSnapshot;
  thresholds: {
    minimumConfidence: number;
    minimumPriceActionScore: number;
    maximumAdx: number;
    maximumReversalAdx: number;
    exceptionalReversalBypassEnabled: boolean;
    maximumExceptionalReversalAdx: number;
    minimumReversalVolumeRatio: number;
    minimumContinuationAdx: number;
    maximumContinuationAdx: number;
    minimumContinuationPriceActionScore: number;
    maximumContinuationEmaSpreadPercent: number;
    minimumContinuationAtrPercent: number;
    minimumContinuationVolumeRatio: number;
    continuationLongBollingerMaximum: number;
    continuationShortBollingerMinimum: number;
    maximum145mNetOrRangePercent: number;
    maximumEmaSpreadPercent: number;
    minimumAtrPercent: number;
    minimumBandwidthPercent: number;
    minimumVolumeRatio: number;
    longRsiMaximum: number;
    shortRsiMinimum: number;
    longBollingerMaximum: number;
    shortBollingerMinimum: number;
  };
  markers: ScalpOverlayMarker[];
};

function finite(value: number | null) {
  return value != null && Number.isFinite(value);
}

function round(value: number | null, digits = 3) {
  return finite(value) ? Number(value!.toFixed(digits)) : null;
}

function currentRejectionReasons(
  points: PricePoint[],
  indicators: IndicatorSnapshot,
  profile: ScalpLearningProfile
) {
  const priceAction = analyzeScalpPriceAction(points, profile);
  const previousPriceAction = analyzeScalpPriceAction(points.slice(0, -1), profile);
  const regime = classifyScalpMarketRegime(points);
  const trendBias = regime.bias;
  const reasons: string[] = [];

  if (priceAction.score < profile.minimumPriceActionScore) {
    reasons.push(`Price-action score ${priceAction.score.toFixed(2)} is below ${profile.minimumPriceActionScore.toFixed(2)}.`);
  } else if (!priceAction.confirmed) {
    reasons.push("The candle-structure reversal has not confirmed its momentum/reclaim yet.");
  } else if (priceAction.direction !== null) {
    const continuation = evaluateScalpTrendContinuation({
      priceAction,
      previousPriceAction,
      points,
      trendBias,
      indicators,
      profile,
      regime,
    });
    if (!continuation.qualified) {
      const exceptionalCandidate = priceAction.score >= SCALP_EXCEPTIONAL_REVERSAL_SCORE;
      if (exceptionalCandidate && !SCALP_EXCEPTIONAL_REVERSAL_BYPASS_ENABLED) {
        reasons.push("Exceptional reversal execution is paused; the setup remains visible for diagnostics only.");
      }
      if (exceptionalCandidate) {
        const safety = evaluateScalpReversalSafety({
          priceAction,
          previousPriceAction,
          indicators,
          profile,
        });
        reasons.push(...safety.reasons.slice(0, 2));
      } else {
        reasons.push(...continuation.reasons.slice(0, 2));
      }
    }
  }
  const breakout = evaluateScalpBreakoutRetest({ points, indicators, regime });
  const range = evaluateScalpRangeReversal({ points, indicators, profile, regime });
  if (!breakout.qualified) reasons.push(...breakout.reasons.slice(0, 1));
  if (!range.qualified) reasons.push(...range.reasons.slice(0, 1));
  return reasons.slice(0, 4);
}

function historicalMarkers(
  symbol: string,
  points: PricePoint[],
  profile: ScalpLearningProfile,
  settings: IndicatorSettings
) {
  const markers: ScalpOverlayMarker[] = [];
  // Historical markers must use the same complete 145-minute regime context as
  // the live monitor. Starting earlier can manufacture an apparently eligible
  // marker from a truncated window that live routing correctly evaluates with
  // more history.
  const start = Math.max(SCALP_EXHAUSTION_LOOKBACK_MINUTES - 1, points.length - 120);
  for (let index = start; index < points.length; index += 1) {
    const window = points.slice(0, index + 1);
    const indicators = computeIndicatorSnapshot(window, settings);
    const signal = detectAdaptiveScalpSignal({
      symbol,
      points: window,
      indicators,
      profile,
    });
    if (!signal) continue;
    const latest = window[window.length - 1]!;
    markers.push({
      time: Math.floor(latest.t / 1_000),
      price: latest.v,
      direction: signal.direction,
      setupType: signal.setupType,
      score: signal.priceActionScore,
      confidence: signal.confidence,
      tags: signal.priceActionTags,
    });
  }
  return markers.slice(-20);
}

export function buildScalpAgentOverlaySnapshot(input: {
  symbol: string;
  points: PricePoint[];
  profile: ScalpLearningProfile;
  indicatorSettings: IndicatorSettings;
  scalpModeEnabled: boolean;
  isActiveAsset: boolean;
  monitorHealth?: ScalpMonitorHealth | null;
  recentClosedTrade?: RecentClosedScalpTrade | null;
  now?: Date;
}): ScalpAgentOverlaySnapshot {
  const indicators = computeIndicatorSnapshot(input.points, input.indicatorSettings);
  const priceAction = analyzeScalpPriceAction(input.points, input.profile);
  const rawSignal = detectAdaptiveScalpSignal({
    symbol: input.symbol,
    points: input.points,
    indicators,
    profile: input.profile,
  });
  const liveSignal = detectAdaptiveScalpSignal({
    symbol: input.symbol,
    points: input.points,
    indicators,
    profile: input.profile,
    recentClosedTrade: input.recentClosedTrade,
  });
  const profilePassed = scalpProfileAllowsLiveEntries(input.profile);
  const reasons: string[] = [];
  let state: ScalpAgentOverlaySnapshot["state"] = "watching";
  let headline = "Watching for a scalp setup";

  if (!input.scalpModeEnabled) {
    state = "disabled";
    headline = "Scalp Mode is off";
    reasons.push("Enable Scalp Mode to allow qualifying candidates to route.");
  } else if (!input.isActiveAsset) {
    state = "blocked";
    headline = "Chart is not the active scalp asset";
    reasons.push("Select the configured Perps asset to mirror the live scalp decision.");
  } else if (input.monitorHealth?.healthy === false) {
    state = "blocked";
    headline = input.monitorHealth.consecutiveFailureCount >= 2
      ? `Scalp monitor blocked for ${input.monitorHealth.consecutiveFailureCount} cycles`
      : "Scalp monitor is blocked";
    reasons.push(
      input.monitorHealth.message
      ?? (input.monitorHealth.stale
        ? "The autonomous monitor heartbeat is stale; no new entry can be submitted."
        : "The autonomous monitor failed its latest safety check.")
    );
  } else if (!profilePassed) {
    state = "blocked";
    headline = "Scalp profile validation paused";
    reasons.push(input.profile.validation.reasons[0] ?? "The learned profile has not passed loss-history validation.");
  } else if (liveSignal) {
    state = "ready";
    headline = `${liveSignal.direction === "bullish" ? "Bullish" : "Bearish"} ${liveSignal.setupType.replace(/-/g, " ")} ready`;
  } else if (rawSignal && input.recentClosedTrade) {
    state = "blocked";
    headline = "Qualifying setup is in cooldown";
    const secondsRemaining = Math.max(
      0,
      input.profile.cooldownSeconds - Math.floor(
        ((input.now ?? new Date()).getTime() - input.recentClosedTrade.closedAt) / 1_000
      ),
    );
    reasons.push(`${Math.ceil(secondsRemaining / 60)} minute${Math.ceil(secondsRemaining / 60) === 1 ? "" : "s"} remain in the learned cooldown.`);
  } else {
    reasons.push(...currentRejectionReasons(input.points, indicators, input.profile));
    if (reasons.length === 0) {
      reasons.push("Waiting for the next qualifying 1-minute setup.");
    }
  }

  const signal = liveSignal ?? rawSignal;
  const detail = signal
    ? `Score ${signal.priceActionScore.toFixed(2)} · Confidence ${(signal.confidence * 100).toFixed(0)}%${state === "ready" ? " · eligible" : " · blocked"}`
    : `Price action ${priceAction.score.toFixed(2)} · ${getScalpTrendBias(input.points)} market`;

  return {
    generatedAt: (input.now ?? new Date()).toISOString(),
    timeframe: "1",
    state,
    headline,
    detail,
    reasons,
    trendBias: getScalpTrendBias(input.points),
    setupType: signal?.setupType ?? priceAction.setupType,
    direction: signal?.direction ?? priceAction.direction,
    score: signal?.priceActionScore ?? priceAction.score,
    confidence: signal?.confidence ?? null,
    tags: signal?.priceActionTags ?? priceAction.tags,
    profilePassed,
    scalpModeEnabled: input.scalpModeEnabled,
    isActiveAsset: input.isActiveAsset,
    monitorHealth: input.monitorHealth ?? null,
    indicators: {
      ...indicators,
      emaFast: round(indicators.emaFast),
      emaSlow: round(indicators.emaSlow),
      emaSpreadPercent: round(indicators.emaSpreadPercent),
      emaSlopePercent: round(indicators.emaSlopePercent),
      rsi: round(indicators.rsi, 2),
      macdLine: round(indicators.macdLine),
      macdSignal: round(indicators.macdSignal),
      macdHistogram: round(indicators.macdHistogram),
      macdHistogramChange: round(indicators.macdHistogramChange),
      adx: round(indicators.adx, 2),
      plusDi: round(indicators.plusDi, 2),
      minusDi: round(indicators.minusDi, 2),
      atrPercent: round(indicators.atrPercent),
      volumeRatio: round(indicators.volumeRatio),
      bollingerBandwidthPercent: round(indicators.bollingerBandwidthPercent),
      bollingerPosition: round(indicators.bollingerPosition),
    },
    thresholds: {
      minimumConfidence: input.profile.minimumConfidence,
      minimumPriceActionScore: input.profile.minimumPriceActionScore,
      maximumAdx: input.profile.maximumAdx,
      maximumReversalAdx: SCALP_REVERSAL_MAX_ADX,
      exceptionalReversalBypassEnabled: SCALP_EXCEPTIONAL_REVERSAL_BYPASS_ENABLED,
      maximumExceptionalReversalAdx: SCALP_EXCEPTIONAL_REVERSAL_MAX_ADX,
      minimumReversalVolumeRatio: SCALP_REVERSAL_MIN_VOLUME_RATIO,
      minimumContinuationAdx: SCALP_CONTINUATION_MIN_ADX,
      maximumContinuationAdx: SCALP_CONTINUATION_MAX_ADX,
      minimumContinuationPriceActionScore: SCALP_CONTINUATION_MIN_PRICE_ACTION_SCORE,
      maximumContinuationEmaSpreadPercent: SCALP_CONTINUATION_MAX_EMA_SPREAD_PERCENT,
      minimumContinuationAtrPercent: SCALP_CONTINUATION_MIN_ATR_PERCENT,
      minimumContinuationVolumeRatio: SCALP_CONTINUATION_MIN_VOLUME_RATIO,
      continuationLongBollingerMaximum: SCALP_CONTINUATION_LONG_BOLLINGER_MAXIMUM,
      continuationShortBollingerMinimum: SCALP_CONTINUATION_SHORT_BOLLINGER_MINIMUM,
      maximum145mNetOrRangePercent: SCALP_MAX_145M_NET_OR_RANGE_PERCENT,
      maximumEmaSpreadPercent: input.profile.maximumEmaSpreadPercent,
      minimumAtrPercent: input.profile.minimumAtrPercent,
      minimumBandwidthPercent: input.profile.minimumBandwidthPercent,
      minimumVolumeRatio: input.profile.minimumVolumeRatio,
      longRsiMaximum: input.profile.longRsiMaximum,
      shortRsiMinimum: input.profile.shortRsiMinimum,
      longBollingerMaximum: input.profile.longBollingerMaximum,
      shortBollingerMinimum: input.profile.shortBollingerMinimum,
    },
    markers: historicalMarkers(input.symbol, input.points, input.profile, input.indicatorSettings),
  };
}
