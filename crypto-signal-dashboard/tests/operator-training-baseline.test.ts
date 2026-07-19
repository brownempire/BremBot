import assert from "node:assert/strict";
import test from "node:test";

import { decisionLearningProfileSchema } from "../lib/decision/learningTypes";
import {
  makeOperatorTrainingBaselineProfile,
  OPERATOR_TRAINING_BASELINE,
} from "../lib/decision/operatorTrainingBaseline";
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
  assert.equal(profile.takeProfitRoePercent, 0);
  assert.equal(profile.stopLossRoePercent, 0);
  assert.equal(profile.leverageCap, 50);
  for (const asset of ["SOL", "ETH", "BTC"] as const) {
    assert.equal(profile.assetAdjustments[asset].trendThreshold, 0.14);
    assert.equal(profile.assetAdjustments[asset].breakoutPercent, 0.19);
  }
});
