import fs from "node:fs";

import { evaluateTradeDecision } from "../../lib/decision/engine";
import type { DecisionLearningProfile, LearningAsset } from "../../lib/decision/learningTypes";
import { applyLearnedTradePlan } from "../../lib/decision/learningRuntime";
import type { PricePoint } from "../../lib/price/simulated";
import { computeSignalMetrics, detectSignals, type Signal } from "../../lib/signal/engine";
import {
  BASE_INDICATOR_SETTINGS,
  computeIndicatorSnapshot,
  scoreIndicatorSnapshot,
  type IndicatorSettings,
  type IndicatorSnapshot,
} from "../../lib/signal/indicators";

export type Asset = LearningAsset;

export type Candle = PricePoint & {
  o: number;
  h: number;
  l: number;
  volume: number;
};

export type FrozenControl = {
  commit: string;
  startingCapitalUsd: number;
  params: {
    trendWindow: number;
    trendThreshold: number;
    breakoutPercent: number;
    cooldownSeconds: number;
  };
  settings: {
    walletPercent: number;
    walletAllocationMode: "percent" | "usd";
    perpsTakeProfitValue: number;
    perpsTakeProfitMode: "percent" | "usd";
    stopLossPercent: number;
    perpsLeverage: number;
    perpsExecutionMode: "set-parameters" | "smart-trades";
    decisionMode: "shadow" | "active";
    smartTradeProfile: "conservative" | "balanced" | "aggressive";
    mode: "all" | "buy-only";
  };
  risk: {
    maxUserLeverage: number;
    maxTradePct: number;
    maxExposurePct: number;
    maxDailyLossPct: number;
  };
  profile: DecisionLearningProfile;
};

export type StrategyVariant = {
  name: string;
  trendWindow: number;
  trendThreshold: number;
  breakoutPercent: number;
  cooldownSeconds: number;
  useIndicators: boolean;
  useLearnedConfirmation: boolean;
  useDecisionLayer: boolean;
  minimumIndicatorScore?: number;
  directionMode?: "all" | "buy-only";
  executionTiming?: "next-open" | "signal-close";
  stopLossRoePercent?: number;
  stopLossCooldownSeconds?: number;
  indicatorLookbackMinutes?: number;
  dynamicLeverage?: {
    minimum: number;
    maximum: number;
    qualityExponent: number;
    volatilityPenalty: number;
    lossStepdown: number;
  };
  entryLockedAtrExit?: {
    stopMultiplier: number;
    takeProfitMultiplier: number;
    minimumStopRoePercent?: number;
    maximumStopRoePercent?: number;
    minimumTakeProfitRoePercent?: number;
    maximumTakeProfitRoePercent?: number;
  };
  enforceTargetRiskAtStop?: boolean;
};

export type CostModel = {
  name: string;
  entryBaseFeeRate: number;
  exitBaseFeeRate: number;
  priceImpactFeeRate: number;
  liquidationFeeRate: number;
  slippageBps: number;
  networkCostUsd: number;
  borrowRatePercentPerHour: Record<Asset, { long: number; short: number }>;
  borrowRateMultiplier: number;
};

export type BacktestTrade = {
  asset: Asset;
  side: "long" | "short";
  signalType: "trend" | "breakout";
  signalAt: number;
  enteredAt: number;
  exitedAt: number;
  entryPrice: number;
  exitPrice: number;
  takeProfitPrice: number | null;
  stopLossPrice: number | null;
  liquidationPriceAtEntry: number;
  exitReason: "take-profit" | "stop-loss" | "liquidation" | "end-of-period";
  signalConfidence: number;
  decisionConfidence: number;
  collateralUsd: number;
  leverage: number;
  sizeUsd: number;
  grossPnlUsd: number;
  entryFeeUsd: number;
  exitFeeUsd: number;
  borrowFeeUsd: number;
  networkCostUsd: number;
  netPnlUsd: number;
  durationMinutes: number;
  trendStrengthPercent: number;
  breakoutStrengthPercent: number;
  shortMomentumPercent: number;
  volatilityPercent: number;
  indicatorScore: number;
  indicatorTags: string[];
  rsi: number | null;
  adx: number | null;
  volumeRatio: number | null;
  protectionAttached: boolean;
};

export type BacktestResult = {
  asset: Asset;
  variant: StrategyVariant;
  costModel: string;
  period: { start: number; end: number };
  startingCapitalUsd: number;
  endingCapitalUsd: number;
  netPnlUsd: number;
  returnPercent: number;
  maxDrawdownUsd: number;
  maxDrawdownPercent: number;
  sharpeRatio: number;
  sortinoRatio: number;
  calmarRatio: number;
  underlyingReturnPercent: number;
  tradeCount: number;
  winCount: number;
  lossCount: number;
  winRate: number;
  grossProfitUsd: number;
  grossLossUsd: number;
  profitFactor: number;
  expectancyUsd: number;
  liquidationCount: number;
  totalFeesUsd: number;
  totalBorrowFeesUsd: number;
  averageLeverage: number;
  averageDurationMinutes: number;
  exposurePercent: number;
  candidateCount: number;
  indicatorBlockedCount: number;
  confirmationBlockedCount: number;
  decisionBlockedCount: number;
  directionBlockedCount: number;
  staleOrInvalidCount: number;
  unprotectedEntryCount: number;
  dailyEquity: Array<{ timestamp: number; equityUsd: number }>;
  trades: BacktestTrade[];
};

export type PreparedIndicators = {
  ready: Uint8Array;
  bullQualified: Uint8Array;
  bearQualified: Uint8Array;
  bullVetoed: Uint8Array;
  bearVetoed: Uint8Array;
  bullScore: Float32Array;
  bearScore: Float32Array;
};

type ExecutionHistoryEvent = {
  timestamp: number;
  status: "blocked" | "closed" | "failed";
};

type OpenTrade = {
  side: "long" | "short";
  signal: Signal;
  signalAt: number;
  enteredAt: number;
  entryIndex: number;
  entryPrice: number;
  takeProfitPrice: number | null;
  stopLossPrice: number | null;
  protectionAttached: boolean;
  collateralUsd: number;
  leverage: number;
  sizeUsd: number;
  entryFeeUsd: number;
  decisionConfidence: number;
  metrics: ReturnType<typeof computeSignalMetrics>;
  volatilityPercent: number;
  indicatorSnapshot: IndicatorSnapshot;
  indicatorScore: ReturnType<typeof scoreIndicatorSnapshot>;
};

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function round(value: number, digits = 6) {
  return Number(value.toFixed(digits));
}

function percentChange(next: number, previous: number) {
  return previous === 0 ? 0 : ((next - previous) / previous) * 100;
}

function mean(values: number[]) {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function sampleDeviation(values: number[]) {
  if (values.length < 2) return 0;
  const average = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1));
}

export function loadCandles(csvFile: string): Candle[] {
  const lines = fs.readFileSync(csvFile, "utf8").trim().split("\n");
  if (lines[0] !== "timestamp,open,high,low,close,volume") {
    throw new Error(`Unexpected candle header in ${csvFile}`);
  }
  const candles: Candle[] = [];
  let previous = 0;
  for (let index = 1; index < lines.length; index += 1) {
    const fields = lines[index]!.split(",").map(Number);
    const [timestamp, open, high, low, close, volume] = fields;
    if (![timestamp, open, high, low, close, volume].every(Number.isFinite)) {
      throw new Error(`Invalid numeric candle at ${csvFile}:${index + 1}`);
    }
    if (timestamp! <= previous) throw new Error(`Non-increasing timestamp at ${csvFile}:${index + 1}`);
    // Coinbase can omit minutes during an upstream market-data interruption.
    // Preserve the gap instead of inventing an OHLCV candle. Replay windows are
    // timestamp-based so this matches the production fetcher's sparse response.
    if (low! > high! || open! < low! || open! > high! || close! < low! || close! > high!) {
      throw new Error(`Invalid OHLC relationship at ${csvFile}:${index + 1}`);
    }
    candles.push({
      t: timestamp! * 1_000,
      o: open!,
      h: high!,
      l: low!,
      v: close!,
      volume: volume!,
    });
    previous = timestamp!;
  }
  return candles;
}

export function prepareIndicators(
  candles: Candle[],
  settings: IndicatorSettings,
  onProgress?: (percent: number) => void,
  historyMinutes = 60,
  candleMinutes = 1
): PreparedIndicators {
  const ready = new Uint8Array(candles.length);
  const bullQualified = new Uint8Array(candles.length);
  const bearQualified = new Uint8Array(candles.length);
  const bullVetoed = new Uint8Array(candles.length);
  const bearVetoed = new Uint8Array(candles.length);
  const bullScore = new Float32Array(candles.length);
  const bearScore = new Float32Array(candles.length);
  const requiredHistory = Math.max(
    60,
    Math.min(240, Math.ceil(historyMinutes / candleMinutes)),
    settings.macdSlow + settings.macdSignal + 5,
    settings.adxPeriod * 2 + 2
  );
  let historyStart = 0;
  let nextProgress = 10;
  for (let index = requiredHistory - 1; index < candles.length; index += 1) {
    const cutoff = candles[index]!.t - (requiredHistory - 1) * candleMinutes * 60_000;
    while (historyStart < index && candles[historyStart]!.t < cutoff) historyStart += 1;
    const points = candles.slice(historyStart, index + 1);
    const snapshot = computeIndicatorSnapshot(points, settings);
    const isReady = snapshot.emaFast !== null
      && snapshot.emaSlow !== null
      && snapshot.rsi !== null
      && snapshot.macdHistogram !== null
      && snapshot.adx !== null;
    if (isReady) {
      const bull = scoreIndicatorSnapshot(snapshot, "bullish", settings);
      const bear = scoreIndicatorSnapshot(snapshot, "bearish", settings);
      ready[index] = 1;
      bullQualified[index] = bull.qualified ? 1 : 0;
      bearQualified[index] = bear.qualified ? 1 : 0;
      bullVetoed[index] = bull.vetoed ? 1 : 0;
      bearVetoed[index] = bear.vetoed ? 1 : 0;
      bullScore[index] = bull.score;
      bearScore[index] = bear.score;
    }
    const progress = Math.floor(index / candles.length * 100);
    if (onProgress && progress >= nextProgress) {
      onProgress(progress);
      nextProgress += 10;
    }
  }
  return { ready, bullQualified, bearQualified, bullVetoed, bearVetoed, bullScore, bearScore };
}

export function getIndicatorSettings(profile: DecisionLearningProfile, minimumScore?: number): IndicatorSettings {
  return {
    ...BASE_INDICATOR_SETTINGS,
    ...(profile.indicatorSettings ?? {}),
    ...(minimumScore === undefined ? {} : { minimumScore }),
  };
}

function getVolatilityPercent(points: Candle[]) {
  const current = points[points.length - 1]?.v ?? 0;
  if (current <= 0 || points.length < 2) return 0;
  let high = -Infinity;
  let low = Infinity;
  for (const point of points) {
    high = Math.max(high, point.v);
    low = Math.min(low, point.v);
  }
  return ((high - low) / current) * 100;
}

function getTrendBias(points: Candle[]): "bullish" | "bearish" | "sideways" {
  const first = points[0]?.v ?? 0;
  const last = points[points.length - 1]?.v ?? 0;
  if (first <= 0 || last <= 0) return "sideways";
  const change = percentChange(last, first);
  if (change >= 1) return "bullish";
  if (change <= -1) return "bearish";
  return "sideways";
}

function deriveQualityLeverage(input: {
  policy: NonNullable<StrategyVariant["dynamicLeverage"]>;
  signal: Signal;
  indicatorSnapshot: IndicatorSnapshot;
  indicatorScore: ReturnType<typeof scoreIndicatorSnapshot>;
  consecutiveLosses: number;
}) {
  const { policy, signal, indicatorSnapshot, indicatorScore, consecutiveLosses } = input;
  const confidence = clamp((signal.confidence - 0.55) / 0.3, 0, 1);
  const indicators = clamp((indicatorScore.score - 3) / 3, 0, 1);
  const adx = clamp(((indicatorSnapshot.adx ?? 20) - 20) / 20, 0, 1);
  const volume = clamp(((indicatorSnapshot.volumeRatio ?? 1) - 1) / 0.5, 0, 1);
  const atrPenalty = clamp(((indicatorSnapshot.atrPercent ?? 0.35) - 0.35) / 0.65, 0, 1);
  const rawQuality = clamp(
    confidence * 0.35 + indicators * 0.3 + adx * 0.2 + volume * 0.15
      - atrPenalty * policy.volatilityPenalty,
    0,
    1
  );
  const quality = rawQuality ** policy.qualityExponent;
  const qualityLeverage = policy.minimum + (policy.maximum - policy.minimum) * quality;
  const lossMultiplier = policy.lossStepdown ** Math.min(3, consecutiveLosses);
  return round(clamp(qualityLeverage * lossMultiplier, policy.minimum, policy.maximum), 2);
}

function deriveBaseTradePlan(control: FrozenControl, points: Candle[], signal: Signal, availableUsdc: number) {
  const settings = control.settings;
  const baseCollateralPercent = settings.walletAllocationMode === "usd"
    ? clamp((settings.walletPercent / availableUsdc) * 100, 0, 100)
    : clamp(settings.walletPercent, 1, 100);
  const volatilityPercent = getVolatilityPercent(points);
  if (settings.perpsExecutionMode !== "smart-trades" || settings.decisionMode === "shadow") {
    return {
      collateralPercent: baseCollateralPercent,
      leverage: settings.perpsLeverage,
      stopLossPercent: settings.stopLossPercent,
      takeProfitPercent: settings.perpsTakeProfitMode === "percent" ? settings.perpsTakeProfitValue : 0,
      volatilityPercent,
    };
  }

  const smart = {
    conservative: { collateralBase: 0.4, leverageBase: 0.3, defaultTp: 0.9, defaultSl: 1.5, leverageCapMultiplier: 0.45 },
    balanced: { collateralBase: 0.65, leverageBase: 0.5, defaultTp: 1.5, defaultSl: 3.5, leverageCapMultiplier: 0.65 },
    aggressive: { collateralBase: 0.8, leverageBase: 1.35, defaultTp: 3, defaultSl: 7, leverageCapMultiplier: 2 },
  }[settings.smartTradeProfile];
  const volatilityFactor = clamp(volatilityPercent / 2.5, 0, 1.35);
  const confidenceBias = clamp((signal.confidence - 0.55) / 0.35, -0.5, 1);
  const collateralPercent = clamp(
    baseCollateralPercent * (smart.collateralBase + confidenceBias * 0.18 - volatilityFactor * 0.16),
    Math.min(5, baseCollateralPercent),
    100
  );
  const leverage = clamp(
    settings.perpsLeverage * (smart.leverageBase + confidenceBias * 0.12 - volatilityFactor * 0.14),
    1,
    Math.min(250, Math.max(1, settings.perpsLeverage * smart.leverageCapMultiplier))
  );
  const baseTp = settings.perpsTakeProfitMode === "percent" && settings.perpsTakeProfitValue > 0
    ? settings.perpsTakeProfitValue
    : smart.defaultTp;
  const baseSl = settings.stopLossPercent > 0 ? settings.stopLossPercent : smart.defaultSl;
  return {
    collateralPercent: round(collateralPercent, 2),
    leverage: round(leverage, 2),
    stopLossPercent: round(clamp(baseSl * (1 + volatilityFactor * 0.18 - confidenceBias * 0.06), 0.2, 5), 2),
    takeProfitPercent: round(clamp(baseTp * (1 + volatilityFactor * 0.28 + confidenceBias * 0.08), 0.2, 6), 2),
    volatilityPercent: round(volatilityPercent, 2),
  };
}

function computeTriggerPrices(options: {
  control: FrozenControl;
  entryPrice: number;
  collateralUsd: number;
  leverage: number;
  side: "long" | "short";
  stopLossPercent: number;
  takeProfitPercent: number;
}) {
  const direction = options.side === "long" ? 1 : -1;
  const positionSizeUsd = options.collateralUsd * options.leverage;
  const requestedTakeProfitMove = options.control.settings.perpsTakeProfitMode === "usd"
    ? (positionSizeUsd > 0 ? options.control.settings.perpsTakeProfitValue / positionSizeUsd : 0)
    : options.takeProfitPercent > 0 ? options.takeProfitPercent / 100 / options.leverage : 0;
  const requestedStopLossMove = options.stopLossPercent > 0 ? options.stopLossPercent / 100 / options.leverage : 0;
  const minimumTriggerMove = positionSizeUsd > 0 ? 1 / positionSizeUsd : 0;
  const takeProfitMove = requestedTakeProfitMove > 0 ? Math.max(requestedTakeProfitMove, minimumTriggerMove) : 0;
  const stopLossMove = requestedStopLossMove > 0 ? Math.max(requestedStopLossMove, minimumTriggerMove) : 0;
  return {
    takeProfitPrice: takeProfitMove > 0 ? options.entryPrice * (1 + direction * takeProfitMove) : null,
    stopLossPrice: stopLossMove > 0 ? options.entryPrice * (1 - direction * stopLossMove) : null,
  };
}

function computeEntryLockedAtrPrices(options: {
  entryPrice: number;
  leverage: number;
  side: "long" | "short";
  atrPercent: number | null;
  policy: NonNullable<StrategyVariant["entryLockedAtrExit"]>;
}) {
  if (options.atrPercent === null || options.atrPercent <= 0 || options.leverage <= 0) {
    return { takeProfitPrice: null, stopLossPrice: null };
  }
  const stopRoe = clamp(
    options.atrPercent * options.policy.stopMultiplier * options.leverage,
    options.policy.minimumStopRoePercent ?? 0,
    options.policy.maximumStopRoePercent ?? Number.POSITIVE_INFINITY,
  );
  const takeProfitRoe = clamp(
    options.atrPercent * options.policy.takeProfitMultiplier * options.leverage,
    options.policy.minimumTakeProfitRoePercent ?? 0,
    options.policy.maximumTakeProfitRoePercent ?? Number.POSITIVE_INFINITY,
  );
  const direction = options.side === "long" ? 1 : -1;
  const stopMove = stopRoe / 100 / options.leverage;
  const takeProfitMove = takeProfitRoe / 100 / options.leverage;
  return {
    takeProfitPrice: options.entryPrice * (1 + direction * takeProfitMove),
    stopLossPrice: options.entryPrice * (1 - direction * stopMove),
  };
}

function recentHistory(events: ExecutionHistoryEvent[], now: number) {
  const cutoff = now - 24 * 60 * 60 * 1_000;
  const recent = events.filter((event) => event.timestamp >= cutoff).slice(-20).reverse();
  const count = (status: ExecutionHistoryEvent["status"]) => recent.filter((event) => event.status === status).length;
  const failedCount = count("failed");
  const blockedCount = count("blocked");
  const closedCount = count("closed");
  return {
    recentExecutionCount: recent.length,
    approvalRequiredCount: 0,
    submittedCount: 0,
    confirmedCount: closedCount,
    paperExecutedCount: 0,
    blockedCount,
    failedCount,
    recentFailureRate: recent.length > 0 ? failedCount / recent.length : 0,
    recentBlockedRate: recent.length > 0 ? blockedCount / recent.length : 0,
  };
}

function liquidationPrice(open: OpenTrade, elapsedMinutes: number, asset: Asset, costs: CostModel) {
  const hourlyRate = costs.borrowRatePercentPerHour[asset][open.side] * costs.borrowRateMultiplier;
  const borrowFee = open.sizeUsd * (hourlyRate / 100) * (elapsedMinutes / 60);
  const liquidationExitFee = open.sizeUsd * (
    costs.exitBaseFeeRate + costs.priceImpactFeeRate + costs.liquidationFeeRate
  );
  const lossCapacity = Math.max(0, open.collateralUsd - open.entryFeeUsd - liquidationExitFee - borrowFee - costs.networkCostUsd);
  const adverseMove = open.sizeUsd > 0 ? lossCapacity / open.sizeUsd : 0;
  return open.side === "long"
    ? open.entryPrice * (1 - adverseMove)
    : open.entryPrice * (1 + adverseMove);
}

function markEquity(capital: number, open: OpenTrade | null, price: number, elapsedMinutes: number, asset: Asset, costs: CostModel) {
  if (!open) return capital;
  const direction = open.side === "long" ? 1 : -1;
  const gross = open.sizeUsd * direction * ((price - open.entryPrice) / open.entryPrice);
  const hourlyRate = costs.borrowRatePercentPerHour[asset][open.side] * costs.borrowRateMultiplier;
  const borrow = open.sizeUsd * (hourlyRate / 100) * (elapsedMinutes / 60);
  const exitFee = open.sizeUsd * (costs.exitBaseFeeRate + costs.priceImpactFeeRate);
  return capital + Math.max(-open.collateralUsd, gross - open.entryFeeUsd - exitFee - borrow - costs.networkCostUsd);
}

function closeTrade(options: {
  asset: Asset;
  open: OpenTrade;
  exitedAt: number;
  exitPrice: number;
  reason: BacktestTrade["exitReason"];
  costs: CostModel;
}) {
  const { asset, open, exitedAt, exitPrice, reason, costs } = options;
  const durationMinutes = Math.max(0, (exitedAt - open.enteredAt) / 60_000);
  const hourlyRate = costs.borrowRatePercentPerHour[asset][open.side] * costs.borrowRateMultiplier;
  const borrowFeeUsd = open.sizeUsd * (hourlyRate / 100) * (durationMinutes / 60);
  const direction = open.side === "long" ? 1 : -1;
  const grossPnlUsd = open.sizeUsd * direction * ((exitPrice - open.entryPrice) / open.entryPrice);
  const exitFeeRate = costs.exitBaseFeeRate + costs.priceImpactFeeRate + (reason === "liquidation" ? costs.liquidationFeeRate : 0);
  const exitFeeUsd = open.sizeUsd * exitFeeRate;
  const netPnlUsd = reason === "liquidation"
    ? -open.collateralUsd
    : grossPnlUsd - open.entryFeeUsd - exitFeeUsd - borrowFeeUsd - costs.networkCostUsd;
  return {
    trade: {
      asset,
      side: open.side,
      signalType: open.signal.type,
      signalAt: open.signalAt,
      enteredAt: open.enteredAt,
      exitedAt,
      entryPrice: round(open.entryPrice, 8),
      exitPrice: round(exitPrice, 8),
      takeProfitPrice: open.takeProfitPrice === null ? null : round(open.takeProfitPrice, 8),
      stopLossPrice: open.stopLossPrice === null ? null : round(open.stopLossPrice, 8),
      liquidationPriceAtEntry: round(liquidationPrice(open, 0, asset, costs), 8),
      exitReason: reason,
      signalConfidence: open.signal.confidence,
      decisionConfidence: open.decisionConfidence,
      collateralUsd: round(open.collateralUsd),
      leverage: round(open.leverage, 2),
      sizeUsd: round(open.sizeUsd),
      grossPnlUsd: round(grossPnlUsd),
      entryFeeUsd: round(open.entryFeeUsd),
      exitFeeUsd: round(exitFeeUsd),
      borrowFeeUsd: round(borrowFeeUsd),
      networkCostUsd: costs.networkCostUsd,
      netPnlUsd: round(netPnlUsd),
      durationMinutes: round(durationMinutes, 2),
      trendStrengthPercent: round(open.metrics.trend.changePercent),
      breakoutStrengthPercent: round(open.metrics.breakoutChange),
      shortMomentumPercent: round(open.metrics.shortMomentum),
      volatilityPercent: open.volatilityPercent,
      indicatorScore: open.indicatorScore.score,
      indicatorTags: open.indicatorScore.tags,
      rsi: open.indicatorSnapshot.rsi,
      adx: open.indicatorSnapshot.adx,
      volumeRatio: open.indicatorSnapshot.volumeRatio,
      protectionAttached: open.protectionAttached,
    } satisfies BacktestTrade,
    netPnlUsd,
  };
}

export function runBacktest(input: {
  asset: Asset;
  candles: Candle[];
  preparedIndicators: PreparedIndicators;
  control: FrozenControl;
  variant: StrategyVariant;
  costs: CostModel;
  startMs: number;
  endMs: number;
  startingCapitalUsd?: number;
  higherTimeframeQualification?: {
    bullQualified: Uint8Array;
    bearQualified: Uint8Array;
  };
}): BacktestResult {
  const { asset, candles, preparedIndicators, control, variant, costs } = input;
  const rawStartIndex = candles.findIndex((candle) => candle.t >= input.startMs);
  if (rawStartIndex < 0) throw new Error(`Requested ${asset} start is after the available candle history.`);
  const startIndex = Math.max(60, rawStartIndex);
  const rawEndIndex = candles.findIndex((candle) => candle.t >= input.endMs);
  const endIndex = rawEndIndex < 0 ? candles.length : rawEndIndex;
  if (startIndex < 60 || endIndex <= startIndex + 1) throw new Error(`Insufficient ${asset} candles for requested period.`);
  const profile: DecisionLearningProfile = structuredClone(control.profile);
  profile.trendWindow = variant.trendWindow;
  profile.cooldownSeconds = variant.cooldownSeconds;
  profile.assetAdjustments[asset].trendThreshold = variant.trendThreshold;
  profile.assetAdjustments[asset].breakoutPercent = variant.breakoutPercent;
  const indicatorSettings = getIndicatorSettings(profile, variant.minimumIndicatorScore);
  const capitalStart = input.startingCapitalUsd ?? control.startingCapitalUsd;
  let capital = capitalStart;
  let peakEquity = capital;
  let maxDrawdownUsd = 0;
  let maxDrawdownPercent = 0;
  let open: OpenTrade | null = null;
  let pendingEntry: Omit<OpenTrade, "enteredAt" | "entryIndex" | "entryPrice" | "sizeUsd" | "entryFeeUsd" | "protectionAttached"> | null = null;
  let lastSignalAt: number | null = null;
  let entryBlockedUntil = 0;
  let exposedMinutes = 0;
  const events: ExecutionHistoryEvent[] = [];
  const trades: BacktestTrade[] = [];
  let candidateCount = 0;
  let indicatorBlockedCount = 0;
  let confirmationBlockedCount = 0;
  let decisionBlockedCount = 0;
  let directionBlockedCount = 0;
  let staleOrInvalidCount = 0;
  let unprotectedEntryCount = 0;
  const dailyEquity: Array<{ timestamp: number; equityUsd: number }> = [];

  for (let index = startIndex; index < endIndex; index += 1) {
    const candle = candles[index]!;

    if (pendingEntry && !open) {
      const slippage = costs.slippageBps / 10_000;
      const entryPrice = candle.o * (pendingEntry.side === "long" ? 1 + slippage : 1 - slippage);
      const totalEntryRate = costs.entryBaseFeeRate + costs.priceImpactFeeRate;
      const sizeUsd = pendingEntry.collateralUsd * pendingEntry.leverage / (1 + pendingEntry.leverage * totalEntryRate);
      const entryFeeUsd = sizeUsd * totalEntryRate;
      const atrPrices = variant.entryLockedAtrExit
        ? computeEntryLockedAtrPrices({
            entryPrice,
            leverage: pendingEntry.leverage,
            side: pendingEntry.side,
            atrPercent: pendingEntry.indicatorSnapshot.atrPercent,
            policy: variant.entryLockedAtrExit,
          })
        : null;
      const takeProfitPrice = atrPrices?.takeProfitPrice ?? pendingEntry.takeProfitPrice;
      const stopLossPrice = atrPrices?.stopLossPrice ?? pendingEntry.stopLossPrice;
      const takeProfitValid = takeProfitPrice === null || (
        pendingEntry.side === "long"
          ? takeProfitPrice > entryPrice
          : takeProfitPrice < entryPrice
      );
      const stopLossValid = stopLossPrice === null || (
        pendingEntry.side === "long"
          ? stopLossPrice < entryPrice
          : stopLossPrice > entryPrice
      );
      const protectionAttached = (takeProfitPrice !== null || stopLossPrice !== null)
        && takeProfitValid
        && stopLossValid;
      if (!protectionAttached) unprotectedEntryCount += 1;
      open = {
        ...pendingEntry,
        enteredAt: candle.t,
        entryIndex: index,
        entryPrice,
        sizeUsd,
        entryFeeUsd,
        protectionAttached,
        takeProfitPrice: protectionAttached ? takeProfitPrice : null,
        stopLossPrice: protectionAttached ? stopLossPrice : null,
      };
      pendingEntry = null;
    }

    if (open) {
      exposedMinutes += 1;
      const elapsedMinutes = Math.max(0, (candle.t - open.enteredAt) / 60_000);
      const liq = liquidationPrice(open, elapsedMinutes, asset, costs);
      const liquidationTouched = open.side === "long" ? candle.l <= liq : candle.h >= liq;
      const tpTouched = open.takeProfitPrice !== null && (
        open.side === "long" ? candle.h >= open.takeProfitPrice : candle.l <= open.takeProfitPrice
      );
      const stopTouched = open.stopLossPrice !== null && (
        open.side === "long" ? candle.l <= open.stopLossPrice : candle.h >= open.stopLossPrice
      );
      if (liquidationTouched || stopTouched || tpTouched) {
        const reason = liquidationTouched
          ? "liquidation" as const
          : stopTouched
            ? "stop-loss" as const
            : "take-profit" as const;
        const rawExit = liquidationTouched ? liq : stopTouched ? open.stopLossPrice! : open.takeProfitPrice!;
        const slippage = costs.slippageBps / 10_000;
        const exitPrice = rawExit * (open.side === "long" ? 1 - slippage : 1 + slippage);
        const closed = closeTrade({ asset, open, exitedAt: candle.t + 60_000, exitPrice, reason, costs });
        capital = Math.max(0, capital + closed.netPnlUsd);
        trades.push(closed.trade);
        events.push({ timestamp: candle.t + 60_000, status: "closed" });
        if (reason === "stop-loss" && variant.stopLossCooldownSeconds) {
          entryBlockedUntil = candle.t + variant.stopLossCooldownSeconds * 1_000;
        }
        open = null;
      }
    }

    const equity = markEquity(capital, open, candle.v, open ? (candle.t - open.enteredAt) / 60_000 : 0, asset, costs);
    const dayTimestamp = Math.floor(candle.t / 86_400_000) * 86_400_000;
    if (dailyEquity[dailyEquity.length - 1]?.timestamp === dayTimestamp) {
      dailyEquity[dailyEquity.length - 1]!.equityUsd = round(equity);
    } else {
      dailyEquity.push({ timestamp: dayTimestamp, equityUsd: round(equity) });
    }
    peakEquity = Math.max(peakEquity, equity);
    const drawdown = peakEquity - equity;
    maxDrawdownUsd = Math.max(maxDrawdownUsd, drawdown);
    maxDrawdownPercent = Math.max(maxDrawdownPercent, peakEquity > 0 ? drawdown / peakEquity * 100 : 0);

    if (open || pendingEntry || capital < 10 || candle.t < entryBlockedUntil) continue;
    const windowCutoff = candle.t - variant.trendWindow * 60_000;
    let windowStart = index;
    while (windowStart > 0 && candles[windowStart - 1]!.t >= windowCutoff) windowStart -= 1;
    const windowPoints = candles.slice(windowStart, index + 1);
    if (windowPoints.length < 3) continue;
    const signal: Signal | undefined = detectSignals({
      symbol: `${asset}/USD`,
      points: windowPoints,
      params: {
        trendWindow: variant.trendWindow,
        trendThreshold: variant.trendThreshold,
        breakoutPercent: variant.breakoutPercent,
        cooldownSeconds: variant.cooldownSeconds,
      },
      lastSignalAt: lastSignalAt ?? undefined,
    })[0];
    if (!signal) continue;
    candidateCount += 1;
    const higherTimeframeQualified = signal.direction === "bullish"
      ? input.higherTimeframeQualification?.bullQualified[index]
      : input.higherTimeframeQualification?.bearQualified[index];
    if (input.higherTimeframeQualification && !higherTimeframeQualified) {
      directionBlockedCount += 1;
      lastSignalAt = signal.timestamp;
      continue;
    }
    const metrics = computeSignalMetrics(windowPoints);
    const volatilityPercent = getVolatilityPercent(windowPoints);
    if (volatilityPercent > profile.volatilityCeilingPercent) {
      continue;
    }

    const directionIndex = signal.direction === "bullish" ? preparedIndicators.bullQualified[index] : preparedIndicators.bearQualified[index];
    if (variant.useIndicators && preparedIndicators.ready[index] && !directionIndex) {
      indicatorBlockedCount += 1;
      lastSignalAt = signal.timestamp;
      continue;
    }
    if (variant.useLearnedConfirmation) {
      const trendQualified = Math.abs(metrics.trend.changePercent) >= variant.trendThreshold;
      const breakoutMetric = Math.abs(metrics.breakoutChange) >= variant.breakoutPercent
        ? metrics.breakoutChange
        : metrics.shortMomentum;
      const breakoutQualified = Math.abs(breakoutMetric) >= variant.breakoutPercent * 0.6;
      const trendDirection = metrics.trend.changePercent >= 0 ? "bullish" : "bearish";
      const breakoutDirection = breakoutMetric >= 0 ? "bullish" : "bearish";
      if (!trendQualified || !breakoutQualified || trendDirection !== breakoutDirection || signal.direction !== trendDirection) {
        confirmationBlockedCount += 1;
        lastSignalAt = signal.timestamp;
        continue;
      }
    }
    if ((variant.directionMode ?? control.settings.mode) === "buy-only" && signal.direction === "bearish") {
      directionBlockedCount += 1;
      lastSignalAt = signal.timestamp;
      continue;
    }

    const indicatorLookbackMinutes = Math.max(60, Math.min(1_440, variant.indicatorLookbackMinutes ?? 60));
    const historyCutoff = candle.t - (indicatorLookbackMinutes - 1) * 60_000;
    let historyStart = index;
    while (historyStart > 0 && candles[historyStart - 1]!.t >= historyCutoff) historyStart -= 1;
    const historyPoints = candles.slice(historyStart, index + 1);
    const indicatorSnapshot = computeIndicatorSnapshot(historyPoints, indicatorSettings);
    const indicatorScore = scoreIndicatorSnapshot(indicatorSnapshot, signal.direction, indicatorSettings);
    let basePlan = deriveBaseTradePlan(control, windowPoints, signal, capital);
    if (variant.dynamicLeverage) {
      let consecutiveLosses = 0;
      for (let tradeIndex = trades.length - 1; tradeIndex >= 0; tradeIndex -= 1) {
        if (trades[tradeIndex]!.netPnlUsd >= 0) break;
        consecutiveLosses += 1;
      }
      basePlan = {
        ...basePlan,
        leverage: deriveQualityLeverage({
          policy: variant.dynamicLeverage,
          signal,
          indicatorSnapshot,
          indicatorScore,
          consecutiveLosses,
        }),
      };
    }
    const plan = applyLearnedTradePlan({ basePlan, asset, points: windowPoints, profile });
    const collateralUsd = round(capital * plan.collateralPercent / 100);
    if (!Number.isFinite(collateralUsd) || collateralUsd < 10) {
      staleOrInvalidCount += 1;
      lastSignalAt = signal.timestamp;
      continue;
    }
    const side = signal.direction === "bullish" ? "long" : "short";
    const signalSpot = candle.v;
    const triggers = computeTriggerPrices({
      control,
      entryPrice: signalSpot,
      collateralUsd,
      leverage: plan.leverage,
      side,
      stopLossPercent: variant.stopLossRoePercent ?? plan.stopLossPercent,
      takeProfitPercent: plan.takeProfitPercent,
    });
    let resolvedCollateral = collateralUsd;
    let resolvedLeverage = plan.leverage;
    let resolvedTakeProfit = triggers.takeProfitPrice;
    let resolvedStopLoss = triggers.stopLossPrice;
    let decisionConfidence = signal.confidence;

    if (variant.useDecisionLayer) {
      const recommendation = evaluateTradeDecision({
        decisionId: `backtest-${asset}-${candle.t}`,
        createdAt: new Date(candle.t).toISOString(),
        walletAddress: "backtest-wallet",
        sessionId: "backtest-session",
        sessionMode: "live",
        executionModel: "delegated-ready",
        signalId: signal.id,
        symbol: signal.symbol,
        summary: signal.summary,
        direction: signal.direction,
        signalConfidence: signal.confidence,
        asset,
        requestedTrade: {
          collateralUsd,
          leverage: plan.leverage,
          takeProfitPrice: triggers.takeProfitPrice,
          stopLossPrice: triggers.stopLossPrice,
          maxSlippageBps: 100,
          executionStyle: control.settings.perpsExecutionMode,
          smartTradeProfile: control.settings.smartTradeProfile,
        },
        marketContext: {
          spotPrice: signalSpot,
          volatilityPercent: plan.volatilityPercent,
          trendBias: getTrendBias(windowPoints),
          availableUsdc: capital,
          hasOpenPosition: false,
          recentPriceChangePercent: metrics.trend.changePercent,
        },
        strategyContext: null,
        historyContext: recentHistory(events, candle.t),
        shadowMode: false,
      }, profile);
      decisionConfidence = recommendation.confidenceScore;
      if (!recommendation.shouldTrade) {
        decisionBlockedCount += 1;
        events.push({ timestamp: candle.t, status: "blocked" });
        lastSignalAt = signal.timestamp;
        continue;
      }
      resolvedCollateral = recommendation.recommendedCollateralUsd;
      resolvedLeverage = recommendation.recommendedLeverage;
      resolvedTakeProfit = recommendation.recommendedTakeProfitPrice;
      resolvedStopLoss = recommendation.recommendedStopLossPrice;
    }

    if (variant.enforceTargetRiskAtStop && signalSpot > 0 && resolvedLeverage > 0) {
      const underlyingStopPercent = variant.entryLockedAtrExit && indicatorSnapshot.atrPercent !== null
        ? clamp(
            indicatorSnapshot.atrPercent * variant.entryLockedAtrExit.stopMultiplier * resolvedLeverage,
            variant.entryLockedAtrExit.minimumStopRoePercent ?? 0,
            variant.entryLockedAtrExit.maximumStopRoePercent ?? Number.POSITIVE_INFINITY,
          ) / resolvedLeverage
        : resolvedStopLoss !== null
          ? Math.abs(resolvedStopLoss - signalSpot) / signalSpot * 100
          : 0;
      const stopRoePercent = underlyingStopPercent * resolvedLeverage;
      if (stopRoePercent > 0) {
        const riskSizedCollateral = capital * profile.targetWalletRiskPercent / stopRoePercent;
        resolvedCollateral = Math.min(resolvedCollateral, riskSizedCollateral);
      }
    }

    if (
      resolvedLeverage > control.risk.maxUserLeverage
      || resolvedCollateral > capital * control.risk.maxTradePct
      || resolvedCollateral > capital * control.risk.maxExposurePct
      || resolvedCollateral < 10
    ) {
      staleOrInvalidCount += 1;
      events.push({ timestamp: candle.t, status: "blocked" });
      lastSignalAt = signal.timestamp;
      continue;
    }
    pendingEntry = {
      side,
      signal,
      signalAt: candle.t,
      takeProfitPrice: resolvedTakeProfit,
      stopLossPrice: resolvedStopLoss,
      collateralUsd: resolvedCollateral,
      leverage: resolvedLeverage,
      decisionConfidence,
      metrics,
      volatilityPercent: plan.volatilityPercent,
      indicatorSnapshot,
      indicatorScore,
    };
    if (variant.executionTiming === "signal-close") {
      const slippage = costs.slippageBps / 10_000;
      const entryPrice = candle.v * (pendingEntry.side === "long" ? 1 + slippage : 1 - slippage);
      const totalEntryRate = costs.entryBaseFeeRate + costs.priceImpactFeeRate;
      const sizeUsd = pendingEntry.collateralUsd * pendingEntry.leverage / (1 + pendingEntry.leverage * totalEntryRate);
      const entryFeeUsd = sizeUsd * totalEntryRate;
      const atrPrices = variant.entryLockedAtrExit
        ? computeEntryLockedAtrPrices({
            entryPrice,
            leverage: pendingEntry.leverage,
            side: pendingEntry.side,
            atrPercent: pendingEntry.indicatorSnapshot.atrPercent,
            policy: variant.entryLockedAtrExit,
          })
        : null;
      const takeProfitPrice = atrPrices?.takeProfitPrice ?? pendingEntry.takeProfitPrice;
      const stopLossPrice = atrPrices?.stopLossPrice ?? pendingEntry.stopLossPrice;
      const takeProfitValid = takeProfitPrice === null || (
        pendingEntry.side === "long"
          ? takeProfitPrice > entryPrice
          : takeProfitPrice < entryPrice
      );
      const stopLossValid = stopLossPrice === null || (
        pendingEntry.side === "long"
          ? stopLossPrice < entryPrice
          : stopLossPrice > entryPrice
      );
      const protectionAttached = (takeProfitPrice !== null || stopLossPrice !== null)
        && takeProfitValid
        && stopLossValid;
      if (!protectionAttached) unprotectedEntryCount += 1;
      open = {
        ...pendingEntry,
        enteredAt: candle.t + 60_000,
        entryIndex: index,
        entryPrice,
        sizeUsd,
        entryFeeUsd,
        protectionAttached,
        takeProfitPrice: protectionAttached ? takeProfitPrice : null,
        stopLossPrice: protectionAttached ? stopLossPrice : null,
      };
      pendingEntry = null;
    }
    lastSignalAt = signal.timestamp;
  }

  if (open) {
    const candle = candles[endIndex - 1]!;
    const slippage = costs.slippageBps / 10_000;
    const exitPrice = candle.v * (open.side === "long" ? 1 - slippage : 1 + slippage);
    const closed = closeTrade({ asset, open, exitedAt: candle.t + 60_000, exitPrice, reason: "end-of-period", costs });
    capital = Math.max(0, capital + closed.netPnlUsd);
    trades.push(closed.trade);
    if (dailyEquity.length > 0) dailyEquity[dailyEquity.length - 1]!.equityUsd = round(capital);
  }
  // A signal on the final candle cannot execute inside the test period.
  pendingEntry = null;

  const wins = trades.filter((trade) => trade.netPnlUsd > 0);
  const losses = trades.filter((trade) => trade.netPnlUsd <= 0);
  const grossProfitUsd = wins.reduce((sum, trade) => sum + trade.netPnlUsd, 0);
  const grossLossUsd = Math.abs(losses.reduce((sum, trade) => sum + trade.netPnlUsd, 0));
  const totalFeesUsd = trades.reduce((sum, trade) => sum + trade.entryFeeUsd + trade.exitFeeUsd + trade.networkCostUsd, 0);
  const totalBorrowFeesUsd = trades.reduce((sum, trade) => sum + trade.borrowFeeUsd, 0);
  const periodMinutes = Math.max(1, (candles[endIndex - 1]!.t - candles[startIndex]!.t) / 60_000 + 1);
  const dailyReturns = dailyEquity.slice(1).flatMap((point, index) => {
    const previous = dailyEquity[index]!.equityUsd;
    return previous > 0 ? [point.equityUsd / previous - 1] : [];
  });
  const averageDailyReturn = mean(dailyReturns);
  const dailyDeviation = sampleDeviation(dailyReturns);
  const downsideDeviation = Math.sqrt(mean(dailyReturns.map((value) => Math.min(0, value) ** 2)));
  const elapsedYears = periodMinutes / (365.25 * 24 * 60);
  const annualizedReturn = elapsedYears > 0 && capitalStart > 0 && capital > 0
    ? (capital / capitalStart) ** (1 / elapsedYears) - 1
    : capital <= 0 ? -1 : 0;
  return {
    asset,
    variant,
    costModel: costs.name,
    period: { start: candles[startIndex]!.t, end: candles[endIndex - 1]!.t + 60_000 },
    startingCapitalUsd: capitalStart,
    endingCapitalUsd: round(capital),
    netPnlUsd: round(capital - capitalStart),
    returnPercent: round((capital - capitalStart) / capitalStart * 100),
    maxDrawdownUsd: round(maxDrawdownUsd),
    maxDrawdownPercent: round(maxDrawdownPercent),
    sharpeRatio: dailyDeviation > 0 ? round(averageDailyReturn / dailyDeviation * Math.sqrt(365)) : 0,
    sortinoRatio: downsideDeviation > 0 ? round(averageDailyReturn / downsideDeviation * Math.sqrt(365)) : 0,
    calmarRatio: maxDrawdownPercent > 0 ? round(annualizedReturn / (maxDrawdownPercent / 100)) : 0,
    underlyingReturnPercent: round(percentChange(candles[endIndex - 1]!.v, candles[startIndex]!.v)),
    tradeCount: trades.length,
    winCount: wins.length,
    lossCount: losses.length,
    winRate: trades.length > 0 ? round(wins.length / trades.length) : 0,
    grossProfitUsd: round(grossProfitUsd),
    grossLossUsd: round(grossLossUsd),
    profitFactor: grossLossUsd > 0 ? round(grossProfitUsd / grossLossUsd) : grossProfitUsd > 0 ? 99 : 0,
    expectancyUsd: trades.length > 0 ? round((capital - capitalStart) / trades.length) : 0,
    liquidationCount: trades.filter((trade) => trade.exitReason === "liquidation").length,
    totalFeesUsd: round(totalFeesUsd),
    totalBorrowFeesUsd: round(totalBorrowFeesUsd),
    averageLeverage: trades.length > 0 ? round(trades.reduce((sum, trade) => sum + trade.leverage, 0) / trades.length) : 0,
    averageDurationMinutes: trades.length > 0 ? round(trades.reduce((sum, trade) => sum + trade.durationMinutes, 0) / trades.length) : 0,
    exposurePercent: round(exposedMinutes / periodMinutes * 100),
    candidateCount,
    indicatorBlockedCount,
    confirmationBlockedCount,
    decisionBlockedCount,
    directionBlockedCount,
    staleOrInvalidCount,
    unprotectedEntryCount,
    dailyEquity,
    trades,
  };
}

export const BASELINE_COST_MODEL: CostModel = {
  name: "jupiter-observed-baseline",
  entryBaseFeeRate: 0.0006,
  exitBaseFeeRate: 0.0006,
  priceImpactFeeRate: 0.0001,
  liquidationFeeRate: 0.002,
  slippageBps: 0,
  networkCostUsd: 0.01,
  borrowRatePercentPerHour: {
    SOL: { long: 0.0014, short: 0.0006 },
    ETH: { long: 0.0012, short: 0.0006 },
    BTC: { long: 0.0014, short: 0.0006 },
  },
  borrowRateMultiplier: 1,
};
