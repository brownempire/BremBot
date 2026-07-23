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

type Candidate = {
  trendWindow: number;
  trendThreshold: number;
  breakoutPercent: number;
  cooldownSeconds: number;
  emaFast: number;
  emaSlow: number;
  useSolFourHourRegime: boolean;
  btcConfirmation: "none" | "1h" | "1h+4h";
  takeProfitRoePercent: number;
  stopLossRoePercent: number;
  leverage: number;
  targetWalletRiskPercent?: number;
  dynamicLeverage?: NonNullable<StrategyVariant["dynamicLeverage"]>;
};

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

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function quality(result: BacktestResult) {
  if (result.tradeCount < 5) return -300;
  return result.returnPercent
    - 1.35 * result.maxDrawdownPercent
    + 9 * Math.log1p(Math.min(4, result.profitFactor))
    + 1.5 * result.sharpeRatio;
}

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
const searchMode = process.env.SOL_SEARCH_MODE ?? "default";
const monthlyMode = searchMode === "monthly";
const dynamicMode = searchMode === "dynamic-leverage";
const adaptiveJointMode = searchMode === "adaptive-joint";
const adaptiveLocalMode = searchMode === "adaptive-local";
const adaptiveAggressiveMode = searchMode === "adaptive-aggressive";
const adaptiveAggressiveLocalMode = searchMode === "adaptive-aggressive-local";
const adaptiveHybridMode = searchMode === "adaptive-hybrid";
const adaptiveRiskLadderMode = searchMode === "adaptive-risk-ladder";
const aggressiveSearchMode = adaptiveAggressiveMode || adaptiveAggressiveLocalMode || adaptiveHybridMode;
const adaptiveSearchMode = adaptiveJointMode || adaptiveLocalMode || aggressiveSearchMode;
const focusedMode = monthlyMode || dynamicMode || adaptiveSearchMode || adaptiveRiskLadderMode;
const twelveMonthMode = process.env.SOL_TEST_MONTHS === "12";
const frozen = JSON.parse(fs.readFileSync(path.join(root, "frozen-control.json"), "utf8")) as FrozenControl;
const solMinute = loadCandles(path.join(root, "data", "coinbase", "sol-usd-1m.csv"));
const btcMinute = loadCandles(path.join(root, "data", "coinbase", "btc-usd-1m.csv"));
const solEntry = resample(solMinute, 15);
const solHour = resample(solMinute, 60);
const solFourHour = resample(solMinute, 240);
const btcHour = resample(btcMinute, 60);
const btcFourHour = resample(btcMinute, 240);
const preparedIndicators = prepareIndicators(solEntry, getIndicatorSettings(frozen.profile), undefined, 900, 15);

const dimensions = {
  trendWindows: [60, 75, 90, 120, 150, 180],
  trendThresholds: [0.3, 0.4, 0.5, 0.65, 0.8, 1, 1.25],
  breakoutPercents: [0.25, 0.35, 0.5, 0.65, 0.8, 1, 1.25, 1.5],
  cooldownSeconds: [1_800, 3_600, 7_200, 10_800, 14_400],
  emaPairs: [{ fast: 5, slow: 13 }, { fast: 8, slow: 21 }, { fast: 9, slow: 21 }, { fast: 12, slow: 26 }],
  solFourHourRegime: [false, true],
  btcConfirmation: ["none", "1h", "1h+4h"] as const,
  takeProfitRoePercents: [15, 20, 25, 30, 40, 50],
  stopLossRoePercents: [3, 5, 7, 10, 15, 20, 25, 30, 40, 50],
  leverages: [1.5, 2, 2.5, 3, 4, 5],
};
const primes = [2, 3, 5, 7, 11, 13, 17, 19, 23, 29];
const candidates = new Map<string, Candidate>();
const previousSolCandidate: Candidate = {
  trendWindow: 120,
  trendThreshold: 0.65,
  breakoutPercent: 0.5,
  cooldownSeconds: 7_200,
  emaFast: 5,
  emaSlow: 13,
  useSolFourHourRegime: false,
  btcConfirmation: "1h+4h",
  takeProfitRoePercent: 25,
  stopLossRoePercent: 15,
  leverage: 2,
};
candidates.set(JSON.stringify(previousSolCandidate), previousSolCandidate);
const broadCandidateTarget = focusedMode ? 1 : 4_096;
for (let index = 1; candidates.size < broadCandidateTarget; index += 1) {
  const pair = choose(dimensions.emaPairs, halton(index, primes[4]!));
  const candidate: Candidate = {
    trendWindow: choose(dimensions.trendWindows, halton(index, primes[0]!)),
    trendThreshold: choose(dimensions.trendThresholds, halton(index, primes[1]!)),
    breakoutPercent: choose(dimensions.breakoutPercents, halton(index, primes[2]!)),
    cooldownSeconds: choose(dimensions.cooldownSeconds, halton(index, primes[3]!)),
    emaFast: pair.fast,
    emaSlow: pair.slow,
    useSolFourHourRegime: choose(dimensions.solFourHourRegime, halton(index, primes[5]!)),
    btcConfirmation: choose(dimensions.btcConfirmation, halton(index, primes[6]!)),
    takeProfitRoePercent: choose(dimensions.takeProfitRoePercents, halton(index, primes[7]!)),
    stopLossRoePercent: choose(dimensions.stopLossRoePercents, halton(index, primes[8]!)),
    leverage: choose(dimensions.leverages, halton(index, primes[9]!)),
  };
  candidates.set(JSON.stringify(candidate), candidate);
}

const folds = twelveMonthMode ? [
  { name: "2025-q3", start: Date.parse("2025-07-01T00:00:00Z"), end: Date.parse("2025-10-01T00:00:00Z") },
  { name: "2025-q4", start: Date.parse("2025-10-01T00:00:00Z"), end: Date.parse("2026-01-01T00:00:00Z") },
  { name: "2026-q1a", start: Date.parse("2026-01-01T00:00:00Z"), end: Date.parse("2026-02-15T00:00:00Z") },
  { name: "2026-q1b", start: Date.parse("2026-02-15T00:00:00Z"), end: Date.parse("2026-04-01T00:00:00Z") },
] : [
  { name: "2025-early", start: Date.parse("2025-01-01T00:00:00Z"), end: Date.parse("2025-05-01T00:00:00Z") },
  { name: "2025-mid", start: Date.parse("2025-05-01T00:00:00Z"), end: Date.parse("2025-09-01T00:00:00Z") },
  { name: "2025-late", start: Date.parse("2025-09-01T00:00:00Z"), end: Date.parse("2026-01-01T00:00:00Z") },
  { name: "2026-validation", start: Date.parse("2026-01-01T00:00:00Z"), end: Date.parse("2026-04-01T00:00:00Z") },
];
const analysisStart = Date.parse(twelveMonthMode ? "2025-07-01T00:00:00Z" : "2025-01-01T00:00:00Z");
const forward = {
  start: Date.parse("2026-04-01T00:00:00Z"),
  end: Date.parse(twelveMonthMode ? "2026-07-01T00:00:00Z" : "2026-07-20T00:00:00Z"),
};
const stress: CostModel = {
  ...BASELINE_COST_MODEL,
  name: "stress-costs",
  priceImpactFeeRate: 0.0005,
  slippageBps: 10,
  networkCostUsd: 0.1,
  borrowRateMultiplier: 3,
};

const projectionCache = new Map<string, { bull: Uint8Array; bear: Uint8Array }>();
function cachedProjection(market: "sol" | "btc", timeframe: "1h" | "4h", fast: number, slow: number) {
  const key = `${market}/${timeframe}/${fast}/${slow}`;
  const cached = projectionCache.get(key);
  if (cached) return cached;
  const source = market === "sol"
    ? timeframe === "1h" ? solHour : solFourHour
    : timeframe === "1h" ? btcHour : btcFourHour;
  const result = project(solEntry, source, emaAlignment(source, fast, slow));
  projectionCache.set(key, result);
  return result;
}

const qualificationCache = new Map<string, { bullQualified: Uint8Array; bearQualified: Uint8Array }>();
function qualification(candidate: Candidate) {
  const key = `${candidate.emaFast}/${candidate.emaSlow}/${candidate.useSolFourHourRegime}/${candidate.btcConfirmation}`;
  const cached = qualificationCache.get(key);
  if (cached) return cached;
  const sol1h = cachedProjection("sol", "1h", candidate.emaFast, candidate.emaSlow);
  let result = { bullQualified: sol1h.bull, bearQualified: sol1h.bear };
  if (candidate.useSolFourHourRegime) result = intersect(result, cachedProjection("sol", "4h", candidate.emaFast, candidate.emaSlow));
  if (candidate.btcConfirmation !== "none") result = intersect(result, cachedProjection("btc", "1h", candidate.emaFast, candidate.emaSlow));
  if (candidate.btcConfirmation === "1h+4h") result = intersect(result, cachedProjection("btc", "4h", candidate.emaFast, candidate.emaSlow));
  qualificationCache.set(key, result);
  return result;
}

function buildControl(candidate: Candidate) {
  const control = structuredClone(frozen);
  const leverageCap = candidate.dynamicLeverage?.maximum ?? candidate.leverage;
  control.settings.perpsLeverage = leverageCap;
  control.settings.smartTradeProfile = "aggressive";
  control.settings.mode = "all";
  control.profile.leverageCap = leverageCap;
  control.profile.takeProfitRoePercent = candidate.takeProfitRoePercent;
  control.profile.stopLossRoePercent = candidate.stopLossRoePercent;
  control.profile.targetWalletRiskPercent = candidate.targetWalletRiskPercent ?? 0.75;
  return control;
}

function buildVariant(candidate: Candidate, name: string): StrategyVariant {
  return {
    name,
    trendWindow: candidate.trendWindow,
    trendThreshold: candidate.trendThreshold,
    breakoutPercent: candidate.breakoutPercent,
    cooldownSeconds: candidate.cooldownSeconds,
    useIndicators: true,
    useLearnedConfirmation: true,
    useDecisionLayer: true,
    directionMode: "all",
    indicatorLookbackMinutes: 900,
    stopLossRoePercent: candidate.stopLossRoePercent,
    stopLossCooldownSeconds: candidate.cooldownSeconds,
    dynamicLeverage: candidate.dynamicLeverage,
  };
}

const developmentRows = [];
let completed = 0;
for (const candidate of candidates.values()) {
  const control = buildControl(candidate);
  const variant = buildVariant(candidate, `sol-joint-risk-${completed + 1}`);
  const results = folds.map((fold) => runBacktest({
    asset: "SOL",
    candles: solEntry,
    preparedIndicators,
    higherTimeframeQualification: qualification(candidate),
    control,
    variant,
    costs: BASELINE_COST_MODEL,
    startMs: fold.start,
    endMs: fold.end,
    startingCapitalUsd: 1_000,
  }));
  const qualities = results.map(quality);
  const returns = results.map((result) => result.returnPercent);
  const profitableFoldCount = results.filter((result) => result.returnPercent > 0 && result.profitFactor > 1).length;
  const worstDrawdownPercent = Math.max(...results.map((result) => result.maxDrawdownPercent));
  const totalTrades = results.reduce((sum, result) => sum + result.tradeCount, 0);
  const robustScore = Math.min(...qualities) * 1.8
    + median(qualities)
    + profitableFoldCount * 8
    - (Math.max(...returns) - Math.min(...returns)) * 0.15
    - Math.max(0, worstDrawdownPercent - 35) * 2;
  developmentRows.push({
    candidate,
    robustScore,
    profitableFoldCount,
    worstReturnPercent: Math.min(...returns),
    medianReturnPercent: median(returns),
    averageReturnPercent: returns.reduce((sum, value) => sum + value, 0) / returns.length,
    worstDrawdownPercent,
    totalTrades,
    results: results.map((result, index) => ({ segment: folds[index]!.name, ...compact(result) })),
  });
  completed += 1;
  if (completed % 128 === 0 || completed === candidates.size) process.stdout.write(`SOL joint search ${completed}/${candidates.size}\n`);
}
developmentRows.sort((left, right) => right.robustScore - left.robustScore);

const strictSurvivors = developmentRows.filter((row) =>
  row.profitableFoldCount === 4
  && row.worstDrawdownPercent <= 40
  && row.totalTrades >= 40
  && row.results.every((result) => result.tradeCount >= 5)
);
const confirmationLeaders = (strictSurvivors.length > 0
  ? strictSurvivors
  : developmentRows.filter((row) => row.profitableFoldCount === 4)
).slice(0, 100);
const previousCandidateRow = developmentRows.find((row) => JSON.stringify(row.candidate) === JSON.stringify(previousSolCandidate));
if (previousCandidateRow && !confirmationLeaders.includes(previousCandidateRow)) confirmationLeaders.push(previousCandidateRow);
const confirmationRows = [];
const developmentStressRows = [];
for (let index = 0; index < confirmationLeaders.length; index += 1) {
  const development = confirmationLeaders[index]!;
  const control = buildControl(development.candidate);
  const variant = buildVariant(development.candidate, `sol-joint-confirmation-${index + 1}`);
  for (const costs of [BASELINE_COST_MODEL, stress]) {
    const result = runBacktest({
      asset: "SOL",
      candles: solEntry,
      preparedIndicators,
      higherTimeframeQualification: qualification(development.candidate),
      control,
      variant,
      costs,
      startMs: forward.start,
      endMs: forward.end,
      startingCapitalUsd: 1_000,
    });
    confirmationRows.push({
      developmentRank: developmentRows.indexOf(development) + 1,
      strictDevelopmentSurvivor: strictSurvivors.includes(development),
      candidate: development.candidate,
      ...compact(result),
    });
  }
  for (const fold of folds) {
    const result = runBacktest({
      asset: "SOL",
      candles: solEntry,
      preparedIndicators,
      higherTimeframeQualification: qualification(development.candidate),
      control,
      variant,
      costs: stress,
      startMs: fold.start,
      endMs: fold.end,
      startingCapitalUsd: 1_000,
    });
    developmentStressRows.push({
      developmentRank: developmentRows.indexOf(development) + 1,
      candidate: development.candidate,
      segment: fold.name,
      ...compact(result),
    });
  }
  if ((index + 1) % 20 === 0 || index + 1 === confirmationLeaders.length) process.stdout.write(`SOL confirmation ${index + 1}/${confirmationLeaders.length}\n`);
}

const confirmed = confirmationLeaders.flatMap((development) => {
  const developmentRank = developmentRows.indexOf(development) + 1;
  const baseline = confirmationRows.find((row) => row.developmentRank === developmentRank && row.costModel === BASELINE_COST_MODEL.name);
  const stressed = confirmationRows.find((row) => row.developmentRank === developmentRank && row.costModel === stress.name);
  const developmentStress = developmentStressRows.filter((row) => row.developmentRank === developmentRank);
  return baseline && stressed ? [{
    developmentRank,
    candidate: development.candidate,
    development: {
      robustScore: development.robustScore,
      worstReturnPercent: development.worstReturnPercent,
      medianReturnPercent: development.medianReturnPercent,
      averageReturnPercent: development.averageReturnPercent,
      worstDrawdownPercent: development.worstDrawdownPercent,
      totalTrades: development.totalTrades,
    },
    forward: baseline,
    stress: stressed,
    confirmed: baseline.returnPercent > 0 && baseline.profitFactor > 1 && stressed.returnPercent > 0 && stressed.profitFactor > 1,
    developmentStress: developmentStress.map((row) => ({ segment: row.segment, ...row })),
    profitableDevelopmentStressFolds: developmentStress.filter((row) => row.returnPercent > 0 && row.profitFactor > 1).length,
    fullyStressConfirmed: baseline.returnPercent > 0
      && baseline.profitFactor > 1
      && stressed.returnPercent > 0
      && stressed.profitFactor > 1
      && developmentStress.length === folds.length
      && developmentStress.every((row) => row.returnPercent > 0 && row.profitFactor > 1),
  }] : [];
}).sort((left, right) => {
  if (left.fullyStressConfirmed !== right.fullyStressConfirmed) return Number(right.fullyStressConfirmed) - Number(left.fullyStressConfirmed);
  if (left.confirmed !== right.confirmed) return Number(right.confirmed) - Number(left.confirmed);
  if (left.profitableDevelopmentStressFolds !== right.profitableDevelopmentStressFolds) return right.profitableDevelopmentStressFolds - left.profitableDevelopmentStressFolds;
  if (left.stress.returnPercent !== right.stress.returnPercent) return right.stress.returnPercent - left.stress.returnPercent;
  if (left.development.worstDrawdownPercent !== right.development.worstDrawdownPercent) return left.development.worstDrawdownPercent - right.development.worstDrawdownPercent;
  return left.developmentRank - right.developmentRank;
});

const preservationMode = searchMode === "preservation";
const localDimensions = preservationMode ? {
  trendWindows: [75, 90, 120, 150],
  trendThresholds: [0.65, 0.8, 1, 1.25],
  breakoutPercents: [0.5, 0.65, 0.8, 1],
  cooldownSeconds: [7_200, 10_800, 14_400, 21_600, 28_800],
  emaPairs: [{ fast: 5, slow: 13 }, { fast: 8, slow: 21 }, { fast: 9, slow: 21 }],
  solFourHourRegime: [false, true],
  btcConfirmation: ["none", "1h", "1h+4h"] as const,
  takeProfitRoePercents: [5, 7, 10, 12, 15, 20, 25],
  stopLossRoePercents: [3, 5, 7, 10, 15],
  leverages: [1, 1.25, 1.5, 2, 2.5, 3],
} : {
  trendWindows: [75, 90, 120],
  trendThresholds: [0.65, 0.8, 1],
  breakoutPercents: [0.5, 0.65, 0.8],
  cooldownSeconds: [7_200, 10_800, 14_400],
  emaPairs: [{ fast: 5, slow: 13 }, { fast: 8, slow: 21 }],
  solFourHourRegime: [false, true],
  btcConfirmation: ["none", "1h", "1h+4h"] as const,
  takeProfitRoePercents: [20, 25, 30],
  stopLossRoePercents: [5, 7, 10, 15],
  leverages: [1.5, 2, 2.5],
};
const localCandidates = new Map<string, Candidate>();
const localSeed: Candidate = {
  trendWindow: 90,
  trendThreshold: 0.8,
  breakoutPercent: 0.65,
  cooldownSeconds: 14_400,
  emaFast: 5,
  emaSlow: 13,
  useSolFourHourRegime: false,
  btcConfirmation: "none",
  takeProfitRoePercent: 25,
  stopLossRoePercent: 7,
  leverage: 1.5,
};
localCandidates.set(JSON.stringify(localSeed), localSeed);
const localCandidateTarget = focusedMode ? 1 : preservationMode ? 4_096 : 2_048;
for (let index = 1; localCandidates.size < localCandidateTarget; index += 1) {
  const pair = choose(localDimensions.emaPairs, halton(index, primes[4]!));
  const candidate: Candidate = {
    trendWindow: choose(localDimensions.trendWindows, halton(index, primes[0]!)),
    trendThreshold: choose(localDimensions.trendThresholds, halton(index, primes[1]!)),
    breakoutPercent: choose(localDimensions.breakoutPercents, halton(index, primes[2]!)),
    cooldownSeconds: choose(localDimensions.cooldownSeconds, halton(index, primes[3]!)),
    emaFast: pair.fast,
    emaSlow: pair.slow,
    useSolFourHourRegime: choose(localDimensions.solFourHourRegime, halton(index, primes[5]!)),
    btcConfirmation: choose(localDimensions.btcConfirmation, halton(index, primes[6]!)),
    takeProfitRoePercent: choose(localDimensions.takeProfitRoePercents, halton(index, primes[7]!)),
    stopLossRoePercent: choose(localDimensions.stopLossRoePercents, halton(index, primes[8]!)),
    leverage: choose(localDimensions.leverages, halton(index, primes[9]!)),
  };
  localCandidates.set(JSON.stringify(candidate), candidate);
}
const localRows = [];
completed = 0;
for (const candidate of localCandidates.values()) {
  const control = buildControl(candidate);
  const variant = buildVariant(candidate, `sol-local-risk-${completed + 1}`);
  const foldResults = folds.map((fold) => {
    const baseline = runBacktest({
      asset: "SOL", candles: solEntry, preparedIndicators, higherTimeframeQualification: qualification(candidate),
      control, variant, costs: BASELINE_COST_MODEL, startMs: fold.start, endMs: fold.end, startingCapitalUsd: 1_000,
    });
    const stressed = runBacktest({
      asset: "SOL", candles: solEntry, preparedIndicators, higherTimeframeQualification: qualification(candidate),
      control, variant, costs: stress, startMs: fold.start, endMs: fold.end, startingCapitalUsd: 1_000,
    });
    return { fold: fold.name, baseline, stressed };
  });
  const all = foldResults.flatMap((result) => [result.baseline, result.stressed]);
  const worstReturnPercent = Math.min(...all.map((result) => result.returnPercent));
  const worstDrawdownPercent = Math.max(...all.map((result) => result.maxDrawdownPercent));
  const passingFoldCostCount = all.filter((result) => result.returnPercent > 0 && result.profitFactor > 1).length;
  const totalBaselineTrades = foldResults.reduce((sum, result) => sum + result.baseline.tradeCount, 0);
  const robustScore = Math.min(...all.map(quality)) * 2
    + median(all.map(quality))
    + passingFoldCostCount * 7
    - Math.max(0, worstDrawdownPercent - 20) * 3
    - (preservationMode ? worstDrawdownPercent * 1.5 : 0);
  localRows.push({
    candidate,
    robustScore,
    passingFoldCostCount,
    worstReturnPercent,
    worstDrawdownPercent,
    totalBaselineTrades,
    results: foldResults.map((result) => ({
      segment: result.fold,
      baseline: compact(result.baseline),
      stress: compact(result.stressed),
    })),
  });
  completed += 1;
  if (completed % 128 === 0 || completed === localCandidates.size) process.stdout.write(`SOL local refinement ${completed}/${localCandidates.size}\n`);
}
localRows.sort((left, right) => right.robustScore - left.robustScore);
const localSurvivors = localRows.filter((row) =>
  row.passingFoldCostCount === 8
  && row.worstDrawdownPercent <= 25
  && row.totalBaselineTrades >= 40
  && row.results.every((result) => result.baseline.tradeCount >= 5)
);
const localConfirmationRows = [];
for (const development of localSurvivors.slice(0, 100)) {
  const control = buildControl(development.candidate);
  const variant = buildVariant(development.candidate, "sol-local-forward-confirmation");
  for (const costs of [BASELINE_COST_MODEL, stress]) {
    const result = runBacktest({
      asset: "SOL", candles: solEntry, preparedIndicators, higherTimeframeQualification: qualification(development.candidate),
      control, variant, costs, startMs: forward.start, endMs: forward.end, startingCapitalUsd: 1_000,
    });
    localConfirmationRows.push({
      localDevelopmentRank: localRows.indexOf(development) + 1,
      candidate: development.candidate,
      ...compact(result),
    });
  }
}
const localConfirmed = localSurvivors.slice(0, 100).flatMap((development) => {
  const localDevelopmentRank = localRows.indexOf(development) + 1;
  const baseline = localConfirmationRows.find((row) => row.localDevelopmentRank === localDevelopmentRank && row.costModel === BASELINE_COST_MODEL.name);
  const stressed = localConfirmationRows.find((row) => row.localDevelopmentRank === localDevelopmentRank && row.costModel === stress.name);
  return baseline && stressed && baseline.returnPercent > 0 && baseline.profitFactor > 1 && stressed.returnPercent > 0 && stressed.profitFactor > 1
    ? [{ localDevelopmentRank, candidate: development.candidate, development, forward: baseline, stress: stressed }]
    : [];
}).sort((left, right) => left.localDevelopmentRank - right.localDevelopmentRank);
const smallAccountRows = [];
for (const confirmedCandidate of localConfirmed) {
  const control = buildControl(confirmedCandidate.candidate);
  const variant = buildVariant(confirmedCandidate.candidate, "sol-small-account-confirmation");
  for (const costs of [BASELINE_COST_MODEL, stress]) {
    const result = runBacktest({
      asset: "SOL", candles: solEntry, preparedIndicators, higherTimeframeQualification: qualification(confirmedCandidate.candidate),
      control, variant, costs, startMs: Date.parse("2025-01-01T00:00:00Z"), endMs: forward.end, startingCapitalUsd: 100,
    });
    smallAccountRows.push({
      localDevelopmentRank: confirmedCandidate.localDevelopmentRank,
      candidate: confirmedCandidate.candidate,
      ...compact(result),
    });
  }
}

function monthlyStatistics(result: BacktestResult, startingCapitalUsd: number) {
  const monthEnds = new Map<string, number>();
  for (const point of result.dailyEquity) {
    const date = new Date(point.timestamp);
    const key = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
    if (key !== "2026-07") monthEnds.set(key, point.equityUsd);
  }
  let previous = startingCapitalUsd;
  const returns = [...monthEnds.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([month, equityUsd]) => {
    const returnPercent = previous > 0 ? (equityUsd / previous - 1) * 100 : -100;
    previous = equityUsd;
    return { month, equityUsd, returnPercent };
  });
  const values = returns.map((row) => row.returnPercent);
  return {
    monthCount: returns.length,
    averageReturnPercent: values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length),
    medianReturnPercent: median(values),
    worstReturnPercent: Math.min(...values),
    bestReturnPercent: Math.max(...values),
    positiveMonthCount: values.filter((value) => value > 0).length,
    monthsAtLeast25Percent: values.filter((value) => value >= 25).length,
    monthsAtLeast50Percent: values.filter((value) => value >= 50).length,
    monthsAtLeast100Percent: values.filter((value) => value >= 100).length,
    returns,
  };
}

const monthlyDimensions = {
  trendWindows: [60, 75, 90, 120, 150],
  trendThresholds: [0.5, 0.65, 0.8, 1, 1.25, 1.5],
  breakoutPercents: [0.35, 0.5, 0.65, 0.8, 1, 1.25],
  cooldownSeconds: [1_800, 3_600, 7_200, 10_800, 14_400, 21_600],
  emaPairs: [{ fast: 5, slow: 13 }, { fast: 8, slow: 21 }, { fast: 9, slow: 21 }],
  solFourHourRegime: [false, true],
  btcConfirmation: ["none", "1h", "1h+4h"] as const,
  takeProfitRoePercents: [5, 7, 10, 15, 20, 25, 30],
  stopLossRoePercents: [3, 5, 7, 10, 15, 20, 30],
  leverages: [1.5, 2, 3, 4, 5, 7, 10, 15],
  targetWalletRiskPercents: [0.75, 1.5, 2.5, 5, 10],
};
const monthlyCandidates = new Map<string, Candidate>();
if (monthlyMode) {
  const seed: Candidate = {
    trendWindow: 90, trendThreshold: 1.25, breakoutPercent: 0.65, cooldownSeconds: 10_800,
    emaFast: 5, emaSlow: 13, useSolFourHourRegime: false, btcConfirmation: "1h+4h",
    takeProfitRoePercent: 7, stopLossRoePercent: 15, leverage: 3, targetWalletRiskPercent: 0.75,
  };
  monthlyCandidates.set(JSON.stringify(seed), seed);
  const monthlyPrimes = [...primes, 31];
  for (let index = 1; monthlyCandidates.size < 4_096; index += 1) {
    const pair = choose(monthlyDimensions.emaPairs, halton(index, monthlyPrimes[4]!));
    const candidate: Candidate = {
      trendWindow: choose(monthlyDimensions.trendWindows, halton(index, monthlyPrimes[0]!)),
      trendThreshold: choose(monthlyDimensions.trendThresholds, halton(index, monthlyPrimes[1]!)),
      breakoutPercent: choose(monthlyDimensions.breakoutPercents, halton(index, monthlyPrimes[2]!)),
      cooldownSeconds: choose(monthlyDimensions.cooldownSeconds, halton(index, monthlyPrimes[3]!)),
      emaFast: pair.fast,
      emaSlow: pair.slow,
      useSolFourHourRegime: choose(monthlyDimensions.solFourHourRegime, halton(index, monthlyPrimes[5]!)),
      btcConfirmation: choose(monthlyDimensions.btcConfirmation, halton(index, monthlyPrimes[6]!)),
      takeProfitRoePercent: choose(monthlyDimensions.takeProfitRoePercents, halton(index, monthlyPrimes[7]!)),
      stopLossRoePercent: choose(monthlyDimensions.stopLossRoePercents, halton(index, monthlyPrimes[8]!)),
      leverage: choose(monthlyDimensions.leverages, halton(index, monthlyPrimes[9]!)),
      targetWalletRiskPercent: choose(monthlyDimensions.targetWalletRiskPercents, halton(index, monthlyPrimes[10]!)),
    };
    monthlyCandidates.set(JSON.stringify(candidate), candidate);
  }
}
const monthlyRows = [];
let monthlyCompleted = 0;
for (const candidate of monthlyCandidates.values()) {
  const control = buildControl(candidate);
  const variant = buildVariant(candidate, `sol-monthly-target-${monthlyCompleted + 1}`);
  const baseline = runBacktest({
    asset: "SOL", candles: solEntry, preparedIndicators, higherTimeframeQualification: qualification(candidate),
    control, variant, costs: BASELINE_COST_MODEL, startMs: analysisStart, endMs: forward.end, startingCapitalUsd: 100,
  });
  const stressed = runBacktest({
    asset: "SOL", candles: solEntry, preparedIndicators, higherTimeframeQualification: qualification(candidate),
    control, variant, costs: stress, startMs: analysisStart, endMs: forward.end, startingCapitalUsd: 100,
  });
  const baselineMonthly = monthlyStatistics(baseline, 100);
  const stressMonthly = monthlyStatistics(stressed, 100);
  const score = stressMonthly.monthsAtLeast50Percent * 30
    + baselineMonthly.monthsAtLeast50Percent * 12
    + stressMonthly.positiveMonthCount * 4
    + baselineMonthly.positiveMonthCount * 2
    + stressMonthly.medianReturnPercent * 4
    + baselineMonthly.medianReturnPercent * 2
    + Math.min(0, stressMonthly.worstReturnPercent) * 2
    - stressed.maxDrawdownPercent * 2.5
    - baseline.maxDrawdownPercent;
  monthlyRows.push({
    candidate,
    score,
    targetQualified: stressMonthly.medianReturnPercent >= 50
      && stressMonthly.worstReturnPercent >= 0
      && stressed.maxDrawdownPercent <= 40,
    baseline: { ...compact(baseline), monthly: baselineMonthly },
    stress: { ...compact(stressed), monthly: stressMonthly },
  });
  monthlyCompleted += 1;
  if (monthlyCompleted % 128 === 0 || monthlyCompleted === monthlyCandidates.size) process.stdout.write(`SOL monthly target ${monthlyCompleted}/${monthlyCandidates.size}\n`);
}
monthlyRows.sort((left, right) => right.score - left.score);

const dynamicLeverageDimensions = {
  minimums: [1, 1.25, 1.5],
  maximums: [2, 2.5, 3, 4, 5, 7],
  qualityExponents: [0.7, 1, 1.4, 2],
  volatilityPenalties: [0.25, 0.5, 0.75, 1],
  lossStepdowns: [0.5, 0.7, 0.85, 1],
};
const adaptiveJointDimensions = {
  trendWindows: [60, 75, 90, 120, 150],
  trendThresholds: [0.8, 1, 1.25, 1.5],
  breakoutPercents: [0.25, 0.35, 0.5, 0.65],
  cooldownSeconds: [7_200, 10_800, 14_400, 21_600],
  emaPairs: [{ fast: 5, slow: 13 }, { fast: 8, slow: 21 }, { fast: 9, slow: 21 }],
  solFourHourRegime: [false, true],
  btcConfirmation: ["none", "1h", "1h+4h"] as const,
  takeProfitRoePercents: [5, 7, 10, 15],
  stopLossRoePercents: [5, 7, 10, 15],
  targetWalletRiskPercents: [1.5, 2.5, 3.5, 5],
  minimumLeverages: [1, 1.25, 1.5],
  maximumLeverages: [2, 3, 4, 5, 7],
  qualityExponents: [1, 1.4, 2],
  volatilityPenalties: [0.5, 0.75, 1],
  lossStepdowns: [0.7, 0.85, 1],
};
const adaptiveLocalDimensions = {
  trendWindows: [120, 135, 150, 165, 180],
  trendThresholds: [1.25, 1.4, 1.5, 1.6, 1.75],
  breakoutPercents: [0.2, 0.25, 0.3, 0.35],
  cooldownSeconds: [14_400, 18_000, 21_600, 25_200, 28_800],
  emaPairs: [{ fast: 8, slow: 21 }, { fast: 9, slow: 21 }, { fast: 10, slow: 24 }],
  solFourHourRegime: [true],
  btcConfirmation: ["1h", "1h+4h"] as const,
  takeProfitRoePercents: [5, 7, 10],
  stopLossRoePercents: [5, 7, 10],
  targetWalletRiskPercents: [3.5, 4, 5],
  minimumLeverages: [1, 1.25, 1.5],
  maximumLeverages: [3, 4, 5],
  qualityExponents: [1.4, 2],
  volatilityPenalties: [0.5, 0.75, 1],
  lossStepdowns: [0.7, 0.85, 1],
};
const adaptiveAggressiveDimensions = {
  trendWindows: [105, 120, 135, 150, 165],
  trendThresholds: [1.35, 1.5, 1.65, 1.8, 2],
  breakoutPercents: [0.2, 0.25, 0.3, 0.35, 0.4],
  cooldownSeconds: [21_600, 25_200, 28_800, 32_400, 36_000],
  emaPairs: [{ fast: 8, slow: 21 }, { fast: 9, slow: 21 }, { fast: 10, slow: 24 }],
  solFourHourRegime: [true],
  btcConfirmation: ["1h", "1h+4h"] as const,
  takeProfitRoePercents: [5, 7, 10, 12, 15],
  stopLossRoePercents: [7, 10, 12, 15],
  targetWalletRiskPercents: [4, 5, 6, 7.5, 10],
  minimumLeverages: [1, 1.5, 2],
  maximumLeverages: [4, 5, 7, 10],
  qualityExponents: [1.4, 2, 2.5],
  volatilityPenalties: [0.75, 1, 1.25],
  lossStepdowns: [0.5, 0.7, 0.85, 1],
};
const adaptiveAggressiveLocalDimensions = {
  trendWindows: [135, 145, 150, 155, 165],
  trendThresholds: [1.8, 1.9, 2, 2.1, 2.2],
  breakoutPercents: [0.3, 0.35, 0.4, 0.45],
  cooldownSeconds: [21_600, 25_200, 28_800],
  emaPairs: [{ fast: 8, slow: 21 }, { fast: 9, slow: 21 }, { fast: 10, slow: 24 }],
  solFourHourRegime: [true],
  btcConfirmation: ["1h", "1h+4h"] as const,
  takeProfitRoePercents: [10, 12, 15, 18],
  stopLossRoePercents: [12, 15, 18],
  targetWalletRiskPercents: [5, 6, 7.5, 8],
  minimumLeverages: [1.5, 2],
  maximumLeverages: [4, 5, 7],
  qualityExponents: [2, 2.5, 3],
  volatilityPenalties: [0.75, 1, 1.25],
  lossStepdowns: [0.5, 0.7, 0.85],
};
const adaptiveHybridDimensions = {
  trendWindows: [135, 145, 155],
  trendThresholds: [1.5, 1.65, 1.75, 1.9, 2],
  breakoutPercents: [0.25, 0.3, 0.35],
  cooldownSeconds: [25_200, 27_000, 28_800],
  emaPairs: [{ fast: 8, slow: 21 }],
  solFourHourRegime: [true],
  btcConfirmation: ["1h+4h"] as const,
  takeProfitRoePercents: [10, 12, 15],
  stopLossRoePercents: [7, 10, 12, 15],
  targetWalletRiskPercents: [5],
  minimumLeverages: [1.5, 1.75, 2],
  maximumLeverages: [4, 5],
  qualityExponents: [2, 2.25, 2.5],
  volatilityPenalties: [1, 1.125, 1.25],
  lossStepdowns: [0.7, 0.85, 1],
};
const dynamicCandidates = new Map<string, Candidate>();
if (dynamicMode) {
  for (const minimum of dynamicLeverageDimensions.minimums) {
    for (const maximum of dynamicLeverageDimensions.maximums) {
      if (maximum < minimum) continue;
      for (const qualityExponent of dynamicLeverageDimensions.qualityExponents) {
        for (const volatilityPenalty of dynamicLeverageDimensions.volatilityPenalties) {
          for (const lossStepdown of dynamicLeverageDimensions.lossStepdowns) {
            const candidate: Candidate = {
              trendWindow: 75,
              trendThreshold: 1.25,
              breakoutPercent: 0.35,
              cooldownSeconds: 14_400,
              emaFast: 8,
              emaSlow: 21,
              useSolFourHourRegime: false,
              btcConfirmation: "1h",
              takeProfitRoePercent: 7,
              stopLossRoePercent: 7,
              leverage: maximum,
              targetWalletRiskPercent: 2.5,
              dynamicLeverage: { minimum, maximum, qualityExponent, volatilityPenalty, lossStepdown },
            };
            dynamicCandidates.set(JSON.stringify(candidate.dynamicLeverage), candidate);
          }
        }
      }
    }
  }
}
if (adaptiveRiskLadderMode) {
  for (const targetWalletRiskPercent of [5, 6, 7.5, 8, 10]) {
    const candidate: Candidate = {
      trendWindow: 135,
      trendThreshold: 1.5,
      breakoutPercent: 0.25,
      cooldownSeconds: 28_800,
      emaFast: 8,
      emaSlow: 21,
      useSolFourHourRegime: true,
      btcConfirmation: "1h+4h",
      takeProfitRoePercent: 10,
      stopLossRoePercent: 7,
      leverage: 4,
      targetWalletRiskPercent,
      dynamicLeverage: {
        minimum: 1.5,
        maximum: 4,
        qualityExponent: 2,
        volatilityPenalty: 1,
        lossStepdown: 0.85,
      },
    };
    dynamicCandidates.set(JSON.stringify(candidate), candidate);
  }
}
if (adaptiveSearchMode) {
  const adaptiveDimensions = adaptiveHybridMode
    ? adaptiveHybridDimensions
    : adaptiveAggressiveLocalMode
      ? adaptiveAggressiveLocalDimensions
    : adaptiveAggressiveMode
      ? adaptiveAggressiveDimensions
    : adaptiveLocalMode
      ? adaptiveLocalDimensions
      : adaptiveJointDimensions;
  const adaptivePrimes = [2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47];
  const adaptiveCandidateTarget = aggressiveSearchMode ? 8_192 : 4_096;
  for (let index = 1; dynamicCandidates.size < adaptiveCandidateTarget; index += 1) {
    const pair = choose(adaptiveDimensions.emaPairs, halton(index, adaptivePrimes[4]!));
    const minimum = choose(adaptiveDimensions.minimumLeverages, halton(index, adaptivePrimes[10]!));
    const maximum = choose(adaptiveDimensions.maximumLeverages, halton(index, adaptivePrimes[11]!));
    const candidate: Candidate = {
      trendWindow: choose(adaptiveDimensions.trendWindows, halton(index, adaptivePrimes[0]!)),
      trendThreshold: choose(adaptiveDimensions.trendThresholds, halton(index, adaptivePrimes[1]!)),
      breakoutPercent: choose(adaptiveDimensions.breakoutPercents, halton(index, adaptivePrimes[2]!)),
      cooldownSeconds: choose(adaptiveDimensions.cooldownSeconds, halton(index, adaptivePrimes[3]!)),
      emaFast: pair.fast,
      emaSlow: pair.slow,
      useSolFourHourRegime: choose(adaptiveDimensions.solFourHourRegime, halton(index, adaptivePrimes[5]!)),
      btcConfirmation: choose(adaptiveDimensions.btcConfirmation, halton(index, adaptivePrimes[6]!)),
      takeProfitRoePercent: choose(adaptiveDimensions.takeProfitRoePercents, halton(index, adaptivePrimes[7]!)),
      stopLossRoePercent: choose(adaptiveDimensions.stopLossRoePercents, halton(index, adaptivePrimes[8]!)),
      leverage: maximum,
      targetWalletRiskPercent: choose(adaptiveDimensions.targetWalletRiskPercents, halton(index, adaptivePrimes[9]!)),
      dynamicLeverage: {
        minimum,
        maximum,
        qualityExponent: choose(adaptiveDimensions.qualityExponents, halton(index, adaptivePrimes[12]!)),
        volatilityPenalty: choose(adaptiveDimensions.volatilityPenalties, halton(index, adaptivePrimes[13]!)),
        lossStepdown: choose(adaptiveDimensions.lossStepdowns, halton(index, adaptivePrimes[14]!)),
      },
    };
    dynamicCandidates.set(JSON.stringify(candidate), candidate);
  }
}
const dynamicRows = [];
let dynamicCompleted = 0;
for (const candidate of dynamicCandidates.values()) {
  const control = buildControl(candidate);
  const variant = buildVariant(candidate, `sol-dynamic-leverage-${dynamicCompleted + 1}`);
  const developmentBaseline = folds.map((period) => runBacktest({
    asset: "SOL", candles: solEntry, preparedIndicators, higherTimeframeQualification: qualification(candidate),
    control, variant, costs: BASELINE_COST_MODEL, startMs: period.start, endMs: period.end, startingCapitalUsd: 100,
  }));
  const developmentStress = folds.map((period) => runBacktest({
    asset: "SOL", candles: solEntry, preparedIndicators, higherTimeframeQualification: qualification(candidate),
    control, variant, costs: stress, startMs: period.start, endMs: period.end, startingCapitalUsd: 100,
  }));
  const summarizeDevelopment = (results: BacktestResult[]) => {
    const wins = results.reduce((sum, result) => sum + result.winCount, 0);
    const losses = results.reduce((sum, result) => sum + result.lossCount, 0);
    const returns = results.map((result) => result.returnPercent);
    return {
      profitableFoldCount: returns.filter((value) => value > 0).length,
      medianReturnPercent: median(returns),
      worstReturnPercent: Math.min(...returns),
      worstDrawdownPercent: Math.max(...results.map((result) => result.maxDrawdownPercent)),
      tradeCount: wins + losses,
      winCount: wins,
      lossCount: losses,
      winRate: wins + losses > 0 ? wins / (wins + losses) : 0,
    };
  };
  const development = {
    baseline: summarizeDevelopment(developmentBaseline),
    stress: summarizeDevelopment(developmentStress),
  };
  const forwardBaseline = runBacktest({
    asset: "SOL", candles: solEntry, preparedIndicators, higherTimeframeQualification: qualification(candidate),
    control, variant, costs: BASELINE_COST_MODEL, startMs: forward.start, endMs: forward.end, startingCapitalUsd: 100,
  });
  const forwardStress = runBacktest({
    asset: "SOL", candles: solEntry, preparedIndicators, higherTimeframeQualification: qualification(candidate),
    control, variant, costs: stress, startMs: forward.start, endMs: forward.end, startingCapitalUsd: 100,
  });
  const baseline = runBacktest({
    asset: "SOL", candles: solEntry, preparedIndicators, higherTimeframeQualification: qualification(candidate),
    control, variant, costs: BASELINE_COST_MODEL, startMs: analysisStart, endMs: forward.end, startingCapitalUsd: 100,
  });
  const stressed = runBacktest({
    asset: "SOL", candles: solEntry, preparedIndicators, higherTimeframeQualification: qualification(candidate),
    control, variant, costs: stress, startMs: analysisStart, endMs: forward.end, startingCapitalUsd: 100,
  });
  const baselineMonthly = monthlyStatistics(baseline, 100);
  const stressMonthly = monthlyStatistics(stressed, 100);
  const aggressiveWinRateFloor = aggressiveSearchMode ? 0.6 : 0.5;
  const qualified = development.baseline.winRate >= aggressiveWinRateFloor
    && development.stress.winRate >= aggressiveWinRateFloor
    && development.baseline.profitableFoldCount >= 3
    && development.stress.profitableFoldCount >= 3
    && development.stress.worstDrawdownPercent <= (aggressiveSearchMode ? 35 : 30)
    && development.stress.worstReturnPercent >= (aggressiveSearchMode ? -12 : -10);
  const forwardConfirmed = qualified
    && forwardBaseline.returnPercent > 0
    && forwardStress.returnPercent > 0
    && forwardBaseline.winRate >= aggressiveWinRateFloor
    && forwardStress.winRate >= aggressiveWinRateFloor
    && forwardStress.maxDrawdownPercent <= (aggressiveSearchMode ? 25 : 20);
  const score = aggressiveSearchMode
    ? development.stress.medianReturnPercent * 4
      + development.baseline.medianReturnPercent * 1.5
      + development.stress.winRate * 80
      + development.stress.worstReturnPercent * 2
      - development.stress.worstDrawdownPercent * 1.5
    : development.stress.medianReturnPercent * 3
      + development.baseline.medianReturnPercent
      + development.stress.winRate * 30
      + development.stress.worstReturnPercent * 2
      - development.stress.worstDrawdownPercent * 2;
  const continuousQualified = baseline.returnPercent > 0
    && stressed.returnPercent > 0
    && baseline.winCount > baseline.lossCount
    && stressed.winCount > stressed.lossCount
    && stressed.maxDrawdownPercent <= 30
    && stressMonthly.worstReturnPercent >= -10;
  dynamicRows.push({
    candidate,
    score,
    qualified,
    forwardConfirmed,
    continuousQualified,
    development,
    forward: {
      baseline: compact(forwardBaseline),
      stress: compact(forwardStress),
    },
    baseline: { ...compact(baseline), monthly: baselineMonthly },
    stress: { ...compact(stressed), monthly: stressMonthly },
  });
  dynamicCompleted += 1;
  if (dynamicCompleted % 96 === 0 || dynamicCompleted === dynamicCandidates.size) {
    process.stdout.write(`SOL dynamic leverage ${dynamicCompleted}/${dynamicCandidates.size}\n`);
  }
}
dynamicRows.sort((left, right) => right.score - left.score);

const periodSuffix = twelveMonthMode ? "-12m" : "";
const output = path.join(root, "results", "broad-search", adaptiveRiskLadderMode ? `sol-adaptive-risk-ladder${periodSuffix}.json` : adaptiveHybridMode ? `sol-adaptive-hybrid-search${periodSuffix}.json` : adaptiveAggressiveLocalMode ? `sol-adaptive-aggressive-local-search${periodSuffix}.json` : adaptiveAggressiveMode ? `sol-adaptive-aggressive-search${periodSuffix}.json` : adaptiveLocalMode ? `sol-adaptive-local-search${periodSuffix}.json` : adaptiveJointMode ? `sol-adaptive-joint-search${periodSuffix}.json` : dynamicMode ? `sol-dynamic-leverage-search${periodSuffix}.json` : monthlyMode ? `sol-monthly-target-search${periodSuffix}.json` : preservationMode ? `sol-capital-preservation-search${periodSuffix}.json` : `sol-joint-risk-search${periodSuffix}.json`);
fs.writeFileSync(output, `${JSON.stringify({
  generatedAt: new Date().toISOString(),
  analysisPeriod: { start: analysisStart, end: forward.end, twelveMonthMode },
  methodology: "4,096 deterministic SOL candidates jointly varying signal thresholds, 15m/1h/4h architecture, BTC confirmation, TP, SL, leverage, and cooldown. Four development folds determine ranking. Strict survivors require 4/4 profitable folds, <=40% worst drawdown, >=40 total trades, and >=5 trades per fold. Up to 100 survivors are then evaluated on later baseline and stress costs.",
  dimensions,
  candidateCount: candidates.size,
  fourFoldSurvivorCount: developmentRows.filter((row) => row.profitableFoldCount === 4).length,
  strictSurvivorCount: strictSurvivors.length,
  forwardConfirmedCount: confirmed.filter((row) => row.confirmed).length,
  fullyStressConfirmedCount: confirmed.filter((row) => row.fullyStressConfirmed).length,
  developmentRows,
  confirmationRows,
  developmentStressRows,
  confirmed,
  localRefinement: {
    objective: preservationMode
      ? "Capital-preservation search prioritizing positive stressed folds and low drawdown while expanding TP down to 5%, leverage down to 1x, and cooldown up to eight hours."
      : "Local refinement around the broad-search robustness leader.",
    dimensions: localDimensions,
    candidateCount: localCandidates.size,
    developmentStressSurvivorCount: localSurvivors.length,
    fullyConfirmedCount: localConfirmed.length,
    rows: localRows,
    confirmationRows: localConfirmationRows,
    confirmed: localConfirmed,
    smallAccountRows,
  },
  monthlyTargetSearch: {
    objective: "Test whether a SOL strategy can robustly approach at least 50% ROI per month on a $100 account across 18 complete months under baseline and stressed costs.",
    dimensions: monthlyDimensions,
    candidateCount: monthlyCandidates.size,
    targetQualifiedCount: monthlyRows.filter((row) => row.targetQualified).length,
    rows: monthlyRows,
  },
  dynamicLeverageSearch: {
    objective: adaptiveSearchMode
      ? "Jointly retune SOL signals, confirmation, exits, wallet risk, and confidence/indicator/ADX/volume/ATR-driven leverage while selecting only on four development folds and reserving later data for confirmation."
      : "Test confidence/indicator/ADX/volume/ATR-driven leverage with post-loss stepdown while holding the selected SOL signal architecture and 7% TP/SL fixed.",
    dimensions: adaptiveHybridMode ? adaptiveHybridDimensions : adaptiveAggressiveLocalMode ? adaptiveAggressiveLocalDimensions : adaptiveAggressiveMode ? adaptiveAggressiveDimensions : adaptiveLocalMode ? adaptiveLocalDimensions : adaptiveJointMode ? adaptiveJointDimensions : dynamicLeverageDimensions,
    candidateCount: dynamicCandidates.size,
    qualifiedCount: dynamicRows.filter((row) => row.qualified).length,
    forwardConfirmedCount: dynamicRows.filter((row) => row.forwardConfirmed).length,
    rows: dynamicRows,
  },
}, null, 2)}\n`);
process.stdout.write(`Saved ${output}\n`);
process.stdout.write(`${JSON.stringify({
  candidateCount: candidates.size,
  fourFoldSurvivorCount: developmentRows.filter((row) => row.profitableFoldCount === 4).length,
  strictSurvivorCount: strictSurvivors.length,
  forwardConfirmedCount: confirmed.filter((row) => row.confirmed).length,
  fullyStressConfirmedCount: confirmed.filter((row) => row.fullyStressConfirmed).length,
  localDevelopmentStressSurvivorCount: localSurvivors.length,
  localFullyConfirmedCount: localConfirmed.length,
  monthlyTargetCandidateCount: monthlyCandidates.size,
  monthlyTargetQualifiedCount: monthlyRows.filter((row) => row.targetQualified).length,
  dynamicLeverageCandidateCount: dynamicCandidates.size,
  dynamicLeverageQualifiedCount: dynamicRows.filter((row) => row.qualified).length,
  dynamicLeverageForwardConfirmedCount: dynamicRows.filter((row) => row.forwardConfirmed).length,
  leaders: confirmed.slice(0, 10).map((row) => ({
    developmentRank: row.developmentRank,
    candidate: row.candidate,
    development: row.development,
    forwardReturnPercent: row.forward.returnPercent,
    forwardDrawdownPercent: row.forward.maxDrawdownPercent,
    stressReturnPercent: row.stress.returnPercent,
    stressDrawdownPercent: row.stress.maxDrawdownPercent,
    forwardTrades: row.forward.tradeCount,
    confirmed: row.confirmed,
    profitableDevelopmentStressFolds: row.profitableDevelopmentStressFolds,
    fullyStressConfirmed: row.fullyStressConfirmed,
  })),
  localLeaders: localConfirmed.slice(0, 10).map((row) => ({
    localDevelopmentRank: row.localDevelopmentRank,
    candidate: row.candidate,
    developmentWorstReturnPercent: row.development.worstReturnPercent,
    developmentWorstDrawdownPercent: row.development.worstDrawdownPercent,
    developmentTrades: row.development.totalBaselineTrades,
    forwardReturnPercent: row.forward.returnPercent,
    forwardDrawdownPercent: row.forward.maxDrawdownPercent,
    stressReturnPercent: row.stress.returnPercent,
    stressDrawdownPercent: row.stress.maxDrawdownPercent,
    forwardTrades: row.forward.tradeCount,
    smallAccountBaseline: smallAccountRows.find((result) => result.localDevelopmentRank === row.localDevelopmentRank && result.costModel === BASELINE_COST_MODEL.name)?.returnPercent,
    smallAccountStress: smallAccountRows.find((result) => result.localDevelopmentRank === row.localDevelopmentRank && result.costModel === stress.name)?.returnPercent,
  })),
  monthlyLeaders: monthlyRows.slice(0, 10).map((row) => ({
    candidate: row.candidate,
    score: row.score,
    targetQualified: row.targetQualified,
    baselineReturnPercent: row.baseline.returnPercent,
    baselineDrawdownPercent: row.baseline.maxDrawdownPercent,
    baselineMedianMonthPercent: row.baseline.monthly.medianReturnPercent,
    baselineWorstMonthPercent: row.baseline.monthly.worstReturnPercent,
    baselineMonthsAtLeast50Percent: row.baseline.monthly.monthsAtLeast50Percent,
    stressReturnPercent: row.stress.returnPercent,
    stressDrawdownPercent: row.stress.maxDrawdownPercent,
    stressMedianMonthPercent: row.stress.monthly.medianReturnPercent,
    stressWorstMonthPercent: row.stress.monthly.worstReturnPercent,
    stressMonthsAtLeast50Percent: row.stress.monthly.monthsAtLeast50Percent,
  })),
  dynamicLeverageLeaders: dynamicRows.slice(0, 10).map((row) => ({
    candidate: row.candidate,
    score: row.score,
    qualified: row.qualified,
    forwardConfirmed: row.forwardConfirmed,
    development: row.development,
    forward: row.forward,
    baselineReturnPercent: row.baseline.returnPercent,
    baselineWinRate: row.baseline.winRate,
    baselineDrawdownPercent: row.baseline.maxDrawdownPercent,
    stressReturnPercent: row.stress.returnPercent,
    stressWinRate: row.stress.winRate,
    stressDrawdownPercent: row.stress.maxDrawdownPercent,
    stressMedianMonthPercent: row.stress.monthly.medianReturnPercent,
    stressWorstMonthPercent: row.stress.monthly.worstReturnPercent,
  })),
}, null, 2)}\n`);
