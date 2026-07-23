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
const candles = loadCandles(path.join(root, "data", "coinbase", "sol-usd-1m.csv"));
const prepared = prepareIndicators(candles, getIndicatorSettings(frozen.profile), (percent) => {
  process.stdout.write(`SOL: indicators ${percent}%\n`);
});
const leverages = [3, 5, 8, 10];
const takeProfits = [5, 10, 15, 20];
const stopLosses = [2, 4, 6, 8, 10];
const riskTargets = [0.5, 1, 1.6];
const periods = [
  { name: "training", start: Date.parse("2025-01-01T00:00:00Z"), end: Date.parse("2025-11-01T00:00:00Z") },
  { name: "validation", start: Date.parse("2025-11-01T00:00:00Z"), end: Date.parse("2026-04-01T00:00:00Z") },
];
const rows = [];
const total = leverages.length * takeProfits.length * stopLosses.length * riskTargets.length;
let complete = 0;
for (const leverage of leverages) {
  for (const takeProfitRoePercent of takeProfits) {
    for (const stopLossRoePercent of stopLosses) {
      for (const targetWalletRiskPercent of riskTargets) {
        const control = structuredClone(frozen);
        control.settings.perpsLeverage = leverage;
        control.profile.leverageCap = leverage;
        control.profile.takeProfitRoePercent = takeProfitRoePercent;
        control.profile.targetWalletRiskPercent = targetWalletRiskPercent;
        const variant: StrategyVariant = {
          name: `l${leverage}-tp${takeProfitRoePercent}-sl${stopLossRoePercent}-r${targetWalletRiskPercent}`,
          trendWindow: 15,
          trendThreshold: 0.14,
          breakoutPercent: 0.19,
          cooldownSeconds: 180,
          useIndicators: true,
          useLearnedConfirmation: true,
          useDecisionLayer: true,
          stopLossRoePercent,
        };
        const results = periods.map((period) => runBacktest({
          asset: "SOL",
          candles,
          preparedIndicators: prepared,
          control,
          variant,
          costs: BASELINE_COST_MODEL,
          startMs: period.start,
          endMs: period.end,
        }));
        rows.push({
          leverage,
          takeProfitRoePercent,
          stopLossRoePercent,
          targetWalletRiskPercent,
          variant,
          results: results.map((result, index) => {
            const { trades: _trades, dailyEquity: _dailyEquity, ...summary } = result;
            return { segment: periods[index]!.name, ...summary };
          }),
        });
        complete += 1;
        if (complete % 10 === 0 || complete === total) process.stdout.write(`SOL: stop grid ${complete}/${total}\n`);
      }
    }
  }
}

const outputDir = path.join(root, "results", "stop-grid");
fs.mkdirSync(outputDir, { recursive: true });
const file = path.join(outputDir, "sol-counterfactual.json");
fs.writeFileSync(file, `${JSON.stringify({
  generatedAt: new Date().toISOString(),
  commit: frozen.commit,
  label: "Research-only counterfactual; current production suppresses stop losses.",
  selectionBoundary: "No candles on or after 2026-04-01 are used.",
  dimensions: { leverages, takeProfits, stopLosses, riskTargets },
  rows,
}, null, 2)}\n`);
process.stdout.write(`Saved ${file}\n`);
