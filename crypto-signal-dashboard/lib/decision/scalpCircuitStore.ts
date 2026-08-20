import fs from "node:fs";

import { z } from "zod";

import {
  scalpEntryPathSchema,
  type ScalpEntryPath,
  type TradeLearningOutcome,
} from "@/lib/decision/learningTypes";
import { getRedisClient } from "@/lib/server/redis";

export const SCALP_PATH_LOSS_LIMIT = 2;
export const SCALP_GLOBAL_LOSS_LIMIT = 3;

const CIRCUIT_FILE = process.env.PERPS_SCALP_CIRCUIT_FILE || "/tmp/brembot-perps-scalp-circuit-events.json";
const CIRCUIT_EVENTS_KEY_PREFIX = "brembot:perps:scalp:circuit-events:v2";

const scalpCircuitEventSchema = z.object({
  eventId: z.string().trim().min(1),
  walletAddress: z.string().trim().min(1),
  policyVersion: z.number().int().positive(),
  eventType: z.enum(["outcome", "reset-all", "reset-path"]),
  entryPath: scalpEntryPathSchema.nullable(),
  outcomeId: z.string().trim().min(1).nullable(),
  netPnlUsd: z.number().finite().nullable(),
  occurredAt: z.string().datetime(),
  reason: z.string().trim().min(1).nullable(),
});

export type ScalpCircuitEvent = z.infer<typeof scalpCircuitEventSchema>;

export type ScalpPathCircuitState = {
  consecutivePostFeeLosses: number;
  disabled: boolean;
  disabledAt: string | null;
  triggeringOutcomeId: string | null;
};

export type ScalpCircuitState = {
  walletAddress: string;
  policyVersion: number;
  consecutivePostFeeLosses: number;
  globallyPaused: boolean;
  globallyPausedAt: string | null;
  triggeringOutcomeId: string | null;
  paths: Record<ScalpEntryPath, ScalpPathCircuitState>;
  processedOutcomeCount: number;
  updatedAt: string | null;
};

const ENTRY_PATHS = scalpEntryPathSchema.options;

function circuitEventsKey(walletAddress: string, policyVersion: number) {
  return `${CIRCUIT_EVENTS_KEY_PREFIX}:${walletAddress}:${policyVersion}`;
}

function readJsonFile(filePath: string): Record<string, unknown> {
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
    // Redis is authoritative in production; disk is a local fail-safe.
  }
}

function parseEvent(value: unknown) {
  const parsed = scalpCircuitEventSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function emptyPathState(): ScalpPathCircuitState {
  return {
    consecutivePostFeeLosses: 0,
    disabled: false,
    disabledAt: null,
    triggeringOutcomeId: null,
  };
}

export function emptyScalpCircuitState(walletAddress: string, policyVersion: number): ScalpCircuitState {
  return {
    walletAddress,
    policyVersion,
    consecutivePostFeeLosses: 0,
    globallyPaused: false,
    globallyPausedAt: null,
    triggeringOutcomeId: null,
    paths: Object.fromEntries(ENTRY_PATHS.map((path) => [path, emptyPathState()])) as Record<ScalpEntryPath, ScalpPathCircuitState>,
    processedOutcomeCount: 0,
    updatedAt: null,
  };
}

export function deriveScalpEntryPath(outcome: Pick<TradeLearningOutcome, "scalpEntryPath" | "scalpSetupType" | "priceActionTags">): ScalpEntryPath {
  if (outcome.scalpEntryPath) return outcome.scalpEntryPath;
  if (outcome.priceActionTags?.includes("INDICATORS_CONFIRMED_TREND_CONTINUATION")) return "continuation";
  if (
    outcome.priceActionTags?.includes("PRICE_BREAKOUT_RETEST")
    || outcome.priceActionTags?.includes("BREAKOUT_RETEST")
  ) return "breakout-retest";
  if (outcome.scalpSetupType === "range-reversal") return "range-reversal";
  if (outcome.scalpSetupType) return "reversal";
  return "unknown";
}

export function reduceScalpCircuitEvents(
  walletAddress: string,
  policyVersion: number,
  events: ScalpCircuitEvent[]
): ScalpCircuitState {
  const state = emptyScalpCircuitState(walletAddress, policyVersion);
  const ordered = events
    .filter((event) => event.walletAddress === walletAddress && event.policyVersion === policyVersion)
    .sort((left, right) => Date.parse(left.occurredAt) - Date.parse(right.occurredAt)
      || left.eventId.localeCompare(right.eventId));

  for (const event of ordered) {
    state.updatedAt = event.occurredAt;
    if (event.eventType === "reset-all") {
      const reset = emptyScalpCircuitState(walletAddress, policyVersion);
      state.consecutivePostFeeLosses = reset.consecutivePostFeeLosses;
      state.globallyPaused = reset.globallyPaused;
      state.globallyPausedAt = reset.globallyPausedAt;
      state.triggeringOutcomeId = reset.triggeringOutcomeId;
      state.paths = reset.paths;
      state.processedOutcomeCount = 0;
      continue;
    }
    if (event.eventType === "reset-path" && event.entryPath) {
      state.paths[event.entryPath] = emptyPathState();
      continue;
    }
    if (event.eventType !== "outcome" || !event.entryPath || event.netPnlUsd === null || !event.outcomeId) {
      continue;
    }

    state.processedOutcomeCount += 1;
    const pathState = state.paths[event.entryPath];
    if (event.netPnlUsd < 0) {
      state.consecutivePostFeeLosses += 1;
      pathState.consecutivePostFeeLosses += 1;
      if (!pathState.disabled && pathState.consecutivePostFeeLosses >= SCALP_PATH_LOSS_LIMIT) {
        pathState.disabled = true;
        pathState.disabledAt = event.occurredAt;
        pathState.triggeringOutcomeId = event.outcomeId;
      }
      if (!state.globallyPaused && state.consecutivePostFeeLosses >= SCALP_GLOBAL_LOSS_LIMIT) {
        state.globallyPaused = true;
        state.globallyPausedAt = event.occurredAt;
        state.triggeringOutcomeId = event.outcomeId;
      }
    } else {
      state.consecutivePostFeeLosses = 0;
      pathState.consecutivePostFeeLosses = 0;
    }
  }
  return state;
}

async function listScalpCircuitEvents(
  walletAddress: string,
  policyVersion: number,
  options: { requireAuthoritative?: boolean } = {}
) {
  const events = new Map<string, ScalpCircuitEvent>();
  const redis = await getRedisClient().catch(() => null);
  if (options.requireAuthoritative && !redis) {
    throw new Error("Authoritative Redis scalp-circuit state is unavailable; live scalp execution is blocked.");
  }
  if (redis) {
    try {
      const values = await redis.hVals(circuitEventsKey(walletAddress, policyVersion));
      values.forEach((value) => {
        try {
          const event = parseEvent(JSON.parse(value));
          if (options.requireAuthoritative && !event) {
            throw new Error("An authoritative Redis scalp-circuit event failed schema validation.");
          }
          if (event?.walletAddress === walletAddress && event.policyVersion === policyVersion) {
            events.set(event.eventId, event);
          }
        } catch (error) {
          if (options.requireAuthoritative) {
            throw new Error(
              `Authoritative Redis scalp-circuit state is malformed: ${error instanceof Error ? error.message : "invalid event"}`
            );
          }
          // Ignore malformed records.
        }
      });
    } catch (error) {
      if (options.requireAuthoritative) {
        throw new Error(
          `Authoritative Redis scalp-circuit state could not be read: ${error instanceof Error ? error.message : "unknown Redis error"}`
        );
      }
      // Merge the local fail-safe below.
    }
  }
  if (options.requireAuthoritative) return [...events.values()];
  Object.values(readJsonFile(CIRCUIT_FILE)).forEach((value) => {
    const event = parseEvent(value);
    if (event?.walletAddress === walletAddress && event.policyVersion === policyVersion) {
      events.set(event.eventId, event);
    }
  });
  return [...events.values()];
}

async function saveCircuitEvent(
  event: ScalpCircuitEvent,
  options: { requireAuthoritative?: boolean } = {}
) {
  const parsed = scalpCircuitEventSchema.parse(event);
  const redis = await getRedisClient().catch(() => null);
  if (options.requireAuthoritative && !redis) {
    throw new Error("Authoritative Redis scalp-circuit state is unavailable; the live outcome was not recorded.");
  }
  if (redis) {
    try {
      const key = circuitEventsKey(parsed.walletAddress, parsed.policyVersion);
      const existingRaw = await redis.hGet(key, parsed.eventId);
      if (existingRaw) {
        const existing = parseEvent(JSON.parse(existingRaw));
        if (existing && JSON.stringify(existing) !== JSON.stringify(parsed)) {
          throw new Error(`Scalp circuit event ${parsed.eventId} cannot be overwritten with different data.`);
        }
        return parsed;
      }
      await redis.hSet(key, parsed.eventId, JSON.stringify(parsed));
      return parsed;
    } catch (error) {
      if (error instanceof Error && error.message.includes("cannot be overwritten")) throw error;
      if (options.requireAuthoritative) {
        throw new Error(
          `Authoritative Redis scalp-circuit state could not be written: ${error instanceof Error ? error.message : "unknown Redis error"}`
        );
      }
      // Local fail-safe below.
    }
  }
  const disk = readJsonFile(CIRCUIT_FILE);
  const existing = parseEvent(disk[parsed.eventId]);
  if (existing && JSON.stringify(existing) !== JSON.stringify(parsed)) {
    throw new Error(`Scalp circuit event ${parsed.eventId} cannot be overwritten with different data.`);
  }
  disk[parsed.eventId] = parsed;
  writeJsonFile(CIRCUIT_FILE, disk);
  return parsed;
}

export async function getScalpCircuitState(
  walletAddress: string,
  policyVersion: number,
  options: { requireAuthoritative?: boolean } = {}
) {
  return reduceScalpCircuitEvents(
    walletAddress,
    policyVersion,
    await listScalpCircuitEvents(walletAddress, policyVersion, options)
  );
}

export async function getScalpCircuitDecision(input: {
  walletAddress: string;
  policyVersion: number;
  entryPath: ScalpEntryPath;
  requireAuthoritative?: boolean;
}) {
  const state = await getScalpCircuitState(input.walletAddress, input.policyVersion, {
    requireAuthoritative: input.requireAuthoritative,
  });
  const reasons: string[] = [];
  if (state.globallyPaused) {
    reasons.push(`Scalp execution paused after ${SCALP_GLOBAL_LOSS_LIMIT} consecutive post-fee losses.`);
  }
  if (state.paths[input.entryPath].disabled) {
    reasons.push(`${input.entryPath} disabled after ${SCALP_PATH_LOSS_LIMIT} consecutive post-fee losses on that entry path.`);
  }
  return { allowed: reasons.length === 0, reasons, state };
}

export async function recordScalpCircuitOutcome(input: {
  walletAddress: string;
  outcomeId: string;
  policyVersion: number;
  entryPath: ScalpEntryPath;
  netPnlUsd: number;
  closedAt: string;
  requireAuthoritative?: boolean;
}) {
  return recordScalpCircuitOutcomes({
    walletAddress: input.walletAddress,
    policyVersion: input.policyVersion,
    outcomes: [input],
    requireAuthoritative: input.requireAuthoritative,
  });
}

/**
 * Idempotently appends a policy outcome batch with one authoritative Redis
 * read/write transaction and one state reduction. Existing outcome event IDs
 * are verified and skipped, so a monitor restart cannot double-count history.
 */
export async function recordScalpCircuitOutcomes(input: {
  walletAddress: string;
  policyVersion: number;
  outcomes: Array<{
    outcomeId: string;
    entryPath: ScalpEntryPath;
    netPnlUsd: number;
    closedAt: string;
  }>;
  requireAuthoritative?: boolean;
}) {
  const parsed = input.outcomes.map((outcome) => scalpCircuitEventSchema.parse({
    eventId: `${input.walletAddress}:${input.policyVersion}:outcome:${outcome.outcomeId}`,
    walletAddress: input.walletAddress,
    policyVersion: input.policyVersion,
    eventType: "outcome",
    entryPath: outcome.entryPath,
    outcomeId: outcome.outcomeId,
    netPnlUsd: outcome.netPnlUsd,
    occurredAt: outcome.closedAt,
    reason: null,
  }));
  if (parsed.length === 0) {
    return getScalpCircuitState(input.walletAddress, input.policyVersion, {
      requireAuthoritative: input.requireAuthoritative,
    });
  }

  const redis = await getRedisClient().catch(() => null);
  if (input.requireAuthoritative && !redis) {
    throw new Error("Authoritative Redis scalp-circuit state is unavailable; live outcomes were not recorded.");
  }
  if (redis) {
    try {
      const key = circuitEventsKey(input.walletAddress, input.policyVersion);
      const existingRaw = await redis.hGetAll(key);
      const merged = new Map<string, ScalpCircuitEvent>();
      Object.entries(existingRaw).forEach(([field, raw]) => {
        let decoded: unknown;
        try {
          decoded = JSON.parse(raw);
        } catch {
          throw new Error(`Scalp circuit event ${field} contains malformed JSON.`);
        }
        const existing = parseEvent(decoded);
        if (!existing) throw new Error(`Scalp circuit event ${field} is malformed.`);
        if (
          existing.walletAddress !== input.walletAddress
          || existing.policyVersion !== input.policyVersion
          || existing.eventId !== field
        ) {
          throw new Error(`Scalp circuit event ${field} does not match its authoritative wallet, policy, or field key.`);
        }
        merged.set(existing.eventId, existing);
      });
      const missing = parsed.filter((event) => {
        const existing = merged.get(event.eventId);
        if (!existing) return true;
        if (JSON.stringify(existing) !== JSON.stringify(event)) {
          throw new Error(`Scalp circuit event ${event.eventId} cannot be overwritten with different data.`);
        }
        return false;
      });
      if (missing.length > 0) {
        const multi = redis.multi();
        missing.forEach((event) => multi.hSet(key, event.eventId, JSON.stringify(event)));
        await multi.exec();
      }
      parsed.forEach((event) => merged.set(event.eventId, event));
      return reduceScalpCircuitEvents(
        input.walletAddress,
        input.policyVersion,
        [...merged.values()]
      );
    } catch (error) {
      if (input.requireAuthoritative) {
        throw new Error(
          `Authoritative Redis scalp-circuit outcome batch could not be recorded: ${error instanceof Error ? error.message : "unknown Redis error"}`
        );
      }
    }
  }

  for (const event of parsed) await saveCircuitEvent(event);
  return getScalpCircuitState(input.walletAddress, input.policyVersion);
}

export async function resetScalpCircuit(input: {
  walletAddress: string;
  policyVersion: number;
  entryPath?: ScalpEntryPath;
  reason: string;
  resetAt?: string;
}) {
  const resetAt = input.resetAt ?? new Date().toISOString();
  await saveCircuitEvent({
    eventId: `${input.walletAddress}:${input.policyVersion}:reset:${resetAt}:${input.entryPath ?? "all"}`,
    walletAddress: input.walletAddress,
    policyVersion: input.policyVersion,
    eventType: input.entryPath ? "reset-path" : "reset-all",
    entryPath: input.entryPath ?? null,
    outcomeId: null,
    netPnlUsd: null,
    occurredAt: resetAt,
    reason: input.reason,
  });
  return getScalpCircuitState(input.walletAddress, input.policyVersion);
}
