import { PublicKey } from "@solana/web3.js";

import { getPerpsTradingKeypair } from "@/lib/perps/signer";

export type PerpsWalletRole = "primary" | "agent";

function normalizePublicKey(value: string | null | undefined) {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return null;

  try {
    return new PublicKey(trimmed).toBase58();
  } catch {
    return null;
  }
}

function parseAssociationMap() {
  const raw = process.env.PERPS_AGENT_WALLET_ASSOCIATIONS?.trim();
  const associations = new Map<string, string>();

  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      for (const [owner, agent] of Object.entries(parsed)) {
        const ownerAddress = normalizePublicKey(owner);
        const agentAddress = normalizePublicKey(typeof agent === "string" ? agent : null);
        if (ownerAddress && agentAddress) associations.set(ownerAddress, agentAddress);
      }
    } catch {
      // Invalid JSON fails closed; the singleton variables below can still be used.
    }
  }

  const ownerAddress = normalizePublicKey(process.env.PERPS_AGENT_OWNER_WALLET);
  const agentAddress = normalizePublicKey(process.env.PERPS_AGENT_WALLET_PUBLIC_KEY);
  if (ownerAddress && agentAddress) associations.set(ownerAddress, agentAddress);

  return associations;
}

export function getAgentWalletForOwner(ownerWalletAddress: string | null | undefined) {
  const normalizedOwner = normalizePublicKey(ownerWalletAddress);
  if (!normalizedOwner) return null;
  return parseAssociationMap().get(normalizedOwner) ?? null;
}

export function assertAgentWalletSigner(ownerWalletAddress: string) {
  const configuredAgent = getAgentWalletForOwner(ownerWalletAddress);
  if (!configuredAgent) {
    throw new Error("No autonomous Perps wallet is associated with this primary wallet.");
  }

  const signerAddress = getPerpsTradingKeypair().publicKey.toBase58();
  if (signerAddress !== configuredAgent) {
    throw new Error("The configured autonomous Perps signer does not match the associated agent wallet.");
  }

  return configuredAgent;
}
