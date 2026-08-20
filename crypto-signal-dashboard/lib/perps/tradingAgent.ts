import crypto from "node:crypto";

import { getTradeDecisionConfig } from "@/lib/decision/config";
import { createTradeDecisionRecord } from "@/lib/decision/engine";
import { appendTradeDecisionRecord } from "@/lib/decision/logStore";
import {
  getActiveDecisionLearningProfile,
  getActiveDecisionLearningProfileAuthoritative,
} from "@/lib/decision/learningStore";
import { getPerpsSessionConfig } from "@/lib/perps/sessionConfig";
import { getScalpCircuitDecision } from "@/lib/decision/scalpCircuitStore";
import { getPerpsAutomationConfig } from "@/lib/perps/automationConfigStore";
import { assertAgentWalletSigner } from "@/lib/perps/agentWallet";
import { getPerpsDelegationCapability } from "@/lib/perps/delegationAdapter";
import { resolvePerpsExecutionModel } from "@/lib/perps/executionModel";
import { getPerpsSession, savePerpsSession } from "@/lib/perps/sessionStore";
import type {
  PerpsAgentSignal,
  PerpsAutomationSession,
  PerpsClockInInput,
  PerpsSessionHeartbeatInput,
  PerpsUserExecution,
} from "@/lib/perps/sessionTypes";
import {
  createUserPerpsExecution,
  listUserPerpsExecutions,
  listUserPerpsExecutionsAuthoritative,
  updateUserPerpsExecution,
} from "@/lib/perps/userExecutionAudit";
import { evaluateUserScopedPerpsRisk } from "@/lib/perps/userScopedRisk";
import { signSerializedPerpsTransaction } from "@/lib/perps/signer";
import { executePerpsEntryWithRetries } from "@/lib/perps/entryRetry";
import {
  SCALP_POLICY_VERSION,
  scalpCandidatePathAllowsLiveSignal,
  scalpProfileAllowsLiveEntries,
} from "@/lib/perps/scalpEngine";
import {
  fetchJupiterPerpsAccountSnapshot,
  fetchJupiterPerpsTransactionStatus,
} from "@/lib/jupiterPerps";
import {
  DEFAULT_CONSERVATIVE_PERPS_ROUND_TRIP_FEE_RATE,
  SCALP_MINIMUM_NET_PROFIT_USD,
} from "@/lib/perps/scalpExit";
import {
  beginScalpProtectionEntryRoute,
  createScalpEmergencyCloseSubmissionUncertainError,
  createScalpProtectionSubmissionUncertainError,
  createScalpProtectionRecoveryRecord,
  getScalpRecoveryExecutionPatch,
  getScalpProtectionRecovery,
  resolveScalpRecoveryPositionPubkey,
  runScalpProtectionRecovery,
  saveScalpProtectionRecovery,
  scalpProtectionRecoveryToSignal,
  updateScalpProtectionRecoveryRecord,
  isScalpProtectionSubmissionUncertainError,
  type ScalpProtectionRecoveryRecord,
  type ScalpProtectionRecoveryResult,
} from "@/lib/perps/scalpProtectionRecovery";

function nowIso() {
  return new Date().toISOString();
}

const TRUSTED_AUTONOMOUS_MONITOR_AUTHORITY = Symbol("trusted-autonomous-monitor");
type PerpsRoutingAuthority = typeof TRUSTED_AUTONOMOUS_MONITOR_AUTHORITY | null;

export function decisionVetoBlocksPerpsExecution(input: {
  decisionControlsExecution: boolean;
  liveDelegatedScalp: boolean;
  shadowMode: boolean;
  shouldTrade: boolean;
  decisionRejectionOverridden: boolean;
}) {
  return input.decisionControlsExecution
    && (!input.shadowMode || input.liveDelegatedScalp)
    && !input.shouldTrade
    && !input.decisionRejectionOverridden;
}

function plannedTriggerPrice(
  plannedTpsl: Array<{ requestType: "tp" | "sl"; triggerPrice: string }>,
  requestType: "tp" | "sl"
) {
  const raw = Number(plannedTpsl.find((request) => request.requestType === requestType)?.triggerPrice);
  return Number.isFinite(raw) && raw > 0 ? raw / 1_000_000 : null;
}

export function assertScalpPreEntryInventoryIsAuthoritative(
  snapshot: Awaited<ReturnType<typeof fetchJupiterPerpsAccountSnapshot>>
) {
  if (
    snapshot.positions.length === 0
    && snapshot.readEvidence?.authoritativePositionAbsence !== true
  ) {
    throw new Error(
      "Live scalp entry is blocked because an empty Jupiter API response was not confirmed by an owner-account RPC scan."
    );
  }
}

export function bindDiscoveredScalpRecoveryPosition(
  record: ScalpProtectionRecoveryRecord,
  positionPubkey: string,
  now?: string
) {
  if (!record.entryTxid) {
    throw new Error("A recovery position cannot be bound without the submitted entry transaction signature.");
  }
  // Position discovery is not a new protection attempt. In particular, keep
  // the durable submission reservation and its original freshness boundary so
  // recovery cannot mistake triggers from an older position episode for the
  // TP/SL currently being prepared by this route.
  return updateScalpProtectionRecoveryRecord(record, {
    positionPubkey,
    positionIdentitySource: "entry-transaction",
    positionIdentityTxid: record.entryTxid,
  }, now);
}

export type DeferredProtectionResult =
  | { status: "protected"; protectionTxid: string; error: null }
  | { status: "recovery-pending"; protectionTxid: null; error: string }
  | { status: "failed"; protectionTxid: null; error: string }
  | { status: "emergency-close-submitted"; protectionTxid: null; emergencyCloseTxid: string; error: string };

const SCALP_PROTECTION_RETRY_DELAYS_MS = [0, 1_000, 2_000, 4_000, 6_000] as const;
const STANDARD_PROTECTION_RETRY_DELAYS_MS = [0, 750, 1_500] as const;

export async function executeDeferredProtectionFailClosed(options: {
  isScalp: boolean;
  positionPubkey: string | null;
  getPositionPubkey?: () => string | null;
  attachProtection: () => Promise<string | null>;
  emergencyClose: (positionPubkey: string) => Promise<string | null>;
  wait?: (delayMs: number) => Promise<void>;
}): Promise<DeferredProtectionResult> {
  const wait = options.wait ?? ((delayMs: number) => new Promise((resolve) => setTimeout(resolve, delayMs)));
  const retryDelays = options.isScalp
    ? SCALP_PROTECTION_RETRY_DELAYS_MS
    : STANDARD_PROTECTION_RETRY_DELAYS_MS;
  let protectionError = "Unable to attach autonomous TP/SL protection.";

  for (const delayMs of retryDelays) {
    if (delayMs > 0) await wait(delayMs);
    try {
      const protectionTxid = await options.attachProtection();
      if (!protectionTxid) {
        throw options.isScalp
          ? createScalpProtectionSubmissionUncertainError(
              new Error("Jupiter returned no TP/SL transaction signature.")
            )
          : new Error("Jupiter did not return a TP/SL transaction signature.");
      }
      return { status: "protected", protectionTxid, error: null };
    } catch (error) {
      protectionError = error instanceof Error
        ? error.message
        : "Unable to attach autonomous TP/SL protection.";
      if (options.isScalp && isScalpProtectionSubmissionUncertainError(error)) {
        return {
          status: "recovery-pending",
          protectionTxid: null,
          error: `${protectionError} Durable recovery will inspect live triggers before any retry or emergency close.`,
        };
      }
      if ((error as { code?: unknown } | null)?.code === "LIVE_POSITION_TRIGGER_ALREADY_CROSSED") {
        break;
      }
    }
  }

  const resolvedPositionPubkey = options.getPositionPubkey?.() ?? options.positionPubkey;
  if (!options.isScalp || !resolvedPositionPubkey) {
    const positionMessage = options.isScalp && !resolvedPositionPubkey
      ? " Jupiter did not return the position reference required for an emergency close."
      : "";
    return {
      status: "failed",
      protectionTxid: null,
      error: `${protectionError}${positionMessage}`,
    };
  }

  try {
    const emergencyCloseTxid = await options.emergencyClose(resolvedPositionPubkey);
    if (!emergencyCloseTxid) throw new Error("Jupiter did not return an emergency-close transaction signature.");
    return {
      status: "emergency-close-submitted",
      protectionTxid: null,
      emergencyCloseTxid,
      error: protectionError,
    };
  } catch (error) {
    const closeError = error instanceof Error
      ? error.message
      : "Unable to submit the emergency close.";
    return {
      status: "failed",
      protectionTxid: null,
      error: `${protectionError} Emergency close also failed: ${closeError}`,
    };
  }
}

/**
 * Reconciles one wallet's durable unprotected-scalp guard. The route calls this
 * before every new live entry; the autonomous monitor should also call it once
 * per cycle so recovery continues even when no fresh signal is emitted.
 *
 * A recovery that existed at the beginning of this call always blocks the
 * current entry cycle, even if it is resolved here. That prevents a close or a
 * newly attached trigger from racing a second position submission.
 */
export async function recoverPendingScalpProtectionForWallet(
  walletAddress: string
): Promise<ScalpProtectionRecoveryResult> {
  const record = await getScalpProtectionRecovery(walletAddress);
  if (!record) {
    return {
      status: "no-pending-recovery",
      blockNewEntries: false,
      record: null,
      message: "No unresolved scalp protection recovery exists for this wallet.",
    };
  }

  const agentWalletAddress = assertAgentWalletSigner(walletAddress);
  if (agentWalletAddress !== record.agentWalletAddress) {
    throw new Error(
      "The configured autonomous wallet does not match the wallet that owns the unresolved scalp position; new entries remain blocked."
    );
  }
  const {
    buildPerpsCloseTransaction,
    buildPerpsTpslTransactionForSignal,
    executeSignedPerpsTransaction,
  } = await import("@/lib/perps/jupiterAdapter");

  const updateRecoveryExecution = async (result: ScalpProtectionRecoveryResult) => {
    const patch = getScalpRecoveryExecutionPatch(result);
    if (!patch) return;
    const updated = await updateUserPerpsExecution(record.walletAddress, record.executionId, patch, {
      requireAuthoritative: true,
    });
    if (!updated) {
      throw new Error(`The original scalp execution ${record.executionId} could not be reconciled with recovery state.`);
    }
  };

  const result = await runScalpProtectionRecovery(record, {
    readSnapshot: () => fetchJupiterPerpsAccountSnapshot(record.agentWalletAddress, { includeRecentTrades: true }),
    readTransactionStatus: fetchJupiterPerpsTransactionStatus,
    attachProtection: async (positionPubkey, currentRecord) => {
      const protection = await buildPerpsTpslTransactionForSignal(
        scalpProtectionRecoveryToSignal(currentRecord),
        currentRecord.agentWalletAddress,
        positionPubkey,
        SCALP_MINIMUM_NET_PROFIT_USD,
        undefined,
        undefined,
        { requireLivePosition: true }
      );
      if (!protection) throw new Error("Jupiter did not build the required TP/SL recovery transaction.");
      const signed = signSerializedPerpsTransaction(protection.serializedTxBase64);
      let submitted: Awaited<ReturnType<typeof executeSignedPerpsTransaction>>;
      try {
        submitted = await executeSignedPerpsTransaction("create-tpsl", signed.signedSerializedTxBase64);
      } catch (error) {
        throw createScalpProtectionSubmissionUncertainError(error);
      }
      if (!submitted.txid) {
        throw createScalpProtectionSubmissionUncertainError(
          new Error("Jupiter returned no TP/SL transaction signature.")
        );
      }
      return {
        txid: submitted.txid,
        takeProfitPrice: plannedTriggerPrice(protection.plannedTpsl, "tp"),
        stopLossPrice: plannedTriggerPrice(protection.plannedTpsl, "sl"),
      };
    },
    emergencyClose: async (positionPubkey) => {
      const close = await buildPerpsCloseTransaction(positionPubkey, "USDC", "100");
      const signed = signSerializedPerpsTransaction(close.serializedTxBase64);
      let submitted: Awaited<ReturnType<typeof executeSignedPerpsTransaction>>;
      try {
        submitted = await executeSignedPerpsTransaction("decrease-position", signed.signedSerializedTxBase64);
      } catch (error) {
        throw createScalpEmergencyCloseSubmissionUncertainError(error);
      }
      return submitted.txid ?? null;
    },
    beforeClear: async (resolution, resolvedRecord, message) => {
      await updateRecoveryExecution({
        status: resolution,
        blockNewEntries: true,
        record: resolvedRecord,
        message,
      });
    },
  });
  if (!["protected", "position-closed", "entry-not-found"].includes(result.status)) {
    await updateRecoveryExecution(result);
  }
  return result;
}

function parseIso(value: string | null | undefined) {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function getSessionTimeoutReason(timeoutMs: number) {
  const seconds = Math.max(1, Math.round(timeoutMs / 1000));
  return `Trading session timed out after ${seconds} seconds without an active app heartbeat.`;
}

async function resolveSessionTimeout(walletAddress: string, session: PerpsAutomationSession | null) {
  if (!session || session.sessionState !== "clocked_in") return session;
  if (session.executionModel === "delegated-ready") return session;

  const config = getPerpsSessionConfig();
  const now = Date.now();
  const inactiveSince = parseIso(session.inactiveSince);
  const lastHeartbeatAt = parseIso(session.lastHeartbeatAt);
  const timedOutWhileInactive =
    inactiveSince !== null
      && now - inactiveSince >= config.heartbeatTimeoutMs;
  const timedOutHeartbeat =
    inactiveSince === null
      && lastHeartbeatAt !== null
      && now - lastHeartbeatAt >= config.heartbeatTimeoutMs;

  if (!timedOutWhileInactive && !timedOutHeartbeat) {
    return session;
  }

  return clockOutPerpsSession(walletAddress, getSessionTimeoutReason(config.heartbeatTimeoutMs));
}

export async function getPerpsSessionWithTimeout(walletAddress: string) {
  const existing = await getPerpsSession(walletAddress);
  return resolveSessionTimeout(walletAddress, existing);
}

export async function clockInPerpsSession(walletAddress: string, input: PerpsClockInInput) {
  const config = getPerpsSessionConfig();
  const existing = await getPerpsSession(walletAddress);
  const requestedMode = input.mode;
  const delegation = getPerpsDelegationCapability(walletAddress);
  const executionModel = resolvePerpsExecutionModel({ mode: requestedMode }, { delegatedExecutionAvailable: delegation.available });
  const warning =
    input.unlimitedSession
      ? "Unlimited session is enabled. Guardrails remain in code, but this raises operational risk while the app stays open."
      : executionModel === "approval-assisted"
        ? delegation.message
        : null;

  const session: PerpsAutomationSession = {
    sessionId: existing?.sessionId ?? `psess_${crypto.randomUUID()}`,
    walletAddress,
    sessionState: "clocked_in",
    startedAt: existing?.startedAt ?? nowIso(),
    lastHeartbeatAt: nowIso(),
    inactiveSince: null,
    endedAt: null,
    mode: requestedMode,
    executionModel,
    appOpen: input.appOpen ?? true,
    appForeground: true,
    walletConnected: true,
    walletWriteEnabled: requestedMode === "paper" || executionModel === "delegated-ready" ? true : input.platform === "native",
    killSwitch: config.globalKillSwitch,
    unlimitedSession: Boolean(input.unlimitedSession),
    platform: input.platform ?? null,
    walletProvider: input.walletProvider ?? null,
    warning,
  };

  await savePerpsSession(session);
  return session;
}

export async function clockOutPerpsSession(walletAddress: string, reason?: string) {
  const existing = await getPerpsSession(walletAddress);
  if (!existing) return null;

  const next: PerpsAutomationSession = {
    ...existing,
    sessionState: "clocked_out",
    appOpen: false,
    appForeground: false,
    walletConnected: false,
    walletWriteEnabled: false,
    lastHeartbeatAt: nowIso(),
    inactiveSince: null,
    endedAt: nowIso(),
    warning: reason ?? existing.warning,
  };
  await savePerpsSession(next);
  return next;
}

export async function heartbeatPerpsSession(walletAddress: string, input: PerpsSessionHeartbeatInput) {
  const existing = await getPerpsSession(walletAddress);
  if (!existing) return null;

  const config = getPerpsSessionConfig();
  if (existing.executionModel === "delegated-ready") {
    const next: PerpsAutomationSession = {
      ...existing,
      lastHeartbeatAt: nowIso(),
      inactiveSince: null,
      appOpen: input.appOpen,
      appForeground: input.appForeground,
      walletConnected: input.walletConnected,
      walletWriteEnabled: true,
    };
    await savePerpsSession(next);
    return next;
  }
  const inactive = !input.appOpen || !input.appForeground || !input.walletConnected;
  const now = nowIso();

  if (inactive) {
    const inactiveSince = existing.inactiveSince ?? now;
    const timedOut = (Date.parse(now) - Date.parse(inactiveSince)) >= config.heartbeatTimeoutMs;
    if (timedOut) {
      return clockOutPerpsSession(walletAddress, getSessionTimeoutReason(config.heartbeatTimeoutMs));
    }

    const next: PerpsAutomationSession = {
      ...existing,
      lastHeartbeatAt: now,
      inactiveSince,
      appOpen: input.appOpen,
      appForeground: input.appForeground,
      walletConnected: input.walletConnected,
      walletWriteEnabled: input.walletWriteEnabled ?? existing.walletWriteEnabled,
      warning: input.reason ?? existing.warning,
    };
    await savePerpsSession(next);
    return next;
  }

  const next: PerpsAutomationSession = {
    ...existing,
    lastHeartbeatAt: now,
    inactiveSince: null,
    appOpen: input.appOpen,
    appForeground: input.appForeground,
    walletConnected: input.walletConnected,
    walletWriteEnabled: input.walletWriteEnabled ?? existing.walletWriteEnabled,
  };
  await savePerpsSession(next);
  return next;
}

async function routePerpsSignal(
  walletAddress: string,
  signal: PerpsAgentSignal,
  authority: PerpsRoutingAuthority
) {
  const config = getPerpsSessionConfig();
  const decisionConfig = getTradeDecisionConfig();
  const session = await getPerpsSessionWithTimeout(walletAddress);
  if (!session) {
    return { ok: false, code: "NO_SESSION", message: "Clock In before routing automated perps signals." } as const;
  }
  const isScalp = signal.strategyClass === "scalp";
  const requireAuthoritativeScalpAudit = isScalp
    && session.mode === "live"
    && session.executionModel === "delegated-ready";

  if (requireAuthoritativeScalpAudit && authority !== TRUSTED_AUTONOMOUS_MONITOR_AUTHORITY) {
    return {
      ok: false,
      code: "SCALP_TRUSTED_SOURCE_REQUIRED",
      message: "Live scalp execution is accepted only from the trusted autonomous server monitor.",
    } as const;
  }
  if (requireAuthoritativeScalpAudit && signal.protectionOverride) {
    return {
      ok: false,
      code: "SCALP_PROTECTION_OVERRIDE_PROHIBITED",
      message: "Live scalp execution cannot bypass its decision, take-profit, or stop-loss protections.",
    } as const;
  }

  if (session.mode === "live" && session.executionModel === "delegated-ready") {
    try {
      const recovery = await recoverPendingScalpProtectionForWallet(walletAddress);
      if (recovery.blockNewEntries) {
        return {
          ok: false,
          code: ["protected", "position-closed", "entry-not-found"].includes(recovery.status)
            ? "SCALP_PROTECTION_RECOVERY_RESOLVED"
            : "SCALP_PROTECTION_RECOVERY_PENDING",
          recovery,
          message: `${recovery.message} This entry was not routed; the next cycle may proceed after confirming no recovery remains.`,
        } as const;
      }
    } catch (error) {
      return {
        ok: false,
        code: "SCALP_PROTECTION_RECOVERY_UNAVAILABLE",
        message: `New live entries are blocked because scalp protection recovery could not be verified: ${error instanceof Error ? error.message : "unknown recovery error"}`,
      } as const;
    }
  }

  const [existingExecutions, learningProfile, automationConfig] = await Promise.all([
    requireAuthoritativeScalpAudit
      ? listUserPerpsExecutionsAuthoritative(walletAddress)
      : listUserPerpsExecutions(walletAddress),
    requireAuthoritativeScalpAudit
      ? getActiveDecisionLearningProfileAuthoritative(walletAddress)
      : getActiveDecisionLearningProfile(walletAddress),
    getPerpsAutomationConfig(walletAddress).catch(() => null),
  ]);
  const shadowMode = automationConfig
    ? automationConfig.settings.decisionMode === "shadow"
    : decisionConfig.shadowMode;
  const decision = createTradeDecisionRecord({
    walletAddress,
    session,
    signal,
    existingExecutions,
    learningProfile,
    shadowMode,
  });
  await appendTradeDecisionRecord(decision, {
    requireAuthoritative: requireAuthoritativeScalpAudit,
  });

  if (requireAuthoritativeScalpAudit) {
    const scalpProfile = learningProfile?.scalpProfile ?? null;
    if (!scalpProfile || !scalpProfileAllowsLiveEntries(scalpProfile)) {
      return {
        ok: false,
        code: "SCALP_PROFILE_NOT_LIVE_ELIGIBLE",
        decision: decision.recommendation,
        message: "Direct scalp execution is blocked because the authoritative current policy profile is missing, paused, or not authorized for live entries.",
      } as const;
    }
    const scalpEntryPath = signal.strategyContext?.scalpEntryPath;
    if (!scalpEntryPath || scalpEntryPath === "unknown") {
      return {
        ok: false,
        code: "SCALP_ENTRY_PATH_REQUIRED",
        decision: decision.recommendation,
        message: "Direct live scalp execution requires an explicit attributable entry path.",
      } as const;
    }
    if (!scalpCandidatePathAllowsLiveSignal(scalpEntryPath)) {
      return {
        ok: false,
        code: "SCALP_ENTRY_PATH_SHADOW_ONLY",
        decision: decision.recommendation,
        message: `${scalpEntryPath} scalp entries remain shadow-only until path-specific after-fee validation explicitly enables them.`,
      } as const;
    }
    const circuit = await getScalpCircuitDecision({
      walletAddress,
      policyVersion: SCALP_POLICY_VERSION,
      entryPath: scalpEntryPath,
      requireAuthoritative: true,
    });
    if (!circuit.allowed) {
      return {
        ok: false,
        code: "SCALP_CIRCUIT_OPEN",
        decision: decision.recommendation,
        message: circuit.reasons.join(" "),
      } as const;
    }
  }

  const explicitOverride = signal.protectionOverride;
  const protectionOverrideScopes: PerpsUserExecution["protectionOverrideScopes"] = [
    explicitOverride?.allowDecisionRejection ? "decision-rejection" as const : null,
    explicitOverride?.allowMissingTakeProfit ? "missing-take-profit" as const : null,
    explicitOverride?.allowMissingStopLoss ? "missing-stop-loss" as const : null,
  ].filter((scope): scope is NonNullable<typeof scope> => scope !== null);
  const decisionControlsExecution = signal.executionStyle === "smart-trades" || isScalp;
  const decisionRejectionOverridden = Boolean(
    isScalp
    && !requireAuthoritativeScalpAudit
    && explicitOverride?.allowDecisionRejection
  );
  const missingTakeProfit = isScalp && !signal.takeProfitPrice;
  const missingStopLoss = isScalp && !signal.stopLossPrice;
  const missingRequiredProtection = (
    missingTakeProfit && !explicitOverride?.allowMissingTakeProfit
  ) || (
    missingStopLoss && !explicitOverride?.allowMissingStopLoss
  );
  const resolvedSignal =
    signal.executionStyle === "smart-trades" && !shadowMode && decisionConfig.allowExecutionOverrides
      ? {
          ...signal,
          collateralUsd: decision.recommendation.recommendedCollateralUsd,
          leverage: decision.recommendation.recommendedLeverage,
          takeProfitPrice: decision.recommendation.recommendedTakeProfitPrice,
          stopLossPrice: decision.recommendation.recommendedStopLossPrice,
        }
      : signal;

  if (decisionVetoBlocksPerpsExecution({
    decisionControlsExecution,
    liveDelegatedScalp: requireAuthoritativeScalpAudit,
    shadowMode,
    shouldTrade: decision.recommendation.shouldTrade,
    decisionRejectionOverridden,
  })) {
    const blockedExecution: PerpsUserExecution = {
      executionId: `pexec_${crypto.randomUUID()}`,
      sessionId: session.sessionId,
      walletAddress,
      signalId: signal.signalId,
      symbol: signal.symbol,
      summary: signal.summary,
      side: signal.direction === "bullish" ? "long" : "short",
      asset: signal.asset,
      mode: session.mode,
      executionModel: session.executionModel,
      status: "blocked",
      reasonCode: "DECISION_LAYER_SKIP",
      reasonMessage: decision.recommendation.explanationSummary,
      collateralUsd: signal.collateralUsd,
      sizeUsd: Number((signal.collateralUsd * signal.leverage).toFixed(2)),
      leverage: signal.leverage,
      takeProfitPrice: signal.takeProfitPrice ?? null,
      stopLossPrice: signal.stopLossPrice ?? null,
      txid: null,
      positionPubkey: null,
      decisionId: decision.payload.decisionId,
      decisionConfidence: decision.recommendation.confidenceScore,
      decisionShouldTrade: decision.recommendation.shouldTrade,
      decisionSummary: decision.recommendation.explanationSummary,
      decisionTags: decision.recommendation.explanationTags,
      decisionShadowMode: decision.recommendation.shadowMode,
      strategyClass: signal.strategyClass ?? "smart",
      scalpSetupType: signal.strategyContext?.scalpSetupType ?? null,
      scalpEntryPath: signal.strategyContext?.scalpEntryPath ?? null,
      priceActionTags: signal.strategyContext?.priceActionTags ?? [],
      protectionOverrideReason: explicitOverride?.reason ?? null,
      protectionOverrideScopes,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };

    await createUserPerpsExecution(blockedExecution);
    return {
      ok: false,
      execution: blockedExecution,
      decision: decision.recommendation,
      code: "DECISION_LAYER_SKIP",
      message: decision.recommendation.explanationSummary,
    } as const;
  }

  if (missingRequiredProtection) {
    const missing = [
      missingTakeProfit && !explicitOverride?.allowMissingTakeProfit ? "take profit" : null,
      missingStopLoss && !explicitOverride?.allowMissingStopLoss ? "stop loss" : null,
    ].filter(Boolean).join(" and ");
    const blockedExecution: PerpsUserExecution = {
      executionId: `pexec_${crypto.randomUUID()}`,
      sessionId: session.sessionId,
      walletAddress,
      signalId: signal.signalId,
      symbol: signal.symbol,
      summary: signal.summary,
      side: signal.direction === "bullish" ? "long" : "short",
      asset: signal.asset,
      mode: session.mode,
      executionModel: session.executionModel,
      status: "blocked",
      reasonCode: "SCALP_PROTECTION_REQUIRED",
      reasonMessage: `Scalp execution requires a protected ${missing} unless the signal includes an explicit, reasoned override.`,
      collateralUsd: signal.collateralUsd,
      sizeUsd: Number((signal.collateralUsd * signal.leverage).toFixed(2)),
      leverage: signal.leverage,
      takeProfitPrice: signal.takeProfitPrice ?? null,
      stopLossPrice: signal.stopLossPrice ?? null,
      txid: null,
      positionPubkey: null,
      decisionId: decision.payload.decisionId,
      decisionConfidence: decision.recommendation.confidenceScore,
      decisionShouldTrade: decision.recommendation.shouldTrade,
      decisionSummary: decision.recommendation.explanationSummary,
      decisionTags: [
        ...decision.recommendation.explanationTags,
        "scalp-protection-required",
      ],
      decisionShadowMode: decision.recommendation.shadowMode,
      strategyClass: "scalp",
      scalpSetupType: signal.strategyContext?.scalpSetupType ?? null,
      scalpEntryPath: signal.strategyContext?.scalpEntryPath ?? null,
      priceActionTags: signal.strategyContext?.priceActionTags ?? [],
      protectionOverrideReason: explicitOverride?.reason ?? null,
      protectionOverrideScopes,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    await createUserPerpsExecution(blockedExecution);
    return {
      ok: false,
      execution: blockedExecution,
      decision: decision.recommendation,
      code: "SCALP_PROTECTION_REQUIRED",
      message: blockedExecution.reasonMessage,
    } as const;
  }

  const side = signal.direction === "bullish" ? "long" : "short";
  const risk = evaluateUserScopedPerpsRisk({
    session,
    signal: {
      ...resolvedSignal,
      sizeUsd: Number((resolvedSignal.collateralUsd * resolvedSignal.leverage).toFixed(2)),
    } as PerpsAgentSignal & { sizeUsd: number },
    existingExecutions,
    maxLeverage: config.maxUserLeverage,
    maxTradePct: config.maxTradePct,
    maxExposurePct: config.maxExposurePct,
  });

  const execution: PerpsUserExecution = {
    executionId: `pexec_${crypto.randomUUID()}`,
    sessionId: session.sessionId,
    walletAddress,
    signalId: signal.signalId,
    symbol: signal.symbol,
    summary: signal.summary,
    side,
    asset: signal.asset,
    mode: session.mode,
    executionModel: session.executionModel,
    status: risk.approved
      ? (session.mode === "paper" ? "paper_executed" : session.executionModel === "delegated-ready" ? "prepared" : "approval_required")
      : "blocked",
    reasonCode: risk.code,
    reasonMessage: risk.message,
    collateralUsd: resolvedSignal.collateralUsd,
    sizeUsd: Number((resolvedSignal.collateralUsd * resolvedSignal.leverage).toFixed(2)),
    leverage: resolvedSignal.leverage,
    takeProfitPrice: resolvedSignal.takeProfitPrice ?? null,
    stopLossPrice: resolvedSignal.stopLossPrice ?? null,
    txid: null,
    positionPubkey: null,
    decisionId: decision.payload.decisionId,
    decisionConfidence: decision.recommendation.confidenceScore,
    decisionShouldTrade: decision.recommendation.shouldTrade,
    decisionSummary: decision.recommendation.explanationSummary,
    decisionTags: protectionOverrideScopes.length > 0
      ? [...decision.recommendation.explanationTags, "explicit-protection-override"]
      : decision.recommendation.explanationTags,
    decisionShadowMode: decision.recommendation.shadowMode,
    strategyClass: signal.strategyClass ?? "smart",
    scalpSetupType: signal.strategyContext?.scalpSetupType ?? null,
    scalpEntryPath: signal.strategyContext?.scalpEntryPath ?? null,
    priceActionTags: signal.strategyContext?.priceActionTags ?? [],
    protectionOverrideReason: explicitOverride?.reason ?? null,
    protectionOverrideScopes,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };

  await createUserPerpsExecution(execution, {
    requireAuthoritative: requireAuthoritativeScalpAudit,
  });

  if (!risk.approved) {
    return {
      ok: false,
      execution,
      decision: decision.recommendation,
      code: risk.code,
      message: risk.message,
    } as const;
  }

  if (session.mode === "live" && session.executionModel === "delegated-ready") {
    try {
      const agentWalletAddress = assertAgentWalletSigner(walletAddress);
      const {
        buildPerpsCloseTransaction,
        buildPerpsTpslTransactionForSignal,
        buildPerpsTransactionForSignal,
        executeSignedPerpsTransaction,
      } = await import("@/lib/perps/jupiterAdapter");
      const executionSignal = {
        signalId: signal.signalId,
        strategyId: signal.smartTradeProfile ?? "bremlogic-agent",
        market: `${signal.asset}-PERP`,
        assetMint: signal.asset,
        side,
        action: "open",
        collateralUsd: resolvedSignal.collateralUsd,
        sizeUsd: Number((resolvedSignal.collateralUsd * resolvedSignal.leverage).toFixed(2)),
        leverage: resolvedSignal.leverage,
        maxSlippageBps: resolvedSignal.maxSlippageBps,
        takeProfit: { enabled: Boolean(resolvedSignal.takeProfitPrice), priceUsd: resolvedSignal.takeProfitPrice ?? null },
        stopLoss: { enabled: Boolean(resolvedSignal.stopLossPrice), priceUsd: resolvedSignal.stopLossPrice ?? null },
        referenceEntryPriceUsd: isScalp ? resolvedSignal.marketContext?.spotPrice ?? null : null,
        estimatedRoundTripFeeRate: isScalp
          ? resolvedSignal.strategyContext?.estimatedRoundTripFeeRate
            ?? DEFAULT_CONSERVATIVE_PERPS_ROUND_TRIP_FEE_RATE
          : null,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        reason: signal.summary,
        walletAddress: agentWalletAddress,
        source: "ui-local",
      } as const;
      // A pre-submit inventory makes a missing Jupiter response pubkey safe to
      // recover without guessing between an older and the newly opened scalp.
      // If this inventory cannot be read, fail before submitting live risk.
      const scalpPreEntrySnapshot = isScalp
        ? await fetchJupiterPerpsAccountSnapshot(agentWalletAddress, { includeRecentTrades: false })
        : null;
      if (scalpPreEntrySnapshot) assertScalpPreEntryInventoryIsAuthoritative(scalpPreEntrySnapshot);
      const baselinePositionPubkeys = (scalpPreEntrySnapshot?.positions ?? []).flatMap((position) => (
        position.accountRef ? [position.accountRef] : []
      ));
      let recoveryRecord: ScalpProtectionRecoveryRecord | null = isScalp
        ? createScalpProtectionRecoveryRecord({
            walletAddress,
            agentWalletAddress,
            executionId: execution.executionId,
            signalId: signal.signalId,
            entryTxid: null,
            asset: signal.asset,
            side,
            market: executionSignal.market,
            assetMint: executionSignal.assetMint,
            collateralUsd: executionSignal.collateralUsd,
            sizeUsd: executionSignal.sizeUsd,
            leverage: executionSignal.leverage,
            maxSlippageBps: executionSignal.maxSlippageBps,
            takeProfitPrice: executionSignal.takeProfit.enabled
              ? executionSignal.takeProfit.priceUsd
              : null,
            stopLossPrice: executionSignal.stopLoss.enabled
              ? executionSignal.stopLoss.priceUsd
              : null,
            referenceEntryPriceUsd: executionSignal.referenceEntryPriceUsd,
            estimatedRoundTripFeeRate: executionSignal.estimatedRoundTripFeeRate
              ?? DEFAULT_CONSERVATIVE_PERPS_ROUND_TRIP_FEE_RATE,
            positionPubkey: null,
            baselinePositionPubkeys,
          })
        : null;
      let recoveryPersistenceError: string | null = null;
      let assertEntryRouteLeaseOwned: () => Promise<void> = async () => undefined;

      const submitEntry = () => executePerpsEntryWithRetries({
        signal: executionSignal,
        build: (attemptSignal) => buildPerpsTransactionForSignal(
          attemptSignal,
          agentWalletAddress,
          undefined,
          { forceDeferredProtection: isScalp }
        ),
        sign: (serializedTxBase64) => signSerializedPerpsTransaction(serializedTxBase64).signedSerializedTxBase64,
        submit: async (signedSerializedTxBase64) => {
          await assertEntryRouteLeaseOwned();
          return executeSignedPerpsTransaction("increase-position", signedSerializedTxBase64);
        },
      });
      // The production route creates the durable guard and acquires the same
      // wallet lease as monitor recovery before Jupiter receives a signed
      // entry. It holds that lease through fill discovery, TP/SL submission,
      // and any fail-closed emergency close.
      const releaseEntryRouteLease = recoveryRecord
        ? await beginScalpProtectionEntryRoute(recoveryRecord)
        : null;
      if (releaseEntryRouteLease) {
        assertEntryRouteLeaseOwned = releaseEntryRouteLease.assertOwned;
      }
      try {
      await assertEntryRouteLeaseOwned();
      const entryResult = await submitEntry();
      const { built, submitted, signal: successfulSignal } = entryResult;
      let positionPubkey = submitted.positionPubkey ?? built.positionPubkey;
      let protectionTxid: string | null = null;
      let protectionError: string | null = null;
      let emergencyCloseTxid: string | null = null;
      let expectedTakeProfitPrice: number | null = null;
      let expectedStopLossPrice: number | null = null;

      const persistRecovery = async (record: ScalpProtectionRecoveryRecord) => {
        recoveryRecord = record;
        await assertEntryRouteLeaseOwned();
        try {
          await saveScalpProtectionRecovery(record);
        } catch (error) {
          recoveryPersistenceError = error instanceof Error
            ? error.message
            : "Scalp recovery state could not be persisted.";
        }
      };

      const persistRecoverySideEffectReservation = async (record: ScalpProtectionRecoveryRecord) => {
        recoveryRecord = record;
        await assertEntryRouteLeaseOwned();
        try {
          await saveScalpProtectionRecovery(record);
        } catch (error) {
          recoveryPersistenceError = error instanceof Error
            ? error.message
            : "Scalp recovery side-effect reservation could not be persisted.";
          throw new Error(
            `Live scalp side effect was blocked because its authoritative recovery reservation failed: ${recoveryPersistenceError}`
          );
        }
      };

      if (recoveryRecord) {
        await persistRecovery(updateScalpProtectionRecoveryRecord(recoveryRecord, {
          entryTxid: submitted.txid!,
          positionPubkey,
          positionIdentitySource: positionPubkey ? "entry-response" : null,
          positionIdentityTxid: positionPubkey ? submitted.txid! : null,
          // This is a durable intent reservation, not a claim that Jupiter has
          // already accepted TP/SL. It prevents the monitor from submitting a
          // duplicate during the narrow gap before this route acquires the
          // wallet recovery lease and builds protection from the confirmed fill.
          status: built.tpslMode === "deferred"
            ? "protection-submitted"
            : positionPubkey ? "protection-pending" : "awaiting-position",
          lastAttemptAt: built.tpslMode === "deferred" ? nowIso() : null,
          lastError: built.tpslMode === "deferred"
            ? "The direct entry route reserved the fill-based TP/SL submission and is preparing it now."
            : null,
          collateralUsd: successfulSignal.collateralUsd,
          sizeUsd: successfulSignal.sizeUsd,
          leverage: successfulSignal.leverage,
          maxSlippageBps: successfulSignal.maxSlippageBps,
          takeProfitPrice: successfulSignal.takeProfit?.enabled
            ? successfulSignal.takeProfit.priceUsd ?? null
            : null,
          stopLossPrice: successfulSignal.stopLoss?.enabled
            ? successfulSignal.stopLoss.priceUsd ?? null
            : null,
        }));
      }

      if (built.tpslMode === "deferred") {
        const resolvePositionPubkey = async () => {
          if (positionPubkey || !recoveryRecord) return positionPubkey;
          const snapshot = await fetchJupiterPerpsAccountSnapshot(agentWalletAddress, { includeRecentTrades: true });
          const discovered = resolveScalpRecoveryPositionPubkey(recoveryRecord, snapshot);
          if (!discovered) return null;
          positionPubkey = discovered;
          await persistRecovery(bindDiscoveredScalpRecoveryPosition(recoveryRecord, discovered));
          return discovered;
        };

        const executeProtectionFailClosed = () => executeDeferredProtectionFailClosed({
          isScalp,
          positionPubkey,
          getPositionPubkey: () => positionPubkey,
          attachProtection: async () => {
            const confirmedPositionPubkey = isScalp
              ? await resolvePositionPubkey()
              : positionPubkey;
            if (!confirmedPositionPubkey) {
              throw new Error("Jupiter did not return the position reference needed to attach TP/SL.");
            }
            const protection = await buildPerpsTpslTransactionForSignal(
              {
                ...successfulSignal,
                referenceEntryPriceUsd: executionSignal.referenceEntryPriceUsd,
                estimatedRoundTripFeeRate: executionSignal.estimatedRoundTripFeeRate,
              },
              agentWalletAddress,
              confirmedPositionPubkey,
              SCALP_MINIMUM_NET_PROFIT_USD,
              undefined,
              undefined,
              { requireLivePosition: isScalp }
            );
            if (!protection) throw new Error("Jupiter did not build the requested TP/SL protection transaction.");
            expectedTakeProfitPrice = plannedTriggerPrice(protection.plannedTpsl, "tp");
            expectedStopLossPrice = plannedTriggerPrice(protection.plannedTpsl, "sl");
            if (isScalp && recoveryRecord) {
              await persistRecoverySideEffectReservation(updateScalpProtectionRecoveryRecord(recoveryRecord, {
                positionPubkey: confirmedPositionPubkey,
                status: "protection-submitted",
                protectionTxid: null,
                expectedTakeProfitPrice,
                expectedStopLossPrice,
                lastAttemptAt: nowIso(),
                attemptCount: recoveryRecord.attemptCount + 1,
                lastError: "A full-position TP/SL submission is authoritatively reserved and awaiting Jupiter submission.",
              }));
            }
            const signedProtection = signSerializedPerpsTransaction(protection.serializedTxBase64);
            let submittedProtection: Awaited<ReturnType<typeof executeSignedPerpsTransaction>>;
            await assertEntryRouteLeaseOwned();
            try {
              submittedProtection = await executeSignedPerpsTransaction(
                "create-tpsl",
                signedProtection.signedSerializedTxBase64
              );
            } catch (error) {
              if (isScalp) throw createScalpProtectionSubmissionUncertainError(error);
              throw error;
            }
            if (!submittedProtection.txid && isScalp) {
              throw createScalpProtectionSubmissionUncertainError(
                new Error("Jupiter returned no TP/SL transaction signature.")
              );
            }
            return submittedProtection.txid ?? null;
          },
          emergencyClose: async (confirmedPositionPubkey) => {
            const close = await buildPerpsCloseTransaction(confirmedPositionPubkey, "USDC", "100");
            if (isScalp && recoveryRecord) {
              await persistRecoverySideEffectReservation(updateScalpProtectionRecoveryRecord(recoveryRecord, {
                positionPubkey: confirmedPositionPubkey,
                status: "emergency-close-submitted",
                emergencyCloseTxid: null,
                lastAttemptAt: nowIso(),
                attemptCount: recoveryRecord.attemptCount + 1,
                lastError: "An emergency full close is authoritatively reserved and awaiting Jupiter submission.",
              }));
            }
            const signedClose = signSerializedPerpsTransaction(close.serializedTxBase64);
            let submittedClose: Awaited<ReturnType<typeof executeSignedPerpsTransaction>>;
            await assertEntryRouteLeaseOwned();
            try {
              submittedClose = await executeSignedPerpsTransaction(
                "decrease-position",
                signedClose.signedSerializedTxBase64
              );
            } catch (error) {
              throw createScalpEmergencyCloseSubmissionUncertainError(error);
            }
            return submittedClose.txid ?? null;
          },
        });
        // The route-wide lease acquired before entry is still held here. The
        // status reservations above survive a process crash or a post-submit
        // txid-save failure after that lease eventually ends.
        const protectionResult = await executeProtectionFailClosed();
        protectionTxid = protectionResult.protectionTxid;
        protectionError = protectionResult.error;
        emergencyCloseTxid = protectionResult.status === "emergency-close-submitted"
          ? protectionResult.emergencyCloseTxid
          : null;

        if (isScalp && recoveryRecord) {
          if (protectionResult.status === "protected") {
            await persistRecovery(updateScalpProtectionRecoveryRecord(recoveryRecord, {
              positionPubkey,
              status: "protection-submitted",
              protectionTxid: protectionResult.protectionTxid,
              expectedTakeProfitPrice,
              expectedStopLossPrice,
              lastAttemptAt: nowIso(),
              attemptCount: recoveryRecord.attemptCount + 1,
              lastError: "The TP/SL transaction was submitted and is awaiting confirmation of both live triggers.",
            }));
          } else if (protectionResult.status === "emergency-close-submitted") {
            await persistRecovery(updateScalpProtectionRecoveryRecord(recoveryRecord, {
              positionPubkey,
              status: "emergency-close-submitted",
              emergencyCloseTxid: protectionResult.emergencyCloseTxid,
              lastAttemptAt: nowIso(),
              attemptCount: recoveryRecord.attemptCount + 1,
              lastError: protectionResult.error,
            }));
          } else {
            await persistRecovery(updateScalpProtectionRecoveryRecord(recoveryRecord, {
              positionPubkey,
              // Never downgrade a durable side-effect reservation merely
              // because the client did not receive a transaction signature.
              // Jupiter may still have accepted that TP/SL or full close; the
              // monitor must first observe the chain and honor the retry delay.
              status: recoveryRecord.status === "protection-submitted"
                || recoveryRecord.status === "emergency-close-submitted"
                ? recoveryRecord.status
                : positionPubkey ? "protection-pending" : "awaiting-position",
              lastAttemptAt: nowIso(),
              attemptCount: recoveryRecord.attemptCount + 1,
              lastError: protectionResult.error,
            }));
          }
        }

        if (recoveryPersistenceError) {
          protectionError = protectionError
            ? `${protectionError} Recovery persistence warning: ${recoveryPersistenceError}`
            : `Recovery persistence warning: ${recoveryPersistenceError}`;
        }

        if (isScalp && protectionResult.status !== "protected") {
          const failClosedMessage = emergencyCloseTxid
            ? `Scalp TP/SL could not attach (${protectionError}); emergency full close submitted (${emergencyCloseTxid}).`
            : recoveryRecord
              ? `Scalp entry is not protected yet (${protectionError}); durable recovery is armed and all new entries are blocked until it attaches TP/SL or confirms an emergency close.`
              : `CRITICAL: scalp entry submitted without protection and no durable recovery could be armed: ${protectionError}`;
          const failed = await updateUserPerpsExecution(walletAddress, execution.executionId, {
            status: "failed",
            txid: submitted.txid,
            positionPubkey,
            collateralUsd: successfulSignal.collateralUsd,
            sizeUsd: successfulSignal.sizeUsd,
            leverage: successfulSignal.leverage,
            attemptCount: entryResult.attemptCount,
            retrySummary: entryResult.failures,
            errorMessage: failClosedMessage,
            reasonMessage: failClosedMessage,
          }, { requireAuthoritative: requireAuthoritativeScalpAudit });
          return {
            ok: false,
            execution: failed ?? execution,
            autonomousResult: {
              agentWalletAddress,
              txid: submitted.txid,
              positionPubkey,
              protectionTxid: null,
              emergencyCloseTxid,
              tpslMode: built.tpslMode,
              attemptCount: entryResult.attemptCount,
            },
            decision: decision.recommendation,
            code: emergencyCloseTxid
              ? "SCALP_PROTECTION_FAILED_EMERGENCY_CLOSE_SUBMITTED"
              : recoveryRecord
                ? "SCALP_PROTECTION_RECOVERY_PENDING"
                : "SCALP_UNPROTECTED_POSITION_CRITICAL",
            message: failClosedMessage,
          } as const;
        }
      }

      const updated = await updateUserPerpsExecution(walletAddress, execution.executionId, {
        status: "submitted",
        txid: submitted.txid,
        positionPubkey,
        collateralUsd: successfulSignal.collateralUsd,
        sizeUsd: successfulSignal.sizeUsd,
        leverage: successfulSignal.leverage,
        attemptCount: entryResult.attemptCount,
        retrySummary: entryResult.failures,
        errorMessage: protectionError,
        reasonMessage: protectionError
          ? `Entry submitted, but automatic TP/SL attachment needs attention: ${protectionError}`
          : entryResult.attemptCount > 1
            ? `Entry submitted on parameter attempt ${entryResult.attemptCount} of 3 at ${successfulSignal.leverage}x leverage with ${successfulSignal.collateralUsd.toFixed(2)} USDC collateral.`
            : execution.reasonMessage,
      }, { requireAuthoritative: requireAuthoritativeScalpAudit });
      return {
        ok: true,
        execution: updated ?? execution,
        autonomousResult: {
          agentWalletAddress,
          txid: submitted.txid,
          positionPubkey,
          protectionTxid,
          tpslMode: built.tpslMode,
          attemptCount: entryResult.attemptCount,
        },
        decision: decision.recommendation,
        message: protectionError
          ? `The signal was submitted, but automatic TP/SL attachment needs attention: ${protectionError}`
          : built.tpslMode === "deferred"
            ? isScalp
              ? "The signal and TP/SL transaction were submitted. New entries remain blocked until a fresh Jupiter snapshot confirms both live triggers."
              : "The signal was submitted and TP/SL protection was attached automatically after entry."
            : built.tpslMode === "bundled"
              ? "The signal and TP/SL protection were submitted together through the associated autonomous wallet."
              : "The signal was submitted through the associated autonomous wallet.",
      } as const;
      } finally {
        await releaseEntryRouteLease?.();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Autonomous Perps execution failed.";
      const updated = await updateUserPerpsExecution(walletAddress, execution.executionId, {
        status: "failed",
        errorMessage: message,
      }, { requireAuthoritative: requireAuthoritativeScalpAudit });
      return {
        ok: false,
        execution: updated ?? execution,
        decision: decision.recommendation,
        code: "AGENT_EXECUTION_FAILED",
        message,
      } as const;
    }
  }

  return {
    ok: true,
    execution,
    preparedAction: {
      asset: signal.asset,
      collateralToken: "USDC" as const,
      leverage: String(resolvedSignal.leverage),
      maxSlippageBps: String(resolvedSignal.maxSlippageBps),
      side,
      stopLossPrice: resolvedSignal.stopLossPrice ?? null,
      takeProfitPrice: resolvedSignal.takeProfitPrice ?? null,
      uiAmount: resolvedSignal.collateralUsd,
    },
    decision: decision.recommendation,
    message:
      session.mode === "paper"
        ? "Paper execution recorded for the active user session."
        : "Approval-assisted execution prepared for the active user wallet session.",
  } as const;
}

/** Public/user-authored routing. Live scalp provenance is rejected above. */
export function routePerpsSignalForUser(walletAddress: string, signal: PerpsAgentSignal) {
  return routePerpsSignal(walletAddress, signal, null);
}

/** Server-only entry point used by the autonomous monitor for detector-authored scalp context. */
export function routePerpsSignalFromAutonomousMonitor(walletAddress: string, signal: PerpsAgentSignal) {
  return routePerpsSignal(walletAddress, signal, TRUSTED_AUTONOMOUS_MONITOR_AUTHORITY);
}
