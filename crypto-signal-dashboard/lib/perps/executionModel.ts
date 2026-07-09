import type { PerpsAutomationSession } from "@/lib/perps/sessionTypes";

export function resolvePerpsExecutionModel(session: Pick<PerpsAutomationSession, "mode">, options?: { delegatedExecutionAvailable?: boolean }) {
  if (options?.delegatedExecutionAvailable && session.mode === "live") {
    return "delegated-ready" as const;
  }

  return "approval-assisted" as const;
}

export function getExecutionModelMessage(model: "approval-assisted" | "delegated-ready") {
  if (model === "delegated-ready") {
    return "Delegated execution support is available for this session.";
  }

  return "Approval-assisted mode uses the connected user's wallet session. BremLogic does not custody user keys.";
}
