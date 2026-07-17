import crypto from "node:crypto";

import { getTradeDecisionConfig } from "@/lib/decision/config";
import { createTradeDecisionRecord } from "@/lib/decision/engine";
import { appendTradeDecisionRecord } from "@/lib/decision/logStore";
import { getActiveDecisionLearningProfile } from "@/lib/decision/learningStore";
import { getPerpsSessionConfig } from "@/lib/perps/sessionConfig";
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
import { createUserPerpsExecution, listUserPerpsExecutions, updateUserPerpsExecution } from "@/lib/perps/userExecutionAudit";
import { evaluateUserScopedPerpsRisk } from "@/lib/perps/userScopedRisk";
import { signSerializedPerpsTransaction } from "@/lib/perps/signer";
import { executePerpsEntryWithRetries } from "@/lib/perps/entryRetry";

function nowIso() {
  return new Date().toISOString();
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

export async function routePerpsSignalForUser(walletAddress: string, signal: PerpsAgentSignal) {
  const config = getPerpsSessionConfig();
  const decisionConfig = getTradeDecisionConfig();
  const session = await getPerpsSessionWithTimeout(walletAddress);
  if (!session) {
    return { ok: false, code: "NO_SESSION", message: "Clock In before routing automated perps signals." } as const;
  }

  const [existingExecutions, learningProfile] = await Promise.all([
    listUserPerpsExecutions(walletAddress),
    getActiveDecisionLearningProfile(walletAddress),
  ]);
  const decision = createTradeDecisionRecord({
    walletAddress,
    session,
    signal,
    existingExecutions,
    learningProfile,
  });
  await appendTradeDecisionRecord(decision);

  const resolvedSignal =
    !decisionConfig.shadowMode && decisionConfig.allowExecutionOverrides
      ? {
          ...signal,
          collateralUsd: decision.recommendation.recommendedCollateralUsd,
          leverage: decision.recommendation.recommendedLeverage,
          takeProfitPrice: decision.recommendation.recommendedTakeProfitPrice,
          stopLossPrice: decision.recommendation.recommendedStopLossPrice,
        }
      : signal;

  if (!decisionConfig.shadowMode && !decision.recommendation.shouldTrade) {
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
    decisionTags: decision.recommendation.explanationTags,
    decisionShadowMode: decision.recommendation.shadowMode,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };

  await createUserPerpsExecution(execution);

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
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        reason: signal.summary,
        walletAddress: agentWalletAddress,
        source: "ui-local",
      } as const;
      const entryResult = await executePerpsEntryWithRetries({
        signal: executionSignal,
        build: (attemptSignal) => buildPerpsTransactionForSignal(attemptSignal, agentWalletAddress),
        sign: (serializedTxBase64) => signSerializedPerpsTransaction(serializedTxBase64).signedSerializedTxBase64,
        submit: (signedSerializedTxBase64) => executeSignedPerpsTransaction("increase-position", signedSerializedTxBase64),
      });
      const { built, submitted, signal: successfulSignal } = entryResult;
      const positionPubkey = submitted.positionPubkey ?? built.positionPubkey;
      let protectionTxid: string | null = null;
      let protectionError: string | null = null;
      if (built.tpslMode === "deferred") {
        if (!positionPubkey) {
          protectionError = "Jupiter did not return the position reference needed to attach TP/SL.";
        } else {
          for (let attempt = 0; attempt < 3 && !protectionTxid; attempt += 1) {
            if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, attempt * 750));
            try {
              const protection = await buildPerpsTpslTransactionForSignal(
                successfulSignal,
                agentWalletAddress,
                positionPubkey
              );
              if (!protection) break;
              const signedProtection = signSerializedPerpsTransaction(protection.serializedTxBase64);
              const submittedProtection = await executeSignedPerpsTransaction(
                "create-tpsl",
                signedProtection.signedSerializedTxBase64
              );
              protectionTxid = submittedProtection.txid ?? null;
              if (!protectionTxid) throw new Error("Jupiter did not return a TP/SL transaction signature.");
              protectionError = null;
            } catch (protectionFailure) {
              protectionError = protectionFailure instanceof Error
                ? protectionFailure.message
                : "Unable to attach autonomous TP/SL protection.";
            }
          }
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
      });
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
            ? "The signal was submitted and TP/SL protection was attached automatically after entry."
            : built.tpslMode === "bundled"
              ? "The signal and TP/SL protection were submitted together through the associated autonomous wallet."
              : "The signal was submitted through the associated autonomous wallet.",
      } as const;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Autonomous Perps execution failed.";
      const updated = await updateUserPerpsExecution(walletAddress, execution.executionId, {
        status: "failed",
        errorMessage: message,
      });
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
