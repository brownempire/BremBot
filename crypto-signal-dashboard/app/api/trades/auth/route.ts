import { PublicKey } from "@solana/web3.js";
import { getRedisClient } from "@/lib/server/redis";

const AUTH_TTL_SECONDS = 60 * 60 * 12;

function toToken() {
  return `${crypto.randomUUID()}-${Math.random().toString(36).slice(2)}`;
}

export async function POST(request: Request) {
  const payload = await request.json().catch(() => null);
  const address = String(payload?.address ?? "").trim();
  if (!address) {
    return new Response(JSON.stringify({ error: "Missing address" }), { status: 400 });
  }

  try {
    new PublicKey(address);
  } catch {
    return new Response(JSON.stringify({ error: "Invalid address" }), { status: 400 });
  }

  const redis = await getRedisClient().catch(() => null);
  if (!redis) {
    return new Response(JSON.stringify({ error: "Remote storage unavailable" }), { status: 503 });
  }

  const token = toToken();
  await redis.set(`brembot:trades:session:${token}`, address, { EX: AUTH_TTL_SECONDS });

  return new Response(JSON.stringify({ token, address, expiresInSeconds: AUTH_TTL_SECONDS }), {
    headers: { "Content-Type": "application/json" },
  });
}
