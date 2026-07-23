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

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname));
const frozen = JSON.parse(fs.readFileSync(path.join(root, "frozen-control.json"), "utf8")) as FrozenControl;
const gridFile = path.join(root, "results", "risk-grid", "sol-visible-form-risk-grid.json");
const grid = JSON.parse(fs.readFileSync(gridFile, "utf8")) as {
  variant: StrategyVariant;
  rows: Array<{
    leverage: number;
    takeProfitRoePercent: number;
    targetWalletRiskPercent: number;
    results: Array<{ returnPercent: number; profitFactor: number }>;
  }>;
};
const selected = grid.rows.filter((row) => (
  row.results.every((result) => result.returnPercent > 0 && result.profitFactor > 1)
));
if (selected.length === 0) throw new Error("No risk configurations passed the predeclared training/validation filter.");

const candles = loadCandles(path.join(root, "data", "coinbase", "sol-usd-1m.csv"));
const prepared = prepareIndicators(candles, getIndicatorSettings(frozen.profile), (percent) => {
  process.stdout.write(`SOL: indicators ${percent}%\n`);
});
const rows = selected.map((selection) => {
  const control = structuredClone(frozen);
  control.settings.perpsLeverage = selection.leverage;
  control.profile.leverageCap = selection.leverage;
  control.profile.takeProfitRoePercent = selection.takeProfitRoePercent;
  control.profile.targetWalletRiskPercent = selection.targetWalletRiskPercent;
  const result = runBacktest({
    asset: "SOL",
    candles,
    preparedIndicators: prepared,
    control,
    variant: grid.variant,
    costs: BASELINE_COST_MODEL,
    startMs: Date.parse("2026-04-01T00:00:00Z"),
    endMs: Date.parse("2026-07-20T00:00:00Z"),
  });
  process.stdout.write(
    `${selection.leverage}x TP${selection.takeProfitRoePercent} risk${selection.targetWalletRiskPercent}: `
    + `${result.returnPercent}% return, ${result.maxDrawdownPercent}% max DD, PF ${result.profitFactor}\n`
  );
  return { selection, result };
});

const file = path.join(root, "results", "sealed-test", "sol-risk-selected.json");
fs.writeFileSync(file, `${JSON.stringify({
  generatedAt: new Date().toISOString(),
  commit: frozen.commit,
  selectionSource: gridFile,
  selectionRule: "All configurations profitable with profit factor above one in both training and validation; sealed results do not alter membership.",
  rows,
}, null, 2)}\n`);
process.stdout.write(`Saved ${file}\n`);
