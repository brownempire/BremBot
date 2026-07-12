export const dynamic = "force-dynamic";

type MarketExplainerMessage = {
  role: "user" | "assistant";
  content: string;
};

type MarketExplainerPayload = {
  prompt?: string;
  symbol?: string;
  timeframe?: string;
  currentPrice?: number | null;
  recentCandles?: Array<{ t: number; v: number }>;
  latestSignal?: {
    direction?: "bullish" | "bearish";
    confidence?: number;
    summary?: string;
  } | null;
  activePerpsTrade?: {
    side?: "long" | "short";
    entryPrice?: number | null;
    takeProfitPrice?: number | null;
    stopLossPrice?: number | null;
  } | null;
  chatHistory?: MarketExplainerMessage[];
};

type AnalyticContext = {
  symbol: string;
  timeframe: string;
  currentPrice: number | null;
  latestSignal: MarketExplainerPayload["latestSignal"];
  activePerpsTrade: MarketExplainerPayload["activePerpsTrade"];
  recentCandles: Array<{ t: number; v: number }>;
  userPrompt: string;
};

function buildSystemPrompt() {
  return [
    "You are BremLogic AI, an in-app market analyst.",
    "Explain recent price action clearly and briefly for an active trader.",
    "Do not claim certainty or insider knowledge.",
    "Do not give financial advice or guarantee future direction.",
    "Focus on price structure, momentum, volatility, support/resistance, and signal context.",
    "Keep answers concise, practical, and easy to scan.",
    "When context is limited, say what is known versus inferred.",
  ].join(" ");
}

function sanitizeCandles(candles: MarketExplainerPayload["recentCandles"]) {
  return (candles ?? [])
    .filter((candle) => Number.isFinite(candle?.t) && Number.isFinite(candle?.v))
    .slice(-48);
}

function extractTextFromResponse(payload: unknown) {
  const candidate = payload as {
    output_text?: string;
    output?: Array<{
      content?: Array<{
        type?: string;
        text?: string;
      }>;
    }>;
  };

  if (typeof candidate?.output_text === "string" && candidate.output_text.trim()) {
    return candidate.output_text.trim();
  }

  const text = candidate?.output
    ?.flatMap((item) => item.content ?? [])
    .filter((item) => item.type === "output_text" || item.type === "text")
    .map((item) => item.text ?? "")
    .join("\n")
    .trim();

  return text || null;
}

function formatSignedPercent(value: number | null | undefined, fractionDigits = 2) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "n/a";
  return `${value >= 0 ? "+" : ""}${value.toFixed(fractionDigits)}%`;
}

function formatPrice(value: number | null | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "n/a";
  return `$${value.toFixed(value >= 100 ? 2 : 3)}`;
}

function buildFallbackAnswer(context: AnalyticContext) {
  const prices = context.recentCandles.map((candle) => candle.v).filter((value) => Number.isFinite(value));
  const lastPrice = typeof context.currentPrice === "number" && Number.isFinite(context.currentPrice)
    ? context.currentPrice
    : (prices.at(-1) ?? null);
  const firstPrice = prices.length > 1 ? prices[0] : null;
  const minPrice = prices.length > 0 ? Math.min(...prices) : null;
  const maxPrice = prices.length > 0 ? Math.max(...prices) : null;
  const changePercent =
    typeof firstPrice === "number" && firstPrice > 0 && typeof lastPrice === "number"
      ? ((lastPrice - firstPrice) / firstPrice) * 100
      : null;
  const rangePercent =
    typeof minPrice === "number" && minPrice > 0 && typeof maxPrice === "number"
      ? ((maxPrice - minPrice) / minPrice) * 100
      : null;

  const midpoint =
    typeof minPrice === "number" && typeof maxPrice === "number"
      ? (minPrice + maxPrice) / 2
      : null;
  const trendBias =
    typeof changePercent === "number"
      ? changePercent > 0.45
        ? "bullish"
        : changePercent < -0.45
          ? "bearish"
          : "sideways"
      : "unclear";
  const priceLocation =
    typeof lastPrice === "number" && typeof midpoint === "number"
      ? lastPrice >= midpoint
        ? "upper half of the recent range"
        : "lower half of the recent range"
      : "recent range is limited";
  const signalLine = context.latestSignal
    ? `Latest signal is ${context.latestSignal.direction ?? "unknown"} with ${typeof context.latestSignal.confidence === "number" ? `${Math.round(context.latestSignal.confidence * 100)}% confidence` : "no confidence score"}${context.latestSignal.summary ? `, summarized as: ${context.latestSignal.summary}` : ""}.`
    : "No latest signal is attached to this view.";
  const positionLine = context.activePerpsTrade?.side
    ? `Active Perps context shows a ${context.activePerpsTrade.side} bias${context.activePerpsTrade.entryPrice ? ` from ${formatPrice(context.activePerpsTrade.entryPrice)}` : ""}.`
    : "No active Perps trade context was attached.";

  const normalizedPrompt = context.userPrompt.trim();

  return [
    `Analytic read for ${context.symbol} on ${context.timeframe}:`,
    `Price is ${formatPrice(lastPrice)} and sitting in the ${priceLocation}. Trend bias from the recent sampled move looks ${trendBias}, with a net move of ${formatSignedPercent(changePercent)} and an observed range of ${formatSignedPercent(rangePercent)}.`,
    `Nearest reference levels from the sampled window are support near ${formatPrice(minPrice)} and resistance near ${formatPrice(maxPrice)}.`,
    signalLine,
    positionLine,
    `Your question was: "${normalizedPrompt}". Based on the available in-app data, the best analytic answer is that the move is being interpreted through range position, recent directional change, and the current signal context rather than certainty about the next candle.`,
    "This fallback answer is inferred from the app's current market snapshot, not a live external model response.",
  ].join("\n\n");
}

export async function POST(request: Request) {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  const model = process.env.OPENAI_MARKET_ANALYST_MODEL?.trim() || "gpt-5.6-luna";
  const payload = await request.json().catch(() => null) as MarketExplainerPayload | null;
  const prompt = payload?.prompt?.trim();

  if (!prompt) {
    return Response.json({ error: "Missing AI prompt." }, { status: 400 });
  }

  const recentCandles = sanitizeCandles(payload?.recentCandles);
  const userContext = {
    symbol: payload?.symbol ?? "Unknown market",
    timeframe: payload?.timeframe ?? "current view",
    currentPrice: typeof payload?.currentPrice === "number" ? payload.currentPrice : null,
    latestSignal: payload?.latestSignal ?? null,
    activePerpsTrade: payload?.activePerpsTrade ?? null,
    recentCandles,
    userPrompt: prompt,
  };

  if (!apiKey) {
    return Response.json({ answer: buildFallbackAnswer(userContext) });
  }

  const messages = [
    ...((payload?.chatHistory ?? []).slice(-8).map((message) => ({
      role: message.role,
      content: [{ type: "input_text" as const, text: message.content }],
    }))),
    {
      role: "user" as const,
      content: [{
        type: "input_text" as const,
        text: `Analyze this BremLogic market context and answer the user's question.\n\n${JSON.stringify(userContext, null, 2)}`,
      }],
    },
  ];

  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        input: [
          {
            role: "system",
            content: [{ type: "input_text", text: buildSystemPrompt() }],
          },
          ...messages,
        ],
      }),
      cache: "no-store",
    });

    const raw = await response.json().catch(() => null);
    if (!response.ok) {
      return Response.json({ answer: buildFallbackAnswer(userContext) });
    }

    const answer = extractTextFromResponse(raw);
    if (!answer) {
      return Response.json({ answer: buildFallbackAnswer(userContext) });
    }

    return Response.json({ answer });
  } catch (error) {
    return Response.json({ answer: buildFallbackAnswer(userContext) });
  }
}
