import crypto from "node:crypto";

import { getPerpsRuntimeOverride } from "@/lib/perps/auditLog";
import {
  getActivePerpsAsset,
  getActiveRegularPerpsAsset,
  getActiveScalpAsset,
  isPerpsAutomationEnabled,
  type PerpsAutomationConfig,
} from "@/lib/perps/automationConfig";
import { disablePerpsScalpMode, listPerpsAutomationConfigs } from "@/lib/perps/automationConfigStore";
import { assertAgentWalletSigner, getAgentWalletForOwner } from "@/lib/perps/agentWallet";
import {
  calculatePerpsPositionNetRoePercent,
  calculateScalpProfitLockStopPrice,
  estimatePerpsPeakRoeFromCompletedCandles,
  evaluatePerpsProfitLock,
  type PerpsProfitLockState,
} from "@/lib/perps/profitLock";
import { getPerpsSessionConfig, isPerpsLiveWalletAllowed } from "@/lib/perps/sessionConfig";
import { listPerpsSessions } from "@/lib/perps/sessionStore";
import type { PerpsAutomationSession, PerpsUserExecution } from "@/lib/perps/sessionTypes";
import { PerpsExecutionError } from "@/lib/perps/errors";
import { signSerializedPerpsTransaction } from "@/lib/perps/signer";
import {
  recoverPendingScalpProtectionForWallet,
  routePerpsSignalFromAutonomousMonitor,
} from "@/lib/perps/tradingAgent";
import { listPendingScalpProtectionRecoveryWalletsAuthoritative } from "@/lib/perps/scalpProtectionRecovery";
import {
  listUserPerpsExecutionsAuthoritative,
  reconcileUserExecutionsWithoutOpenPosition,
} from "@/lib/perps/userExecutionAudit";
import { getWalletUsdcBalance } from "@/lib/perps/walletBalance";
import {
  cancelScalpDirectionExperiment,
  getScalpDirectionExperiment,
  recordScalpDirectionExperimentTrade,
} from "@/lib/perps/scalpDirectionExperiment";
import {
  fetchJupiterPerpsAccountSnapshot,
  fetchJupiterPerpsTradeHistory,
  fetchJupiterPerpsTransactionStatus,
  type JupiterPerpsPendingTrigger,
  type JupiterPerpsPosition,
  type JupiterPerpsTransactionStatus,
} from "@/lib/jupiterPerps";
import {
  fetchCoinbaseLiveMarketSample,
  fetchCoinbaseLivePrice,
  fetchCoinbaseMinuteCandles,
  type CoinbaseLiveMarketSample,
} from "@/lib/price/coinbase";
import type { PricePoint } from "@/lib/price/simulated";
import { computeSignalMetrics, detectSignals, type Signal } from "@/lib/signal/engine";
import {
  BASE_INDICATOR_SETTINGS,
  computeIndicatorSnapshot,
  scoreIndicatorSnapshot,
  type IndicatorSnapshot,
  type IndicatorSettings,
} from "@/lib/signal/indicators";
import { getRedisClient } from "@/lib/server/redis";
import {
  getActiveDecisionLearningProfile,
  getActiveDecisionLearningProfileAuthoritative,
  listTradeLearningOutcomes,
  listTradeLearningOutcomesAuthoritative,
} from "@/lib/decision/learningStore";
import { getLearnedSignalParams, applyLearnedTradePlan } from "@/lib/decision/learningRuntime";
import { OPERATOR_TRAINING_BASELINE } from "@/lib/decision/operatorTrainingBaselineConstants";
import { listAllTradeDecisionRecordsAuthoritative } from "@/lib/decision/logStore";
import { reconcileTradeLearningOutcomes } from "@/lib/decision/outcomeReconciler";
import {
  ensureWalletScalpPolicyProfile,
  trainWalletDecisionProfile,
} from "@/lib/decision/trainer";
import {
  CURRENT_OUTCOME_RECONCILIATION_VERSION,
  type DecisionLearningProfile,
  type ScalpCandidate,
  type ScalpEntryPath,
  type ScalpLearningProfile,
  type TradeLearningOutcome,
} from "@/lib/decision/learningTypes";
import {
  labelMatureScalpCandidates,
  saveScalpCandidate,
} from "@/lib/decision/scalpCandidateStore";
import {
  evaluateValidatedScalpOutcomePrediction,
  predictScalpCandidateOutcome,
} from "@/lib/decision/scalpOutcomeModel";
import {
  deriveScalpEntryPath,
  getScalpCircuitDecision,
  recordScalpCircuitOutcomes,
} from "@/lib/decision/scalpCircuitStore";
import {
  DEFAULT_SCALP_LEARNING_PROFILE,
  SCALP_EXHAUSTION_LOOKBACK_MINUTES,
  SCALP_POLICY_VERSION,
  SCALP_STANDARD_COOLDOWN_SECONDS,
  SCALP_TRADE_LEVERAGE,
  scalpCandidatePathAllowsLiveSignal,
  scalpProfileAllowsLiveEntries,
  detectAdaptiveScalpSignal,
  evaluateAdaptiveScalpCandidate,
  getScalpLearningProfile,
  type RecentClosedScalpTrade,
  type ScalpCandidateEvaluation,
  type ScalpSignal,
} from "@/lib/perps/scalpEngine";
import {
  isExceptionalScalpLeverageSetup,
  resolveScalpTradeLeverage,
} from "@/lib/perps/scalpLeverage";
import {
  LOW_BALANCE_TRADE_MAX_USDC,
  LOW_BALANCE_TRADE_USD,
  MIN_PERPS_COLLATERAL_USD,
} from "@/lib/perps/scalpAllocation";
import {
  computePercentageScalpExitPlan,
  ESTIMATED_PERPS_ROUND_TRIP_FEE_RATE,
  MIN_TPSL_EXPECTED_PNL_USD,
  resolveConservativeScalpFeeRate,
  SCALP_STOP_LOSS_ROE_PERCENT,
} from "@/lib/perps/scalpExit";
import { evaluateScalpPositionPolicy } from "@/lib/perps/scalpPositionPolicy";

const MONITOR_LOCK_KEY = "brembot:perps:automation:monitor-lock";
const LAST_SIGNAL_KEY = "brembot:perps:automation:last-signal";
const LAST_RUN_KEY = "brembot:perps:automation:last-run";
const PROFIT_LOCK_STATE_KEY = "brembot:perps:automation:profit-lock";
const PROFIT_LOCK_STOP_CLAIM_KEY_PREFIX = "brembot:perps:automation:profit-lock-stop-claim:v1";
const PROFIT_LOCK_CLOSE_CLAIM_KEY_PREFIX = "brembot:perps:automation:profit-lock-close-claim:v1";
const PENDING_SCALP_REVERSAL_KEY = "brembot:perps:automation:pending-scalp-reversal:v1";
// Entry submission can include confirmed-fill and fail-closed protection retries.
// Keep the distributed lease longer than one cron interval so another worker
// cannot overlap a still-active routing cycle; successful runs release it early.
const MONITOR_LOCK_TTL_MS = 3 * 60_000;
const PENDING_SCALP_REVERSAL_TTL_MS = 3 * 60_000;
const SCALP_CIRCUIT_OUTCOME_REPLAY_LIMIT = 1_000;
const PROFIT_LOCK_STOP_CLAIM_TTL_MS = 7 * 24 * 60 * 60_000;
const localProfitLockClaims = new Map<string, string>();
export const SCALP_SIGNAL_COOLDOWN_SECONDS = SCALP_STANDARD_COOLDOWN_SECONDS;
export const SCALP_ONE_SECOND_ENTRY_INTERVAL_MS = 1_000;
export const SCALP_NEXT_CANDLE_CONFIRMATION_WINDOW_MS = 10_000;
export const SCALP_ONE_SECOND_ENTRY_MAX_WAIT_MS = SCALP_NEXT_CANDLE_CONFIRMATION_WINDOW_MS;
const SCALP_ONE_SECOND_ROUTE_RESERVE_MS = 15_000;

export type ProfitLockSideEffectClaim = {
  key: string;
  ownerToken: string;
  reservedValue: string;
};

export type ProfitLockClaimSettlement = "submitted" | "ambiguous" | "definite-failure";

export class AutonomousMonitorLeaseLostError extends Error {
  constructor(message = "The autonomous monitor lost its distributed lease before completing.") {
    super(message);
    this.name = "AutonomousMonitorLeaseLostError";
  }
}

export type AutonomousMonitorLeaseGuard = {
  signal: AbortSignal;
  assertOwned: () => void;
};

export class ProfitLockSideEffectError extends Error {
  certainty: Exclude<ProfitLockClaimSettlement, "submitted">;

  constructor(
    certainty: Exclude<ProfitLockClaimSettlement, "submitted">,
    message: string
  ) {
    super(message);
    this.name = "ProfitLockSideEffectError";
    this.certainty = certainty;
  }
}

function serializeProfitLockClaim(ownerToken: string, status: "reserved" | "submitted" | "ambiguous") {
  return JSON.stringify({ ownerToken, status });
}

function profitLockStopClaimKey(
  walletAddress: string,
  positionPubkey: string,
  episodeId: string,
  tier: NonNullable<PerpsProfitLockState["activeTier"]>
) {
  return `${PROFIT_LOCK_STOP_CLAIM_KEY_PREFIX}:${walletAddress}:${positionPubkey}:${episodeId}:${tier}`;
}

function profitLockCloseClaimKey(walletAddress: string, positionPubkey: string, episodeId: string) {
  return `${PROFIT_LOCK_CLOSE_CLAIM_KEY_PREFIX}:${walletAddress}:${positionPubkey}:${episodeId}`;
}

function submittedProfitLockClaim(key: string, ownerToken: string): ProfitLockSideEffectClaim {
  return {
    key,
    ownerToken,
    reservedValue: serializeProfitLockClaim(ownerToken, "submitted"),
  };
}

async function reserveProfitLockClaim(claimKey: string): Promise<ProfitLockSideEffectClaim | null> {
  const ownerToken = crypto.randomUUID();
  const reservedValue = serializeProfitLockClaim(ownerToken, "reserved");
  const redis = await getRedisClient().catch((error) => {
    if (process.env.REDIS_URL?.trim()) throw error;
    return null;
  });
  if (redis) {
    const claimed = await redis.set(claimKey, reservedValue, {
      NX: true,
      PX: PROFIT_LOCK_STOP_CLAIM_TTL_MS,
    });
    return claimed === "OK" ? { key: claimKey, ownerToken, reservedValue } : null;
  }
  if (process.env.REDIS_URL?.trim()) {
    throw new Error("Authoritative Redis is unavailable for the profit-lock side-effect claim.");
  }
  if (localProfitLockClaims.has(claimKey)) return null;
  localProfitLockClaims.set(claimKey, reservedValue);
  return { key: claimKey, ownerToken, reservedValue };
}

async function settleProfitLockClaim(
  claim: ProfitLockSideEffectClaim,
  settlement: ProfitLockClaimSettlement
) {
  const redis = await getRedisClient().catch((error) => {
    if (process.env.REDIS_URL?.trim()) throw error;
    return null;
  });
  if (redis) {
    const result = settlement === "definite-failure"
      ? await redis.eval(
          "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
          { keys: [claim.key], arguments: [claim.reservedValue] }
        )
      : await redis.eval(
          "if redis.call('get', KEYS[1]) == ARGV[1] then redis.call('set', KEYS[1], ARGV[2], 'PX', ARGV[3]); return 1 else return 0 end",
          {
            keys: [claim.key],
            arguments: [
              claim.reservedValue,
              serializeProfitLockClaim(claim.ownerToken, settlement),
              String(PROFIT_LOCK_STOP_CLAIM_TTL_MS),
            ],
          }
        );
    return Number(result) === 1;
  }
  if (process.env.REDIS_URL?.trim()) {
    throw new Error("Authoritative Redis is unavailable while settling the profit-lock side-effect claim.");
  }
  if (localProfitLockClaims.get(claim.key) !== claim.reservedValue) return false;
  if (settlement === "definite-failure") {
    localProfitLockClaims.delete(claim.key);
  } else {
    localProfitLockClaims.set(claim.key, serializeProfitLockClaim(claim.ownerToken, settlement));
  }
  return true;
}

export function classifyProfitLockSideEffectFailure(error: unknown): Exclude<ProfitLockClaimSettlement, "submitted"> {
  // The lease check happens immediately before submission. Losing ownership at
  // that boundary proves this worker did not invoke the external side effect.
  if (error instanceof AutonomousMonitorLeaseLostError) return "definite-failure";
  if (error instanceof ProfitLockSideEffectError) return error.certainty;
  // A concrete 4xx response means Jupiter rejected the request before it could
  // be accepted for execution. Network loss, malformed success bodies, and 5xx
  // responses remain ambiguous because the transaction may already be in flight.
  if (
    error instanceof PerpsExecutionError
    && error.code === "JUPITER_EXECUTE_FAILED"
    // Do not release on timeout-like responses (notably 408): the server may
    // have accepted the transaction before the response path failed.
    && [400, 401, 403, 404, 409, 410, 413, 415, 422, 429].includes(error.status)
  ) return "definite-failure";
  return "ambiguous";
}

function profitLockSideEffectError(
  error: unknown,
  certainty: Exclude<ProfitLockClaimSettlement, "submitted">
) {
  if (error instanceof ProfitLockSideEffectError) return error;
  return new ProfitLockSideEffectError(
    certainty,
    error instanceof Error ? error.message : "Profit-lock side effect failed."
  );
}

type AutonomousSignal = Omit<Signal, "type"> & {
  type: Signal["type"] | "scalp";
  setupType?: ScalpSignal["setupType"];
  priceActionScore?: number;
  priceActionTags?: string[];
  indicatorBypass?: boolean;
};
type StrategyClass = "smart" | "scalp";

export type ProfitLockPositionProvenance = {
  episodeId: string;
  strategyClass: StrategyClass;
  executionId: string;
  createdAt: string;
};

/**
 * A Jupiter position pubkey can be reused after a close. Its immutable strategy
 * provenance therefore comes from the newest execution episode that opened
 * that pubkey, never from the wallet's current Scalp Mode toggle.
 */
export function resolveProfitLockPositionProvenance(
  executions: PerpsUserExecution[],
  positionPubkey: string
): ProfitLockPositionProvenance | null {
  const normalizedPositionPubkey = positionPubkey.trim();
  const latest = executions
    .filter((execution) => execution.positionPubkey?.trim() === normalizedPositionPubkey)
    .sort((left, right) => {
      const createdDelta = Date.parse(right.createdAt) - Date.parse(left.createdAt);
      if (createdDelta !== 0) return createdDelta;
      const updatedDelta = Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
      if (updatedDelta !== 0) return updatedDelta;
      return right.executionId.localeCompare(left.executionId);
    })[0];
  if (!latest) return null;
  return {
    episodeId: latest.executionId,
    executionId: latest.executionId,
    // Historical/manual executions predate the optional strategy field and
    // used the Smart/manual path. Treating them as scalp would be unsafe.
    strategyClass: latest.strategyClass ?? "smart",
    createdAt: latest.createdAt,
  };
}

type PendingScalpReversal = {
  positionPubkey: string;
  direction: "bullish" | "bearish";
  createdAt: number;
  expiresAt: number;
  projectedSurplusUsd: number;
};

type MonitorExecutionResult = {
  walletAddress: string;
  asset: "SOL" | "ETH" | "BTC" | null;
  status: "executed" | "skipped" | "failed";
  code: string;
  message: string;
  signalId?: string;
};

export type AutonomousMonitorResult = {
  ok: boolean;
  locked: boolean;
  startedAt: string;
  completedAt: string;
  consecutiveFailureCount?: number;
  walletFailureStreaks?: Record<string, number>;
  configuredWallets: number;
  eligibleWallets: number;
  results: MonitorExecutionResult[];
};

type MonitorDependencies = {
  listConfigs: typeof listPerpsAutomationConfigs;
  listSessions: typeof listPerpsSessions;
  getRuntimeOverride: typeof getPerpsRuntimeOverride;
  fetchCandles: typeof fetchCoinbaseMinuteCandles;
  fetchLivePrice: (product: string) => Promise<number | null>;
  fetchLiveSample: (product: string) => Promise<CoinbaseLiveMarketSample | null>;
  monitorScalpEntryPoint: typeof monitorScalpOneSecondEntryPoint;
  fetchSnapshot: typeof fetchJupiterPerpsAccountSnapshot;
  getUsdcBalance: typeof getWalletUsdcBalance;
  routeSignal: typeof routePerpsSignalFromAutonomousMonitor;
  recoverPendingScalpProtection: typeof recoverPendingScalpProtectionForWallet;
  listPendingScalpProtectionRecoveryWallets: typeof listPendingScalpProtectionRecoveryWalletsAuthoritative;
  reconcileNoOpenPosition: typeof reconcileUserExecutionsWithoutOpenPosition;
  getAgentWallet: typeof getAgentWalletForOwner;
  isWalletAllowed: typeof isPerpsLiveWalletAllowed;
  getLearningProfile: (walletAddress: string) => Promise<DecisionLearningProfile | null>;
  getLatestClosedOutcome: (walletAddress: string) => Promise<Awaited<ReturnType<typeof listTradeLearningOutcomes>>[number] | null>;
  getClosedScalpOutcomes: (walletAddress: string) => Promise<TradeLearningOutcome[]>;
  saveScalpCandidate: typeof saveScalpCandidate;
  labelMatureScalpCandidates: typeof labelMatureScalpCandidates;
  getScalpCircuitDecision: typeof getScalpCircuitDecision;
  recordScalpCircuitOutcomes: typeof recordScalpCircuitOutcomes;
  reconcileLearningHistory: (
    walletAddress: string,
    snapshot: Awaited<ReturnType<typeof fetchJupiterPerpsAccountSnapshot>>,
    options?: { requireCompleteTradeHistory?: boolean; agentWalletAddress?: string }
  ) => Promise<number>;
  listProfitLockStates: (walletAddress: string) => Promise<PerpsProfitLockState[]>;
  autoTrain: (walletAddress: string, config: PerpsAutomationConfig) => Promise<void>;
  ensureScalpPolicyProfile: (walletAddress: string) => Promise<DecisionLearningProfile>;
  disableScalpMode: (walletAddress: string) => Promise<PerpsAutomationConfig | null>;
  closePosition: (walletAddress: string, position: JupiterPerpsPosition) => Promise<{ txid: string }>;
  getProfitLockPositionProvenance: (
    walletAddress: string,
    positionPubkey: string
  ) => Promise<ProfitLockPositionProvenance | null>;
  readProfitLockTransactionStatus: (txid: string) => Promise<JupiterPerpsTransactionStatus>;
  submitProfitLockStop: (
    walletAddress: string,
    position: JupiterPerpsPosition,
    triggerPrice: number
  ) => Promise<{ txid: string; triggerPrice: number }>;
  claimProfitLockStop: (
    walletAddress: string,
    positionPubkey: string,
    episodeId: string,
    tier: NonNullable<PerpsProfitLockState["activeTier"]>
  ) => Promise<ProfitLockSideEffectClaim | null>;
  claimProfitLockClose: (
    walletAddress: string,
    positionPubkey: string,
    episodeId: string
  ) => Promise<ProfitLockSideEffectClaim | null>;
  settleProfitLockClaim: (
    claim: ProfitLockSideEffectClaim,
    settlement: ProfitLockClaimSettlement
  ) => Promise<boolean>;
  commitFailedProfitLockClaim: (
    walletAddress: string,
    positionPubkey: string,
    claim: ProfitLockSideEffectClaim,
    nextState: PerpsProfitLockState
  ) => Promise<boolean>;
  readProfitLockState: (walletAddress: string, positionPubkey: string) => Promise<PerpsProfitLockState | null>;
  writeProfitLockState: (walletAddress: string, state: PerpsProfitLockState) => Promise<void>;
  clearProfitLockState: (walletAddress: string, positionPubkey?: string) => Promise<void>;
  pruneProfitLockStates: (walletAddress: string, activePositionPubkeys: string[]) => Promise<void>;
  readPendingScalpReversal: (walletAddress: string) => Promise<PendingScalpReversal | null>;
  writePendingScalpReversal: (walletAddress: string, intent: PendingScalpReversal) => Promise<void>;
  clearPendingScalpReversal: (walletAddress: string) => Promise<void>;
  readLastSignal: (walletAddress: string, asset: string, strategyClass: StrategyClass) => Promise<number | null>;
  writeLastSignal: (walletAddress: string, asset: string, strategyClass: StrategyClass, timestamp: number) => Promise<void>;
  getDirectionExperiment: typeof getScalpDirectionExperiment;
  cancelDirectionExperiment: typeof cancelScalpDirectionExperiment;
  recordDirectionExperimentTrade: typeof recordScalpDirectionExperimentTrade;
};

const defaultDependencies: MonitorDependencies = {
  listConfigs: listPerpsAutomationConfigs,
  listSessions: listPerpsSessions,
  getRuntimeOverride: getPerpsRuntimeOverride,
  fetchCandles: fetchCoinbaseMinuteCandles,
  fetchLivePrice: fetchCoinbaseLivePrice,
  fetchLiveSample: fetchCoinbaseLiveMarketSample,
  monitorScalpEntryPoint: monitorScalpOneSecondEntryPoint,
  fetchSnapshot: fetchJupiterPerpsAccountSnapshot,
  getUsdcBalance: getWalletUsdcBalance,
  routeSignal: routePerpsSignalFromAutonomousMonitor,
  recoverPendingScalpProtection: recoverPendingScalpProtectionForWallet,
  listPendingScalpProtectionRecoveryWallets: listPendingScalpProtectionRecoveryWalletsAuthoritative,
  reconcileNoOpenPosition: reconcileUserExecutionsWithoutOpenPosition,
  getAgentWallet: getAgentWalletForOwner,
  isWalletAllowed: isPerpsLiveWalletAllowed,
  getLearningProfile: getActiveDecisionLearningProfile,
  getLatestClosedOutcome: async (walletAddress) => {
    const outcomes = await listTradeLearningOutcomesAuthoritative(walletAddress);
    return outcomes.at(-1) ?? null;
  },
  getClosedScalpOutcomes: async (walletAddress) => {
    const outcomes = await listTradeLearningOutcomesAuthoritative(walletAddress);
    return outcomes
      .filter((outcome) => outcome.signalType === "scalp" || outcome.scalpSetupType !== null)
      .sort((left, right) => Date.parse(left.closedAt) - Date.parse(right.closedAt));
  },
  saveScalpCandidate,
  labelMatureScalpCandidates,
  getScalpCircuitDecision,
  recordScalpCircuitOutcomes,
  reconcileLearningHistory: async (walletAddress, snapshot, options) => {
    const [executions, decisions, profitLockStates] = await Promise.all([
      listUserPerpsExecutionsAuthoritative(walletAddress),
      listAllTradeDecisionRecordsAuthoritative(walletAddress),
      defaultDependencies.listProfitLockStates(walletAddress),
    ]);
    const activeProfile = await getActiveDecisionLearningProfileAuthoritative(walletAddress);
    const requiresCleanRebuild = (activeProfile?.outcomeDataVersion ?? 1) < CURRENT_OUTCOME_RECONCILIATION_VERSION;
    let learningSnapshot = snapshot;
    if (requiresCleanRebuild || options?.requireCompleteTradeHistory) {
      const agentWallet = options?.agentWalletAddress ?? getAgentWalletForOwner(walletAddress);
      if (!agentWallet) {
        throw new Error("A complete Jupiter trade-history reconciliation requires the configured autonomous wallet.");
      }
      const history = await fetchJupiterPerpsTradeHistory(agentWallet);
      learningSnapshot = mergeCompleteJupiterTradeHistoryForLearning(snapshot, history);
    }
    const outcomes = await reconcileTradeLearningOutcomes({
      walletAddress,
      executions,
      decisions,
      snapshot: learningSnapshot,
      replaceWalletHistory: requiresCleanRebuild,
      requireAuthoritative: true,
      profitLockStates,
    });
    return outcomes.length;
  },
  listProfitLockStates: async (walletAddress) => {
    const redis = await getRedisClient();
    if (!redis) return [];
    const values = await redis.hGetAll(PROFIT_LOCK_STATE_KEY);
    return Object.entries(values).flatMap(([field, raw]) => {
      if (field !== walletAddress && !field.startsWith(`${walletAddress}:`)) return [];
      try {
        const state = JSON.parse(raw) as PerpsProfitLockState;
        return state.positionPubkey ? [state] : [];
      } catch {
        return [];
      }
    });
  },
  autoTrain: async (walletAddress, config) => {
    await trainWalletDecisionProfile({
      walletAddress,
      config,
      source: "automatic",
      requireAuthoritative: config.settings.scalpModeEnabled,
    });
  },
  ensureScalpPolicyProfile: async (walletAddress) => {
    const ensured = await ensureWalletScalpPolicyProfile({ walletAddress, source: "automatic" });
    return ensured.profile;
  },
  disableScalpMode: disablePerpsScalpMode,
  getProfitLockPositionProvenance: async (walletAddress, positionPubkey) => (
    resolveProfitLockPositionProvenance(
      await listUserPerpsExecutionsAuthoritative(walletAddress),
      positionPubkey
    )
  ),
  readProfitLockTransactionStatus: fetchJupiterPerpsTransactionStatus,
  closePosition: async (walletAddress, position) => {
    let signedSerializedTxBase64: string;
    let executeSignedPerpsTransaction: typeof import("@/lib/perps/jupiterAdapter").executeSignedPerpsTransaction;
    try {
      assertAgentWalletSigner(walletAddress);
      if (!position.accountRef) throw new Error("The live Jupiter position is missing its close reference.");
      const receiveToken = position.collateralSymbol === "BTC"
        || position.collateralSymbol === "ETH"
        || position.collateralSymbol === "SOL"
        ? position.collateralSymbol
        : "USDC";
      const adapter = await import("@/lib/perps/jupiterAdapter");
      executeSignedPerpsTransaction = adapter.executeSignedPerpsTransaction;
      const built = await adapter.buildPerpsCloseTransaction(position.accountRef, receiveToken, "100");
      signedSerializedTxBase64 = signSerializedPerpsTransaction(built.serializedTxBase64).signedSerializedTxBase64;
    } catch (error) {
      // No execute request was made, so this owner may safely release its claim.
      throw profitLockSideEffectError(error, "definite-failure");
    }
    let submitted: Awaited<ReturnType<typeof executeSignedPerpsTransaction>>;
    try {
      submitted = await executeSignedPerpsTransaction("decrease-position", signedSerializedTxBase64);
    } catch (error) {
      throw profitLockSideEffectError(error, classifyProfitLockSideEffectFailure(error));
    }
    const txid = submitted.txid?.trim();
    if (!txid) {
      throw new ProfitLockSideEffectError(
        "ambiguous",
        "Jupiter did not return a profit-lock close transaction signature."
      );
    }
    return { txid };
  },
  submitProfitLockStop: async (walletAddress, position, triggerPrice) => {
    let plannedTriggerPrice: number;
    let signedSerializedTxBase64: string;
    let executeSignedPerpsTransaction: typeof import("@/lib/perps/jupiterAdapter").executeSignedPerpsTransaction;
    try {
      const agentWalletAddress = assertAgentWalletSigner(walletAddress);
      if (!position.accountRef) throw new Error("The live Jupiter position is missing its TP/SL reference.");
      const adapter = await import("@/lib/perps/jupiterAdapter");
      executeSignedPerpsTransaction = adapter.executeSignedPerpsTransaction;
      const protection = await adapter.buildPerpsTpslTransactionForSignal({
        signalId: `profit-lock-${position.accountRef}-${Date.now()}`,
        strategyId: "scalp-profit-lock",
        market: position.marketSymbol.endsWith("-PERP") ? position.marketSymbol : `${position.marketSymbol}-PERP`,
        assetMint: position.marketAddress ?? "unknown-market",
        side: position.side,
        action: "open",
        collateralUsd: Math.max(0.01, position.collateralValue ?? 0.01),
        sizeUsd: Math.max(0.01, position.positionValue ?? 0.01),
        leverage: Math.max(1, position.leverage ?? 1),
        maxSlippageBps: 100,
        takeProfit: { enabled: false, priceUsd: null },
        stopLoss: { enabled: true, priceUsd: triggerPrice },
        expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
        reason: "Fee-protected scalp profit-lock staircase",
        walletAddress: agentWalletAddress,
        source: "ui-local",
      }, agentWalletAddress, position.accountRef, 1, undefined, undefined, { requireLivePosition: true });
      const plannedStop = protection?.plannedTpsl.find((item) => item.requestType === "sl");
      if (!protection?.serializedTxBase64 || !plannedStop || plannedStop.entirePosition !== true) {
        throw new Error("Jupiter did not build the required entire-position profit-lock stop.");
      }
      plannedTriggerPrice = Number(plannedStop.triggerPrice) / 1_000_000;
      if (!Number.isFinite(plannedTriggerPrice) || Math.abs(plannedTriggerPrice - triggerPrice) > 0.000002) {
        throw new Error("Jupiter changed the requested fee-protected profit-lock stop price.");
      }
      signedSerializedTxBase64 = signSerializedPerpsTransaction(protection.serializedTxBase64).signedSerializedTxBase64;
    } catch (error) {
      // Build, validation, and signing failures are known to have happened
      // before Jupiter's execute endpoint received a signed transaction.
      throw profitLockSideEffectError(error, "definite-failure");
    }
    let submitted: Awaited<ReturnType<typeof executeSignedPerpsTransaction>>;
    try {
      submitted = await executeSignedPerpsTransaction("create-tpsl", signedSerializedTxBase64);
    } catch (error) {
      throw profitLockSideEffectError(error, classifyProfitLockSideEffectFailure(error));
    }
    const txid = submitted.txid?.trim();
    if (!txid) {
      throw new ProfitLockSideEffectError(
        "ambiguous",
        "Jupiter did not return a profit-lock stop transaction signature."
      );
    }
    return { txid, triggerPrice: plannedTriggerPrice };
  },
  claimProfitLockStop: async (walletAddress, positionPubkey, episodeId, tier) => {
    const claimKey = profitLockStopClaimKey(walletAddress, positionPubkey, episodeId, tier);
    return reserveProfitLockClaim(claimKey);
  },
  claimProfitLockClose: async (walletAddress, positionPubkey, episodeId) => {
    const claimKey = profitLockCloseClaimKey(walletAddress, positionPubkey, episodeId);
    return reserveProfitLockClaim(claimKey);
  },
  settleProfitLockClaim,
  commitFailedProfitLockClaim: async (walletAddress, positionPubkey, claim, nextState) => {
    const redis = await getRedisClient().catch((error) => {
      if (process.env.REDIS_URL?.trim()) throw error;
      return null;
    });
    if (redis) {
      const result = await redis.eval(
        "if redis.call('get', KEYS[1]) == ARGV[1] then redis.call('hset', KEYS[2], ARGV[2], ARGV[4]); redis.call('hdel', KEYS[2], ARGV[3]); redis.call('del', KEYS[1]); return 1 else return 0 end",
        {
          keys: [claim.key, PROFIT_LOCK_STATE_KEY],
          arguments: [
            claim.reservedValue,
            `${walletAddress}:${positionPubkey}`,
            walletAddress,
            JSON.stringify(nextState),
          ],
        }
      );
      return Number(result) === 1;
    }
    if (process.env.REDIS_URL?.trim()) {
      throw new Error("Authoritative Redis is unavailable while reconciling the failed profit-lock transaction.");
    }
    if (localProfitLockClaims.get(claim.key) !== claim.reservedValue) return false;
    localProfitLockClaims.delete(claim.key);
    return true;
  },
  readProfitLockState: async (walletAddress, positionPubkey) => {
    const redis = await getRedisClient();
    if (!redis) return null;
    const [raw, legacyRaw] = await Promise.all([
      redis.hGet(PROFIT_LOCK_STATE_KEY, `${walletAddress}:${positionPubkey}`),
      redis.hGet(PROFIT_LOCK_STATE_KEY, walletAddress),
    ]);
    const serialized = raw ?? legacyRaw;
    if (!serialized) return null;
    try {
      const state = JSON.parse(serialized) as PerpsProfitLockState;
      return state.positionPubkey === positionPubkey ? state : null;
    } catch {
      return null;
    }
  },
  writeProfitLockState: async (walletAddress, state) => {
    const redis = await getRedisClient();
    if (!redis) throw new Error("Redis is unavailable while saving the Perps profit lock.");
    await redis.hSet(PROFIT_LOCK_STATE_KEY, `${walletAddress}:${state.positionPubkey}`, JSON.stringify(state));
  },
  clearProfitLockState: async (walletAddress, positionPubkey) => {
    const redis = await getRedisClient();
    if (!redis) return;
    if (positionPubkey) {
      await redis.hDel(PROFIT_LOCK_STATE_KEY, `${walletAddress}:${positionPubkey}`);
      return;
    }
    const fields = await redis.hKeys(PROFIT_LOCK_STATE_KEY);
    const walletFields = fields.filter((field) => field === walletAddress || field.startsWith(`${walletAddress}:`));
    if (walletFields.length > 0) await redis.hDel(PROFIT_LOCK_STATE_KEY, walletFields);
  },
  pruneProfitLockStates: async (walletAddress, activePositionPubkeys) => {
    const redis = await getRedisClient();
    if (!redis) return;
    const activeFields = new Set(activePositionPubkeys.map((positionPubkey) => `${walletAddress}:${positionPubkey}`));
    const fields = await redis.hKeys(PROFIT_LOCK_STATE_KEY);
    // Preserve the legacy wallet-only field while a position is open so the next
    // read can migrate its peak into the new position-scoped field.
    const staleFields = fields.filter((field) => (
      field.startsWith(`${walletAddress}:`) && !activeFields.has(field)
    ));
    if (staleFields.length > 0) await redis.hDel(PROFIT_LOCK_STATE_KEY, staleFields);
  },
  readPendingScalpReversal: async (walletAddress) => {
    const redis = await getRedisClient();
    if (!redis) return null;
    const raw = await redis.hGet(PENDING_SCALP_REVERSAL_KEY, walletAddress);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as Partial<PendingScalpReversal>;
      if (
        typeof parsed.positionPubkey !== "string"
        || (parsed.direction !== "bullish" && parsed.direction !== "bearish")
        || typeof parsed.createdAt !== "number"
        || typeof parsed.expiresAt !== "number"
        || typeof parsed.projectedSurplusUsd !== "number"
      ) return null;
      return parsed as PendingScalpReversal;
    } catch {
      return null;
    }
  },
  writePendingScalpReversal: async (walletAddress, intent) => {
    const redis = await getRedisClient();
    if (!redis) throw new Error("Redis is unavailable while saving a pending scalp reversal.");
    await redis.hSet(PENDING_SCALP_REVERSAL_KEY, walletAddress, JSON.stringify(intent));
  },
  clearPendingScalpReversal: async (walletAddress) => {
    const redis = await getRedisClient();
    if (!redis) return;
    await redis.hDel(PENDING_SCALP_REVERSAL_KEY, walletAddress);
  },
  readLastSignal: async (walletAddress, asset, strategyClass) => {
    const redis = await getRedisClient();
    if (!redis) return null;
    const cursorKey = strategyClass === "scalp"
      ? `${walletAddress}:${asset}:scalp`
      : `${walletAddress}:${asset}`;
    const value = await redis.hGet(LAST_SIGNAL_KEY, cursorKey);
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  },
  writeLastSignal: async (walletAddress, asset, strategyClass, timestamp) => {
    const redis = await getRedisClient();
    if (!redis) throw new Error("Redis is unavailable while saving the autonomous signal cursor.");
    const cursorKey = strategyClass === "scalp"
      ? `${walletAddress}:${asset}:scalp`
      : `${walletAddress}:${asset}`;
    await redis.hSet(LAST_SIGNAL_KEY, cursorKey, String(timestamp));
  },
  getDirectionExperiment: getScalpDirectionExperiment,
  cancelDirectionExperiment: cancelScalpDirectionExperiment,
  recordDirectionExperimentTrade: recordScalpDirectionExperimentTrade,
};

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function computeVolatilityPercent(points: PricePoint[]) {
  const values = points.map((point) => point.v).filter((value) => Number.isFinite(value) && value > 0);
  if (values.length < 2) return 0;
  const current = values[values.length - 1] ?? 0;
  return current > 0 ? ((Math.max(...values) - Math.min(...values)) / current) * 100 : 0;
}

function computeTrendBias(points: PricePoint[]): "bullish" | "bearish" | "sideways" {
  if (points.length < 2) return "sideways";
  const first = points[0]?.v ?? 0;
  const last = points[points.length - 1]?.v ?? 0;
  if (first <= 0 || last <= 0) return "sideways";
  const change = ((last - first) / first) * 100;
  if (change >= 1) return "bullish";
  if (change <= -1) return "bearish";
  return "sideways";
}

function resolvePositionPriceAsset(position: JupiterPerpsPosition): "SOL" | "ETH" | "BTC" | null {
  const symbol = position.marketSymbol.trim().toUpperCase();
  for (const asset of ["SOL", "ETH", "BTC"] as const) {
    if (symbol === asset || symbol.startsWith(`${asset}-`) || symbol.startsWith(`${asset}/`)) {
      return asset;
    }
  }
  return null;
}

function toScalpEntryPath(path: ScalpCandidateEvaluation["candidate"]["path"]): ScalpEntryPath {
  return path === "none" ? "unknown" : path;
}

export function resolveRevalidatedScalpEntryPath(
  originalDirection: "bullish" | "bearish",
  freshEvaluation: ScalpCandidateEvaluation
): ScalpEntryPath | null {
  const freshPath = toScalpEntryPath(freshEvaluation.candidate.path);
  return freshEvaluation.signal
    && freshEvaluation.signal.direction === originalDirection
    && freshPath !== "unknown"
    && scalpCandidatePathAllowsLiveSignal(freshEvaluation.candidate.path)
    ? freshPath
    : null;
}

function scalpCandidateMetrics(
  evaluation: ScalpCandidateEvaluation,
  indicators: IndicatorSnapshot,
  volatilityPercent: number
) {
  const horizons = evaluation.candidate.regime.horizons;
  const horizon = (minutes: 5 | 15 | 60) => horizons.find((item) => item.minutes === minutes);
  const atrPercent = indicators.atrPercent ?? 0.18;
  const shadowAtrMultiplier = evaluation.candidate.path === "reversal"
    || evaluation.candidate.path === "range-reversal" ? 1.5 : 2;
  return {
    score: evaluation.candidate.score,
    atrPercent: indicators.atrPercent,
    volatilityPercent,
    netMove145mPercent: evaluation.candidate.regime.netMove145mPercent,
    range145mPercent: evaluation.candidate.regime.range145mPercent,
    regimeTrending: evaluation.candidate.regime.trending ? 1 : 0,
    regimeExhausted: evaluation.candidate.regime.exhausted ? 1 : 0,
    netMove5mPercent: horizon(5)?.netMovePercent ?? null,
    netMove15mPercent: horizon(15)?.netMovePercent ?? null,
    netMove60mPercent: horizon(60)?.netMovePercent ?? null,
    atr5mPercent: horizon(5)?.atrPercent ?? null,
    atr15mPercent: horizon(15)?.atrPercent ?? null,
    atr60mPercent: horizon(60)?.atrPercent ?? null,
    emaSpreadPercent: indicators.emaSpreadPercent,
    emaSlopePercent: indicators.emaSlopePercent,
    rsi: indicators.rsi,
    macdHistogram: indicators.macdHistogram,
    macdHistogramChange: indicators.macdHistogramChange,
    adx: indicators.adx,
    plusDi: indicators.plusDi,
    minusDi: indicators.minusDi,
    volumeRatio: indicators.volumeRatio,
    bollingerBandwidthPercent: indicators.bollingerBandwidthPercent,
    bollingerPosition: indicators.bollingerPosition,
    // Shadow candidates use the same minimum target and hard-stop geometry as
    // a standard 40x live scalp. Accepted candidates are overwritten with the
    // exact planned leverage/fee-aware trigger distances before routing.
    shadowLabelVersion: 2,
    shadowEstimatedFeeRate: ESTIMATED_PERPS_ROUND_TRIP_FEE_RATE,
    shadowTakeProfitMovePercent: clamp(atrPercent * shadowAtrMultiplier, 0.5, 1),
    shadowStopLossMovePercent: Number((SCALP_STOP_LOSS_ROE_PERCENT / SCALP_TRADE_LEVERAGE).toFixed(6)),
  };
}

async function persistScalpCandidate(input: {
  deps: Pick<MonitorDependencies, "saveScalpCandidate">;
  walletAddress: string;
  asset: "SOL" | "ETH" | "BTC";
  evaluation: ScalpCandidateEvaluation;
  indicators: IndicatorSnapshot;
  volatilityPercent: number;
  outcomeModel?: ScalpLearningProfile["outcomeModel"];
}) {
  const diagnostic = input.evaluation.candidate;
  if (!diagnostic.direction || !diagnostic.timestamp || !diagnostic.entryPrice || diagnostic.entryPrice <= 0) {
    return null;
  }
  const entryPath = toScalpEntryPath(diagnostic.path);
  const signal = input.evaluation.signal;
  const saved = await input.deps.saveScalpCandidate({
    candidateId: `${input.walletAddress}:${SCALP_POLICY_VERSION}:${input.asset}:${diagnostic.timestamp}:${entryPath}:${diagnostic.direction}`,
    walletAddress: input.walletAddress,
    policyVersion: SCALP_POLICY_VERSION,
    asset: input.asset,
    side: diagnostic.direction === "bullish" ? "long" : "short",
    entryPath,
    setupType: signal?.setupType ?? null,
    observedAt: new Date(diagnostic.timestamp).toISOString(),
    referencePrice: diagnostic.entryPrice,
    disposition: diagnostic.accepted ? "accepted" : "rejected",
    rejectionReasons: diagnostic.rejectionReasons,
    signalId: signal?.id ?? null,
    decisionId: null,
    executionId: null,
    metrics: scalpCandidateMetrics(input.evaluation, input.indicators, input.volatilityPercent),
    tags: diagnostic.tags,
  });
  if (!input.outcomeModel || input.outcomeModel.status === "insufficient-data") return saved;
  return input.deps.saveScalpCandidate({
    ...saved,
    prediction: predictScalpCandidateOutcome(input.outcomeModel, saved),
  });
}

async function rejectPersistedScalpCandidate(
  deps: Pick<MonitorDependencies, "saveScalpCandidate">,
  candidate: ScalpCandidate | null,
  reason: string,
  route?: { executionId?: string | null; decisionId?: string | null }
) {
  if (!candidate) return null;
  return deps.saveScalpCandidate({
    ...candidate,
    disposition: "rejected",
    rejectionReasons: [...new Set([...candidate.rejectionReasons, reason])],
    tags: reason.startsWith("SYSTEM_HEALTH_BLOCKED:")
      ? [...new Set([...candidate.tags, "SYSTEM_HEALTH_BLOCKED"])]
      : candidate.tags,
    executionId: route?.executionId ?? candidate.executionId ?? null,
    decisionId: route?.decisionId ?? candidate.decisionId ?? null,
  });
}

async function recordPolicyScalpOutcomes(input: {
  deps: Pick<MonitorDependencies, "recordScalpCircuitOutcomes">;
  walletAddress: string;
  outcomes: TradeLearningOutcome[];
  policyStartedAt?: string | null;
}) {
  const ordered = input.outcomes
    .filter((outcome) => outcome.signalType === "scalp" || outcome.scalpSetupType !== null)
    .sort((left, right) => Date.parse(left.closedAt) - Date.parse(right.closedAt)
      || left.outcomeId.localeCompare(right.outcomeId));
  const policyStartedAt = input.policyStartedAt ? Date.parse(input.policyStartedAt) : Number.NaN;
  if (!Number.isFinite(policyStartedAt) || !input.policyStartedAt) {
    throw new Error("Policy v8 circuit accounting requires a persisted rollout start boundary.");
  }
  const policyOutcomes = ordered
    .filter((outcome) => Date.parse(outcome.openedAt) >= policyStartedAt)
    .slice(-SCALP_CIRCUIT_OUTCOME_REPLAY_LIMIT);
  await input.deps.recordScalpCircuitOutcomes({
    walletAddress: input.walletAddress,
    policyVersion: SCALP_POLICY_VERSION,
    outcomes: policyOutcomes.map((outcome) => ({
      outcomeId: outcome.outcomeId,
      episodeId: outcome.episodeId ?? null,
      reconciliationVersion: outcome.reconciliationVersion ?? null,
      reconciledAt: outcome.createdAt,
      entryPath: deriveScalpEntryPath(outcome),
      netPnlUsd: outcome.netPnlUsd,
      closedAt: outcome.closedAt,
    })),
    requireAuthoritative: true,
  });
  return policyOutcomes;
}

export function mergeCompleteJupiterTradeHistoryForLearning(
  snapshot: Awaited<ReturnType<typeof fetchJupiterPerpsAccountSnapshot>>,
  history: Awaited<ReturnType<typeof fetchJupiterPerpsTradeHistory>>
) {
  if (!history.complete) {
    throw new Error(`Jupiter returned only ${history.trades.length} of ${history.totalCount} trades.`);
  }
  return { ...snapshot, recentTrades: history.trades };
}

export function evaluateScalpAdverseEntryDrift(input: {
  side: "long" | "short";
  referencePrice: number;
  livePrice: number;
  atrPercent: number | null | undefined;
}) {
  const atrPercent = Number.isFinite(input.atrPercent) ? Math.max(0, input.atrPercent ?? 0) : 0;
  const tolerancePercent = clamp(atrPercent * 0.5, 0.03, 0.2);
  const signedMovePercent = input.referencePrice > 0
    ? (input.livePrice - input.referencePrice) / input.referencePrice * 100
    : Number.POSITIVE_INFINITY;
  const adverseMovePercent = input.side === "long" ? -signedMovePercent : signedMovePercent;
  return {
    allowed: Number.isFinite(adverseMovePercent) && adverseMovePercent <= tolerancePercent,
    adverseMovePercent: Number(adverseMovePercent.toFixed(6)),
    tolerancePercent: Number(tolerancePercent.toFixed(6)),
  };
}

export type ScalpOneSecondEntryPointEvaluation = ReturnType<typeof evaluateScalpOneSecondEntryPoint>;

export function resolveScalpNextCandleConfirmationDeadline(signalCandleStartedAt: number) {
  return signalCandleStartedAt + 60_000 + SCALP_NEXT_CANDLE_CONFIRMATION_WINDOW_MS;
}

export function evaluateScalpOneSecondEntryPoint(input: {
  side: "long" | "short";
  referencePrice: number;
  livePrice: number;
  atrPercent: number | null | undefined;
}) {
  const drift = evaluateScalpAdverseEntryDrift(input);
  const signedMovePercent = input.referencePrice > 0
    ? (input.livePrice - input.referencePrice) / input.referencePrice * 100
    : Number.POSITIVE_INFINITY;
  const directionalMovePercent = input.side === "long" ? signedMovePercent : -signedMovePercent;
  // A live entry must confirm the completed-candle direction without chasing
  // farther than the same ATR-relative band used by the adverse-drift guard.
  const triggered = drift.allowed
    && Number.isFinite(directionalMovePercent)
    && directionalMovePercent >= 0
    && directionalMovePercent <= drift.tolerancePercent;
  return {
    triggered,
    invalidated: !drift.allowed,
    directionalMovePercent: Number(directionalMovePercent.toFixed(6)),
    adverseMovePercent: drift.adverseMovePercent,
    tolerancePercent: drift.tolerancePercent,
  };
}

export type ScalpOneSecondEntryMonitorResult = {
  status: "triggered" | "invalidated" | "expired" | "unavailable";
  price: number | null;
  observedAt: number | null;
  samples: number;
  confirmations?: number;
  requiredConfirmations?: number;
  spreadBps?: number | null;
  tradeImbalance?: number | null;
  evaluation: ScalpOneSecondEntryPointEvaluation | null;
};

export async function monitorScalpOneSecondEntryPoint(options: {
  side: "long" | "short";
  referencePrice: number;
  atrPercent: number | null | undefined;
  fetchPrice: () => Promise<number | null>;
  fetchSample?: () => Promise<CoinbaseLiveMarketSample | null>;
  deadlineAt?: number;
  maxWaitMs?: number;
  intervalMs?: number;
  now?: () => number;
  wait?: (milliseconds: number) => Promise<void>;
  assertActive?: () => void;
  requiredConfirmations?: number;
  confirmationWindow?: number;
  maximumSpreadBps?: number;
  maximumOpposingTradeImbalance?: number;
}): Promise<ScalpOneSecondEntryMonitorResult> {
  const now = options.now ?? Date.now;
  const wait = options.wait ?? ((milliseconds: number) => new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  }));
  const intervalMs = Math.max(1, options.intervalMs ?? SCALP_ONE_SECOND_ENTRY_INTERVAL_MS);
  const startedAt = now();
  const deadlineAt = Math.min(
    options.deadlineAt ?? Number.POSITIVE_INFINITY,
    startedAt + Math.max(0, options.maxWaitMs ?? SCALP_ONE_SECOND_ENTRY_MAX_WAIT_MS)
  );
  const windowAlreadyClosed = startedAt > deadlineAt;
  let samples = 0;
  let sawUsablePrice = false;
  let lastPrice: number | null = null;
  let lastObservedAt: number | null = null;
  let lastEvaluation: ScalpOneSecondEntryPointEvaluation | null = null;
  let lastSpreadBps: number | null = null;
  let lastTradeImbalance: number | null = null;
  const requiredConfirmations = Math.max(1, options.requiredConfirmations ?? 3);
  const confirmationWindow = Math.max(requiredConfirmations, options.confirmationWindow ?? 5);
  const maximumSpreadBps = Math.max(0, options.maximumSpreadBps ?? 12);
  const maximumOpposingTradeImbalance = clamp(options.maximumOpposingTradeImbalance ?? 0.35, 0, 1);
  const confirmationHistory: boolean[] = [];

  while (now() <= deadlineAt) {
    options.assertActive?.();
    const sampleStartedAt = now();
    const marketSample = options.fetchSample
      ? await options.fetchSample().catch(() => null)
      : null;
    const price = marketSample?.price ?? await options.fetchPrice().catch(() => null);
    const observedAt = now();
    samples += 1;
    if (typeof price === "number" && Number.isFinite(price) && price > 0) {
      sawUsablePrice = true;
      lastPrice = price;
      lastObservedAt = observedAt;
      lastSpreadBps = marketSample?.spreadBps ?? null;
      lastTradeImbalance = marketSample?.tradeImbalance ?? null;
      lastEvaluation = evaluateScalpOneSecondEntryPoint({
        side: options.side,
        referencePrice: options.referencePrice,
        livePrice: price,
        atrPercent: options.atrPercent,
      });
      if (lastEvaluation.invalidated) {
        return {
          status: "invalidated",
          price,
          observedAt,
          samples,
          confirmations: confirmationHistory.filter(Boolean).length,
          requiredConfirmations,
          spreadBps: lastSpreadBps,
          tradeImbalance: lastTradeImbalance,
          evaluation: lastEvaluation,
        };
      }
      const spreadAllowed = lastSpreadBps === null || lastSpreadBps <= maximumSpreadBps;
      const flowAllowed = lastTradeImbalance === null
        || (options.side === "long"
          ? lastTradeImbalance >= -maximumOpposingTradeImbalance
          : lastTradeImbalance <= maximumOpposingTradeImbalance);
      confirmationHistory.push(lastEvaluation.triggered && spreadAllowed && flowAllowed);
      if (confirmationHistory.length > confirmationWindow) confirmationHistory.shift();
      const confirmations = confirmationHistory.filter(Boolean).length;
      if (confirmations >= requiredConfirmations) {
        return {
          status: "triggered",
          price,
          observedAt,
          samples,
          confirmations,
          requiredConfirmations,
          spreadBps: lastSpreadBps,
          tradeImbalance: lastTradeImbalance,
          evaluation: lastEvaluation,
        };
      }
    }

    const remainingMs = deadlineAt - now();
    if (remainingMs <= 0) break;
    const elapsedMs = Math.max(0, now() - sampleStartedAt);
    await wait(Math.min(remainingMs, Math.max(0, intervalMs - elapsedMs)));
    options.assertActive?.();
  }

  return {
    status: windowAlreadyClosed || sawUsablePrice ? "expired" : "unavailable",
    price: lastPrice,
    observedAt: lastObservedAt,
    samples,
    confirmations: confirmationHistory.filter(Boolean).length,
    requiredConfirmations,
    spreadBps: lastSpreadBps,
    tradeImbalance: lastTradeImbalance,
    evaluation: lastEvaluation,
  };
}

export function detectScalpSignal(options: {
  symbol: string;
  points: PricePoint[];
  indicators: IndicatorSnapshot;
  cooldownSeconds: number;
  recentClosedTrade?: RecentClosedScalpTrade | null;
}): AutonomousSignal | null {
  return detectAdaptiveScalpSignal({
    symbol: options.symbol,
    points: options.points,
    indicators: options.indicators,
    profile: {
      ...structuredClone(DEFAULT_SCALP_LEARNING_PROFILE),
      cooldownSeconds: options.cooldownSeconds,
    },
    recentClosedTrade: options.recentClosedTrade,
  });
}

function getIndicatorSettings(profile: DecisionLearningProfile | null): IndicatorSettings {
  const learned = profile?.indicatorSettings;
  return learned ? {
    ...BASE_INDICATOR_SETTINGS,
    ...learned,
  } : BASE_INDICATOR_SETTINGS;
}

function getCollateralPercent(config: PerpsAutomationConfig, availableUsdc: number) {
  if (availableUsdc <= 0) return 0;
  return config.settings.walletAllocationMode === "usd"
    ? clamp((config.settings.walletPercent / availableUsdc) * 100, 0, 100)
    : clamp(config.settings.walletPercent, 1, 100);
}

export function resolveAutonomousCollateralUsd(availableUsdc: number, collateralPercent: number) {
  const configuredCollateralUsd = Number((availableUsdc * collateralPercent / 100).toFixed(6));
  if (availableUsdc < LOW_BALANCE_TRADE_USD) {
    return Math.min(configuredCollateralUsd, MIN_PERPS_COLLATERAL_USD - 0.000001);
  }
  if (availableUsdc < LOW_BALANCE_TRADE_MAX_USDC) {
    return LOW_BALANCE_TRADE_USD;
  }
  return configuredCollateralUsd;
}

export function resolveScalpProbationCollateralPercent(
  availableUsdc: number,
  standardCollateralPercent: number,
  probation: boolean
) {
  if (!probation || availableUsdc < LOW_BALANCE_TRADE_MAX_USDC) return standardCollateralPercent;
  const probationPercent = Number((standardCollateralPercent * 0.5).toFixed(2));
  const probationCollateralUsd = availableUsdc * probationPercent / 100;
  // A qualified live setup must not disappear merely because half sizing would
  // fall below the venue minimum. Keep normal sizing until the wallet can fund
  // a genuinely smaller Jupiter-compatible probation order.
  return probationCollateralUsd >= MIN_PERPS_COLLATERAL_USD
    ? probationPercent
    : standardCollateralPercent;
}

function deriveTradePlan(config: PerpsAutomationConfig, points: PricePoint[], signal: AutonomousSignal, availableUsdc: number) {
  const baseCollateralPercent = getCollateralPercent(config, availableUsdc);
  const volatilityPercent = computeVolatilityPercent(points);
  if (config.settings.perpsExecutionMode !== "smart-trades" || config.settings.decisionMode === "shadow") {
    return {
      collateralPercent: baseCollateralPercent,
      leverage: config.settings.perpsLeverage,
      stopLossPercent: config.settings.stopLossPercent,
      takeProfitPercent: config.settings.perpsTakeProfitMode === "percent" ? config.settings.perpsTakeProfitValue : 0,
      volatilityPercent,
    };
  }

  const profile = {
    conservative: { collateralBase: 0.4, leverageBase: 0.3, defaultTp: 0.9, defaultSl: 1.5, leverageCapMultiplier: 0.45 },
    balanced: { collateralBase: 0.65, leverageBase: 0.5, defaultTp: 1.5, defaultSl: 3.5, leverageCapMultiplier: 0.65 },
    aggressive: { collateralBase: 0.8, leverageBase: 1.35, defaultTp: 3, defaultSl: 7, leverageCapMultiplier: 2 },
  }[config.settings.smartTradeProfile];
  const smartTradeBaseLeverage = OPERATOR_TRAINING_BASELINE.leverageCap;
  const volatilityFactor = clamp(volatilityPercent / 2.5, 0, 1.35);
  const confidenceBias = clamp((signal.confidence - 0.55) / 0.35, -0.5, 1);
  const collateralPercent = clamp(
    baseCollateralPercent * (profile.collateralBase + confidenceBias * 0.18 - volatilityFactor * 0.16),
    Math.min(5, baseCollateralPercent),
    100
  );
  const leverage = clamp(
    smartTradeBaseLeverage * (profile.leverageBase + confidenceBias * 0.12 - volatilityFactor * 0.14),
    1,
    Math.min(250, Math.max(1, smartTradeBaseLeverage * profile.leverageCapMultiplier))
  );
  const baseTp = config.settings.perpsTakeProfitMode === "percent" && config.settings.perpsTakeProfitValue > 0
    ? config.settings.perpsTakeProfitValue
    : profile.defaultTp;
  const baseSl = config.settings.stopLossPercent > 0 ? config.settings.stopLossPercent : profile.defaultSl;

  return {
    collateralPercent: Number(collateralPercent.toFixed(2)),
    leverage: Number(leverage.toFixed(2)),
    stopLossPercent: Number(clamp(baseSl * (1 + volatilityFactor * 0.18 - confidenceBias * 0.06), 0.2, 5).toFixed(2)),
    takeProfitPercent: Number(clamp(baseTp * (1 + volatilityFactor * 0.28 + confidenceBias * 0.08), 0.2, 6).toFixed(2)),
    volatilityPercent: Number(volatilityPercent.toFixed(2)),
  };
}

export function getScalpTradePlanningConfig(config: PerpsAutomationConfig): PerpsAutomationConfig {
  return {
    ...config,
    settings: {
      ...config.settings,
      perpsExecutionMode: "set-parameters",
      walletAllocationMode: "percent",
      walletPercent: 50,
      perpsLeverage: SCALP_TRADE_LEVERAGE,
      stopLossPercent: SCALP_STOP_LOSS_ROE_PERCENT,
    },
  };
}

export function computeTriggerPrices(options: {
  config: PerpsAutomationConfig;
  entryPrice: number;
  collateralUsd: number;
  leverage: number;
  side: "long" | "short";
  stopLossPercent: number;
  takeProfitPercent: number;
  takeProfitUsd?: number;
  estimatedRoundTripFeeRate?: number;
}) {
  const direction = options.side === "long" ? 1 : -1;
  const positionSizeUsd = options.collateralUsd * options.leverage;
  const requestedTakeProfitMove = typeof options.takeProfitUsd === "number"
    ? (positionSizeUsd > 0
      ? (
          Math.max(0, options.takeProfitUsd)
          + positionSizeUsd * (
            options.estimatedRoundTripFeeRate ?? ESTIMATED_PERPS_ROUND_TRIP_FEE_RATE
          )
        ) / positionSizeUsd
      : 0)
    : options.config.settings.perpsTakeProfitMode === "usd"
    ? (positionSizeUsd > 0 ? options.config.settings.perpsTakeProfitValue / positionSizeUsd : 0)
    : options.takeProfitPercent > 0 ? options.takeProfitPercent / 100 / options.leverage : 0;
  const requestedStopLossMove = options.stopLossPercent > 0 ? options.stopLossPercent / 100 / options.leverage : 0;
  const minimumTriggerMove = positionSizeUsd > 0 ? MIN_TPSL_EXPECTED_PNL_USD / positionSizeUsd : 0;
  const takeProfitMove = requestedTakeProfitMove > 0 ? Math.max(requestedTakeProfitMove, minimumTriggerMove) : 0;
  const stopLossMove = requestedStopLossMove > 0 ? Math.max(requestedStopLossMove, minimumTriggerMove) : 0;
  return {
    takeProfitPrice: takeProfitMove > 0 ? options.entryPrice * (1 + direction * takeProfitMove) : null,
    stopLossPrice: stopLossMove > 0 ? options.entryPrice * (1 - direction * stopLossMove) : null,
  };
}

export function hasMatchingEntirePositionProfitLockStop(options: {
  pendingTriggers: JupiterPerpsPendingTrigger[];
  positionPubkey: string;
  triggerPrice: number;
}) {
  return options.pendingTriggers.some((trigger) => (
    trigger.positionPubkey === options.positionPubkey
    && trigger.kind === "stop-loss"
    && trigger.entirePosition
    && !trigger.executed
    && typeof trigger.triggerPrice === "number"
    && Math.abs(trigger.triggerPrice - options.triggerPrice) <= 0.000002
  ));
}

function isProfitLockStopStrictlyProtective(position: JupiterPerpsPosition, triggerPrice: number) {
  if (
    typeof position.entryPrice !== "number"
    || !Number.isFinite(position.entryPrice)
    || position.entryPrice <= 0
    || typeof position.markPrice !== "number"
    || !Number.isFinite(position.markPrice)
    || position.markPrice <= 0
  ) return false;
  const originalStop = position.stopLoss;
  if (position.side === "long") {
    return triggerPrice > position.entryPrice
      && triggerPrice < position.markPrice
      && (typeof originalStop !== "number" || triggerPrice > originalStop);
  }
  return triggerPrice < position.entryPrice
    && triggerPrice > position.markPrice
    && (typeof originalStop !== "number" || triggerPrice < originalStop);
}

function getSessionForConfig(config: PerpsAutomationConfig, sessions: PerpsAutomationSession[]) {
  return sessions.find((session) => session.walletAddress === config.walletAddress) ?? null;
}

function skip(config: PerpsAutomationConfig, asset: "SOL" | "ETH" | "BTC" | null, code: string, message: string): MonitorExecutionResult {
  return { walletAddress: config.walletAddress, asset, status: "skipped", code, message };
}

export type AutonomousPerpsLayerTarget = {
  config: PerpsAutomationConfig;
  asset: "SOL" | "ETH" | "BTC";
  layer: "scalp" | "regular";
};

/**
 * Build independent scan targets. Scalp runs first so enabling regular Perps
 * cannot pre-empt a scalp setup; if Scalp does not submit, regular Perps still
 * gets its own scan in the same cycle. A successful submission pauses the
 * sibling target through the shared wallet-position admission lock.
 */
export function getAutonomousPerpsLayerTargets(config: PerpsAutomationConfig): AutonomousPerpsLayerTarget[] {
  const scalpAsset = getActiveScalpAsset(config);
  const regularAsset = getActiveRegularPerpsAsset(config);
  return [
    ...(scalpAsset ? [{ config, asset: scalpAsset, layer: "scalp" as const }] : []),
    ...(regularAsset ? [{ config, asset: regularAsset, layer: "regular" as const }] : []),
  ];
}

export async function runAutonomousPerpsMonitor(
  overrides: Partial<MonitorDependencies> = {},
  leaseGuard?: AutonomousMonitorLeaseGuard
): Promise<AutonomousMonitorResult> {
  const deps = { ...defaultDependencies, ...overrides };
  leaseGuard?.assertOwned();
  const startedAt = new Date().toISOString();
  const [configs, sessions, runtimeOverride] = await Promise.all([
    deps.listConfigs(),
    deps.listSessions(),
    deps.getRuntimeOverride(),
  ]);
  const globalKillSwitch = runtimeOverride.killSwitchOverride ?? getPerpsSessionConfig().globalKillSwitch;
  const enabledConfigs = configs.filter(isPerpsAutomationEnabled);
  const enabledLayerTargets = enabledConfigs.flatMap(getAutonomousPerpsLayerTargets);
  const results: MonitorExecutionResult[] = [];
  const entrySubmittedWallets = new Set<string>();
  const positionManagedWallets = new Set<string>();

  // Recovery is independent of entry eligibility. Union durable guards with
  // every configured wallet so disabling/deleting an automation config cannot
  // strand a filled scalp without TP/SL protection.
  const pendingRecoveryWallets = await deps.listPendingScalpProtectionRecoveryWallets();
  const recoveryWallets = [...new Set([
    ...pendingRecoveryWallets,
    ...configs.map((config) => config.walletAddress),
  ])];
  const recoveryBlockedWallets = new Set<string>();
  for (const walletAddress of recoveryWallets) {
    const config = configs.find((candidate) => candidate.walletAddress === walletAddress) ?? null;
    const asset = config ? getActivePerpsAsset(config) : null;
    try {
      leaseGuard?.assertOwned();
      const recovery = await deps.recoverPendingScalpProtection(walletAddress);
      if (!recovery.blockNewEntries) continue;
      recoveryBlockedWallets.add(walletAddress);
      results.push({
        walletAddress,
        asset,
        status: "skipped",
        code: recovery.status === "protected"
          || recovery.status === "position-closed"
          || recovery.status === "entry-not-found"
          ? "SCALP_PROTECTION_RECOVERY_RESOLVED"
          : "SCALP_PROTECTION_RECOVERY_PENDING",
        message: `${recovery.message} This monitor cycle will not scan or submit another entry.`,
      });
    } catch (error) {
      if (error instanceof AutonomousMonitorLeaseLostError) throw error;
      recoveryBlockedWallets.add(walletAddress);
      results.push({
        walletAddress,
        asset,
        status: "failed",
        code: "SCALP_PROTECTION_RECOVERY_UNAVAILABLE",
        message: `New entries are blocked because pending scalp protection recovery could not be verified: ${error instanceof Error ? error.message : "unknown recovery error"}`,
      });
    }
  }

  for (const target of enabledLayerTargets) {
    leaseGuard?.assertOwned();
    const { config, asset, layer } = target;
    const regularPerpsLayerEnabled = layer === "regular";
    const scalpAgentLayerEnabled = layer === "scalp";
    if (entrySubmittedWallets.has(config.walletAddress)) {
      results.push(skip(
        config,
        asset,
        "ENTRY_LAYERS_PAUSED_POSITION_OPEN",
        "The other autonomous Perps layer opened a position earlier in this monitor cycle. Both entry layers remain paused until the wallet is flat."
      ));
      continue;
    }
    const session = getSessionForConfig(config, sessions);
    if (recoveryBlockedWallets.has(config.walletAddress)) continue;
    if (!session || session.sessionState !== "clocked_in") {
      results.push(skip(config, asset, "SESSION_INACTIVE", "The autonomous Perps session is not clocked in."));
      continue;
    }
    if (session.mode !== "live" || session.executionModel !== "delegated-ready") {
      results.push(skip(config, asset, "SESSION_NOT_DELEGATED", "The session is not a delegated-ready live session."));
      continue;
    }
    if (globalKillSwitch || session.killSwitch) {
      results.push(skip(config, asset, "KILL_SWITCH", "The Perps kill switch is enabled."));
      continue;
    }
    if (!deps.isWalletAllowed(config.walletAddress)) {
      results.push(skip(config, asset, "WALLET_NOT_ALLOWED", "The primary wallet is not in the live Perps allowlist."));
      continue;
    }

    try {
      const agentWallet = deps.getAgentWallet(config.walletAddress);
      if (!agentWallet) throw new Error("No autonomous wallet is associated with this primary wallet.");
      const [snapshot, availableUsdc] = await Promise.all([
        deps.fetchSnapshot(agentWallet),
        deps.getUsdcBalance(agentWallet),
      ]);
      const openPositions = snapshot.positions.filter((position) => position.source !== "mock");
      if (
        openPositions.length === 0
        && snapshot.readEvidence?.authoritativePositionAbsence !== true
      ) {
        if (scalpAgentLayerEnabled) {
          // Scalp-policy initialization/migration only persists policy metadata;
          // it neither reconciles inventory nor admits an entry. Keep it ahead of
          // the unverified-flat guard so an older profile cannot remain stuck,
          // while the guard below continues to fail closed before any scan/route.
          await deps.ensureScalpPolicyProfile(config.walletAddress);
        }
        results.push(skip(
          config,
          asset,
          "POSITION_ABSENCE_UNVERIFIED",
          "Jupiter did not return an authoritative RPC proof that this wallet is flat; reconciliation and new scalp entries are blocked for this cycle."
        ));
        continue;
      }
      if (openPositions.length > 0 && positionManagedWallets.has(config.walletAddress)) {
        results.push(skip(
          config,
          asset,
          "ENTRY_LAYERS_PAUSED_POSITION_OPEN",
          "An autonomous Perps position is open. Both regular Perps and Scalp entry layers remain paused until the wallet is flat."
        ));
        continue;
      }
      const activePositionPubkeys = openPositions
        .map((position) => position.accountRef)
        .filter((positionPubkey): positionPubkey is string => Boolean(positionPubkey));
      if (openPositions.length > 0) {
        // Claim position management for this wallet before any side effect.
        // If management throws, the sibling entry layer must not retry the
        // same stop/close operation later in this monitor cycle.
        positionManagedWallets.add(config.walletAddress);
        await deps.pruneProfitLockStates(config.walletAddress, activePositionPubkeys);
      }
      let prefetchedClosedScalpOutcomes: TradeLearningOutcome[] | null = null;
      const profitLockPointsByAsset = new Map<"SOL" | "ETH" | "BTC", PricePoint[]>();
      if (openPositions.length > 0) {
        prefetchedClosedScalpOutcomes = await deps.getClosedScalpOutcomes(config.walletAddress).catch(() => []);
        const positionAssets = [...new Set(openPositions.flatMap((position) => {
          const positionAsset = resolvePositionPriceAsset(position);
          return positionAsset ? [positionAsset] : [];
        }))];
        const completedCandleSets = await Promise.all(positionAssets.map(async (positionAsset) => ({
          asset: positionAsset,
          points: await deps.fetchCandles(`${positionAsset}-USD`, 65).catch(() => []),
        })));
        for (const completedCandles of completedCandleSets) {
          profitLockPointsByAsset.set(completedCandles.asset, completedCandles.points);
        }
      }
      const profitLockFeeRate = resolveConservativeScalpFeeRate(prefetchedClosedScalpOutcomes ?? []);
      let pendingScalpReversal = await deps.readPendingScalpReversal(config.walletAddress);
      if (pendingScalpReversal && pendingScalpReversal.expiresAt <= Date.now()) {
        await deps.clearPendingScalpReversal(config.walletAddress);
        pendingScalpReversal = null;
      }
      if (
        pendingScalpReversal
        && openPositions.some((position) => position.accountRef === pendingScalpReversal?.positionPubkey)
      ) {
        // Position occupancy is now the only shared entry pause. Retire stale
        // replacement intents rather than allowing one layer to close or
        // replace a position while the other layer is paused.
        await deps.clearPendingScalpReversal(config.walletAddress);
        pendingScalpReversal = null;
      }

      let positionLifecycleBusy = false;
      const monitoredPositionMessages: Array<{ armed: boolean; message: string }> = [];
      for (const position of openPositions) {
        const positionPubkey = position.accountRef;
        const currentRoePercent = calculatePerpsPositionNetRoePercent(position, profitLockFeeRate);
        if (!positionPubkey || currentRoePercent === null) {
          results.push(skip(
            config,
            asset,
            "POSITION_PROFIT_LOCK_UNAVAILABLE",
            "An agent-owned position is open, but Jupiter has not returned the live position reference and collateral ROE needed for its profit lock."
          ));
          positionLifecycleBusy = true;
          break;
        }

        const provenance = await deps.getProfitLockPositionProvenance(
          config.walletAddress,
          positionPubkey
        );
        if (!provenance) {
          results.push(skip(
            config,
            asset,
            "POSITION_PROFIT_LOCK_PROVENANCE_UNAVAILABLE",
            "An open Jupiter position has no authoritative execution episode. Profit-lock stops and closes are disabled rather than inferring its strategy from current wallet settings."
          ));
          positionLifecycleBusy = true;
          break;
        }
        const storedState = await deps.readProfitLockState(config.walletAddress, positionPubkey);
        let previousState = storedState?.episodeId === provenance.episodeId
          ? storedState
          : null;
        if (
          previousState?.closeStatus === "submitted"
          && previousState.closeTxid
          && previousState.closeClaimOwnerToken
        ) {
          const closeTransactionStatus = await deps.readProfitLockTransactionStatus(previousState.closeTxid)
            .catch(() => null);
          if (closeTransactionStatus === "failed") {
            const failedClaim = submittedProfitLockClaim(
              profitLockCloseClaimKey(config.walletAddress, positionPubkey, provenance.episodeId),
              previousState.closeClaimOwnerToken
            );
            const nextState: PerpsProfitLockState = {
              ...previousState,
              closeTxid: null,
              closeSubmittedAt: null,
              closeClaimedAt: null,
              closeClaimOwnerToken: null,
              closeStatus: null,
              closeError: "The prior profit-lock close transaction failed on-chain and is eligible for retry.",
              updatedAt: Date.now(),
            };
            if (await deps.commitFailedProfitLockClaim(
              config.walletAddress,
              positionPubkey,
              failedClaim,
              nextState
            )) previousState = nextState;
          }
        }
        if (
          previousState?.onChainStopStatus === "submitted"
          && previousState.onChainStopTxid
          && previousState.onChainStopTier
          && previousState.onChainStopClaimOwnerToken
        ) {
          const stopTransactionStatus = await deps.readProfitLockTransactionStatus(previousState.onChainStopTxid)
            .catch(() => null);
          if (stopTransactionStatus === "failed") {
            const failedClaim = submittedProfitLockClaim(
              profitLockStopClaimKey(
                config.walletAddress,
                positionPubkey,
                provenance.episodeId,
                previousState.onChainStopTier
              ),
              previousState.onChainStopClaimOwnerToken
            );
            const nextState: PerpsProfitLockState = {
              ...previousState,
              onChainStopTier: null,
              onChainStopPrice: null,
              onChainStopStatus: null,
              onChainStopTxid: null,
              onChainStopAttemptedAt: null,
              onChainStopClaimOwnerToken: null,
              onChainStopError: "The prior profit-lock stop transaction failed on-chain and is eligible for retry.",
              updatedAt: Date.now(),
            };
            if (await deps.commitFailedProfitLockClaim(
              config.walletAddress,
              positionPubkey,
              failedClaim,
              nextState
            )) previousState = nextState;
          }
        }
        const previousStateUpdatedAt = previousState?.positionPubkey === positionPubkey
          && Number.isFinite(previousState.updatedAt)
          && previousState.updatedAt > 0
          ? previousState.updatedAt
          : null;
        const positionStrategyClass = provenance.strategyClass;
        const positionPriceAsset = resolvePositionPriceAsset(position);
        const profitLockPoints = positionPriceAsset
          ? profitLockPointsByAsset.get(positionPriceAsset) ?? []
          : [];
        const observedPeakRoePercent = positionStrategyClass === "scalp"
          && typeof position.entryPrice === "number"
          && Number.isFinite(position.entryPrice)
          && position.entryPrice > 0
          && typeof position.leverage === "number"
          && Number.isFinite(position.leverage)
          && position.leverage > 0
          && previousStateUpdatedAt !== null
          ? estimatePerpsPeakRoeFromCompletedCandles({
              side: position.side,
              entryPrice: position.entryPrice,
              leverage: position.leverage,
              currentRoePercent,
              points: profitLockPoints,
              since: previousStateUpdatedAt,
              estimatedRoundTripFeeRate: profitLockFeeRate,
            })
          : currentRoePercent;
        const profitLock = evaluatePerpsProfitLock({
          positionPubkey,
          episodeId: provenance.episodeId,
          currentRoePercent,
          previousState,
          strategyClass: positionStrategyClass,
          observedPeakRoePercent,
          leverage: position.leverage,
          estimatedRoundTripFeeRate: profitLockFeeRate,
        });
        let profitLockState = profitLock.state;
        await deps.writeProfitLockState(config.walletAddress, profitLockState);

        if (profitLock.action === "close") {
          const closeClaim = await deps.claimProfitLockClose(
            config.walletAddress,
            positionPubkey,
            provenance.episodeId
          );
          if (!closeClaim) {
            results.push(skip(
              config,
              asset,
              "PROFIT_LOCK_CLOSE_PENDING",
              `A market-close side effect is already claimed for execution episode ${provenance.episodeId}; this worker will not submit a duplicate full close.`
            ));
            positionLifecycleBusy = true;
            continue;
          }
          const closeClaimedAt = Date.now();
          profitLockState = {
            ...profitLockState,
            closeClaimedAt,
            closeClaimOwnerToken: closeClaim.ownerToken,
            closeStatus: "reserved",
            closeError: null,
            updatedAt: closeClaimedAt,
          };
          try {
            await deps.writeProfitLockState(config.walletAddress, profitLockState);
          } catch (error) {
            // The durable pre-submit reservation did not land, so this worker
            // proves it never reached the external close side effect.
            await deps.settleProfitLockClaim(closeClaim, "definite-failure");
            throw error;
          }
          let closed: { txid: string };
          try {
            leaseGuard?.assertOwned();
            closed = await deps.closePosition(config.walletAddress, position);
          } catch (error) {
            const settlement = classifyProfitLockSideEffectFailure(error);
            await deps.settleProfitLockClaim(closeClaim, settlement);
            const retryable = settlement === "definite-failure";
            profitLockState = {
              ...profitLockState,
              closeClaimedAt: retryable ? null : profitLockState.closeClaimedAt,
              closeClaimOwnerToken: retryable ? null : profitLockState.closeClaimOwnerToken,
              closeStatus: retryable ? null : "uncertain",
              closeError: error instanceof Error
                ? error.message
                : retryable
                  ? "Profit-lock market close was rejected before submission."
                  : "Profit-lock market close failed ambiguously.",
              updatedAt: Date.now(),
            };
            await deps.writeProfitLockState(config.walletAddress, profitLockState);
            throw error;
          }
          await deps.settleProfitLockClaim(closeClaim, "submitted");
          profitLockState = {
            ...profitLockState,
            closeTxid: closed.txid,
            closeSubmittedAt: Date.now(),
            closeStatus: "submitted",
            closeError: null,
            updatedAt: Date.now(),
          };
          await deps.writeProfitLockState(config.walletAddress, profitLockState);
          results.push({
            walletAddress: config.walletAddress,
            asset,
            status: "executed",
            code: "PROFIT_LOCK_CLOSE_SUBMITTED",
            message: `Profit lock closed the position after ROE retreated to ${currentRoePercent.toFixed(2)}% from a ${profitLockState.peakRoePercent.toFixed(2)}% peak. Close transaction: ${closed.txid}.`,
          });
          positionLifecycleBusy = true;
          continue;
        }

        if (profitLock.action === "close-pending") {
          results.push(skip(
            config,
            asset,
            "PROFIT_LOCK_CLOSE_PENDING",
            `A profit-lock close is already pending for this position after its ${profitLockState.peakRoePercent.toFixed(2)}% peak.`
          ));
          positionLifecycleBusy = true;
          continue;
        }

        if (
          profitLock.action === "armed"
          && profitLock.strategyClass === "scalp"
          && profitLock.activeTier
          && typeof position.entryPrice === "number"
          && typeof position.leverage === "number"
        ) {
          const desiredStopPrice = calculateScalpProfitLockStopPrice({
            side: position.side,
            entryPrice: position.entryPrice,
            leverage: position.leverage,
            exitNetRoePercent: profitLock.exitRoePercent,
            estimatedRoundTripFeeRate: profitLockFeeRate,
          });
          if (desiredStopPrice) {
            const visibleOnChain = hasMatchingEntirePositionProfitLockStop({
              pendingTriggers: snapshot.pendingTriggers,
              positionPubkey,
              triggerPrice: desiredStopPrice,
            });
            const sameTierReserved = profitLockState.onChainStopTier === profitLock.activeTier
              && profitLockState.onChainStopPrice === desiredStopPrice
              && profitLockState.onChainStopStatus !== null;
            if (visibleOnChain) {
              profitLockState = {
                ...profitLockState,
                onChainStopTier: profitLock.activeTier,
                onChainStopPrice: desiredStopPrice,
                onChainStopStatus: "confirmed",
                onChainStopError: null,
                updatedAt: Date.now(),
              };
              await deps.writeProfitLockState(config.walletAddress, profitLockState);
            } else if (
              !sameTierReserved
              && isProfitLockStopStrictlyProtective(position, desiredStopPrice)
            ) {
              // This separate Redis NX claim is the external-side-effect
              // idempotency key. A stale global monitor lease or overlapping
              // worker cannot submit the same position/tier stop twice even if
              // both workers read the pre-reservation profit-lock state.
              const stopClaim = await deps.claimProfitLockStop(
                config.walletAddress,
                positionPubkey,
                provenance.episodeId,
                profitLock.activeTier
              );
              if (stopClaim) {
                const attemptedAt = Date.now();
                profitLockState = {
                  ...profitLockState,
                  onChainStopTier: profitLock.activeTier,
                  onChainStopPrice: desiredStopPrice,
                  onChainStopStatus: "reserved",
                  onChainStopTxid: null,
                  onChainStopAttemptedAt: attemptedAt,
                  onChainStopClaimOwnerToken: stopClaim.ownerToken,
                  onChainStopError: null,
                  updatedAt: attemptedAt,
                };
                try {
                  await deps.writeProfitLockState(config.walletAddress, profitLockState);
                } catch (error) {
                  // No stop submission is allowed until its durable intent is
                  // saved. A failed save therefore releases only this owner.
                  await deps.settleProfitLockClaim(stopClaim, "definite-failure");
                  throw error;
                }
                try {
                  leaseGuard?.assertOwned();
                  const submitted = await deps.submitProfitLockStop(
                    config.walletAddress,
                    position,
                    desiredStopPrice
                  );
                  await deps.settleProfitLockClaim(stopClaim, "submitted");
                  profitLockState = {
                    ...profitLockState,
                    onChainStopPrice: submitted.triggerPrice,
                    onChainStopStatus: "submitted",
                    onChainStopTxid: submitted.txid,
                    onChainStopError: null,
                    updatedAt: Date.now(),
                  };
                } catch (error) {
                  const settlement = classifyProfitLockSideEffectFailure(error);
                  await deps.settleProfitLockClaim(stopClaim, settlement);
                  const retryable = settlement === "definite-failure";
                  profitLockState = {
                    ...profitLockState,
                    onChainStopTier: retryable ? null : profitLockState.onChainStopTier,
                    onChainStopPrice: retryable ? null : profitLockState.onChainStopPrice,
                    onChainStopStatus: retryable ? null : "uncertain",
                    onChainStopTxid: retryable ? null : profitLockState.onChainStopTxid,
                    onChainStopAttemptedAt: retryable ? null : profitLockState.onChainStopAttemptedAt,
                    onChainStopClaimOwnerToken: retryable
                      ? null
                      : profitLockState.onChainStopClaimOwnerToken,
                    onChainStopError: error instanceof Error ? error.message : "Profit-lock stop submission failed.",
                    updatedAt: Date.now(),
                  };
                }
                await deps.writeProfitLockState(config.walletAddress, profitLockState);
              }
            }
          }
        }
        monitoredPositionMessages.push({
          armed: profitLock.action === "armed",
          message: profitLock.action === "armed"
            ? `${position.side} profit lock is armed at a ${profitLockState.peakRoePercent.toFixed(2)}% peak and will close if live ROE reaches ${profitLock.exitRoePercent}% or lower.${profitLockState.onChainStopStatus === "confirmed" || profitLockState.onChainStopStatus === "submitted" ? ` An entire-position on-chain stop is ${profitLockState.onChainStopStatus} at $${profitLockState.onChainStopPrice?.toFixed(4)}.` : " Market-close polling remains active."}`
            : `${position.side} ${profitLock.strategyClass === "scalp" ? "Scalp" : "Smart Trade"} remains independently managed at ${currentRoePercent.toFixed(2)}% ROE.`,
        });
      }
      if (positionLifecycleBusy) continue;
      if (openPositions.length > 0) {
        const profitLockArmed = monitoredPositionMessages.some((item) => item.armed);
        results.push(skip(
          config,
          asset,
          profitLockArmed ? "POSITION_PROFIT_LOCK_ARMED" : "ENTRY_LAYERS_PAUSED_POSITION_OPEN",
          `${monitoredPositionMessages.map((item) => item.message).join(" ")} Both regular Perps and Scalp entry layers remain paused until the wallet is flat.`
        ));
        continue;
      }
      if (scalpAgentLayerEnabled) {
        // Scalp v8 circuit accounting and fee estimates must be based on the
        // authoritative, freshly reconciled outcome set. Never admit a new
        // scalp entry after a failed reconciliation.
        await deps.reconcileLearningHistory(config.walletAddress, snapshot, {
          requireCompleteTradeHistory: true,
          agentWalletAddress: agentWallet,
        });
      } else {
        await deps.reconcileLearningHistory(config.walletAddress, snapshot).catch(() => 0);
      }
      // Keep the just-closed position's staircase tier and peak available until
      // outcome reconciliation has copied that exit provenance into training.
      if (openPositions.length === 0) await deps.clearProfitLockState(config.walletAddress);
      if (scalpAgentLayerEnabled) {
        // Initialize the stable rollout first, then consume/review authoritative
        // scalp outcomes independently of Smart Trade execution mode.
        await deps.ensureScalpPolicyProfile(config.walletAddress);
        await deps.autoTrain(config.walletAddress, config);
      } else if (
        regularPerpsLayerEnabled
        && config.settings.perpsExecutionMode === "smart-trades"
        && config.settings.decisionMode === "active"
      ) {
        // This initializes/migrates the researched baseline, immediately consumes newly closed
        // outcomes, and performs the trainer's interval-gated full holdout pass when due.
        await deps.autoTrain(config.walletAddress, config).catch(() => undefined);
      }
      const learningProfile = scalpAgentLayerEnabled
        ? await deps.ensureScalpPolicyProfile(config.walletAddress)
        : await deps.getLearningProfile(config.walletAddress);
      const executionProfile = regularPerpsLayerEnabled
        && config.settings.perpsExecutionMode === "smart-trades"
        && config.settings.decisionMode === "active"
        ? learningProfile
        : null;
      const scalpProfile = getScalpLearningProfile(learningProfile);
      const closedScalpOutcomes = scalpAgentLayerEnabled
        ? await deps.getClosedScalpOutcomes(config.walletAddress)
        : prefetchedClosedScalpOutcomes
          ?? await deps.getClosedScalpOutcomes(config.walletAddress).catch(() => []);
      let scalpCircuitReconciliationError: string | null = null;
      if (scalpAgentLayerEnabled && scalpProfile.policyVersion === SCALP_POLICY_VERSION) {
        try {
          await recordPolicyScalpOutcomes({
            deps,
            walletAddress: config.walletAddress,
            outcomes: closedScalpOutcomes,
            policyStartedAt: scalpProfile.policyRollout?.startedAt ?? null,
          });
        } catch (error) {
          // Keep market diagnostics alive so a circuit-storage incident cannot
          // make missed candidates invisible. Execution remains fail-closed
          // until the authoritative circuit projection is healthy again.
          scalpCircuitReconciliationError = error instanceof Error
            ? error.message
            : "Authoritative scalp-circuit reconciliation failed.";
        }
      }
      const estimatedScalpFeeRate = resolveConservativeScalpFeeRate(closedScalpOutcomes);
      const effectiveParams = getLearnedSignalParams(config, asset, executionProfile);
      const points = await deps.fetchCandles(
        `${asset}-USD`,
        Math.max(SCALP_EXHAUSTION_LOOKBACK_MINUTES + 65, effectiveParams.trendWindow + 35)
      );
      if (openPositions.length === 0) await deps.reconcileNoOpenPosition(config.walletAddress);
      if (availableUsdc === null || availableUsdc <= 0) {
        results.push(skip(config, asset, "NO_COLLATERAL", "The autonomous wallet has no available USDC collateral."));
        continue;
      }

      const latestTimestamp = points[points.length - 1]?.t ?? 0;
      const windowStart = latestTimestamp - effectiveParams.trendWindow * 60_000;
      const windowPoints = points.filter((point) => point.t >= windowStart);
      const scalpPoints = points.slice(-Math.max(SCALP_EXHAUSTION_LOOKBACK_MINUTES, 60));
      const layerHasSufficientMarketData = regularPerpsLayerEnabled
        ? windowPoints.length >= 3
        : scalpPoints.length >= 3;
      if (!layerHasSufficientMarketData) {
        if (monitoredPositionMessages.length > 0) {
          results.push(skip(
            config,
            asset,
            monitoredPositionMessages.some((item) => item.armed)
              ? "POSITION_PROFIT_LOCK_ARMED"
              : "POSITION_ALREADY_OPEN",
            `${monitoredPositionMessages.map((item) => item.message).join(" ")} Additional entry scanning is waiting for sufficient completed market candles.`
          ));
          continue;
        }
        results.push(skip(
          config,
          asset,
          "INSUFFICIENT_MARKET_DATA",
          regularPerpsLayerEnabled
            ? `Regular Perps requires at least three completed candles inside its ${effectiveParams.trendWindow}-minute trend window.`
            : "Scalp Agent did not receive enough completed candles for its independent setup history."
        ));
        continue;
      }
      const latestClosedOutcome = await deps.getLatestClosedOutcome(config.walletAddress)
        .catch(() => closedScalpOutcomes.at(-1) ?? null);
      const latestClosedAt = latestClosedOutcome
        ? Date.parse(latestClosedOutcome.closedAt)
        : Number.NaN;
      const postCloseCooldownSeconds = scalpAgentLayerEnabled
        ? scalpProfile.cooldownSeconds
        : effectiveParams.cooldownSeconds;
      const postCloseCooldownLabel = postCloseCooldownSeconds === SCALP_SIGNAL_COOLDOWN_SECONDS
        ? "seven-minute"
        : `${postCloseCooldownSeconds}-second`;
      const smartVolatilityPercent = computeVolatilityPercent(windowPoints);
      const scalpVolatilityPercent = computeVolatilityPercent(scalpPoints);
      const signalMetrics = computeSignalMetrics(windowPoints);
      const smartSignalCandidate = regularPerpsLayerEnabled
        ? detectSignals({
            symbol: `${asset}/USD`,
            points: windowPoints,
            params: effectiveParams,
          })[0]
        : null;
      const smartSignal = regularPerpsLayerEnabled
        ? detectSignals({
            symbol: `${asset}/USD`,
            points: windowPoints,
            params: {
              ...effectiveParams,
              cooldownSeconds: postCloseCooldownSeconds,
            },
            lastSignalAt: Number.isFinite(latestClosedAt) ? latestClosedAt : undefined,
          })[0]
        : null;
      const indicatorSettings = getIndicatorSettings(learningProfile);
      const indicators = computeIndicatorSnapshot(points, indicatorSettings);
      const indicatorsReady = indicators.emaFast !== null
        && indicators.emaSlow !== null
        && indicators.rsi !== null
        && indicators.macdHistogram !== null
        && indicators.adx !== null;
      const smartIndicatorScore = smartSignal
        ? scoreIndicatorSnapshot(indicators, smartSignal.direction, indicatorSettings)
        : null;
      const breakoutMetric = Math.abs(signalMetrics.breakoutChange) >= effectiveParams.breakoutPercent
        ? signalMetrics.breakoutChange
        : signalMetrics.shortMomentum;
      const trendDirection = signalMetrics.trend.changePercent >= 0 ? "bullish" : "bearish";
      const breakoutDirection = breakoutMetric >= 0 ? "bullish" : "bearish";
      const smartLearningConfirmed = !smartSignal || !executionProfile || (
        Math.abs(signalMetrics.trend.changePercent) >= effectiveParams.trendThreshold
        && Math.abs(breakoutMetric) >= effectiveParams.breakoutPercent * 0.6
        && trendDirection === breakoutDirection
        && smartSignal.direction === trendDirection
      );
      const smartDirectionAllowed = !smartSignal
        || !executionProfile
        || executionProfile.preferredDirection === "balanced"
        || smartSignal.direction === executionProfile.preferredDirection;
      const smartEligible = Boolean(
        regularPerpsLayerEnabled
        && smartSignal
        && (!indicatorsReady || smartIndicatorScore?.qualified)
        && smartLearningConfirmed
        && smartDirectionAllowed
      );
      const scalpValidationPaused = scalpAgentLayerEnabled
        && !scalpProfileAllowsLiveEntries(scalpProfile);
      if (scalpAgentLayerEnabled) {
        await deps.labelMatureScalpCandidates({
          walletAddress: config.walletAddress,
          points,
          policyVersion: SCALP_POLICY_VERSION,
          evaluatedAt: latestTimestamp,
        }).catch(() => []);
      }
      const scalpEvaluation = scalpAgentLayerEnabled && !scalpValidationPaused
        ? evaluateAdaptiveScalpCandidate({
            symbol: `${asset}/USD`,
            points: scalpPoints,
            indicators,
            profile: scalpProfile,
            recentClosedTrade: latestClosedOutcome
              ? {
                  openedAt: Date.parse(latestClosedOutcome.openedAt),
                  closedAt: Date.parse(latestClosedOutcome.closedAt),
                  side: latestClosedOutcome.side,
                  netPnlUsd: latestClosedOutcome.netPnlUsd,
                }
              : null,
          })
        : null;
      let scalpCandidateRecord = scalpEvaluation
        ? await persistScalpCandidate({
            deps,
            walletAddress: config.walletAddress,
            asset,
            evaluation: scalpEvaluation,
            indicators,
            volatilityPercent: scalpVolatilityPercent,
            outcomeModel: scalpProfile.outcomeModel,
          })
        : null;
      const outcomePrediction = scalpCandidateRecord?.prediction;
      const outcomeAdmission = evaluateValidatedScalpOutcomePrediction({
        modelStatus: scalpProfile.outcomeModel?.status,
        prediction: outcomePrediction,
      });
      const profitableProbability = outcomeAdmission.profitableProbability;
      const outcomeModelRejected = !outcomeAdmission.allowed;
      if (outcomeModelRejected && scalpCandidateRecord && outcomePrediction) {
        scalpCandidateRecord = await rejectPersistedScalpCandidate(
          deps,
          scalpCandidateRecord,
          `The validated outcome model estimated ${(profitableProbability! * 100).toFixed(1)}% profitable follow-through and ${(outcomePrediction.fullSl * 100).toFixed(1)}% full-SL risk.`
        );
      }
      const scalpSignal = outcomeModelRejected ? null : scalpEvaluation?.signal ?? null;
      let directionExperiment = scalpAgentLayerEnabled
        ? await deps.getDirectionExperiment(config.walletAddress)
        : null;
      if (
        scalpProfile.policyVersion === SCALP_POLICY_VERSION
        && directionExperiment?.enabled
        && directionExperiment.tradesRemaining > 0
      ) {
        // Policy v8 deliberately retired the inverse-direction experiment. It
        // contradicted the detector/indicator evidence, could be vetoed by the
        // independent decision layer, and then consumed a full scalp cooldown.
        // Persistently cancel stale state before signal selection or routing.
        await deps.cancelDirectionExperiment(config.walletAddress);
        directionExperiment = null;
      }
      const directionExperimentActive = Boolean(
        scalpAgentLayerEnabled
        && directionExperiment?.enabled
        && directionExperiment.tradesRemaining > 0
      );
      const signal = directionExperimentActive
        ? scalpSignal
        : openPositions.length > 0
          ? scalpSignal
          : smartEligible ? smartSignal! : scalpSignal;
      const strategyClass = directionExperimentActive
        ? "scalp" as const
        : openPositions.length > 0
          ? "scalp" as const
          : smartEligible ? "smart" as const : "scalp" as const;
      if (strategyClass === "smart" && scalpCandidateRecord?.disposition === "accepted") {
        scalpCandidateRecord = await rejectPersistedScalpCandidate(
          deps,
          scalpCandidateRecord,
          "A qualifying Smart Trade took priority over this simultaneous scalp candidate."
        );
      }
      if (strategyClass === "scalp" && scalpCircuitReconciliationError) {
        const reason = `SYSTEM_HEALTH_BLOCKED: ${scalpCircuitReconciliationError}`;
        scalpCandidateRecord = await rejectPersistedScalpCandidate(
          deps,
          scalpCandidateRecord,
          reason
        );
        results.push({
          walletAddress: config.walletAddress,
          asset,
          status: "failed",
          code: "SCALP_CIRCUIT_RECONCILIATION_FAILED",
          message: `${reason} Candidate diagnostics completed, but no scalp entry was submitted.`,
        });
        continue;
      }
      if (!signal) {
        if (pendingScalpReversal) {
          results.push(skip(
            config,
            asset,
            "SCALP_REVERSAL_RECHECK_PENDING",
            "The original position has closed. The scalp agent is waiting for the exceptional opposite-side setup to remain qualified before opening its replacement."
          ));
          continue;
        }
        if (monitoredPositionMessages.length > 0) {
          results.push(skip(
            config,
            asset,
            monitoredPositionMessages.some((item) => item.armed)
              ? "POSITION_PROFIT_LOCK_ARMED"
              : "POSITION_ALREADY_OPEN",
            `${monitoredPositionMessages.map((item) => item.message).join(" ")} No additional qualifying scalp signal was detected.`
          ));
          continue;
        }
        if (directionExperimentActive && directionExperiment) {
          results.push(skip(
            config,
            asset,
            "NO_SIGNAL",
            `Opposite-direction scalp experiment is waiting for a qualifying scalp setup; ${directionExperiment.tradesCompleted}/${directionExperiment.maxTrades} submitted, ${directionExperiment.tradesRemaining} remaining.`
          ));
          continue;
        }
        const smartRejectedByIndicators = smartSignal && indicatorsReady && !smartIndicatorScore?.qualified;
        const smartRejectedByDirection = smartSignal && !smartDirectionAllowed;
        const smartRejectedByLearning = smartSignal && !smartLearningConfirmed;
        results.push(skip(
          config,
          asset,
          smartRejectedByIndicators
            ? smartIndicatorScore?.vetoed ? "INDICATOR_RSI_VETO" : "INDICATOR_CONFIRMATION_SKIP"
            : smartRejectedByDirection ? "LEARNED_DIRECTION_SKIP"
              : smartRejectedByLearning ? "LEARNED_CONFIRMATION_SKIP"
                : smartSignalCandidate ? "SMART_SIGNAL_COOLDOWN"
                  : scalpValidationPaused ? "SCALP_VALIDATION_PAUSED"
                    : "NO_SIGNAL",
          smartRejectedByIndicators
            ? smartIndicatorScore?.vetoed
              ? `The ${smartSignal.direction} Smart candidate was skipped by the RSI extreme veto, and no qualifying scalp/reversal setup replaced it.`
              : `The Smart candidate scored ${smartIndicatorScore?.score.toFixed(1)} indicator points, and no qualifying scalp/reversal setup replaced it.`
            : smartRejectedByDirection
              ? `The Smart candidate opposed the trained Smart direction, and no qualifying independent scalp/reversal setup replaced it.`
              : smartRejectedByLearning
                ? "The Smart candidate lacked matching trend and breakout confirmation, and no qualifying independent scalp/reversal setup replaced it."
                : smartSignalCandidate
                  ? `A Smart candidate was inside the ${postCloseCooldownLabel} post-close cooldown; Scalp Mode remains enabled, but no qualifying independent scalp/reversal setup was detected.`
                : scalpValidationPaused
                  ? "Scalp Mode is paused because its winner-derived profile has not passed loss-history validation."
                  : regularPerpsLayerEnabled && scalpAgentLayerEnabled
                    ? "No qualifying Smart, range scalp, or candle-structure reversal signal was detected in the latest window."
                    : scalpAgentLayerEnabled
                      ? "No qualifying range scalp or candle-structure reversal signal was detected in the latest window."
                      : "No qualifying Smart signal was detected in the latest candle window."
        ));
        continue;
      }
      const scalpMetadata = strategyClass === "scalp" ? signal as ScalpSignal : null;
      let scalpEntryPath = strategyClass === "scalp" && scalpEvaluation
        ? toScalpEntryPath(scalpEvaluation.candidate.path)
        : null;
      if (
        pendingScalpReversal
        && (strategyClass !== "scalp" || signal.direction !== pendingScalpReversal.direction)
      ) {
        scalpCandidateRecord = await rejectPersistedScalpCandidate(
          deps,
          scalpCandidateRecord,
          "The candidate no longer matches the pending reversal direction after the original position closed."
        );
        results.push(skip(
          config,
          asset,
          "SCALP_REVERSAL_RECHECK_PENDING",
          "The original position has closed, but the exceptional opposite-side setup must still qualify in the same direction before the replacement trade can open."
        ));
        continue;
      }
      const strategyVolatilityPercent = strategyClass === "scalp"
        ? scalpVolatilityPercent
        : smartVolatilityPercent;
      const activeRiskProfile = strategyClass === "scalp" ? learningProfile : executionProfile;
      if (activeRiskProfile && strategyVolatilityPercent > activeRiskProfile.volatilityCeilingPercent) {
        scalpCandidateRecord = await rejectPersistedScalpCandidate(
          deps,
          scalpCandidateRecord,
          `Current ${strategyVolatilityPercent.toFixed(2)}% volatility exceeds the learned ${activeRiskProfile.volatilityCeilingPercent.toFixed(2)}% ceiling.`
        );
        results.push(skip(config, asset, "LEARNED_VOLATILITY_SKIP", `Current ${strategyVolatilityPercent.toFixed(2)}% volatility exceeds the trained ${activeRiskProfile.volatilityCeilingPercent.toFixed(2)}% ceiling.`));
        continue;
      }
      const indicatorScore = strategyClass === "scalp"
        ? scoreIndicatorSnapshot(indicators, signal.direction, indicatorSettings)
        : smartIndicatorScore!;
      let routingIndicators = indicators;
      let routingIndicatorScore = indicatorScore;
      if (strategyClass === "smart" && config.settings.mode === "buy-only" && signal.direction === "bearish") {
        scalpCandidateRecord = await rejectPersistedScalpCandidate(
          deps,
          scalpCandidateRecord,
          "Buy-only mode rejected the bearish scalp candidate."
        );
        results.push(skip(config, asset, "BUY_ONLY_SKIP", "Buy-only mode skipped the bearish Perps signal."));
        continue;
      }
      if (strategyClass === "scalp" && scalpEntryPath) {
        let circuit: Awaited<ReturnType<typeof getScalpCircuitDecision>>;
        try {
          circuit = await deps.getScalpCircuitDecision({
            walletAddress: config.walletAddress,
            policyVersion: SCALP_POLICY_VERSION,
            entryPath: scalpEntryPath,
            requireAuthoritative: true,
          });
        } catch (error) {
          const reason = `SYSTEM_HEALTH_BLOCKED: ${error instanceof Error ? error.message : "Authoritative scalp-circuit state is unavailable."}`;
          scalpCandidateRecord = await rejectPersistedScalpCandidate(deps, scalpCandidateRecord, reason);
          results.push({
            walletAddress: config.walletAddress,
            asset,
            status: "failed",
            code: "SCALP_CIRCUIT_STATE_UNAVAILABLE",
            message: `${reason} Candidate diagnostics completed, but no scalp entry was submitted.`,
          });
          continue;
        }
        if (!circuit.allowed) {
          const reason = circuit.reasons.join(" ");
          scalpCandidateRecord = await rejectPersistedScalpCandidate(deps, scalpCandidateRecord, reason);
          results.push(skip(config, asset, "SCALP_CIRCUIT_OPEN", reason));
          continue;
        }
      }
      const planningConfig = strategyClass === "scalp"
        ? getScalpTradePlanningConfig(config)
        : config;
      const planningPoints = strategyClass === "scalp" ? scalpPoints : windowPoints;
      const basePlan = deriveTradePlan(planningConfig, planningPoints, signal, availableUsdc);
      const learnedPlanBase = applyLearnedTradePlan({
        basePlan,
        asset,
        points: planningPoints,
        profile: strategyClass === "smart" ? executionProfile : learningProfile,
        signalConfidence: signal.confidence,
        indicatorScore: indicatorScore.score,
        adx: indicators.adx,
        volumeRatio: indicators.volumeRatio,
      });
      const learnedPlan = strategyClass === "scalp"
        ? { ...learnedPlanBase, stopLossPercent: SCALP_STOP_LOSS_ROE_PERCENT }
        : learnedPlanBase;
      const probationContinuation = strategyClass === "scalp"
        && scalpMetadata?.priceActionTags.includes("CONTINUATION_PROBATION") === true;
      const standardScalpCollateralPercent = Number(
        (learnedPlan.collateralPercent * scalpProfile.riskMultiplier).toFixed(2)
      );
      const plan = strategyClass === "scalp"
        ? {
            ...learnedPlan,
            collateralPercent: resolveScalpProbationCollateralPercent(
              availableUsdc,
              standardScalpCollateralPercent,
              probationContinuation
            ),
            leverage: resolveScalpTradeLeverage({
              learnedLeverage: learnedPlan.leverage,
              learnedFloor: learningProfile?.leverageFloor,
              learnedCap: learningProfile?.leverageCap,
              exceptional: false,
            }),
            profileId: learningProfile?.profileId ?? null,
          }
        : learnedPlan;
      let collateralUsd = resolveAutonomousCollateralUsd(availableUsdc, plan.collateralPercent);
      if (!Number.isFinite(collateralUsd) || collateralUsd <= 0) {
        scalpCandidateRecord = await rejectPersistedScalpCandidate(
          deps,
          scalpCandidateRecord,
          "The learned allocation produced no usable USDC collateral."
        );
        results.push(skip(config, asset, "NO_COLLATERAL", "The configured allocation produced no usable USDC collateral."));
        continue;
      }
      if (collateralUsd < MIN_PERPS_COLLATERAL_USD) {
        scalpCandidateRecord = await rejectPersistedScalpCandidate(
          deps,
          scalpCandidateRecord,
          `The learned risk allocation produced $${collateralUsd.toFixed(2)}, below Jupiter's $${MIN_PERPS_COLLATERAL_USD.toFixed(2)} minimum.`
        );
        results.push(skip(
          config,
          asset,
          "COLLATERAL_BELOW_MINIMUM",
          `The configured allocation produced $${collateralUsd.toFixed(2)} of collateral; Jupiter requires at least $${MIN_PERPS_COLLATERAL_USD.toFixed(2)}.`
        ));
        continue;
      }
      const invertDirection = Boolean(
        strategyClass === "scalp"
        && directionExperimentActive
      );
      const detectedDirection = signal.direction;
      const executionDirection = invertDirection
        ? detectedDirection === "bullish" ? "bearish" as const : "bullish" as const
        : detectedDirection;
      const experimentTradeNumber = invertDirection && directionExperiment
        ? directionExperiment.tradesCompleted + 1
        : null;
      const side = executionDirection === "bullish" ? "long" : "short";
      let entryPrice = (strategyClass === "scalp" ? scalpPoints : windowPoints).at(-1)?.v ?? 0;
      let executionScalpMetadata = scalpMetadata;
      let executionSignalConfidence = signal.confidence;
      let oneSecondEntryPoint: ScalpOneSecondEntryMonitorResult | null = null;
      if (strategyClass === "scalp" && scalpEntryPath) {
        const completedCandleEntryReference = entryPrice;
        const signalCandleStartedAt = scalpPoints.at(-1)?.t ?? 0;
        const routeBudgetDeadline = Date.parse(startedAt)
          + 55_000
          - SCALP_ONE_SECOND_ROUTE_RESERVE_MS;
        const nextCandleConfirmationDeadline = resolveScalpNextCandleConfirmationDeadline(
          signalCandleStartedAt
        );
        oneSecondEntryPoint = await deps.monitorScalpEntryPoint({
          side,
          referencePrice: completedCandleEntryReference,
          atrPercent: plan.atrPercent,
          fetchPrice: () => deps.fetchLivePrice(`${asset}-USD`),
          fetchSample: overrides.fetchLivePrice && !overrides.fetchLiveSample
            ? undefined
            : () => deps.fetchLiveSample(`${asset}-USD`),
          // Replace the former second completed-candle requirement with the
          // first ten live seconds of the immediately following candle.
          deadlineAt: Math.min(routeBudgetDeadline, nextCandleConfirmationDeadline),
          maxWaitMs: SCALP_ONE_SECOND_ENTRY_MAX_WAIT_MS,
          intervalMs: SCALP_ONE_SECOND_ENTRY_INTERVAL_MS,
          assertActive: leaseGuard?.assertOwned,
        });
        if (oneSecondEntryPoint.status !== "triggered" || oneSecondEntryPoint.price === null) {
          const evaluation = oneSecondEntryPoint.evaluation;
          const reason = oneSecondEntryPoint.status === "invalidated" && evaluation
            ? `The one-second Coinbase entry monitor observed a ${evaluation.adverseMovePercent.toFixed(3)}% counter-directional move beyond its ${evaluation.tolerancePercent.toFixed(3)}% ATR-relative limit.`
            : oneSecondEntryPoint.status === "unavailable"
              ? "The one-second Coinbase entry monitor could not obtain a usable live price during the next candle's 10-second confirmation window."
              : "The next candle did not confirm the completed signal candle during its first 10 seconds.";
          scalpCandidateRecord = await rejectPersistedScalpCandidate(deps, scalpCandidateRecord, reason);
          results.push(skip(
            config,
            asset,
            oneSecondEntryPoint.status === "invalidated"
              ? "SCALP_ADVERSE_ENTRY_DRIFT"
              : oneSecondEntryPoint.status === "unavailable"
                ? "SCALP_ONE_SECOND_ENTRY_UNAVAILABLE"
                : "SCALP_ONE_SECOND_ENTRY_TIMEOUT",
            reason
          ));
          continue;
        }
        entryPrice = oneSecondEntryPoint.price;

        // The completed signal candle establishes the setup and the next
        // candle's live 10-second window establishes directional persistence.
        // Refetch completed candles after the trigger to ensure the originating
        // setup still resolves to the same direction and an authorized path.
        let freshPoints: PricePoint[];
        try {
          freshPoints = await deps.fetchCandles(
            `${asset}-USD`,
            Math.max(SCALP_EXHAUSTION_LOOKBACK_MINUTES + 65, effectiveParams.trendWindow + 35)
          );
        } catch {
          const reason = "Fresh completed-candle data was unavailable for the required pre-submit scalp revalidation.";
          scalpCandidateRecord = await rejectPersistedScalpCandidate(deps, scalpCandidateRecord, reason);
          results.push(skip(config, asset, "SCALP_REVALIDATION_UNAVAILABLE", reason));
          continue;
        }
        const freshScalpPoints = freshPoints.slice(-Math.max(SCALP_EXHAUSTION_LOOKBACK_MINUTES, 60));
        const freshIndicators = computeIndicatorSnapshot(freshPoints, indicatorSettings);
        const freshEvaluation = evaluateAdaptiveScalpCandidate({
          symbol: `${asset}/USD`,
          points: freshScalpPoints,
          indicators: freshIndicators,
          profile: scalpProfile,
          recentClosedTrade: latestClosedOutcome
            ? {
                openedAt: Date.parse(latestClosedOutcome.openedAt),
                closedAt: Date.parse(latestClosedOutcome.closedAt),
                side: latestClosedOutcome.side,
                netPnlUsd: latestClosedOutcome.netPnlUsd,
              }
            : null,
        });
        const freshPath = resolveRevalidatedScalpEntryPath(signal.direction, freshEvaluation);
        if (!freshPath) {
          const reason = freshEvaluation.candidate.rejectionReasons[0]
            ?? "The scalp setup changed direction or entry path before submission.";
          scalpCandidateRecord = await rejectPersistedScalpCandidate(deps, scalpCandidateRecord, reason);
          results.push(skip(config, asset, "SCALP_REVALIDATION_FAILED", reason));
          continue;
        }
        if (freshPath !== scalpEntryPath) {
          const freshCircuit = await deps.getScalpCircuitDecision({
            walletAddress: config.walletAddress,
            policyVersion: SCALP_POLICY_VERSION,
            entryPath: freshPath,
            requireAuthoritative: true,
          });
          if (!freshCircuit.allowed) {
            const reason = freshCircuit.reasons.join(" ");
            scalpCandidateRecord = await rejectPersistedScalpCandidate(deps, scalpCandidateRecord, reason);
            results.push(skip(config, asset, "SCALP_CIRCUIT_OPEN", reason));
            continue;
          }
          scalpCandidateRecord = await rejectPersistedScalpCandidate(
            deps,
            scalpCandidateRecord,
            `The same-direction setup transitioned from ${scalpEntryPath} to ${freshPath} during pre-submit revalidation.`
          );
          scalpCandidateRecord = await persistScalpCandidate({
            deps,
            walletAddress: config.walletAddress,
            asset,
            evaluation: freshEvaluation,
            indicators: freshIndicators,
            volatilityPercent: computeVolatilityPercent(freshScalpPoints),
            outcomeModel: scalpProfile.outcomeModel,
          });
          scalpEntryPath = freshPath;
        }
        const freshProbationContinuation = freshEvaluation.signal!.priceActionTags
          .includes("CONTINUATION_PROBATION");
        collateralUsd = resolveAutonomousCollateralUsd(
          availableUsdc,
          resolveScalpProbationCollateralPercent(
            availableUsdc,
            standardScalpCollateralPercent,
            freshProbationContinuation
          )
        );
        let livePrice: number | null;
        try {
          livePrice = await deps.fetchLivePrice(`${asset}-USD`);
        } catch {
          livePrice = null;
        }
        if (livePrice === null) {
          const reason = "The live Coinbase ticker was unavailable for the required pre-submit scalp price check.";
          scalpCandidateRecord = await rejectPersistedScalpCandidate(deps, scalpCandidateRecord, reason);
          results.push(skip(config, asset, "SCALP_LIVE_PRICE_UNAVAILABLE", reason));
          continue;
        }
        const finalEntryPoint = evaluateScalpOneSecondEntryPoint({
          side,
          referencePrice: completedCandleEntryReference,
          livePrice,
          atrPercent: plan.atrPercent,
        });
        if (!finalEntryPoint.triggered) {
          const reason = finalEntryPoint.invalidated
            ? `The live Coinbase price moved ${finalEntryPoint.adverseMovePercent.toFixed(3)}% against the signal during next-candle confirmation, exceeding the ${finalEntryPoint.tolerancePercent.toFixed(3)}% ATR-relative tolerance.`
            : `The live Coinbase price left the direction-confirming ${finalEntryPoint.tolerancePercent.toFixed(3)}% entry band before submission.`;
          scalpCandidateRecord = await rejectPersistedScalpCandidate(deps, scalpCandidateRecord, reason);
          results.push(skip(config, asset, "SCALP_ONE_SECOND_ENTRY_MOVED", reason));
          continue;
        }
        entryPrice = livePrice;
        routingIndicators = freshIndicators;
        routingIndicatorScore = scoreIndicatorSnapshot(freshIndicators, signal.direction, indicatorSettings);
        const confirmedTags = [
          ...freshEvaluation.signal!.priceActionTags,
          "NEXT_CANDLE_10S_CONFIRMED",
          "SIGNAL_CANDLE_FINAL_REVALIDATION",
        ];
        executionScalpMetadata = {
          ...freshEvaluation.signal!,
          priceActionTags: [...new Set(confirmedTags)],
        };
        executionSignalConfidence = freshEvaluation.signal!.confidence;
        if (scalpCandidateRecord) {
          scalpCandidateRecord = await deps.saveScalpCandidate({
            ...scalpCandidateRecord,
            metrics: {
              ...scalpCandidateRecord.metrics,
              oneSecondEntryPrice: oneSecondEntryPoint.price,
              oneSecondEntryObservedAt: oneSecondEntryPoint.observedAt ?? Date.now(),
              oneSecondEntrySamples: oneSecondEntryPoint.samples,
              oneSecondEntryConfirmations: oneSecondEntryPoint.confirmations ?? 0,
              oneSecondEntrySpreadBps: oneSecondEntryPoint.spreadBps ?? null,
              oneSecondEntryTradeImbalance: oneSecondEntryPoint.tradeImbalance ?? null,
              oneMinuteConfirmationPrice: livePrice,
            },
            tags: [...new Set([
              ...scalpCandidateRecord.tags,
              "NEXT_CANDLE_10S_CONFIRMED",
              "SIGNAL_CANDLE_FINAL_REVALIDATION",
            ])],
          });
        }
      }
      if (strategyClass === "scalp" && executionScalpMetadata) {
        const exceptionalScalpLeverage = isExceptionalScalpLeverageSetup({
          entryPath: scalpEntryPath,
          confidence: executionSignalConfidence,
          priceActionScore: executionScalpMetadata.priceActionScore,
          indicatorScore: routingIndicatorScore.score,
          indicatorBypass: executionScalpMetadata.indicatorBypass,
          adx: routingIndicators.adx,
          volumeRatio: routingIndicators.volumeRatio,
        });
        // Leverage is finalized only after the completed-candle and live-price
        // revalidation. A setup cannot retain exceptional sizing from stale
        // pre-submit evidence.
        plan.leverage = resolveScalpTradeLeverage({
          learnedLeverage: learnedPlan.leverage,
          learnedFloor: learningProfile?.leverageFloor,
          learnedCap: learningProfile?.leverageCap,
          exceptional: exceptionalScalpLeverage,
        });
      }
      const scalpExitPlan = strategyClass === "scalp"
        ? computePercentageScalpExitPlan({
            positionSizeUsd: collateralUsd * plan.leverage,
            leverage: plan.leverage,
            atrPercent: plan.atrPercent,
            configuredTakeProfitRoePercent: config.settings.scalpTakeProfitRoePercent,
            entryPath: scalpEntryPath,
            estimatedRoundTripFeeRate: estimatedScalpFeeRate,
          })
        : null;
      const scalpPositionPolicy = strategyClass === "scalp" && executionScalpMetadata && scalpExitPlan
        ? evaluateScalpPositionPolicy({
            openPositions,
            candidateSide: side,
            setupType: executionScalpMetadata.setupType,
            confidence: executionSignalConfidence,
            priceActionScore: executionScalpMetadata.priceActionScore,
            indicatorBypass: !invertDirection && executionScalpMetadata.indicatorBypass === true,
            projectedNetProfitUsd: scalpExitPlan.netProfitTargetUsd,
          })
        : { action: "open" as const };
      if (scalpPositionPolicy.action === "block") {
        scalpCandidateRecord = await rejectPersistedScalpCandidate(
          deps,
          scalpCandidateRecord,
          scalpPositionPolicy.message
        );
        results.push(skip(config, asset, scalpPositionPolicy.code, scalpPositionPolicy.message));
        continue;
      }
      if (scalpPositionPolicy.action === "reverse") {
        const positionPubkey = scalpPositionPolicy.existingPosition.accountRef;
        if (!positionPubkey) {
          scalpCandidateRecord = await rejectPersistedScalpCandidate(
            deps,
            scalpCandidateRecord,
            "Jupiter did not return the current position reference required for a safe reversal close."
          );
          results.push(skip(
            config,
            asset,
            "SCALP_REVERSAL_POSITION_UNAVAILABLE",
            "The exceptional reversal qualified, but Jupiter did not return the current position reference required for a safe close."
          ));
          continue;
        }
        leaseGuard?.assertOwned();
        const closed = await deps.closePosition(config.walletAddress, scalpPositionPolicy.existingPosition);
        const now = Date.now();
        await deps.writePendingScalpReversal(config.walletAddress, {
          positionPubkey,
          direction: executionDirection,
          createdAt: now,
          expiresAt: now + PENDING_SCALP_REVERSAL_TTL_MS,
          projectedSurplusUsd: scalpPositionPolicy.projectedSurplusUsd,
        });
        results.push({
          walletAddress: config.walletAddress,
          asset,
          status: "executed",
          code: "SCALP_REVERSAL_CLOSE_SUBMITTED",
          message: `Exceptional ${side} scalp reversal submitted the existing ${scalpPositionPolicy.existingPosition.side} close (${closed.txid}). The replacement must still qualify after Jupiter confirms the close; projected post-fee surplus was $${scalpPositionPolicy.projectedSurplusUsd.toFixed(2)}.`,
          signalId: signal.id,
        });
        continue;
      }
      const allowConcurrentPosition = scalpPositionPolicy.action === "hold-concurrent";
      const triggers = computeTriggerPrices({
        config,
        entryPrice,
        collateralUsd,
        leverage: plan.leverage,
        side,
        stopLossPercent: plan.stopLossPercent,
        takeProfitPercent: plan.takeProfitPercent,
        takeProfitUsd: scalpExitPlan?.netProfitTargetUsd,
        estimatedRoundTripFeeRate: strategyClass === "scalp" ? estimatedScalpFeeRate : undefined,
      });
      if (strategyClass === "scalp" && scalpCandidateRecord) {
        const plannedTakeProfitMovePercent = entryPrice > 0 && triggers.takeProfitPrice
          ? Math.abs(triggers.takeProfitPrice - entryPrice) / entryPrice * 100
          : null;
        const plannedStopLossMovePercent = entryPrice > 0 && triggers.stopLossPrice
          ? Math.abs(triggers.stopLossPrice - entryPrice) / entryPrice * 100
          : null;
        scalpCandidateRecord = await deps.saveScalpCandidate({
          ...scalpCandidateRecord,
          metrics: {
            ...scalpCandidateRecord.metrics,
            plannedLeverage: plan.leverage,
            shadowTakeProfitMovePercent: plannedTakeProfitMovePercent,
            shadowStopLossMovePercent: plannedStopLossMovePercent,
          },
        });
      }
      const firstPrice = windowPoints[0]?.v ?? entryPrice;
      const recentPriceChangePercent = firstPrice > 0 ? ((entryPrice - firstPrice) / firstPrice) * 100 : 0;
      const scalpEntryTimingSummary = strategyClass === "scalp" && oneSecondEntryPoint?.status === "triggered"
        ? `The completed signal candle and next-candle 10-second confirmation passed at ${new Date(oneSecondEntryPoint.observedAt ?? Date.now()).toISOString()}. `
        : "";
      leaseGuard?.assertOwned();
      const routed = await deps.routeSignal(config.walletAddress, {
        signalId: signal.id,
        symbol: signal.symbol,
        summary: pendingScalpReversal
          ? `${scalpEntryTimingSummary}Confirmed scalp reversal replacement after the original position closed. ${signal.summary} Server monitor ${new Date(signal.timestamp).toISOString()}.`
          : allowConcurrentPosition
            ? `${scalpEntryTimingSummary}Protected opposite-side scalp entry while the existing position remains independently managed. ${signal.summary} Server monitor ${new Date(signal.timestamp).toISOString()}.`
          : invertDirection
          ? `${scalpEntryTimingSummary}Opposite-direction scalp experiment ${experimentTradeNumber}/${directionExperiment?.maxTrades}: detector selected ${detectedDirection === "bullish" ? "long" : "short"}; executing ${side}. ${signal.summary} Server monitor ${new Date(signal.timestamp).toISOString()}.`
          : `${scalpEntryTimingSummary}${signal.summary} Server monitor ${new Date(signal.timestamp).toISOString()}.`,
        direction: executionDirection,
        signalConfidence: executionSignalConfidence,
        asset,
        collateralUsd,
        leverage: plan.leverage,
        takeProfitPrice: triggers.takeProfitPrice,
        stopLossPrice: triggers.stopLossPrice,
        maxSlippageBps: 100,
        smartTradeProfile: config.settings.smartTradeProfile,
        executionStyle: strategyClass === "scalp" ? "set-parameters" : config.settings.perpsExecutionMode,
        strategyClass,
        strategyContext: {
          signalType: signal.type,
          trendWindow: effectiveParams.trendWindow,
          trendThreshold: effectiveParams.trendThreshold,
          breakoutPercent: effectiveParams.breakoutPercent,
          cooldownSeconds: strategyClass === "scalp" || scalpAgentLayerEnabled
            ? scalpProfile.cooldownSeconds
            : effectiveParams.cooldownSeconds,
          trendStrengthPercent: signalMetrics.trend.changePercent,
          breakoutStrengthPercent: signalMetrics.breakoutChange,
          atrPercent: plan.atrPercent,
          indicatorScore: routingIndicatorScore.score,
          indicatorQualified: indicatorsReady ? routingIndicatorScore.qualified : false,
          indicatorTags: indicatorsReady ? routingIndicatorScore.tags : ["INDICATOR_HISTORY_INCOMPLETE"],
          scalpPolicyVersion: strategyClass === "scalp" ? SCALP_POLICY_VERSION : undefined,
          scalpSetupType: executionScalpMetadata?.setupType,
          scalpEntryPath: scalpEntryPath ?? undefined,
          priceActionScore: executionScalpMetadata?.priceActionScore,
          priceActionTags: invertDirection
            ? [...(executionScalpMetadata?.priceActionTags ?? []), "OPPOSITE_DIRECTION_EXPERIMENT"]
            : executionScalpMetadata?.priceActionTags,
          indicatorBypass: executionScalpMetadata?.indicatorBypass,
          detectedDirection: invertDirection ? detectedDirection : undefined,
          directionInverted: invertDirection || undefined,
          directionExperimentId: invertDirection ? directionExperiment?.experimentId : undefined,
          directionExperimentTradeNumber: experimentTradeNumber ?? undefined,
          estimatedRoundTripFeeRate: strategyClass === "scalp" ? estimatedScalpFeeRate : undefined,
          indicators: {
            emaSpreadPercent: routingIndicators.emaSpreadPercent,
            emaSlopePercent: routingIndicators.emaSlopePercent,
            rsi: routingIndicators.rsi,
            macdLine: routingIndicators.macdLine,
            macdSignal: routingIndicators.macdSignal,
            macdHistogram: routingIndicators.macdHistogram,
            macdHistogramChange: routingIndicators.macdHistogramChange,
            adx: routingIndicators.adx,
            plusDi: routingIndicators.plusDi,
            minusDi: routingIndicators.minusDi,
            atrPercent: routingIndicators.atrPercent,
            volumeRatio: routingIndicators.volumeRatio,
            bollingerBandwidthPercent: routingIndicators.bollingerBandwidthPercent,
            bollingerPosition: routingIndicators.bollingerPosition,
          },
          learningProfileId: plan.profileId,
        },
        marketContext: {
          spotPrice: entryPrice,
          volatilityPercent: plan.volatilityPercent,
          trendBias: strategyClass === "scalp"
            ? scalpEvaluation?.candidate.regime.bias ?? computeTrendBias(scalpPoints)
            : computeTrendBias(windowPoints),
          availableUsdc,
          hasOpenPosition: openPositions.length > 0,
          allowConcurrentPosition,
          recentPriceChangePercent,
        },
      });
      const routeExecution = "execution" in routed ? routed.execution : null;
      if (scalpCandidateRecord) {
        if (routed.ok) {
          scalpCandidateRecord = await deps.saveScalpCandidate({
            ...scalpCandidateRecord,
            disposition: "accepted",
            executionId: routeExecution?.executionId ?? null,
            decisionId: routeExecution?.decisionId ?? null,
          });
        } else {
          scalpCandidateRecord = await rejectPersistedScalpCandidate(
            deps,
            scalpCandidateRecord,
            routed.message,
            {
              executionId: routeExecution?.executionId ?? null,
              decisionId: routeExecution?.decisionId ?? null,
            }
          );
        }
      }
      if (routed.ok && pendingScalpReversal) {
        await deps.clearPendingScalpReversal(config.walletAddress);
      }
      const updatedExperiment = routed.ok && invertDirection
        ? await deps.recordDirectionExperimentTrade(config.walletAddress)
        : null;
      results.push({
        walletAddress: config.walletAddress,
        asset,
        status: routed.ok ? "executed" : "skipped",
        code: "code" in routed && typeof routed.code === "string" ? routed.code : routed.ok ? "EXECUTED" : "NOT_EXECUTED",
        message: updatedExperiment
          ? `${routed.message} Opposite-direction scalp experiment: ${updatedExperiment.tradesCompleted}/${updatedExperiment.maxTrades} submitted, ${updatedExperiment.tradesRemaining} remaining.`
          : routed.message,
        signalId: signal.id,
      });
      if (routed.ok) entrySubmittedWallets.add(config.walletAddress);
    } catch (error) {
      if (error instanceof AutonomousMonitorLeaseLostError) throw error;
      results.push({
        walletAddress: config.walletAddress,
        asset,
        status: "failed",
        code: "MONITOR_ERROR",
        message: error instanceof Error ? error.message : "Autonomous Perps monitoring failed.",
      });
    }
  }

  const completedAt = new Date().toISOString();
  return {
    ok: !results.some((result) => result.status === "failed"),
    locked: true,
    startedAt,
    completedAt,
    configuredWallets: configs.length,
    eligibleWallets: enabledConfigs.length,
    results,
  };
}

export type AutonomousMonitorLeaseStore = {
  acquire: (ownerToken: string, ttlMs: number) => Promise<boolean>;
  renew: (ownerToken: string, ttlMs: number) => Promise<boolean>;
  release: (ownerToken: string) => Promise<boolean>;
};

export async function runWithRenewingAutonomousMonitorLease<T>(options: {
  leaseStore: AutonomousMonitorLeaseStore;
  task: (leaseGuard: AutonomousMonitorLeaseGuard) => Promise<T>;
  ttlMs?: number;
  renewalIntervalMs?: number;
  ownerToken?: string;
}): Promise<{ acquired: false } | { acquired: true; result: T }> {
  const ttlMs = Math.max(10, options.ttlMs ?? MONITOR_LOCK_TTL_MS);
  const renewalIntervalMs = Math.max(
    5,
    Math.min(options.renewalIntervalMs ?? Math.floor(ttlMs / 3), Math.max(5, ttlMs - 5))
  );
  const ownerToken = options.ownerToken ?? crypto.randomUUID();
  if (!await options.leaseStore.acquire(ownerToken, ttlMs)) return { acquired: false };

  let stopped = false;
  let leaseLostError: AutonomousMonitorLeaseLostError | null = null;
  const abortController = new AbortController();
  const markLeaseLost = (cause?: unknown) => {
    if (leaseLostError) return;
    leaseLostError = new AutonomousMonitorLeaseLostError(
      cause instanceof Error
        ? `The autonomous monitor could not renew its distributed lease: ${cause.message}`
        : "The autonomous monitor lost its distributed lease to another worker."
    );
    abortController.abort(leaseLostError);
  };
  const leaseGuard: AutonomousMonitorLeaseGuard = {
    signal: abortController.signal,
    assertOwned: () => {
      if (leaseLostError) throw leaseLostError;
    },
  };
  let renewalQueue: Promise<void> = Promise.resolve();
  const timer = setInterval(() => {
    renewalQueue = renewalQueue
      .then(async () => {
        if (stopped) return;
        const renewed = await options.leaseStore.renew(ownerToken, ttlMs);
        if (!renewed) markLeaseLost();
      })
      // If Redis cannot verify renewal, continuing to a later live side effect
      // would be unsafe: the lease may expire and a successor may take over.
      .catch((error) => { markLeaseLost(error); });
  }, renewalIntervalMs);
  timer.unref?.();

  try {
    const result = await options.task(leaseGuard);
    leaseGuard.assertOwned();
    return { acquired: true, result };
  } finally {
    stopped = true;
    clearInterval(timer);
    await renewalQueue;
    await options.leaseStore.release(ownerToken).catch(() => false);
  }
}

export async function runLockedAutonomousPerpsMonitor() {
  const redis = await getRedisClient();
  if (!redis) throw new Error("Redis is required for the autonomous Perps monitor.");
  const leaseStore: AutonomousMonitorLeaseStore = {
    acquire: async (ownerToken, ttlMs) => (
      await redis.set(MONITOR_LOCK_KEY, ownerToken, { NX: true, PX: ttlMs }) === "OK"
    ),
    renew: async (ownerToken, ttlMs) => Number(await redis.eval(
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end",
      { keys: [MONITOR_LOCK_KEY], arguments: [ownerToken, String(ttlMs)] }
    )) === 1,
    release: async (ownerToken) => Number(await redis.eval(
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
      { keys: [MONITOR_LOCK_KEY], arguments: [ownerToken] }
    )) === 1,
  };
  const leased = await runWithRenewingAutonomousMonitorLease({
    leaseStore,
    task: async (leaseGuard) => {
      const result = await runAutonomousPerpsMonitor({}, leaseGuard);
      const previousRaw = await redis.get(LAST_RUN_KEY);
      let previous: AutonomousMonitorResult | null = null;
      try {
        previous = previousRaw ? JSON.parse(previousRaw) as AutonomousMonitorResult : null;
      } catch {
        previous = null;
      }
      const walletFailureStreaks: Record<string, number> = {};
      const walletAddresses = new Set([
        ...Object.keys(previous?.walletFailureStreaks ?? {}),
        ...result.results.map((item) => item.walletAddress),
      ]);
      walletAddresses.forEach((walletAddress) => {
        const walletResults = result.results.filter((item) => item.walletAddress === walletAddress);
        walletFailureStreaks[walletAddress] = walletResults.some((item) => item.status === "failed")
          ? (previous?.walletFailureStreaks?.[walletAddress] ?? 0) + 1
          : 0;
      });
      const persisted = {
        ...result,
        consecutiveFailureCount: result.ok
          ? 0
          : (previous?.ok === false ? previous.consecutiveFailureCount ?? 1 : 0) + 1,
        walletFailureStreaks,
      } satisfies AutonomousMonitorResult;
      await redis.set(LAST_RUN_KEY, JSON.stringify(persisted));
      return persisted;
    },
  });
  if (!leased.acquired) {
    const now = new Date().toISOString();
    return {
      ok: true,
      locked: false,
      startedAt: now,
      completedAt: now,
      configuredWallets: 0,
      eligibleWallets: 0,
      results: [],
    } satisfies AutonomousMonitorResult;
  }
  return leased.result;
}

export async function getLastAutonomousMonitorRun() {
  const redis = await getRedisClient();
  if (!redis) return null;
  const raw = await redis.get(LAST_RUN_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as AutonomousMonitorResult;
  } catch {
    return null;
  }
}
