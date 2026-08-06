import crypto from "node:crypto";

import { getRedisClient } from "@/lib/server/redis";

const REDIS_KEY = "brembot:perps:scalp-direction-experiment:v1";

export type ScalpDirectionExperiment = {
  experimentId: string;
  baselineProfileId: string;
  enabled: boolean;
  maxTrades: number;
  tradesCompleted: number;
  tradesRemaining: number;
  startedAt: string;
  completedAt: string | null;
};

function parseExperiment(raw: string | null): ScalpDirectionExperiment | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<ScalpDirectionExperiment>;
    if (
      typeof value.experimentId !== "string"
      || typeof value.baselineProfileId !== "string"
      || typeof value.enabled !== "boolean"
      || !Number.isInteger(value.maxTrades)
      || !Number.isInteger(value.tradesCompleted)
      || !Number.isInteger(value.tradesRemaining)
      || typeof value.startedAt !== "string"
    ) return null;
    return value as ScalpDirectionExperiment;
  } catch {
    return null;
  }
}

export async function getScalpDirectionExperiment(walletAddress: string) {
  const redis = await getRedisClient();
  if (!redis) return null;
  return parseExperiment(await redis.hGet(REDIS_KEY, walletAddress));
}

export async function startScalpDirectionExperiment(input: {
  walletAddress: string;
  baselineProfileId: string;
  maxTrades?: number;
}) {
  const maxTrades = input.maxTrades ?? 3;
  if (!Number.isInteger(maxTrades) || maxTrades < 1 || maxTrades > 10) {
    throw new Error("The opposite-direction experiment must contain between 1 and 10 trades.");
  }
  const experiment: ScalpDirectionExperiment = {
    experimentId: `scalp_inverse_${crypto.randomUUID()}`,
    baselineProfileId: input.baselineProfileId,
    enabled: true,
    maxTrades,
    tradesCompleted: 0,
    tradesRemaining: maxTrades,
    startedAt: new Date().toISOString(),
    completedAt: null,
  };
  const redis = await getRedisClient();
  if (!redis) throw new Error("Redis is required for the scalp direction experiment.");
  await redis.hSet(REDIS_KEY, input.walletAddress, JSON.stringify(experiment));
  return experiment;
}

const RECORD_EXECUTION_SCRIPT = `
local raw = redis.call('HGET', KEYS[1], ARGV[1])
if not raw then return '' end
local ok, state = pcall(cjson.decode, raw)
if not ok or state.enabled ~= true then return raw end
local remaining = tonumber(state.tradesRemaining) or 0
if remaining <= 0 then return raw end
state.tradesCompleted = (tonumber(state.tradesCompleted) or 0) + 1
state.tradesRemaining = remaining - 1
if state.tradesRemaining <= 0 then
  state.enabled = false
  state.completedAt = ARGV[2]
end
local encoded = cjson.encode(state)
redis.call('HSET', KEYS[1], ARGV[1], encoded)
return encoded
`;

export async function recordScalpDirectionExperimentTrade(walletAddress: string) {
  const redis = await getRedisClient();
  if (!redis) throw new Error("Redis is required for the scalp direction experiment.");
  const result = await redis.eval(RECORD_EXECUTION_SCRIPT, {
    keys: [REDIS_KEY],
    arguments: [walletAddress, new Date().toISOString()],
  });
  const raw = typeof result === "string" ? result : Buffer.isBuffer(result) ? result.toString("utf8") : "";
  return parseExperiment(raw);
}
