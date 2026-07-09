import crypto from "node:crypto";

import { createPerpsExecution, listPerpsExecutions, updatePerpsExecution } from "@/lib/perps/auditLog";
import { getPerpsRuntimeSettings } from "@/lib/perps/config";
import { buildRiskDecision } from "@/lib/perps/riskGuard";
import { type PerpsExecutionRecord, type PerpsSignalPayload } from "@/lib/perps/types";

export async function executePerpsSignal(signal: PerpsSignalPayload, options?: { killSwitchOverride?: boolean | null }) {
  const settings = getPerpsRuntimeSettings();
  const existingExecutions = await listPerpsExecutions();
  const effectiveKillSwitch = options?.killSwitchOverride ?? settings.killSwitch;
  const riskDecision = buildRiskDecision({
    signal,
    settings: {
      ...settings,
      killSwitch: effectiveKillSwitch,
    },
    existingExecutions,
    duplicateNonceSeen: false,
  });

  const now = new Date().toISOString();
  const record: PerpsExecutionRecord = {
    id: `exec_${crypto.randomUUID()}`,
    signalId: signal.signalId,
    strategyId: signal.strategyId,
    market: signal.market,
    assetMint: signal.assetMint,
    side: signal.side,
    action: signal.action,
    collateralUsd: signal.collateralUsd,
    sizeUsd: signal.sizeUsd,
    leverage: signal.leverage,
    maxSlippageBps: signal.maxSlippageBps,
    reason: signal.reason,
    walletAddress: signal.walletAddress ?? null,
    source: signal.source ?? "webhook",
    mode: settings.paperTrading ? "paper" : "live",
    status: riskDecision.approved ? "received" : "risk_blocked",
    riskDecision,
    errorCode: riskDecision.approved ? null : riskDecision.code,
    errorMessage: riskDecision.approved ? null : riskDecision.message,
    takeProfitPriceUsd: signal.takeProfit?.enabled ? signal.takeProfit.priceUsd ?? null : null,
    stopLossPriceUsd: signal.stopLoss?.enabled ? signal.stopLoss.priceUsd ?? null : null,
    txid: null,
    positionPubkey: null,
    createdAt: now,
    updatedAt: now,
    expiresAt: signal.expiresAt,
  };

  await createPerpsExecution(record);

  if (!riskDecision.approved) {
    return {
      ok: false,
      executionId: record.id,
      signalId: record.signalId,
      status: record.status,
      riskDecision: riskDecision.code,
      detail: riskDecision.message,
      mode: record.mode,
    };
  }

  if (settings.paperTrading) {
    const updated = await updatePerpsExecution(record.id, {
      status: "paper_approved",
    });

    return {
      ok: true,
      executionId: record.id,
      signalId: record.signalId,
      status: updated?.status ?? "paper_approved",
      riskDecision: riskDecision.code,
      detail: riskDecision.message,
      mode: "paper" as const,
    };
  }

  const message =
    "Direct backend live execution is disabled in the non-custodial architecture. Use the per-user Clock In session with approval-assisted execution instead.";
  await updatePerpsExecution(record.id, {
    status: "failed",
    errorCode: "BACKEND_LIVE_DISABLED",
    errorMessage: message,
  });
  return {
    ok: false,
    executionId: record.id,
    signalId: record.signalId,
    status: "failed",
    riskDecision: riskDecision.code,
    detail: message,
    mode: "live" as const,
  };
}
