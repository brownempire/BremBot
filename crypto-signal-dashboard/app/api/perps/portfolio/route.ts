import { getAgentWalletForOwner, type PerpsWalletRole } from "@/lib/perps/agentWallet";
import { getAuthorizedWalletAddress } from "@/lib/perps/sessionAuth";
import {
  fetchJupiterPerpsAccountSnapshot,
  type JupiterPerpsAccountSnapshot,
} from "@/lib/jupiterPerps";
import { clusterApiUrl, Connection, PublicKey } from "@solana/web3.js";

export const dynamic = "force-dynamic";

const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

async function getUsdcBalance(walletAddress: string | null) {
  if (!walletAddress) return null;
  const rpcUrl = process.env.SOLANA_RPC_URL?.trim()
    || process.env.NEXT_PUBLIC_SOLANA_RPC_URL?.trim()
    || clusterApiUrl("mainnet-beta");
  const accounts = await new Connection(rpcUrl, "confirmed").getParsedTokenAccountsByOwner(
    new PublicKey(walletAddress),
    { mint: USDC_MINT }
  );
  return accounts.value.reduce((sum, entry) => {
    const amount = entry.account.data.parsed?.info?.tokenAmount?.uiAmount;
    return sum + (typeof amount === "number" && Number.isFinite(amount) ? amount : 0);
  }, 0);
}

function labelSnapshot(snapshot: JupiterPerpsAccountSnapshot, walletAddress: string, walletRole: PerpsWalletRole) {
  return {
    positions: snapshot.positions.map((position) => ({
      ...position,
      id: `${walletRole}:${position.id}`,
      walletAddress,
      walletRole,
    })),
    pendingTriggers: snapshot.pendingTriggers.map((trigger) => ({
      ...trigger,
      id: `${walletRole}:${trigger.id}`,
      walletAddress,
      walletRole,
    })),
    recentTrades: snapshot.recentTrades.map((trade) => ({
      ...trade,
      id: `${walletRole}:${trade.id}`,
      walletAddress,
      walletRole,
    })),
  };
}

export async function GET(request: Request) {
  const ownerWalletAddress = await getAuthorizedWalletAddress(request);
  if (!ownerWalletAddress) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const agentWalletAddress = getAgentWalletForOwner(ownerWalletAddress);
  const wallets = [
    { address: ownerWalletAddress, role: "primary" as const },
    ...(agentWalletAddress && agentWalletAddress !== ownerWalletAddress
      ? [{ address: agentWalletAddress, role: "agent" as const }]
      : []),
  ];
  const results = await Promise.allSettled(
    wallets.map(async (wallet) => labelSnapshot(
      await fetchJupiterPerpsAccountSnapshot(wallet.address),
      wallet.address,
      wallet.role
    ))
  );
  const agentAvailableUsdc = await getUsdcBalance(agentWalletAddress).catch(() => null);
  const fulfilled = results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);

  if (fulfilled.length === 0) {
    const firstFailure = results.find((result) => result.status === "rejected");
    const message = firstFailure?.status === "rejected" && firstFailure.reason instanceof Error
      ? firstFailure.reason.message
      : "Unable to load the associated Perps portfolio.";
    return Response.json({ error: message }, { status: 502 });
  }

  return Response.json({
    ownerWalletAddress,
    agentWalletAddress,
    agentAvailableUsdc,
    positions: fulfilled.flatMap((snapshot) => snapshot.positions),
    pendingTriggers: fulfilled.flatMap((snapshot) => snapshot.pendingTriggers),
    recentTrades: fulfilled
      .flatMap((snapshot) => snapshot.recentTrades)
      .sort((left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0)),
    partial: fulfilled.length !== wallets.length,
  }, {
    headers: { "Cache-Control": "no-store, max-age=0" },
  });
}
