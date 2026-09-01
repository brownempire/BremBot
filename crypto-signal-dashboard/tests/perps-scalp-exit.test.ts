import assert from "node:assert/strict";
import test from "node:test";

import {
  computePercentageScalpExitPlan,
  DEFAULT_CONSERVATIVE_PERPS_ROUND_TRIP_FEE_RATE,
  DEFAULT_SCALP_TAKE_PROFIT_ROE_PERCENT,
  ESTIMATED_PERPS_ROUND_TRIP_FEE_RATE,
  SCALP_ATR_PROFIT_TARGET_MULTIPLIER,
  SCALP_MAXIMUM_PRICE_TARGET_PERCENT,
  SCALP_MINIMUM_PRICE_TARGET_PERCENT,
  SCALP_MINIMUM_NET_PROFIT_USD,
  SCALP_MINIMUM_NET_REWARD_RISK_RATIO,
  SCALP_MINIMUM_TAKE_PROFIT_ROE_PERCENT,
  SCALP_STOP_LOSS_ROE_PERCENT,
  resolveConservativeScalpFeeRate,
} from "../lib/perps/scalpExit";
import {
  SCALP_PROFIT_LOCK_RESCUE_ARM_ROE_PERCENT,
  SCALP_PROFIT_LOCK_RESCUE_EXIT_ROE_PERCENT,
  SCALP_PROFIT_LOCK_INITIAL_ARM_ROE_PERCENT,
  SCALP_PROFIT_LOCK_INITIAL_EXIT_ROE_PERCENT,
  SCALP_PROFIT_LOCK_FINAL_ARM_ROE_PERCENT,
  SCALP_PROFIT_LOCK_FINAL_EXIT_ROE_PERCENT,
  SCALP_PROFIT_LOCK_RUNNER_ARM_ROE_PERCENT,
  SCALP_PROFIT_LOCK_RUNNER_EXIT_ROE_PERCENT,
} from "../lib/perps/profitLock";

test("scalp protection uses the 15% hard SL and retains the profit staircase", () => {
  assert.equal(SCALP_STOP_LOSS_ROE_PERCENT, 15);
  assert.equal(SCALP_PROFIT_LOCK_RESCUE_ARM_ROE_PERCENT, 4);
  assert.equal(SCALP_PROFIT_LOCK_RESCUE_EXIT_ROE_PERCENT, 2);
  assert.equal(SCALP_PROFIT_LOCK_INITIAL_ARM_ROE_PERCENT, 10);
  assert.equal(SCALP_PROFIT_LOCK_INITIAL_EXIT_ROE_PERCENT, 7);
  assert.equal(SCALP_PROFIT_LOCK_RUNNER_ARM_ROE_PERCENT, 30);
  assert.equal(SCALP_PROFIT_LOCK_RUNNER_EXIT_ROE_PERCENT, 23);
  assert.equal(SCALP_PROFIT_LOCK_FINAL_ARM_ROE_PERCENT, 40);
  assert.equal(SCALP_PROFIT_LOCK_FINAL_EXIT_ROE_PERCENT, 32);
});

test("scalp hard TP uses a bounded market move while clearing fees and stop risk", () => {
  const plan = computePercentageScalpExitPlan({
    positionSizeUsd: 390,
    leverage: 50,
    atrPercent: 0.1597,
    configuredTakeProfitRoePercent: DEFAULT_SCALP_TAKE_PROFIT_ROE_PERCENT,
  });

  assert.equal(ESTIMATED_PERPS_ROUND_TRIP_FEE_RATE, 0.00205);
  assert.equal(SCALP_ATR_PROFIT_TARGET_MULTIPLIER, 2);
  assert.equal(SCALP_MINIMUM_PRICE_TARGET_PERCENT, 0.5);
  assert.equal(SCALP_MAXIMUM_PRICE_TARGET_PERCENT, 1);
  assert.equal(SCALP_MINIMUM_NET_REWARD_RISK_RATIO, 1);
  assert.equal(plan.estimatedFeesUsd, 0.7995);
  assert.equal(plan.estimatedStopLossNetUsd, 1.9695);
  assert.equal(plan.minimumRewardRiskNetProfitUsd, 1.9695);
  assert.equal(plan.volatilityTargetRoePercent, 25);
  assert.equal(plan.targetPriceMovePercent, 0.71);
  assert.equal(plan.targetRoePercent, 35.5);
  assert.equal(plan.grossProfitTargetUsd, 2.769);
  assert.equal(plan.netProfitTargetUsd, 1.9695);
});

test("quiet markets keep a one-to-one post-fee target instead of stretching the hold", () => {
  const plan = computePercentageScalpExitPlan({
    positionSizeUsd: 390,
    leverage: 50,
    atrPercent: 0.01,
    configuredTakeProfitRoePercent: DEFAULT_SCALP_TAKE_PROFIT_ROE_PERCENT,
  });

  assert.ok(plan.targetRoePercent > SCALP_MINIMUM_TAKE_PROFIT_ROE_PERCENT);
  assert.equal(plan.targetPriceMovePercent, 0.71);
  assert.equal(plan.targetRoePercent, 35.5);
  assert.equal(plan.grossProfitTargetUsd, 2.769);
  assert.equal(plan.netProfitTargetUsd, 1.9695);
  assert.equal(Number((plan.netProfitTargetUsd / plan.estimatedStopLossNetUsd).toFixed(6)), 1);
  assert.ok(plan.netProfitTargetUsd >= SCALP_MINIMUM_NET_PROFIT_USD);
});

test("percentage targets scale up with position collateral instead of stopping at a flat dollar cap", () => {
  const plan = computePercentageScalpExitPlan({
    positionSizeUsd: 2_000,
    leverage: 50,
    atrPercent: 0.01,
    configuredTakeProfitRoePercent: DEFAULT_SCALP_TAKE_PROFIT_ROE_PERCENT,
  });

  assert.equal(plan.estimatedFeesUsd, 4.1);
  assert.equal(plan.targetPriceMovePercent, 0.71);
  assert.equal(plan.targetRoePercent, 35.5);
  assert.equal(plan.grossProfitTargetUsd, 14.2);
  assert.equal(plan.netProfitTargetUsd, 10.1);
});

test("missing ATR falls back to the configured percentage target", () => {
  const plan = computePercentageScalpExitPlan({
    positionSizeUsd: 390,
    leverage: 50,
    atrPercent: null,
    configuredTakeProfitRoePercent: DEFAULT_SCALP_TAKE_PROFIT_ROE_PERCENT,
  });

  assert.equal(plan.volatilityTargetRoePercent, null);
  assert.equal(plan.targetPriceMovePercent, 0.71);
  assert.equal(plan.targetRoePercent, 35.5);
  assert.equal(plan.grossProfitTargetUsd, 2.769);
  assert.equal(plan.netProfitTargetUsd, 1.9695);
});

test("the pictured small scalp targets its full fee-adjusted SL risk without an extended hold", () => {
  const plan = computePercentageScalpExitPlan({
    positionSizeUsd: 578.91,
    leverage: 49.9,
    atrPercent: null,
    configuredTakeProfitRoePercent: DEFAULT_SCALP_TAKE_PROFIT_ROE_PERCENT,
  });

  assert.equal(plan.netProfitTargetUsd, plan.estimatedStopLossNetUsd);
  assert.equal(Number((plan.netProfitTargetUsd / plan.estimatedStopLossNetUsd).toFixed(2)), 1);
  assert.ok(plan.targetPriceMovePercent >= 0.5 && plan.targetPriceMovePercent <= 1);
});

test("large scalp positions are no longer capped at $3.50", () => {
  const plan = computePercentageScalpExitPlan({
    positionSizeUsd: 10_000,
    leverage: 50,
    atrPercent: 1,
    configuredTakeProfitRoePercent: DEFAULT_SCALP_TAKE_PROFIT_ROE_PERCENT,
  });

  assert.equal(plan.targetPriceMovePercent, 1);
  assert.equal(plan.targetRoePercent, 50);
  assert.equal(plan.grossProfitTargetUsd, 100);
  assert.equal(plan.netProfitTargetUsd, 79.5);
  assert.ok(plan.netProfitTargetUsd > 3.5);
});

test("the low-balance leverage band targets roughly 0.7-1.0% after fees and stop risk", () => {
  const plans = [25, 40, 50].map((leverage) => computePercentageScalpExitPlan({
    positionSizeUsd: 12 * leverage,
    leverage,
    atrPercent: 0.15,
    configuredTakeProfitRoePercent: DEFAULT_SCALP_TAKE_PROFIT_ROE_PERCENT,
  }));

  assert.deepEqual(plans.map((plan) => plan.targetPriceMovePercent), [1.01, 0.785, 0.71]);
  assert.ok(plans.every((plan) => plan.netProfitTargetUsd >= SCALP_MINIMUM_NET_PROFIT_USD));
});

test("range and reversal setups use a shorter ATR target than continuation setups", () => {
  const continuation = computePercentageScalpExitPlan({
    positionSizeUsd: 10_000,
    leverage: 50,
    atrPercent: 0.4,
    configuredTakeProfitRoePercent: DEFAULT_SCALP_TAKE_PROFIT_ROE_PERCENT,
    entryPath: "continuation",
  });
  const reversal = computePercentageScalpExitPlan({
    positionSizeUsd: 10_000,
    leverage: 50,
    atrPercent: 0.4,
    configuredTakeProfitRoePercent: DEFAULT_SCALP_TAKE_PROFIT_ROE_PERCENT,
    entryPath: "reversal",
  });

  assert.equal(continuation.volatilityTargetRoePercent, 40);
  assert.equal(reversal.volatilityTargetRoePercent, 30);
  assert.ok(reversal.targetPriceMovePercent < continuation.targetPriceMovePercent);
});

test("rolling scalp fees use the recent eligible upper quartile with a conservative floor", () => {
  const outcomes = [0.00135, 0.0018, 0.00205, 0.0024].map((rate, index) => ({
    feesUsd: rate * 1_000,
    sizeUsd: 1_000,
    signalType: "scalp",
    scalpSetupType: index % 2 ? "liquidity-sweep" : null,
    trainingEligible: true,
  }));
  outcomes.push({
    feesUsd: 9,
    sizeUsd: 1_000,
    signalType: "scalp",
    scalpSetupType: null,
    trainingEligible: false,
  });

  assert.equal(DEFAULT_CONSERVATIVE_PERPS_ROUND_TRIP_FEE_RATE, 0.00205);
  assert.equal(resolveConservativeScalpFeeRate(outcomes), 0.0024);
  assert.equal(resolveConservativeScalpFeeRate([]), 0.00205);
});
