import assert from "node:assert/strict";
import test from "node:test";

import type { PerpsAutomationConfig } from "../lib/perps/automationConfig";
import {
  AutonomousMonitorLeaseLostError,
  classifyProfitLockSideEffectFailure,
  computeTriggerPrices,
  detectScalpSignal,
  evaluateScalpAdverseEntryDrift,
  evaluateScalpOneSecondEntryPoint,
  getScalpTradePlanningConfig,
  hasMatchingEntirePositionProfitLockStop,
  mergeCompleteJupiterTradeHistoryForLearning,
  monitorScalpOneSecondEntryPoint,
  ProfitLockSideEffectError,
  resolveAutonomousCollateralUsd,
  resolveProfitLockPositionProvenance,
  resolveRevalidatedScalpEntryPath,
  resolveScalpProbationCollateralPercent,
  runAutonomousPerpsMonitor as runAutonomousPerpsMonitorImpl,
  runWithRenewingAutonomousMonitorLease,
  SCALP_ONE_SECOND_ENTRY_INTERVAL_MS,
  SCALP_SIGNAL_COOLDOWN_SECONDS,
  type AutonomousMonitorLeaseGuard,
  type AutonomousMonitorLeaseStore,
  type ProfitLockClaimSettlement,
  type ProfitLockSideEffectClaim,
} from "../lib/perps/autonomousMonitor";
import { SCALP_STOP_LOSS_ROE_PERCENT } from "../lib/perps/scalpExit";
import {
  DEFAULT_SCALP_LEARNING_PROFILE,
  SCALP_EXCEPTIONAL_REVERSAL_BYPASS_ENABLED,
  SCALP_EXCEPTIONAL_REVERSAL_SCORE,
  SCALP_REVERSAL_MAX_ADX,
  SCALP_TRADE_LEVERAGE,
  analyzeScalpPriceAction,
  detectAdaptiveScalpSignal,
  evaluateScalpReversalSafety,
} from "../lib/perps/scalpEngine";
import type { DecisionLearningProfile, ScalpCandidate, TradeLearningOutcome } from "../lib/decision/learningTypes";
import type { JupiterPerpsPosition } from "../lib/jupiterPerps";
import {
  calculatePerpsPositionNetRoePercent,
  calculatePerpsPositionRoePercent,
  calculateScalpProfitLockStopPrice,
  evaluatePerpsProfitLock,
  PROFIT_LOCK_INITIAL_ARM_ROE_PERCENT,
  PROFIT_LOCK_INITIAL_EXIT_ROE_PERCENT,
  PROFIT_LOCK_ARM_ROE_PERCENT,
  PROFIT_LOCK_EXIT_ROE_PERCENT,
  SCALP_PROFIT_LOCK_INITIAL_ARM_ROE_PERCENT,
  SCALP_PROFIT_LOCK_INITIAL_EXIT_ROE_PERCENT,
  type PerpsProfitLockState,
} from "../lib/perps/profitLock";
import type { PerpsAgentSignal, PerpsAutomationSession, PerpsUserExecution } from "../lib/perps/sessionTypes";
import { PerpsExecutionError } from "../lib/perps/errors";
import { computeIndicatorSnapshot } from "../lib/signal/indicators";

type RouteSignal = typeof import("../lib/perps/tradingAgent").routePerpsSignalForUser;
type SaveScalpCandidate = typeof import("../lib/decision/scalpCandidateStore").saveScalpCandidate;

const walletAddress = "owner-wallet";

let testClaimSequence = 0;
function createProfitLockTestClaim(label = "claim"): ProfitLockSideEffectClaim {
  testClaimSequence += 1;
  const ownerToken = `${label}-owner-${testClaimSequence}`;
  return {
    key: `${label}-key-${testClaimSequence}`,
    ownerToken,
    reservedValue: `${ownerToken}:reserved`,
  };
}

function createProfitLockTestClaimLifecycle(label: string) {
  let activeClaim: ProfitLockSideEffectClaim | null = null;
  const settlements: ProfitLockClaimSettlement[] = [];
  return {
    settlements,
    claim: async () => {
      if (activeClaim) return null;
      activeClaim = createProfitLockTestClaim(label);
      return activeClaim;
    },
    settle: async (claim: ProfitLockSideEffectClaim, settlement: ProfitLockClaimSettlement) => {
      if (
        !activeClaim
        || claim.ownerToken !== activeClaim.ownerToken
      ) return false;
      settlements.push(settlement);
      if (settlement === "definite-failure") activeClaim = null;
      return true;
    },
  };
}

const runAutonomousPerpsMonitor = (
  overrides: Parameters<typeof runAutonomousPerpsMonitorImpl>[0] = {},
  leaseGuard?: AutonomousMonitorLeaseGuard
) => {
  const ensureScalpPolicyProfile = overrides.ensureScalpPolicyProfile ?? (async (address: string) => (
    await overrides.getLearningProfile?.(address) ?? qualifyingRangeLearningProfile()
  ));
  const latestFetchedPriceByProduct = new Map<string, number>();
  const providedFetchCandles = overrides.fetchCandles;
  const fetchCandles = providedFetchCandles
    ? async (...args: Parameters<typeof providedFetchCandles>) => {
        const points = await providedFetchCandles(...args);
        const latest = points.at(-1)?.v;
        if (typeof latest === "number" && Number.isFinite(latest) && latest > 0) {
          latestFetchedPriceByProduct.set(args[0], latest);
        }
        return points;
      }
    : undefined;
  const providedFetchSnapshot = overrides.fetchSnapshot;
  const fetchSnapshot = providedFetchSnapshot
    ? async (...args: Parameters<typeof providedFetchSnapshot>) => {
        const snapshot = await providedFetchSnapshot(...args);
        if (snapshot.readEvidence) return snapshot;
        const hasLivePosition = snapshot.positions.some((position) => position.source !== "mock");
        return {
          ...snapshot,
          readEvidence: {
            liveApiSucceeded: true,
            rpcSucceeded: true,
            authoritativePositionAbsence: !hasLivePosition,
          },
        };
      }
    : undefined;
  return runAutonomousPerpsMonitorImpl({
    // Production scalp monitoring requires authoritative Redis reconciliation.
    // Focused unit cases inject deterministic in-memory outcomes by default.
    reconcileLearningHistory: async () => 0,
    getLatestClosedOutcome: async () => null,
    getClosedScalpOutcomes: async () => [],
    recordScalpCircuitOutcomes: (async () => null) as never,
    getScalpCircuitDecision: (async () => ({ allowed: true, reasons: [], state: null })) as never,
    autoTrain: async () => undefined,
    recoverPendingScalpProtection: async () => ({
      status: "no-pending-recovery",
      blockNewEntries: false,
      record: null,
      message: "No pending recovery.",
    }),
    listPendingScalpProtectionRecoveryWallets: async () => [],
    fetchLivePrice: async (product) => latestFetchedPriceByProduct.get(product) ?? null,
    getProfitLockPositionProvenance: async (address, positionPubkey) => {
      const configs = await overrides.listConfigs?.() ?? [];
      const strategyClass = configs.find((config) => config.walletAddress === address)?.settings.scalpModeEnabled
        ? "scalp" as const
        : "smart" as const;
      return {
        episodeId: `test-episode:${positionPubkey}`,
        executionId: `test-episode:${positionPubkey}`,
        strategyClass,
        createdAt: "2026-08-19T12:00:00.000Z",
      };
    },
    readProfitLockTransactionStatus: async () => "processing",
    submitProfitLockStop: async (_walletAddress, _position, triggerPrice) => ({
      txid: "test-profit-lock-stop-tx",
      triggerPrice,
    }),
    claimProfitLockStop: async () => createProfitLockTestClaim("stop"),
    claimProfitLockClose: async () => createProfitLockTestClaim("close"),
    settleProfitLockClaim: async () => true,
    commitFailedProfitLockClaim: async (address, _positionPubkey, claim, nextState) => {
      const committed = overrides.settleProfitLockClaim
        ? await overrides.settleProfitLockClaim(claim, "definite-failure")
        : true;
      if (!committed) return false;
      await overrides.writeProfitLockState?.(address, nextState);
      return true;
    },
    cancelDirectionExperiment: async () => null,
    ...overrides,
    ...(fetchCandles ? { fetchCandles } : {}),
    ...(fetchSnapshot ? { fetchSnapshot } : {}),
    ensureScalpPolicyProfile,
  }, leaseGuard);
};

function createCandidateRecorder(records: ScalpCandidate[]): SaveScalpCandidate {
  const stored = new Map<string, ScalpCandidate>();
  return (async (input) => {
    const existing = stored.get(input.candidateId);
    const now = new Date().toISOString();
    const candidate = {
      ...existing,
      ...input,
      rejectionReasons: input.rejectionReasons ?? existing?.rejectionReasons ?? [],
      metrics: { ...existing?.metrics, ...input.metrics },
      tags: input.tags ?? existing?.tags ?? [],
      labels: { ...existing?.labels, ...input.labels },
      createdAt: existing?.createdAt ?? input.createdAt ?? now,
      updatedAt: input.updatedAt ?? now,
    } as ScalpCandidate;
    stored.set(candidate.candidateId, candidate);
    records.push(candidate);
    return candidate;
  }) as SaveScalpCandidate;
}

function createConfig(overrides: Partial<PerpsAutomationConfig> = {}): PerpsAutomationConfig {
  return {
    walletAddress,
    revision: 1,
    settings: {
      walletPercent: 25,
      walletAllocationMode: "percent",
      perpsTakeProfitValue: 2,
      perpsTakeProfitMode: "percent",
      spotTakeProfitValue: 0,
      spotTakeProfitMode: "percent",
      stopLossPercent: 1,
      perpsLeverage: 2,
      perpsExecutionMode: "set-parameters",
      scalpModeEnabled: false,
      scalpTakeProfitRoePercent: 25,
      decisionMode: "active",
      smartTradeProfile: "balanced",
      slots: [
        { id: "slot-sol", token: "SOL" },
        { id: "slot-eth", token: "ETH" },
        { id: "slot-btc", token: "BTC" },
      ],
      activeSlotId: null,
      perpsActiveSlotId: "slot-sol",
      scalpActiveSlotId: null,
      mode: "all",
      disableTpLock: false,
    },
    params: {
      trendWindow: 5,
      trendThreshold: 0.5,
      breakoutPercent: 0.8,
      cooldownSeconds: 60,
    },
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

test("scalp detection does not enter from a one-candle range edge without the full reversal sequence", () => {
  const baseTime = 1_784_174_800_000;
  const points = [100, 100.1, 100.05, 99.95, 99.9].map((value, index) => ({
    t: baseTime + index * 60_000,
    v: value,
  }));
  const signal = detectScalpSignal({
    symbol: "SOL/USD",
    points,
    cooldownSeconds: 180,
    indicators: {
      emaFast: 99.98,
      emaSlow: 100,
      emaSpreadPercent: -0.02,
      emaSlopePercent: -0.01,
      rsi: 39,
      macdLine: -0.01,
      macdSignal: -0.01,
      macdHistogram: 0,
      macdHistogramChange: 0,
      adx: 14,
      plusDi: 18,
      minusDi: 20,
      atrPercent: 0.08,
      volumeRatio: 1.1,
      bollingerBandwidthPercent: 0.6,
      bollingerPosition: -0.2,
    },
  });

  assert.equal(signal, null);
});

test("scalp detection uses a seven-minute cooldown only after a recorded trade close", () => {
  const points = qualifyingRangePoints();
  const indicators = computeIndicatorSnapshot(points);
  const latestTimestamp = points[points.length - 1]!.t;

  assert.equal(SCALP_SIGNAL_COOLDOWN_SECONDS, 420);
  assert.equal(detectScalpSignal({
    symbol: "SOL/USD",
    points,
    indicators,
    cooldownSeconds: SCALP_SIGNAL_COOLDOWN_SECONDS,
    recentClosedTrade: {
      openedAt: latestTimestamp - 10 * 60_000,
      closedAt: latestTimestamp - (SCALP_SIGNAL_COOLDOWN_SECONDS * 1_000 - 1),
      side: "long",
      netPnlUsd: 1,
    },
  }), null);
  assert.equal(detectScalpSignal({
    symbol: "SOL/USD",
    points,
    indicators,
    cooldownSeconds: SCALP_SIGNAL_COOLDOWN_SECONDS,
    recentClosedTrade: {
      openedAt: latestTimestamp - 10 * 60_000,
      closedAt: latestTimestamp - SCALP_SIGNAL_COOLDOWN_SECONDS * 1_000,
      side: "long",
      netPnlUsd: 1,
    },
  })?.type, "scalp");
  assert.equal(detectScalpSignal({
    symbol: "SOL/USD",
    points,
    indicators,
    cooldownSeconds: SCALP_SIGNAL_COOLDOWN_SECONDS,
  })?.type, "scalp", "a rejected candidate cannot start the post-close cooldown");
});

function reversalIndicators(overrides: Record<string, number | null> = {}) {
  return {
    emaFast: 100.4,
    emaSlow: 99.5,
    emaSpreadPercent: 0.9,
    emaSlopePercent: 0.2,
    rsi: 58,
    macdLine: -0.01,
    macdSignal: 0,
    macdHistogram: -0.01,
    macdHistogramChange: 0.01,
    adx: 38,
    plusDi: 18,
    minusDi: 24,
    atrPercent: 0.12,
    volumeRatio: 1.6,
    bollingerBandwidthPercent: 0.8,
    bollingerPosition: 0.55,
    ...overrides,
  };
}

function bullishSweepPoints() {
  const baseTime = 1_784_174_800_000;
  return Array.from({ length: 24 }, (_, index) => {
    const closes = [100, 99.98, 99.82, 99.88, 100.02, 100.16];
    const close = index < 18 ? 100 + Math.sin(index) * 0.015 : closes[index - 18]!;
    return {
      t: baseTime + index * 60_000,
      o: index === 20 ? 100 : close - 0.01,
      h: index === 20 ? 100.02 : close + 0.03,
      l: index === 20 ? 99.7 : close - 0.03,
      v: close,
      volume: index >= 22 ? 220 : 100,
    };
  });
}

function exceptionalBullishSweepPoints() {
  return bullishSweepPoints().map((point, index) => index === 22
    ? {
        ...point,
        o: 99.98,
        h: 100.04,
        l: 99.8,
      }
    : point);
}

function qualifyingRangePoints() {
  const baseTime = 1_784_174_800_000;
  const closes = Array.from({ length: 51 }, (_, index) => 100 + Math.sin(index / 2) * 0.025);
  closes.push(100.15, 100.14, 100.09, 100.11, 100.13, 100.14, 100.12, 100.16, 100.2);
  return closes.map((close, index) => ({
    t: baseTime + index * 60_000,
    o: index === 0 ? close : closes[index - 1],
    h: index < 51 ? Math.min(close + 0.05, 100.08) : close + 0.05,
    l: index === 53 ? 100.055 : close - 0.05,
    v: close,
    volume: index === 51 ? 220 : index >= closes.length - 3 ? 130 : 100,
  }));
}

function qualifyingRangeLearningProfile() {
  const profile = createLearningProfile();
  profile.scalpProfile = structuredClone(DEFAULT_SCALP_LEARNING_PROFILE);
  profile.scalpProfile.minimumConfidence = 0.7;
  profile.scalpProfile.policyRollout = {
    status: "probation",
    startedAt: "2026-08-19T12:00:00.000Z",
    baselineOutcomeCount: 0,
    reviewedOutcomeCount: 0,
    minimumValidationTrades: 10,
    liveTradingAuthorized: true,
    authorization: "operator-approved-live-rollout",
    reason: "Test policy v8 rollout.",
  };
  profile.leverageFloor = 5;
  profile.leverageCap = 20;
  profile.maximumAllocationPercent = 50;
  profile.targetWalletRiskPercent = 10;
  profile.assetAdjustments = {
    SOL: { ...profile.assetAdjustments.SOL, leverageMultiplier: 1, allocationMultiplier: 1 },
    ETH: { ...profile.assetAdjustments.ETH, leverageMultiplier: 1, allocationMultiplier: 1 },
    BTC: { ...profile.assetAdjustments.BTC, leverageMultiplier: 1, allocationMultiplier: 1 },
  };
  return profile;
}

test("enabled exceptional liquidity-sweep layer still requires prior-candle persistence", () => {
  const points = exceptionalBullishSweepPoints();
  const priceAction = analyzeScalpPriceAction(points, DEFAULT_SCALP_LEARNING_PROFILE);
  const signal = detectAdaptiveScalpSignal({
    symbol: "SOL/USD",
    points,
    indicators: reversalIndicators({ adx: SCALP_REVERSAL_MAX_ADX + 20 }),
    profile: structuredClone(DEFAULT_SCALP_LEARNING_PROFILE),
  });

  assert.equal(priceAction.direction, "bullish");
  assert.equal(priceAction.setupType, "liquidity-sweep");
  assert.equal(priceAction.strong, true);
  assert.equal(priceAction.confirmed, true);
  assert.ok(priceAction.score >= SCALP_EXCEPTIONAL_REVERSAL_SCORE);
  assert.equal(SCALP_EXCEPTIONAL_REVERSAL_BYPASS_ENABLED, true);
  assert.equal(signal, null);
});

test("enabled exceptional layer applies the same persistence rule to bearish sweeps", () => {
  const points = exceptionalBullishSweepPoints().map((point) => ({
    ...point,
    v: 200 - point.v,
    o: 200 - point.o,
    h: 200 - point.l,
    l: 200 - point.h,
  }));
  const priceAction = analyzeScalpPriceAction(points, DEFAULT_SCALP_LEARNING_PROFILE);
  const signal = detectAdaptiveScalpSignal({
    symbol: "SOL/USD",
    points,
    indicators: reversalIndicators({
      emaFast: 99.4,
      emaSlow: 100.3,
      emaSpreadPercent: -0.9,
      emaSlopePercent: -0.2,
      rsi: 42,
      plusDi: 24,
      minusDi: 18,
    }),
    profile: structuredClone(DEFAULT_SCALP_LEARNING_PROFILE),
  });

  assert.equal(priceAction.direction, "bearish");
  assert.equal(priceAction.setupType, "liquidity-sweep");
  assert.ok(priceAction.score >= SCALP_EXCEPTIONAL_REVERSAL_SCORE);
  assert.equal(signal, null);
});

test("a lone price spike without reclaim and momentum confirmation cannot bypass indicators", () => {
  const points = bullishSweepPoints().map((point, index) => index >= 21
    ? { ...point, v: 99.74, o: 99.76, h: 99.79, l: 99.7, volume: 100 }
    : point);
  const priceAction = analyzeScalpPriceAction(points, DEFAULT_SCALP_LEARNING_PROFILE);
  const signal = detectAdaptiveScalpSignal({
    symbol: "SOL/USD",
    points,
    indicators: reversalIndicators(),
    profile: structuredClone(DEFAULT_SCALP_LEARNING_PROFILE),
  });

  assert.equal(priceAction.direction, null);
  assert.equal(signal, null);
});

test("ADX above 40 still rejects a non-exceptional confirmed reversal", () => {
  const points = bullishSweepPoints();
  const profile = structuredClone(DEFAULT_SCALP_LEARNING_PROFILE);
  const priceAction = analyzeScalpPriceAction(points, profile);
  const signal = detectAdaptiveScalpSignal({
    symbol: "SOL/USD",
    points,
    indicators: reversalIndicators({ adx: SCALP_REVERSAL_MAX_ADX + 0.01 }),
    profile,
  });

  assert.equal(priceAction.strong, false);
  assert.equal(priceAction.confirmed, true);
  assert.ok(priceAction.score < SCALP_EXCEPTIONAL_REVERSAL_SCORE);
  assert.equal(signal, null);
});

test("a persisted reversal at the ADX 40 ceiling passes the new safety layer", () => {
  const priceAction = analyzeScalpPriceAction(exceptionalBullishSweepPoints(), DEFAULT_SCALP_LEARNING_PROFILE);
  const safety = evaluateScalpReversalSafety({
    priceAction,
    previousPriceAction: priceAction,
    indicators: reversalIndicators({
      adx: SCALP_REVERSAL_MAX_ADX,
      plusDi: 24,
      minusDi: 18,
    }),
    profile: DEFAULT_SCALP_LEARNING_PROFILE,
  });

  assert.equal(safety.qualified, true);
  assert.deepEqual(safety.reasons, []);
});

test("a profitable opposite-side scalp cannot bypass missing structural persistence", () => {
  const points = exceptionalBullishSweepPoints();
  const latestTimestamp = points.at(-1)!.t;
  const signal = detectAdaptiveScalpSignal({
    symbol: "SOL/USD",
    points,
    indicators: reversalIndicators({ adx: SCALP_REVERSAL_MAX_ADX + 20 }),
    profile: structuredClone(DEFAULT_SCALP_LEARNING_PROFILE),
    recentClosedTrade: {
      openedAt: latestTimestamp - 12 * 60_000,
      closedAt: latestTimestamp - SCALP_SIGNAL_COOLDOWN_SECONDS * 1_000,
      side: "short",
      netPnlUsd: 3.5,
    },
  });

  assert.equal(signal, null);
});

test("the seven-minute post-close cooldown applies regardless of the prior trade outcome or side", () => {
  const points = qualifyingRangePoints();
  const latestTimestamp = points.at(-1)!.t;
  const detect = (side: "long" | "short", netPnlUsd: number, closedMinutesAgo: number) => detectAdaptiveScalpSignal({
    symbol: "SOL/USD",
    points,
    indicators: computeIndicatorSnapshot(points),
    profile: structuredClone(DEFAULT_SCALP_LEARNING_PROFILE),
    recentClosedTrade: {
      openedAt: latestTimestamp - 12 * 60_000,
      closedAt: latestTimestamp - closedMinutesAgo * 60_000,
      side,
      netPnlUsd,
    },
  });

  assert.equal(detect("short", -1, 6.99), null);
  assert.equal(detect("long", 3.5, 6.99), null);
  assert.equal(detect("short", 3.5, 7)?.type, "scalp");
});

test("raw scalp confidence must clear the learned threshold instead of being raised to it", () => {
  const points = bullishSweepPoints();
  const profile = structuredClone(DEFAULT_SCALP_LEARNING_PROFILE);
  profile.minimumConfidence = 0.82;
  profile.setupConfidenceAdjustments.liquiditySweep = 0.08;
  const signal = detectAdaptiveScalpSignal({
    symbol: "SOL/USD",
    points,
    indicators: reversalIndicators(),
    profile,
  });

  assert.equal(signal, null);
});

test("scalp trigger pricing adds estimated fees to the adaptive net target", () => {
  const config = createConfig();
  const triggers = computeTriggerPrices({
    config,
    entryPrice: 100,
    collateralUsd: 25,
    leverage: 2,
    side: "long",
    stopLossPercent: 0,
    takeProfitPercent: 0,
    takeProfitUsd: 5,
  });
  const targetPnl = (((triggers.takeProfitPrice ?? 0) - 100) / 100) * 50;

  assert.ok(targetPnl - 50 * 0.0012 >= 4.999999);
  assert.equal(triggers.stopLossPrice, null);
});

test("scalp planning uses the configured 50 percent base allocation with a 40x normal ceiling", () => {
  const planningConfig = getScalpTradePlanningConfig(createConfig());
  assert.equal(planningConfig.settings.walletAllocationMode, "percent");
  assert.equal(planningConfig.settings.walletPercent, 50);
  assert.equal(planningConfig.settings.perpsLeverage, SCALP_TRADE_LEVERAGE);
  assert.equal(planningConfig.settings.stopLossPercent, SCALP_STOP_LOSS_ROE_PERCENT);
  assert.equal(SCALP_TRADE_LEVERAGE, 40);
  assert.equal(planningConfig.settings.perpsExecutionMode, "set-parameters");
});

test("low-balance collateral restores the isolated $12 order from $12 up to but not including $50", () => {
  assert.equal(resolveAutonomousCollateralUsd(11.99, 20), 2.398);
  assert.equal(resolveAutonomousCollateralUsd(11.99, 100), 9.999999);
  assert.equal(resolveAutonomousCollateralUsd(12, 20), 12);
  assert.equal(resolveAutonomousCollateralUsd(25, 20), 12);
  assert.equal(resolveAutonomousCollateralUsd(49.99, 20), 12);
  assert.equal(resolveAutonomousCollateralUsd(50, 20), 10);
});

test("probation sizing never suppresses the $12 low-balance order or creates a sub-minimum order", () => {
  assert.equal(resolveScalpProbationCollateralPercent(20, 50, true), 50);
  assert.equal(resolveAutonomousCollateralUsd(20, resolveScalpProbationCollateralPercent(20, 50, true)), 12);
  assert.equal(resolveScalpProbationCollateralPercent(50, 30, true), 30);
  assert.equal(resolveScalpProbationCollateralPercent(100, 50, true), 25);
  assert.equal(resolveScalpProbationCollateralPercent(100, 50, false), 50);
});

test("pre-submit revalidation accepts a same-direction path transition but rejects a direction change", () => {
  const points = qualifyingRangePoints();
  const breakout = detectAdaptiveScalpSignal({
    symbol: "SOL/USD",
    points,
    indicators: computeIndicatorSnapshot(points),
    profile: structuredClone(DEFAULT_SCALP_LEARNING_PROFILE),
  });
  assert.ok(breakout);
  const continuationEvaluation = {
    signal: {
      ...breakout!,
      priceActionTags: [
        "INDICATORS_CONFIRMED_TREND_CONTINUATION",
        "CONTINUATION_TWO_CANDLE_CONFIRMATION",
        "CONTINUATION_PULLBACK_RETEST_RESUMPTION",
        "CONTINUATION_CONFIRMATION_CONSENSUS",
      ],
    },
    candidate: {
      path: "continuation" as const,
      direction: breakout!.direction,
      score: breakout!.priceActionScore,
      accepted: true,
      rejectionReasons: [],
      tags: breakout!.priceActionTags,
      entryPrice: points.at(-1)!.v,
      timestamp: points.at(-1)!.t,
      regime: { bias: breakout!.direction, trending: true, exhausted: false, netMove145mPercent: 0.8, range145mPercent: 1.2, horizons: [] },
    },
  };

  assert.equal(resolveRevalidatedScalpEntryPath(breakout!.direction, continuationEvaluation), "continuation");
  assert.equal(resolveRevalidatedScalpEntryPath(
    breakout!.direction === "bullish" ? "bearish" : "bullish",
    continuationEvaluation
  ), null);
});

test("pre-submit scalp drift uses a bounded ATR-relative adverse tolerance", () => {
  const accepted = evaluateScalpAdverseEntryDrift({
    side: "long",
    referencePrice: 100,
    livePrice: 99.96,
    atrPercent: 0.1,
  });
  const rejected = evaluateScalpAdverseEntryDrift({
    side: "long",
    referencePrice: 100,
    livePrice: 99.9,
    atrPercent: 0.1,
  });

  assert.equal(accepted.tolerancePercent, 0.05);
  assert.equal(accepted.allowed, true);
  assert.equal(rejected.allowed, false);
  assert.ok(rejected.adverseMovePercent > rejected.tolerancePercent);
});

test("one-second entry evaluation requires direction confirmation without chasing beyond the ATR band", () => {
  const waiting = evaluateScalpOneSecondEntryPoint({
    side: "long",
    referencePrice: 100,
    livePrice: 99.96,
    atrPercent: 0.1,
  });
  const triggered = evaluateScalpOneSecondEntryPoint({
    side: "long",
    referencePrice: 100,
    livePrice: 100.01,
    atrPercent: 0.1,
  });
  const chasing = evaluateScalpOneSecondEntryPoint({
    side: "long",
    referencePrice: 100,
    livePrice: 100.06,
    atrPercent: 0.1,
  });

  assert.equal(waiting.triggered, false);
  assert.equal(waiting.invalidated, false);
  assert.equal(triggered.triggered, true);
  assert.equal(chasing.triggered, false);
  assert.equal(chasing.invalidated, false);
});

test("one-second entry monitor requires three confirming samples instead of entering on one tick", async () => {
  let clock = 0;
  const waits: number[] = [];
  const prices = [99.96, 100.01, 100.02, 100.01];
  const result = await monitorScalpOneSecondEntryPoint({
    side: "long",
    referencePrice: 100,
    atrPercent: 0.1,
    fetchPrice: async () => prices.shift() ?? null,
    deadlineAt: 5_000,
    now: () => clock,
    wait: async (milliseconds) => {
      waits.push(milliseconds);
      clock += milliseconds;
    },
  });

  assert.equal(result.status, "triggered");
  assert.equal(result.price, 100.01);
  assert.equal(result.observedAt, SCALP_ONE_SECOND_ENTRY_INTERVAL_MS * 3);
  assert.equal(result.samples, 4);
  assert.equal(result.confirmations, 3);
  assert.deepEqual(waits, [
    SCALP_ONE_SECOND_ENTRY_INTERVAL_MS,
    SCALP_ONE_SECOND_ENTRY_INTERVAL_MS,
    SCALP_ONE_SECOND_ENTRY_INTERVAL_MS,
  ]);
});

test("one-second entry monitor does not confirm while the live spread is too wide", async () => {
  let clock = 0;
  const result = await monitorScalpOneSecondEntryPoint({
    side: "long",
    referencePrice: 100,
    atrPercent: 0.1,
    fetchPrice: async () => null,
    fetchSample: async () => ({
      price: 100.01,
      bid: 99.9,
      ask: 100.1,
      volume: 1,
      observedAt: clock,
      spreadBps: 20,
    }),
    maxWaitMs: 2_000,
    intervalMs: 1_000,
    now: () => clock,
    wait: async (milliseconds) => { clock += milliseconds; },
  });

  assert.equal(result.status, "expired");
  assert.equal(result.confirmations, 0);
  assert.equal(result.spreadBps, 20);
});

test("one-second entry monitor rejects strongly opposing aggressive trade flow", async () => {
  let clock = 0;
  const result = await monitorScalpOneSecondEntryPoint({
    side: "long",
    referencePrice: 100,
    atrPercent: 0.1,
    fetchPrice: async () => null,
    fetchSample: async () => ({
      price: 100.01,
      bid: 100,
      ask: 100.01,
      volume: 1,
      observedAt: clock,
      spreadBps: 1,
      tradeImbalance: -0.8,
      tradeCount: 50,
    }),
    maxWaitMs: 2_000,
    intervalMs: 1_000,
    now: () => clock,
    wait: async (milliseconds) => { clock += milliseconds; },
  });

  assert.equal(result.status, "expired");
  assert.equal(result.confirmations, 0);
  assert.equal(result.tradeImbalance, -0.8);
});

test("scalp monitor journals the v8 path, uses real indicators, learned risk, and conservative fees", async () => {
  const points = qualifyingRangePoints();
  const base = createConfig();
  const config = createConfig({
    settings: { ...base.settings, scalpModeEnabled: true },
    params: { ...base.params, trendWindow: 24 },
  });
  const candidates: ScalpCandidate[] = [];
  let labelCalls = 0;
  let routedSignal: PerpsAgentSignal | null = null;

  const result = await runAutonomousPerpsMonitor({
    listConfigs: async () => [config],
    listSessions: async () => [createSession()],
    getRuntimeOverride: async () => ({ killSwitchOverride: false, updatedAt: new Date().toISOString() }),
    fetchCandles: async () => points,
    fetchLivePrice: async () => points.at(-1)?.v ?? null,
    fetchSnapshot: async () => ({ positions: [], pendingTriggers: [], recentTrades: [] }),
    getUsdcBalance: async () => 100,
    routeSignal: (async (_wallet: string, signal: PerpsAgentSignal) => {
      routedSignal = signal;
      return {
        ok: true,
        message: "submitted",
        execution: { executionId: "execution-v8", decisionId: "decision-v8", status: "submitted" },
      };
    }) as unknown as RouteSignal,
    reconcileNoOpenPosition: async () => [],
    getAgentWallet: () => "agent-wallet",
    isWalletAllowed: () => true,
    getLearningProfile: async () => qualifyingRangeLearningProfile(),
    getClosedScalpOutcomes: async () => [],
    saveScalpCandidate: createCandidateRecorder(candidates),
    labelMatureScalpCandidates: (async () => {
      labelCalls += 1;
      return [];
    }) as never,
    getScalpCircuitDecision: (async () => ({ allowed: true, reasons: [], state: null })) as never,
    readLastSignal: async () => null,
    writeLastSignal: async () => undefined,
  });

  const routed = routedSignal as PerpsAgentSignal | null;
  assert.equal(result.results[0]?.status, "executed");
  assert.equal(routed?.strategyContext?.scalpEntryPath, "breakout-retest");
  assert.equal(routed?.strategyContext?.scalpPolicyVersion, 8);
  assert.equal(routed?.strategyContext?.indicatorScore, 5.5);
  assert.equal(routed?.strategyContext?.indicatorQualified, false);
  assert.equal(routed?.strategyContext?.estimatedRoundTripFeeRate, 0.00205);
  assert.equal(routed?.strategyContext?.indicators?.atrPercent !== null, true);
  assert.ok((routed?.leverage ?? 0) >= 25);
  assert.ok((routed?.leverage ?? Number.POSITIVE_INFINITY) <= 50);
  assert.ok((routed?.collateralUsd ?? Number.POSITIVE_INFINITY) <= 50);
  assert.equal(labelCalls, 1);
  assert.equal(candidates.at(-1)?.disposition, "accepted");
  assert.equal(candidates.at(-1)?.entryPath, "breakout-retest");
  assert.equal(candidates.at(-1)?.executionId, "execution-v8");
});

test("Scalp Agent can route while regular Perps Auto-Trade is off", async () => {
  const points = qualifyingRangePoints();
  const base = createConfig();
  const config = createConfig({
    settings: {
      ...base.settings,
      perpsActiveSlotId: null,
      scalpModeEnabled: true,
      scalpActiveSlotId: "slot-sol",
    },
    params: { ...base.params, trendWindow: 24 },
  });
  let routedStrategy: PerpsAgentSignal["strategyClass"] = undefined;

  const result = await runAutonomousPerpsMonitor({
    listConfigs: async () => [config],
    listSessions: async () => [createSession()],
    getRuntimeOverride: async () => ({ killSwitchOverride: false, updatedAt: new Date().toISOString() }),
    fetchCandles: async () => points,
    fetchSnapshot: async () => ({ positions: [], pendingTriggers: [], recentTrades: [] }),
    getUsdcBalance: async () => 100,
    routeSignal: (async (_wallet: string, signal: PerpsAgentSignal) => {
      routedStrategy = signal.strategyClass;
      return { ok: true, message: "submitted", execution: { status: "submitted" } };
    }) as unknown as RouteSignal,
    reconcileNoOpenPosition: async () => [],
    getAgentWallet: () => "agent-wallet",
    isWalletAllowed: () => true,
    getLearningProfile: async () => qualifyingRangeLearningProfile(),
    getScalpCircuitDecision: (async () => ({ allowed: true, reasons: [], state: null })) as never,
    readLastSignal: async () => null,
    writeLastSignal: async () => undefined,
  });

  assert.equal(result.results[0]?.status, "executed", JSON.stringify(result.results));
  assert.equal(routedStrategy, "scalp");
});

test("Scalp Agent off prevents scalp candidates from being read by regular Perps", async () => {
  const points = qualifyingRangePoints();
  const base = createConfig();
  const config = createConfig({
    settings: {
      ...base.settings,
      scalpModeEnabled: false,
      scalpActiveSlotId: null,
    },
    params: { ...base.params, trendWindow: 24 },
  });
  let candidateWrites = 0;
  let labelCalls = 0;
  const routedStrategies: Array<PerpsAgentSignal["strategyClass"]> = [];

  await runAutonomousPerpsMonitor({
    listConfigs: async () => [config],
    listSessions: async () => [createSession()],
    getRuntimeOverride: async () => ({ killSwitchOverride: false, updatedAt: new Date().toISOString() }),
    fetchCandles: async () => points,
    fetchSnapshot: async () => ({ positions: [], pendingTriggers: [], recentTrades: [] }),
    getUsdcBalance: async () => 100,
    routeSignal: (async (_wallet: string, signal: PerpsAgentSignal) => {
      routedStrategies.push(signal.strategyClass);
      return { ok: true, message: "submitted", execution: { status: "submitted" } };
    }) as unknown as RouteSignal,
    reconcileNoOpenPosition: async () => [],
    getAgentWallet: () => "agent-wallet",
    isWalletAllowed: () => true,
    saveScalpCandidate: (async () => {
      candidateWrites += 1;
      throw new Error("Scalp candidate persistence must remain off.");
    }) as never,
    labelMatureScalpCandidates: (async () => {
      labelCalls += 1;
      return [];
    }) as never,
    getDirectionExperiment: async () => {
      throw new Error("Scalp direction state must remain unread.");
    },
    readLastSignal: async () => null,
    writeLastSignal: async () => undefined,
  });

  assert.equal(candidateWrites, 0);
  assert.equal(labelCalls, 0);
  assert.equal(routedStrategies.includes("scalp"), false);
});

test("regular Perps off prevents Smart signals from being routed by Scalp Agent", async () => {
  const baseTime = 1_784_174_800_000;
  const points = [100, 100.2, 100.4, 100.8, 101.4, 102].map((value, index) => ({
    t: baseTime + index * 60_000,
    v: value,
  }));
  const base = createConfig();
  const config = createConfig({
    settings: {
      ...base.settings,
      perpsActiveSlotId: null,
      scalpModeEnabled: true,
      scalpActiveSlotId: "slot-sol",
    },
  });
  const routedStrategies: Array<PerpsAgentSignal["strategyClass"]> = [];

  await runAutonomousPerpsMonitor({
    listConfigs: async () => [config],
    listSessions: async () => [createSession()],
    getRuntimeOverride: async () => ({ killSwitchOverride: false, updatedAt: new Date().toISOString() }),
    fetchCandles: async () => points,
    fetchSnapshot: async () => ({ positions: [], pendingTriggers: [], recentTrades: [] }),
    getUsdcBalance: async () => 100,
    routeSignal: (async (_wallet: string, signal: PerpsAgentSignal) => {
      routedStrategies.push(signal.strategyClass);
      return { ok: true, message: "submitted", execution: { status: "submitted" } };
    }) as unknown as RouteSignal,
    reconcileNoOpenPosition: async () => [],
    getAgentWallet: () => "agent-wallet",
    isWalletAllowed: () => true,
    readLastSignal: async () => null,
    writeLastSignal: async () => undefined,
  });

  assert.equal(routedStrategies.includes("smart"), false);
});

test("a rejected scalp route does not write a cooldown cursor", async () => {
  const points = qualifyingRangePoints();
  const base = createConfig();
  const config = createConfig({
    settings: { ...base.settings, scalpModeEnabled: true },
    params: { ...base.params, trendWindow: 24 },
  });
  let routeCalls = 0;
  let cursorWrites = 0;

  const result = await runAutonomousPerpsMonitor({
    listConfigs: async () => [config],
    listSessions: async () => [createSession()],
    getRuntimeOverride: async () => ({ killSwitchOverride: false, updatedAt: new Date().toISOString() }),
    fetchCandles: async () => points,
    fetchSnapshot: async () => ({ positions: [], pendingTriggers: [], recentTrades: [] }),
    getUsdcBalance: async () => 100,
    routeSignal: (async () => {
      routeCalls += 1;
      return { ok: false, code: "DECISION_LAYER_SKIP", message: "Rejected before execution." };
    }) as unknown as RouteSignal,
    reconcileNoOpenPosition: async () => [],
    getAgentWallet: () => "agent-wallet",
    isWalletAllowed: () => true,
    getLearningProfile: async () => qualifyingRangeLearningProfile(),
    readLastSignal: async () => null,
    writeLastSignal: async () => { cursorWrites += 1; },
  });

  assert.equal(routeCalls, 1);
  assert.equal(result.results[0]?.code, "DECISION_LAYER_SKIP");
  assert.equal(cursorWrites, 0);
});

test("an adverse one-second tick vetoes a scalp before final one-minute confirmation", async () => {
  const points = qualifyingRangePoints();
  const base = createConfig();
  const config = createConfig({
    settings: { ...base.settings, scalpModeEnabled: true },
    params: { ...base.params, trendWindow: 24 },
  });
  let routeCalls = 0;
  let candleReads = 0;

  const result = await runAutonomousPerpsMonitor({
    listConfigs: async () => [config],
    listSessions: async () => [createSession()],
    getRuntimeOverride: async () => ({ killSwitchOverride: false, updatedAt: new Date().toISOString() }),
    fetchCandles: async () => {
      candleReads += 1;
      return points;
    },
    // The completed-candle context arms monitoring, then the no-cache ticker
    // invalidates the setup before the final one-minute confirmation read.
    fetchLivePrice: async () => 99,
    fetchSnapshot: async () => ({ positions: [], pendingTriggers: [], recentTrades: [] }),
    getUsdcBalance: async () => 100,
    routeSignal: (async () => {
      routeCalls += 1;
      return { ok: true, message: "unexpected" };
    }) as unknown as RouteSignal,
    reconcileNoOpenPosition: async () => [],
    getAgentWallet: () => "agent-wallet",
    isWalletAllowed: () => true,
    getLearningProfile: async () => qualifyingRangeLearningProfile(),
    readLastSignal: async () => null,
    writeLastSignal: async () => undefined,
  });

  assert.equal(candleReads, 1, "an invalid one-second signal must not advance to final confirmation");
  assert.equal(result.results[0]?.code, "SCALP_ADVERSE_ENTRY_DRIFT", JSON.stringify(result.results));
  assert.match(result.results[0]?.message ?? "", /one-second Coinbase entry monitor/i);
  assert.equal(routeCalls, 0);
});

test("a one-second entry signal is followed by final one-minute confirmation before routing", async () => {
  const points = qualifyingRangePoints();
  const base = createConfig();
  const config = createConfig({
    settings: { ...base.settings, scalpModeEnabled: true },
    params: { ...base.params, trendWindow: 24 },
  });
  const events: string[] = [];
  let candleReads = 0;
  let routedSignal: PerpsAgentSignal | null = null;

  const result = await runAutonomousPerpsMonitor({
    listConfigs: async () => [config],
    listSessions: async () => [createSession()],
    getRuntimeOverride: async () => ({ killSwitchOverride: false, updatedAt: new Date().toISOString() }),
    fetchCandles: async () => {
      candleReads += 1;
      events.push(candleReads === 1 ? "one-minute-context" : "one-minute-final-confirmation");
      return points;
    },
    monitorScalpEntryPoint: async (options) => {
      events.push("one-second-entry-trigger");
      return {
        status: "triggered",
        price: options.referencePrice + 0.01,
        observedAt: 1_784_178_401_000,
        samples: 2,
        evaluation: evaluateScalpOneSecondEntryPoint({
          side: options.side,
          referencePrice: options.referencePrice,
          livePrice: options.referencePrice + 0.01,
          atrPercent: options.atrPercent,
        }),
      };
    },
    fetchLivePrice: async () => {
      events.push("final-live-price");
      return points.at(-1)!.v + 0.01;
    },
    fetchSnapshot: async () => ({ positions: [], pendingTriggers: [], recentTrades: [] }),
    getUsdcBalance: async () => 100,
    routeSignal: (async (_wallet: string, signal: PerpsAgentSignal) => {
      events.push("route");
      routedSignal = signal;
      return { ok: true, message: "submitted", execution: { status: "submitted" } };
    }) as unknown as RouteSignal,
    reconcileNoOpenPosition: async () => [],
    getAgentWallet: () => "agent-wallet",
    isWalletAllowed: () => true,
    getLearningProfile: async () => qualifyingRangeLearningProfile(),
    readLastSignal: async () => null,
    writeLastSignal: async () => undefined,
  });

  assert.equal(result.results[0]?.status, "executed", JSON.stringify(result.results));
  assert.deepEqual(events, [
    "one-minute-context",
    "one-second-entry-trigger",
    "one-minute-final-confirmation",
    "final-live-price",
    "route",
  ]);
  const routed = routedSignal as PerpsAgentSignal | null;
  assert.equal(routed?.marketContext?.spotPrice, points.at(-1)!.v + 0.01);
  assert.ok(routed?.strategyContext?.priceActionTags?.includes("ONE_SECOND_ENTRY_TRIGGER"));
  assert.ok(routed?.strategyContext?.priceActionTags?.includes("ONE_MINUTE_FINAL_CONFIRMATION"));
  assert.match(routed?.summary ?? "", /one-second entry trigger.*final one-minute confirmation passed/i);
});

test("a one-second entry signal cannot route when final one-minute confirmation fails", async () => {
  const points = qualifyingRangePoints();
  const flatPoints = points.map((point) => ({
    ...point,
    o: 100,
    h: 100.01,
    l: 99.99,
    v: 100,
    volume: 100,
  }));
  const base = createConfig();
  const config = createConfig({
    settings: { ...base.settings, scalpModeEnabled: true },
    params: { ...base.params, trendWindow: 24 },
  });
  let candleReads = 0;
  let routeCalls = 0;

  const result = await runAutonomousPerpsMonitor({
    listConfigs: async () => [config],
    listSessions: async () => [createSession()],
    getRuntimeOverride: async () => ({ killSwitchOverride: false, updatedAt: new Date().toISOString() }),
    fetchCandles: async () => (++candleReads === 1 ? points : flatPoints),
    monitorScalpEntryPoint: async (options) => ({
      status: "triggered",
      price: options.referencePrice + 0.01,
      observedAt: 1_784_178_401_000,
      samples: 1,
      evaluation: evaluateScalpOneSecondEntryPoint({
        side: options.side,
        referencePrice: options.referencePrice,
        livePrice: options.referencePrice + 0.01,
        atrPercent: options.atrPercent,
      }),
    }),
    fetchSnapshot: async () => ({ positions: [], pendingTriggers: [], recentTrades: [] }),
    getUsdcBalance: async () => 100,
    routeSignal: (async () => {
      routeCalls += 1;
      return { ok: true, message: "unexpected" };
    }) as unknown as RouteSignal,
    reconcileNoOpenPosition: async () => [],
    getAgentWallet: () => "agent-wallet",
    isWalletAllowed: () => true,
    getLearningProfile: async () => qualifyingRangeLearningProfile(),
    readLastSignal: async () => null,
    writeLastSignal: async () => undefined,
  });

  assert.equal(candleReads, 2);
  assert.equal(routeCalls, 0);
  assert.equal(result.results[0]?.code, "SCALP_REVALIDATION_FAILED", JSON.stringify(result.results));
});

test("scalp circuit ingests only positions opened after the v8 rollout and blocks the affected path", async () => {
  const points = qualifyingRangePoints();
  const base = createConfig();
  const config = createConfig({
    settings: { ...base.settings, scalpModeEnabled: true },
    params: { ...base.params, trendWindow: 24 },
  });
  const profile = qualifyingRangeLearningProfile();
  profile.scalpProfile!.policyRollout = {
    ...profile.scalpProfile!.policyRollout!,
    startedAt: "2026-07-16T03:00:00.000Z",
  };
  const outcome = (outcomeId: string, openedAt: string): TradeLearningOutcome => ({
    outcomeId,
    openedAt,
    closedAt: new Date(points.at(-1)!.t - 8 * 60_000).toISOString(),
    signalType: "scalp",
    scalpSetupType: "v-reversal",
    scalpEntryPath: "breakout-retest",
    priceActionTags: ["PRICE_BREAKOUT_RETEST"],
    netPnlUsd: -2,
    feesUsd: 1,
    sizeUsd: 500,
  }) as TradeLearningOutcome;
  const recorded: string[] = [];
  let routeCalls = 0;

  const result = await runAutonomousPerpsMonitor({
    listConfigs: async () => [config],
    listSessions: async () => [createSession()],
    getRuntimeOverride: async () => ({ killSwitchOverride: false, updatedAt: new Date().toISOString() }),
    fetchCandles: async () => points,
    fetchSnapshot: async () => ({ positions: [], pendingTriggers: [], recentTrades: [] }),
    getUsdcBalance: async () => 100,
    routeSignal: (async () => {
      routeCalls += 1;
      return { ok: true, message: "unexpected" };
    }) as unknown as RouteSignal,
    reconcileNoOpenPosition: async () => [],
    getAgentWallet: () => "agent-wallet",
    isWalletAllowed: () => true,
    getLearningProfile: async () => profile,
    getClosedScalpOutcomes: async () => [
      outcome("legacy-v7", "2026-07-16T02:59:00.000Z"),
      outcome("policy-v8", "2026-07-16T03:01:00.000Z"),
    ],
    recordScalpCircuitOutcomes: (async (input: { outcomes: Array<{ outcomeId: string }> }) => {
      recorded.push(...input.outcomes.map((outcome) => outcome.outcomeId));
      return null;
    }) as never,
    getScalpCircuitDecision: (async () => ({
      allowed: false,
      reasons: ["breakout-retest disabled after 2 consecutive post-fee losses on that entry path."],
      state: null,
    })) as never,
    saveScalpCandidate: createCandidateRecorder([]),
    labelMatureScalpCandidates: (async () => []) as never,
    readLastSignal: async () => null,
    writeLastSignal: async () => undefined,
  });

  assert.deepEqual(recorded, ["policy-v8"]);
  assert.equal(routeCalls, 0);
  assert.equal(result.results[0]?.code, "SCALP_CIRCUIT_OPEN");
});

test("set-parameters monitoring persists one stable v8 rollout boundary before circuit accounting", async () => {
  const base = createConfig();
  const config = createConfig({
    settings: { ...base.settings, scalpModeEnabled: true, perpsExecutionMode: "set-parameters" },
  });
  const points = Array.from({ length: 70 }, (_, index) => ({
    t: 1_784_174_800_000 + index * 60_000,
    o: 100,
    h: 100.01,
    l: 99.99,
    v: 100,
    volume: 100,
  }));
  let persistedProfile = qualifyingRangeLearningProfile();
  persistedProfile.scalpProfile!.policyVersion = 7;
  persistedProfile.scalpProfile!.policyRollout = null;
  const originalSmartConfidence = persistedProfile.minimumConfidence;
  let migrationWrites = 0;
  let authoritativeScalpTrainingRuns = 0;
  let fallbackProfileReads = 0;
  let reconciliationComplete = false;
  const observedRolloutBoundaries: string[] = [];
  const circuitBatches: string[][] = [];
  const postRolloutOutcome = {
    outcomeId: "stable-v8-outcome",
    openedAt: "2026-08-19T12:01:00.000Z",
    closedAt: "2026-08-19T12:05:00.000Z",
    signalType: "scalp",
    scalpSetupType: "v-reversal",
    scalpEntryPath: "continuation",
    netPnlUsd: 1,
  } as TradeLearningOutcome;
  let authoritativeOutcomes = [postRolloutOutcome];

  const run = () => runAutonomousPerpsMonitor({
    listConfigs: async () => [config],
    listSessions: async () => [createSession()],
    getRuntimeOverride: async () => ({ killSwitchOverride: false, updatedAt: new Date().toISOString() }),
    fetchCandles: async () => points,
    fetchSnapshot: async () => ({ positions: [], pendingTriggers: [], recentTrades: [] }),
    getUsdcBalance: async () => 100,
    getAgentWallet: () => "agent-wallet",
    isWalletAllowed: () => true,
    getLearningProfile: async () => {
      fallbackProfileReads += 1;
      return persistedProfile;
    },
    reconcileLearningHistory: async () => {
      reconciliationComplete = true;
      return 0;
    },
    ensureScalpPolicyProfile: async () => {
      if (persistedProfile.scalpProfile?.policyVersion !== 8) {
        migrationWrites += 1;
        const migrated = qualifyingRangeLearningProfile();
        migrated.minimumConfidence = persistedProfile.minimumConfidence;
        migrated.scalpProfile!.policyRollout!.startedAt = "2026-08-19T12:00:00.000Z";
        persistedProfile = migrated;
      }
      return persistedProfile;
    },
    autoTrain: async () => {
      authoritativeScalpTrainingRuns += 1;
    },
    getClosedScalpOutcomes: async () => {
      assert.equal(reconciliationComplete, true);
      return authoritativeOutcomes;
    },
    recordScalpCircuitOutcomes: (async (input: { outcomes: Array<{ outcomeId: string }> }) => {
      observedRolloutBoundaries.push(persistedProfile.scalpProfile!.policyRollout!.startedAt);
      circuitBatches.push(input.outcomes.map((outcome) => outcome.outcomeId));
      return null;
    }) as never,
    reconcileNoOpenPosition: async () => [],
    readLastSignal: async () => null,
    writeLastSignal: async () => undefined,
  });

  await run();
  authoritativeOutcomes = [{
    ...postRolloutOutcome,
    outcomeId: "late-reconciled-older-loss",
    closedAt: "2026-08-19T12:03:00.000Z",
    netPnlUsd: -2,
  }, postRolloutOutcome];
  await run();

  assert.equal(migrationWrites, 1);
  assert.equal(authoritativeScalpTrainingRuns, 2);
  assert.equal(fallbackProfileReads, 0);
  assert.equal(persistedProfile.minimumConfidence, originalSmartConfidence);
  assert.deepEqual(observedRolloutBoundaries, [
    "2026-08-19T12:00:00.000Z",
    "2026-08-19T12:00:00.000Z",
  ]);
  assert.deepEqual(circuitBatches, [
    ["stable-v8-outcome"],
    ["late-reconciled-older-loss", "stable-v8-outcome"],
  ]);
});

test("set-parameters scalp learning fails closed when its authoritative updater fails", async () => {
  const base = createConfig();
  const config = createConfig({
    settings: { ...base.settings, scalpModeEnabled: true, perpsExecutionMode: "set-parameters" },
  });
  let routeCalls = 0;
  const result = await runAutonomousPerpsMonitor({
    listConfigs: async () => [config],
    listSessions: async () => [createSession()],
    getRuntimeOverride: async () => ({ killSwitchOverride: false, updatedAt: new Date().toISOString() }),
    fetchSnapshot: async () => ({ positions: [], pendingTriggers: [], recentTrades: [] }),
    getUsdcBalance: async () => 100,
    getAgentWallet: () => "agent-wallet",
    isWalletAllowed: () => true,
    ensureScalpPolicyProfile: async () => qualifyingRangeLearningProfile(),
    autoTrain: async () => {
      throw new Error("authoritative scalp profile write failed");
    },
    routeSignal: (async () => {
      routeCalls += 1;
      return { ok: true, message: "unexpected" };
    }) as unknown as RouteSignal,
  });

  assert.equal(result.results[0]?.status, "failed");
  assert.match(result.results[0]?.message ?? "", /authoritative scalp profile write failed/);
  assert.equal(routeCalls, 0);
});

test("scalp admission fails closed when the authoritative circuit outcome batch cannot be persisted", async () => {
  const base = createConfig();
  const config = createConfig({ settings: { ...base.settings, scalpModeEnabled: true } });
  let routeCalls = 0;
  const candidates: ScalpCandidate[] = [];
  const result = await runAutonomousPerpsMonitor({
    listConfigs: async () => [config],
    listSessions: async () => [createSession()],
    getRuntimeOverride: async () => ({ killSwitchOverride: false, updatedAt: new Date().toISOString() }),
    fetchCandles: async () => qualifyingRangePoints(),
    fetchSnapshot: async () => ({ positions: [], pendingTriggers: [], recentTrades: [] }),
    getUsdcBalance: async () => 100,
    getAgentWallet: () => "agent-wallet",
    isWalletAllowed: () => true,
    ensureScalpPolicyProfile: async () => qualifyingRangeLearningProfile(),
    getClosedScalpOutcomes: async () => [{
      outcomeId: "checkpoint-failure-outcome",
      openedAt: "2026-08-19T12:01:00.000Z",
      closedAt: "2026-08-19T12:05:00.000Z",
      signalType: "scalp",
      scalpSetupType: "v-reversal",
      netPnlUsd: -1,
    } as TradeLearningOutcome],
    recordScalpCircuitOutcomes: (async () => {
      throw new Error("circuit Redis unavailable");
    }) as never,
    saveScalpCandidate: createCandidateRecorder(candidates),
    labelMatureScalpCandidates: (async () => []) as never,
    routeSignal: (async () => {
      routeCalls += 1;
      return { ok: true, message: "unexpected" };
    }) as unknown as RouteSignal,
  });

  assert.equal(result.results[0]?.status, "failed");
  assert.equal(result.results[0]?.code, "SCALP_CIRCUIT_RECONCILIATION_FAILED");
  assert.match(result.results[0]?.message ?? "", /circuit Redis unavailable/);
  assert.match(candidates.at(-1)?.rejectionReasons.at(-1) ?? "", /SYSTEM_HEALTH_BLOCKED/);
  assert.ok(candidates.at(-1)?.tags.includes("SYSTEM_HEALTH_BLOCKED"));
  assert.equal(routeCalls, 0);
});

test("scalp admission requires a complete paginated Jupiter trade history", async () => {
  assert.throws(() => mergeCompleteJupiterTradeHistoryForLearning(
    {
      positions: [],
      pendingTriggers: [],
      recentTrades: [],
      readEvidence: {
        liveApiSucceeded: true,
        rpcSucceeded: true,
        authoritativePositionAbsence: true,
      },
    },
    { trades: [], totalCount: 3, complete: false }
  ), /only 0 of 3 trades/);

  const base = createConfig();
  const config = createConfig({ settings: { ...base.settings, scalpModeEnabled: true } });
  let routed = 0;
  let requiredCompleteHistory = false;
  const result = await runAutonomousPerpsMonitor({
    listConfigs: async () => [config],
    listSessions: async () => [createSession()],
    getRuntimeOverride: async () => ({ killSwitchOverride: false, updatedAt: new Date().toISOString() }),
    fetchSnapshot: async () => ({ positions: [], pendingTriggers: [], recentTrades: [] }),
    getUsdcBalance: async () => 100,
    getAgentWallet: () => "agent-wallet",
    isWalletAllowed: () => true,
    reconcileLearningHistory: async (_wallet, _snapshot, options) => {
      requiredCompleteHistory = options?.requireCompleteTradeHistory === true;
      throw new Error("Jupiter trade history pagination failed");
    },
    routeSignal: (async () => {
      routed += 1;
      return { ok: true, message: "unexpected" };
    }) as unknown as RouteSignal,
  });

  assert.equal(requiredCompleteHistory, true);
  assert.equal(result.results[0]?.status, "failed");
  assert.match(result.results[0]?.message ?? "", /pagination failed/);
  assert.equal(routed, 0);
});

test("monitor does not route an exceptional reversal missing structural persistence after a profitable cooldown", async () => {
  const points = exceptionalBullishSweepPoints();
  const latestTimestamp = points.at(-1)!.t;
  const lastSignalAt = latestTimestamp - 12 * 60_000;
  let routedSignal: PerpsAgentSignal | null = null;
  const base = createConfig();
  const config = createConfig({
    settings: {
      ...base.settings,
      perpsLeverage: 10,
      scalpModeEnabled: true,
      stopLossPercent: 25,
    },
    params: {
      ...base.params,
      trendWindow: 24,
    },
  });

  const result = await runAutonomousPerpsMonitor({
    listConfigs: async () => [config],
    listSessions: async () => [createSession()],
    getRuntimeOverride: async () => ({ killSwitchOverride: false, updatedAt: new Date().toISOString() }),
    fetchCandles: async () => points,
    fetchSnapshot: async () => ({ positions: [], pendingTriggers: [], recentTrades: [] }),
    getUsdcBalance: async () => 100,
    routeSignal: (async (_wallet: string, signal: PerpsAgentSignal) => {
      routedSignal = signal;
      return { ok: true, message: "submitted", execution: { status: "submitted" } };
    }) as unknown as RouteSignal,
    reconcileNoOpenPosition: async () => [],
    getAgentWallet: () => "agent-wallet",
    isWalletAllowed: () => true,
    getLatestClosedOutcome: async () => ({
      openedAt: new Date(lastSignalAt + 30_000).toISOString(),
      closedAt: new Date(latestTimestamp - SCALP_SIGNAL_COOLDOWN_SECONDS * 1_000).toISOString(),
      side: "short",
      netPnlUsd: 3.5,
    }) as never,
    readLastSignal: async (_wallet, _asset, strategyClass) => strategyClass === "scalp" ? lastSignalAt : null,
    writeLastSignal: async () => undefined,
  });

  assert.equal(result.results[0]?.status, "skipped");
  assert.equal(result.results[0]?.code, "NO_SIGNAL");
  assert.equal(routedSignal, null);
});

test("policy v8 cancels a stale opposite-direction experiment and routes the detector direction", async () => {
  const points = qualifyingRangePoints();
  let routedSignal: PerpsAgentSignal | null = null;
  let recordedTrades = 0;
  let cancelledExperiments = 0;
  const base = createConfig();
  const config = createConfig({
    settings: { ...base.settings, scalpModeEnabled: true },
    params: { ...base.params, trendWindow: 24 },
  });

  const result = await runAutonomousPerpsMonitor({
    listConfigs: async () => [config],
    listSessions: async () => [createSession()],
    getRuntimeOverride: async () => ({ killSwitchOverride: false, updatedAt: new Date().toISOString() }),
    fetchCandles: async () => points,
    fetchSnapshot: async () => ({ positions: [], pendingTriggers: [], recentTrades: [] }),
    getUsdcBalance: async () => 100,
    routeSignal: (async (_wallet: string, signal: PerpsAgentSignal) => {
      routedSignal = signal;
      return { ok: true, message: "submitted", execution: { status: "submitted" } };
    }) as unknown as RouteSignal,
    reconcileNoOpenPosition: async () => [],
    getAgentWallet: () => "agent-wallet",
    isWalletAllowed: () => true,
    getLearningProfile: async () => qualifyingRangeLearningProfile(),
    readLastSignal: async () => null,
    writeLastSignal: async () => undefined,
    getDirectionExperiment: async () => ({
      experimentId: "inverse-test",
      baselineProfileId: "baseline-test",
      enabled: true,
      maxTrades: 3,
      tradesCompleted: 0,
      tradesRemaining: 3,
      startedAt: new Date().toISOString(),
      completedAt: null,
    }),
    cancelDirectionExperiment: async () => {
      cancelledExperiments += 1;
      return {
        experimentId: "inverse-test",
        baselineProfileId: "baseline-test",
        enabled: false,
        maxTrades: 3,
        tradesCompleted: 0,
        tradesRemaining: 0,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      };
    },
    recordDirectionExperimentTrade: async () => {
      recordedTrades += 1;
      return null;
    },
  });

  const routed = routedSignal as PerpsAgentSignal | null;
  const entry = routed?.marketContext?.spotPrice ?? 0;
  assert.equal(routed?.strategyClass, "scalp", JSON.stringify(result.results[0]));
  assert.equal(routed?.direction, "bullish");
  assert.equal(routed?.strategyContext?.detectedDirection, undefined);
  assert.equal(routed?.strategyContext?.directionInverted, undefined);
  assert.equal(routed?.strategyContext?.directionExperimentId, undefined);
  assert.equal(routed?.strategyContext?.directionExperimentTradeNumber, undefined);
  assert.ok((routed?.takeProfitPrice ?? 0) > entry);
  assert.ok((routed?.stopLossPrice ?? Number.POSITIVE_INFINITY) < entry);
  assert.equal(cancelledExperiments, 1, JSON.stringify(result.results[0]));
  assert.equal(recordedTrades, 0);
  assert.equal(result.results[0]?.status, "executed", JSON.stringify(result.results[0]));
});

test("a stale v8 direction experiment cannot trigger the decision-veto cooldown deadlock", async () => {
  const points = qualifyingRangePoints();
  let recordedTrades = 0;
  let cursorWrites = 0;
  let cancelledExperiments = 0;
  const base = createConfig();
  const config = createConfig({
    settings: { ...base.settings, scalpModeEnabled: true },
    params: { ...base.params, trendWindow: 24 },
  });

  const result = await runAutonomousPerpsMonitor({
    listConfigs: async () => [config],
    listSessions: async () => [createSession()],
    getRuntimeOverride: async () => ({ killSwitchOverride: false, updatedAt: new Date().toISOString() }),
    fetchCandles: async () => points,
    fetchSnapshot: async () => ({ positions: [], pendingTriggers: [], recentTrades: [] }),
    getUsdcBalance: async () => 100,
    routeSignal: (async (_wallet: string, signal: PerpsAgentSignal) => (
      signal.strategyContext?.directionInverted
        ? { ok: false, code: "DECISION_LAYER_SKIP", message: "Directional indicators vetoed the inverted experiment." }
        : { ok: true, message: "normal detector direction submitted", execution: { status: "submitted" } }
    )) as unknown as RouteSignal,
    reconcileNoOpenPosition: async () => [],
    getAgentWallet: () => "agent-wallet",
    isWalletAllowed: () => true,
    getLearningProfile: async () => qualifyingRangeLearningProfile(),
    readLastSignal: async () => null,
    writeLastSignal: async () => { cursorWrites += 1; },
    getDirectionExperiment: async () => ({
      experimentId: "inverse-test",
      baselineProfileId: "baseline-test",
      enabled: true,
      maxTrades: 3,
      tradesCompleted: 0,
      tradesRemaining: 3,
      startedAt: new Date().toISOString(),
      completedAt: null,
    }),
    cancelDirectionExperiment: async () => {
      cancelledExperiments += 1;
      return null;
    },
    recordDirectionExperimentTrade: async () => {
      recordedTrades += 1;
      return null;
    },
  });

  assert.equal(cancelledExperiments, 1);
  assert.equal(recordedTrades, 0);
  assert.equal(cursorWrites, 0, JSON.stringify(result.results[0]));
  assert.equal(result.results[0]?.status, "executed", JSON.stringify(result.results[0]));
});

test("monitor pauses scalp entries while the winner-derived profile fails validation", async () => {
  const points = exceptionalBullishSweepPoints();
  const base = createConfig();
  const config = createConfig({
    settings: {
      ...base.settings,
      scalpModeEnabled: true,
    },
    params: {
      ...base.params,
      trendWindow: 24,
    },
  });
  const profile = createLearningProfile();
  profile.scalpProfile = structuredClone(DEFAULT_SCALP_LEARNING_PROFILE);
  profile.scalpProfile.validation = {
    ...profile.scalpProfile.validation,
    passed: false,
    reasons: ["Loss-history validation failed."],
  };
  profile.scalpProfile.policyRollout = {
    status: "paused",
    startedAt: "2026-08-19T12:00:00.000Z",
    timeoutStartedAt: "2099-08-19T12:00:00.000Z",
    timeoutExpiresAt: "2099-08-19T12:30:00.000Z",
    baselineOutcomeCount: 0,
    reviewedOutcomeCount: 10,
    minimumValidationTrades: 10,
    liveTradingAuthorized: false,
    authorization: "operator-approved-live-rollout",
    reason: "Loss-history validation failed.",
  };
  let routeCalls = 0;

  const result = await runAutonomousPerpsMonitor({
    listConfigs: async () => [config],
    listSessions: async () => [createSession()],
    getRuntimeOverride: async () => ({ killSwitchOverride: false, updatedAt: new Date().toISOString() }),
    fetchCandles: async () => points,
    fetchSnapshot: async () => ({ positions: [], pendingTriggers: [], recentTrades: [] }),
    getUsdcBalance: async () => 100,
    routeSignal: (async () => {
      routeCalls += 1;
      return { ok: true, message: "unexpected" };
    }) as unknown as RouteSignal,
    reconcileNoOpenPosition: async () => [],
    getAgentWallet: () => "agent-wallet",
    isWalletAllowed: () => true,
    getLearningProfile: async () => profile,
    reconcileLearningHistory: async () => 0,
    autoTrain: async () => undefined,
    readLastSignal: async () => null,
    writeLastSignal: async () => undefined,
  });

  assert.equal(routeCalls, 0);
  assert.equal(result.results[0]?.code, "SCALP_VALIDATION_PAUSED");
  assert.match(result.results[0]?.message ?? "", /winner-derived profile/i);
});

test("a successfully taken smart trade leaves Scalp Mode enabled", async () => {
  let disabledWallet: string | null = null;
  let routedStrategy: PerpsAgentSignal["strategyClass"] = undefined;
  const baseTime = 1_784_174_800_000;
  const points = [100, 100.2, 100.4, 100.8, 101.4, 102].map((value, index) => ({
    t: baseTime + index * 60_000,
    v: value,
  }));
  const base = createConfig();
  const config = createConfig({ settings: { ...base.settings, scalpModeEnabled: true } });

  const result = await runAutonomousPerpsMonitor({
    listConfigs: async () => [config],
    listSessions: async () => [createSession()],
    getRuntimeOverride: async () => ({ killSwitchOverride: false, updatedAt: new Date().toISOString() }),
    fetchCandles: async () => points,
    fetchSnapshot: async () => ({ positions: [], pendingTriggers: [], recentTrades: [] }),
    getUsdcBalance: async () => 100,
    routeSignal: (async (_wallet: string, signal: PerpsAgentSignal) => {
      routedStrategy = signal.strategyClass;
      return { ok: true, message: "submitted", execution: { status: "submitted" } };
    }) as unknown as RouteSignal,
    reconcileNoOpenPosition: async () => [],
    getAgentWallet: () => "agent-wallet",
    isWalletAllowed: () => true,
    disableScalpMode: async (address) => {
      disabledWallet = address;
      return null;
    },
    readLastSignal: async () => null,
    writeLastSignal: async () => undefined,
  });

  assert.equal(result.results[0]?.status, "executed", JSON.stringify(result.results[0]));
  assert.equal(disabledWallet, null);
  assert.equal(routedStrategy, "smart");
});

test("a stale v8 direction experiment cannot suppress an otherwise eligible Smart entry", async () => {
  let routeCalls = 0;
  let disableCalls = 0;
  let cancelCalls = 0;
  const baseTime = 1_784_174_800_000;
  const points = [100, 100.2, 100.4, 100.8, 101.4, 102].map((value, index) => ({
    t: baseTime + index * 60_000,
    v: value,
  }));
  const base = createConfig();
  const config = createConfig({ settings: { ...base.settings, scalpModeEnabled: true } });

  const result = await runAutonomousPerpsMonitor({
    listConfigs: async () => [config],
    listSessions: async () => [createSession()],
    getRuntimeOverride: async () => ({ killSwitchOverride: false, updatedAt: new Date().toISOString() }),
    fetchCandles: async () => points,
    fetchSnapshot: async () => ({ positions: [], pendingTriggers: [], recentTrades: [] }),
    getUsdcBalance: async () => 100,
    routeSignal: (async () => {
      routeCalls += 1;
      return { ok: true, message: "unexpected" };
    }) as unknown as RouteSignal,
    reconcileNoOpenPosition: async () => [],
    getAgentWallet: () => "agent-wallet",
    isWalletAllowed: () => true,
    disableScalpMode: async () => {
      disableCalls += 1;
      return null;
    },
    readLastSignal: async () => null,
    writeLastSignal: async () => undefined,
    getDirectionExperiment: async () => ({
      experimentId: "inverse-test",
      baselineProfileId: "baseline-test",
      enabled: true,
      maxTrades: 3,
      tradesCompleted: 0,
      tradesRemaining: 3,
      startedAt: new Date().toISOString(),
      completedAt: null,
    }),
    cancelDirectionExperiment: async () => {
      cancelCalls += 1;
      return null;
    },
  });

  assert.equal(result.results[0]?.status, "executed");
  assert.equal(routeCalls, 1);
  assert.equal(disableCalls, 0);
  assert.equal(cancelCalls, 1);
});

test("a generated smart signal that is skipped leaves Scalp Mode enabled", async () => {
  let disableCalls = 0;
  const baseTime = 1_784_174_800_000;
  const points = [100, 100.2, 100.4, 100.8, 101.4, 102].map((value, index) => ({
    t: baseTime + index * 60_000,
    v: value,
  }));
  const base = createConfig();
  const config = createConfig({ settings: { ...base.settings, scalpModeEnabled: true } });

  const result = await runAutonomousPerpsMonitor({
    listConfigs: async () => [config],
    listSessions: async () => [createSession()],
    getRuntimeOverride: async () => ({ killSwitchOverride: false, updatedAt: new Date().toISOString() }),
    fetchCandles: async () => points,
    fetchSnapshot: async () => ({ positions: [], pendingTriggers: [], recentTrades: [] }),
    getUsdcBalance: async () => 100,
    routeSignal: (async () => ({
      ok: false,
      code: "DECISION_LAYER_SKIP",
      message: "The smart signal was skipped.",
    })) as unknown as RouteSignal,
    reconcileNoOpenPosition: async () => [],
    getAgentWallet: () => "agent-wallet",
    isWalletAllowed: () => true,
    disableScalpMode: async () => {
      disableCalls += 1;
      return null;
    },
    readLastSignal: async () => null,
    writeLastSignal: async () => undefined,
  });

  assert.equal(result.results[0]?.status, "skipped");
  assert.equal(result.results[0]?.code, "DECISION_LAYER_SKIP");
  assert.equal(disableCalls, 0);
});

test("a rejected Smart signal cursor cannot start a cooldown", async () => {
  let disableCalls = 0;
  let routeCalls = 0;
  const baseTime = 1_784_174_800_000;
  const points = [100, 100.2, 100.4, 100.8, 101.4, 102].map((value, index) => ({
    t: baseTime + index * 60_000,
    v: value,
  }));
  const base = createConfig();
  const config = createConfig({ settings: { ...base.settings, scalpModeEnabled: true } });

  const result = await runAutonomousPerpsMonitor({
    listConfigs: async () => [config],
    listSessions: async () => [createSession()],
    getRuntimeOverride: async () => ({ killSwitchOverride: false, updatedAt: new Date().toISOString() }),
    fetchCandles: async () => points,
    fetchSnapshot: async () => ({ positions: [], pendingTriggers: [], recentTrades: [] }),
    getUsdcBalance: async () => 100,
    routeSignal: (async () => {
      routeCalls += 1;
      return { ok: true, message: "unexpected" };
    }) as unknown as RouteSignal,
    reconcileNoOpenPosition: async () => [],
    getAgentWallet: () => "agent-wallet",
    isWalletAllowed: () => true,
    disableScalpMode: async () => {
      disableCalls += 1;
      return null;
    },
    readLastSignal: async () => points[points.length - 1]!.t,
    writeLastSignal: async () => undefined,
  });

  assert.equal(result.results[0]?.status, "executed");
  assert.equal(routeCalls, 1);
  assert.equal(disableCalls, 0);
});

test("a completed trade close starts the shared seven-minute Smart and scalp cooldown", async () => {
  let routeCalls = 0;
  const baseTime = 1_784_174_800_000;
  const points = [100, 100.2, 100.4, 100.8, 101.4, 102].map((value, index) => ({
    t: baseTime + index * 60_000,
    v: value,
  }));
  const latestTimestamp = points.at(-1)!.t;
  const base = createConfig();
  const config = createConfig({ settings: { ...base.settings, scalpModeEnabled: true } });

  const result = await runAutonomousPerpsMonitor({
    listConfigs: async () => [config],
    listSessions: async () => [createSession()],
    getRuntimeOverride: async () => ({ killSwitchOverride: false, updatedAt: new Date().toISOString() }),
    fetchCandles: async () => points,
    fetchSnapshot: async () => ({ positions: [], pendingTriggers: [], recentTrades: [] }),
    getUsdcBalance: async () => 100,
    routeSignal: (async () => {
      routeCalls += 1;
      return { ok: true, message: "unexpected" };
    }) as unknown as RouteSignal,
    reconcileNoOpenPosition: async () => [],
    getAgentWallet: () => "agent-wallet",
    isWalletAllowed: () => true,
    getLatestClosedOutcome: async () => ({
      openedAt: new Date(latestTimestamp - 10 * 60_000).toISOString(),
      closedAt: new Date(latestTimestamp - 60_000).toISOString(),
      side: "long",
      netPnlUsd: 0.5,
    }) as never,
  });

  assert.equal(result.results[0]?.code, "SMART_SIGNAL_COOLDOWN");
  assert.match(result.results[0]?.message ?? "", /seven-minute post-close cooldown/i);
  assert.equal(routeCalls, 0);
});

function createSession(): PerpsAutomationSession {
  return {
    sessionId: "session-1",
    walletAddress,
    sessionState: "clocked_in",
    startedAt: new Date().toISOString(),
    lastHeartbeatAt: new Date().toISOString(),
    inactiveSince: null,
    endedAt: null,
    mode: "live",
    executionModel: "delegated-ready",
    appOpen: false,
    appForeground: false,
    walletConnected: false,
    walletWriteEnabled: true,
    killSwitch: false,
    unlimitedSession: true,
    platform: "web",
    walletProvider: "Agent wallet",
    warning: null,
  };
}

function createOpenPosition(
  roePercent: number,
  overrides: Partial<JupiterPerpsPosition> = {}
): JupiterPerpsPosition {
  return {
    id: "live-position-sol",
    source: "live-api",
    platformId: "jupiter-exchange",
    marketSymbol: "SOL",
    marketName: "Solana Perps",
    marketAddress: "market",
    custodyAddress: "custody",
    collateralCustodyAddress: "collateral-custody",
    collateralSymbol: "USDC",
    imageUri: null,
    side: "long",
    entryPrice: 100,
    markPrice: 102,
    positionSize: 2,
    positionValue: 204,
    collateralValue: 100,
    leverage: 2,
    unrealizedPnl: roePercent,
    realizedPnl: null,
    liquidationPrice: 60,
    fundingSnapshot: null,
    borrowSnapshot: null,
    takeProfit: 115,
    stopLoss: 90,
    markPriceIsLive: true,
    liquidationPriceIsEstimated: false,
    accountRef: "position-pubkey",
    lastUpdated: Date.now(),
    ...overrides,
  };
}

function createExecutionEpisode(input: {
  executionId: string;
  positionPubkey: string;
  createdAt: string;
  updatedAt?: string;
  strategyClass?: "smart" | "scalp";
}): PerpsUserExecution {
  return {
    executionId: input.executionId,
    sessionId: "session-1",
    walletAddress,
    signalId: `signal-${input.executionId}`,
    symbol: "SOL/USD",
    summary: "Execution provenance test",
    side: "long",
    asset: "SOL",
    mode: "live",
    executionModel: "delegated-ready",
    status: "confirmed",
    reasonCode: "LIVE_SUBMITTED",
    reasonMessage: "Submitted",
    collateralUsd: 100,
    sizeUsd: 2_000,
    leverage: 20,
    takeProfitPrice: 102,
    stopLossPrice: 98,
    txid: `tx-${input.executionId}`,
    positionPubkey: input.positionPubkey,
    ...(input.strategyClass ? { strategyClass: input.strategyClass } : {}),
    createdAt: input.createdAt,
    updatedAt: input.updatedAt ?? input.createdAt,
  };
}

test("profit-lock provenance selects the newest same-pubkey episode and treats legacy manual entries as smart", () => {
  const oldEpisode = createExecutionEpisode({
    executionId: "old-scalp",
    positionPubkey: "reused-position",
    createdAt: "2026-08-19T10:00:00.000Z",
    // A later reconciliation update must not make this the newer episode.
    updatedAt: "2026-08-19T13:00:00.000Z",
    strategyClass: "scalp",
  });
  const reopenedManualEpisode = createExecutionEpisode({
    executionId: "new-manual",
    positionPubkey: "reused-position",
    createdAt: "2026-08-19T12:00:00.000Z",
  });

  assert.deepEqual(
    resolveProfitLockPositionProvenance([oldEpisode, reopenedManualEpisode], "reused-position"),
    {
      episodeId: "new-manual",
      executionId: "new-manual",
      strategyClass: "smart",
      createdAt: "2026-08-19T12:00:00.000Z",
    }
  );
});

test("profit-lock ROE normalizes only direct-RPC gross PnL", () => {
  const live = createOpenPosition(14.1, { leverage: 20, source: "live-api" });
  const rpc = createOpenPosition(14.1, { leverage: 20, source: "rpc-direct" });

  assert.equal(Number(calculatePerpsPositionNetRoePercent(live, 0.00205)?.toFixed(4)), 14.1);
  assert.equal(Number(calculatePerpsPositionNetRoePercent(rpc, 0.00205)?.toFixed(4)), 10);
});

test("fee-protected scalp stop prices preserve positive net ROE on both sides", () => {
  assert.equal(calculateScalpProfitLockStopPrice({
    side: "long",
    entryPrice: 100,
    leverage: 20,
    exitNetRoePercent: 7,
    estimatedRoundTripFeeRate: 0.00205,
  }), 100.555);
  assert.equal(calculateScalpProfitLockStopPrice({
    side: "short",
    entryPrice: 100,
    leverage: 20,
    exitNetRoePercent: 7,
    estimatedRoundTripFeeRate: 0.00205,
  }), 99.445);
});

test("matching entire-position stops are recognized without resubmission", () => {
  assert.equal(hasMatchingEntirePositionProfitLockStop({
    positionPubkey: "position-pubkey",
    triggerPrice: 100.555,
    pendingTriggers: [{
      positionPubkey: "position-pubkey",
      kind: "stop-loss",
      entirePosition: true,
      executed: false,
      triggerPrice: 100.555001,
    } as never],
  }), true);
});

test("enabling Scalp Mode cannot reclassify an existing Smart/manual position", async () => {
  const base = createConfig();
  const config = createConfig({ settings: { ...base.settings, scalpModeEnabled: true } });
  let writtenState: PerpsProfitLockState | null = null;
  let stopSubmissions = 0;
  let closeSubmissions = 0;

  await runAutonomousPerpsMonitor({
    listConfigs: async () => [config],
    listSessions: async () => [createSession()],
    getRuntimeOverride: async () => ({ killSwitchOverride: false, updatedAt: new Date().toISOString() }),
    fetchCandles: async () => [],
    fetchSnapshot: async () => ({
      positions: [createOpenPosition(11, { leverage: 20, markPrice: 101 })],
      pendingTriggers: [],
      recentTrades: [],
    }),
    getUsdcBalance: async () => 100,
    getAgentWallet: () => "agent-wallet",
    isWalletAllowed: () => true,
    getProfitLockPositionProvenance: async () => ({
      episodeId: "manual-smart-episode",
      executionId: "manual-smart-episode",
      strategyClass: "smart",
      createdAt: "2026-08-19T12:00:00.000Z",
    }),
    readProfitLockState: async () => null,
    writeProfitLockState: async (_address, state) => { writtenState = state; },
    submitProfitLockStop: async (_address, _position, triggerPrice) => {
      stopSubmissions += 1;
      return { txid: "must-not-submit-stop", triggerPrice };
    },
    closePosition: async () => {
      closeSubmissions += 1;
      return { txid: "must-not-close" };
    },
  });

  assert.equal((writtenState as PerpsProfitLockState | null)?.episodeId, "manual-smart-episode");
  assert.equal((writtenState as PerpsProfitLockState | null)?.strategyClass, "smart");
  assert.equal((writtenState as PerpsProfitLockState | null)?.activeTier, null);
  assert.equal(stopSubmissions, 0);
  assert.equal(closeSubmissions, 0);
});

test("a reopened same-pubkey episode can claim and submit the same scalp tier", async () => {
  const base = createConfig();
  const config = createConfig({ settings: { ...base.settings, scalpModeEnabled: true } });
  let episodeId = "episode-one";
  let state: PerpsProfitLockState | null = null;
  const claimKeys = new Set<string>();
  const submittedEpisodes: string[] = [];

  const run = () => runAutonomousPerpsMonitor({
    listConfigs: async () => [config],
    listSessions: async () => [createSession()],
    getRuntimeOverride: async () => ({ killSwitchOverride: false, updatedAt: new Date().toISOString() }),
    fetchCandles: async () => [],
    fetchSnapshot: async () => ({
      positions: [createOpenPosition(11, {
        entryPrice: 100,
        markPrice: 101,
        leverage: 20,
        positionValue: 2_000,
        collateralValue: 100,
        stopLoss: 98.85,
      })],
      pendingTriggers: [],
      recentTrades: [],
    }),
    getUsdcBalance: async () => 100,
    getAgentWallet: () => "agent-wallet",
    isWalletAllowed: () => true,
    getProfitLockPositionProvenance: async () => ({
      episodeId,
      executionId: episodeId,
      strategyClass: "scalp",
      createdAt: episodeId === "episode-one"
        ? "2026-08-19T10:00:00.000Z"
        : "2026-08-19T12:00:00.000Z",
    }),
    readProfitLockState: async () => state,
    writeProfitLockState: async (_address, next) => { state = next; },
    claimProfitLockStop: async (_address, _positionPubkey, claimEpisodeId, tier) => {
      const key = `${claimEpisodeId}:${tier}`;
      if (claimKeys.has(key)) return null;
      claimKeys.add(key);
      return createProfitLockTestClaim(key);
    },
    submitProfitLockStop: async (_address, _position, triggerPrice) => {
      submittedEpisodes.push(episodeId);
      return { txid: `stop-${episodeId}`, triggerPrice };
    },
  });

  await run();
  episodeId = "episode-two";
  await run();

  assert.deepEqual(submittedEpisodes, ["episode-one", "episode-two"]);
  assert.deepEqual([...claimKeys], ["episode-one:ten-to-seven", "episode-two:ten-to-seven"]);
  assert.equal((state as PerpsProfitLockState | null)?.episodeId, "episode-two");
});

test("overlapping profit-lock close workers atomically submit one full close per episode", async () => {
  const base = createConfig();
  const config = createConfig({ settings: { ...base.settings, scalpModeEnabled: true } });
  const previousState: PerpsProfitLockState = {
    positionPubkey: "position-pubkey",
    episodeId: "close-episode",
    strategyClass: "scalp",
    peakRoePercent: 11,
    activeTier: "ten-to-seven",
    protectedExitRoePercent: 7,
    armedAt: 1_000,
    closeTxid: null,
    closeSubmittedAt: null,
    updatedAt: 1_000,
  };
  let claimed = false;
  let closeCalls = 0;
  const run = () => runAutonomousPerpsMonitor({
    listConfigs: async () => [config],
    listSessions: async () => [createSession()],
    getRuntimeOverride: async () => ({ killSwitchOverride: false, updatedAt: new Date().toISOString() }),
    fetchCandles: async () => [],
    fetchSnapshot: async () => ({
      positions: [createOpenPosition(6, { leverage: 20, markPrice: 100.4 })],
      pendingTriggers: [],
      recentTrades: [],
    }),
    getUsdcBalance: async () => 100,
    getAgentWallet: () => "agent-wallet",
    isWalletAllowed: () => true,
    getProfitLockPositionProvenance: async () => ({
      episodeId: "close-episode",
      executionId: "close-episode",
      strategyClass: "scalp",
      createdAt: "2026-08-19T12:00:00.000Z",
    }),
    readProfitLockState: async () => previousState,
    writeProfitLockState: async () => undefined,
    claimProfitLockClose: async (_address, _positionPubkey, claimEpisodeId) => {
      assert.equal(claimEpisodeId, "close-episode");
      if (claimed) return null;
      claimed = true;
      return createProfitLockTestClaim("overlap-close");
    },
    closePosition: async () => {
      closeCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { txid: "single-close" };
    },
  });

  const outcomes = await Promise.all([run(), run()]);
  assert.equal(closeCalls, 1);
  assert.deepEqual(
    outcomes.map((outcome) => outcome.results[0]?.code).sort(),
    ["PROFIT_LOCK_CLOSE_PENDING", "PROFIT_LOCK_CLOSE_SUBMITTED"]
  );
});

test("scalp staircase submits one closer profitable stop per armed tier", async () => {
  const base = createConfig();
  const config = createConfig({ settings: { ...base.settings, scalpModeEnabled: true } });
  let state: PerpsProfitLockState | null = null;
  const submitted: number[] = [];
  let roePercent = 11;
  let markPrice = 101;
  const run = () => runAutonomousPerpsMonitor({
    listConfigs: async () => [config],
    listSessions: async () => [createSession()],
    getRuntimeOverride: async () => ({ killSwitchOverride: false, updatedAt: new Date().toISOString() }),
    fetchCandles: async () => [],
    fetchSnapshot: async () => ({
      positions: [createOpenPosition(roePercent, {
        entryPrice: 100,
        markPrice,
        leverage: 20,
        positionValue: 2_000,
        collateralValue: 100,
        stopLoss: 98.85,
      })],
      pendingTriggers: [],
      recentTrades: [],
    }),
    getUsdcBalance: async () => 100,
    getAgentWallet: () => "agent-wallet",
    isWalletAllowed: () => true,
    readProfitLockState: async () => state,
    writeProfitLockState: async (_address, next) => {
      state = next;
    },
    submitProfitLockStop: async (_address, position, triggerPrice) => {
      assert.equal(position.stopLoss, 98.85, "the original hard SL remains untouched");
      submitted.push(triggerPrice);
      return { txid: `lock-stop-${submitted.length}`, triggerPrice };
    },
  });

  await run();
  await run();
  assert.deepEqual(submitted, [100.555], "the same tier is reserved and never duplicated");
  assert.equal((state as PerpsProfitLockState | null)?.onChainStopStatus, "submitted");

  roePercent = 31;
  markPrice = 103;
  await run();
  assert.deepEqual(submitted, [100.555, 101.355]);
  assert.equal((state as PerpsProfitLockState | null)?.onChainStopTier, "thirty-to-twenty-three");
  assert.equal((state as PerpsProfitLockState | null)?.onChainStopPrice, 101.355);
});

test("ambiguous on-chain stop failure is reserved and not blindly retried", async () => {
  const base = createConfig();
  const config = createConfig({ settings: { ...base.settings, scalpModeEnabled: true } });
  let state: PerpsProfitLockState | null = null;
  let submitCalls = 0;
  const run = () => runAutonomousPerpsMonitor({
    listConfigs: async () => [config],
    listSessions: async () => [createSession()],
    getRuntimeOverride: async () => ({ killSwitchOverride: false, updatedAt: new Date().toISOString() }),
    fetchCandles: async () => [],
    fetchSnapshot: async () => ({
      positions: [createOpenPosition(11, {
        entryPrice: 100,
        markPrice: 101,
        leverage: 20,
        positionValue: 2_000,
        collateralValue: 100,
        stopLoss: 98.85,
      })],
      pendingTriggers: [],
      recentTrades: [],
    }),
    getUsdcBalance: async () => 100,
    getAgentWallet: () => "agent-wallet",
    isWalletAllowed: () => true,
    readProfitLockState: async () => state,
    writeProfitLockState: async (_address, next) => {
      state = next;
    },
    submitProfitLockStop: async () => {
      submitCalls += 1;
      throw new Error("ambiguous network response");
    },
  });

  await run();
  await run();
  assert.equal(submitCalls, 1);
  assert.equal((state as PerpsProfitLockState | null)?.onChainStopStatus, "uncertain");
  assert.match((state as PerpsProfitLockState | null)?.onChainStopError ?? "", /ambiguous network response/);
});

test("overlapping monitor workers atomically claim one on-chain stop submission", async () => {
  const base = createConfig();
  const config = createConfig({ settings: { ...base.settings, scalpModeEnabled: true } });
  let claimed = false;
  let submitCalls = 0;
  const run = () => runAutonomousPerpsMonitor({
    listConfigs: async () => [config],
    listSessions: async () => [createSession()],
    getRuntimeOverride: async () => ({ killSwitchOverride: false, updatedAt: new Date().toISOString() }),
    fetchCandles: async () => [],
    fetchSnapshot: async () => ({
      positions: [createOpenPosition(11, {
        entryPrice: 100,
        markPrice: 101,
        leverage: 20,
        positionValue: 2_000,
        collateralValue: 100,
        stopLoss: 98.85,
      })],
      pendingTriggers: [],
      recentTrades: [],
    }),
    getUsdcBalance: async () => 100,
    getAgentWallet: () => "agent-wallet",
    isWalletAllowed: () => true,
    readProfitLockState: async () => null,
    writeProfitLockState: async () => undefined,
    claimProfitLockStop: async () => {
      if (claimed) return null;
      claimed = true;
      return createProfitLockTestClaim("overlap-stop");
    },
    submitProfitLockStop: async (_address, _position, triggerPrice) => {
      submitCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { txid: "single-stop", triggerPrice };
    },
  });

  await Promise.all([run(), run()]);
  assert.equal(submitCalls, 1);
});

test("a definitively rejected profit-lock stop releases its owner claim and retries safely", async () => {
  const base = createConfig();
  const config = createConfig({ settings: { ...base.settings, scalpModeEnabled: true } });
  const lifecycle = createProfitLockTestClaimLifecycle("definite-stop");
  let state: PerpsProfitLockState | null = null;
  let submitCalls = 0;
  const run = () => runAutonomousPerpsMonitor({
    listConfigs: async () => [config],
    listSessions: async () => [createSession()],
    getRuntimeOverride: async () => ({ killSwitchOverride: false, updatedAt: new Date().toISOString() }),
    fetchCandles: async () => [],
    fetchSnapshot: async () => ({
      positions: [createOpenPosition(11, {
        entryPrice: 100,
        markPrice: 101,
        leverage: 20,
        positionValue: 2_000,
        collateralValue: 100,
        stopLoss: 98.85,
      })],
      pendingTriggers: [],
      recentTrades: [],
    }),
    getUsdcBalance: async () => 100,
    getAgentWallet: () => "agent-wallet",
    isWalletAllowed: () => true,
    readProfitLockState: async () => state,
    writeProfitLockState: async (_address, next) => { state = next; },
    claimProfitLockStop: lifecycle.claim,
    settleProfitLockClaim: lifecycle.settle,
    submitProfitLockStop: async (_address, _position, triggerPrice) => {
      submitCalls += 1;
      if (submitCalls === 1) {
        throw new ProfitLockSideEffectError(
          "definite-failure",
          "Jupiter rejected the stop before submission."
        );
      }
      return { txid: "retry-stop-tx", triggerPrice };
    },
  });

  await run();
  assert.equal((state as PerpsProfitLockState | null)?.onChainStopStatus, null);
  await run();

  assert.equal(submitCalls, 2);
  assert.deepEqual(lifecycle.settlements, ["definite-failure", "submitted"]);
  assert.equal((state as PerpsProfitLockState | null)?.onChainStopStatus, "submitted");
  assert.equal((state as PerpsProfitLockState | null)?.onChainStopTxid, "retry-stop-tx");
});

test("a failed durable stop reservation releases the claim before any side effect", async () => {
  const base = createConfig();
  const config = createConfig({ settings: { ...base.settings, scalpModeEnabled: true } });
  const lifecycle = createProfitLockTestClaimLifecycle("stop-state-write");
  let state: PerpsProfitLockState | null = null;
  let failReservedWrite = true;
  let submitCalls = 0;
  const run = () => runAutonomousPerpsMonitor({
    listConfigs: async () => [config],
    listSessions: async () => [createSession()],
    getRuntimeOverride: async () => ({ killSwitchOverride: false, updatedAt: new Date().toISOString() }),
    fetchCandles: async () => [],
    fetchSnapshot: async () => ({
      positions: [createOpenPosition(11, {
        entryPrice: 100,
        markPrice: 101,
        leverage: 20,
        positionValue: 2_000,
        collateralValue: 100,
        stopLoss: 98.85,
      })],
      pendingTriggers: [],
      recentTrades: [],
    }),
    getUsdcBalance: async () => 100,
    getAgentWallet: () => "agent-wallet",
    isWalletAllowed: () => true,
    readProfitLockState: async () => state,
    writeProfitLockState: async (_address, next) => {
      if (failReservedWrite && next.onChainStopStatus === "reserved") {
        failReservedWrite = false;
        throw new Error("stop reservation HSET failed");
      }
      state = next;
    },
    claimProfitLockStop: lifecycle.claim,
    settleProfitLockClaim: lifecycle.settle,
    submitProfitLockStop: async (_address, _position, triggerPrice) => {
      submitCalls += 1;
      return { txid: "stop-after-state-retry", triggerPrice };
    },
  });

  const failed = await run();
  assert.equal(failed.results[0]?.code, "MONITOR_ERROR");
  assert.equal(submitCalls, 0);
  assert.deepEqual(lifecycle.settlements, ["definite-failure"]);

  await run();
  assert.equal(submitCalls, 1);
  assert.deepEqual(lifecycle.settlements, ["definite-failure", "submitted"]);
  assert.equal((state as PerpsProfitLockState | null)?.onChainStopTxid, "stop-after-state-retry");
});

test("an explicitly failed submitted stop transaction releases its claim and retries", async () => {
  const base = createConfig();
  const config = createConfig({ settings: { ...base.settings, scalpModeEnabled: true } });
  const lifecycle = createProfitLockTestClaimLifecycle("failed-stop-tx");
  let state: PerpsProfitLockState | null = null;
  let submitCalls = 0;
  let transactionStatus: "processing" | "failed" = "processing";
  const run = () => runAutonomousPerpsMonitor({
    listConfigs: async () => [config],
    listSessions: async () => [createSession()],
    getRuntimeOverride: async () => ({ killSwitchOverride: false, updatedAt: new Date().toISOString() }),
    fetchCandles: async () => [],
    fetchSnapshot: async () => ({
      positions: [createOpenPosition(11, {
        entryPrice: 100,
        markPrice: 101,
        leverage: 20,
        positionValue: 2_000,
        collateralValue: 100,
        stopLoss: 98.85,
      })],
      pendingTriggers: [],
      recentTrades: [],
    }),
    getUsdcBalance: async () => 100,
    getAgentWallet: () => "agent-wallet",
    isWalletAllowed: () => true,
    readProfitLockState: async () => state,
    writeProfitLockState: async (_address, next) => { state = next; },
    claimProfitLockStop: lifecycle.claim,
    settleProfitLockClaim: lifecycle.settle,
    readProfitLockTransactionStatus: async () => transactionStatus,
    submitProfitLockStop: async (_address, _position, triggerPrice) => {
      submitCalls += 1;
      return { txid: `stop-tx-${submitCalls}`, triggerPrice };
    },
  });

  await run();
  assert.equal(submitCalls, 1);
  transactionStatus = "failed";
  await run();

  assert.equal(submitCalls, 2);
  assert.deepEqual(lifecycle.settlements, ["submitted", "definite-failure", "submitted"]);
  assert.equal((state as PerpsProfitLockState | null)?.onChainStopTxid, "stop-tx-2");
});

for (const transactionStatus of ["confirmed", "processing", "not-found", "unavailable"] as const) {
  test(`a ${transactionStatus} submitted stop status remains blocked without resubmission`, async () => {
    const base = createConfig();
    const config = createConfig({ settings: { ...base.settings, scalpModeEnabled: true } });
    const lifecycle = createProfitLockTestClaimLifecycle(`blocked-stop-${transactionStatus}`);
    let state: PerpsProfitLockState | null = null;
    let submitCalls = 0;
    const run = () => runAutonomousPerpsMonitor({
      listConfigs: async () => [config],
      listSessions: async () => [createSession()],
      getRuntimeOverride: async () => ({ killSwitchOverride: false, updatedAt: new Date().toISOString() }),
      fetchCandles: async () => [],
      fetchSnapshot: async () => ({
        positions: [createOpenPosition(11, {
          entryPrice: 100,
          markPrice: 101,
          leverage: 20,
          positionValue: 2_000,
          collateralValue: 100,
          stopLoss: 98.85,
        })],
        pendingTriggers: [],
        recentTrades: [],
      }),
      getUsdcBalance: async () => 100,
      getAgentWallet: () => "agent-wallet",
      isWalletAllowed: () => true,
      readProfitLockState: async () => state,
      writeProfitLockState: async (_address, next) => { state = next; },
      claimProfitLockStop: lifecycle.claim,
      settleProfitLockClaim: lifecycle.settle,
      readProfitLockTransactionStatus: async () => {
        if (transactionStatus === "unavailable") throw new Error("RPC unavailable");
        return transactionStatus;
      },
      submitProfitLockStop: async (_address, _position, triggerPrice) => {
        submitCalls += 1;
        return { txid: "blocked-stop-tx", triggerPrice };
      },
    });

    await run();
    await run();
    assert.equal(submitCalls, 1);
    assert.deepEqual(lifecycle.settlements, ["submitted"]);
    assert.equal((state as PerpsProfitLockState | null)?.onChainStopTxid, "blocked-stop-tx");
  });
}

test("profit-lock claim classification releases explicit 4xx rejections but reserves uncertain failures", () => {
  assert.equal(
    classifyProfitLockSideEffectFailure(
      new PerpsExecutionError("JUPITER_EXECUTE_FAILED", "invalid trigger", 422)
    ),
    "definite-failure"
  );
  assert.equal(
    classifyProfitLockSideEffectFailure(
      new PerpsExecutionError("JUPITER_EXECUTE_FAILED", "upstream unavailable", 503)
    ),
    "ambiguous"
  );
  assert.equal(
    classifyProfitLockSideEffectFailure(
      new PerpsExecutionError("JUPITER_EXECUTE_FAILED", "request timed out", 408)
    ),
    "ambiguous"
  );
  assert.equal(classifyProfitLockSideEffectFailure(new TypeError("fetch failed")), "ambiguous");
});

test("an ambiguous profit-lock stop response remains claimed and never auto-submits a duplicate", async () => {
  const base = createConfig();
  const config = createConfig({ settings: { ...base.settings, scalpModeEnabled: true } });
  const lifecycle = createProfitLockTestClaimLifecycle("ambiguous-stop");
  let state: PerpsProfitLockState | null = null;
  let submitCalls = 0;
  const run = () => runAutonomousPerpsMonitor({
    listConfigs: async () => [config],
    listSessions: async () => [createSession()],
    getRuntimeOverride: async () => ({ killSwitchOverride: false, updatedAt: new Date().toISOString() }),
    fetchCandles: async () => [],
    fetchSnapshot: async () => ({
      positions: [createOpenPosition(11, {
        entryPrice: 100,
        markPrice: 101,
        leverage: 20,
        positionValue: 2_000,
        collateralValue: 100,
        stopLoss: 98.85,
      })],
      pendingTriggers: [],
      recentTrades: [],
    }),
    getUsdcBalance: async () => 100,
    getAgentWallet: () => "agent-wallet",
    isWalletAllowed: () => true,
    readProfitLockState: async () => state,
    writeProfitLockState: async (_address, next) => { state = next; },
    claimProfitLockStop: lifecycle.claim,
    settleProfitLockClaim: lifecycle.settle,
    submitProfitLockStop: async () => {
      submitCalls += 1;
      throw new ProfitLockSideEffectError(
        "ambiguous",
        "The execute response was dropped after the request left this worker."
      );
    },
  });

  await run();
  await run();

  assert.equal(submitCalls, 1);
  assert.deepEqual(lifecycle.settlements, ["ambiguous"]);
  assert.equal((state as PerpsProfitLockState | null)?.onChainStopStatus, "uncertain");
});

test("a rejected profit-lock close retries while an ambiguous retry remains reserved", async () => {
  const base = createConfig();
  const config = createConfig({ settings: { ...base.settings, scalpModeEnabled: true } });
  let state: PerpsProfitLockState | null = {
    positionPubkey: "position-pubkey",
    episodeId: "close-lifecycle-episode",
    strategyClass: "scalp",
    peakRoePercent: 11,
    activeTier: "ten-to-seven",
    protectedExitRoePercent: 7,
    armedAt: 1_000,
    closeTxid: null,
    closeSubmittedAt: null,
    updatedAt: 1_000,
  };
  const lifecycle = createProfitLockTestClaimLifecycle("close-lifecycle");
  let closeCalls = 0;
  const run = () => runAutonomousPerpsMonitor({
    listConfigs: async () => [config],
    listSessions: async () => [createSession()],
    getRuntimeOverride: async () => ({ killSwitchOverride: false, updatedAt: new Date().toISOString() }),
    fetchCandles: async () => [],
    fetchSnapshot: async () => ({
      positions: [createOpenPosition(6, { leverage: 20, markPrice: 100.4 })],
      pendingTriggers: [],
      recentTrades: [],
    }),
    getUsdcBalance: async () => 100,
    getAgentWallet: () => "agent-wallet",
    isWalletAllowed: () => true,
    getProfitLockPositionProvenance: async () => ({
      episodeId: "close-lifecycle-episode",
      executionId: "close-lifecycle-episode",
      strategyClass: "scalp",
      createdAt: "2026-08-19T12:00:00.000Z",
    }),
    readProfitLockState: async () => state,
    writeProfitLockState: async (_address, next) => { state = next; },
    claimProfitLockClose: lifecycle.claim,
    settleProfitLockClaim: lifecycle.settle,
    closePosition: async () => {
      closeCalls += 1;
      if (closeCalls === 1) {
        throw new ProfitLockSideEffectError("definite-failure", "Close build rejected.");
      }
      throw new ProfitLockSideEffectError("ambiguous", "Close response dropped.");
    },
  });

  await run();
  assert.equal((state as PerpsProfitLockState | null)?.closeStatus, null);
  await run();
  await run();

  assert.equal(closeCalls, 2);
  assert.deepEqual(lifecycle.settlements, ["definite-failure", "ambiguous"]);
  assert.equal((state as PerpsProfitLockState | null)?.closeStatus, "uncertain");
});

test("a failed durable close reservation releases the claim before any side effect", async () => {
  const base = createConfig();
  const config = createConfig({ settings: { ...base.settings, scalpModeEnabled: true } });
  let state: PerpsProfitLockState | null = {
    positionPubkey: "position-pubkey",
    episodeId: "close-state-write-episode",
    strategyClass: "scalp",
    peakRoePercent: 11,
    activeTier: "ten-to-seven",
    protectedExitRoePercent: 7,
    armedAt: 1_000,
    closeTxid: null,
    closeSubmittedAt: null,
    updatedAt: 1_000,
  };
  const lifecycle = createProfitLockTestClaimLifecycle("close-state-write");
  let failReservedWrite = true;
  let closeCalls = 0;
  const run = () => runAutonomousPerpsMonitor({
    listConfigs: async () => [config],
    listSessions: async () => [createSession()],
    getRuntimeOverride: async () => ({ killSwitchOverride: false, updatedAt: new Date().toISOString() }),
    fetchCandles: async () => [],
    fetchSnapshot: async () => ({
      positions: [createOpenPosition(6, { leverage: 20, markPrice: 100.4 })],
      pendingTriggers: [],
      recentTrades: [],
    }),
    getUsdcBalance: async () => 100,
    getAgentWallet: () => "agent-wallet",
    isWalletAllowed: () => true,
    getProfitLockPositionProvenance: async () => ({
      episodeId: "close-state-write-episode",
      executionId: "close-state-write-episode",
      strategyClass: "scalp",
      createdAt: "2026-08-19T12:00:00.000Z",
    }),
    readProfitLockState: async () => state,
    writeProfitLockState: async (_address, next) => {
      if (failReservedWrite && next.closeStatus === "reserved") {
        failReservedWrite = false;
        throw new Error("close reservation HSET failed");
      }
      state = next;
    },
    claimProfitLockClose: lifecycle.claim,
    settleProfitLockClaim: lifecycle.settle,
    closePosition: async () => {
      closeCalls += 1;
      return { txid: "close-after-state-retry" };
    },
  });

  const failed = await run();
  assert.equal(failed.results[0]?.code, "MONITOR_ERROR");
  assert.equal(closeCalls, 0);
  assert.deepEqual(lifecycle.settlements, ["definite-failure"]);

  await run();
  assert.equal(closeCalls, 1);
  assert.deepEqual(lifecycle.settlements, ["definite-failure", "submitted"]);
  assert.equal((state as PerpsProfitLockState | null)?.closeTxid, "close-after-state-retry");
});

test("an explicitly failed submitted close transaction releases its claim and retries", async () => {
  const base = createConfig();
  const config = createConfig({ settings: { ...base.settings, scalpModeEnabled: true } });
  let state: PerpsProfitLockState | null = {
    positionPubkey: "position-pubkey",
    episodeId: "failed-close-tx-episode",
    strategyClass: "scalp",
    peakRoePercent: 11,
    activeTier: "ten-to-seven",
    protectedExitRoePercent: 7,
    armedAt: 1_000,
    closeTxid: null,
    closeSubmittedAt: null,
    updatedAt: 1_000,
  };
  const lifecycle = createProfitLockTestClaimLifecycle("failed-close-tx");
  let closeCalls = 0;
  let transactionStatus: "processing" | "failed" = "processing";
  const run = () => runAutonomousPerpsMonitor({
    listConfigs: async () => [config],
    listSessions: async () => [createSession()],
    getRuntimeOverride: async () => ({ killSwitchOverride: false, updatedAt: new Date().toISOString() }),
    fetchCandles: async () => [],
    fetchSnapshot: async () => ({
      positions: [createOpenPosition(6, { leverage: 20, markPrice: 100.4 })],
      pendingTriggers: [],
      recentTrades: [],
    }),
    getUsdcBalance: async () => 100,
    getAgentWallet: () => "agent-wallet",
    isWalletAllowed: () => true,
    getProfitLockPositionProvenance: async () => ({
      episodeId: "failed-close-tx-episode",
      executionId: "failed-close-tx-episode",
      strategyClass: "scalp",
      createdAt: "2026-08-19T12:00:00.000Z",
    }),
    readProfitLockState: async () => state,
    writeProfitLockState: async (_address, next) => { state = next; },
    claimProfitLockClose: lifecycle.claim,
    settleProfitLockClaim: lifecycle.settle,
    readProfitLockTransactionStatus: async () => transactionStatus,
    closePosition: async () => {
      closeCalls += 1;
      return { txid: `close-tx-${closeCalls}` };
    },
  });

  await run();
  assert.equal(closeCalls, 1);
  transactionStatus = "failed";
  await run();

  assert.equal(closeCalls, 2);
  assert.deepEqual(lifecycle.settlements, ["submitted", "definite-failure", "submitted"]);
  assert.equal((state as PerpsProfitLockState | null)?.closeTxid, "close-tx-2");
});

for (const transactionStatus of ["confirmed", "processing", "not-found", "unavailable"] as const) {
  test(`a ${transactionStatus} submitted close status remains blocked without resubmission`, async () => {
    const base = createConfig();
    const config = createConfig({ settings: { ...base.settings, scalpModeEnabled: true } });
    let state: PerpsProfitLockState | null = {
      positionPubkey: "position-pubkey",
      episodeId: `blocked-close-${transactionStatus}`,
      strategyClass: "scalp",
      peakRoePercent: 11,
      activeTier: "ten-to-seven",
      protectedExitRoePercent: 7,
      armedAt: 1_000,
      closeTxid: null,
      closeSubmittedAt: null,
      updatedAt: 1_000,
    };
    const lifecycle = createProfitLockTestClaimLifecycle(`blocked-close-${transactionStatus}`);
    let closeCalls = 0;
    const run = () => runAutonomousPerpsMonitor({
      listConfigs: async () => [config],
      listSessions: async () => [createSession()],
      getRuntimeOverride: async () => ({ killSwitchOverride: false, updatedAt: new Date().toISOString() }),
      fetchCandles: async () => [],
      fetchSnapshot: async () => ({
        positions: [createOpenPosition(6, { leverage: 20, markPrice: 100.4 })],
        pendingTriggers: [],
        recentTrades: [],
      }),
      getUsdcBalance: async () => 100,
      getAgentWallet: () => "agent-wallet",
      isWalletAllowed: () => true,
      getProfitLockPositionProvenance: async () => ({
        episodeId: `blocked-close-${transactionStatus}`,
        executionId: `blocked-close-${transactionStatus}`,
        strategyClass: "scalp",
        createdAt: "2026-08-19T12:00:00.000Z",
      }),
      readProfitLockState: async () => state,
      writeProfitLockState: async (_address, next) => { state = next; },
      claimProfitLockClose: lifecycle.claim,
      settleProfitLockClaim: lifecycle.settle,
      readProfitLockTransactionStatus: async () => {
        if (transactionStatus === "unavailable") throw new Error("RPC unavailable");
        return transactionStatus;
      },
      closePosition: async () => {
        closeCalls += 1;
        return { txid: "blocked-close-tx" };
      },
    });

    await run();
    if (state) {
      state = {
        ...(state as PerpsProfitLockState),
        closeSubmittedAt: Date.now() - 10 * 60_000,
      };
    }
    await run();
    assert.equal(closeCalls, 1);
    assert.deepEqual(lifecycle.settlements, ["submitted"]);
    assert.equal((state as PerpsProfitLockState | null)?.closeTxid, "blocked-close-tx");
  });
}

test("renewing monitor lease stays exclusive past its original TTL", async () => {
  let owner: string | null = null;
  let expiresAt = 0;
  let renewals = 0;
  const store: AutonomousMonitorLeaseStore = {
    acquire: async (candidate, ttlMs) => {
      const now = Date.now();
      if (owner && expiresAt > now) return false;
      owner = candidate;
      expiresAt = now + ttlMs;
      return true;
    },
    renew: async (candidate, ttlMs) => {
      if (owner !== candidate || expiresAt <= Date.now()) return false;
      renewals += 1;
      expiresAt = Date.now() + ttlMs;
      return true;
    },
    release: async (candidate) => {
      if (owner !== candidate) return false;
      owner = null;
      expiresAt = 0;
      return true;
    },
  };
  let finishFirst!: () => void;
  const firstTask = new Promise<void>((resolve) => { finishFirst = resolve; });
  const first = runWithRenewingAutonomousMonitorLease({
    leaseStore: store,
    ownerToken: "first-owner",
    ttlMs: 60,
    renewalIntervalMs: 10,
    task: async () => {
      await firstTask;
      return "first";
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 85));
  const overlapping = await runWithRenewingAutonomousMonitorLease({
    leaseStore: store,
    ownerToken: "second-owner",
    ttlMs: 60,
    renewalIntervalMs: 10,
    task: async () => "second",
  });
  assert.deepEqual(overlapping, { acquired: false });
  assert.ok(renewals >= 2);

  finishFirst();
  assert.deepEqual(await first, { acquired: true, result: "first" });
  const afterRelease = await runWithRenewingAutonomousMonitorLease({
    leaseStore: store,
    ownerToken: "third-owner",
    ttlMs: 60,
    renewalIntervalMs: 10,
    task: async () => "third",
  });
  assert.deepEqual(afterRelease, { acquired: true, result: "third" });
});

test("a worker that loses its lease to a successor cannot continue to live routing", async () => {
  let owner: string | null = null;
  let routeCalls = 0;
  let releaseFirstRenewal!: () => void;
  const firstRenewal = new Promise<void>((resolve) => { releaseFirstRenewal = resolve; });
  let continueMonitor!: () => void;
  const monitorPaused = new Promise<void>((resolve) => { continueMonitor = resolve; });
  let finishSuccessor!: () => void;
  const successorTask = new Promise<void>((resolve) => { finishSuccessor = resolve; });
  const store: AutonomousMonitorLeaseStore = {
    acquire: async (candidate) => {
      if (owner) return false;
      owner = candidate;
      return true;
    },
    renew: async (candidate) => {
      if (owner !== candidate) return false;
      if (candidate === "first-owner") {
        owner = null;
        releaseFirstRenewal();
        return false;
      }
      return true;
    },
    release: async (candidate) => {
      if (owner !== candidate) return false;
      owner = null;
      return true;
    },
  };
  const baseTime = 1_784_174_800_000;
  const points = [100, 100.2, 100.4, 100.8, 101.4, 102].map((value, index) => ({
    t: baseTime + index * 60_000,
    v: value,
  }));
  const first = runWithRenewingAutonomousMonitorLease({
    leaseStore: store,
    ownerToken: "first-owner",
    ttlMs: 100,
    renewalIntervalMs: 5,
    task: (leaseGuard) => runAutonomousPerpsMonitor({
      listConfigs: async () => [createConfig()],
      listSessions: async () => [createSession()],
      getRuntimeOverride: async () => ({ killSwitchOverride: null, updatedAt: new Date().toISOString() }),
      fetchCandles: async () => points,
      fetchSnapshot: async () => ({ positions: [], pendingTriggers: [], recentTrades: [] }),
      getUsdcBalance: async () => 100,
      routeSignal: (async () => {
        routeCalls += 1;
        return { ok: true, message: "unexpected route" };
      }) as unknown as RouteSignal,
      reconcileNoOpenPosition: async () => [],
      getAgentWallet: () => "agent-wallet",
      isWalletAllowed: () => true,
      getLatestClosedOutcome: async () => {
        await monitorPaused;
        return null;
      },
      readLastSignal: async () => null,
      writeLastSignal: async () => undefined,
    }, leaseGuard),
  });
  const firstRejected = assert.rejects(first, AutonomousMonitorLeaseLostError);

  await firstRenewal;
  let successorStarted!: () => void;
  const successorIsRunning = new Promise<void>((resolve) => { successorStarted = resolve; });
  const successor = runWithRenewingAutonomousMonitorLease({
    leaseStore: store,
    ownerToken: "successor-owner",
    ttlMs: 100,
    renewalIntervalMs: 10,
    task: async () => {
      successorStarted();
      await successorTask;
      return "successor";
    },
  });
  await successorIsRunning;
  assert.equal(owner, "successor-owner");
  continueMonitor();
  await firstRejected;

  assert.equal(routeCalls, 0);
  assert.equal(owner, "successor-owner", "the stale first-worker release must preserve its successor");
  finishSuccessor();
  assert.deepEqual(await successor, { acquired: true, result: "successor" });
});

test("an expired monitor owner cannot renew or stale-release its successor", async () => {
  let owner: string | null = null;
  let expiresAt = 0;
  const store: AutonomousMonitorLeaseStore = {
    acquire: async (candidate, ttlMs) => {
      const now = Date.now();
      if (owner && expiresAt > now) return false;
      owner = candidate;
      expiresAt = now + ttlMs;
      return true;
    },
    renew: async (candidate, ttlMs) => {
      if (owner !== candidate || expiresAt <= Date.now()) return false;
      expiresAt = Date.now() + ttlMs;
      return true;
    },
    release: async (candidate) => {
      if (owner !== candidate) return false;
      owner = null;
      expiresAt = 0;
      return true;
    },
  };

  assert.equal(await store.acquire("expired-owner", 20), true);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(await store.acquire("successor-owner", 100), true);
  assert.equal(await store.renew("expired-owner", 100), false);
  assert.equal(await store.release("expired-owner"), false);
  assert.equal(owner, "successor-owner");
  assert.equal(await store.release("successor-owner"), true);
  assert.equal(owner, null);
});

function createLearningProfile(): DecisionLearningProfile {
  const now = new Date().toISOString();
  return {
    profileId: "profile-1",
    walletAddress,
    version: 1,
    status: "active",
    source: "operator-baseline",
    createdAt: now,
    promotedAt: now,
    learnedFromClosedTrades: 0,
    strategyBaselineVersion: 3,
    minimumConfidence: 0.62,
    leverageCap: 2,
    maximumAllocationPercent: 5,
    targetWalletRiskPercent: 1,
    preferredDirection: "balanced",
    trendWindow: 15,
    cooldownSeconds: 300,
    takeProfitRoePercent: 1,
    stopLossRoePercent: 1,
    minimumRewardRiskRatio: 2,
    atrLookback: 14,
    atrStopMultiplier: 1.5,
    volatilityCeilingPercent: 5,
    assetAdjustments: {
      SOL: { trendThreshold: 0.5, breakoutPercent: 0.3, leverageMultiplier: 0.5, allocationMultiplier: 0.5 },
      ETH: { trendThreshold: 0.5, breakoutPercent: 0.3, leverageMultiplier: 0.5, allocationMultiplier: 0.5 },
      BTC: { trendThreshold: 0.5, breakoutPercent: 0.3, leverageMultiplier: 0.5, allocationMultiplier: 0.5 },
    },
    validation: {
      sampleSize: 0,
      trainingSize: 0,
      validationSize: 0,
      winRate: 0,
      expectancyUsd: 0,
      profitFactor: 0,
      maxDrawdownUsd: 0,
      passed: true,
      reasons: ["test"],
    },
    summary: "Test profile",
  };
}

test("first profit-lock tier arms at 15% ROE and closes on a retreat to 10%", () => {
  assert.equal(PROFIT_LOCK_INITIAL_ARM_ROE_PERCENT, 15);
  assert.equal(PROFIT_LOCK_INITIAL_EXIT_ROE_PERCENT, 10);

  const armed = evaluatePerpsProfitLock({
    positionPubkey: "position-pubkey",
    currentRoePercent: 15,
    previousState: null,
    now: 1_000,
  });
  assert.equal(armed.action, "armed");
  assert.equal(armed.activeTier, "fifteen-to-ten");
  assert.equal(armed.exitRoePercent, 10);

  const retreat = evaluatePerpsProfitLock({
    positionPubkey: "position-pubkey",
    currentRoePercent: 10,
    previousState: armed.state,
    now: 2_000,
  });
  assert.equal(retreat.action, "close");
  assert.equal(retreat.activeTier, "fifteen-to-ten");
  assert.equal(retreat.state.peakRoePercent, 15);
});

test("scalp staircase arms at 10% ROE and closes on a retreat to 7%", () => {
  assert.equal(SCALP_PROFIT_LOCK_INITIAL_ARM_ROE_PERCENT, 10);
  assert.equal(SCALP_PROFIT_LOCK_INITIAL_EXIT_ROE_PERCENT, 7);

  const armed = evaluatePerpsProfitLock({
    positionPubkey: "scalp-position",
    strategyClass: "scalp",
    currentRoePercent: 10,
    previousState: null,
    now: 1_000,
  });
  assert.equal(armed.action, "armed");
  assert.equal(armed.activeTier, "ten-to-seven");
  assert.equal(armed.exitRoePercent, 7);
  assert.equal(armed.state.strategyClass, "scalp");

  const held = evaluatePerpsProfitLock({
    positionPubkey: "scalp-position",
    strategyClass: "scalp",
    currentRoePercent: 8,
    previousState: armed.state,
    now: 2_000,
  });
  assert.equal(held.action, "armed");

  const retreat = evaluatePerpsProfitLock({
    positionPubkey: "scalp-position",
    strategyClass: "scalp",
    currentRoePercent: 7,
    previousState: held.state,
    now: 3_000,
  });
  assert.equal(retreat.action, "close");
  assert.equal(retreat.activeTier, "ten-to-seven");
});

test("Smart Trades retain the original staircase and do not arm at 10% ROE", () => {
  const evaluation = evaluatePerpsProfitLock({
    positionPubkey: "smart-position",
    strategyClass: "smart",
    currentRoePercent: 10,
    previousState: null,
    now: 1_000,
  });
  assert.equal(evaluation.action, "track");
  assert.equal(evaluation.activeTier, null);
  assert.equal(evaluation.armRoePercent, 15);
});

test("a scalp position promotes from 10-to-7 through the existing upper tiers", () => {
  const first = evaluatePerpsProfitLock({
    positionPubkey: "scalp-position",
    strategyClass: "scalp",
    currentRoePercent: 11,
    previousState: null,
    now: 1_000,
  });
  assert.equal(first.activeTier, "ten-to-seven");

  const second = evaluatePerpsProfitLock({
    positionPubkey: "scalp-position",
    strategyClass: "scalp",
    currentRoePercent: 16,
    previousState: first.state,
    now: 2_000,
  });
  assert.equal(second.activeTier, "fifteen-to-ten");
  assert.equal(second.exitRoePercent, 10);

  const third = evaluatePerpsProfitLock({
    positionPubkey: "scalp-position",
    strategyClass: "scalp",
    currentRoePercent: 21,
    previousState: second.state,
    now: 3_000,
  });
  assert.equal(third.activeTier, "twenty-to-fifteen");
  assert.equal(third.exitRoePercent, 15);
});

test("a scalp runner protects gains near the raised post-fee TP", () => {
  const thirty = evaluatePerpsProfitLock({
    positionPubkey: "scalp-runner",
    strategyClass: "scalp",
    currentRoePercent: 30,
    previousState: null,
    now: 1_000,
  });
  assert.equal(thirty.activeTier, "thirty-to-twenty-three");
  assert.equal(thirty.exitRoePercent, 23);

  const forty = evaluatePerpsProfitLock({
    positionPubkey: "scalp-runner",
    strategyClass: "scalp",
    currentRoePercent: 40,
    previousState: thirty.state,
    now: 2_000,
  });
  assert.equal(forty.activeTier, "forty-to-thirty-two");
  assert.equal(forty.exitRoePercent, 32);

  const retreat = evaluatePerpsProfitLock({
    positionPubkey: "scalp-runner",
    strategyClass: "scalp",
    currentRoePercent: 32,
    previousState: forty.state,
    now: 3_000,
  });
  assert.equal(retreat.action, "close");
  assert.equal(retreat.activeTier, "forty-to-thirty-two");
});

test("second profit-lock tier arms at 20% ROE and closes on a retreat to 15%", () => {
  assert.equal(PROFIT_LOCK_ARM_ROE_PERCENT, 20);
  assert.equal(PROFIT_LOCK_EXIT_ROE_PERCENT, 15);
  assert.equal(calculatePerpsPositionRoePercent(createOpenPosition(20)), 20);

  const armed = evaluatePerpsProfitLock({
    positionPubkey: "position-pubkey",
    currentRoePercent: 20,
    previousState: null,
    now: 1_000,
  });
  assert.equal(armed.action, "armed");
  assert.equal(armed.activeTier, "twenty-to-fifteen");
  assert.equal(armed.exitRoePercent, 15);
  assert.equal(armed.state.peakRoePercent, 20);

  const retreat = evaluatePerpsProfitLock({
    positionPubkey: "position-pubkey",
    currentRoePercent: 15,
    previousState: armed.state,
    now: 2_000,
  });
  assert.equal(retreat.action, "close");
  assert.equal(retreat.state.peakRoePercent, 20);
});

test("profit lock does not close at 10% unless the same position first reached 15%", () => {
  const evaluation = evaluatePerpsProfitLock({
    positionPubkey: "position-pubkey",
    currentRoePercent: 10,
    previousState: null,
    now: 1_000,
  });
  assert.equal(evaluation.action, "track");
  assert.equal(evaluation.state.armedAt, null);
});

test("a position promoted to the 20-to-15 tier cannot fall back to the 15-to-10 tier", () => {
  const firstTier = evaluatePerpsProfitLock({
    positionPubkey: "position-pubkey",
    currentRoePercent: 16,
    previousState: null,
    now: 1_000,
  });
  assert.equal(firstTier.activeTier, "fifteen-to-ten");

  const promoted = evaluatePerpsProfitLock({
    positionPubkey: "position-pubkey",
    currentRoePercent: 21,
    previousState: firstTier.state,
    now: 2_000,
  });
  assert.equal(promoted.activeTier, "twenty-to-fifteen");
  assert.equal(promoted.exitRoePercent, 15);

  const retreat = evaluatePerpsProfitLock({
    positionPubkey: "position-pubkey",
    currentRoePercent: 14,
    previousState: promoted.state,
    now: 3_000,
  });
  assert.equal(retreat.action, "close");
  assert.equal(retreat.activeTier, "twenty-to-fifteen");
  assert.equal(retreat.exitRoePercent, 15);
});

test("the tier thresholds arm a current position from its Redis-tracked peak", () => {
  const evaluation = evaluatePerpsProfitLock({
    positionPubkey: "position-pubkey",
    currentRoePercent: 17,
    previousState: {
      positionPubkey: "position-pubkey",
      peakRoePercent: 21,
      armedAt: null,
      closeTxid: null,
      closeSubmittedAt: null,
      updatedAt: 1_000,
    },
    now: 2_000,
  });
  assert.equal(evaluation.action, "armed");
  assert.equal(evaluation.activeTier, "twenty-to-fifteen");
  assert.equal(evaluation.state.armedAt, 2_000);
  assert.equal(evaluation.state.peakRoePercent, 21);
});

test("the upper tier immediately closes a current position below 15% after a Redis-tracked 20% peak", () => {
  const evaluation = evaluatePerpsProfitLock({
    positionPubkey: "position-pubkey",
    currentRoePercent: 14,
    previousState: {
      positionPubkey: "position-pubkey",
      peakRoePercent: 21,
      armedAt: null,
      closeTxid: null,
      closeSubmittedAt: null,
      updatedAt: 1_000,
    },
    now: 2_000,
  });
  assert.equal(evaluation.action, "close");
  assert.equal(evaluation.state.armedAt, 2_000);
});

test("a submitted profit-lock close stays pending until its txid is authoritatively reconciled", () => {
  const previousState: PerpsProfitLockState = {
    positionPubkey: "position-pubkey",
    peakRoePercent: 30,
    armedAt: 1_000,
    closeTxid: "close-tx",
    closeSubmittedAt: 2_000,
    updatedAt: 2_000,
  };
  assert.equal(evaluatePerpsProfitLock({
    positionPubkey: "position-pubkey",
    currentRoePercent: 14,
    previousState,
    now: 60_000,
  }).action, "close-pending");
  assert.equal(evaluatePerpsProfitLock({
    positionPubkey: "position-pubkey",
    currentRoePercent: 14,
    previousState,
    now: 130_000,
  }).action, "close-pending");
});

test("server monitor routes a qualifying signal while the app is closed", async () => {
  let routedSignal: PerpsAgentSignal | null = null;
  let savedCursor = 0;
  const baseTime = 1_784_174_800_000;
  const points = [100, 100.2, 100.4, 100.8, 101.4, 102].map((value, index) => ({
    t: baseTime + index * 60_000,
    v: value,
  }));

  const result = await runAutonomousPerpsMonitor({
    listConfigs: async () => [createConfig()],
    listSessions: async () => [createSession()],
    getRuntimeOverride: async () => ({ killSwitchOverride: null, updatedAt: new Date().toISOString() }),
    fetchCandles: async () => points,
    fetchSnapshot: async () => ({ positions: [], pendingTriggers: [], recentTrades: [] }),
    getUsdcBalance: async () => 100,
    routeSignal: (async (_wallet: string, signal: PerpsAgentSignal) => {
      routedSignal = signal;
      return { ok: true, message: "submitted", execution: { status: "submitted" } };
    }) as unknown as RouteSignal,
    reconcileNoOpenPosition: async () => [],
    getAgentWallet: () => "agent-wallet",
    isWalletAllowed: () => true,
    readLastSignal: async () => null,
    writeLastSignal: async (_wallet, _asset, strategyClass, timestamp) => {
      assert.equal(strategyClass, "smart");
      savedCursor = timestamp;
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.results[0]?.status, "executed");
  assert.equal((routedSignal as PerpsAgentSignal | null)?.asset, "SOL");
  assert.equal((routedSignal as PerpsAgentSignal | null)?.collateralUsd, 25);
  assert.equal((routedSignal as PerpsAgentSignal | null)?.leverage, 2);
  const routedTakeProfit = (routedSignal as PerpsAgentSignal | null)?.takeProfitPrice ?? 0;
  const routedStopLoss = (routedSignal as PerpsAgentSignal | null)?.stopLossPrice ?? 0;
  const entryPrice = points[points.length - 1]?.v ?? 0;
  const positionSizeUsd = 25 * 2;
  assert.ok(((routedTakeProfit - entryPrice) / entryPrice) * positionSizeUsd >= 1);
  assert.ok(((entryPrice - routedStopLoss) / entryPrice) * positionSizeUsd >= 1);
  assert.equal(savedCursor, 0, "opening a trade does not start the post-close cooldown");
});

test("monitor recovery blocks the whole cycle even when pending scalp protection is repaired", async () => {
  let snapshotReads = 0;
  let routeCalls = 0;
  const result = await runAutonomousPerpsMonitor({
    listConfigs: async () => [createConfig()],
    listSessions: async () => [createSession()],
    getRuntimeOverride: async () => ({ killSwitchOverride: false, updatedAt: new Date().toISOString() }),
    getAgentWallet: () => "agent-wallet",
    isWalletAllowed: () => true,
    recoverPendingScalpProtection: async () => ({
      status: "protected",
      blockNewEntries: true,
      record: { recoveryId: "recovery-1" },
      message: "The pending scalp position is now protected.",
    }) as never,
    fetchSnapshot: async () => {
      snapshotReads += 1;
      return { positions: [], pendingTriggers: [], recentTrades: [] };
    },
    routeSignal: (async () => {
      routeCalls += 1;
      return { ok: true, message: "unexpected" };
    }) as unknown as RouteSignal,
  });

  assert.equal(result.results[0]?.code, "SCALP_PROTECTION_RECOVERY_RESOLVED");
  assert.equal(snapshotReads, 0);
  assert.equal(routeCalls, 0);
});

test("durable protection recovery runs for a disabled no-asset config", async () => {
  const recoveredWallets: string[] = [];
  const base = createConfig();
  const disabledConfig = createConfig({
    walletAddress: "orphaned-wallet",
    settings: { ...base.settings, perpsActiveSlotId: null },
  });
  const result = await runAutonomousPerpsMonitor({
    listConfigs: async () => [disabledConfig],
    listSessions: async () => [],
    getRuntimeOverride: async () => ({ killSwitchOverride: false, updatedAt: new Date().toISOString() }),
    listPendingScalpProtectionRecoveryWallets: async () => ["orphaned-wallet"],
    recoverPendingScalpProtection: async (address) => {
      recoveredWallets.push(address);
      return {
        status: "protection-pending",
        blockNewEntries: true,
        record: { recoveryId: "orphaned-recovery" },
        message: "The orphaned position is still being protected.",
      } as never;
    },
  });

  assert.deepEqual(recoveredWallets, ["orphaned-wallet"]);
  assert.equal(result.results[0]?.walletAddress, "orphaned-wallet");
  assert.equal(result.results[0]?.code, "SCALP_PROTECTION_RECOVERY_PENDING");
});

test("an unverified empty inventory cannot reconcile the wallet flat or admit a new scalp", async () => {
  const base = createConfig();
  const config = createConfig({ settings: { ...base.settings, scalpModeEnabled: true } });
  let policyMigrationCalls = 0;
  let reconciliationCalls = 0;
  let flatReconciliationCalls = 0;
  let routeCalls = 0;
  const result = await runAutonomousPerpsMonitor({
    listConfigs: async () => [config],
    listSessions: async () => [createSession()],
    getRuntimeOverride: async () => ({ killSwitchOverride: false, updatedAt: new Date().toISOString() }),
    getAgentWallet: () => "agent-wallet",
    isWalletAllowed: () => true,
    fetchSnapshot: async () => ({
      positions: [],
      pendingTriggers: [],
      recentTrades: [],
      readEvidence: {
        liveApiSucceeded: true,
        rpcSucceeded: false,
        authoritativePositionAbsence: false,
      },
    }),
    getUsdcBalance: async () => 100,
    ensureScalpPolicyProfile: async () => {
      policyMigrationCalls += 1;
      return qualifyingRangeLearningProfile();
    },
    reconcileLearningHistory: async () => {
      reconciliationCalls += 1;
      return 0;
    },
    reconcileNoOpenPosition: async () => {
      flatReconciliationCalls += 1;
      return [];
    },
    routeSignal: (async () => {
      routeCalls += 1;
      return { ok: true, message: "unexpected" };
    }) as unknown as RouteSignal,
  });

  assert.equal(result.results[0]?.code, "POSITION_ABSENCE_UNVERIFIED");
  assert.equal(policyMigrationCalls, 1);
  assert.equal(reconciliationCalls, 0);
  assert.equal(flatReconciliationCalls, 0);
  assert.equal(routeCalls, 0);
});

test("an unverified empty inventory fails closed when scalp policy migration cannot be verified", async () => {
  const base = createConfig();
  const config = createConfig({ settings: { ...base.settings, scalpModeEnabled: true } });
  let routeCalls = 0;
  const result = await runAutonomousPerpsMonitor({
    listConfigs: async () => [config],
    listSessions: async () => [createSession()],
    getRuntimeOverride: async () => ({ killSwitchOverride: false, updatedAt: new Date().toISOString() }),
    getAgentWallet: () => "agent-wallet",
    isWalletAllowed: () => true,
    fetchSnapshot: async () => ({
      positions: [],
      pendingTriggers: [],
      recentTrades: [],
      readEvidence: {
        liveApiSucceeded: true,
        rpcSucceeded: false,
        authoritativePositionAbsence: false,
      },
    }),
    getUsdcBalance: async () => 100,
    ensureScalpPolicyProfile: async () => {
      throw new Error("The authoritative v8 scalp rollout could not be verified after persistence.");
    },
    routeSignal: (async () => {
      routeCalls += 1;
      return { ok: true, message: "unexpected" };
    }) as unknown as RouteSignal,
  });

  assert.equal(result.ok, false);
  assert.equal(result.results[0]?.code, "MONITOR_ERROR");
  assert.match(result.results[0]?.message ?? "", /authoritative v8 scalp rollout/i);
  assert.equal(routeCalls, 0);
});

test("pending scalp protection recovery runs while the wallet is clocked out and kill switch is on", async () => {
  let recoveryCalls = 0;
  const result = await runAutonomousPerpsMonitor({
    listConfigs: async () => [createConfig()],
    listSessions: async () => [],
    getRuntimeOverride: async () => ({ killSwitchOverride: true, updatedAt: new Date().toISOString() }),
    recoverPendingScalpProtection: async () => {
      recoveryCalls += 1;
      return {
        status: "protection-pending",
        blockNewEntries: true,
        record: { recoveryId: "clocked-out-recovery" },
        message: "Protection recovery is still pending.",
      } as never;
    },
  });

  assert.equal(recoveryCalls, 1);
  assert.equal(result.results[0]?.code, "SCALP_PROTECTION_RECOVERY_PENDING");
});

test("monitor fails closed before scanning when scalp protection recovery cannot be verified", async () => {
  let snapshotReads = 0;
  const result = await runAutonomousPerpsMonitor({
    listConfigs: async () => [createConfig()],
    listSessions: async () => [createSession()],
    getRuntimeOverride: async () => ({ killSwitchOverride: false, updatedAt: new Date().toISOString() }),
    getAgentWallet: () => "agent-wallet",
    isWalletAllowed: () => true,
    recoverPendingScalpProtection: async () => {
      throw new Error("authoritative recovery store unavailable");
    },
    fetchSnapshot: async () => {
      snapshotReads += 1;
      return { positions: [], pendingTriggers: [], recentTrades: [] };
    },
  });

  assert.equal(result.results[0]?.code, "SCALP_PROTECTION_RECOVERY_UNAVAILABLE");
  assert.equal(snapshotReads, 0);
});

test("server monitor routes the established $12 low-balance order", async () => {
  let routedSignal: PerpsAgentSignal | null = null;
  const baseTime = 1_784_174_800_000;
  const points = [100, 100.2, 100.4, 100.8, 101.4, 102].map((value, index) => ({
    t: baseTime + index * 60_000,
    v: value,
  }));

  const result = await runAutonomousPerpsMonitor({
    listConfigs: async () => [createConfig()],
    listSessions: async () => [createSession()],
    getRuntimeOverride: async () => ({ killSwitchOverride: false, updatedAt: new Date().toISOString() }),
    fetchCandles: async () => points,
    fetchSnapshot: async () => ({ positions: [], pendingTriggers: [], recentTrades: [] }),
    getUsdcBalance: async () => 20,
    routeSignal: (async (_wallet: string, signal: PerpsAgentSignal) => {
      routedSignal = signal;
      return { ok: true, message: "submitted", execution: { status: "submitted" } };
    }) as unknown as RouteSignal,
    reconcileNoOpenPosition: async () => [],
    getAgentWallet: () => "agent-wallet",
    isWalletAllowed: () => true,
    readLastSignal: async () => null,
    writeLastSignal: async () => undefined,
  });

  assert.equal(result.results[0]?.status, "executed");
  assert.equal((routedSignal as PerpsAgentSignal | null)?.collateralUsd, 12);
  assert.equal((routedSignal as PerpsAgentSignal | null)?.marketContext?.availableUsdc, 20);
});

test("smart monitoring applies adaptive leverage and real 25% TP / 25% SL", async () => {
  let routedSignal: PerpsAgentSignal | null = null;
  const baseTime = 1_784_174_800_000;
  const points = [100, 100.2, 100.4, 100.8, 101.4, 102].map((value, index) => ({
    t: baseTime + index * 60_000,
    v: value,
  }));
  const base = createConfig();
  const config = createConfig({
    settings: {
      ...base.settings,
      walletPercent: 80,
      perpsLeverage: 10,
      perpsExecutionMode: "smart-trades",
      smartTradeProfile: "aggressive",
    },
  });
  const legacyFixture = createLearningProfile();
  const profile: DecisionLearningProfile = {
    ...legacyFixture,
    strategyBaselineVersion: 3,
    minimumConfidence: 0.68,
    leverageFloor: 2,
    leverageCap: 20,
    leverageQualityExponent: 2.5,
    leverageVolatilityPenalty: 1.25,
    leverageLossStepdown: 1,
    maximumAllocationPercent: 50,
    targetWalletRiskPercent: 3,
    takeProfitRoePercent: 25,
    stopLossRoePercent: 15,
    assetAdjustments: {
      ...legacyFixture.assetAdjustments,
      SOL: { trendThreshold: 0.5, breakoutPercent: 0.3, leverageMultiplier: 1, allocationMultiplier: 1 },
    },
  };

  const result = await runAutonomousPerpsMonitor({
    listConfigs: async () => [config],
    listSessions: async () => [createSession()],
    getRuntimeOverride: async () => ({ killSwitchOverride: false, updatedAt: new Date().toISOString() }),
    fetchCandles: async () => points,
    fetchSnapshot: async () => ({ positions: [], pendingTriggers: [], recentTrades: [] }),
    getUsdcBalance: async () => 100,
    routeSignal: (async (_wallet: string, signal: PerpsAgentSignal) => {
      routedSignal = signal;
      return { ok: true, message: "submitted", execution: { status: "submitted" } };
    }) as unknown as RouteSignal,
    reconcileNoOpenPosition: async () => [],
    getAgentWallet: () => "agent-wallet",
    isWalletAllowed: () => true,
    getLearningProfile: async () => profile,
    reconcileLearningHistory: async () => 0,
    autoTrain: async () => undefined,
    readLastSignal: async () => null,
    writeLastSignal: async () => undefined,
  });

  const routed = routedSignal as PerpsAgentSignal | null;
  assert.equal(result.results[0]?.status, "executed");
  assert.ok((routed?.leverage ?? 0) >= 2 && (routed?.leverage ?? 0) <= 20);
  assert.ok((routed?.collateralUsd ?? 0) <= 12);
  const entryPrice = points.at(-1)?.v ?? 0;
  const leverage = routed?.leverage ?? 1;
  assert.ok(Math.abs((((routed?.takeProfitPrice ?? 0) - entryPrice) / entryPrice) * leverage * 100 - 25) < 0.01);
  assert.ok(Math.abs(((entryPrice - (routed?.stopLossPrice ?? 0)) / entryPrice) * leverage * 100 - 25) < 0.01);
});

test("server monitor fails closed when an agent position is already open", async () => {
  let routeCalls = 0;
  let profitLockState: PerpsProfitLockState | null = null;
  const result = await runAutonomousPerpsMonitor({
    listConfigs: async () => [createConfig()],
    listSessions: async () => [createSession()],
    getRuntimeOverride: async () => ({ killSwitchOverride: false, updatedAt: new Date().toISOString() }),
    fetchCandles: async () => [],
    fetchSnapshot: async () => ({ positions: [createOpenPosition(10)], pendingTriggers: [], recentTrades: [] }),
    getUsdcBalance: async () => 100,
    routeSignal: (async () => {
      routeCalls += 1;
      return { ok: true, message: "unexpected" };
    }) as unknown as RouteSignal,
    reconcileNoOpenPosition: async () => [],
    getAgentWallet: () => "agent-wallet",
    isWalletAllowed: () => true,
    readProfitLockState: async () => profitLockState,
    writeProfitLockState: async (_address, state) => {
      profitLockState = state;
    },
    readLastSignal: async () => null,
    writeLastSignal: async () => undefined,
  });

  assert.equal(routeCalls, 0);
  assert.equal(result.results[0]?.code, "POSITION_ALREADY_OPEN");
});

test("server monitor closes the first-tier profit lock at 10% even with pending TP and SL", async () => {
  let profitLockState: PerpsProfitLockState | null = null;
  let closeCalls = 0;
  const run = (roePercent: number) => runAutonomousPerpsMonitor({
    listConfigs: async () => [createConfig()],
    listSessions: async () => [createSession()],
    getRuntimeOverride: async () => ({ killSwitchOverride: false, updatedAt: new Date().toISOString() }),
    fetchCandles: async () => [],
    fetchSnapshot: (async () => ({
      positions: [createOpenPosition(roePercent)],
      pendingTriggers: [
        { kind: "take-profit", positionPubkey: "position-pubkey" },
        { kind: "stop-loss", positionPubkey: "position-pubkey" },
      ],
      recentTrades: [],
    })) as never,
    getUsdcBalance: async () => 100,
    routeSignal: (async () => ({ ok: true, message: "unexpected" })) as unknown as RouteSignal,
    reconcileNoOpenPosition: async () => [],
    getAgentWallet: () => "agent-wallet",
    isWalletAllowed: () => true,
    closePosition: async () => {
      closeCalls += 1;
      return { txid: "first-tier-profit-lock-close-tx" };
    },
    readProfitLockState: async () => profitLockState,
    writeProfitLockState: async (_address, state) => {
      profitLockState = state;
    },
    readLastSignal: async () => null,
    writeLastSignal: async () => undefined,
  });

  const armed = await run(16);
  assert.equal(armed.results[0]?.code, "POSITION_PROFIT_LOCK_ARMED");
  assert.match(armed.results[0]?.message ?? "", /10% or lower/);
  assert.equal(closeCalls, 0);

  const held = await run(12);
  assert.equal(held.results[0]?.code, "POSITION_PROFIT_LOCK_ARMED");
  assert.equal(closeCalls, 0);

  const closed = await run(10);
  assert.equal(closed.results[0]?.code, "PROFIT_LOCK_CLOSE_SUBMITTED");
  assert.equal(closeCalls, 1);
  assert.equal((profitLockState as PerpsProfitLockState | null)?.activeTier, "fifteen-to-ten");
});

test("server monitor applies the 10-to-7 staircase only to an open scalp position", async () => {
  let profitLockState: PerpsProfitLockState | null = null;
  let closeCalls = 0;
  const base = createConfig();
  const scalpConfig = createConfig({
    settings: {
      ...base.settings,
      scalpModeEnabled: true,
    },
  });
  const run = (roePercent: number) => runAutonomousPerpsMonitor({
    listConfigs: async () => [scalpConfig],
    listSessions: async () => [createSession()],
    getRuntimeOverride: async () => ({ killSwitchOverride: false, updatedAt: new Date().toISOString() }),
    fetchCandles: async () => [],
    fetchSnapshot: async () => ({
      positions: [createOpenPosition(roePercent)],
      pendingTriggers: [],
      recentTrades: [],
    }),
    getUsdcBalance: async () => 100,
    routeSignal: (async () => ({ ok: true, message: "unexpected" })) as unknown as RouteSignal,
    reconcileNoOpenPosition: async () => [],
    getAgentWallet: () => "agent-wallet",
    isWalletAllowed: () => true,
    closePosition: async () => {
      closeCalls += 1;
      return { txid: "scalp-staircase-close-tx" };
    },
    readProfitLockState: async () => profitLockState,
    writeProfitLockState: async (_address, state) => {
      profitLockState = state;
    },
    readLastSignal: async () => null,
    writeLastSignal: async () => undefined,
  });

  const armed = await run(11);
  assert.equal(armed.results[0]?.code, "POSITION_PROFIT_LOCK_ARMED");
  assert.match(armed.results[0]?.message ?? "", /7% or lower/);
  assert.equal((profitLockState as PerpsProfitLockState | null)?.strategyClass, "scalp");
  assert.equal((profitLockState as PerpsProfitLockState | null)?.activeTier, "ten-to-seven");

  const held = await run(8);
  assert.equal(held.results[0]?.code, "POSITION_PROFIT_LOCK_ARMED");
  assert.equal(closeCalls, 0);

  const closed = await run(7);
  assert.equal(closed.results[0]?.code, "PROFIT_LOCK_CLOSE_SUBMITTED");
  assert.equal(closeCalls, 1);
  assert.equal((profitLockState as PerpsProfitLockState | null)?.closeTxid, "scalp-staircase-close-tx");
});

test("server monitor recovers a completed-candle scalp peak before evaluating the staircase", async () => {
  const base = createConfig();
  const config = createConfig({ settings: { ...base.settings, scalpModeEnabled: true } });
  const points = qualifyingRangePoints().map((point, index, all) => (
    index === all.length - 1 ? { ...point, h: 100.8, v: 100.6 } : point
  ));
  let closeCalls = 0;
  const previousState: PerpsProfitLockState = {
    positionPubkey: "position-pubkey",
    episodeId: "test-episode:position-pubkey",
    strategyClass: "scalp",
    peakRoePercent: 6,
    activeTier: null,
    protectedExitRoePercent: null,
    armedAt: null,
    closeTxid: null,
    closeSubmittedAt: null,
    updatedAt: points[0]!.t - 60_000,
  };

  const result = await runAutonomousPerpsMonitor({
    listConfigs: async () => [config],
    listSessions: async () => [createSession()],
    getRuntimeOverride: async () => ({ killSwitchOverride: false, updatedAt: new Date().toISOString() }),
    fetchCandles: async () => points,
    fetchSnapshot: async () => ({
      positions: [createOpenPosition(6, { entryPrice: 100, leverage: 20, side: "long" })],
      pendingTriggers: [],
      recentTrades: [],
    }),
    getUsdcBalance: async () => 100,
    closePosition: async () => {
      closeCalls += 1;
      return { txid: "completed-candle-lock" };
    },
    getAgentWallet: () => "agent-wallet",
    isWalletAllowed: () => true,
    readProfitLockState: async () => previousState,
    writeProfitLockState: async () => undefined,
    getClosedScalpOutcomes: async () => [],
  });

  assert.equal(closeCalls, 1);
  assert.equal(result.results[0]?.code, "PROFIT_LOCK_CLOSE_SUBMITTED");
});

test("profit-lock peak recovery uses candles for each position's own market", async () => {
  const base = createConfig();
  const config = createConfig({ settings: { ...base.settings, scalpModeEnabled: true } });
  const baseTime = 1_787_100_000_000;
  const requestedProducts: string[] = [];
  let closeCalls = 0;
  const previousState: PerpsProfitLockState = {
    positionPubkey: "btc-position",
    strategyClass: "scalp",
    peakRoePercent: 6,
    activeTier: null,
    protectedExitRoePercent: null,
    armedAt: null,
    closeTxid: null,
    closeSubmittedAt: null,
    updatedAt: baseTime - 60_000,
  };

  await runAutonomousPerpsMonitor({
    listConfigs: async () => [config],
    listSessions: async () => [createSession()],
    getRuntimeOverride: async () => ({ killSwitchOverride: false, updatedAt: new Date().toISOString() }),
    fetchCandles: async (product) => {
      requestedProducts.push(product);
      if (product === "BTC-USD") {
        return [
          { t: baseTime, v: 59_990, h: 60_010, l: 59_980 },
          { t: baseTime + 60_000, v: 59_985, h: 60_005, l: 59_975 },
        ];
      }
      // Applying these SOL prices to the BTC short would fabricate an enormous
      // favorable peak and immediately submit a false profit-lock close.
      return [
        { t: baseTime, v: 80, h: 81, l: 79 },
        { t: baseTime + 60_000, v: 80.5, h: 81.5, l: 79.5 },
      ];
    },
    fetchSnapshot: async () => ({
      positions: [createOpenPosition(6, {
        id: "btc-position",
        accountRef: "btc-position",
        marketSymbol: "BTC",
        marketName: "Bitcoin Perps",
        side: "short",
        entryPrice: 60_000,
        markPrice: 59_985,
        leverage: 20,
        positionValue: 2_000,
        collateralValue: 100,
      })],
      pendingTriggers: [],
      recentTrades: [],
    }),
    getUsdcBalance: async () => 100,
    closePosition: async () => {
      closeCalls += 1;
      return { txid: "must-not-close" };
    },
    getAgentWallet: () => "agent-wallet",
    isWalletAllowed: () => true,
    readProfitLockState: async () => previousState,
    writeProfitLockState: async () => undefined,
    getClosedScalpOutcomes: async () => [],
  });

  assert.equal(closeCalls, 0);
  assert.ok(requestedProducts.includes("BTC-USD"));
});

test("a newly observed position cannot arm from favorable candles that predate its tracking boundary", async () => {
  const base = createConfig();
  const config = createConfig({ settings: { ...base.settings, scalpModeEnabled: true } });
  const points = qualifyingRangePoints().map((point, index) => (
    index === 10 ? { ...point, h: 101.5 } : point
  ));
  let closeCalls = 0;
  let writtenState: PerpsProfitLockState | null = null;

  const result = await runAutonomousPerpsMonitor({
    listConfigs: async () => [config],
    listSessions: async () => [createSession()],
    getRuntimeOverride: async () => ({ killSwitchOverride: false, updatedAt: new Date().toISOString() }),
    fetchCandles: async () => points,
    fetchSnapshot: async () => ({
      positions: [createOpenPosition(6, { entryPrice: 100, leverage: 20, side: "long" })],
      pendingTriggers: [],
      recentTrades: [],
    }),
    getUsdcBalance: async () => 100,
    closePosition: async () => {
      closeCalls += 1;
      return { txid: "must-not-close" };
    },
    getAgentWallet: () => "agent-wallet",
    isWalletAllowed: () => true,
    readProfitLockState: async () => null,
    writeProfitLockState: async (_address, state) => { writtenState = state; },
  });

  assert.equal(closeCalls, 0);
  assert.equal((writtenState as PerpsProfitLockState | null)?.peakRoePercent, 6);
  assert.notEqual(result.results[0]?.code, "PROFIT_LOCK_CLOSE_SUBMITTED");
});

test("server monitor closes an armed profitable position at 15% even with pending TP and SL", async () => {
  let profitLockState: PerpsProfitLockState | null = null;
  let closeCalls = 0;
  const run = (roePercent: number) => runAutonomousPerpsMonitor({
    listConfigs: async () => [createConfig()],
    listSessions: async () => [createSession()],
    getRuntimeOverride: async () => ({ killSwitchOverride: false, updatedAt: new Date().toISOString() }),
    fetchCandles: async () => [],
    fetchSnapshot: (async () => ({
      positions: [createOpenPosition(roePercent)],
      pendingTriggers: [
        { kind: "take-profit", positionPubkey: "position-pubkey" },
        { kind: "stop-loss", positionPubkey: "position-pubkey" },
      ],
      recentTrades: [],
    })) as never,
    getUsdcBalance: async () => 100,
    routeSignal: (async () => ({ ok: true, message: "unexpected" })) as unknown as RouteSignal,
    reconcileNoOpenPosition: async () => [],
    getAgentWallet: () => "agent-wallet",
    isWalletAllowed: () => true,
    closePosition: async (_address, position) => {
      closeCalls += 1;
      assert.equal(position.accountRef, "position-pubkey");
      return { txid: "profit-lock-close-tx" };
    },
    readProfitLockState: async () => profitLockState,
    writeProfitLockState: async (_address, state) => {
      profitLockState = state;
    },
    readLastSignal: async () => null,
    writeLastSignal: async () => undefined,
  });

  const armed = await run(22);
  assert.equal(armed.results[0]?.code, "POSITION_PROFIT_LOCK_ARMED");
  assert.match(armed.results[0]?.message ?? "", /15% or lower/);
  assert.equal(closeCalls, 0);

  const closed = await run(15);
  assert.equal(closed.results[0]?.status, "executed");
  assert.equal(closed.results[0]?.code, "PROFIT_LOCK_CLOSE_SUBMITTED");
  assert.equal(closeCalls, 1);
  assert.equal((profitLockState as PerpsProfitLockState | null)?.closeTxid, "profit-lock-close-tx");
});

test("server monitor clears stale profit-lock state after the position closes", async () => {
  let clearCalls = 0;
  await runAutonomousPerpsMonitor({
    listConfigs: async () => [createConfig()],
    listSessions: async () => [createSession()],
    getRuntimeOverride: async () => ({ killSwitchOverride: false, updatedAt: new Date().toISOString() }),
    fetchCandles: async () => [],
    fetchSnapshot: async () => ({ positions: [], pendingTriggers: [], recentTrades: [] }),
    getUsdcBalance: async () => 100,
    routeSignal: (async () => ({ ok: true, message: "unexpected" })) as unknown as RouteSignal,
    reconcileNoOpenPosition: async () => [],
    getAgentWallet: () => "agent-wallet",
    isWalletAllowed: () => true,
    clearProfitLockState: async () => {
      clearCalls += 1;
    },
    getLearningProfile: async () => null,
    reconcileLearningHistory: async () => 0,
    readLastSignal: async () => null,
    writeLastSignal: async () => undefined,
  });

  assert.equal(clearCalls, 1);
});

test("set-parameter monitoring uses saved settings while still loading learning history", async () => {
  let routedSignal: PerpsAgentSignal | null = null;
  let learningLoads = 0;
  const baseTime = 1_784_174_800_000;
  const points = [100, 100, 99.95, 99.9, 99.8].map((value, index) => ({
    t: baseTime + index * 60_000,
    v: value,
  }));
  const base = createConfig();
  const config = createConfig({
    settings: {
      ...base.settings,
      walletPercent: 80,
      perpsLeverage: 50,
      perpsTakeProfitValue: 4,
      stopLossPercent: 2,
      perpsExecutionMode: "set-parameters",
    },
    params: {
      trendWindow: 15,
      trendThreshold: 0.1,
      breakoutPercent: 0.3,
      cooldownSeconds: 180,
    },
  });

  const result = await runAutonomousPerpsMonitor({
    listConfigs: async () => [config],
    listSessions: async () => [createSession()],
    getRuntimeOverride: async () => ({ killSwitchOverride: false, updatedAt: new Date().toISOString() }),
    fetchCandles: async () => points,
    fetchSnapshot: async () => ({ positions: [], pendingTriggers: [], recentTrades: [] }),
    getUsdcBalance: async () => 100,
    routeSignal: (async (_wallet: string, signal: PerpsAgentSignal) => {
      routedSignal = signal;
      return { ok: true, message: "submitted", execution: { status: "submitted" } };
    }) as unknown as RouteSignal,
    reconcileNoOpenPosition: async () => [],
    getAgentWallet: () => "agent-wallet",
    isWalletAllowed: () => true,
    getLearningProfile: async () => {
      learningLoads += 1;
      return createLearningProfile();
    },
    reconcileLearningHistory: async () => 0,
    autoTrain: async () => undefined,
    readLastSignal: async () => null,
    writeLastSignal: async () => undefined,
  });

  const routed = routedSignal as PerpsAgentSignal | null;
  assert.equal(result.results[0]?.status, "executed");
  assert.equal(learningLoads, 1);
  assert.equal(routed?.collateralUsd, 80);
  assert.equal(routed?.leverage, 50);
  assert.equal(routed?.strategyContext?.trendWindow, 15);
  assert.equal(routed?.strategyContext?.trendThreshold, 0.1);
  assert.equal(routed?.strategyContext?.cooldownSeconds, 180);
  assert.equal(routed?.strategyContext?.learningProfileId, null);
});

test("smart-trade monitoring retains learned confirmation controls", async () => {
  let routeCalls = 0;
  let autoTrainCalls = 0;
  const baseTime = 1_784_174_800_000;
  const points = [100, 100, 99.95, 99.9, 99.8].map((value, index) => ({
    t: baseTime + index * 60_000,
    v: value,
  }));
  const base = createConfig();
  const config = createConfig({
    settings: { ...base.settings, perpsExecutionMode: "smart-trades" },
    params: { ...base.params, trendThreshold: 0.1, breakoutPercent: 0.3 },
  });

  const result = await runAutonomousPerpsMonitor({
    listConfigs: async () => [config],
    listSessions: async () => [createSession()],
    getRuntimeOverride: async () => ({ killSwitchOverride: false, updatedAt: new Date().toISOString() }),
    fetchCandles: async () => points,
    fetchSnapshot: async () => ({ positions: [], pendingTriggers: [], recentTrades: [] }),
    getUsdcBalance: async () => 100,
    routeSignal: (async () => {
      routeCalls += 1;
      return { ok: true, message: "unexpected" };
    }) as unknown as RouteSignal,
    reconcileNoOpenPosition: async () => [],
    getAgentWallet: () => "agent-wallet",
    isWalletAllowed: () => true,
    getLearningProfile: async () => createLearningProfile(),
    reconcileLearningHistory: async () => 0,
    autoTrain: async () => { autoTrainCalls += 1; },
    readLastSignal: async () => null,
    writeLastSignal: async () => undefined,
  });

  assert.equal(routeCalls, 0);
  assert.equal(autoTrainCalls, 1);
  assert.equal(result.results[0]?.code, "LEARNED_CONFIRMATION_SKIP");
});

test("server monitor skips allocations below Jupiter's collateral minimum", async () => {
  let routeCalls = 0;
  let savedCursor = 0;
  const baseTime = 1_784_174_800_000;
  const points = [100, 100.2, 100.4, 100.8, 101.4, 102].map((value, index) => ({
    t: baseTime + index * 60_000,
    v: value,
  }));
  const base = createConfig();
  const config = createConfig({ settings: { ...base.settings, walletPercent: 80 } });

  const result = await runAutonomousPerpsMonitor({
    listConfigs: async () => [config],
    listSessions: async () => [createSession()],
    getRuntimeOverride: async () => ({ killSwitchOverride: false, updatedAt: new Date().toISOString() }),
    fetchCandles: async () => points,
    fetchSnapshot: async () => ({ positions: [], pendingTriggers: [], recentTrades: [] }),
    getUsdcBalance: async () => 6,
    routeSignal: (async () => {
      routeCalls += 1;
      return { ok: true, message: "unexpected" };
    }) as unknown as RouteSignal,
    reconcileNoOpenPosition: async () => [],
    getAgentWallet: () => "agent-wallet",
    isWalletAllowed: () => true,
    getLearningProfile: async () => null,
    reconcileLearningHistory: async () => 0,
    autoTrain: async () => undefined,
    readLastSignal: async () => null,
    writeLastSignal: async (_wallet, _asset, _strategyClass, timestamp) => {
      savedCursor = timestamp;
    },
  });

  assert.equal(routeCalls, 0);
  assert.equal(result.results[0]?.code, "COLLATERAL_BELOW_MINIMUM");
  assert.equal(savedCursor, 0, "an order that never routed must not consume the signal cooldown");
});

test("parameter candidates are skipped when the RSI indicator reaches the configured extreme", async () => {
  let routeCalls = 0;
  let savedCursor = 0;
  const baseTime = 1_784_174_800_000;
  const points = Array.from({ length: 70 }, (_, index) => {
    const close = 100 + index * 0.2;
    return {
      t: baseTime + index * 60_000,
      o: close - 0.1,
      h: close + 0.2,
      l: close - 0.2,
      v: close,
      volume: 100 + index,
    };
  });

  const result = await runAutonomousPerpsMonitor({
    listConfigs: async () => [createConfig()],
    listSessions: async () => [createSession()],
    getRuntimeOverride: async () => ({ killSwitchOverride: false, updatedAt: new Date().toISOString() }),
    fetchCandles: async () => points,
    fetchSnapshot: async () => ({ positions: [], pendingTriggers: [], recentTrades: [] }),
    getUsdcBalance: async () => 100,
    routeSignal: (async () => {
      routeCalls += 1;
      return { ok: true, message: "unexpected" };
    }) as unknown as RouteSignal,
    reconcileNoOpenPosition: async () => [],
    getAgentWallet: () => "agent-wallet",
    isWalletAllowed: () => true,
    getLearningProfile: async () => null,
    reconcileLearningHistory: async () => 0,
    autoTrain: async () => undefined,
    readLastSignal: async () => null,
    writeLastSignal: async (_wallet, _asset, _strategyClass, timestamp) => { savedCursor = timestamp; },
  });

  assert.equal(routeCalls, 0);
  assert.equal(result.results[0]?.code, "INDICATOR_RSI_VETO");
  assert.equal(savedCursor, 0, "a rejected Smart candidate does not start the post-close cooldown");
});

test("scalp monitor can route an opposite-side entry while independently managing the current position", async () => {
  const points = qualifyingRangePoints();
  const base = createConfig();
  const config = createConfig({
    settings: { ...base.settings, scalpModeEnabled: true },
    params: { ...base.params, trendWindow: 24 },
  });
  let routedSignal: PerpsAgentSignal | null = null;
  let closeCalls = 0;
  let prunedPositionPubkeys: string[] = [];

  const result = await runAutonomousPerpsMonitor({
    listConfigs: async () => [config],
    listSessions: async () => [createSession()],
    getRuntimeOverride: async () => ({ killSwitchOverride: false, updatedAt: new Date().toISOString() }),
    fetchCandles: async () => points,
    fetchLivePrice: async () => points.at(-1)?.v ?? null,
    fetchSnapshot: async () => ({
      positions: [createOpenPosition(1, {
        id: "existing-short",
        accountRef: "existing-short",
        side: "short",
        unrealizedPnl: 1,
      })],
      pendingTriggers: [],
      recentTrades: [],
    }),
    getUsdcBalance: async () => 100,
    routeSignal: (async (_wallet: string, signal: PerpsAgentSignal) => {
      routedSignal = signal;
      return { ok: true, message: "submitted", execution: { status: "submitted" } };
    }) as unknown as RouteSignal,
    closePosition: async () => {
      closeCalls += 1;
      return { txid: "unexpected-close" };
    },
    reconcileNoOpenPosition: async () => [],
    getAgentWallet: () => "agent-wallet",
    isWalletAllowed: () => true,
    getLearningProfile: async () => qualifyingRangeLearningProfile(),
    readProfitLockState: async () => null,
    writeProfitLockState: async () => undefined,
    pruneProfitLockStates: async (_wallet, activePositionPubkeys) => {
      prunedPositionPubkeys = activePositionPubkeys;
    },
    readLastSignal: async () => null,
    writeLastSignal: async () => undefined,
  });

  const routed = routedSignal as PerpsAgentSignal | null;
  assert.equal(result.results[0]?.status, "executed", JSON.stringify(result.results[0]));
  assert.equal(routed?.strategyClass, "scalp");
  assert.equal(routed?.direction, "bullish");
  assert.equal(routed?.marketContext?.hasOpenPosition, true);
  assert.equal(routed?.marketContext?.allowConcurrentPosition, true);
  assert.equal(closeCalls, 0);
  assert.deepEqual(prunedPositionPubkeys, ["existing-short"]);
});

test("scalp monitor refuses a second same-side entry instead of merging Jupiter positions", async () => {
  const points = qualifyingRangePoints();
  const base = createConfig();
  const config = createConfig({
    settings: { ...base.settings, scalpModeEnabled: true },
    params: { ...base.params, trendWindow: 24 },
  });
  let routeCalls = 0;

  const result = await runAutonomousPerpsMonitor({
    listConfigs: async () => [config],
    listSessions: async () => [createSession()],
    getRuntimeOverride: async () => ({ killSwitchOverride: false, updatedAt: new Date().toISOString() }),
    fetchCandles: async () => points,
    fetchLivePrice: async () => points.at(-1)?.v ?? null,
    fetchSnapshot: async () => ({ positions: [createOpenPosition(1)], pendingTriggers: [], recentTrades: [] }),
    getUsdcBalance: async () => 100,
    routeSignal: (async () => {
      routeCalls += 1;
      return { ok: true, message: "unexpected" };
    }) as unknown as RouteSignal,
    reconcileNoOpenPosition: async () => [],
    getAgentWallet: () => "agent-wallet",
    isWalletAllowed: () => true,
    getLearningProfile: async () => qualifyingRangeLearningProfile(),
    readProfitLockState: async () => null,
    writeProfitLockState: async () => undefined,
    readLastSignal: async () => null,
    writeLastSignal: async () => undefined,
  });

  assert.equal(result.results[0]?.code, "SAME_SIDE_POSITION_OPEN", JSON.stringify(result.results[0]));
  assert.equal(routeCalls, 0);
});

test("unconfirmed exceptional reversal cannot close an existing position or create replacement intent", async () => {
  const points = exceptionalBullishSweepPoints();
  const base = createConfig();
  const config = createConfig({
    settings: { ...base.settings, scalpModeEnabled: true },
    params: { ...base.params, trendWindow: 24 },
  });
  let routeCalls = 0;
  let closeCalls = 0;
  const savedIntents: Array<{ direction: "bullish" | "bearish"; positionPubkey: string; expiresAt: number }> = [];

  const result = await runAutonomousPerpsMonitor({
    listConfigs: async () => [config],
    listSessions: async () => [createSession()],
    getRuntimeOverride: async () => ({ killSwitchOverride: false, updatedAt: new Date().toISOString() }),
    fetchCandles: async () => points,
    fetchSnapshot: async () => ({
      positions: [createOpenPosition(-1, {
        id: "losing-short",
        accountRef: "losing-short",
        side: "short",
        unrealizedPnl: -1,
      })],
      pendingTriggers: [],
      recentTrades: [],
    }),
    getUsdcBalance: async () => 100,
    routeSignal: (async () => {
      routeCalls += 1;
      return { ok: true, message: "unexpected" };
    }) as unknown as RouteSignal,
    closePosition: async (_wallet, position) => {
      closeCalls += 1;
      assert.equal(position.accountRef, "losing-short");
      return { txid: "reversal-close" };
    },
    writePendingScalpReversal: async (_wallet, intent) => {
      savedIntents.push(intent);
    },
    reconcileNoOpenPosition: async () => [],
    getAgentWallet: () => "agent-wallet",
    isWalletAllowed: () => true,
    readProfitLockState: async () => null,
    writeProfitLockState: async () => undefined,
    readLastSignal: async () => null,
    writeLastSignal: async () => undefined,
  });

  assert.equal(result.results[0]?.code, "POSITION_ALREADY_OPEN");
  assert.equal(closeCalls, 0);
  assert.equal(routeCalls, 0);
  assert.deepEqual(savedIntents, []);
});

test("stale reversal replacement remains pending when the exceptional setup cannot execute", async () => {
  const points = exceptionalBullishSweepPoints();
  const base = createConfig();
  const config = createConfig({
    settings: { ...base.settings, scalpModeEnabled: true },
    params: { ...base.params, trendWindow: 24 },
  });
  let routedSignal: PerpsAgentSignal | null = null;
  let clearCalls = 0;

  const result = await runAutonomousPerpsMonitor({
    listConfigs: async () => [config],
    listSessions: async () => [createSession()],
    getRuntimeOverride: async () => ({ killSwitchOverride: false, updatedAt: new Date().toISOString() }),
    fetchCandles: async () => points,
    fetchSnapshot: async () => ({ positions: [], pendingTriggers: [], recentTrades: [] }),
    getUsdcBalance: async () => 100,
    routeSignal: (async (_wallet: string, signal: PerpsAgentSignal) => {
      routedSignal = signal;
      return { ok: true, message: "submitted", execution: { status: "submitted" } };
    }) as unknown as RouteSignal,
    readPendingScalpReversal: async () => ({
      positionPubkey: "closed-short",
      direction: "bullish",
      createdAt: Date.now() - 1_000,
      expiresAt: Date.now() + 60_000,
      projectedSurplusUsd: 2,
    }),
    clearPendingScalpReversal: async () => {
      clearCalls += 1;
    },
    reconcileNoOpenPosition: async () => [],
    getAgentWallet: () => "agent-wallet",
    isWalletAllowed: () => true,
    readLastSignal: async () => null,
    writeLastSignal: async () => undefined,
  });

  assert.equal(result.results[0]?.status, "skipped");
  assert.equal(result.results[0]?.code, "SCALP_REVERSAL_RECHECK_PENDING");
  assert.equal(routedSignal, null);
  assert.equal(clearCalls, 0);
});
