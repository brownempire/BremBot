import fs from "node:fs";

import {
  decisionLearningProfileSchema,
  tradeLearningOutcomeSchema,
  type DecisionLearningProfile,
  type TradeLearningOutcome,
} from "@/lib/decision/learningTypes";
import { getRedisClient } from "@/lib/server/redis";

const PROFILE_FILE = process.env.PERPS_LEARNING_PROFILES_FILE || "/tmp/brembot-perps-learning-profiles.json";
const PROFILE_HISTORY_FILE = process.env.PERPS_LEARNING_PROFILE_HISTORY_FILE || "/tmp/brembot-perps-learning-profile-history.json";
const OUTCOME_FILE = process.env.PERPS_LEARNING_OUTCOMES_FILE || "/tmp/brembot-perps-learning-outcomes.json";
const ACTIVE_PROFILE_KEY = "brembot:perps:learning:active-profiles:v1";
const PROFILE_HISTORY_KEY = "brembot:perps:learning:profile-history:v1";
const OUTCOMES_KEY = "brembot:perps:learning:outcomes:v1";

function readJsonFile(filePath: string): unknown {
  try {
    return fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, "utf8")) : {};
  } catch {
    return {};
  }
}

function writeJsonFile(filePath: string, value: unknown) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(value), "utf8");
  } catch {
    // Redis is authoritative in production; disk is only a fail-safe for local runs.
  }
}

function parseProfile(value: unknown) {
  const parsed = decisionLearningProfileSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function parseOutcome(value: unknown) {
  const parsed = tradeLearningOutcomeSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export async function getActiveDecisionLearningProfile(walletAddress: string) {
  const redis = await getRedisClient().catch(() => null);
  if (redis) {
    try {
      const raw = await redis.hGet(ACTIVE_PROFILE_KEY, walletAddress);
      if (raw) return parseProfile(JSON.parse(raw));
    } catch {
      // Fall through to the local fail-safe.
    }
  }
  const disk = readJsonFile(PROFILE_FILE) as Record<string, unknown>;
  return parseProfile(disk[walletAddress]);
}

export async function listDecisionLearningProfileHistory(walletAddress: string) {
  const profiles = new Map<string, DecisionLearningProfile>();
  const redis = await getRedisClient().catch(() => null);
  if (redis) {
    try {
      const values = await redis.hVals(`${PROFILE_HISTORY_KEY}:${walletAddress}`);
      values.forEach((value) => {
        try {
          const profile = parseProfile(JSON.parse(value));
          if (profile) profiles.set(profile.profileId, profile);
        } catch {
          // Ignore malformed historical versions.
        }
      });
    } catch {
      // Local fallback below.
    }
  }
  const diskHistory = readJsonFile(PROFILE_HISTORY_FILE) as Record<string, unknown[]>;
  (Array.isArray(diskHistory[walletAddress]) ? diskHistory[walletAddress] : []).forEach((value) => {
    const profile = parseProfile(value);
    if (profile) profiles.set(profile.profileId, profile);
  });
  const active = await getActiveDecisionLearningProfile(walletAddress);
  if (active) profiles.set(active.profileId, active);
  return [...profiles.values()].sort((a, b) => b.version - a.version);
}

export async function saveDecisionLearningProfile(profile: DecisionLearningProfile, activate: boolean) {
  const parsed = decisionLearningProfileSchema.parse({
    ...profile,
    status: activate ? "active" : profile.status,
    promotedAt: activate ? new Date().toISOString() : profile.promotedAt,
  });
  const redis = await getRedisClient().catch(() => null);
  if (redis) {
    try {
      const multi = redis.multi();
      multi.hSet(`${PROFILE_HISTORY_KEY}:${parsed.walletAddress}`, parsed.profileId, JSON.stringify(parsed));
      if (activate) multi.hSet(ACTIVE_PROFILE_KEY, parsed.walletAddress, JSON.stringify(parsed));
      await multi.exec();
      return parsed;
    } catch {
      // Preserve the profile locally if Redis is interrupted.
    }
  }
  if (activate) {
    const disk = readJsonFile(PROFILE_FILE) as Record<string, unknown>;
    disk[parsed.walletAddress] = parsed;
    writeJsonFile(PROFILE_FILE, disk);
  }
  const diskHistory = readJsonFile(PROFILE_HISTORY_FILE) as Record<string, unknown[]>;
  const walletHistory = Array.isArray(diskHistory[parsed.walletAddress]) ? diskHistory[parsed.walletAddress] : [];
  diskHistory[parsed.walletAddress] = [
    parsed,
    ...walletHistory.filter((value) => parseProfile(value)?.profileId !== parsed.profileId),
  ];
  writeJsonFile(PROFILE_HISTORY_FILE, diskHistory);
  return parsed;
}

export async function saveTradeLearningOutcomes(outcomes: TradeLearningOutcome[]) {
  if (outcomes.length === 0) return [];
  const parsed = outcomes.map((outcome) => tradeLearningOutcomeSchema.parse(outcome));
  const redis = await getRedisClient().catch(() => null);
  if (redis) {
    try {
      const multi = redis.multi();
      parsed.forEach((outcome) => multi.hSet(OUTCOMES_KEY, outcome.outcomeId, JSON.stringify(outcome)));
      await multi.exec();
      return parsed;
    } catch {
      // Local fail-safe below.
    }
  }
  const disk = readJsonFile(OUTCOME_FILE) as Record<string, unknown>;
  parsed.forEach((outcome) => { disk[outcome.outcomeId] = outcome; });
  writeJsonFile(OUTCOME_FILE, disk);
  return parsed;
}

export async function replaceTradeLearningOutcomesForWallet(
  walletAddress: string,
  outcomes: TradeLearningOutcome[]
) {
  const parsed = outcomes.map((outcome) => tradeLearningOutcomeSchema.parse(outcome));
  if (parsed.some((outcome) => outcome.walletAddress !== walletAddress)) {
    throw new Error("Cannot replace learning outcomes across wallet boundaries.");
  }

  const redis = await getRedisClient().catch(() => null);
  if (redis) {
    try {
      const existing = await redis.hGetAll(OUTCOMES_KEY);
      const staleIds = Object.entries(existing).flatMap(([outcomeId, value]) => {
        try {
          return parseOutcome(JSON.parse(value))?.walletAddress === walletAddress ? [outcomeId] : [];
        } catch {
          return [];
        }
      });
      const multi = redis.multi();
      if (staleIds.length > 0) multi.hDel(OUTCOMES_KEY, staleIds);
      parsed.forEach((outcome) => multi.hSet(OUTCOMES_KEY, outcome.outcomeId, JSON.stringify(outcome)));
      await multi.exec();
    } catch {
      // Keep the local fail-safe internally consistent if Redis is interrupted.
    }
  }

  const disk = readJsonFile(OUTCOME_FILE) as Record<string, unknown>;
  Object.entries(disk).forEach(([outcomeId, value]) => {
    if (parseOutcome(value)?.walletAddress === walletAddress) delete disk[outcomeId];
  });
  parsed.forEach((outcome) => { disk[outcome.outcomeId] = outcome; });
  writeJsonFile(OUTCOME_FILE, disk);
  return parsed;
}

export async function listTradeLearningOutcomes(walletAddress: string) {
  const outcomes = new Map<string, TradeLearningOutcome>();
  const redis = await getRedisClient().catch(() => null);
  if (redis) {
    try {
      const values = await redis.hVals(OUTCOMES_KEY);
      values.forEach((value) => {
        try {
          const outcome = parseOutcome(JSON.parse(value));
          if (outcome?.walletAddress === walletAddress) outcomes.set(outcome.outcomeId, outcome);
        } catch {
          // Ignore malformed records.
        }
      });
    } catch {
      // Merge the local fail-safe below.
    }
  }
  const disk = readJsonFile(OUTCOME_FILE) as Record<string, unknown>;
  Object.values(disk).forEach((value) => {
    const outcome = parseOutcome(value);
    if (outcome?.walletAddress === walletAddress) outcomes.set(outcome.outcomeId, outcome);
  });
  return [...outcomes.values()].sort((a, b) => Date.parse(a.closedAt) - Date.parse(b.closedAt));
}
