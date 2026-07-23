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

function compact(result: BacktestResult) {
  const { trades: _trades, dailyEquity: _dailyEquity, variant: _variant, ...summary } = result;
  return {
    ...summary,
    stopLossCount: result.trades.filter((trade) => trade.exitReason === "stop-loss").length,
    takeProfitCount: result.trades.filter((trade) => trade.exitReason === "take-profit").length,
  };
}

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
  right: { bull: Uint8Array; bear: Uint8Array }
) {
  const bullQualified = new Uint8Array(left.bullQualified.length);
  const bearQualified = new Uint8Array(left.bearQualified.length);
  for (let index = 0; index < bullQualified.length; index += 1) {
    bullQualified[index] = left.bullQualified[index] && right.bull[index] ? 1 : 0;
    bearQualified[index] = left.bearQualified[index] && right.bear[index] ? 1 : 0;
  }
  return { bullQualified, bearQualified };
}

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname));
const preservationMode = process.env.SOL_SENSITIVITY_MODE === "preservation";
const frozen = JSON.parse(fs.readFileSync(path.join(root, "frozen-control.json"), "utf8")) as FrozenControl;
const solMinute = loadCandles(path.join(root, "data", "coinbase", "sol-usd-1m.csv"));
const btcMinute = loadCandles(path.join(root, "data", "coinbase", "btc-usd-1m.csv"));
const solEntry = resample(solMinute, 15);
const solHour = resample(solMinute, 60);
const btcHour = resample(btcMinute, 60);
const btcFourHour = resample(btcMinute, 240);
const preparedIndicators = prepareIndicators(solEntry, getIndicatorSettings(frozen.profile), undefined, 900, 15);
const sol1h = project(solEntry, solHour, emaAlignment(solHour, 8, 21));
let qualification = { bullQualified: sol1h.bull, bearQualified: sol1h.bear };
qualification = intersect(qualification, project(solEntry, btcHour, emaAlignment(btcHour, 8, 21)));
qualification = intersect(qualification, project(solEntry, btcFourHour, emaAlignment(btcFourHour, 8, 21)));

const periods = [
  { name: "2025-early", start: Date.parse("2025-01-01T00:00:00Z"), end: Date.parse("2025-05-01T00:00:00Z") },
  { name: "2025-mid", start: Date.parse("2025-05-01T00:00:00Z"), end: Date.parse("2025-09-01T00:00:00Z") },
  { name: "2025-late", start: Date.parse("2025-09-01T00:00:00Z"), end: Date.parse("2026-01-01T00:00:00Z") },
  { name: "2026-validation", start: Date.parse("2026-01-01T00:00:00Z"), end: Date.parse("2026-04-01T00:00:00Z") },
  { name: "2026-forward", start: Date.parse("2026-04-01T00:00:00Z"), end: Date.parse("2026-07-20T00:00:00Z") },
  { name: "full-2025-01-to-2026-07", start: Date.parse("2025-01-01T00:00:00Z"), end: Date.parse("2026-07-20T00:00:00Z") },
];
const stress: CostModel = {
  ...BASELINE_COST_MODEL,
  name: "stress-costs",
  priceImpactFeeRate: 0.0005,
  slippageBps: 10,
  networkCostUsd: 0.1,
  borrowRateMultiplier: 3,
};
const stopLossRoePercents = [0, 7, 10, 15, 20, 25, 30, 40, 50, 60, 75, 90];
const configurations = preservationMode ? [
  { leverage: 1.25, stopLossRoePercent: 5, benchmark: false },
] : [
  { leverage: 2.5, stopLossRoePercent: 7, benchmark: true },
  ...stopLossRoePercents.map((stopLossRoePercent) => ({ leverage: 20, stopLossRoePercent, benchmark: false })),
];
const startingCapitalsUsd = [1_000, 100];
const rows = [];
for (const configuration of configurations) {
  const { leverage, stopLossRoePercent } = configuration;
  const control = structuredClone(frozen);
  control.settings.perpsLeverage = leverage;
  control.settings.smartTradeProfile = "aggressive";
  control.settings.mode = "all";
  control.profile.leverageCap = leverage;
  control.profile.takeProfitRoePercent = preservationMode ? 5 : 20;
  control.profile.stopLossRoePercent = stopLossRoePercent;
  control.profile.targetWalletRiskPercent = 0.75;
  const variant: StrategyVariant = {
    name: `sol-selected-${leverage}x-sl-${stopLossRoePercent}`,
    trendWindow: preservationMode ? 120 : 90,
    trendThreshold: 1,
    breakoutPercent: preservationMode ? 1 : 0.8,
    cooldownSeconds: preservationMode ? 28_800 : 10_800,
    useIndicators: true,
    useLearnedConfirmation: true,
    useDecisionLayer: true,
    directionMode: "all",
    indicatorLookbackMinutes: 900,
    stopLossRoePercent: stopLossRoePercent || undefined,
    stopLossCooldownSeconds: preservationMode ? 28_800 : 10_800,
  };
  for (const startingCapitalUsd of startingCapitalsUsd) {
    for (const period of periods) {
      for (const costs of [BASELINE_COST_MODEL, stress]) {
        const result = runBacktest({
          asset: "SOL",
          candles: solEntry,
          preparedIndicators,
          higherTimeframeQualification: qualification,
          control,
          variant,
          costs,
          startMs: period.start,
          endMs: period.end,
          startingCapitalUsd,
        });
        rows.push({ leverage, stopLossRoePercent, startingCapitalUsd, segment: period.name, ...compact(result) });
      }
    }
  }
}

const output = path.join(root, "results", "broad-search", preservationMode ? "sol-capital-preservation-size.json" : "sol-20x-sensitivity.json");
fs.writeFileSync(output, `${JSON.stringify({
  generatedAt: new Date().toISOString(),
  methodology: preservationMode
    ? "Capital-preservation SOL candidate replayed with $1,000 and $100 independently simulated starting capital across the same segmented and continuous periods under baseline/stress costs."
    : "Exact selected SOL signal strategy replayed at configured 20x across a no-stop control and 7–90% fixed SL ROE values, with $1,000 and $100 independently simulated starting capital across the same segmented and continuous periods under baseline/stress costs. The selected 2.5x/7% SL result is retained as a benchmark.",
  fixedControls: {
    trendWindow: preservationMode ? 120 : 90,
    trendThreshold: 1,
    breakoutPercent: preservationMode ? 1 : 0.8,
    cooldownSeconds: preservationMode ? 28_800 : 10_800,
    emaFast: 8,
    emaSlow: 21,
    btcConfirmation: "1h+4h",
    useSolFourHourRegime: false,
    takeProfitRoePercent: preservationMode ? 5 : 20,
    targetWalletRiskPercent: 0.75,
  },
  configurations,
  stopLossRoePercents,
  startingCapitalsUsd,
  rows,
}, null, 2)}\n`);
process.stdout.write(`Saved ${output}\n`);
if (preservationMode) {
  for (const row of rows.filter((row) => row.segment === "full-2025-01-to-2026-07")) {
    process.stdout.write(`$${row.startingCapitalUsd} ${row.costModel}: ${row.returnPercent.toFixed(2)}%, ending $${row.endingCapitalUsd.toFixed(2)}, DD ${row.maxDrawdownPercent.toFixed(2)}%, ${row.tradeCount} trades\n`);
  }
} else {
  for (const stopLossRoePercent of stopLossRoePercents) {
    const selected = rows.filter((row) => row.leverage === 20 && row.stopLossRoePercent === stopLossRoePercent && row.segment === "full-2025-01-to-2026-07");
    process.stdout.write(`SL ${stopLossRoePercent}%: ${selected.map((row) => `$${row.startingCapitalUsd} ${row.costModel} ${row.returnPercent.toFixed(2)}%, ${row.tradeCount} trades/${row.stopLossCount} stops/${row.liquidationCount} liq`).join(" | ")}\n`);
  }
}
