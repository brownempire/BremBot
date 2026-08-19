import type { ScalpLearningProfile, ScalpSetupType } from "@/lib/decision/learningTypes";
import {
  analyzeScalpPriceAction,
  detectAdaptiveScalpSignal,
  evaluateScalpTrendContinuation,
  getScalpTrendBias,
  SCALP_CONTINUATION_MAX_ADX,
  SCALP_CONTINUATION_MAX_EMA_SPREAD_PERCENT,
  SCALP_CONTINUATION_MIN_ADX,
  SCALP_CONTINUATION_MIN_ATR_PERCENT,
  SCALP_CONTINUATION_MIN_VOLUME_RATIO,
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
  indicators: IndicatorSnapshot;
  thresholds: {
    minimumConfidence: number;
    minimumPriceActionScore: number;
    maximumAdx: number;
    maximumReversalAdx: number;
    minimumContinuationAdx: number;
    maximumContinuationAdx: number;
    maximumContinuationEmaSpreadPercent: number;
    minimumContinuationAtrPercent: number;
    minimumContinuationVolumeRatio: number;
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
  const trendBias = getScalpTrendBias(points);
  const reasons: string[] = [];

  if (priceAction.score < profile.minimumPriceActionScore) {
    reasons.push(`Price-action score ${priceAction.score.toFixed(2)} is below ${profile.minimumPriceActionScore.toFixed(2)}.`);
  } else if (!priceAction.confirmed) {
    reasons.push("The candle-structure reversal has not confirmed its momentum/reclaim yet.");
  } else if (priceAction.direction !== null) {
    const continuation = evaluateScalpTrendContinuation({
      priceAction,
      trendBias,
      indicators,
      profile,
    });
    if (!continuation.qualified) reasons.push(...continuation.reasons.slice(0, 2));
  }

  const rangeRsiReady = indicators.rsi != null
    && (indicators.rsi <= profile.longRsiMaximum || indicators.rsi >= profile.shortRsiMinimum);
  const rangeBandReady = indicators.bollingerPosition != null
    && (indicators.bollingerPosition <= profile.longBollingerMaximum
      || indicators.bollingerPosition >= profile.shortBollingerMinimum);
  if (trendBias !== "sideways" && priceAction.direction === null) {
    reasons.push(`Range entry is waiting for a sideways trend; current bias is ${trendBias}.`);
  }
  if (!rangeRsiReady && indicators.rsi != null) {
    reasons.push(`RSI ${indicators.rsi.toFixed(1)} is outside the learned range-entry zones.`);
  }
  if (!rangeBandReady && indicators.bollingerPosition != null) {
    reasons.push(`Bollinger position ${indicators.bollingerPosition.toFixed(2)} is not at a learned range edge.`);
  }
  if (indicators.adx != null && indicators.adx > profile.maximumAdx) {
    reasons.push(`ADX ${indicators.adx.toFixed(1)} exceeds the range limit ${profile.maximumAdx.toFixed(1)}.`);
  }
  if (indicators.emaSpreadPercent != null
    && Math.abs(indicators.emaSpreadPercent) > profile.maximumEmaSpreadPercent) {
    reasons.push(`EMA spread ${Math.abs(indicators.emaSpreadPercent).toFixed(2)}% exceeds ${profile.maximumEmaSpreadPercent.toFixed(2)}%.`);
  }
  if (indicators.atrPercent != null && indicators.atrPercent < profile.minimumAtrPercent) {
    reasons.push(`ATR ${indicators.atrPercent.toFixed(2)}% is below ${profile.minimumAtrPercent.toFixed(2)}%.`);
  }
  if (indicators.bollingerBandwidthPercent != null
    && indicators.bollingerBandwidthPercent < profile.minimumBandwidthPercent) {
    reasons.push(`Band width ${indicators.bollingerBandwidthPercent.toFixed(2)}% is below ${profile.minimumBandwidthPercent.toFixed(2)}%.`);
  }
  if (indicators.volumeRatio != null && indicators.volumeRatio < profile.minimumVolumeRatio) {
    reasons.push(`Volume ratio ${indicators.volumeRatio.toFixed(2)}× is below ${profile.minimumVolumeRatio.toFixed(2)}×.`);
  }
  return reasons.slice(0, 4);
}

function historicalMarkers(
  symbol: string,
  points: PricePoint[],
  profile: ScalpLearningProfile,
  settings: IndicatorSettings
) {
  const markers: ScalpOverlayMarker[] = [];
  let lastCandidateAt = 0;
  const start = Math.max(24, points.length - 120);
  for (let index = start; index < points.length; index += 1) {
    const window = points.slice(0, index + 1);
    const indicators = computeIndicatorSnapshot(window, settings);
    const signal = detectAdaptiveScalpSignal({
      symbol,
      points: window,
      indicators,
      profile,
      lastSignalAt: lastCandidateAt || null,
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
    lastCandidateAt = signal.timestamp;
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
  lastSignalAt?: number | null;
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
    lastSignalAt: input.lastSignalAt,
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
  } else if (!profilePassed) {
    state = "blocked";
    headline = "Scalp profile validation paused";
    reasons.push(input.profile.validation.reasons[0] ?? "The learned profile has not passed loss-history validation.");
  } else if (liveSignal) {
    state = "ready";
    headline = `${liveSignal.direction === "bullish" ? "Bullish" : "Bearish"} ${liveSignal.setupType.replace(/-/g, " ")} ready`;
  } else if (rawSignal && input.lastSignalAt) {
    state = "blocked";
    headline = "Qualifying setup is in cooldown";
    const secondsRemaining = Math.max(
      0,
      input.profile.cooldownSeconds - Math.floor(((input.now ?? new Date()).getTime() - input.lastSignalAt) / 1_000),
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
      minimumContinuationAdx: SCALP_CONTINUATION_MIN_ADX,
      maximumContinuationAdx: SCALP_CONTINUATION_MAX_ADX,
      maximumContinuationEmaSpreadPercent: SCALP_CONTINUATION_MAX_EMA_SPREAD_PERCENT,
      minimumContinuationAtrPercent: SCALP_CONTINUATION_MIN_ATR_PERCENT,
      minimumContinuationVolumeRatio: SCALP_CONTINUATION_MIN_VOLUME_RATIO,
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
