import fs from "node:fs";
import path from "node:path";

import {
  BASELINE_COST_MODEL,
  getIndicatorSettings,
  loadCandles,
  prepareIndicators,
  runBacktest,
  type Asset,
  type Candle,
  type FrozenControl,
  type StrategyVariant,
} from "./model";

type ConfirmationMode = "15m-only" | "15m+1h" | "15m+1h+4h";

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
      current = {
        t: nextBucket + intervalMs - 60_000,
        o: candle.o,
        h: candle.h,
        l: candle.l,
        v: candle.v,
        volume: candle.volume,
      };
      continue;
    }
    current!.h = Math.max(current!.h, candle.h);
    current!.l = Math.min(current!.l, candle.l);
    current!.v = candle.v;
    current!.volume += candle.volume;
  }
  if (current) output.push(current);
  return output;
}

function emaAlignment(candles: Candle[], fastPeriod = 9, slowPeriod = 21) {
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

function projectAlignment(target: Candle[], source: Candle[], alignment: ReturnType<typeof emaAlignment>) {
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

function combine(left: ReturnType<typeof projectAlignment>, right: ReturnType<typeof projectAlignment>) {
  const bull = new Uint8Array(left.bull.length);
  const bear = new Uint8Array(left.bear.length);
  for (let index = 0; index < bull.length; index += 1) {
    bull[index] = left.bull[index] && right.bull[index] ? 1 : 0;
    bear[index] = left.bear[index] && right.bear[index] ? 1 : 0;
  }
  return { bullQualified: bull, bearQualified: bear };
}

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname));
const frozen = JSON.parse(fs.readFileSync(path.join(root, "frozen-control.json"), "utf8")) as FrozenControl;
const assets: Asset[] = ["SOL", "ETH", "BTC"];
const modes: ConfirmationMode[] = ["15m-only", "15m+1h", "15m+1h+4h"];
const periods = [
  { name: "development", start: Date.parse("2025-01-01T00:00:00Z"), end: Date.parse("2026-04-01T00:00:00Z") },
  { name: "forward", start: Date.parse("2026-04-01T00:00:00Z"), end: Date.parse("2026-07-20T00:00:00Z") },
];
const control = structuredClone(frozen);
control.settings.perpsLeverage = 2;
control.settings.smartTradeProfile = "aggressive";
control.settings.mode = "all";
control.profile.leverageCap = 2;
control.profile.takeProfitRoePercent = 25;
control.profile.targetWalletRiskPercent = 0.75;

const rows: Array<{
  asset: Asset;
  period: string;
  mode: ConfirmationMode;
  returnPercent: number;
  maxDrawdownPercent: number;
  profitFactor: number;
  tradeCount: number;
  winCount: number;
  lossCount: number;
  stopLossCount: number;
  averageDurationMinutes: number;
  directionBlockedCount: number;
}> = [];
for (const asset of assets) {
  const minuteCandles = loadCandles(path.join(root, "data", "coinbase", `${asset.toLowerCase()}-usd-1m.csv`));
  const entryCandles = resample(minuteCandles, 15);
  const hourCandles = resample(minuteCandles, 60);
  const regimeCandles = resample(minuteCandles, 240);
  process.stdout.write(`${asset}: ${entryCandles.length} 15m / ${hourCandles.length} 1h / ${regimeCandles.length} 4h candles\n`);
  const preparedIndicators = prepareIndicators(entryCandles, getIndicatorSettings(frozen.profile), undefined, 900, 15);
  const hour = projectAlignment(entryCandles, hourCandles, emaAlignment(hourCandles));
  const regime = projectAlignment(entryCandles, regimeCandles, emaAlignment(regimeCandles));
  const qualifications = {
    "15m-only": undefined,
    "15m+1h": { bullQualified: hour.bull, bearQualified: hour.bear },
    "15m+1h+4h": combine(hour, regime),
  } satisfies Record<ConfirmationMode, { bullQualified: Uint8Array; bearQualified: Uint8Array } | undefined>;

  for (const mode of modes) {
    const variant: StrategyVariant = {
      name: `multi-timeframe-${mode}`,
      trendWindow: 60,
      trendThreshold: 0.15,
      breakoutPercent: 0.65,
      cooldownSeconds: 3_600,
      useIndicators: true,
      useLearnedConfirmation: true,
      useDecisionLayer: true,
      directionMode: "all",
      indicatorLookbackMinutes: 900,
      stopLossRoePercent: 15,
      stopLossCooldownSeconds: 3_600,
    };
    for (const period of periods) {
      const result = runBacktest({
        asset,
        candles: entryCandles,
        preparedIndicators,
        higherTimeframeQualification: qualifications[mode],
        control,
        variant,
        costs: BASELINE_COST_MODEL,
        startMs: period.start,
        endMs: period.end,
        startingCapitalUsd: 1_000,
      });
      rows.push({
        asset,
        period: period.name,
        mode,
        returnPercent: result.returnPercent,
        maxDrawdownPercent: result.maxDrawdownPercent,
        profitFactor: result.profitFactor,
        tradeCount: result.tradeCount,
        winCount: result.winCount,
        lossCount: result.lossCount,
        stopLossCount: result.trades.filter((trade) => trade.exitReason === "stop-loss").length,
        averageDurationMinutes: result.averageDurationMinutes,
        directionBlockedCount: result.directionBlockedCount,
      });
    }
    process.stdout.write(`${asset}: ${mode} complete\n`);
  }
}

const summaries = modes.map((mode) => {
  const selected = rows.filter((row) => row.mode === mode);
  return {
    mode,
    positiveSegments: selected.filter((row) => row.returnPercent > 0 && row.profitFactor > 1).length,
    averageReturnPercent: selected.reduce((sum, row) => sum + row.returnPercent, 0) / selected.length,
    worstDrawdownPercent: Math.max(...selected.map((row) => row.maxDrawdownPercent)),
    totalTrades: selected.reduce((sum, row) => sum + row.tradeCount, 0),
    totalStopLosses: selected.reduce((sum, row) => sum + row.stopLossCount, 0),
  };
});
const file = path.join(root, "results", "broad-search", "multi-timeframe-study.json");
fs.writeFileSync(file, `${JSON.stringify({
  generatedAt: new Date().toISOString(),
  methodology: "Research-only coarse-candle architecture: 15m entry candles with existing indicator scoring, optional 1h and 4h EMA(9/21) directional confirmation, 25% TP, 15% SL, 2x leverage, and one-hour signal/post-stop cooldown.",
  summaries,
  rows,
}, null, 2)}\n`);
process.stdout.write(`Saved ${file}\n`);
