import fs from "node:fs";
import path from "node:path";

import type { DecisionLearningProfile } from "../../lib/decision/learningTypes";
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

function arg(name: string, fallback: string) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
}

function parseDate(value: string) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error(`Invalid date: ${value}`);
  return timestamp;
}

function resultWithoutTrades(result: BacktestResult) {
  const { trades: _trades, dailyEquity: _dailyEquity, ...summary } = result;
  return summary;
}

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname));
const control = JSON.parse(fs.readFileSync(path.join(root, "frozen-control.json"), "utf8")) as FrozenControl;
const dataDir = path.resolve(arg("data", path.join(root, "data", "coinbase")));
const outputDir = path.resolve(arg("out", path.join(root, "results", "controls")));
const startMs = parseDate(arg("start", "2025-01-01T00:00:00Z"));
const endMs = parseDate(arg("end", "2026-07-20T00:00:00Z"));
const startingCapitalUsd = Number(arg("capital", String(control.startingCapitalUsd)));
if (!Number.isFinite(startingCapitalUsd) || startingCapitalUsd <= 0) throw new Error("Invalid --capital.");
const requestedAssets = arg("assets", "SOL,ETH,BTC").split(",").map((item) => item.trim().toUpperCase()) as Asset[];
const validAssets = requestedAssets.filter((asset): asset is Asset => ["SOL", "ETH", "BTC"].includes(asset));
if (validAssets.length === 0) throw new Error("No valid --assets supplied.");
fs.mkdirSync(outputDir, { recursive: true });

const periods = [
  { name: "full", start: startMs, end: endMs },
  { name: "training", start: Math.max(startMs, parseDate("2025-01-01T00:00:00Z")), end: Math.min(endMs, parseDate("2025-11-01T00:00:00Z")) },
  { name: "validation", start: Math.max(startMs, parseDate("2025-11-01T00:00:00Z")), end: Math.min(endMs, parseDate("2026-04-01T00:00:00Z")) },
  { name: "untouched-test", start: Math.max(startMs, parseDate("2026-04-01T00:00:00Z")), end: endMs },
].filter((period) => period.end > period.start);

const allResults: Array<{ period: string; result: BacktestResult }> = [];

for (const asset of validAssets) {
  const file = path.join(dataDir, `${asset.toLowerCase()}-usd-1m.csv`);
  process.stdout.write(`${asset}: loading ${file}\n`);
  const candles = loadCandles(file);
  process.stdout.write(`${asset}: loaded ${candles.length} validated candles\n`);
  const learned = control.profile.assetAdjustments[asset];
  const variants: StrategyVariant[] = [
    {
      name: "as-deployed",
      trendWindow: control.profile.trendWindow,
      trendThreshold: learned.trendThreshold,
      breakoutPercent: learned.breakoutPercent,
      cooldownSeconds: control.profile.cooldownSeconds,
      useIndicators: true,
      useLearnedConfirmation: true,
      useDecisionLayer: true,
    },
    {
      name: "form-014-019",
      trendWindow: 15,
      trendThreshold: 0.14,
      breakoutPercent: 0.19,
      cooldownSeconds: 180,
      useIndicators: true,
      useLearnedConfirmation: true,
      useDecisionLayer: true,
    },
    {
      name: "balanced-025-025",
      trendWindow: 15,
      trendThreshold: 0.25,
      breakoutPercent: 0.25,
      cooldownSeconds: 300,
      useIndicators: true,
      useLearnedConfirmation: true,
      useDecisionLayer: true,
    },
    {
      name: "selective-035-030",
      trendWindow: 15,
      trendThreshold: 0.35,
      breakoutPercent: 0.3,
      cooldownSeconds: 300,
      useIndicators: true,
      useLearnedConfirmation: true,
      useDecisionLayer: true,
    },
    {
      name: "as-deployed-no-decision-layer",
      trendWindow: control.profile.trendWindow,
      trendThreshold: learned.trendThreshold,
      breakoutPercent: learned.breakoutPercent,
      cooldownSeconds: control.profile.cooldownSeconds,
      useIndicators: true,
      useLearnedConfirmation: true,
      useDecisionLayer: false,
    },
    {
      name: "as-deployed-price-gates-only",
      trendWindow: control.profile.trendWindow,
      trendThreshold: learned.trendThreshold,
      breakoutPercent: learned.breakoutPercent,
      cooldownSeconds: control.profile.cooldownSeconds,
      useIndicators: false,
      useLearnedConfirmation: false,
      useDecisionLayer: false,
    },
  ];
  const indicatorSettings = getIndicatorSettings(control.profile);
  process.stdout.write(`${asset}: preparing production indicator snapshots\n`);
  const prepared = prepareIndicators(candles, indicatorSettings, (percent) => {
    process.stdout.write(`${asset}: indicators ${percent}%\n`);
  });

  for (const period of periods) {
    for (const variant of variants) {
      const result = runBacktest({
        asset,
        candles,
        preparedIndicators: prepared,
        control,
        variant,
        costs: BASELINE_COST_MODEL,
        startMs: period.start,
        endMs: period.end,
        startingCapitalUsd,
      });
      allResults.push({ period: period.name, result });
      process.stdout.write(
        `${asset} ${period.name} ${variant.name}: ${result.tradeCount} trades, `
        + `${result.returnPercent.toFixed(2)}%, PF ${result.profitFactor.toFixed(2)}, `
        + `${result.liquidationCount} liquidations\n`
      );
      fs.writeFileSync(
        path.join(outputDir, `${asset.toLowerCase()}-${period.name}-${variant.name}.json`),
        `${JSON.stringify(result, null, 2)}\n`
      );
    }
  }
}

const summary = {
  generatedAt: new Date().toISOString(),
  commit: control.commit,
  dataDir,
  requestedPeriod: { start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString() },
  startingCapitalUsd,
  costModel: BASELINE_COST_MODEL,
  results: allResults.map(({ period, result }) => ({ segment: period, ...resultWithoutTrades(result) })),
};
fs.writeFileSync(path.join(outputDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
process.stdout.write(`Saved ${allResults.length} control results to ${outputDir}\n`);
