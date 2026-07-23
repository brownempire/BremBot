import fs from "node:fs";
import path from "node:path";

import {
  BASELINE_COST_MODEL,
  getIndicatorSettings,
  loadCandles,
  prepareIndicators,
  runBacktest,
  type FrozenControl,
  type StrategyVariant,
} from "./model";

function halton(index: number, base: number) {
  let result = 0;
  let fraction = 1 / base;
  let value = index;
  while (value > 0) {
    result += fraction * (value % base);
    value = Math.floor(value / base);
    fraction /= base;
  }
  return result;
}

function choose<T>(values: readonly T[], fraction: number) {
  return values[Math.min(values.length - 1, Math.floor(fraction * values.length))]!;
}

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname));
const frozen = JSON.parse(fs.readFileSync(path.join(root, "frozen-control.json"), "utf8")) as FrozenControl;
const candles = loadCandles(path.join(root, "data", "coinbase", "sol-usd-1m.csv"));
const dimensions = {
  trendWindows: [5, 10, 15],
  trendThresholds: [0.1, 0.125, 0.15, 0.175, 0.2],
  breakoutPercents: [0.45, 0.55, 0.65, 0.75, 0.85],
  cooldowns: [180, 240, 300, 360, 450],
  leverages: [1.5, 2, 2.5, 3],
  takeProfitRoes: [10, 12, 15, 18, 20],
  riskTargets: [0.5, 0.625, 0.75, 0.875, 1],
  stopLossRoes: [8, 10, 12, 15, 18, 20, 25],
};
const primes = [2, 3, 5, 7, 11, 13, 17, 19];
const candidates = new Map<string, {
  trendWindow: number;
  trendThreshold: number;
  breakoutPercent: number;
  cooldownSeconds: number;
  leverage: number;
  takeProfitRoePercent: number;
  targetWalletRiskPercent: number;
  stopLossRoePercent: number;
}>();
for (let index = 1; candidates.size < 384; index += 1) {
  const candidate = {
    trendWindow: choose(dimensions.trendWindows, halton(index, primes[0]!)),
    trendThreshold: choose(dimensions.trendThresholds, halton(index, primes[1]!)),
    breakoutPercent: choose(dimensions.breakoutPercents, halton(index, primes[2]!)),
    cooldownSeconds: choose(dimensions.cooldowns, halton(index, primes[3]!)),
    leverage: choose(dimensions.leverages, halton(index, primes[4]!)),
    takeProfitRoePercent: choose(dimensions.takeProfitRoes, halton(index, primes[5]!)),
    targetWalletRiskPercent: choose(dimensions.riskTargets, halton(index, primes[6]!)),
    stopLossRoePercent: choose(dimensions.stopLossRoes, halton(index, primes[7]!)),
  };
  candidates.set(JSON.stringify(candidate), candidate);
}

const prepared = new Map<number, ReturnType<typeof prepareIndicators>>();
function preparedFor(window: number) {
  const lookback = Math.max(60, window + 35);
  const existing = prepared.get(lookback);
  if (existing) return existing;
  process.stdout.write(`SOL: preparing ${lookback}m indicators\n`);
  const next = prepareIndicators(candles, getIndicatorSettings(frozen.profile), undefined, lookback);
  prepared.set(lookback, next);
  return next;
}

const rows = [];
let complete = 0;
for (const candidate of candidates.values()) {
  const control = structuredClone(frozen);
  control.settings.perpsLeverage = candidate.leverage;
  control.settings.smartTradeProfile = "aggressive";
  control.settings.mode = "all";
  control.profile.leverageCap = candidate.leverage;
  control.profile.takeProfitRoePercent = candidate.takeProfitRoePercent;
  control.profile.targetWalletRiskPercent = candidate.targetWalletRiskPercent;
  const variant: StrategyVariant = {
    name: `plateau-${complete + 1}`,
    trendWindow: candidate.trendWindow,
    trendThreshold: candidate.trendThreshold,
    breakoutPercent: candidate.breakoutPercent,
    cooldownSeconds: candidate.cooldownSeconds,
    useIndicators: true,
    useLearnedConfirmation: true,
    useDecisionLayer: true,
    directionMode: "all",
    indicatorLookbackMinutes: Math.max(60, candidate.trendWindow + 35),
    stopLossRoePercent: candidate.stopLossRoePercent,
  };
  const segments = [
    { name: "development", start: Date.parse("2025-01-01T00:00:00Z"), end: Date.parse("2026-04-01T00:00:00Z") },
    { name: "forward", start: Date.parse("2026-04-01T00:00:00Z"), end: Date.parse("2026-07-20T00:00:00Z") },
  ].map((segment) => {
    const result = runBacktest({
      asset: "SOL",
      candles,
      preparedIndicators: preparedFor(candidate.trendWindow),
      control,
      variant,
      costs: BASELINE_COST_MODEL,
      startMs: segment.start,
      endMs: segment.end,
      startingCapitalUsd: 1_000,
    });
    const { trades: _trades, dailyEquity: _dailyEquity, ...summary } = result;
    return { segment: segment.name, ...summary };
  });
  const development = segments[0]!;
  const forward = segments[1]!;
  const passes = development.returnPercent > 0
    && development.profitFactor > 1
    && development.tradeCount >= 20
    && forward.returnPercent > 0
    && forward.profitFactor > 1
    && forward.tradeCount >= 3;
  const controlled = passes && development.maxDrawdownPercent <= 35 && forward.maxDrawdownPercent <= 35;
  const score = Math.min(development.returnPercent, forward.returnPercent) * 2
    - Math.max(development.maxDrawdownPercent, forward.maxDrawdownPercent)
    + Math.min(3, development.profitFactor) * 5
    + Math.min(3, forward.profitFactor) * 5;
  rows.push({ candidate, passes, controlled, score, segments });
  complete += 1;
  if (complete % 25 === 0 || complete === candidates.size) process.stdout.write(`SOL: plateau ${complete}/${candidates.size}\n`);
}
rows.sort((a, b) => b.score - a.score);
const file = path.join(root, "results", "broad-search", "sol-local-plateau.json");
fs.writeFileSync(file, `${JSON.stringify({
  generatedAt: new Date().toISOString(),
  center: { trendWindow: 10, trendThreshold: 0.15, breakoutPercent: 0.65, cooldownSeconds: 300, leverage: 2, takeProfitRoePercent: 15, targetWalletRiskPercent: 0.75, stopLossRoePercent: 15 },
  methodology: "384 deterministic Halton samples in the local neighborhood. Forward data is diagnostic, not pristine after the earlier study.",
  dimensions,
  passingCount: rows.filter((row) => row.passes).length,
  controlledCount: rows.filter((row) => row.controlled).length,
  rows,
}, null, 2)}\n`);
process.stdout.write(`Saved ${file}; passing=${rows.filter((row) => row.passes).length}, controlled=${rows.filter((row) => row.controlled).length}\n`);
