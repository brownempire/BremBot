import fs from "node:fs";
import path from "node:path";

import {
  BASELINE_COST_MODEL,
  getIndicatorSettings,
  loadCandles,
  prepareIndicators,
  runBacktest,
  type Asset,
  type BacktestResult,
  type FrozenControl,
  type StrategyVariant,
} from "./model";

function list(value: string) {
  return value.split(",").map(Number).filter(Number.isFinite);
}

function arg(name: string, fallback: string) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
}

function parseDate(value: string) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid date: ${value}`);
  return parsed;
}

function compact(result: BacktestResult) {
  const { trades: _trades, dailyEquity: _dailyEquity, variant: _variant, ...summary } = result;
  return summary;
}

function quality(result: BacktestResult) {
  const sampleWeight = Math.min(1, result.tradeCount / 20);
  const pf = Math.min(4, result.profitFactor);
  return sampleWeight * (
    result.returnPercent
    + Math.log1p(Math.max(0, pf)) * 8
    - result.maxDrawdownPercent * 1.5
    - result.liquidationCount * 3
  );
}

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname));
const control = JSON.parse(fs.readFileSync(path.join(root, "frozen-control.json"), "utf8")) as FrozenControl;
const asset = arg("asset", "SOL").toUpperCase() as Asset;
if (!["SOL", "ETH", "BTC"].includes(asset)) throw new Error(`Unsupported asset ${asset}`);
const dataDir = path.resolve(arg("data", path.join(root, "data", "coinbase")));
const outputDir = path.resolve(arg("out", path.join(root, "results", "grid")));
const trendWindows = list(arg("windows", "5,15,30,60"));
const trendThresholds = list(arg("trends", "0.1,0.14,0.2,0.25,0.35,0.5"));
const breakoutThresholds = list(arg("breakouts", "0.1,0.15,0.19,0.25,0.3,0.4"));
const cooldowns = list(arg("cooldowns", "300"));
const useDecisionLayer = arg("decision", "true") !== "false";
const periods = [
  { name: "training", start: parseDate(arg("train-start", "2025-01-01T00:00:00Z")), end: parseDate(arg("train-end", "2025-11-01T00:00:00Z")) },
  { name: "validation", start: parseDate(arg("validation-start", "2025-11-01T00:00:00Z")), end: parseDate(arg("validation-end", "2026-04-01T00:00:00Z")) },
];

fs.mkdirSync(outputDir, { recursive: true });
const candles = loadCandles(path.join(dataDir, `${asset.toLowerCase()}-usd-1m.csv`));
process.stdout.write(`${asset}: preparing indicators for ${candles.length} candles\n`);
const prepared = prepareIndicators(candles, getIndicatorSettings(control.profile), (percent) => {
  process.stdout.write(`${asset}: indicators ${percent}%\n`);
});

const variants: StrategyVariant[] = [];
for (const trendWindow of trendWindows) {
  for (const trendThreshold of trendThresholds) {
    for (const breakoutPercent of breakoutThresholds) {
      for (const cooldownSeconds of cooldowns) {
        variants.push({
          name: `w${trendWindow}-t${trendThreshold}-b${breakoutPercent}-c${cooldownSeconds}`,
          trendWindow,
          trendThreshold,
          breakoutPercent,
          cooldownSeconds,
          useIndicators: true,
          useLearnedConfirmation: true,
          useDecisionLayer,
        });
      }
    }
  }
}

const rows: Array<{
  variant: StrategyVariant;
  training: ReturnType<typeof compact>;
  validation: ReturnType<typeof compact>;
  trainingQuality: number;
  validationQuality: number;
  robustScore: number;
}> = [];

for (let index = 0; index < variants.length; index += 1) {
  const variant = variants[index]!;
  const results = periods.map((period) => runBacktest({
    asset,
    candles,
    preparedIndicators: prepared,
    control,
    variant,
    costs: BASELINE_COST_MODEL,
    startMs: period.start,
    endMs: period.end,
  }));
  const trainingQuality = quality(results[0]!);
  const validationQuality = quality(results[1]!);
  // Selection rewards configurations that survive both samples. The untouched
  // 2026-04-01 onward segment is deliberately never loaded by this runner.
  const robustScore = Math.min(trainingQuality, validationQuality) + 0.25 * (trainingQuality + validationQuality);
  rows.push({
    variant,
    training: compact(results[0]!),
    validation: compact(results[1]!),
    trainingQuality,
    validationQuality,
    robustScore,
  });
  if ((index + 1) % 10 === 0 || index + 1 === variants.length) {
    process.stdout.write(`${asset}: grid ${index + 1}/${variants.length}\n`);
  }
}

rows.sort((a, b) => b.robustScore - a.robustScore);
const output = {
  generatedAt: new Date().toISOString(),
  commit: control.commit,
  asset,
  useDecisionLayer,
  selectionBoundary: "No candles on or after 2026-04-01 are used.",
  costModel: BASELINE_COST_MODEL,
  dimensions: { trendWindows, trendThresholds, breakoutThresholds, cooldowns },
  candidateCount: variants.length,
  rows,
};
const file = path.join(outputDir, `${asset.toLowerCase()}-${useDecisionLayer ? "full-engine" : "no-decision"}.json`);
fs.writeFileSync(file, `${JSON.stringify(output, null, 2)}\n`);
process.stdout.write(`Saved ranked grid to ${file}\n`);
for (const row of rows.slice(0, 12)) {
  process.stdout.write(
    `${row.variant.name}: score ${row.robustScore.toFixed(2)}, `
    + `train ${row.training.returnPercent}%/${row.training.tradeCount} trades, `
    + `validation ${row.validation.returnPercent}%/${row.validation.tradeCount} trades\n`
  );
}
