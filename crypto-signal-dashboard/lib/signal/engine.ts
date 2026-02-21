import { percentChange } from "../utils";
import type { PricePoint } from "../price/simulated";

export type UserParams = {
  trendWindow: number; // minutes
  trendThreshold: number; // percent
  breakoutPercent: number; // percent
  newsBias: number; // -1 to 1
  cooldownSeconds: number;
};

export type Signal = {
  id: string;
  symbol: string;
  type: "trend" | "breakout" | "news";
  direction: "bullish" | "bearish";
  confidence: number;
  summary: string;
  timestamp: number;
};

function scoreConfidence(magnitude: number, threshold: number) {
  if (threshold <= 0) return 0.5;
  const ratio = magnitude / threshold;
  // 0.55 at threshold, ramps slower, capped below 1.0 to avoid constant 100% prints.
  return Math.max(0.3, Math.min(0.95, 0.55 + (ratio - 1) / 3));
}

export function computeTrend(points: PricePoint[]) {
  if (points.length < 2) {
    return { changePercent: 0, direction: "bullish" as const };
  }
  const start = points[0].v;
  const end = points[points.length - 1].v;
  const changePercent = percentChange(end, start);
  return {
    changePercent,
    direction: changePercent >= 0 ? ("bullish" as const) : ("bearish" as const),
  };
}

export function detectSignals({
  symbol,
  points,
  params,
  newsScore,
  lastSignalAt,
}: {
  symbol: string;
  points: PricePoint[];
  params: UserParams;
  newsScore: number;
  lastSignalAt?: number;
}): Signal[] {
  if (points.length < 3) return [];
  const now = points[points.length - 1].t;
  if (lastSignalAt && now - lastSignalAt < params.cooldownSeconds * 1000) {
    return [];
  }

  const trend = computeTrend(points);
  // Use a wider baseline to target slower, 15m+ style setups.
  const recent = points.slice(Math.max(0, points.length - Math.max(30, Math.floor(points.length / 3))));
  const avg = recent.reduce((sum, point) => sum + point.v, 0) / recent.length;
  const breakoutChange = percentChange(points[points.length - 1].v, avg);

  const signals: Signal[] = [];

  if (Math.abs(trend.changePercent) >= params.trendThreshold) {
    signals.push({
      id: `${symbol}-trend-${now}`,
      symbol,
      type: "trend",
      direction: trend.direction,
      confidence: scoreConfidence(Math.abs(trend.changePercent), params.trendThreshold),
      summary: `Trend shift of ${trend.changePercent.toFixed(2)}% over window.`,
      timestamp: now,
    });
  }

  if (Math.abs(breakoutChange) >= params.breakoutPercent) {
    signals.push({
      id: `${symbol}-breakout-${now}`,
      symbol,
      type: "breakout",
      direction: breakoutChange >= 0 ? "bullish" : "bearish",
      confidence: scoreConfidence(Math.abs(breakoutChange), params.breakoutPercent),
      summary: `Price action breakout of ${breakoutChange.toFixed(2)}% vs recent avg.`,
      timestamp: now,
    });
  }

  if (Math.abs(newsScore) > 0.65) {
    signals.push({
      id: `${symbol}-news-${now}`,
      symbol,
      type: "news",
      direction: newsScore >= 0 ? "bullish" : "bearish",
      confidence: Math.max(0.35, Math.min(0.8, Math.abs(newsScore))),
      summary: `News sentiment suggests ${newsScore >= 0 ? "positive" : "negative"} bias.`,
      timestamp: now,
    });
  }

  if (signals.length <= 1) return signals;
  return [...signals].sort((a, b) => b.confidence - a.confidence).slice(0, 1);
}
