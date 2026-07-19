import type { PricePoint } from "@/lib/price/simulated";

export type IndicatorSettings = {
  emaFast: number;
  emaSlow: number;
  rsiPeriod: number;
  longRsiMin: number;
  longRsiMax: number;
  shortRsiMin: number;
  shortRsiMax: number;
  longRsiVeto: number;
  shortRsiVeto: number;
  macdFast: number;
  macdSlow: number;
  macdSignal: number;
  adxPeriod: number;
  minimumAdx: number;
  strongAdx: number;
  volumePeriod: number;
  minimumVolumeRatio: number;
  strongVolumeRatio: number;
  bollingerPeriod: number;
  bollingerStdDev: number;
  minimumScore: number;
};

export const BASE_INDICATOR_SETTINGS: IndicatorSettings = {
  emaFast: 9,
  emaSlow: 21,
  rsiPeriod: 14,
  longRsiMin: 50,
  longRsiMax: 72,
  shortRsiMin: 28,
  shortRsiMax: 50,
  longRsiVeto: 75,
  shortRsiVeto: 25,
  macdFast: 12,
  macdSlow: 26,
  macdSignal: 9,
  adxPeriod: 14,
  minimumAdx: 20,
  strongAdx: 25,
  volumePeriod: 20,
  minimumVolumeRatio: 1.1,
  strongVolumeRatio: 1.25,
  bollingerPeriod: 20,
  bollingerStdDev: 2,
  minimumScore: 3,
};

export type IndicatorSnapshot = {
  emaFast: number | null;
  emaSlow: number | null;
  emaSpreadPercent: number | null;
  emaSlopePercent: number | null;
  rsi: number | null;
  macdLine: number | null;
  macdSignal: number | null;
  macdHistogram: number | null;
  macdHistogramChange: number | null;
  adx: number | null;
  plusDi: number | null;
  minusDi: number | null;
  atrPercent: number | null;
  volumeRatio: number | null;
  bollingerBandwidthPercent: number | null;
  bollingerPosition: number | null;
};

export type IndicatorScore = {
  score: number;
  qualified: boolean;
  vetoed: boolean;
  tags: string[];
};

function finite(value: number | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function emaSeries(values: number[], period: number) {
  if (values.length < period) return [];
  const output = Array<number | null>(values.length).fill(null);
  let current = values.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  output[period - 1] = current;
  const multiplier = 2 / (period + 1);
  for (let index = period; index < values.length; index += 1) {
    current = (values[index]! - current) * multiplier + current;
    output[index] = current;
  }
  return output;
}

function lastFinite(values: Array<number | null>) {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const value = values[index];
    if (value !== null && Number.isFinite(value)) return value;
  }
  return null;
}

function computeRsi(values: number[], period: number) {
  if (values.length <= period) return null;
  let gains = 0;
  let losses = 0;
  for (let index = values.length - period; index < values.length; index += 1) {
    const change = values[index]! - values[index - 1]!;
    if (change >= 0) gains += change;
    else losses -= change;
  }
  if (losses === 0) return gains === 0 ? 50 : 100;
  const relativeStrength = (gains / period) / (losses / period);
  return 100 - 100 / (1 + relativeStrength);
}

function computeMacd(values: number[], settings: IndicatorSettings) {
  const fast = emaSeries(values, settings.macdFast);
  const slow = emaSeries(values, settings.macdSlow);
  const macd = values.map((_, index) => fast[index] !== null && slow[index] !== null ? fast[index]! - slow[index]! : null);
  const validMacd = macd.flatMap((value) => value === null ? [] : [value]);
  const signalValues = emaSeries(validMacd, settings.macdSignal);
  const line = lastFinite(macd);
  const signal = lastFinite(signalValues);
  if (line === null || signal === null) return { line, signal, histogram: null, histogramChange: null };
  const histogram = line - signal;
  const previousLine = lastFinite(macd.slice(0, -1));
  const previousSignal = lastFinite(signalValues.slice(0, -1));
  const previousHistogram = previousLine !== null && previousSignal !== null ? previousLine - previousSignal : null;
  return { line, signal, histogram, histogramChange: previousHistogram === null ? null : histogram - previousHistogram };
}

function computeDirectionalMovement(points: PricePoint[], period: number) {
  if (points.length <= period) return { adx: null, plusDi: null, minusDi: null, atrPercent: null };
  const trueRanges: number[] = [];
  const plusDms: number[] = [];
  const minusDms: number[] = [];
  for (let index = 1; index < points.length; index += 1) {
    const current = points[index]!;
    const previous = points[index - 1]!;
    const high = current.h ?? Math.max(current.o ?? previous.v, current.v);
    const low = current.l ?? Math.min(current.o ?? previous.v, current.v);
    const previousHigh = previous.h ?? previous.v;
    const previousLow = previous.l ?? previous.v;
    trueRanges.push(Math.max(high - low, Math.abs(high - previous.v), Math.abs(low - previous.v)));
    const upMove = high - previousHigh;
    const downMove = previousLow - low;
    plusDms.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDms.push(downMove > upMove && downMove > 0 ? downMove : 0);
  }
  const directionalIndex: number[] = [];
  for (let end = period; end <= trueRanges.length; end += 1) {
    const tr = trueRanges.slice(end - period, end).reduce((sum, value) => sum + value, 0);
    const plus = plusDms.slice(end - period, end).reduce((sum, value) => sum + value, 0);
    const minus = minusDms.slice(end - period, end).reduce((sum, value) => sum + value, 0);
    const plusDi = tr > 0 ? plus / tr * 100 : 0;
    const minusDi = tr > 0 ? minus / tr * 100 : 0;
    const denominator = plusDi + minusDi;
    directionalIndex.push(denominator > 0 ? Math.abs(plusDi - minusDi) / denominator * 100 : 0);
  }
  const recentTr = trueRanges.slice(-period).reduce((sum, value) => sum + value, 0);
  const recentPlus = plusDms.slice(-period).reduce((sum, value) => sum + value, 0);
  const recentMinus = minusDms.slice(-period).reduce((sum, value) => sum + value, 0);
  const plusDi = recentTr > 0 ? recentPlus / recentTr * 100 : 0;
  const minusDi = recentTr > 0 ? recentMinus / recentTr * 100 : 0;
  const adxWindow = directionalIndex.slice(-period);
  const adx = adxWindow.length === period ? adxWindow.reduce((sum, value) => sum + value, 0) / period : null;
  const price = points[points.length - 1]!.v;
  return { adx, plusDi, minusDi, atrPercent: price > 0 ? recentTr / period / price * 100 : 0 };
}

export function computeIndicatorSnapshot(points: PricePoint[], settings: IndicatorSettings = BASE_INDICATOR_SETTINGS): IndicatorSnapshot {
  const valid = points.filter((point) => Number.isFinite(point.v) && point.v > 0);
  const values = valid.map((point) => point.v);
  const fastSeries = emaSeries(values, settings.emaFast);
  const slowSeries = emaSeries(values, settings.emaSlow);
  const emaFast = lastFinite(fastSeries);
  const emaSlow = lastFinite(slowSeries);
  const previousFast = lastFinite(fastSeries.slice(0, -1));
  const macd = computeMacd(values, settings);
  const directional = computeDirectionalMovement(valid, settings.adxPeriod);
  const volumeWindow = valid.slice(-settings.volumePeriod);
  const volumes = volumeWindow.flatMap((point) => finite(point.volume) === null ? [] : [point.volume!]);
  const latestVolume = finite(valid[valid.length - 1]?.volume);
  const averageVolume = volumes.length > 0 ? volumes.reduce((sum, value) => sum + value, 0) / volumes.length : null;
  const bandValues = values.slice(-settings.bollingerPeriod);
  const bandMean = bandValues.length === settings.bollingerPeriod ? bandValues.reduce((sum, value) => sum + value, 0) / bandValues.length : null;
  const stdDev = bandMean === null ? null : Math.sqrt(bandValues.reduce((sum, value) => sum + (value - bandMean) ** 2, 0) / bandValues.length);
  const upper = bandMean !== null && stdDev !== null ? bandMean + stdDev * settings.bollingerStdDev : null;
  const lower = bandMean !== null && stdDev !== null ? bandMean - stdDev * settings.bollingerStdDev : null;
  const price = values[values.length - 1] ?? null;
  return {
    emaFast,
    emaSlow,
    emaSpreadPercent: emaFast !== null && emaSlow !== null && emaSlow > 0 ? (emaFast - emaSlow) / emaSlow * 100 : null,
    emaSlopePercent: emaFast !== null && previousFast !== null && previousFast > 0 ? (emaFast - previousFast) / previousFast * 100 : null,
    rsi: computeRsi(values, settings.rsiPeriod),
    macdLine: macd.line,
    macdSignal: macd.signal,
    macdHistogram: macd.histogram,
    macdHistogramChange: macd.histogramChange,
    adx: directional.adx,
    plusDi: directional.plusDi,
    minusDi: directional.minusDi,
    atrPercent: directional.atrPercent,
    volumeRatio: latestVolume !== null && averageVolume !== null && averageVolume > 0 ? latestVolume / averageVolume : null,
    bollingerBandwidthPercent: upper !== null && lower !== null && bandMean !== null && bandMean > 0 ? (upper - lower) / bandMean * 100 : null,
    bollingerPosition: price !== null && upper !== null && lower !== null && upper > lower ? (price - lower) / (upper - lower) : null,
  };
}

export function scoreIndicatorSnapshot(snapshot: IndicatorSnapshot, direction: "bullish" | "bearish", settings: IndicatorSettings = BASE_INDICATOR_SETTINGS): IndicatorScore {
  let score = 0;
  const tags: string[] = [];
  const bullish = direction === "bullish";
  const vetoed = snapshot.rsi !== null && (bullish ? snapshot.rsi >= settings.longRsiVeto : snapshot.rsi <= settings.shortRsiVeto);
  if (vetoed) tags.push("RSI_EXTREME_VETO");
  if (snapshot.emaFast !== null && snapshot.emaSlow !== null && (bullish ? snapshot.emaFast > snapshot.emaSlow : snapshot.emaFast < snapshot.emaSlow)) {
    score += 1;
    tags.push("EMA_ALIGNED");
  }
  if (snapshot.rsi !== null && (bullish
    ? snapshot.rsi >= settings.longRsiMin && snapshot.rsi <= settings.longRsiMax
    : snapshot.rsi >= settings.shortRsiMin && snapshot.rsi <= settings.shortRsiMax)) {
    score += 1;
    tags.push("RSI_DIRECTIONAL");
  }
  if (snapshot.macdHistogram !== null && (bullish ? snapshot.macdHistogram > 0 : snapshot.macdHistogram < 0)) {
    score += 1;
    tags.push("MACD_ALIGNED");
  }
  if (snapshot.macdHistogramChange !== null && (bullish ? snapshot.macdHistogramChange > 0 : snapshot.macdHistogramChange < 0)) {
    score += 0.5;
    tags.push("MACD_STRENGTHENING");
  }
  if (snapshot.adx !== null && snapshot.adx >= settings.minimumAdx) {
    score += snapshot.adx >= settings.strongAdx ? 1.5 : 1;
    tags.push(snapshot.adx >= settings.strongAdx ? "ADX_STRONG" : "ADX_TRENDING");
  }
  if (snapshot.plusDi !== null && snapshot.minusDi !== null && (bullish ? snapshot.plusDi > snapshot.minusDi : snapshot.minusDi > snapshot.plusDi)) {
    score += 0.5;
    tags.push("DMI_ALIGNED");
  }
  if (snapshot.volumeRatio !== null && snapshot.volumeRatio >= settings.minimumVolumeRatio) {
    score += snapshot.volumeRatio >= settings.strongVolumeRatio ? 1.5 : 1;
    tags.push(snapshot.volumeRatio >= settings.strongVolumeRatio ? "VOLUME_STRONG" : "VOLUME_CONFIRMED");
  }
  return { score: Number(score.toFixed(2)), vetoed, qualified: !vetoed && score >= settings.minimumScore, tags };
}
