import crypto from "node:crypto";

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
    endedAt: nowIso(),
    warning: reason ?? existing.warning,
  };
  await savePerpsSession(next);
  return next;
}

export async function heartbeatPerpsSession(walletAddress: string, input: PerpsSessionHeartbeatInput) {
  const existing = await getPerpsSession(walletAddress);
  if (!existing) return null;

  const shouldClockOut = !input.appOpen || !input.appForeground || !input.walletConnected;
  if (shouldClockOut) {
    return clockOutPerpsSession(walletAddress, input.reason ?? "Session ended because the app or wallet left the active foreground state.");
  }

  const next: PerpsAutomationSession = {
    ...existing,
    lastHeartbeatAt: nowIso(),
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
  const session = await getPerpsSession(walletAddress);
  if (!session) {
    return { ok: false, code: "NO_SESSION", message: "Clock In before routing automated perps signals." } as const;
  }

  const existingExecutions = await listUserPerpsExecutions(walletAddress);
  const side = signal.direction === "bullish" ? "long" : "short";
  const risk = evaluateUserScopedPerpsRisk({
    session,
    signal: {
      ...signal,
      sizeUsd: Number((signal.collateralUsd * signal.leverage).toFixed(2)),
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
    collateralUsd: signal.collateralUsd,
    sizeUsd: Number((signal.collateralUsd * signal.leverage).toFixed(2)),
    leverage: signal.leverage,
    takeProfitPrice: signal.takeProfitPrice ?? null,
    stopLossPrice: signal.stopLossPrice ?? null,
    txid: null,
    positionPubkey: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };

  await createUserPerpsExecution(execution);

  if (!risk.approved) {
    return {
      ok: false,
      execution,
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
      leverage: String(signal.leverage),
      maxSlippageBps: String(signal.maxSlippageBps),
      side,
      stopLossPrice: signal.stopLossPrice ?? null,
      takeProfitPrice: signal.takeProfitPrice ?? null,
      uiAmount: signal.collateralUsd,
    },
    message:
      session.mode === "paper"
        ? "Paper execution recorded for the active user session."
        : "Approval-assisted execution prepared for the active user wallet session.",
  } as const;
}
