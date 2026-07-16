import { createPerpsClient, type InputToken } from "jupiter-perps-api-sdk";

import { assertAgentWalletSigner } from "@/lib/perps/agentWallet";
import { getAuthorizedWalletAddress } from "@/lib/perps/sessionAuth";
import { signSerializedPerpsTransaction } from "@/lib/perps/signer";
import { fetchJupiterPerpsAccountSnapshot } from "@/lib/jupiterPerps";

export const dynamic = "force-dynamic";

const perps = createPerpsClient();

function isReceiveToken(value: string | undefined): value is InputToken {
  return value === "SOL" || value === "ETH" || value === "BTC" || value === "USDC";
}

export async function POST(request: Request) {
  const ownerWalletAddress = await getAuthorizedWalletAddress(request);
  if (!ownerWalletAddress) return Response.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const payload = await request.json().catch(() => null) as {
      maxSlippageBps?: string;
      positionPubkey?: string;
      receiveToken?: string;
    } | null;
    const positionPubkey = payload?.positionPubkey?.trim();
    const receiveToken = payload?.receiveToken?.trim();
    const maxSlippageBps = payload?.maxSlippageBps?.trim() || "100";
    if (!positionPubkey || !isReceiveToken(receiveToken)) {
      return Response.json({ error: "Incomplete autonomous close request." }, { status: 400 });
    }

    const agentWalletAddress = assertAgentWalletSigner(ownerWalletAddress);
    const snapshot = await fetchJupiterPerpsAccountSnapshot(agentWalletAddress);
    if (!snapshot.positions.some((position) => position.accountRef === positionPubkey)) {
      return Response.json({ error: "The requested position is not owned by the associated autonomous wallet." }, { status: 403 });
    }

    const built = await perps.trading.decreasePosition({
      positionPubkey,
      receiveToken,
      maxSlippageBps,
      entirePosition: true,
    });
    const signed = signSerializedPerpsTransaction(built.serializedTxBase64);
    const executed = await perps.trading.executeTransaction({
      action: "decrease-position",
      serializedTxBase64: signed.signedSerializedTxBase64,
    });
    return Response.json({ txid: executed.txid, positionPubkey });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to close the autonomous Perps position.";
    return Response.json({ error: message }, { status: 500 });
  }
}
