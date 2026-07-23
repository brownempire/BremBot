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

function arg(name: string, fallback: string) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
}

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname));
const control = JSON.parse(fs.readFileSync(path.join(root, "frozen-control.json"), "utf8")) as FrozenControl;
const asset = arg("asset", "SOL").toUpperCase() as Asset;
if (!["SOL", "ETH", "BTC"].includes(asset)) throw new Error(`Unsupported asset ${asset}`);
const gridFile = path.resolve(arg("grid", path.join(root, "results", "grid", `${asset.toLowerCase()}-full-engine.json`)));
const dataDir = path.resolve(arg("data", path.join(root, "data", "coinbase")));
const outputDir = path.resolve(arg("out", path.join(root, "results", "sealed-test")));
const top = Math.max(1, Number(arg("top", "12")));
const grid = JSON.parse(fs.readFileSync(gridFile, "utf8")) as { rows: Array<{ variant: StrategyVariant }> };
const learned = control.profile.assetAdjustments[asset];
const controls: StrategyVariant[] = [
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
    name: "visible-form-parameters",
    trendWindow: control.params.trendWindow,
    trendThreshold: control.params.trendThreshold,
    breakoutPercent: control.params.breakoutPercent,
    cooldownSeconds: control.params.cooldownSeconds,
    useIndicators: true,
    useLearnedConfirmation: true,
    useDecisionLayer: true,
  },
];
const selected = [...controls, ...grid.rows.slice(0, top).map((row) => row.variant)];
const unique = [...new Map(selected.map((variant) => [JSON.stringify({
  trendWindow: variant.trendWindow,
  trendThreshold: variant.trendThreshold,
  breakoutPercent: variant.breakoutPercent,
  cooldownSeconds: variant.cooldownSeconds,
  useIndicators: variant.useIndicators,
  useLearnedConfirmation: variant.useLearnedConfirmation,
  useDecisionLayer: variant.useDecisionLayer,
}), variant])).values()];

fs.mkdirSync(outputDir, { recursive: true });
const candles = loadCandles(path.join(dataDir, `${asset.toLowerCase()}-usd-1m.csv`));
const prepared = prepareIndicators(candles, getIndicatorSettings(control.profile), (percent) => {
  process.stdout.write(`${asset}: indicators ${percent}%\n`);
});
const startMs = Date.parse("2026-04-01T00:00:00Z");
const endMs = Date.parse("2026-07-20T00:00:00Z");
const results: BacktestResult[] = unique.map((variant) => runBacktest({
  asset,
  candles,
  preparedIndicators: prepared,
  control,
  variant,
  costs: BASELINE_COST_MODEL,
  startMs,
  endMs,
}));

const file = path.join(outputDir, `${asset.toLowerCase()}-selected.json`);
fs.writeFileSync(file, `${JSON.stringify({
  generatedAt: new Date().toISOString(),
  commit: control.commit,
  selectionSource: gridFile,
  sealedPeriod: { start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString() },
  selectionRule: `Two frozen controls plus the first ${top} training/validation-ranked configurations; test results never alter membership.`,
  results,
}, null, 2)}\n`);
process.stdout.write(`Saved ${results.length} sealed results to ${file}\n`);
for (const result of results) {
  process.stdout.write(
    `${result.variant.name}: ${result.tradeCount} trades, ${result.returnPercent}% return, `
    + `${result.maxDrawdownPercent}% max DD, PF ${result.profitFactor}\n`
  );
}
