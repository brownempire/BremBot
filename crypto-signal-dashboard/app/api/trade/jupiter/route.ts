type JupiterOrderRequest = {
  inputMint?: string;
  outputMint?: string;
  amount?: string;
  slippageBps?: number;
  userPublicKey?: string;
  taker?: string;
};

const JUPITER_SWAP_V2_BASE = "https://api.jup.ag/swap/v2";

function getJupiterHeaders() {
  const apiKey = process.env.JUPITER_API_KEY?.trim();
  const headers: Record<string, string> = {};
  if (apiKey) {
    headers["x-api-key"] = apiKey;
  }
  return headers;
}

async function fetchOrder(params: URLSearchParams) {
  const response = await fetch(`${JUPITER_SWAP_V2_BASE}/order?${params.toString()}`, {
    cache: "no-store",
    headers: getJupiterHeaders(),
  }).catch(() => null);

  if (!response) {
    throw new Error("Unable to reach Jupiter order endpoint");
  }

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = payload?.error ?? payload?.message ?? `HTTP ${response.status}`;
    throw new Error(String(detail));
  }

  return payload;
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as JupiterOrderRequest;
  const inputMint = String(body.inputMint ?? "");
  const outputMint = String(body.outputMint ?? "");
  const amount = String(body.amount ?? "");
  const taker = String(body.taker ?? body.userPublicKey ?? "");
  const slippageBps = Number.isFinite(body.slippageBps) ? Number(body.slippageBps) : 100;

  if (!inputMint || !outputMint || !amount || !taker) {
    return new Response(JSON.stringify({ error: "Missing required trade fields" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const params = new URLSearchParams({
      inputMint,
      outputMint,
      amount,
      taker,
      slippageBps: String(slippageBps),
    });
    const order = await fetchOrder(params);

    const transaction = String(order?.transaction ?? "");
    const requestId = String(order?.requestId ?? "");
    if (!transaction || !requestId) {
      return new Response(JSON.stringify({ error: "Jupiter did not return a swap order" }), {
        status: 502,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(
      JSON.stringify({
        requestId,
        transaction,
        swapTransaction: transaction,
        gasless: Boolean(order?.gasless),
        signatureFeePayer: typeof order?.signatureFeePayer === "string" ? order.signatureFeePayer : taker,
        prioritizationFeePayer:
          typeof order?.prioritizationFeePayer === "string" ? order.prioritizationFeePayer : taker,
        rentFeePayer: typeof order?.rentFeePayer === "string" ? order.rentFeePayer : taker,
        feeBps: Number.isFinite(order?.feeBps) ? Number(order.feeBps) : null,
        priceImpactPct:
          order?.priceImpactPct !== undefined && order?.priceImpactPct !== null
            ? Number(order.priceImpactPct)
            : null,
        inAmount: String(order?.totalInputAmount ?? order?.inAmount ?? amount),
        outAmount: String(order?.totalOutputAmount ?? order?.outAmount ?? ""),
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unable to build Jupiter swap order";
    return new Response(JSON.stringify({ error: message }), {
      status: 502,
      headers: { "Content-Type": "application/json" },
    });
  }
}
