import { getAgentWalletForOwner } from "@/lib/perps/agentWallet";
import { getPerpsTradingKeypair } from "@/lib/perps/signer";

export function getPerpsDelegationCapability(ownerWalletAddress?: string | null) {
  const agentWalletAddress = getAgentWalletForOwner(ownerWalletAddress);
  if (agentWalletAddress) {
    try {
      if (getPerpsTradingKeypair().publicKey.toBase58() === agentWalletAddress) {
        return {
          available: true,
          model: "delegated-ready" as const,
          agentWalletAddress,
          message: "Autonomous execution is enabled through the associated agent wallet.",
        };
      }
    } catch {
      // Missing or invalid signer credentials fail closed below.
    }
  }

  return {
    available: false,
    model: "approval-assisted" as const,
    agentWalletAddress: null,
    message: "Delegated Jupiter Perps execution is not available in the current wallet/session integration. Falling back to approval-assisted mode.",
  };
}
