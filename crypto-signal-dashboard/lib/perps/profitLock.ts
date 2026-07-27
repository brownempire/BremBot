import type { JupiterPerpsPosition } from "@/lib/jupiterPerps";

export const PROFIT_LOCK_INITIAL_ARM_ROE_PERCENT = 15;
export const PROFIT_LOCK_INITIAL_EXIT_ROE_PERCENT = 10;
export const PROFIT_LOCK_ARM_ROE_PERCENT = 20;
export const PROFIT_LOCK_EXIT_ROE_PERCENT = 15;
export const PROFIT_LOCK_CLOSE_RETRY_MS = 2 * 60_000;

export type PerpsProfitLockTier = "fifteen-to-ten" | "twenty-to-fifteen";

export type PerpsProfitLockState = {
  positionPubkey: string;
  peakRoePercent: number;
  activeTier?: PerpsProfitLockTier | null;
  armedAt: number | null;
  closeTxid: string | null;
  closeSubmittedAt: number | null;
  updatedAt: number;
};

export type PerpsProfitLockEvaluation = {
  action: "track" | "armed" | "close" | "close-pending";
  currentRoePercent: number;
  armRoePercent: number;
  exitRoePercent: number;
  activeTier: PerpsProfitLockTier | null;
  state: PerpsProfitLockState;
};

export function calculatePerpsPositionRoePercent(position: JupiterPerpsPosition) {
  const pnl = position.unrealizedPnl;
  const collateral = position.collateralValue;
  if (
    typeof pnl !== "number"
    || !Number.isFinite(pnl)
    || typeof collateral !== "number"
    || !Number.isFinite(collateral)
    || collateral <= 0
  ) {
    return null;
  }

  return (pnl / collateral) * 100;
}

export function evaluatePerpsProfitLock(options: {
  positionPubkey: string;
  currentRoePercent: number;
  previousState: PerpsProfitLockState | null;
  now?: number;
}): PerpsProfitLockEvaluation {
  const now = options.now ?? Date.now();
  const previous = options.previousState?.positionPubkey === options.positionPubkey
    ? options.previousState
    : null;
  const peakRoePercent = Math.max(previous?.peakRoePercent ?? options.currentRoePercent, options.currentRoePercent);
  const activeTier: PerpsProfitLockTier | null = peakRoePercent >= PROFIT_LOCK_ARM_ROE_PERCENT
    ? "twenty-to-fifteen"
    : peakRoePercent >= PROFIT_LOCK_INITIAL_ARM_ROE_PERCENT
      ? "fifteen-to-ten"
      : null;
  const armRoePercent = activeTier === "twenty-to-fifteen"
    ? PROFIT_LOCK_ARM_ROE_PERCENT
    : PROFIT_LOCK_INITIAL_ARM_ROE_PERCENT;
  const exitRoePercent = activeTier === "twenty-to-fifteen"
    ? PROFIT_LOCK_EXIT_ROE_PERCENT
    : PROFIT_LOCK_INITIAL_EXIT_ROE_PERCENT;
  const armedAt = previous?.armedAt
    ?? (activeTier !== null ? now : null);
  const closeIsPending = Boolean(
    previous?.closeTxid
    && previous.closeSubmittedAt
    && now - previous.closeSubmittedAt < PROFIT_LOCK_CLOSE_RETRY_MS
  );
  const shouldClose = activeTier !== null
    && armedAt !== null
    && options.currentRoePercent <= exitRoePercent;

  return {
    action: closeIsPending
      ? "close-pending"
      : shouldClose
        ? "close"
        : armedAt !== null
          ? "armed"
          : "track",
    currentRoePercent: options.currentRoePercent,
    armRoePercent,
    exitRoePercent,
    activeTier,
    state: {
      positionPubkey: options.positionPubkey,
      peakRoePercent,
      activeTier,
      armedAt,
      closeTxid: closeIsPending ? previous?.closeTxid ?? null : null,
      closeSubmittedAt: closeIsPending ? previous?.closeSubmittedAt ?? null : null,
      updatedAt: now,
    },
  };
}
