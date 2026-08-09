import assert from "node:assert/strict";
import test from "node:test";

import {
  computePercentageScalpExitPlan,
  DEFAULT_SCALP_TAKE_PROFIT_ROE_PERCENT,
  ESTIMATED_PERPS_ROUND_TRIP_FEE_RATE,
  SCALP_ATR_PROFIT_TARGET_MULTIPLIER,
  SCALP_MINIMUM_NET_PROFIT_USD,
  SCALP_MINIMUM_TAKE_PROFIT_ROE_PERCENT,
  SCALP_STOP_LOSS_ROE_PERCENT,
} from "../lib/perps/scalpExit";
import {
  SCALP_PROFIT_LOCK_INITIAL_ARM_ROE_PERCENT,
  SCALP_PROFIT_LOCK_INITIAL_EXIT_ROE_PERCENT,
} from "../lib/perps/profitLock";

test("scalp protection uses a 23% hard SL without changing the staircase", () => {
  assert.equal(SCALP_STOP_LOSS_ROE_PERCENT, 23);
  assert.equal(SCALP_PROFIT_LOCK_INITIAL_ARM_ROE_PERCENT, 10);
  assert.equal(SCALP_PROFIT_LOCK_INITIAL_EXIT_ROE_PERCENT, 7);
});

test("scalp hard TP stays above the full ladder while clearing fees by $1", () => {
  const plan = computePercentageScalpExitPlan({
    positionSizeUsd: 390,
    leverage: 50,
    atrPercent: 0.1597,
    configuredTakeProfitRoePercent: DEFAULT_SCALP_TAKE_PROFIT_ROE_PERCENT,
  });

  assert.equal(ESTIMATED_PERPS_ROUND_TRIP_FEE_RATE, 0.0012);
  assert.equal(SCALP_ATR_PROFIT_TARGET_MULTIPLIER, 2);
  assert.equal(plan.estimatedFeesUsd, 0.468);
  assert.equal(plan.volatilityTargetRoePercent, 15.97);
  assert.equal(plan.targetRoePercent, 25);
  assert.equal(plan.grossProfitTargetUsd, 1.95);
  assert.equal(plan.netProfitTargetUsd, 1.482);
});

test("quiet markets retain the 25% target above every ladder checkpoint", () => {
  const plan = computePercentageScalpExitPlan({
    positionSizeUsd: 390,
    leverage: 50,
    atrPercent: 0.01,
    configuredTakeProfitRoePercent: DEFAULT_SCALP_TAKE_PROFIT_ROE_PERCENT,
  });

  assert.equal(plan.targetRoePercent, SCALP_MINIMUM_TAKE_PROFIT_ROE_PERCENT);
  assert.equal(plan.grossProfitTargetUsd, 1.95);
  assert.equal(plan.netProfitTargetUsd, 1.482);
  assert.ok(plan.netProfitTargetUsd >= SCALP_MINIMUM_NET_PROFIT_USD);
});

test("percentage targets scale up with position collateral instead of stopping at a flat dollar cap", () => {
  const plan = computePercentageScalpExitPlan({
    positionSizeUsd: 2_000,
    leverage: 50,
    atrPercent: 0.01,
    configuredTakeProfitRoePercent: DEFAULT_SCALP_TAKE_PROFIT_ROE_PERCENT,
  });

  assert.equal(plan.estimatedFeesUsd, 2.4);
  assert.equal(plan.targetRoePercent, 25);
  assert.equal(plan.grossProfitTargetUsd, 10);
  assert.equal(plan.netProfitTargetUsd, 7.6);
});

test("missing ATR falls back to the configured percentage target", () => {
  const plan = computePercentageScalpExitPlan({
    positionSizeUsd: 390,
    leverage: 50,
    atrPercent: null,
    configuredTakeProfitRoePercent: DEFAULT_SCALP_TAKE_PROFIT_ROE_PERCENT,
  });

  assert.equal(plan.volatilityTargetRoePercent, null);
  assert.equal(plan.targetRoePercent, 25);
  assert.equal(plan.grossProfitTargetUsd, 1.95);
  assert.equal(plan.netProfitTargetUsd, 1.482);
});

test("large scalp positions are no longer capped at $3.50", () => {
  const plan = computePercentageScalpExitPlan({
    positionSizeUsd: 10_000,
    leverage: 50,
    atrPercent: 1,
    configuredTakeProfitRoePercent: DEFAULT_SCALP_TAKE_PROFIT_ROE_PERCENT,
  });

  assert.equal(plan.targetRoePercent, 100);
  assert.equal(plan.grossProfitTargetUsd, 200);
  assert.equal(plan.netProfitTargetUsd, 188);
  assert.ok(plan.netProfitTargetUsd > 3.5);
});
