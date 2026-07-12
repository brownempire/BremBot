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

export async function POST(request: Request) {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    return Response.json(
      { error: "AI not configured yet. Add OPENAI_API_KEY to the app env to enable in-app analysis." },
      { status: 503 }
    );
  }

  const model = process.env.OPENAI_MARKET_ANALYST_MODEL?.trim() || "gpt-4.1-mini";
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
      const detail = raw && typeof raw === "object" && "error" in raw ? JSON.stringify(raw.error) : "OpenAI request failed.";
      return Response.json({ error: "AI analysis request failed.", detail }, { status: response.status });
    }

    const answer = extractTextFromResponse(raw);
    if (!answer) {
      return Response.json({ error: "AI analysis returned no text." }, { status: 502 });
    }

    return Response.json({ answer });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "AI analysis failed unexpectedly." },
      { status: 500 }
    );
  }
}
