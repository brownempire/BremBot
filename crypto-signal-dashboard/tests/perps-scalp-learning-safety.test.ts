import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "brembot-scalp-safety-"));
process.env.REDIS_URL = "";
process.env.PERPS_SCALP_CIRCUIT_FILE = path.join(tempRoot, "circuit.json");
process.env.PERPS_SCALP_CANDIDATES_FILE = path.join(tempRoot, "candidates.json");

let scalpTrainer: typeof import("../lib/decision/scalpTrainer");
let learningTypes: typeof import("../lib/decision/learningTypes");
let scalpEngine: typeof import("../lib/perps/scalpEngine");
let learningStore: typeof import("../lib/decision/learningStore");
let trainer: typeof import("../lib/decision/trainer");
let circuitStore: typeof import("../lib/decision/scalpCircuitStore");
let candidateStore: typeof import("../lib/decision/scalpCandidateStore");
let userExecutionAudit: typeof import("../lib/perps/userExecutionAudit");
let decisionLogStore: typeof import("../lib/decision/logStore");

test.before(async () => {
  scalpTrainer = await import("../lib/decision/scalpTrainer");
  learningTypes = await import("../lib/decision/learningTypes");
  scalpEngine = await import("../lib/perps/scalpEngine");
  learningStore = await import("../lib/decision/learningStore");
  trainer = await import("../lib/decision/trainer");
  circuitStore = await import("../lib/decision/scalpCircuitStore");
  candidateStore = await import("../lib/decision/scalpCandidateStore");
  userExecutionAudit = await import("../lib/perps/userExecutionAudit");
  decisionLogStore = await import("../lib/decision/logStore");
});

test.beforeEach(() => {
  for (const file of [process.env.PERPS_SCALP_CIRCUIT_FILE, process.env.PERPS_SCALP_CANDIDATES_FILE]) {
    if (file && fs.existsSync(file)) fs.rmSync(file);
  }
});

function scalpOutcome(index: number, netPnlUsd: number) {
  return learningTypes.tradeLearningOutcomeSchema.parse({
    outcomeId: `probation-outcome-${index}`,
    walletAddress: "probation-wallet",
    executionId: `execution-${index}`,
    decisionId: `decision-${index}`,
    signalId: `signal-${index}`,
    asset: "SOL",
    side: "long",
    openedAt: new Date(Date.UTC(2026, 7, 19, 12, index * 2)).toISOString(),
    closedAt: new Date(Date.UTC(2026, 7, 19, 12, index * 2 + 1)).toISOString(),
    positionPubkey: `position-${index}`,
    entryPrice: 100,
    exitPrice: netPnlUsd >= 0 ? 101 : 99,
    collateralUsd: 10,
    sizeUsd: 200,
    leverage: 20,
    takeProfitPrice: 101,
    stopLossPrice: 99,
    grossPnlUsd: netPnlUsd + 0.25,
    feesUsd: 0.25,
    netPnlUsd,
    returnOnCollateralPercent: netPnlUsd * 10,
    durationMinutes: 1,
    exitReason: netPnlUsd >= 0 ? "take-profit" : "stop-loss",
    signalConfidence: 0.82,
    signalType: "scalp",
    trendWindow: 145,
    trendThreshold: 1.65,
    breakoutPercent: 0.35,
    cooldownSeconds: 2_550,
    trendStrengthPercent: 0.5,
    breakoutStrengthPercent: 0.2,
    volatilityPercent: 1,
    atrPercent: 0.15,
    indicatorScore: 4,
    emaSpreadPercent: 0.1,
    emaSlopePercent: 0.02,
    rsi: 60,
    macdHistogram: 0.1,
    macdHistogramChange: 0.02,
    adx: 25,
    plusDi: 30,
    minusDi: 15,
    volumeRatio: 1.5,
    bollingerBandwidthPercent: 0.5,
    bollingerPosition: 0.6,
    scalpSetupType: "v-reversal",
    scalpEntryPath: "continuation",
    priceActionScore: 0.8,
    priceActionTags: ["INDICATORS_CONFIRMED_TREND_CONTINUATION"],
    trendBias: "bullish",
    createdAt: new Date(Date.UTC(2026, 7, 19, 12, index * 2 + 1, 1)).toISOString(),
  });
}

test("policy migration is explicitly live on probation without claiming zero-sample validation", () => {
  assert.equal(scalpEngine.DEFAULT_SCALP_LEARNING_PROFILE.policyRollout, null);
  const profile = scalpTrainer.createAuditedScalpBaseline([]);

  assert.equal(profile.policyVersion, 8);
  assert.equal(profile.validation.sampleSize, 0);
  assert.equal(profile.validation.passed, false);
  assert.equal(profile.policyRollout?.status, "probation");
  assert.equal(profile.policyRollout?.liveTradingAuthorized, true);
  assert.equal(scalpEngine.scalpProfileAllowsLiveEntries(profile), true);

  const unauthorized = structuredClone(profile);
  if (!unauthorized.policyRollout) throw new Error("Expected rollout metadata.");
  unauthorized.policyRollout.liveTradingAuthorized = false;
  assert.equal(scalpEngine.scalpProfileAllowsLiveEntries(unauthorized), false);

  const paused = structuredClone(profile);
  if (!paused.policyRollout) throw new Error("Expected rollout metadata.");
  paused.policyRollout.status = "paused";
  assert.equal(scalpEngine.scalpProfileAllowsLiveEntries(paused), false);
});

test("five-trade learning batches preserve probation until ten profitable post-fee outcomes validate it", () => {
  const outcomes = Array.from({ length: 10 }, (_, index) => scalpOutcome(index, 1));
  const baseline = scalpTrainer.createAuditedScalpBaseline([]);
  if (!baseline.policyRollout) throw new Error("Expected rollout metadata.");
  baseline.policyRollout.startedAt = "2026-08-19T11:59:00.000Z";
  const firstBatch = scalpTrainer.updateScalpLearningProfile(baseline, outcomes.slice(0, 5));

  assert.equal(firstBatch.learnedFromClosedTrades, 5);
  assert.equal(firstBatch.policyRollout?.status, "probation");
  assert.equal(firstBatch.validation.passed, false);
  assert.equal(firstBatch.policyRollout?.reviewedOutcomeCount, 5);
  assert.equal(scalpEngine.scalpProfileAllowsLiveEntries(firstBatch), true);

  const validated = scalpTrainer.updateScalpLearningProfile(firstBatch, outcomes);
  assert.equal(validated.learnedFromClosedTrades, 10);
  assert.equal(validated.policyRollout?.status, "validated");
  assert.equal(validated.validation.passed, true);
  assert.ok(validated.validation.expectancyUsd > 0);
  assert.ok(validated.validation.profitFactor >= scalpTrainer.SCALP_POLICY_PROBATION_MIN_PROFIT_FACTOR);
  assert.equal(scalpEngine.scalpProfileAllowsLiveEntries(validated), true);
});

test("a completed negative probation sample pauses live entry instead of auto-passing", () => {
  const outcomes = Array.from({ length: 10 }, (_, index) => scalpOutcome(index, index < 3 ? 1 : -1));
  const baseline = scalpTrainer.createAuditedScalpBaseline([]);
  if (!baseline.policyRollout) throw new Error("Expected rollout metadata.");
  baseline.policyRollout.startedAt = "2026-08-19T11:59:00.000Z";
  const firstBatch = scalpTrainer.updateScalpLearningProfile(baseline, outcomes.slice(0, 5));
  const failed = scalpTrainer.updateScalpLearningProfile(firstBatch, outcomes);

  assert.equal(failed.policyRollout?.status, "paused");
  assert.equal(failed.policyRollout?.liveTradingAuthorized, false);
  assert.equal(failed.validation.passed, false);
  assert.equal(scalpEngine.scalpProfileAllowsLiveEntries(failed), false);
});

test("v8 scalp learning tracks processed outcome IDs so a late older outcome cannot shift its cursor", () => {
  const original = Array.from({ length: 9 }, (_, index) => scalpOutcome(index, 1));
  const baseline = scalpTrainer.createAuditedScalpBaseline([]);
  if (!baseline.policyRollout) throw new Error("Expected rollout metadata.");
  baseline.policyRollout.startedAt = "2026-08-19T11:59:00.000Z";

  const firstBatch = scalpTrainer.updateScalpLearningProfile(baseline, original.slice(0, 5));
  assert.deepEqual(new Set(firstBatch.processedPolicyOutcomeIds), new Set(original.slice(0, 5).map((item) => item.outcomeId)));

  const late = {
    ...scalpOutcome(99, -1),
    outcomeId: "late-reconciled-older-loss",
    openedAt: "2026-08-19T12:00:30.000Z",
    closedAt: "2026-08-19T12:00:45.000Z",
  };
  const afterLateBatch = scalpTrainer.updateScalpLearningProfile(firstBatch, [
    ...original,
    late,
  ]);
  assert.equal(afterLateBatch.processedPolicyOutcomeIds.length, 10);
  assert.ok(afterLateBatch.processedPolicyOutcomeIds.includes(late.outcomeId));
  assert.deepEqual(
    new Set(afterLateBatch.processedPolicyOutcomeIds),
    new Set([...original, late].map((item) => item.outcomeId))
  );

  const replayed = scalpTrainer.updateScalpLearningProfile(afterLateBatch, [...original, late]);
  assert.deepEqual(replayed.processedPolicyOutcomeIds, afterLateBatch.processedPolicyOutcomeIds);
  assert.equal(replayed.minimumConfidence, afterLateBatch.minimumConfidence);
  assert.equal(replayed.riskMultiplier, afterLateBatch.riskMultiplier);
});

test("circuit breakers disable a path after two losses and pause all scalp entries after three", async () => {
  const base = {
    walletAddress: "circuit-wallet",
    policyVersion: 8,
    entryPath: "continuation" as const,
  };
  await circuitStore.recordScalpCircuitOutcome({
    ...base,
    outcomeId: "loss-1",
    netPnlUsd: -1,
    closedAt: "2026-08-19T12:01:00.000Z",
  });
  const pathDisabled = await circuitStore.recordScalpCircuitOutcome({
    ...base,
    outcomeId: "loss-2",
    netPnlUsd: -2,
    closedAt: "2026-08-19T12:02:00.000Z",
  });

  assert.equal(pathDisabled.paths.continuation.disabled, true);
  assert.equal(pathDisabled.globallyPaused, false);
  assert.equal((await circuitStore.getScalpCircuitDecision(base)).allowed, false);

  const globallyPaused = await circuitStore.recordScalpCircuitOutcome({
    ...base,
    entryPath: "range-reversal",
    outcomeId: "loss-3",
    netPnlUsd: -3,
    closedAt: "2026-08-19T12:03:00.000Z",
  });
  assert.equal(globallyPaused.globallyPaused, true);
  assert.equal((await circuitStore.getScalpCircuitDecision({ ...base, entryPath: "breakout-retest" })).allowed, false);

  const idempotent = await circuitStore.recordScalpCircuitOutcome({
    ...base,
    entryPath: "range-reversal",
    outcomeId: "loss-3",
    netPnlUsd: -3,
    closedAt: "2026-08-19T12:03:00.000Z",
  });
  assert.equal(idempotent.processedOutcomeCount, 3);

  const reset = await circuitStore.resetScalpCircuit({
    walletAddress: base.walletAddress,
    policyVersion: base.policyVersion,
    reason: "Operator reviewed the stopped paths.",
    resetAt: "2026-08-19T12:04:00.000Z",
  });
  assert.equal(reset.globallyPaused, false);
  assert.equal(reset.paths.continuation.disabled, false);
});

test("circuit path derivation recognizes the v8 breakout/retest audit tag", () => {
  assert.equal(circuitStore.deriveScalpEntryPath({
    scalpEntryPath: undefined,
    scalpSetupType: "v-reversal",
    priceActionTags: ["PRICE_BREAKOUT_RETEST", "INDICATORS_CONFIRMED_BREAKOUT_RETEST"],
  }), "breakout-retest");
});

test("live circuit checks fail closed without authoritative Redis", async () => {
  await assert.rejects(
    circuitStore.getScalpCircuitDecision({
      walletAddress: "authoritative-wallet",
      policyVersion: 8,
      entryPath: "continuation",
      requireAuthoritative: true,
    }),
    /Authoritative Redis scalp-circuit state is unavailable/
  );
  await assert.rejects(
    circuitStore.recordScalpCircuitOutcome({
      walletAddress: "authoritative-wallet",
      policyVersion: 8,
      entryPath: "continuation",
      outcomeId: "authoritative-loss",
      netPnlUsd: -1,
      closedAt: "2026-08-19T12:05:00.000Z",
      requireAuthoritative: true,
    }),
    /Authoritative Redis scalp-circuit state is unavailable/
  );
});

test("live rollout and outcome storage fail closed without authoritative Redis", async () => {
  await assert.rejects(
    learningStore.getActiveDecisionLearningProfileAuthoritative("authoritative-wallet"),
    /Authoritative Redis learning-profile storage is unavailable/
  );
  await assert.rejects(
    learningStore.listTradeLearningOutcomesAuthoritative("authoritative-wallet"),
    /Authoritative Redis learning-outcome storage is unavailable/
  );
  await assert.rejects(
    trainer.ensureWalletScalpPolicyProfile({
      walletAddress: "authoritative-wallet",
      source: "automatic",
    }),
    /Authoritative Redis learning-(?:profile|outcome) storage is unavailable/
  );
  await assert.rejects(
    trainer.trainWalletDecisionProfile({
      walletAddress: "authoritative-wallet",
      config: null,
      source: "automatic",
      requireAuthoritative: true,
    }),
    /Authoritative Redis learning-profile storage is unavailable/
  );
  await assert.rejects(
    userExecutionAudit.listUserPerpsExecutionsAuthoritative("authoritative-wallet"),
    /Authoritative Redis execution audit is unavailable/
  );
  await assert.rejects(
    decisionLogStore.listTradeDecisionRecordsAuthoritative(50, "authoritative-wallet"),
    /Authoritative Redis decision audit is unavailable/
  );
});

test("candidate journal retains accepted and rejected setups and adds directional 5/15/30/60m labels", async () => {
  const observedAt = Date.parse("2026-08-19T12:00:00.000Z");
  await candidateStore.saveScalpCandidate({
    candidateId: "accepted-candidate",
    walletAddress: "candidate-wallet",
    policyVersion: 8,
    asset: "SOL",
    side: "long",
    entryPath: "breakout-retest",
    setupType: null,
    observedAt: new Date(observedAt).toISOString(),
    referencePrice: 100,
    disposition: "accepted",
    rejectionReasons: [],
    signalId: "candidate-signal",
    decisionId: null,
    executionId: null,
    metrics: { priceActionScore: 0.8, volumeRatio: 1.4 },
    tags: ["BREAKOUT_RETEST"],
  });
  await candidateStore.saveScalpCandidate({
    candidateId: "rejected-candidate",
    walletAddress: "candidate-wallet",
    policyVersion: 8,
    asset: "SOL",
    side: "short",
    entryPath: "range-reversal",
    setupType: "range-reversal",
    observedAt: new Date(observedAt + 60_000).toISOString(),
    referencePrice: 100,
    disposition: "rejected",
    rejectionReasons: ["ADX contradicted the range setup."],
    signalId: null,
    decisionId: null,
    executionId: null,
    metrics: { adx: 50 },
    tags: [],
  });

  const points = Array.from({ length: 60 }, (_, index) => ({
    t: observedAt + (index + 1) * 60_000,
    o: 100 + index * 0.1,
    h: 100.15 + index * 0.1,
    l: index === 0 ? 99.5 : 99.95 + index * 0.1,
    v: 100.1 + index * 0.1,
    volume: 10,
  }));
  const firstLabels = await candidateStore.labelScalpCandidateHorizons({
    candidateId: "accepted-candidate",
    walletAddress: "candidate-wallet",
    points,
    evaluatedAt: observedAt + 15 * 60_000,
  });
  assert.ok(firstLabels.labels["5"]);
  assert.ok(firstLabels.labels["15"]);
  assert.equal(firstLabels.labels["30"], undefined);
  assert.equal(firstLabels.labels["5"]?.maximumFavorableExcursionPercent, 0.55);
  assert.equal(firstLabels.labels["5"]?.maximumAdverseExcursionPercent, 0.5);

  const allLabels = await candidateStore.labelScalpCandidateHorizons({
    candidateId: "accepted-candidate",
    walletAddress: "candidate-wallet",
    points,
    evaluatedAt: observedAt + 60 * 60_000,
  });
  assert.deepEqual(Object.keys(allLabels.labels).sort(), ["15", "30", "5", "60"]);
  assert.equal((await candidateStore.listScalpCandidates({
    walletAddress: "candidate-wallet",
    disposition: "rejected",
  })).length, 1);
});
