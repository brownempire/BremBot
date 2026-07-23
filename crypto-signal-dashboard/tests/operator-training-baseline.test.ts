import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { decisionLearningProfileSchema } from "../lib/decision/learningTypes";
import { applyLearnedTradePlan } from "../lib/decision/learningRuntime";
import {
  makeOperatorTrainingBaselineProfile,
} from "../lib/decision/operatorTrainingBaseline";
import { OPERATOR_TRAINING_BASELINE } from "../lib/decision/operatorTrainingBaselineConstants";
import { DEFAULT_SERVER_SIGNAL_PARAMS } from "../lib/perps/automationConfig";

test("operator training baseline matches the requested starting parameters", () => {
  const profile = decisionLearningProfileSchema.parse(
    makeOperatorTrainingBaselineProfile("baseline-contract-wallet", 1)
  );

  assert.deepEqual(OPERATOR_TRAINING_BASELINE.signalParams, {
    trendWindow: 145,
    trendThreshold: 1.65,
    breakoutPercent: 0.35,
    cooldownSeconds: 27_000,
  });
  assert.deepEqual(DEFAULT_SERVER_SIGNAL_PARAMS, OPERATOR_TRAINING_BASELINE.signalParams);
  assert.equal(profile.maximumAllocationPercent, 50);
  assert.equal(profile.targetWalletRiskPercent, 3);
  assert.equal(profile.takeProfitRoePercent, 25);
  assert.equal(profile.stopLossRoePercent, 25);
  assert.equal(profile.leverageFloor, 2);
  assert.equal(profile.leverageCap, 10);
  for (const asset of ["SOL", "ETH", "BTC"] as const) {
    assert.equal(profile.assetAdjustments[asset].trendThreshold, 1.65);
    assert.equal(profile.assetAdjustments[asset].breakoutPercent, 0.35);
  }
});

test("client baseline constants do not import server-only runtime modules", () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), "lib/decision/operatorTrainingBaselineConstants.ts"),
    "utf8"
  );

  assert.doesNotMatch(source, /node:/);
  assert.doesNotMatch(source, /^import (?!type\b)/m);
});

test("a zero-history baseline enforces risk-sized 25% TP, 25% SL, and adaptive 2-10x leverage", () => {
  const profile = decisionLearningProfileSchema.parse(
    makeOperatorTrainingBaselineProfile("adaptive-exit-wallet", 1)
  );
  const points = Array.from({ length: 16 }, (_, index) => ({
    t: index * 60_000,
    v: 100 + index * 0.1,
  }));
  const plan = applyLearnedTradePlan({
    basePlan: {
      collateralPercent: 80,
      leverage: 10,
      stopLossPercent: 0,
      takeProfitPercent: 0,
      volatilityPercent: 2,
    },
    asset: "SOL",
    points,
    profile,
    signalConfidence: 1,
    indicatorScore: 6,
    adx: 40,
    volumeRatio: 1.5,
  });

  assert.equal(profile.takeProfitRoePercent, 25);
  assert.equal(profile.stopLossRoePercent, 25);
  assert.equal(plan.takeProfitPercent, 25);
  assert.equal(plan.stopLossPercent, 25);
  assert.equal(plan.leverage, 10);
  assert.equal(plan.collateralPercent, 12);
});

test("weak or volatile setups stay at the researched 2x leverage floor", () => {
  const profile = decisionLearningProfileSchema.parse(
    makeOperatorTrainingBaselineProfile("adaptive-floor-wallet", 1)
  );
  const plan = applyLearnedTradePlan({
    basePlan: {
      collateralPercent: 80,
      leverage: 10,
      stopLossPercent: 10,
      takeProfitPercent: 10,
      volatilityPercent: 5,
    },
    asset: "SOL",
    points: Array.from({ length: 16 }, (_, index) => ({
      t: index * 60_000,
      v: index % 2 === 0 ? 95 : 105,
      o: 100,
      h: 106,
      l: 94,
    })),
    profile,
    signalConfidence: 0.55,
    indicatorScore: 3,
    adx: 20,
    volumeRatio: 1,
  });

  assert.equal(plan.leverage, 2);
  assert.equal(plan.stopLossPercent, 25);
  assert.equal(plan.takeProfitPercent, 25);
});

test("an existing learned profile cannot suppress the fixed agent SL", () => {
  const profile = decisionLearningProfileSchema.parse({
    ...makeOperatorTrainingBaselineProfile("existing-zero-exit-wallet", 2),
    source: "manual-training",
    learnedFromClosedTrades: 5,
    takeProfitRoePercent: 0,
    stopLossRoePercent: 0,
  });
  const plan = applyLearnedTradePlan({
    basePlan: {
      collateralPercent: 80,
      leverage: 50,
      stopLossPercent: 0,
      takeProfitPercent: 0,
      volatilityPercent: 2,
    },
    asset: "SOL",
    points: Array.from({ length: 16 }, (_, index) => ({
      t: index * 60_000,
      v: 100 + index * 0.1,
    })),
    profile,
  });

  assert.equal(plan.takeProfitPercent, 1);
  assert.equal(plan.stopLossPercent, 25);
});

test("agent runtime enforces the fixed SL before a learning profile exists", () => {
  const plan = applyLearnedTradePlan({
    basePlan: {
      collateralPercent: 25,
      leverage: 10,
      stopLossPercent: 4,
      takeProfitPercent: 25,
      volatilityPercent: 2,
    },
    asset: "SOL",
    points: [],
    profile: null,
  });

  assert.equal(plan.takeProfitPercent, 25);
  assert.equal(plan.stopLossPercent, 25);
});
