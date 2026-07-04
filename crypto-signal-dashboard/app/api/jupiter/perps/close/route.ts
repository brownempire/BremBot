import { NextRequest } from "next/server";

const JUPITER_PERPS_API_BASE = "https://perps-api.jup.ag/v1";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const payload = await request.json().catch(() => null) as
    | {
        positionPubkey?: string;
        receiveToken?: string;
        maxSlippageBps?: string;
        entirePosition?: boolean;
      }
    | null;

  const positionPubkey = payload?.positionPubkey?.trim();
  if (!positionPubkey) {
    return Response.json({ error: "Missing position pubkey." }, { status: 400 });
  }

  const receiveToken = payload?.receiveToken?.trim() || "USDC";
  const maxSlippageBps = payload?.maxSlippageBps?.trim() || "100";
  const entirePosition = payload?.entirePosition ?? true;

  try {
    // Jupiter's live Perps API returns the unsigned close transaction here.
    const response = await fetch(`${JUPITER_PERPS_API_BASE}/positions/decrease`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "x-perps-api-version": "v2",
      },
      body: JSON.stringify({
        positionPubkey,
        receiveToken,
        maxSlippageBps,
        entirePosition,
      }),
      cache: "no-store",
    });

    const body = await response.text();

    return new Response(body, {
      status: response.status,
      headers: {
        "Cache-Control": "no-store, max-age=0",
        "Content-Type": response.headers.get("Content-Type") ?? "application/json",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to create the Jupiter Perps close transaction.";
    return Response.json({ error: message }, { status: 500 });
  }
}
