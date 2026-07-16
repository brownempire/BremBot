import { createPerpsClient, type InputToken, type TransactionAction } from "jupiter-perps-api-sdk";

import { assertAgentWalletSigner } from "@/lib/perps/agentWallet";
import { getAuthorizedWalletAddress } from "@/lib/perps/sessionAuth";
import { signSerializedPerpsTransaction } from "@/lib/perps/signer";
import { fetchJupiterPerpsAccountSnapshot } from "@/lib/jupiterPerps";

export const dynamic = "force-dynamic";

const perps = createPerpsClient();

type TpslItem = {
  entirePosition?: boolean;
  receiveToken?: InputToken;
  sizeUsdDelta?: string | null;
  triggerPrice?: string | null;
  requestType?: "tp" | "sl";
};

function normalizePositiveNumberString(value: string | null | undefined) {
  const trimmed = value?.trim() ?? "";
  const parsed = Number(trimmed);
  return trimmed && Number.isFinite(parsed) && parsed > 0 ? trimmed : null;
}

function uiUsdToRawUsdString(value: string | null | undefined) {
  const normalized = normalizePositiveNumberString(value);
  return normalized ? String(Math.max(1, Math.round(Number(normalized) * 1_000_000))) : null;
}

function isInputToken(value: string | undefined): value is InputToken {
  return value === "SOL" || value === "ETH" || value === "BTC" || value === "USDC";
}

async function getAuthorizedAgentSnapshot(request: Request) {
  const ownerWalletAddress = await getAuthorizedWalletAddress(request);
  if (!ownerWalletAddress) throw new Error("UNAUTHORIZED");
  const agentWalletAddress = assertAgentWalletSigner(ownerWalletAddress);
  const snapshot = await fetchJupiterPerpsAccountSnapshot(agentWalletAddress);
  return { agentWalletAddress, snapshot };
}

async function signAndExecute(action: TransactionAction, serializedTxBase64: string) {
  const { signedSerializedTxBase64 } = signSerializedPerpsTransaction(serializedTxBase64);
  return perps.trading.executeTransaction({ action, serializedTxBase64: signedSerializedTxBase64 });
}

function errorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : "Unable to modify the autonomous Perps TP/SL request.";
  if (message === "UNAUTHORIZED") return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (/not associated|does not match|not owned/i.test(message)) {
    return Response.json({ error: message }, { status: 403 });
  }
  return Response.json({ error: message }, { status: 500 });
}

export async function POST(request: Request) {
  try {
    const payload = await request.json().catch(() => null) as { positionPubkey?: string; tpsl?: TpslItem[] } | null;
    const positionPubkey = payload?.positionPubkey?.trim();
    const tpsl = (payload?.tpsl ?? []).flatMap((item) => {
      const receiveToken = item.receiveToken?.trim();
      const triggerPrice = uiUsdToRawUsdString(item.triggerPrice);
      const requestType = item.requestType;
      const entirePosition = item.entirePosition !== false;
      const sizeUsdDelta = entirePosition ? null : normalizePositiveNumberString(item.sizeUsdDelta);
      if (!isInputToken(receiveToken) || !triggerPrice || (requestType !== "tp" && requestType !== "sl")) return [];
      return [{ receiveToken, triggerPrice, requestType, entirePosition, sizeUsdDelta }];
    });

    if (!positionPubkey || tpsl.length === 0) {
      return Response.json({ error: "Incomplete autonomous TP/SL request." }, { status: 400 });
    }

    const { agentWalletAddress, snapshot } = await getAuthorizedAgentSnapshot(request);
    if (!snapshot.positions.some((position) => position.accountRef === positionPubkey)) {
      throw new Error("The requested position is not owned by the associated autonomous wallet.");
    }

    const built = await perps.trading.createTpsl({ walletAddress: agentWalletAddress, positionPubkey, tpsl });
    const executed = await signAndExecute("create-tpsl", built.serializedTxBase64);
    return Response.json({ txid: executed.txid, requestPubkeys: built.tpslPubkeys ?? [] });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const payload = await request.json().catch(() => null) as { positionRequestPubkey?: string; triggerPrice?: string } | null;
    const positionRequestPubkey = payload?.positionRequestPubkey?.trim();
    const triggerPrice = uiUsdToRawUsdString(payload?.triggerPrice);
    if (!positionRequestPubkey || !triggerPrice) {
      return Response.json({ error: "Incomplete autonomous TP/SL update request." }, { status: 400 });
    }

    const { snapshot } = await getAuthorizedAgentSnapshot(request);
    if (!snapshot.pendingTriggers.some((trigger) => trigger.positionRequestPubkey === positionRequestPubkey)) {
      throw new Error("The requested TP/SL order is not owned by the associated autonomous wallet.");
    }

    const built = await perps.trading.updateTpsl({ positionRequestPubkey, triggerPrice });
    const executed = await signAndExecute("update-tpsl", built.serializedTxBase64);
    return Response.json({ txid: executed.txid });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: Request) {
  try {
    const payload = await request.json().catch(() => null) as { positionRequestPubkey?: string } | null;
    const positionRequestPubkey = payload?.positionRequestPubkey?.trim();
    if (!positionRequestPubkey) {
      return Response.json({ error: "Missing autonomous TP/SL request reference." }, { status: 400 });
    }

    const { snapshot } = await getAuthorizedAgentSnapshot(request);
    if (!snapshot.pendingTriggers.some((trigger) => trigger.positionRequestPubkey === positionRequestPubkey)) {
      throw new Error("The requested TP/SL order is not owned by the associated autonomous wallet.");
    }

    const built = await perps.trading.cancelTpsl({ positionRequestPubkey });
    const executed = await signAndExecute("cancel-tpsl", built.serializedTxBase64);
    return Response.json({ txid: executed.txid });
  } catch (error) {
    return errorResponse(error);
  }
}
