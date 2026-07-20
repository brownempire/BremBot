import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { decisionLearningProfileSchema } from "../lib/decision/learningTypes";
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
  assert.equal(profile.takeProfitRoePercent, 0);
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
