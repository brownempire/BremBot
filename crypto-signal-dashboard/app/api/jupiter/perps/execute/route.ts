import { NextRequest } from "next/server";

const JUPITER_PERPS_API_BASE = "https://perps-api.jup.ag/v1";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const payload = await request.json().catch(() => null) as
    | {
        action?: string;
        serializedTxBase64?: string;
      }
    | null;

  const action = payload?.action?.trim();
  const serializedTxBase64 = payload?.serializedTxBase64?.trim();

  if (!action || !serializedTxBase64) {
    return Response.json({ error: "Missing transaction payload." }, { status: 400 });
  }

  try {
    const response = await fetch(`${JUPITER_PERPS_API_BASE}/transaction/execute`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "x-perps-api-version": "v2",
      },
      body: JSON.stringify({
        action,
        serializedTxBase64,
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
    const message = error instanceof Error ? error.message : "Unable to execute the signed Jupiter Perps transaction.";
    return Response.json({ error: message }, { status: 500 });
  }
}
