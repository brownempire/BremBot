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
  assert.equal(result.profile.trendWindow, 15);
  for (const asset of ["SOL", "ETH", "BTC"] as const) {
    assert.equal(result.profile.assetAdjustments[asset].trendThreshold, 0.14);
    assert.equal(result.profile.assetAdjustments[asset].breakoutPercent, 0.19);
  }
  assert.equal(result.profile.cooldownSeconds, 180);
  assert.equal(result.profile.leverageCap, 50);
  assert.equal(result.profile.maximumAllocationPercent, 80);
  assert.equal(result.profile.takeProfitRoePercent, 25);
  assert.equal(result.profile.stopLossRoePercent, 0);
  const plan = runtime.applyLearnedTradePlan({
    basePlan: { collateralPercent: 80, leverage: 50, stopLossPercent: 0, takeProfitPercent: 0, volatilityPercent: 2 },
    asset: "SOL",
    points: Array.from({ length: 16 }, (_, index) => ({ t: index * 60_000, v: 100 + index * 0.1 })),
    profile: result.profile,
  });
  assert.equal(plan.collateralPercent, 80);
  assert.equal(plan.leverage, 50);
  assert.ok(plan.takeProfitPercent >= 25 && plan.takeProfitPercent <= 50);
  assert.ok(plan.stopLossPercent >= 0.5 && plan.stopLossPercent <= 5.5);
  assert.ok(plan.takeProfitPercent > plan.stopLossPercent);
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
  assert.equal(reset.profile.assetAdjustments.SOL.trendThreshold, 0.14);
  assert.equal((await learningStore.getActiveDecisionLearningProfile(walletAddress))?.profileId, reset.profile.profileId);
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

test("trained runtime enforces ATR risk sizing, leverage cap, and fee-adjusted reward risk", () => {
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
    leverageCap: 3,
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

  assert.equal(plan.leverage, 3);
  assert.ok(plan.collateralPercent <= 10);
  assert.ok(plan.stopLossPercent >= 2.5);
  assert.ok(plan.takeProfitPercent > plan.stopLossPercent * 2);
});

test("profitable chronological holdout history promotes a versioned learned profile", async () => {
  const walletAddress = "learning-wallet-history";
  const outcomes = Array.from({ length: 60 }, (_, index) => learningTypes.tradeLearningOutcomeSchema.parse({
    outcomeId: `${walletAddress}:${index}`,
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
