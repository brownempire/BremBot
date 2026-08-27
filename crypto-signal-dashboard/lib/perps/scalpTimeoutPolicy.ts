export const SCALP_AGENT_TIMEOUT_MINUTES = 30;
export const SCALP_AGENT_TIMEOUT_MS = SCALP_AGENT_TIMEOUT_MINUTES * 60_000;

type TimedRollout = {
  status: "probation" | "validated" | "paused";
  startedAt: string;
  timeoutStartedAt?: string | null;
  timeoutExpiresAt?: string | null;
};

export type ScalpAgentTimeoutStatus = {
  timedOut: boolean;
  startedAt: string | null;
  expiresAt: string | null;
  remainingMs: number;
};

function timestamp(value: Date | number | string) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  return Date.parse(value);
}

export function scalpTimeoutExpiresAt(startedAt: Date | number | string) {
  const startedAtMs = timestamp(startedAt);
  if (!Number.isFinite(startedAtMs)) return null;
  return new Date(startedAtMs + SCALP_AGENT_TIMEOUT_MS).toISOString();
}

export function resolveScalpRolloutTimeout(
  rollout: TimedRollout | null | undefined,
  evaluatedAt: Date | number | string = Date.now()
): ScalpAgentTimeoutStatus {
  if (!rollout || rollout.status !== "paused") {
    return { timedOut: false, startedAt: null, expiresAt: null, remainingMs: 0 };
  }
  const startedAt = rollout.timeoutStartedAt ?? rollout.startedAt;
  const expiresAt = rollout.timeoutExpiresAt ?? scalpTimeoutExpiresAt(startedAt);
  const evaluatedAtMs = timestamp(evaluatedAt);
  const expiresAtMs = expiresAt ? Date.parse(expiresAt) : Number.NaN;
  const remainingMs = Number.isFinite(evaluatedAtMs) && Number.isFinite(expiresAtMs)
    ? Math.max(0, expiresAtMs - evaluatedAtMs)
    : 0;
  return {
    timedOut: remainingMs > 0,
    startedAt,
    expiresAt,
    remainingMs,
  };
}
