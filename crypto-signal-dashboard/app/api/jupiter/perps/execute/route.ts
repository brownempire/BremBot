import { NextRequest } from "next/server";

const JUPITER_PERPS_API_BASE = "https://perps-api.jup.ag/v1";
const PERPS_UPSTREAM_RETRY_MS = 750;

export const dynamic = "force-dynamic";

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatUpstreamPerpsError(body: string, fallback: string) {
  try {
    const parsed = JSON.parse(body) as { error?: string; message?: string; detail?: string };
    const detail = parsed.error?.trim() || parsed.message?.trim() || parsed.detail?.trim();
    if (detail) return detail;
  } catch {
    // ignore JSON parse failures
  }

  const trimmed = body.trim();
  return trimmed || fallback;
}

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
    const requestBody = JSON.stringify({
      action,
      serializedTxBase64,
    });
    let response: Response | null = null;
    let body = "";

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      response = await fetch(`${JUPITER_PERPS_API_BASE}/transaction/execute`, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "x-perps-api-version": "v2",
        },
        body: requestBody,
        cache: "no-store",
      });

      body = await response.text();

      if (response.ok || response.status < 500 || attempt === 2) {
        break;
      }

      console.error("[Perps Execute Retry]", {
        action,
        attempt,
        status: response.status,
        body: body.slice(0, 500),
      });
      await wait(PERPS_UPSTREAM_RETRY_MS);
    }

    if (!response) {
      return Response.json({ error: "Jupiter Perps execution did not return a response." }, { status: 502 });
    }

    if (!response.ok && response.status >= 500) {
      const detail = formatUpstreamPerpsError(body, "Jupiter Perps execution failed.");
      console.error("[Perps Execute Error]", {
        action,
        status: response.status,
        body: body.slice(0, 1000),
      });
      return Response.json(
        {
          error:
            "Jupiter Perps backend returned a 500 while executing the signed order. This is usually temporary. Refreshing positions may still show a filled trade.",
          detail,
        },
        { status: response.status }
      );
    }

    return new Response(body, {
      status: response.status,
      headers: {
        "Cache-Control": "no-store, max-age=0",
        "Content-Type": response.headers.get("Content-Type") ?? "application/json",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to execute the signed Jupiter Perps transaction.";
    console.error("[Perps Execute Exception]", { action, message });
    return Response.json({ error: message }, { status: 500 });
  }
}
