import { createClient, type RedisClientType } from "redis";

declare global {
  // eslint-disable-next-line no-var
  var __brembotRedisClient: RedisClientType | undefined;
}

function canUseRedis() {
  return !!process.env.REDIS_URL;
}

export async function getRedisClient() {
  if (!canUseRedis()) return null;

  if (!global.__brembotRedisClient) {
    global.__brembotRedisClient = createClient({
      url: process.env.REDIS_URL,
      socket: {
        reconnectStrategy: (retries) => Math.min(500 + retries * 100, 3000),
      },
    });
    global.__brembotRedisClient.on("error", () => {
      // Avoid throwing on background redis reconnect errors.
    });
  }

  const client = global.__brembotRedisClient;
  if (!client.isOpen) {
    await client.connect();
  }
  return client;
}
