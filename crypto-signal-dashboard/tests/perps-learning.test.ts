import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { TradeDecisionRecord } from "../lib/decision/types";
import type { PerpsUserExecution } from "../lib/perps/sessionTypes";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "brembot-perps-learning-"));
process.env.REDIS_URL = "";
process.env.PERPS_LEARNING_PROFILES_FILE = path.join(tempRoot, "profiles.json");
process.env.PERPS_LEARNING_PROFILE_HISTORY_FILE = path.join(tempRoot, "profile-history.json");
process.env.PERPS_LEARNING_OUTCOMES_FILE = path.join(tempRoot, "outcomes.json");

let learningStore: typeof import("../lib/decision/learningStore");
let trainer: typeof import("../lib/decision/trainer");
let runtime: typeof import("../lib/decision/learningRuntime");
let learningTypes: typeof import("../lib/decision/learningTypes");
let outcomeReconciler: typeof import("../lib/decision/outcomeReconciler");

test.before(async () => {
  learningStore = await import("../lib/decision/learningStore");
  trainer = await import("../lib/decision/trainer");
  runtime = await import("../lib/decision/learningRuntime");
  learningTypes = await import("../lib/decision/learningTypes");
  outcomeReconciler = await import("../lib/decision/outcomeReconciler");
});

test.beforeEach(() => {
  for (const file of [process.env.PERPS_LEARNING_PROFILES_FILE, process.env.PERPS_LEARNING_PROFILE_HISTORY_FILE, process.env.PERPS_LEARNING_OUTCOMES_FILE]) {
    if (file && fs.existsSync(file)) fs.rmSync(file);
  }
});

test("manual training activates the operator-selected baseline before enough outcomes exist", async () => {
  const result = await trainer.trainWalletDecisionProfile({
    walletAddress: "learning-wallet-baseline",
    config: null,
    source: "manual-training",
    force: true,
  });

  assert.equal(result.activated, true);
  assert.equal(result.profile.source, "operator-baseline");
  assert.equal(result.profile.trendWindow, 145);
  for (const asset of ["SOL", "ETH", "BTC"] as const) {
    assert.equal(result.profile.assetAdjustments[asset].trendThreshold, 1.65);
    assert.equal(result.profile.assetAdjustments[asset].breakoutPercent, 0.35);
  }
  assert.equal(result.profile.cooldownSeconds, 27_000);
  assert.equal(result.profile.leverageFloor, 2);
  assert.equal(result.profile.leverageCap, 10);
  assert.equal(result.profile.maximumAllocationPercent, 50);
  assert.equal(result.profile.targetWalletRiskPercent, 3);
  assert.equal(result.profile.takeProfitRoePercent, 25);
  assert.equal(result.profile.stopLossRoePercent, 25);
  const plan = runtime.applyLearnedTradePlan({
    basePlan: { collateralPercent: 80, leverage: 10, stopLossPercent: 10, takeProfitPercent: 10, volatilityPercent: 2 },
    asset: "SOL",
    points: Array.from({ length: 16 }, (_, index) => ({ t: index * 60_000, v: 100 + index * 0.1 })),
    profile: result.profile,
  });
  assert.equal(plan.collateralPercent, 12);
  assert.ok(plan.leverage >= 2 && plan.leverage <= 10);
  assert.equal(plan.takeProfitPercent, 25);
  assert.equal(plan.stopLossPercent, 25);
});

test("forced manual training replaces an existing pre-sample profile with the current baseline", async () => {
  const walletAddress = "learning-wallet-baseline-reset";
  const first = await trainer.trainWalletDecisionProfile({
    walletAddress,
    config: null,
    source: "manual-training",
    force: true,
  });
  const reset = await trainer.trainWalletDecisionProfile({
    walletAddress,
    config: null,
    source: "manual-training",
    force: true,
  });

  assert.equal(reset.activated, true);
  assert.equal(reset.skipped, false);
  assert.equal(reset.profile.version, first.profile.version + 1);
  assert.notEqual(reset.profile.profileId, first.profile.profileId);
  assert.equal(reset.profile.assetAdjustments.SOL.trendThreshold, 1.65);
  assert.equal((await learningStore.getActiveDecisionLearningProfile(walletAddress))?.profileId, reset.profile.profileId);
});

test("automatic training migrates a legacy active profile before applying new outcomes", async () => {
  const walletAddress = "learning-wallet-legacy-migration";
  const seeded = await trainer.trainWalletDecisionProfile({
    walletAddress,
    config: null,
    source: "manual-training",
    force: true,
  });
  const legacy = learningTypes.decisionLearningProfileSchema.parse({
    ...seeded.profile,
    profileId: "legacy-profile",
    strategyBaselineVersion: 1,
    trendWindow: 15,
    cooldownSeconds: 180,
    leverageFloor: 1,
    leverageCap: 50,
    stopLossRoePercent: 0,
  });
  await learningStore.saveDecisionLearningProfile(legacy, true);

  const result = await trainer.trainWalletDecisionProfile({
    walletAddress,
    config: null,
    source: "automatic",
  });

  assert.equal(result.activated, true);
  assert.equal(result.migrated, true);
  assert.equal(result.profile.strategyBaselineVersion, 4);
  assert.equal(result.profile.trendWindow, 145);
  assert.equal(result.profile.cooldownSeconds, 27_000);
  assert.equal(result.profile.leverageFloor, 2);
  assert.equal(result.profile.leverageCap, 10);
  assert.equal(result.profile.takeProfitRoePercent, 25);
  assert.equal(result.profile.stopLossRoePercent, 25);
});

test("each newly closed trade incrementally updates the active wallet profile", async () => {
  const walletAddress = "learning-wallet-online";
  const baseline = await trainer.trainWalletDecisionProfile({
    walletAddress,
    config: null,
    source: "manual-training",
    force: true,
  });
  await learningStore.saveTradeLearningOutcomes([learningTypes.tradeLearningOutcomeSchema.parse({
    outcomeId: `${walletAddress}:1`,
    reconciliationVersion: 2,
    trainingEligible: true,
    walletAddress,
    executionId: "execution-online-1",
    decisionId: "decision-online-1",
    signalId: "signal-online-1",
    asset: "SOL",
    side: "long",
    openedAt: new Date(1_700_000_000_000).toISOString(),
    closedAt: new Date(1_700_000_900_000).toISOString(),
    positionPubkey: "position-online-1",
    entryPrice: 100,
    exitPrice: 99,
    collateralUsd: 10,
    sizeUsd: 500,
    leverage: 50,
    takeProfitPrice: 100.08,
    stopLossPrice: 99.96,
    grossPnlUsd: -5,
    feesUsd: 0.2,
    netPnlUsd: -5.2,
    returnOnCollateralPercent: -52,
    durationMinutes: 15,
    exitReason: "stop-loss",
    signalConfidence: 0.61,
    signalType: "trend",
    trendWindow: 15,
    trendThreshold: 0.36,
    breakoutPercent: 0.3,
    cooldownSeconds: 180,
    trendStrengthPercent: 0.4,
    breakoutStrengthPercent: 0.31,
    volatilityPercent: 2,
    atrPercent: 0.4,
    trendBias: "bullish",
    createdAt: new Date().toISOString(),
  })]);

  const result = await trainer.trainWalletDecisionProfile({
    walletAddress,
    config: null,
    source: "automatic",
  });

  assert.equal(result.activated, true);
  assert.equal(result.incremental, true);
  assert.equal(result.profile.learnedFromClosedTrades, 1);
  assert.ok(result.profile.minimumConfidence > baseline.profile.minimumConfidence);
  assert.ok(result.profile.assetAdjustments.SOL.leverageMultiplier < baseline.profile.assetAdjustments.SOL.leverageMultiplier);
  assert.equal((await learningStore.getActiveDecisionLearningProfile(walletAddress))?.profileId, result.profile.profileId);
});

test("Smart and scalp losses update only their respective learning algorithms", async () => {
  const walletAddress = "learning-wallet-strategy-isolation";
  const baseline = await trainer.trainWalletDecisionProfile({
    walletAddress,
    config: null,
    source: "manual-training",
    force: true,
  });
  const makeOutcome = (index: number, signalType: "trend" | "scalp") => learningTypes.tradeLearningOutcomeSchema.parse({
    outcomeId: `${walletAddress}:${index}`,
    reconciliationVersion: 2,
    trainingEligible: true,
    walletAddress,
    executionId: `execution-isolation-${index}`,
    decisionId: `decision-isolation-${index}`,
    signalId: `signal-isolation-${index}`,
    asset: "SOL",
    side: "long",
    openedAt: new Date(1_700_000_000_000 + index * 3_600_000).toISOString(),
    closedAt: new Date(1_700_000_900_000 + index * 3_600_000).toISOString(),
    positionPubkey: `position-isolation-${index}`,
    entryPrice: 100,
    exitPrice: 99,
    collateralUsd: 10,
    sizeUsd: 50,
    leverage: 5,
    takeProfitPrice: 105,
    stopLossPrice: 97,
    grossPnlUsd: -1,
    feesUsd: 0.15,
    netPnlUsd: -1.15,
    returnOnCollateralPercent: -11.5,
    durationMinutes: 15,
    exitReason: "stop-loss",
    signalConfidence: 0.64,
    signalType,
    trendWindow: 145,
    trendThreshold: 1.65,
    breakoutPercent: 0.35,
    cooldownSeconds: signalType === "scalp" ? 1_500 : 27_000,
    trendStrengthPercent: 0.4,
    breakoutStrengthPercent: 0.2,
    volatilityPercent: 1.5,
    atrPercent: 0.15,
    indicatorScore: 3,
    emaSpreadPercent: 0.3,
    emaSlopePercent: -0.05,
    rsi: 45,
    macdHistogram: -0.01,
    macdHistogramChange: -0.01,
    adx: 21,
    plusDi: 18,
    minusDi: 22,
    volumeRatio: 0.72,
    bollingerBandwidthPercent: 0.7,
    bollingerPosition: 0.2,
    scalpSetupType: signalType === "scalp" ? "range-reversal" : null,
    priceActionScore: signalType === "scalp" ? 0.6 : null,
    priceActionTags: signalType === "scalp" ? ["SCALP_RANGE_LOW"] : [],
    trendBias: "sideways",
    createdAt: new Date().toISOString(),
  });

  await learningStore.saveTradeLearningOutcomes([makeOutcome(1, "scalp")]);
  const afterScalp = await trainer.trainWalletDecisionProfile({
    walletAddress,
    config: null,
    source: "automatic",
  });
  assert.equal(afterScalp.profile.minimumConfidence, baseline.profile.minimumConfidence);
  assert.deepEqual(afterScalp.profile.assetAdjustments, baseline.profile.assetAdjustments);
  assert.ok((afterScalp.profile.scalpProfile?.minimumConfidence ?? 0) > (baseline.profile.scalpProfile?.minimumConfidence ?? 0));
  assert.ok((afterScalp.profile.scalpProfile?.riskMultiplier ?? 1) < 1);

  const scalpSnapshot = structuredClone(afterScalp.profile.scalpProfile);
  await learningStore.saveTradeLearningOutcomes([makeOutcome(2, "trend")]);
  const afterSmart = await trainer.trainWalletDecisionProfile({
    walletAddress,
    config: null,
    source: "automatic",
  });
  assert.ok(afterSmart.profile.minimumConfidence > afterScalp.profile.minimumConfidence);
  assert.ok(afterSmart.profile.assetAdjustments.SOL.leverageMultiplier < afterScalp.profile.assetAdjustments.SOL.leverageMultiplier);
  const scalpAfterSmart = structuredClone(afterSmart.profile.scalpProfile);
  if (scalpSnapshot) scalpSnapshot.validation.reasons = [];
  if (scalpAfterSmart) scalpAfterSmart.validation.reasons = [];
  assert.deepEqual(scalpAfterSmart, scalpSnapshot);
});

test("trained runtime enforces risk sizing, adaptive leverage bounds, and stored TP/SL", () => {
  const baseline = learningTypes.decisionLearningProfileSchema.parse({
    profileId: "profile-runtime",
    walletAddress: "wallet-runtime",
    version: 1,
    status: "active",
    source: "manual-training",
    createdAt: new Date().toISOString(),
    promotedAt: new Date().toISOString(),
    learnedFromClosedTrades: 0,
    minimumConfidence: 0.62,
    leverageFloor: 2,
    leverageCap: 3,
    leverageQualityExponent: 2.5,
    leverageVolatilityPenalty: 1.25,
    leverageLossStepdown: 1,
    maximumAllocationPercent: 10,
    targetWalletRiskPercent: 0.35,
    preferredDirection: "balanced",
    trendWindow: 30,
    cooldownSeconds: 600,
    takeProfitRoePercent: 6,
    stopLossRoePercent: 2.5,
    minimumRewardRiskRatio: 2,
    atrLookback: 14,
    atrStopMultiplier: 1.5,
    volatilityCeilingPercent: 5,
    assetAdjustments: {
      SOL: { trendThreshold: 1.5, breakoutPercent: 1.2, leverageMultiplier: 0.9, allocationMultiplier: 0.85 },
      ETH: { trendThreshold: 1.2, breakoutPercent: 1, leverageMultiplier: 1, allocationMultiplier: 1 },
      BTC: { trendThreshold: 1, breakoutPercent: 0.8, leverageMultiplier: 1, allocationMultiplier: 1 },
    },
    validation: { sampleSize: 0, trainingSize: 0, validationSize: 0, winRate: 0, expectancyUsd: 0, profitFactor: 0, maxDrawdownUsd: 0, passed: true, reasons: ["baseline"] },
    summary: "baseline",
  });
  const points = Array.from({ length: 20 }, (_, index) => ({
    t: index * 60_000,
    v: 100 + index * 0.2,
    o: 99.9 + index * 0.2,
    h: 100.4 + index * 0.2,
    l: 99.7 + index * 0.2,
  }));
  const plan = runtime.applyLearnedTradePlan({
    basePlan: { collateralPercent: 25, leverage: 10, stopLossPercent: 0, takeProfitPercent: 0, volatilityPercent: 2 },
    asset: "BTC",
    points,
    profile: baseline,
  });

  assert.ok(plan.leverage >= 2 && plan.leverage <= 3);
  assert.ok(plan.collateralPercent <= 10);
  assert.equal(plan.stopLossPercent, 25);
  assert.ok(plan.takeProfitPercent > 0);
});

test("profitable chronological holdout history promotes a versioned learned profile", async () => {
  const walletAddress = "learning-wallet-history";
  const outcomes = Array.from({ length: 60 }, (_, index) => learningTypes.tradeLearningOutcomeSchema.parse({
    outcomeId: `${walletAddress}:${index}`,
    reconciliationVersion: 2,
    trainingEligible: true,
    walletAddress,
    executionId: `execution-${index}`,
    decisionId: `decision-${index}`,
    signalId: `signal-${index}`,
    asset: index % 3 === 0 ? "SOL" : index % 3 === 1 ? "ETH" : "BTC",
    side: index % 2 === 0 ? "long" : "short",
    openedAt: new Date(1_700_000_000_000 + index * 3_600_000).toISOString(),
    closedAt: new Date(1_700_000_900_000 + index * 3_600_000).toISOString(),
    positionPubkey: `position-${index}`,
    entryPrice: 100,
    exitPrice: 102,
    collateralUsd: 10,
    sizeUsd: 30,
    leverage: 3,
    takeProfitPrice: 102,
    stopLossPrice: 99.2,
    grossPnlUsd: 1.25,
    feesUsd: 0.15,
    netPnlUsd: 1.1,
    returnOnCollateralPercent: 11,
    durationMinutes: 15,
    exitReason: "take-profit",
    signalConfidence: 0.8,
    signalType: "trend",
    trendWindow: 30,
    trendThreshold: 1.2,
    breakoutPercent: 1,
    cooldownSeconds: 600,
    trendStrengthPercent: 1.5,
    breakoutStrengthPercent: 1.1,
    volatilityPercent: 2,
    atrPercent: 0.4,
    trendBias: index % 2 === 0 ? "bullish" : "bearish",
    createdAt: new Date().toISOString(),
  }));
  await learningStore.saveTradeLearningOutcomes(outcomes);

  const result = await trainer.trainWalletDecisionProfile({
    walletAddress,
    config: null,
    source: "manual-training",
    force: true,
  });

  assert.equal(result.activated, true);
  assert.equal(result.profile.source, "manual-training");
  assert.equal(result.profile.validation.passed, true);
  assert.equal(result.profile.learnedFromClosedTrades, 60);
  assert.equal(result.profile.strategyBaselineVersion, 4);
  assert.ok(result.profile.trendWindow >= 120 && result.profile.trendWindow <= 180);
  assert.ok(result.profile.cooldownSeconds >= 27_000 && result.profile.cooldownSeconds <= 43_200);
  assert.ok(result.profile.takeProfitRoePercent >= 20 && result.profile.takeProfitRoePercent <= 30);
  assert.equal(result.profile.stopLossRoePercent, 25);
  assert.equal(result.profile.targetWalletRiskPercent, 3);
  assert.equal(result.profile.maximumAllocationPercent, 50);
  assert.equal(result.profile.leverageFloor, 2);
  assert.equal(result.profile.leverageCap, 10);
  assert.equal((await learningStore.getActiveDecisionLearningProfile(walletAddress))?.profileId, result.profile.profileId);
});

test("a failing trained candidate never replaces the active live profile", async () => {
  const walletAddress = "learning-wallet-rollback";
  const baseline = await trainer.trainWalletDecisionProfile({
    walletAddress,
    config: null,
    source: "manual-training",
    force: true,
  });
  const outcomes = Array.from({ length: 60 }, (_, index) => learningTypes.tradeLearningOutcomeSchema.parse({
    outcomeId: `${walletAddress}:${index}`,
    reconciliationVersion: 2,
    trainingEligible: true,
    walletAddress,
    executionId: `execution-${index}`,
    decisionId: `decision-${index}`,
    signalId: `signal-${index}`,
    asset: "SOL",
    side: index % 2 === 0 ? "long" : "short",
    openedAt: new Date(1_710_000_000_000 + index * 3_600_000).toISOString(),
    closedAt: new Date(1_710_000_900_000 + index * 3_600_000).toISOString(),
    positionPubkey: `position-${index}`,
    entryPrice: 100,
    exitPrice: 99,
    collateralUsd: 10,
    sizeUsd: 30,
    leverage: 3,
    takeProfitPrice: 102,
    stopLossPrice: 99.2,
    grossPnlUsd: -1,
    feesUsd: 0.15,
    netPnlUsd: -1.15,
    returnOnCollateralPercent: -11.5,
    durationMinutes: 15,
    exitReason: "stop-loss",
    signalConfidence: 0.8,
    signalType: "trend",
    trendWindow: 30,
    trendThreshold: 1.5,
    breakoutPercent: 1.2,
    cooldownSeconds: 600,
    trendStrengthPercent: 1.6,
    breakoutStrengthPercent: 1.25,
    volatilityPercent: 2,
    atrPercent: 0.4,
    trendBias: index % 2 === 0 ? "bullish" : "bearish",
    createdAt: new Date().toISOString(),
  }));
  await learningStore.saveTradeLearningOutcomes(outcomes);

  const candidate = await trainer.trainWalletDecisionProfile({
    walletAddress,
    config: null,
    source: "manual-training",
    force: true,
  });

  assert.equal(candidate.activated, false);
  assert.equal(candidate.profile.validation.passed, false);
  assert.equal((await learningStore.getActiveDecisionLearningProfile(walletAddress))?.profileId, baseline.profile.profileId);
  assert.equal((await learningStore.listDecisionLearningProfileHistory(walletAddress)).length, 2);
});

test("closed Jupiter trades reconcile into fee-aware training outcomes", async () => {
  const walletAddress = "learning-wallet-reconcile";
  const openedAt = new Date(1_720_000_000_000).toISOString();
  const execution: PerpsUserExecution = {
    executionId: "execution-reconcile",
    sessionId: "session-reconcile",
    walletAddress,
    signalId: "signal-reconcile",
    symbol: "BTC/USD",
    summary: "Confirmed BTC setup",
    side: "long",
    asset: "BTC",
    mode: "live",
    executionModel: "delegated-ready",
    status: "submitted",
    reasonCode: "APPROVED",
    reasonMessage: "Submitted",
    collateralUsd: 10,
    sizeUsd: 30,
    leverage: 3,
    takeProfitPrice: 102,
    stopLossPrice: 99.2,
    txid: "entry-tx",
    positionPubkey: "position-reconcile",
    decisionId: "decision-reconcile",
    createdAt: openedAt,
    updatedAt: openedAt,
  };
  const decision = {
    payload: {
      decisionId: "decision-reconcile",
      createdAt: openedAt,
      walletAddress,
      sessionId: "session-reconcile",
      sessionMode: "live",
      executionModel: "delegated-ready",
      signalId: "signal-reconcile",
      symbol: "BTC/USD",
      summary: "Confirmed BTC setup",
      direction: "bullish",
      signalConfidence: 0.78,
      asset: "BTC",
      requestedTrade: { collateralUsd: 10, leverage: 3, takeProfitPrice: 102, stopLossPrice: 99.2, maxSlippageBps: 100, executionStyle: "set-parameters", smartTradeProfile: "balanced" },
      marketContext: { spotPrice: 100, volatilityPercent: 2, trendBias: "bullish", availableUsdc: 100, hasOpenPosition: false, recentPriceChangePercent: 1.2 },
      strategyContext: { signalType: "trend", trendWindow: 30, trendThreshold: 1, breakoutPercent: 0.8, cooldownSeconds: 600, trendStrengthPercent: 1.2, breakoutStrengthPercent: 0.9, atrPercent: 0.35, learningProfileId: "profile-1" },
      historyContext: { recentExecutionCount: 0, approvalRequiredCount: 0, submittedCount: 0, confirmedCount: 0, paperExecutedCount: 0, blockedCount: 0, failedCount: 0, recentFailureRate: 0, recentBlockedRate: 0 },
      shadowMode: false,
    },
    recommendation: { shouldTrade: true, confidenceScore: 0.78, riskGrade: "low", sizeMultiplier: 1, leverageMultiplier: 1, recommendedCollateralUsd: 10, recommendedLeverage: 3, recommendedTakeProfitPrice: 102, recommendedStopLossPrice: 99.2, explanationTags: ["test"], explanationSummary: "Approved", shadowMode: false },
  } satisfies TradeDecisionRecord;
  const saved = await outcomeReconciler.reconcileTradeLearningOutcomes({
    walletAddress,
    executions: [execution],
    decisions: [decision],
    snapshot: {
      positions: [],
      pendingTriggers: [],
      recentTrades: [
        { id: "entry", source: "live-api", positionPubkey: "position-reconcile", marketSymbol: "BTC", marketName: "BTC", side: "long", action: "Increase", orderType: "Market", price: 100, sizeUsd: 30, collateralUsdDelta: 10, feeUsd: 0.1, pnl: null, pnlPercentage: null, txHash: "entry-tx", createdAt: 1_720_000_010_000, lastUpdated: 1_720_000_010_000 },
        { id: "exit", source: "live-api", positionPubkey: "position-reconcile", marketSymbol: "BTC", marketName: "BTC", side: "long", action: "Close", orderType: "TakeProfit", price: 102, sizeUsd: 30, collateralUsdDelta: -10, feeUsd: 0.1, pnl: 0.9, pnlPercentage: 9, txHash: "exit-tx", createdAt: 1_720_000_610_000, lastUpdated: 1_720_000_610_000 },
      ],
    },
  });

  assert.equal(saved.length, 1);
  assert.equal(saved[0]?.feesUsd, 0.2);
  assert.equal(saved[0]?.grossPnlUsd, 1);
  assert.equal(saved[0]?.netPnlUsd, 0.8);
  assert.equal(saved[0]?.exitReason, "take-profit");
  assert.equal(saved[0]?.trendWindow, 30);
});

test("reused Jupiter position accounts are reconciled as separate chronological episodes", async () => {
  const walletAddress = "learning-wallet-reused-position";
  const positionPubkey = "reused-position";
  const makeExecution = (index: number, openedAtMs: number, txid: string): PerpsUserExecution => ({
    executionId: `execution-episode-${index}`,
    sessionId: "session-episodes",
    walletAddress,
    signalId: `signal-episode-${index}`,
    symbol: "SOL/USD",
    summary: `Episode ${index}`,
    side: "long",
    asset: "SOL",
    mode: "live",
    executionModel: "delegated-ready",
    status: "submitted",
    reasonCode: "APPROVED",
    reasonMessage: "Submitted",
    collateralUsd: 10,
    sizeUsd: 50,
    leverage: 5,
    takeProfitPrice: 102,
    stopLossPrice: 98,
    txid,
    positionPubkey,
    decisionId: null,
    strategyClass: "scalp",
    createdAt: new Date(openedAtMs).toISOString(),
    updatedAt: new Date(openedAtMs).toISOString(),
  });
  const firstOpenedAt = 1_730_000_000_000;
  const secondOpenedAt = firstOpenedAt + 3_600_000;
  const trades = [
    { id: "exit-2", source: "live-api", positionPubkey, marketSymbol: "SOL", marketName: "SOL", side: "long", action: "Close", orderType: "StopLoss", price: 99, sizeUsd: 50, collateralUsdDelta: -10, feeUsd: 0.1, pnl: -0.6, pnlPercentage: -7, txHash: "exit-tx-2", createdAt: secondOpenedAt + 600_000, lastUpdated: secondOpenedAt + 600_000 },
    { id: "entry-1", source: "live-api", positionPubkey, marketSymbol: "SOL", marketName: "SOL", side: "long", action: "Increase", orderType: "Market", price: 100, sizeUsd: 50, collateralUsdDelta: 10, feeUsd: 0.1, pnl: null, pnlPercentage: null, txHash: "entry-tx-1", createdAt: firstOpenedAt + 1_000, lastUpdated: firstOpenedAt + 1_000 },
    { id: "entry-2", source: "live-api", positionPubkey, marketSymbol: "SOL", marketName: "SOL", side: "long", action: "Increase", orderType: "Market", price: 101, sizeUsd: 50, collateralUsdDelta: 10, feeUsd: 0.1, pnl: null, pnlPercentage: null, txHash: "entry-tx-2", createdAt: secondOpenedAt + 1_000, lastUpdated: secondOpenedAt + 1_000 },
    { id: "exit-1", source: "live-api", positionPubkey, marketSymbol: "SOL", marketName: "SOL", side: "long", action: "Close", orderType: "TakeProfit", price: 102, sizeUsd: 50, collateralUsdDelta: -10, feeUsd: 0.1, pnl: 0.9, pnlPercentage: 8, txHash: "exit-tx-1", createdAt: firstOpenedAt + 600_000, lastUpdated: firstOpenedAt + 600_000 },
  ] as const;

  await learningStore.saveTradeLearningOutcomes([learningTypes.tradeLearningOutcomeSchema.parse({
    outcomeId: `${walletAddress}:corrupt`,
    walletAddress,
    executionId: "corrupt",
    decisionId: null,
    signalId: "corrupt",
    asset: "SOL",
    side: "long",
    openedAt: new Date(firstOpenedAt).toISOString(),
    closedAt: new Date(secondOpenedAt + 600_000).toISOString(),
    positionPubkey,
    entryPrice: 100,
    exitPrice: 99,
    collateralUsd: 10,
    sizeUsd: 50,
    leverage: 5,
    takeProfitPrice: 102,
    stopLossPrice: 98,
    grossPnlUsd: -10,
    feesUsd: 3,
    netPnlUsd: -13,
    returnOnCollateralPercent: -130,
    durationMinutes: 70,
    exitReason: "stop-loss",
    signalConfidence: null,
    signalType: "scalp",
    trendWindow: null,
    trendThreshold: null,
    breakoutPercent: null,
    cooldownSeconds: null,
    trendStrengthPercent: null,
    breakoutStrengthPercent: null,
    volatilityPercent: null,
    atrPercent: null,
    trendBias: null,
    createdAt: new Date().toISOString(),
  })]);

  const saved = await outcomeReconciler.reconcileTradeLearningOutcomes({
    walletAddress,
    executions: [
      makeExecution(1, firstOpenedAt, "entry-tx-1"),
      makeExecution(2, secondOpenedAt, "entry-tx-2"),
    ],
    decisions: [],
    snapshot: { positions: [], pendingTriggers: [], recentTrades: [...trades] },
    replaceWalletHistory: true,
  });

  assert.equal(saved.length, 2);
  assert.equal(saved[0]?.netPnlUsd, 0.8);
  assert.equal(saved[1]?.netPnlUsd, -0.7);
  assert.equal(saved[0]?.feesUsd, 0.2);
  assert.equal(saved[1]?.feesUsd, 0.2);
  assert.equal(saved[0]?.durationMinutes, 10);
  assert.equal(saved[1]?.durationMinutes, 10);
  assert.notEqual(saved[0]?.episodeId, saved[1]?.episodeId);
  assert.ok(saved.every((outcome) => outcome.reconciliationVersion === 2));
  assert.equal((await learningStore.listTradeLearningOutcomes(walletAddress)).length, 2);
});

test("the known legacy loss stays in audit history but is excluded from profile training", async () => {
  const walletAddress = "learning-wallet-legacy-outlier";
  const openedAtMs = Date.parse("2026-07-20T23:04:22.891Z");
  const execution: PerpsUserExecution = {
    executionId: "execution-legacy-outlier",
    sessionId: "session-legacy-outlier",
    walletAddress,
    signalId: "signal-legacy-outlier",
    symbol: "SOL/USD",
    summary: "Legacy scalp",
    side: "long",
    asset: "SOL",
    mode: "live",
    executionModel: "delegated-ready",
    status: "submitted",
    reasonCode: "APPROVED",
    reasonMessage: "Submitted",
    collateralUsd: 100,
    sizeUsd: 500,
    leverage: 5,
    takeProfitPrice: 105,
    stopLossPrice: 95,
    txid: "legacy-entry-tx",
    positionPubkey: "legacy-outlier-position",
    decisionId: null,
    strategyClass: "scalp",
    createdAt: new Date(openedAtMs).toISOString(),
    updatedAt: new Date(openedAtMs).toISOString(),
  };
  const saved = await outcomeReconciler.reconcileTradeLearningOutcomes({
    walletAddress,
    executions: [execution],
    decisions: [],
    snapshot: {
      positions: [],
      pendingTriggers: [],
      recentTrades: [
        { id: "legacy-entry", source: "live-api", positionPubkey: execution.positionPubkey, marketSymbol: "SOL", marketName: "SOL", side: "long", action: "Increase", orderType: "Market", price: 100, sizeUsd: 500, collateralUsdDelta: 100, feeUsd: 0.5, pnl: null, pnlPercentage: null, txHash: execution.txid, createdAt: openedAtMs + 1_000, lastUpdated: openedAtMs + 1_000 },
        { id: "legacy-exit", source: "live-api", positionPubkey: execution.positionPubkey, marketSymbol: "SOL", marketName: "SOL", side: "long", action: "Close", orderType: "Market", price: 82, sizeUsd: 500, collateralUsdDelta: -100, feeUsd: 0.5, pnl: -90.75, pnlPercentage: -91.25, txHash: "legacy-exit-tx", createdAt: openedAtMs + 600_000, lastUpdated: openedAtMs + 600_000 },
      ],
    },
    replaceWalletHistory: true,
  });

  assert.equal(saved[0]?.netPnlUsd, -91.25);
  assert.equal(saved[0]?.trainingEligible, false);
  assert.match(saved[0]?.trainingExclusionReason ?? "", /retained for PnL, audit, and tail-risk/i);

  const trained = await trainer.trainWalletDecisionProfile({
    walletAddress,
    config: null,
    source: "manual-training",
    force: true,
  });
  assert.equal(trained.outcomeCount, 0);
  assert.equal(trained.excludedOutcomeCount, 1);
  assert.equal(trained.profile.learnedFromClosedTrades, 0);
  assert.equal((await learningStore.listTradeLearningOutcomes(walletAddress)).length, 1);
});
