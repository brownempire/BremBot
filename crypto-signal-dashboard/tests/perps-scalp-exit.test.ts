import assert from "node:assert/strict";
import test from "node:test";

import {
  computeFeeAwareScalpExitPlan,
  ESTIMATED_PERPS_ROUND_TRIP_FEE_RATE,
  SCALP_ATR_PROFIT_TARGET_MULTIPLIER,
  SCALP_MINIMUM_NET_PROFIT_USD,
} from "../lib/perps/scalpExit";

test("scalp profit target is capped at two ATR while remaining above fees", () => {
  const plan = computeFeeAwareScalpExitPlan({
    positionSizeUsd: 390,
    atrPercent: 0.1597,
    configuredNetProfitUsd: 3.5,
  });

  assert.equal(ESTIMATED_PERPS_ROUND_TRIP_FEE_RATE, 0.0012);
  assert.equal(SCALP_ATR_PROFIT_TARGET_MULTIPLIER, 2);
  assert.equal(plan.estimatedFeesUsd, 0.468);
  assert.equal(plan.volatilityGrossProfitUsd, 1.24566);
  assert.equal(plan.grossProfitTargetUsd, 1.24566);
  assert.equal(plan.netProfitTargetUsd, 0.77766);
});

test("quiet markets retain the Jupiter minimum without targeting a loss after fees", () => {
  const plan = computeFeeAwareScalpExitPlan({
    positionSizeUsd: 390,
    atrPercent: 0.01,
    configuredNetProfitUsd: 3.5,
  });

  assert.equal(plan.grossProfitTargetUsd, 1);
  assert.equal(plan.netProfitTargetUsd, 0.532);
  assert.ok(plan.netProfitTargetUsd >= SCALP_MINIMUM_NET_PROFIT_USD);
});

test("fee floor scales with position size when fees exceed the Jupiter minimum", () => {
  const plan = computeFeeAwareScalpExitPlan({
    positionSizeUsd: 2_000,
    atrPercent: 0.01,
    configuredNetProfitUsd: 3.5,
  });

  assert.equal(plan.estimatedFeesUsd, 2.4);
  assert.equal(plan.grossProfitTargetUsd, 2.65);
  assert.equal(plan.netProfitTargetUsd, SCALP_MINIMUM_NET_PROFIT_USD);
});

test("missing ATR falls back to the configured net profit target plus fees", () => {
  const plan = computeFeeAwareScalpExitPlan({
    positionSizeUsd: 390,
    atrPercent: null,
    configuredNetProfitUsd: 3.5,
  });

  assert.equal(plan.volatilityGrossProfitUsd, null);
  assert.equal(plan.grossProfitTargetUsd, 3.968);
  assert.equal(plan.netProfitTargetUsd, 3.5);
});
