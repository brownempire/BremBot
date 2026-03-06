import { PublicKey } from "@solana/web3.js";
import { getRedisClient } from "@/lib/server/redis";

type StoredTradeRecord = {
  txid: string;
  timestamp: number;
  walletAddress?: string;
  inputMint?: string;
  outputMint?: string;
  inputAmount?: number;
  outputAmount?: number;
  id: string;
  source?: "manual" | "auto";
  signalId?: string;
  signalSummary?: string;
};

const MAX_REMOTE_TRADES = 500;

function parseBearerToken(request: Request) {
  const auth = request.headers.get("authorization") ?? "";
  return auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
}

async function getAuthorizedAddress(request: Request) {
  const token = parseBearerToken(request);
  if (!token) return null;
  const redis = await getRedisClient().catch(() => null);
  if (!redis) return null;
  const address = await redis.get(`brembot:trades:session:${token}`);
  return address ? String(address) : null;
}

function isValidAddress(address: string) {
  try {
    new PublicKey(address);
    return true;
  } catch {
    return false;
  }
}

function sanitizeTrade(input: unknown, expectedWalletAddress: string): StoredTradeRecord | null {
  if (!input || typeof input !== "object") return null;
  const trade = input as Partial<StoredTradeRecord>;
  const id = String(trade.id ?? "").trim();
  const txid = String(trade.txid ?? "").trim();
  const timestamp = Number(trade.timestamp ?? 0);
  if (!id || !txid || !Number.isFinite(timestamp) || timestamp <= 0) return null;

  const walletAddress = String(trade.walletAddress ?? expectedWalletAddress).trim();
  if (!isValidAddress(walletAddress) || walletAddress !== expectedWalletAddress) return null;

  const inputAmount = Number(trade.inputAmount ?? NaN);
  const outputAmount = Number(trade.outputAmount ?? NaN);

  return {
    id,
    txid,
    timestamp,
    walletAddress,
    inputMint: trade.inputMint ? String(trade.inputMint) : undefined,
    outputMint: trade.outputMint ? String(trade.outputMint) : undefined,
    inputAmount: Number.isFinite(inputAmount) ? inputAmount : undefined,
    outputAmount: Number.isFinite(outputAmount) ? outputAmount : undefined,
    source: trade.source === "manual" || trade.source === "auto" ? trade.source : undefined,
    signalId: trade.signalId ? String(trade.signalId) : undefined,
    signalSummary: trade.signalSummary ? String(trade.signalSummary) : undefined,
  };
}

async function readTrades(redisKey: string): Promise<StoredTradeRecord[]> {
  const redis = await getRedisClient().catch(() => null);
  if (!redis) return [];
  const raw = await redis.get(redisKey);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as { trades?: StoredTradeRecord[] };
    if (!Array.isArray(parsed?.trades)) return [];
    return parsed.trades;
  } catch {
    return [];
  }
}

async function writeTrades(redisKey: string, trades: StoredTradeRecord[]) {
  const redis = await getRedisClient().catch(() => null);
  if (!redis) return false;
  await redis.set(redisKey, JSON.stringify({ trades }), { EX: 60 * 60 * 24 * 30 });
  return true;
}

export async function GET(request: Request) {
  const address = await getAuthorizedAddress(request);
  if (!address) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });

  const requestedAddress = String(new URL(request.url).searchParams.get("address") ?? "").trim();
  if (requestedAddress && requestedAddress !== address) {
    return new Response(JSON.stringify({ error: "Address mismatch" }), { status: 403 });
  }

  const key = `brembot:trades:${address}`;
  const trades = await readTrades(key);
  return new Response(JSON.stringify({ trades, address, maxTrades: MAX_REMOTE_TRADES }), {
    headers: { "Content-Type": "application/json" },
  });
}

export async function POST(request: Request) {
  const address = await getAuthorizedAddress(request);
  if (!address) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });

  const payload = await request.json().catch(() => null);
  const trade = sanitizeTrade(payload?.trade, address);
  if (!trade) {
    return new Response(JSON.stringify({ error: "Invalid trade payload" }), { status: 400 });
  }

  const key = `brembot:trades:${address}`;
  const existing = await readTrades(key);
  const deduped = [trade, ...existing.filter((item) => item.id !== trade.id)].slice(0, MAX_REMOTE_TRADES);
  const ok = await writeTrades(key, deduped);
  if (!ok) return new Response(JSON.stringify({ error: "Remote storage unavailable" }), { status: 503 });

  return new Response(JSON.stringify({ ok: true, trades: deduped, maxTrades: MAX_REMOTE_TRADES }), {
    headers: { "Content-Type": "application/json" },
  });
}

export async function DELETE(request: Request) {
  const address = await getAuthorizedAddress(request);
  if (!address) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });

  const redis = await getRedisClient().catch(() => null);
  if (!redis) return new Response(JSON.stringify({ error: "Remote storage unavailable" }), { status: 503 });

  await redis.del(`brembot:trades:${address}`);
  return new Response(JSON.stringify({ ok: true }), {
    headers: { "Content-Type": "application/json" },
  });
}
