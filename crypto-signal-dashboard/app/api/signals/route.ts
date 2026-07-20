import { PublicKey } from "@solana/web3.js";

import { MAX_SIGNAL_HISTORY, normalizeSignalHistory } from "@/lib/signal/history";
import { getRedisClient } from "@/lib/server/redis";

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
  if (!address) return null;
  try {
    return new PublicKey(String(address)).toBase58();
  } catch {
    return null;
  }
}

async function readSignals(redisKey: string) {
  const redis = await getRedisClient().catch(() => null);
  if (!redis) return [];
  const raw = await redis.get(redisKey);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as { signals?: unknown[] };
    return normalizeSignalHistory(Array.isArray(parsed.signals) ? parsed.signals : []);
  } catch {
    return [];
  }
}

async function writeSignals(redisKey: string, signals: unknown[]) {
  const redis = await getRedisClient().catch(() => null);
  if (!redis) return false;
  await redis.set(redisKey, JSON.stringify({ signals: normalizeSignalHistory(signals) }), {
    EX: 60 * 60 * 24 * 30,
  });
  return true;
}

export async function GET(request: Request) {
  const address = await getAuthorizedAddress(request);
  if (!address) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const requestedAddress = String(new URL(request.url).searchParams.get("address") ?? "").trim();
  if (requestedAddress && requestedAddress !== address) {
    return Response.json({ error: "Address mismatch" }, { status: 403 });
  }

  const signals = await readSignals(`brembot:signals:${address}`);
  return Response.json({ signals, address, maxSignals: MAX_SIGNAL_HISTORY });
}

export async function POST(request: Request) {
  const address = await getAuthorizedAddress(request);
  if (!address) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const payload = await request.json().catch(() => null);
  const incoming = Array.isArray(payload?.signals) ? payload.signals : [payload?.signal];
  const validIncoming = normalizeSignalHistory(incoming);
  if (validIncoming.length === 0) {
    return Response.json({ error: "Invalid signal payload" }, { status: 400 });
  }

  const key = `brembot:signals:${address}`;
  const existing = await readSignals(key);
  const signals = normalizeSignalHistory([...validIncoming, ...existing]);
  if (!await writeSignals(key, signals)) {
    return Response.json({ error: "Remote storage unavailable" }, { status: 503 });
  }
  return Response.json({ ok: true, signals, maxSignals: MAX_SIGNAL_HISTORY });
}

export async function DELETE(request: Request) {
  const address = await getAuthorizedAddress(request);
  if (!address) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const redis = await getRedisClient().catch(() => null);
  if (!redis) return Response.json({ error: "Remote storage unavailable" }, { status: 503 });
  await redis.del(`brembot:signals:${address}`);
  return Response.json({ ok: true });
}
