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
    trendWindow: 15,
    trendThreshold: 0.14,
    breakoutPercent: 0.19,
    cooldownSeconds: 180,
  });
  assert.deepEqual(DEFAULT_SERVER_SIGNAL_PARAMS, OPERATOR_TRAINING_BASELINE.signalParams);
  assert.equal(profile.maximumAllocationPercent, 80);
  assert.equal(profile.takeProfitRoePercent, 25);
  assert.equal(profile.stopLossRoePercent, 0);
  assert.equal(profile.leverageCap, 50);
  for (const asset of ["SOL", "ETH", "BTC"] as const) {
    assert.equal(profile.assetAdjustments[asset].trendThreshold, 0.14);
    assert.equal(profile.assetAdjustments[asset].breakoutPercent, 0.19);
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

test("a zero-history baseline adapts its 25% TP and calculates an ATR-based SL", () => {
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
      leverage: 50,
      stopLossPercent: 0,
      takeProfitPercent: 0,
      volatilityPercent: 2,
    },
    asset: "SOL",
    points,
    profile,
  });

  assert.equal(profile.takeProfitRoePercent, 25);
  assert.equal(profile.stopLossRoePercent, 0);
  assert.ok(plan.takeProfitPercent >= 25 && plan.takeProfitPercent <= 50);
  assert.ok(plan.takeProfitPercent > profile.takeProfitRoePercent);
  assert.ok(plan.stopLossPercent >= 0.5 && plan.stopLossPercent <= 5.5);
  assert.ok(plan.takeProfitPercent > plan.stopLossPercent);
});

test("an existing learned profile with zero stored exits still receives adaptive protection", () => {
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

  assert.ok(plan.takeProfitPercent > 0);
  assert.ok(plan.stopLossPercent > 0);
});
