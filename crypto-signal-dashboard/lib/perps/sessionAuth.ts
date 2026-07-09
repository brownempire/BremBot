import { getRedisClient } from "@/lib/server/redis";

function parseBearerToken(request: Request) {
  const auth = request.headers.get("authorization") ?? "";
  return auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
}

export async function getAuthorizedWalletAddress(request: Request) {
  const token = parseBearerToken(request);
  if (!token) return null;

  const redis = await getRedisClient().catch(() => null);
  if (!redis) return null;

  const address = await redis.get(`brembot:trades:session:${token}`);
  return address ? String(address) : null;
}
