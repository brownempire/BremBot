import type { PerpsAutomationSession, PerpsAgentSignal, PerpsUserExecution } from "@/lib/perps/sessionTypes";

export function evaluateUserScopedPerpsRisk(input: {
  session: PerpsAutomationSession;
  signal: PerpsAgentSignal & { sizeUsd: number };
  existingExecutions: PerpsUserExecution[];
  maxLeverage: number;
  maxTradePct: number;
  maxExposurePct: number;
  assumedCapitalUsd?: number;
}) {
  const capitalUsd = input.assumedCapitalUsd ?? 1000;
  const currentOpenExposure = input.existingExecutions
    .filter((entry) => ["prepared", "approval_required", "submitted", "confirmed", "paper_executed"].includes(entry.status))
    .reduce((sum, entry) => sum + entry.sizeUsd, 0);

  if (input.session.killSwitch) {
    return { approved: false, code: "KILL_SWITCH", message: "Perps automation is blocked by the global kill switch." };
  }

  if (input.session.sessionState !== "clocked_in") {
    return { approved: false, code: "SESSION_INACTIVE", message: "Clock In is required before perps automation can run." };
  }

  if (!input.session.appOpen || !input.session.appForeground || !input.session.walletConnected) {
    return { approved: false, code: "SESSION_NOT_READY", message: "The user session is no longer active in the foreground app." };
  }

  if (input.session.mode === "live" && !input.session.walletWriteEnabled) {
    return { approved: false, code: "WALLET_WRITE_UNAVAILABLE", message: "Live automation requires an active writable user wallet session." };
  }

  if (input.signal.leverage > input.maxLeverage) {
    return { approved: false, code: "LEVERAGE_TOO_HIGH", message: `Requested leverage ${input.signal.leverage}x exceeds the configured limit of ${input.maxLeverage}x.` };
  }

  if (input.signal.sizeUsd > capitalUsd * input.maxTradePct) {
    return { approved: false, code: "SIZE_TOO_LARGE", message: "Requested perps size exceeds the current per-user guardrails." };
  }

  if (currentOpenExposure + input.signal.sizeUsd > capitalUsd * input.maxExposurePct) {
    return { approved: false, code: "EXPOSURE_TOO_HIGH", message: "This trade would push the user's exposure above the current cap." };
  }

  const duplicate = input.existingExecutions.find((entry) => entry.signalId === input.signal.signalId);
  if (duplicate) {
    return { approved: false, code: "DUPLICATE_SIGNAL", message: "This signal was already routed for the active user session." };
  }

  return { approved: true, code: "APPROVED", message: "User-scoped perps session approved the signal." };
}
