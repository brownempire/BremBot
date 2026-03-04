import fs from "node:fs";
import { detectSignals, type UserParams } from "@/lib/signal/engine";
import { getPushConfigError, getTargetSubscriptions, sendPushPayload } from "@/lib/push/sender";

type ScanPoint = { t: number; v: number };
type ScanMarketState = { lastSignalAt?: number; points: ScanPoint[] };
type ScanState = {
  sentSignalIds: string[];
  markets: Record<string, ScanMarketState>;
};

const STATE_PATH = process.env.PUSH_SIGNAL_STATE_FILE || "/tmp/brembot-signal-scan-state.json";
const MAX_POINTS = 5400;
const MAX_SENT_IDS = 80;

const DEFAULT_PARAMS: UserParams = {
  trendWindow: 15,
  trendThreshold: 1.5,
  breakoutPercent: 1.2,
  newsBias: 0.15,
  cooldownSeconds: 30,
};

const TRACKED_MARKETS = [
  { id: "slot-sol", pair: "SOL/USD", coinbaseProduct: "SOL-USD" },
  { id: "slot-eth", pair: "ETH/USD", coinbaseProduct: "ETH-USD" },
  { id: "slot-btc", pair: "BTC/USD", coinbaseProduct: "BTC-USD" },
];

function loadState(): ScanState {
  try {
    if (!fs.existsSync(STATE_PATH)) return { sentSignalIds: [], markets: {} };
    const raw = fs.readFileSync(STATE_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<ScanState>;
    return {
      sentSignalIds: Array.isArray(parsed?.sentSignalIds)
        ? parsed.sentSignalIds.filter((id): id is string => typeof id === "string")
        : [],
      markets: parsed?.markets && typeof parsed.markets === "object" ? parsed.markets : {},
    };
  } catch {
    return { sentSignalIds: [], markets: {} };
  }
}

function saveState(state: ScanState) {
  try {
    fs.writeFileSync(STATE_PATH, JSON.stringify(state), "utf8");
  } catch {
    // Ignore write failures to keep cron route non-fatal.
  }
}

async function fetchPrice(product: string) {
  const response = await fetch(`https://api.exchange.coinbase.com/products/${product}/ticker`, {
    cache: "no-store",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) return null;
  const payload = await response.json() as { price?: string };
  const price = Number(payload.price);
  return Number.isFinite(price) && price > 0 ? price : null;
}

function validateCronSecret(request: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return true;
  const authHeader = request.headers.get("authorization") ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  return token === secret;
}

export async function GET(request: Request) {
  if (!validateCronSecret(request)) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  }

  const configError = getPushConfigError();
  if (configError) {
    return new Response(JSON.stringify({ error: configError }), { status: 400 });
  }

  const subscriptions = getTargetSubscriptions(null);
  if (subscriptions.length === 0) {
    return new Response(JSON.stringify({ ok: true, sent: 0, reason: "No subscriptions" }));
  }

  const state = loadState();
  const now = Date.now();
  const notifications: Array<{ title: string; body: string; url: string; signalId: string }> = [];

  for (const market of TRACKED_MARKETS) {
    const price = await fetchPrice(market.coinbaseProduct).catch(() => null);
    if (!price) continue;

    const marketState: ScanMarketState = state.markets[market.id] ?? { points: [] };
    const points = [...marketState.points, { t: now, v: price }].slice(-MAX_POINTS);
    const recentPoints = points.filter((point) => now - point.t <= DEFAULT_PARAMS.trendWindow * 60 * 1000);
    const signals = detectSignals({
      symbol: market.pair,
      points: recentPoints,
      params: DEFAULT_PARAMS,
      newsScore: 0,
      lastSignalAt: marketState.lastSignalAt,
    });

    if (signals.length > 0) {
      marketState.lastSignalAt = now;
      for (const signal of signals) {
        if (state.sentSignalIds.includes(signal.id)) continue;
        notifications.push({
          title: `Signal: ${signal.symbol}`,
          body: signal.summary,
          url: "/",
          signalId: signal.id,
        });
        state.sentSignalIds = [signal.id, ...state.sentSignalIds].slice(0, MAX_SENT_IDS);
      }
    }

    marketState.points = points;
    state.markets[market.id] = marketState;
  }

  saveState(state);
  if (notifications.length === 0) {
    return new Response(JSON.stringify({ ok: true, sent: 0, reason: "No new signals" }));
  }

  const sendResults = await Promise.all(
    notifications.map((payload) => sendPushPayload(subscriptions, payload))
  );
  const sent = sendResults.reduce((sum, result) => sum + result.sent, 0);

  return new Response(JSON.stringify({
    ok: true,
    notifications: notifications.length,
    sent,
  }));
}
