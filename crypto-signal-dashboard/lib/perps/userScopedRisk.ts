import type { PerpsAutomationSession, PerpsAgentSignal, PerpsUserExecution } from "@/lib/perps/sessionTypes";
import { isIsolatedLowBalanceMinimumTrade } from "@/lib/perps/scalpAllocation";

export function evaluateUserScopedPerpsRisk(input: {
  session: PerpsAutomationSession;
  signal: PerpsAgentSignal & { sizeUsd: number };
  existingExecutions: PerpsUserExecution[];
  maxLeverage: number;
  maxTradePct: number;
  maxExposurePct: number;
}) {
  const reportedAvailableUsdc = input.signal.marketContext?.availableUsdc;
  const availableCapitalUsd = typeof reportedAvailableUsdc === "number" && Number.isFinite(reportedAvailableUsdc) && reportedAvailableUsdc > 0
    ? reportedAvailableUsdc
    : input.signal.collateralUsd;
  const currentCommittedCollateral = input.existingExecutions
    .filter((entry) => ["prepared", "approval_required", "submitted", "confirmed", "paper_executed"].includes(entry.status))
    .reduce((sum, entry) => sum + entry.collateralUsd, 0);
  const maxTradeCollateralUsd = availableCapitalUsd * input.maxTradePct;
  const maxExposureCollateralUsd = availableCapitalUsd * input.maxExposurePct;
  const lowBalanceMinimumTrade = isIsolatedLowBalanceMinimumTrade({
    availableUsdc: availableCapitalUsd,
    collateralUsd: input.signal.collateralUsd,
    hasOpenPosition: input.signal.marketContext?.hasOpenPosition,
    committedCollateralUsd: currentCommittedCollateral,
  });
  const roundUsd = (value: number) => Number(value.toFixed(2));

  if (input.session.killSwitch) {
    return { approved: false, code: "KILL_SWITCH", message: "Perps automation is blocked by the global kill switch." };
  }

  if (input.session.sessionState !== "clocked_in") {
    return { approved: false, code: "SESSION_INACTIVE", message: "Clock In is required before perps automation can run." };
  }

  if (
    input.session.executionModel !== "delegated-ready"
    && (!input.session.appOpen || !input.session.appForeground || !input.session.walletConnected)
  ) {
    return { approved: false, code: "SESSION_NOT_READY", message: "The user session is no longer active in the foreground app." };
  }

  if (input.session.mode === "live" && !input.session.walletWriteEnabled) {
    return { approved: false, code: "WALLET_WRITE_UNAVAILABLE", message: "Live automation requires an active writable user wallet session." };
  }

  if (input.signal.leverage > input.maxLeverage) {
    return { approved: false, code: "LEVERAGE_TOO_HIGH", message: `Requested leverage ${input.signal.leverage}x exceeds the configured limit of ${input.maxLeverage}x.` };
  }

  if (!lowBalanceMinimumTrade && input.signal.collateralUsd > maxTradeCollateralUsd) {
    return {
      approved: false,
      code: "SIZE_TOO_LARGE",
      message: `Requested collateral $${roundUsd(input.signal.collateralUsd)} exceeds the $${roundUsd(maxTradeCollateralUsd)} wallet-allocation guardrail.`,
    };
  }

  if (!lowBalanceMinimumTrade && currentCommittedCollateral + input.signal.collateralUsd > maxExposureCollateralUsd) {
    return {
      approved: false,
      code: "EXPOSURE_TOO_HIGH",
      message: `Committed collateral would reach $${roundUsd(currentCommittedCollateral + input.signal.collateralUsd)}, above the $${roundUsd(maxExposureCollateralUsd)} wallet-allocation cap.`,
    };
  }

  const duplicate = input.existingExecutions.find((entry) => entry.signalId === input.signal.signalId);
  if (duplicate) {
    return { approved: false, code: "DUPLICATE_SIGNAL", message: "This signal was already routed for the active user session." };
  }

  return { approved: true, code: "APPROVED", message: "User-scoped perps session approved the signal." };
}
