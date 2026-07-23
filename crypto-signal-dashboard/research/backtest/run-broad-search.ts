import fs from "node:fs";
import path from "node:path";

import {
  BASELINE_COST_MODEL,
  getIndicatorSettings,
  loadCandles,
  prepareIndicators,
  runBacktest,
  type BacktestResult,
  type FrozenControl,
  type StrategyVariant,
} from "./model";

function arg(name: string, fallback: string) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
}

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

function compact(result: BacktestResult) {
  const { trades: _trades, dailyEquity: _dailyEquity, variant: _variant, ...summary } = result;
  return summary;
}

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function quality(result: BacktestResult) {
  if (result.tradeCount < 5) return -250;
  return result.returnPercent
    - 1.2 * result.maxDrawdownPercent
    + 10 * Math.log1p(Math.min(4, result.profitFactor))
    + 2 * result.sharpeRatio;
}

type Candidate = {
  trendWindow: number;
  trendThreshold: number;
  breakoutPercent: number;
  cooldownSeconds: number;
  leverage: number;
  takeProfitRoePercent: number;
  targetWalletRiskPercent: number;
  smartTradeProfile: "conservative" | "balanced" | "aggressive";
  directionMode: "all" | "buy-only";
};

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname));
const frozen = JSON.parse(fs.readFileSync(path.join(root, "frozen-control.json"), "utf8")) as FrozenControl;
const dataDir = path.resolve(arg("data", path.join(root, "data", "coinbase")));
const outputDir = path.resolve(arg("out", path.join(root, "results", "broad-search")));
const requestedCount = Math.max(64, Number(arg("count", "512")));
const startingCapitalUsd = Number(arg("capital", "1000"));

const dimensions = {
  trendWindows: [5, 10, 15, 20, 30, 45, 60, 90, 120, 180],
  trendThresholds: [0.1, 0.15, 0.2, 0.3, 0.4, 0.5, 0.65, 0.8, 1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 7.5, 10],
  breakoutPercents: [0.1, 0.15, 0.2, 0.3, 0.4, 0.5, 0.65, 0.8, 1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 6, 8],
  cooldowns: [5, 30, 60, 120, 180, 300, 450, 600, 900],
  leverages: [2, 3, 5, 8, 10, 15, 20, 30, 40, 50, 75, 100, 125],
  takeProfitRoes: [5, 8, 10, 12, 15, 20, 25, 30, 40, 50],
  targetWalletRisks: [0.25, 0.5, 0.75, 1, 1.6, 2, 3, 5],
  smartTradeProfiles: ["conservative", "balanced", "aggressive"] as const,
  directionModes: ["all", "buy-only"] as const,
};
const primes = [2, 3, 5, 7, 11, 13, 17, 19, 23];
const candidates = new Map<string, Candidate>();
for (let index = 1; candidates.size < requestedCount; index += 1) {
  const candidate: Candidate = {
    trendWindow: choose(dimensions.trendWindows, halton(index, primes[0]!)),
    trendThreshold: choose(dimensions.trendThresholds, halton(index, primes[1]!)),
    breakoutPercent: choose(dimensions.breakoutPercents, halton(index, primes[2]!)),
    cooldownSeconds: choose(dimensions.cooldowns, halton(index, primes[3]!)),
    leverage: choose(dimensions.leverages, halton(index, primes[4]!)),
    takeProfitRoePercent: choose(dimensions.takeProfitRoes, halton(index, primes[5]!)),
    targetWalletRiskPercent: choose(dimensions.targetWalletRisks, halton(index, primes[6]!)),
    smartTradeProfile: choose(dimensions.smartTradeProfiles, halton(index, primes[7]!)),
    directionMode: choose(dimensions.directionModes, halton(index, primes[8]!)),
  };
  candidates.set(JSON.stringify(candidate), candidate);
}

const folds = [
  { name: "2025-early", start: Date.parse("2025-01-01T00:00:00Z"), end: Date.parse("2025-05-01T00:00:00Z") },
  { name: "2025-mid", start: Date.parse("2025-05-01T00:00:00Z"), end: Date.parse("2025-09-01T00:00:00Z") },
  { name: "2025-late", start: Date.parse("2025-09-01T00:00:00Z"), end: Date.parse("2026-01-01T00:00:00Z") },
  { name: "2026-validation", start: Date.parse("2026-01-01T00:00:00Z"), end: Date.parse("2026-04-01T00:00:00Z") },
];

fs.mkdirSync(outputDir, { recursive: true });
const candles = loadCandles(path.join(dataDir, "sol-usd-1m.csv"));
const grouped = new Map<number, Candidate[]>();
for (const candidate of candidates.values()) {
  const group = grouped.get(candidate.trendWindow) ?? [];
  group.push(candidate);
  grouped.set(candidate.trendWindow, group);
}
const rows = [];
let complete = 0;
for (const [trendWindow, group] of [...grouped.entries()].sort((a, b) => a[0] - b[0])) {
  const indicatorLookbackMinutes = Math.min(240, Math.max(60, trendWindow + 35));
  process.stdout.write(`SOL: preparing ${indicatorLookbackMinutes}m indicator history for ${group.length} candidates\n`);
  const prepared = prepareIndicators(candles, getIndicatorSettings(frozen.profile), undefined, indicatorLookbackMinutes);
  for (const candidate of group) {
    const control = structuredClone(frozen);
    control.settings.perpsLeverage = candidate.leverage;
    control.settings.smartTradeProfile = candidate.smartTradeProfile;
    control.settings.mode = candidate.directionMode;
    control.profile.leverageCap = candidate.leverage;
    control.profile.takeProfitRoePercent = candidate.takeProfitRoePercent;
    control.profile.targetWalletRiskPercent = candidate.targetWalletRiskPercent;
    const variant: StrategyVariant = {
      name: `broad-${complete + 1}`,
      trendWindow: candidate.trendWindow,
      trendThreshold: candidate.trendThreshold,
      breakoutPercent: candidate.breakoutPercent,
      cooldownSeconds: candidate.cooldownSeconds,
      useIndicators: true,
      useLearnedConfirmation: true,
      useDecisionLayer: true,
      directionMode: candidate.directionMode,
      indicatorLookbackMinutes,
    };
    const detailed = folds.map((fold) => runBacktest({
      asset: "SOL",
      candles,
      preparedIndicators: prepared,
      control,
      variant,
      costs: BASELINE_COST_MODEL,
      startMs: fold.start,
      endMs: fold.end,
      startingCapitalUsd,
    }));
    const qualities = detailed.map(quality);
    const returns = detailed.map((result) => result.returnPercent);
    const robustScore = Math.min(...qualities) * 1.5
      + median(qualities)
      + detailed.filter((result) => result.returnPercent > 0 && result.profitFactor > 1).length * 5
      - (Math.max(...returns) - Math.min(...returns)) * 0.1;
    rows.push({
      candidate,
      variant,
      robustScore,
      positiveFoldCount: detailed.filter((result) => result.returnPercent > 0).length,
      profitableFoldCount: detailed.filter((result) => result.returnPercent > 0 && result.profitFactor > 1).length,
      worstReturnPercent: Math.min(...returns),
      medianReturnPercent: median(returns),
      results: detailed.map((result, index) => ({ segment: folds[index]!.name, ...compact(result) })),
    });
    complete += 1;
    if (complete % 25 === 0 || complete === candidates.size) process.stdout.write(`SOL: broad search ${complete}/${candidates.size}\n`);
  }
}
rows.sort((a, b) => b.robustScore - a.robustScore);
const file = path.join(outputDir, "sol-development.json");
fs.writeFileSync(file, `${JSON.stringify({
  generatedAt: new Date().toISOString(),
  commit: frozen.commit,
  methodology: "Deterministic Halton coverage of the joint UI-valid parameter space; four chronological development folds; no post-2026-04-01 candles loaded.",
  startingCapitalUsd,
  dimensions,
  candidateCount: candidates.size,
  folds,
  rows,
}, null, 2)}\n`);
process.stdout.write(`Saved ${file}\n`);
for (const row of rows.slice(0, 20)) {
  process.stdout.write(`${JSON.stringify(row.candidate)} score=${row.robustScore.toFixed(2)} folds=${row.profitableFoldCount}/4 worst=${row.worstReturnPercent.toFixed(2)} median=${row.medianReturnPercent.toFixed(2)}\n`);
}
