type SendTradeRequest = {
  signedTransaction?: string;
  requestId?: string;
};

const JUPITER_SWAP_V2_BASE = "https://api.jup.ag/swap/v2";

function getJupiterHeaders() {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  const apiKey = process.env.JUPITER_API_KEY?.trim();
  if (apiKey) {
    headers["x-api-key"] = apiKey;
  }
  return headers;
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as SendTradeRequest;
  const signedTransaction = String(body.signedTransaction ?? "");
  const requestId = String(body.requestId ?? "");

  if (!signedTransaction || !requestId) {
    return new Response(JSON.stringify({ error: "Missing signedTransaction or requestId" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const response = await fetch(`${JUPITER_SWAP_V2_BASE}/execute`, {
      method: "POST",
      headers: getJupiterHeaders(),
      body: JSON.stringify({
        signedTransaction,
        requestId,
      }),
    });

    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const message = payload?.error ?? payload?.message ?? `Jupiter execute failed (${response.status})`;
      return new Response(JSON.stringify({ error: String(message) }), {
        status: 502,
        headers: { "Content-Type": "application/json" },
      });
    }

    const status = String(payload?.status ?? "");
    const txid = String(payload?.signature ?? payload?.txid ?? "");
    if (status && status.toLowerCase() !== "success") {
      const detail = payload?.error ?? payload?.code ?? payload?.message ?? "Transaction execution failed";
      return new Response(JSON.stringify({ error: String(detail), status, payload }), {
        status: 502,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (!txid) {
      return new Response(JSON.stringify({ error: "Jupiter execute did not return a transaction signature" }), {
        status: 502,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(
      JSON.stringify({
        ok: true,
        txid,
        status: status || "Success",
        totalInputAmount: payload?.totalInputAmount ?? null,
        totalOutputAmount: payload?.totalOutputAmount ?? null,
        inputAmountResult: payload?.inputAmountResult ?? null,
        outputAmountResult: payload?.outputAmountResult ?? null,
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Transaction execution failed";
    return new Response(JSON.stringify({ error: message }), {
      status: 502,
      headers: { "Content-Type": "application/json" },
    });
  }
}
