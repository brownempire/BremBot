import crypto from "node:crypto";

import { getTradeDecisionConfig } from "@/lib/decision/config";
import { createTradeDecisionRecord } from "@/lib/decision/engine";
import { appendTradeDecisionRecord } from "@/lib/decision/logStore";
import { getPerpsSessionConfig } from "@/lib/perps/sessionConfig";
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
import { createUserPerpsExecution, listUserPerpsExecutions } from "@/lib/perps/userExecutionAudit";
import { evaluateUserScopedPerpsRisk } from "@/lib/perps/userScopedRisk";

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
  const delegation = getPerpsDelegationCapability();
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
    walletWriteEnabled: requestedMode === "paper" ? true : input.platform === "native",
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

  const existingExecutions = await listUserPerpsExecutions(walletAddress);
  const decision = createTradeDecisionRecord({
    walletAddress,
    session,
    signal,
    existingExecutions,
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
      ? (session.mode === "paper" ? "paper_executed" : "approval_required")
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
