export function getPerpsDelegationCapability() {
  return {
    available: false,
    model: "approval-assisted" as const,
    message: "Delegated Jupiter Perps execution is not available in the current wallet/session integration. Falling back to approval-assisted mode.",
  };
}
