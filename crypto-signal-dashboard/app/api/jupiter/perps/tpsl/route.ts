import { NextRequest } from "next/server";
import { createPerpsClient, type InputToken } from "jupiter-perps-api-sdk";

export const dynamic = "force-dynamic";

const perps = createPerpsClient();

type CreateTpslRequest = {
  positionPubkey?: string;
  positionRequestPubkey?: string;
  tpsl?: Array<{
    entirePosition?: boolean;
    receiveToken?: InputToken;
    sizeUsdDelta?: string | null;
    triggerPrice?: string | null;
    requestType?: "tp" | "sl";
  }>;
  triggerPrice?: string | null;
  walletAddress?: string;
};

function isInputToken(value: string | undefined): value is InputToken {
  return value === "SOL" || value === "ETH" || value === "BTC" || value === "USDC";
}

function normalizePositiveNumberString(value: string | null | undefined) {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return null;

  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return trimmed;
}

export async function POST(request: NextRequest) {
  const payload = await request.json().catch(() => null) as CreateTpslRequest | null;
  const walletAddress = payload?.walletAddress?.trim();
  const positionPubkey = payload?.positionPubkey?.trim();
  const tpsl = (payload?.tpsl ?? [])
    .map((item) => {
      const receiveToken = item?.receiveToken?.trim();
      const triggerPrice = normalizePositiveNumberString(item?.triggerPrice);
      const sizeUsdDelta = normalizePositiveNumberString(item?.sizeUsdDelta);
      const requestType = item?.requestType;
      const entirePosition = item?.entirePosition !== false;

      if (!isInputToken(receiveToken) || !triggerPrice || (requestType !== "tp" && requestType !== "sl")) {
        return null;
      }

      return {
        entirePosition,
        receiveToken,
        sizeUsdDelta: entirePosition ? null : sizeUsdDelta,
        triggerPrice,
        requestType,
      };
    })
    .filter((item): item is { entirePosition: boolean; receiveToken: InputToken; sizeUsdDelta: string | null; triggerPrice: string; requestType: "tp" | "sl" } => item !== null);

  if (!walletAddress || !positionPubkey || tpsl.length === 0) {
    return Response.json({ error: "Incomplete TP/SL request." }, { status: 400 });
  }

  try {
    const response = await perps.trading.createTpsl({
      walletAddress,
      positionPubkey,
      tpsl,
    });

    return Response.json(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to create the Jupiter Perps TP/SL request right now.";
    console.error("[Perps TP/SL Error]", {
      walletAddress,
      positionPubkey,
      tpslCount: tpsl.length,
      message,
    });
    return Response.json(
      {
        error: "Jupiter Perps could not create the TP/SL request right now.",
        detail: message,
      },
      { status: 500 }
    );
  }
}

export async function PATCH(request: NextRequest) {
  const payload = await request.json().catch(() => null) as CreateTpslRequest | null;
  const positionRequestPubkey = payload?.positionRequestPubkey?.trim();
  const triggerPrice = normalizePositiveNumberString(payload?.triggerPrice);

  if (!positionRequestPubkey || !triggerPrice) {
    return Response.json({ error: "Incomplete TP/SL update request." }, { status: 400 });
  }

  try {
    const response = await perps.trading.updateTpsl({
      positionRequestPubkey,
      triggerPrice,
    });

    return Response.json(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to update the Jupiter Perps TP/SL request right now.";
    console.error("[Perps TP/SL Update Error]", {
      positionRequestPubkey,
      message,
    });
    return Response.json(
      {
        error: "Jupiter Perps could not update the TP/SL request right now.",
        detail: message,
      },
      { status: 500 }
    );
  }
}

export async function DELETE(request: NextRequest) {
  const payload = await request.json().catch(() => null) as { positionRequestPubkey?: string } | null;
  const positionRequestPubkey = payload?.positionRequestPubkey?.trim();

  if (!positionRequestPubkey) {
    return Response.json({ error: "Missing TP/SL request reference." }, { status: 400 });
  }

  try {
    const response = await perps.trading.cancelTpsl({
      positionRequestPubkey,
    });

    return Response.json(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to cancel the Jupiter Perps TP/SL request right now.";
    console.error("[Perps TP/SL Cancel Error]", {
      positionRequestPubkey,
      message,
    });
    return Response.json(
      {
        error: "Jupiter Perps could not cancel the TP/SL request right now.",
        detail: message,
      },
      { status: 500 }
    );
  }
}
