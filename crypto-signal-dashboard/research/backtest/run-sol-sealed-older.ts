import fs from "node:fs";
import path from "node:path";

import {
  BASELINE_COST_MODEL,
  getIndicatorSettings,
  loadCandles,
  prepareIndicators,
  runBacktest,
  type BacktestResult,
  type Candle,
  type CostModel,
  type FrozenControl,
  type StrategyVariant,
} from "./model";

type Candidate = {
  name: string;
  trendWindow: number;
  trendThreshold: number;
  breakoutPercent: number;
  cooldownSeconds: number;
  takeProfitRoePercent: number;
  stopLossRoePercent: number;
  dynamicLeverage: NonNullable<StrategyVariant["dynamicLeverage"]>;
  minimumConfidence?: number;
  targetWalletRiskPercent?: number;
  maximumAllocationPercent?: number;
  directionMode?: "all" | "buy-only";
  ema15Filter?: "alignment" | "fresh-cross";
  ema15ShortOnly?: boolean;
  ema15MaximumCrossAgeBars?: number;
  ema15MinimumScoreOverride?: number;
  entryLockedAtrExit?: StrategyVariant["entryLockedAtrExit"];
  enforceTargetRiskAtStop?: boolean;
};

const candidates: Candidate[] = [
  {
    name: "145-minute-hybrid",
    trendWindow: 145,
    trendThreshold: 1.65,
    breakoutPercent: 0.35,
    cooldownSeconds: 27_000,
    takeProfitRoePercent: 10,
    stopLossRoePercent: 10,
    dynamicLeverage: { minimum: 2, maximum: 4, qualityExponent: 2.5, volatilityPenalty: 1.25, lossStepdown: 1 },
  },
  {
    name: "135-minute-parent",
    trendWindow: 135,
    trendThreshold: 1.5,
    breakoutPercent: 0.25,
    cooldownSeconds: 28_800,
    takeProfitRoePercent: 10,
    stopLossRoePercent: 7,
    dynamicLeverage: { minimum: 1.5, maximum: 4, qualityExponent: 2, volatilityPenalty: 1, lossStepdown: 0.85 },
  },
  {
    name: "155-minute-parent",
    trendWindow: 155,
    trendThreshold: 2,
    breakoutPercent: 0.35,
    cooldownSeconds: 25_200,
    takeProfitRoePercent: 15,
    stopLossRoePercent: 15,
    dynamicLeverage: { minimum: 2, maximum: 5, qualityExponent: 2.5, volatilityPenalty: 1.25, lossStepdown: 0.85 },
  },
];

if (process.env.INCLUDE_BASE_SYNTHESIS === "1") {
  candidates.push(
    {
      name: "145-base-1x-2x",
      trendWindow: 145,
      trendThreshold: 1.65,
      breakoutPercent: 0.35,
      cooldownSeconds: 27_000,
      takeProfitRoePercent: 10,
      stopLossRoePercent: 10,
      dynamicLeverage: { minimum: 1, maximum: 2, qualityExponent: 2.5, volatilityPenalty: 1.25, lossStepdown: 0.7 },
    },
    {
      name: "145-base-1x-2.5x",
      trendWindow: 145,
      trendThreshold: 1.65,
      breakoutPercent: 0.35,
      cooldownSeconds: 27_000,
      takeProfitRoePercent: 10,
      stopLossRoePercent: 10,
      dynamicLeverage: { minimum: 1, maximum: 2.5, qualityExponent: 2.5, volatilityPenalty: 1.25, lossStepdown: 0.7 },
    },
    {
      name: "145-base-1.5x-3x",
      trendWindow: 145,
      trendThreshold: 1.65,
      breakoutPercent: 0.35,
      cooldownSeconds: 27_000,
      takeProfitRoePercent: 10,
      stopLossRoePercent: 10,
      dynamicLeverage: { minimum: 1.5, maximum: 3, qualityExponent: 2.5, volatilityPenalty: 1.25, lossStepdown: 0.7 },
    },
    ...[0.65, 0.68, 0.72].map((minimumConfidence): Candidate => ({
      name: `145-selective-${minimumConfidence}`,
      trendWindow: 145,
      trendThreshold: 1.65,
      breakoutPercent: 0.35,
      cooldownSeconds: 27_000,
      takeProfitRoePercent: 10,
      stopLossRoePercent: 10,
      dynamicLeverage: { minimum: 2, maximum: 4, qualityExponent: 2.5, volatilityPenalty: 1.25, lossStepdown: 0.7 },
      minimumConfidence,
    })),
    ...[0.75, 1, 1.6, 2].map((targetWalletRiskPercent): Candidate => ({
      name: `145-risk-${targetWalletRiskPercent}`,
      trendWindow: 145,
      trendThreshold: 1.65,
      breakoutPercent: 0.35,
      cooldownSeconds: 27_000,
      takeProfitRoePercent: 10,
      stopLossRoePercent: 10,
      dynamicLeverage: { minimum: 2, maximum: 4, qualityExponent: 2.5, volatilityPenalty: 1.25, lossStepdown: 1 },
      targetWalletRiskPercent,
    })),
    ...[1, 1.6, 2].map((targetWalletRiskPercent): Candidate => ({
      name: `145-selective-0.68-risk-${targetWalletRiskPercent}`,
      trendWindow: 145,
      trendThreshold: 1.65,
      breakoutPercent: 0.35,
      cooldownSeconds: 27_000,
      takeProfitRoePercent: 10,
      stopLossRoePercent: 10,
      dynamicLeverage: { minimum: 2, maximum: 4, qualityExponent: 2.5, volatilityPenalty: 1.25, lossStepdown: 1 },
      minimumConfidence: 0.68,
      targetWalletRiskPercent,
    })),
    ...[35, 50, 65, 80].map((maximumAllocationPercent): Candidate => ({
      name: `145-allocation-${maximumAllocationPercent}`,
      trendWindow: 145,
      trendThreshold: 1.65,
      breakoutPercent: 0.35,
      cooldownSeconds: 27_000,
      takeProfitRoePercent: 10,
      stopLossRoePercent: 10,
      dynamicLeverage: { minimum: 2, maximum: 4, qualityExponent: 2.5, volatilityPenalty: 1.25, lossStepdown: 1 },
      minimumConfidence: 0.68,
      targetWalletRiskPercent: 1.6,
      maximumAllocationPercent,
    })),
    ...[14_400, 18_000, 21_600, 23_400, 25_200, 25_560, 25_740, 25_920, 26_100, 26_280, 26_460, 26_640, 26_820].map((cooldownSeconds): Candidate => ({
      name: `145-risk-1.6-cooldown-${cooldownSeconds}`,
      trendWindow: 145,
      trendThreshold: 1.65,
      breakoutPercent: 0.35,
      cooldownSeconds,
      takeProfitRoePercent: 10,
      stopLossRoePercent: 10,
      dynamicLeverage: { minimum: 2, maximum: 4, qualityExponent: 2.5, volatilityPenalty: 1.25, lossStepdown: 1 },
      minimumConfidence: 0.68,
      targetWalletRiskPercent: 1.6,
      maximumAllocationPercent: 35,
    })),
    ...[14_400, 18_000, 21_600, 25_920].map((cooldownSeconds): Candidate => ({
      name: `145-risk-2-cooldown-${cooldownSeconds}`,
      trendWindow: 145,
      trendThreshold: 1.65,
      breakoutPercent: 0.35,
      cooldownSeconds,
      takeProfitRoePercent: 10,
      stopLossRoePercent: 10,
      dynamicLeverage: { minimum: 2, maximum: 4, qualityExponent: 2.5, volatilityPenalty: 1.25, lossStepdown: 1 },
      minimumConfidence: 0.68,
      targetWalletRiskPercent: 2,
      maximumAllocationPercent: 45,
    })),
    ...[3, 4, 5].map((targetWalletRiskPercent): Candidate => ({
      name: `145-risk-${targetWalletRiskPercent}-cooldown-25920`,
      trendWindow: 145,
      trendThreshold: 1.65,
      breakoutPercent: 0.35,
      cooldownSeconds: 25_920,
      takeProfitRoePercent: 10,
      stopLossRoePercent: 10,
      dynamicLeverage: { minimum: 2, maximum: 4, qualityExponent: 2.5, volatilityPenalty: 1.25, lossStepdown: 1 },
      minimumConfidence: 0.68,
      targetWalletRiskPercent,
      maximumAllocationPercent: 80,
    })),
    ...[3, 4].map((targetWalletRiskPercent): Candidate => ({
      name: `145-risk-${targetWalletRiskPercent}`,
      trendWindow: 145,
      trendThreshold: 1.65,
      breakoutPercent: 0.35,
      cooldownSeconds: 27_000,
      takeProfitRoePercent: 10,
      stopLossRoePercent: 10,
      dynamicLeverage: { minimum: 2, maximum: 4, qualityExponent: 2.5, volatilityPenalty: 1.25, lossStepdown: 1 },
      minimumConfidence: 0.68,
      targetWalletRiskPercent,
      maximumAllocationPercent: 80,
    })),
  );
}

if (process.env.INCLUDE_TV_CHALLENGERS === "1") {
  const common = {
    trendWindow: 145,
    trendThreshold: 1.65,
    breakoutPercent: 0.35,
    cooldownSeconds: 27_000,
    takeProfitRoePercent: 10,
    stopLossRoePercent: 10,
    dynamicLeverage: { minimum: 2, maximum: 4, qualityExponent: 2.5, volatilityPenalty: 1.25, lossStepdown: 1 },
    minimumConfidence: 0.68,
    targetWalletRiskPercent: 3,
    maximumAllocationPercent: 80,
  } satisfies Omit<Candidate, "name">;
  candidates.push(
    { name: "tv-control-risk3", ...common },
    { name: "tv-ema20-50-align", ...common, ema15Filter: "alignment" },
    { name: "tv-ema20-50-cross-4h", ...common, ema15Filter: "fresh-cross", ema15MaximumCrossAgeBars: 16 },
    { name: "tv-ema20-50-cross-8h", ...common, ema15Filter: "fresh-cross", ema15MaximumCrossAgeBars: 32 },
    { name: "tv-long-only", ...common, directionMode: "buy-only" },
    { name: "tv-short-ema20-50-align", ...common, ema15Filter: "alignment", ema15ShortOnly: true },
    {
      name: "tv-short-ema-align-score6-override",
      ...common,
      ema15Filter: "alignment",
      ema15ShortOnly: true,
      ema15MinimumScoreOverride: 6,
    },
    {
      name: "tv-short-ema-align-score6.5-override",
      ...common,
      ema15Filter: "alignment",
      ema15ShortOnly: true,
      ema15MinimumScoreOverride: 6.5,
    },
    {
      name: "tv-short-ema-align-score7-override",
      ...common,
      ema15Filter: "alignment",
      ema15ShortOnly: true,
      ema15MinimumScoreOverride: 7,
    },
    {
      name: "tv-ema-align-score7-override",
      ...common,
      ema15Filter: "alignment",
      ema15MinimumScoreOverride: 7,
    },
    { name: "tv-atr-1.5-3", ...common, entryLockedAtrExit: { stopMultiplier: 1.5, takeProfitMultiplier: 3 } },
    { name: "tv-atr-2-3", ...common, entryLockedAtrExit: { stopMultiplier: 2, takeProfitMultiplier: 3 } },
    { name: "tv-atr-1.5-2.5", ...common, entryLockedAtrExit: { stopMultiplier: 1.5, takeProfitMultiplier: 2.5 } },
    {
      name: "tv-atr-bounded-7-15-10-20",
      ...common,
      entryLockedAtrExit: {
        stopMultiplier: 1.5,
        takeProfitMultiplier: 3,
        minimumStopRoePercent: 7,
        maximumStopRoePercent: 15,
        minimumTakeProfitRoePercent: 10,
        maximumTakeProfitRoePercent: 20,
      },
    },
    {
      name: "tv-atr-floor-10",
      ...common,
      entryLockedAtrExit: {
        stopMultiplier: 1.5,
        takeProfitMultiplier: 3,
        minimumStopRoePercent: 10,
        maximumStopRoePercent: 15,
        minimumTakeProfitRoePercent: 10,
        maximumTakeProfitRoePercent: 25,
      },
    },
    {
      name: "tv-atr-1.5-3-exact-risk",
      ...common,
      entryLockedAtrExit: { stopMultiplier: 1.5, takeProfitMultiplier: 3 },
      enforceTargetRiskAtStop: true,
    },
    {
      name: "tv-ema-align-atr-1.5-3",
      ...common,
      ema15Filter: "alignment",
      entryLockedAtrExit: { stopMultiplier: 1.5, takeProfitMultiplier: 3 },
    },
    {
      name: "tv-ema-cross-8h-atr-1.5-3",
      ...common,
      ema15Filter: "fresh-cross",
      ema15MaximumCrossAgeBars: 32,
      entryLockedAtrExit: { stopMultiplier: 1.5, takeProfitMultiplier: 3 },
    },
    {
      name: "tv-short-align-atr-1.5-3",
      ...common,
      ema15Filter: "alignment",
      ema15ShortOnly: true,
      entryLockedAtrExit: { stopMultiplier: 1.5, takeProfitMultiplier: 3 },
    },
  );
}

const olderPeriods = [
  { name: "2021-launch-bull", start: "2021-06-18T00:00:00Z", end: "2022-01-01T00:00:00Z" },
  { name: "2022-h1", start: "2022-01-01T00:00:00Z", end: "2022-07-01T00:00:00Z" },
  { name: "2022-h2", start: "2022-07-01T00:00:00Z", end: "2023-01-01T00:00:00Z" },
  { name: "2023-h1", start: "2023-01-01T00:00:00Z", end: "2023-07-01T00:00:00Z" },
  { name: "2023-h2", start: "2023-07-01T00:00:00Z", end: "2024-01-01T00:00:00Z" },
  { name: "2024-h1", start: "2024-01-01T00:00:00Z", end: "2024-07-01T00:00:00Z" },
  { name: "2024-h2", start: "2024-07-01T00:00:00Z", end: "2025-01-01T00:00:00Z" },
].map((period) => ({ ...period, startMs: Date.parse(period.start), endMs: Date.parse(period.end) }));

const evaluationPeriod = process.env.EVALUATION_PERIOD ?? "older";
const periods = evaluationPeriod === "recent-18.5m"
  ? [
      { name: "2025-q1", start: "2025-01-01T00:00:00Z", end: "2025-04-01T00:00:00Z" },
      { name: "2025-q2", start: "2025-04-01T00:00:00Z", end: "2025-07-01T00:00:00Z" },
      { name: "2025-q3", start: "2025-07-01T00:00:00Z", end: "2025-10-01T00:00:00Z" },
      { name: "2025-q4", start: "2025-10-01T00:00:00Z", end: "2026-01-01T00:00:00Z" },
      { name: "2026-q1", start: "2026-01-01T00:00:00Z", end: "2026-04-01T00:00:00Z" },
      { name: "2026-q2", start: "2026-04-01T00:00:00Z", end: "2026-07-01T00:00:00Z" },
      { name: "2026-july-partial", start: "2026-07-01T00:00:00Z", end: "2026-07-20T00:00:00Z" },
    ].map((period) => ({ ...period, startMs: Date.parse(period.start), endMs: Date.parse(period.end) }))
  : evaluationPeriod === "recent-12m"
    ? [
        { name: "2025-q3-partial", start: "2025-07-20T00:00:00Z", end: "2025-10-01T00:00:00Z" },
        { name: "2025-q4", start: "2025-10-01T00:00:00Z", end: "2026-01-01T00:00:00Z" },
        { name: "2026-q1", start: "2026-01-01T00:00:00Z", end: "2026-04-01T00:00:00Z" },
        { name: "2026-q2", start: "2026-04-01T00:00:00Z", end: "2026-07-01T00:00:00Z" },
        { name: "2026-july-partial", start: "2026-07-01T00:00:00Z", end: "2026-07-20T00:00:00Z" },
      ].map((period) => ({ ...period, startMs: Date.parse(period.start), endMs: Date.parse(period.end) }))
    : olderPeriods;

const continuous = {
  name: `continuous-${evaluationPeriod}`,
  startMs: periods[0]!.startMs,
  endMs: periods.at(-1)!.endMs,
};

function resample(candles: Candle[], minutes: number) {
  const intervalMs = minutes * 60_000;
  const output: Candle[] = [];
  let bucket = -1;
  let current: Candle | null = null;
  for (const candle of candles) {
    const nextBucket = Math.floor(candle.t / intervalMs) * intervalMs;
    if (nextBucket !== bucket) {
      if (current) output.push(current);
      bucket = nextBucket;
      current = { t: nextBucket + intervalMs - 60_000, o: candle.o, h: candle.h, l: candle.l, v: candle.v, volume: candle.volume };
    } else {
      current!.h = Math.max(current!.h, candle.h);
      current!.l = Math.min(current!.l, candle.l);
      current!.v = candle.v;
      current!.volume += candle.volume;
    }
  }
  if (current) output.push(current);
  return output;
}

function emaAlignment(candles: Candle[], fastPeriod: number, slowPeriod: number) {
  const bull = new Uint8Array(candles.length);
  const bear = new Uint8Array(candles.length);
  const fastMultiplier = 2 / (fastPeriod + 1);
  const slowMultiplier = 2 / (slowPeriod + 1);
  let fast: number | null = null;
  let slow: number | null = null;
  for (let index = 0; index < candles.length; index += 1) {
    if (index === fastPeriod - 1) fast = candles.slice(0, fastPeriod).reduce((sum, candle) => sum + candle.v, 0) / fastPeriod;
    else if (fast !== null && index >= fastPeriod) fast = (candles[index]!.v - fast) * fastMultiplier + fast;
    if (index === slowPeriod - 1) slow = candles.slice(0, slowPeriod).reduce((sum, candle) => sum + candle.v, 0) / slowPeriod;
    else if (slow !== null && index >= slowPeriod) slow = (candles[index]!.v - slow) * slowMultiplier + slow;
    if (fast !== null && slow !== null) {
      bull[index] = fast > slow ? 1 : 0;
      bear[index] = fast < slow ? 1 : 0;
    }
  }
  return { bull, bear };
}

function freshCrossQualification(candles: Candle[], fastPeriod: number, slowPeriod: number, maximumAgeBars: number) {
  const alignment = emaAlignment(candles, fastPeriod, slowPeriod);
  const bull = new Uint8Array(candles.length);
  const bear = new Uint8Array(candles.length);
  let lastBullCross = Number.NEGATIVE_INFINITY;
  let lastBearCross = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < candles.length; index += 1) {
    if (alignment.bull[index] && !alignment.bull[index - 1]) lastBullCross = index;
    if (alignment.bear[index] && !alignment.bear[index - 1]) lastBearCross = index;
    bull[index] = alignment.bull[index] && index - lastBullCross <= maximumAgeBars ? 1 : 0;
    bear[index] = alignment.bear[index] && index - lastBearCross <= maximumAgeBars ? 1 : 0;
  }
  return { bull, bear };
}

function project(target: Candle[], source: Candle[], alignment: ReturnType<typeof emaAlignment>) {
  const bull = new Uint8Array(target.length);
  const bear = new Uint8Array(target.length);
  let sourceIndex = -1;
  for (let index = 0; index < target.length; index += 1) {
    while (sourceIndex + 1 < source.length && source[sourceIndex + 1]!.t <= target[index]!.t) sourceIndex += 1;
    if (sourceIndex >= 0) {
      bull[index] = alignment.bull[sourceIndex]!;
      bear[index] = alignment.bear[sourceIndex]!;
    }
  }
  return { bull, bear };
}

function intersect(
  left: { bullQualified: Uint8Array; bearQualified: Uint8Array },
  right: { bull: Uint8Array; bear: Uint8Array },
) {
  const bullQualified = new Uint8Array(left.bullQualified.length);
  const bearQualified = new Uint8Array(left.bearQualified.length);
  for (let index = 0; index < bullQualified.length; index += 1) {
    bullQualified[index] = left.bullQualified[index] && right.bull[index] ? 1 : 0;
    bearQualified[index] = left.bearQualified[index] && right.bear[index] ? 1 : 0;
  }
  return { bullQualified, bearQualified };
}

function applyCandidateQualification(
  base: { bullQualified: Uint8Array; bearQualified: Uint8Array },
  candidate: Candidate,
  alignment: ReturnType<typeof emaAlignment>,
  freshCross: ReturnType<typeof freshCrossQualification>,
  indicators: ReturnType<typeof prepareIndicators>,
) {
  if (!candidate.ema15Filter) return base;
  const filter = candidate.ema15Filter === "fresh-cross" ? freshCross : alignment;
  const bullQualified = new Uint8Array(base.bullQualified);
  const bearQualified = new Uint8Array(base.bearQualified);
  for (let index = 0; index < bullQualified.length; index += 1) {
    const bullOverride = candidate.ema15MinimumScoreOverride !== undefined
      && indicators.bullScore[index]! >= candidate.ema15MinimumScoreOverride;
    const bearOverride = candidate.ema15MinimumScoreOverride !== undefined
      && indicators.bearScore[index]! >= candidate.ema15MinimumScoreOverride;
    if (!candidate.ema15ShortOnly) {
      bullQualified[index] = bullQualified[index] && (filter.bull[index] || bullOverride) ? 1 : 0;
    }
    bearQualified[index] = bearQualified[index] && (filter.bear[index] || bearOverride) ? 1 : 0;
  }
  return { bullQualified, bearQualified };
}

function compact(result: BacktestResult) {
  const { trades, dailyEquity, variant: _variant, ...summary } = result;
  return {
    ...summary,
    stopLossCount: trades.filter((trade) => trade.exitReason === "stop-loss").length,
    takeProfitCount: trades.filter((trade) => trade.exitReason === "take-profit").length,
    endOfPeriodCount: trades.filter((trade) => trade.exitReason === "end-of-period").length,
    longCount: trades.filter((trade) => trade.side === "long").length,
    shortCount: trades.filter((trade) => trade.side === "short").length,
    monthly: monthlyStatistics(dailyEquity, result.startingCapitalUsd),
  };
}

function monthlyStatistics(dailyEquity: BacktestResult["dailyEquity"], startingCapitalUsd: number) {
  const monthEnds = new Map<string, number>();
  for (const point of dailyEquity) {
    const date = new Date(point.timestamp);
    const key = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
    monthEnds.set(key, point.equityUsd);
  }
  let previous = startingCapitalUsd;
  const returns = [...monthEnds.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([month, equityUsd]) => {
    const returnPercent = previous > 0 ? (equityUsd / previous - 1) * 100 : -100;
    previous = equityUsd;
    return { month, equityUsd, returnPercent };
  });
  const values = returns.map((row) => row.returnPercent);
  const sorted = [...values].sort((a, b) => a - b);
  return {
    monthCount: values.length,
    averageReturnPercent: values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length),
    medianReturnPercent: sorted[Math.floor(sorted.length / 2)] ?? 0,
    worstReturnPercent: values.length ? Math.min(...values) : 0,
    bestReturnPercent: values.length ? Math.max(...values) : 0,
    positiveMonthCount: values.filter((value) => value > 0).length,
    returns,
  };
}

function buildControl(frozen: FrozenControl, candidate: Candidate) {
  const control = structuredClone(frozen);
  control.settings.perpsLeverage = candidate.dynamicLeverage.maximum;
  control.settings.smartTradeProfile = "aggressive";
  control.settings.mode = "all";
  control.profile.leverageCap = candidate.dynamicLeverage.maximum;
  control.profile.takeProfitRoePercent = candidate.takeProfitRoePercent;
  control.profile.stopLossRoePercent = candidate.stopLossRoePercent;
  if (candidate.minimumConfidence !== undefined) control.profile.minimumConfidence = candidate.minimumConfidence;
  if (candidate.maximumAllocationPercent !== undefined) control.profile.maximumAllocationPercent = candidate.maximumAllocationPercent;
  // Preserves the exact frozen-search input. This label was not the binding
  // sizing constraint in the discovered runs and is not a production setting recommendation.
  control.profile.targetWalletRiskPercent = candidate.targetWalletRiskPercent ?? 5;
  return control;
}

function buildVariant(candidate: Candidate): StrategyVariant {
  return {
    name: candidate.name,
    trendWindow: candidate.trendWindow,
    trendThreshold: candidate.trendThreshold,
    breakoutPercent: candidate.breakoutPercent,
    cooldownSeconds: candidate.cooldownSeconds,
    useIndicators: true,
    useLearnedConfirmation: true,
    useDecisionLayer: true,
    directionMode: candidate.directionMode ?? "all",
    indicatorLookbackMinutes: 900,
    stopLossRoePercent: candidate.stopLossRoePercent,
    stopLossCooldownSeconds: candidate.cooldownSeconds,
    dynamicLeverage: candidate.dynamicLeverage,
    entryLockedAtrExit: candidate.entryLockedAtrExit,
    enforceTargetRiskAtStop: candidate.enforceTargetRiskAtStop,
  };
}

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname));
const dataDir = path.resolve(process.env.OLDER_DATA_DIR ?? path.join(root, "data", evaluationPeriod === "older" ? "coinbase-2021-2024" : "coinbase"));
const outputFile = path.resolve(process.env.OLDER_RESULT_FILE ?? path.join(root, "results", "older-sealed", "sol-older-sealed.json"));
const detailedDir = process.env.DETAILED_RESULT_DIR ? path.resolve(process.env.DETAILED_RESULT_DIR) : null;
const frozen = JSON.parse(fs.readFileSync(path.join(root, "frozen-control.json"), "utf8")) as FrozenControl;
const manifest = JSON.parse(fs.readFileSync(path.join(dataDir, "manifest.json"), "utf8"));
if (!manifest.products?.every((product: { complete?: boolean }) => product.complete)) throw new Error("Older dataset is not complete.");
if (manifest.requestedStart > continuous.startMs / 1_000 || manifest.requestedEnd < continuous.endMs / 1_000) {
  throw new Error("Dataset does not cover the requested evaluation period.");
}

const solMinute = loadCandles(path.join(dataDir, "sol-usd-1m.csv"));
const btcMinute = loadCandles(path.join(dataDir, "btc-usd-1m.csv"));
const solEntry = resample(solMinute, 15);
const solHour = resample(solMinute, 60);
const solFourHour = resample(solMinute, 240);
const btcHour = resample(btcMinute, 60);
const btcFourHour = resample(btcMinute, 240);
const preparedIndicators = prepareIndicators(solEntry, getIndicatorSettings(frozen.profile), undefined, 900, 15);

// All three frozen candidates intentionally share the same EMA 8/21 regime:
// SOL 1h + 4h and BTC 1h + 4h must align with the trade direction.
let qualification = {
  bullQualified: project(solEntry, solHour, emaAlignment(solHour, 8, 21)).bull,
  bearQualified: project(solEntry, solHour, emaAlignment(solHour, 8, 21)).bear,
};
qualification = intersect(qualification, project(solEntry, solFourHour, emaAlignment(solFourHour, 8, 21)));
qualification = intersect(qualification, project(solEntry, btcHour, emaAlignment(btcHour, 8, 21)));
qualification = intersect(qualification, project(solEntry, btcFourHour, emaAlignment(btcFourHour, 8, 21)));
const ema15Alignment = emaAlignment(solEntry, 20, 50);

const stress: CostModel = {
  ...BASELINE_COST_MODEL,
  name: "stress-costs",
  priceImpactFeeRate: 0.0005,
  slippageBps: 10,
  networkCostUsd: 0.1,
  borrowRateMultiplier: 3,
};

const candidatePattern = process.env.CANDIDATE_PATTERN ? new RegExp(process.env.CANDIDATE_PATTERN) : null;
const evaluationCandidates = candidatePattern ? candidates.filter((candidate) => candidatePattern.test(candidate.name)) : candidates;
const rows = [];
for (const candidate of evaluationCandidates) {
  const control = buildControl(frozen, candidate);
  const variant = buildVariant(candidate);
  const ema15FreshCross = freshCrossQualification(
    solEntry,
    20,
    50,
    candidate.ema15MaximumCrossAgeBars ?? 32,
  );
  const candidateQualification = applyCandidateQualification(
    qualification,
    candidate,
    ema15Alignment,
    ema15FreshCross,
    preparedIndicators,
  );
  for (const startingCapitalUsd of [100, 1_000]) {
    for (const costs of [BASELINE_COST_MODEL, stress]) {
      const full = runBacktest({
        asset: "SOL",
        candles: solEntry,
        preparedIndicators,
        higherTimeframeQualification: candidateQualification,
        control,
        variant,
        costs,
        startMs: continuous.startMs,
        endMs: continuous.endMs,
        startingCapitalUsd,
      });
      if (detailedDir && startingCapitalUsd === 100 && costs.name === stress.name) {
        fs.mkdirSync(detailedDir, { recursive: true });
        fs.writeFileSync(path.join(detailedDir, `${candidate.name}.json`), `${JSON.stringify(full, null, 2)}\n`);
      }
      const segments = periods.map((period) => compact(runBacktest({
        asset: "SOL",
        candles: solEntry,
        preparedIndicators,
        higherTimeframeQualification: candidateQualification,
        control,
        variant,
        costs,
        startMs: period.startMs,
        endMs: period.endMs,
        startingCapitalUsd,
      })));
      rows.push({
        candidate: candidate.name,
        startingCapitalUsd,
        costModel: costs.name,
        continuous: compact(full),
        segments: periods.map((period, index) => ({ segment: period.name, ...segments[index] })),
        profitableSegmentCount: segments.filter((result) => result.returnPercent > 0 && result.profitFactor > 1).length,
      });
      process.stdout.write(`${candidate.name} $${startingCapitalUsd} ${costs.name}: ${full.returnPercent}% (${full.tradeCount} trades)\n`);
    }
  }
}

const gates = rows.filter((row) => row.startingCapitalUsd === 100 && row.costModel === stress.name).map((row) => ({
  candidate: row.candidate,
  positiveContinuousReturn: row.continuous.returnPercent > 0,
  continuousProfitFactorAboveOne: row.continuous.profitFactor > 1,
  majorityProfitableSegments: row.profitableSegmentCount >= 4,
  maximumDrawdownAtMost30Percent: row.continuous.maxDrawdownPercent <= 30,
  noLiquidations: row.continuous.liquidationCount === 0,
  passed: row.continuous.returnPercent > 0
    && row.continuous.profitFactor > 1
    && row.profitableSegmentCount >= 4
    && row.continuous.maxDrawdownPercent <= 30
    && row.continuous.liquidationCount === 0,
}));

const report = {
  methodology: {
    sealed: true,
    parametersFrozenBeforeOlderDataEvaluation: true,
    noOptimizationOnOlderData: true,
    sourceManifest: manifest,
    continuousPeriod: { start: new Date(continuous.startMs).toISOString(), end: new Date(continuous.endMs).toISOString() },
    segmentPeriods: periods.map(({ name, start, end }) => ({ name, start, end })),
    entryBars: "15m resampled from Coinbase 1m candles",
    confirmation: "EMA 8/21 alignment on SOL 1h+4h and BTC 1h+4h",
    acceptanceGates: "stress/$100: positive continuous return, PF > 1, >=4/7 profitable segments, <=30% drawdown, zero liquidations",
  },
  candidates: evaluationCandidates,
  gates,
  rows,
};

fs.mkdirSync(path.dirname(outputFile), { recursive: true });
fs.writeFileSync(outputFile, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`Wrote ${outputFile}\n`);
