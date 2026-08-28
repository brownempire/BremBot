import assert from "node:assert/strict";
import test from "node:test";

import { classifyScalpCandidateFirstTouch } from "../lib/decision/scalpCandidateStore";
import {
  SCALP_OUTCOME_MINIMUM_CLASS_SAMPLES,
  SCALP_OUTCOME_RETRAIN_BATCH_SIZE,
  SCALP_OUTCOME_STRONG_CLASS_SAMPLES,
  evaluateValidatedScalpOutcomePrediction,
  predictScalpCandidateOutcome,
  trainScalpOutcomeModel,
} from "../lib/decision/scalpOutcomeModel";
import { scalpCandidateSchema, type ScalpOutcomeClass } from "../lib/decision/learningTypes";
import { inferScalpExitProvenance } from "../lib/decision/outcomeReconciler";

function candidate(index: number, outcomeClass: ScalpOutcomeClass) {
  const score = outcomeClass === "full-tp"
    ? 0.92
    : outcomeClass === "profitable-staircase"
      ? 0.72
      : outcomeClass === "full-sl"
        ? 0.2
        : 0.46;
  const observedAt = new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString();
  return scalpCandidateSchema.parse({
    candidateId: `candidate-${index}`,
    walletAddress: "model-wallet",
    policyVersion: 8,
    asset: "SOL",
    side: index % 2 ? "short" : "long",
    entryPath: "continuation",
    setupType: "v-reversal",
    observedAt,
    referencePrice: 100,
    disposition: index % 3 ? "rejected" : "accepted",
    rejectionReasons: [],
    metrics: {
      score,
      atrPercent: 0.1 + score * 0.1,
      volatilityPercent: 0.5 + score,
      netMove5mPercent: (index % 2 ? -1 : 1) * score,
      netMove15mPercent: (index % 2 ? -1 : 1) * score * 1.2,
      netMove60mPercent: (index % 2 ? -1 : 1) * score * 1.5,
      emaSpreadPercent: (index % 2 ? -1 : 1) * score,
      emaSlopePercent: (index % 2 ? -1 : 1) * score,
      macdHistogram: (index % 2 ? -1 : 1) * score,
      macdHistogramChange: (index % 2 ? -1 : 1) * score,
      plusDi: index % 2 ? 10 : 10 + score * 20,
      minusDi: index % 2 ? 10 + score * 20 : 10,
      bollingerPosition: index % 2 ? 0.5 - score / 2 : 0.5 + score / 2,
      adx: 10 + score * 20,
      volumeRatio: 0.5 + score,
      regimeTrending: score > 0.5 ? 1 : 0,
      regimeExhausted: outcomeClass === "full-sl" ? 1 : 0,
    },
    outcomeClass,
    outcomeSource: "shadow-first-touch",
    tags: [],
    labels: {},
    createdAt: observedAt,
    updatedAt: observedAt,
  });
}

test("shadow first-touch labeling distinguishes TP, hard SL, and staircase exits", () => {
  const base = candidate(0, "neutral");
  base.metrics.shadowTakeProfitMovePercent = 1;
  base.metrics.shadowStopLossMovePercent = 0.5;
  const start = Date.parse(base.observedAt);
  assert.equal(classifyScalpCandidateFirstTouch({
    candidate: base,
    points: [{ t: start + 60_000, v: 101, h: 101.1, l: 100 }],
  }), "full-tp");
  assert.equal(classifyScalpCandidateFirstTouch({
    candidate: base,
    points: [{ t: start + 60_000, v: 99.5, h: 100, l: 99.4 }],
  }), "full-sl");
  assert.equal(classifyScalpCandidateFirstTouch({
    candidate: base,
    points: [
      { t: start + 60_000, v: 100.6, h: 100.6, l: 100.3 },
      { t: start + 120_000, v: 100.2, h: 100.4, l: 100.2 },
    ],
  }), "profitable-staircase");
});

test("outcome challenger waits for 50 labels and 100 examples per class before validation", () => {
  const classes = ["full-tp", "profitable-staircase", "full-sl", "neutral"] as const;
  const small = Array.from({ length: 49 }, (_, index) => candidate(index, classes[index % 4]!));
  const insufficient = trainScalpOutcomeModel({ candidates: small, outcomes: [], trainedAt: new Date(0) });
  assert.equal(insufficient.status, "insufficient-data");
  assert.equal(insufficient.retrainBatchSize, SCALP_OUTCOME_RETRAIN_BATCH_SIZE);
  const firstBatch = trainScalpOutcomeModel({
    candidates: Array.from({ length: 50 }, (_, index) => candidate(index, classes[index % 4]!)),
    outcomes: [],
    previous: insufficient,
    trainedAt: new Date(0),
  });
  assert.equal(firstBatch.status, "shadow", "an untrained progress snapshot cannot move the 50-label cursor");

  const shadow = trainScalpOutcomeModel({
    candidates: Array.from({ length: 200 }, (_, index) => candidate(index, classes[index % 4]!)),
    outcomes: [],
    trainedAt: new Date(0),
  });
  assert.equal(shadow.status, "shadow");
  assert.equal(shadow.minimumClassSamples, SCALP_OUTCOME_MINIMUM_CLASS_SAMPLES);
  assert.equal(shadow.strongBaselineClassSamples, SCALP_OUTCOME_STRONG_CLASS_SAMPLES);

  const validated = trainScalpOutcomeModel({
    candidates: Array.from({ length: 400 }, (_, index) => candidate(index, classes[index % 4]!)),
    outcomes: [],
    trainedAt: new Date(0),
  });
  assert.equal(validated.status, "validated");
  assert.equal(validated.validation.chronological, true);
  assert.equal(validated.validation.passed, true);
  const prediction = predictScalpCandidateOutcome(validated, candidate(500, "full-tp"));
  assert.equal(prediction.calibrated, true);
  assert.ok(prediction.fullTp > prediction.fullSl);
  assert.ok(Math.abs(prediction.fullTp + prediction.profitableStaircase + prediction.fullSl + prediction.neutral - 1) < 1e-9);
});

test("exit provenance separates full TP, profitable staircase, and hard SL", () => {
  assert.deepEqual(inferScalpExitProvenance({ exitReason: "take-profit", netPnlUsd: 2 }), {
    exitMechanism: "full-tp",
    outcomeClass: "full-tp",
  });
  assert.equal(inferScalpExitProvenance({ exitReason: "stop-loss", netPnlUsd: 1 }).outcomeClass, "profitable-staircase");
  assert.equal(inferScalpExitProvenance({ exitReason: "stop-loss", netPnlUsd: -1 }).outcomeClass, "full-sl");
});

test("outcome probabilities are advisory in shadow and enforced only after validation", () => {
  const prediction = {
    modelVersion: "test",
    calibrated: true,
    fullTp: 0.2,
    profitableStaircase: 0.1,
    fullSl: 0.5,
    neutral: 0.2,
  };
  assert.equal(evaluateValidatedScalpOutcomePrediction({
    modelStatus: "shadow",
    prediction,
  }).allowed, true);
  assert.equal(evaluateValidatedScalpOutcomePrediction({
    modelStatus: "validated",
    prediction,
  }).allowed, false);
});
