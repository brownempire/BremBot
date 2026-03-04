type JupiterSwapRequest = {
  inputMint?: string;
  outputMint?: string;
  amount?: string;
  slippageBps?: number;
  userPublicKey?: string;
};

async function fetchQuote(inputMint: string, outputMint: string, amount: string, slippageBps: number) {
  const urls = [
    "https://lite-api.jup.ag/swap/v1/quote",
    "https://quote-api.jup.ag/v6/quote",
  ];

  for (const base of urls) {
    const url = new URL(base);
    url.searchParams.set("inputMint", inputMint);
    url.searchParams.set("outputMint", outputMint);
    url.searchParams.set("amount", amount);
    url.searchParams.set("slippageBps", String(slippageBps));
    url.searchParams.set("onlyDirectRoutes", "false");

    const response = await fetch(url.toString(), { cache: "no-store" }).catch(() => null);
    if (!response?.ok) continue;
    return response.json();
  }

  return null;
}

async function fetchSwapTransaction(quote: unknown, userPublicKey: string) {
  const urls = [
    "https://lite-api.jup.ag/swap/v1/swap",
    "https://quote-api.jup.ag/v6/swap",
  ];

  for (const url of urls) {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey,
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: "auto",
      }),
    }).catch(() => null);

    if (!response?.ok) continue;
    return response.json();
  }

  return null;
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as JupiterSwapRequest;
  const inputMint = String(body.inputMint ?? "");
  const outputMint = String(body.outputMint ?? "");
  const amount = String(body.amount ?? "");
  const slippageBps = Number.isFinite(body.slippageBps) ? Number(body.slippageBps) : 100;
  const userPublicKey = String(body.userPublicKey ?? "");

  if (!inputMint || !outputMint || !amount || !userPublicKey) {
    return new Response(JSON.stringify({ error: "Missing required trade fields" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const quote = await fetchQuote(inputMint, outputMint, amount, slippageBps);
  if (!quote) {
    return new Response(JSON.stringify({ error: "Unable to fetch Jupiter quote" }), {
      status: 502,
      headers: { "Content-Type": "application/json" },
    });
  }

  const swapPayload = await fetchSwapTransaction(quote, userPublicKey);
  const swapTransaction = String(swapPayload?.swapTransaction ?? "");
  if (!swapTransaction) {
    return new Response(JSON.stringify({ error: "Unable to build Jupiter swap transaction" }), {
      status: 502,
      headers: { "Content-Type": "application/json" },
    });
  }

  return new Response(JSON.stringify({ swapTransaction, quote }), {
    headers: { "Content-Type": "application/json" },
  });
}
