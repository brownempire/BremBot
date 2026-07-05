import { getRedisClient } from "@/lib/server/redis";
import { getApnsConfigError } from "@/lib/push/apnsSender";
import { hasWebPushConfig } from "@/lib/push/sender";

export async function GET() {
  const hasClientPublic = Boolean(process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY);
  const hasServerPublic = Boolean(process.env.VAPID_PUBLIC_KEY || process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY);
  const hasServerPrivate = Boolean(process.env.VAPID_PRIVATE_KEY);
  const hasVapidSubject = Boolean(process.env.VAPID_SUBJECT);
  const hasApns = !getApnsConfigError();
  const hasRedisUrl = Boolean(process.env.REDIS_URL);

  let redis = "disabled";
  if (hasRedisUrl) {
    try {
      const client = await getRedisClient();
      if (!client) {
        redis = "unavailable";
      } else {
        const pong = await client.ping();
        redis = pong === "PONG" ? "ok" : "unhealthy";
      }
    } catch {
      redis = "unhealthy";
    }
  }

  return new Response(
    JSON.stringify({
      ok: hasWebPushConfig() || hasApns,
      push: {
        hasClientPublicKey: hasClientPublic,
        hasServerPublicKey: hasServerPublic,
        hasServerPrivateKey: hasServerPrivate,
        hasVapidSubject,
        hasApns,
      },
      redis,
    }),
    { headers: { "Content-Type": "application/json" } }
  );
}
