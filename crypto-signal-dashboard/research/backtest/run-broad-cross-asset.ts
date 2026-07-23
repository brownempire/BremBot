import fs from "node:fs";
import path from "node:path";

import {
  BASELINE_COST_MODEL,
  getIndicatorSettings,
  loadCandles,
  prepareIndicators,
  runBacktest,
  type Asset,
  type FrozenControl,
  type StrategyVariant,
} from "./model";

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
const searchFile = path.join(root, "results", "broad-search", "sol-development.json");
const search = JSON.parse(fs.readFileSync(searchFile, "utf8")) as {
  rows: Array<{ candidate: Candidate; robustScore: number; positiveFoldCount: number }>;
};
const selected = search.rows.filter((row) => row.positiveFoldCount >= 3).slice(0, 30);
const assets: Asset[] = ["SOL", "ETH", "BTC"];
const candles = new Map(assets.map((asset) => [
  asset,
  loadCandles(path.join(root, "data", "coinbase", `${asset.toLowerCase()}-usd-1m.csv`)),
]));
const prepared = new Map<string, ReturnType<typeof prepareIndicators>>();

function preparedFor(asset: Asset, candidate: Candidate) {
  const lookback = Math.min(240, Math.max(60, candidate.trendWindow + 35));
  const key = `${asset}:${lookback}`;
  const existing = prepared.get(key);
  if (existing) return existing;
  process.stdout.write(`${asset}: preparing ${lookback}m indicators\n`);
  const next = prepareIndicators(candles.get(asset)!, getIndicatorSettings(frozen.profile), undefined, lookback);
  prepared.set(key, next);
  return next;
}

const rows = selected.map((selection, index) => {
  const candidate = selection.candidate;
  const control = structuredClone(frozen);
  control.settings.perpsLeverage = candidate.leverage;
  control.settings.smartTradeProfile = candidate.smartTradeProfile;
  control.settings.mode = candidate.directionMode;
  control.profile.leverageCap = candidate.leverage;
  control.profile.takeProfitRoePercent = candidate.takeProfitRoePercent;
  control.profile.targetWalletRiskPercent = candidate.targetWalletRiskPercent;
  const variant: StrategyVariant = {
    name: `cross-asset-${index + 1}`,
    trendWindow: candidate.trendWindow,
    trendThreshold: candidate.trendThreshold,
    breakoutPercent: candidate.breakoutPercent,
    cooldownSeconds: candidate.cooldownSeconds,
    useIndicators: true,
    useLearnedConfirmation: true,
    useDecisionLayer: true,
    directionMode: candidate.directionMode,
    indicatorLookbackMinutes: Math.min(240, Math.max(60, candidate.trendWindow + 35)),
  };
  const results = assets.flatMap((asset) => [
    { name: "development", start: Date.parse("2025-01-01T00:00:00Z"), end: Date.parse("2026-04-01T00:00:00Z") },
    { name: "forward", start: Date.parse("2026-04-01T00:00:00Z"), end: Date.parse("2026-07-20T00:00:00Z") },
  ].map((period) => {
    const result = runBacktest({
      asset,
      candles: candles.get(asset)!,
      preparedIndicators: preparedFor(asset, candidate),
      control,
      variant,
      costs: BASELINE_COST_MODEL,
      startMs: period.start,
      endMs: period.end,
      startingCapitalUsd: 1_000,
    });
    const { trades: _trades, dailyEquity: _dailyEquity, ...summary } = result;
    return { segment: period.name, ...summary };
  }));
  const profitableMarkets = assets.filter((asset) => results
    .filter((result) => result.asset === asset)
    .every((result) => result.returnPercent > 0 && result.profitFactor > 1)).length;
  process.stdout.write(`candidate ${index + 1}/${selected.length}: profitable across both segments in ${profitableMarkets}/3 assets\n`);
  return { candidate, solDevelopmentScore: selection.robustScore, profitableMarkets, results };
});
rows.sort((a, b) => b.profitableMarkets - a.profitableMarkets || b.solDevelopmentScore - a.solDevelopmentScore);
const file = path.join(root, "results", "broad-search", "cross-asset.json");
fs.writeFileSync(file, `${JSON.stringify({
  generatedAt: new Date().toISOString(),
  source: searchFile,
  selection: "Top 30 SOL development candidates with at least three positive folds.",
  rows,
}, null, 2)}\n`);
process.stdout.write(`Saved ${file}\n`);
