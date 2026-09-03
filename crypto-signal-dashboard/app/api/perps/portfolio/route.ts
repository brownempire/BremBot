import { getAgentWalletForOwner, type PerpsWalletRole } from "@/lib/perps/agentWallet";
import { getAuthorizedWalletAddress } from "@/lib/perps/sessionAuth";
import {
  type JupiterPerpsAccountSnapshot,
} from "@/lib/jupiterPerps";
import { loadAccountedPerpsSnapshot } from "@/lib/perps/pnlAccountingServer";
import { getWalletUsdcBalance } from "@/lib/perps/walletBalance";

export const dynamic = "force-dynamic";

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
      await loadAccountedPerpsSnapshot(wallet.address),
      wallet.address,
      wallet.role
    ))
  );
  const agentAvailableUsdc = await getWalletUsdcBalance(agentWalletAddress).catch(() => null);
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
