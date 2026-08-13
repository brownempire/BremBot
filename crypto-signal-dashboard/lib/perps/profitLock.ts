import type { JupiterPerpsPosition } from "@/lib/jupiterPerps";

export const PROFIT_LOCK_INITIAL_ARM_ROE_PERCENT = 15;
export const PROFIT_LOCK_INITIAL_EXIT_ROE_PERCENT = 10;
export const PROFIT_LOCK_ARM_ROE_PERCENT = 20;
export const PROFIT_LOCK_EXIT_ROE_PERCENT = 15;
export const SCALP_PROFIT_LOCK_INITIAL_ARM_ROE_PERCENT = 10;
export const SCALP_PROFIT_LOCK_INITIAL_EXIT_ROE_PERCENT = 7;
export const SCALP_PROFIT_LOCK_RUNNER_ARM_ROE_PERCENT = 30;
export const SCALP_PROFIT_LOCK_RUNNER_EXIT_ROE_PERCENT = 23;
export const SCALP_PROFIT_LOCK_FINAL_ARM_ROE_PERCENT = 40;
export const SCALP_PROFIT_LOCK_FINAL_EXIT_ROE_PERCENT = 32;
export const PROFIT_LOCK_CLOSE_RETRY_MS = 2 * 60_000;
const PROFIT_LOCK_ROE_EPSILON = 1e-9;

export type PerpsProfitLockTier =
  | "ten-to-seven"
  | "fifteen-to-ten"
  | "twenty-to-fifteen"
  | "thirty-to-twenty-three"
  | "forty-to-thirty-two";
export type PerpsProfitLockStrategyClass = "smart" | "scalp";

export type PerpsProfitLockState = {
  positionPubkey: string;
  strategyClass?: PerpsProfitLockStrategyClass;
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
  strategyClass: PerpsProfitLockStrategyClass;
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
  strategyClass?: PerpsProfitLockStrategyClass;
  now?: number;
}): PerpsProfitLockEvaluation {
  const now = options.now ?? Date.now();
  const previous = options.previousState?.positionPubkey === options.positionPubkey
    ? options.previousState
    : null;
  const strategyClass = options.strategyClass ?? previous?.strategyClass ?? "smart";
  const peakRoePercent = Math.max(previous?.peakRoePercent ?? options.currentRoePercent, options.currentRoePercent);
  const activeTier: PerpsProfitLockTier | null = strategyClass === "scalp"
    && peakRoePercent >= SCALP_PROFIT_LOCK_FINAL_ARM_ROE_PERCENT
    ? "forty-to-thirty-two"
    : strategyClass === "scalp" && peakRoePercent >= SCALP_PROFIT_LOCK_RUNNER_ARM_ROE_PERCENT
      ? "thirty-to-twenty-three"
    : peakRoePercent >= PROFIT_LOCK_ARM_ROE_PERCENT
    ? "twenty-to-fifteen"
    : peakRoePercent >= PROFIT_LOCK_INITIAL_ARM_ROE_PERCENT
      ? "fifteen-to-ten"
      : strategyClass === "scalp" && peakRoePercent >= SCALP_PROFIT_LOCK_INITIAL_ARM_ROE_PERCENT
        ? "ten-to-seven"
      : null;
  const armRoePercent = activeTier === "forty-to-thirty-two"
    ? SCALP_PROFIT_LOCK_FINAL_ARM_ROE_PERCENT
    : activeTier === "thirty-to-twenty-three"
      ? SCALP_PROFIT_LOCK_RUNNER_ARM_ROE_PERCENT
    : activeTier === "twenty-to-fifteen"
    ? PROFIT_LOCK_ARM_ROE_PERCENT
    : activeTier === "fifteen-to-ten"
      ? PROFIT_LOCK_INITIAL_ARM_ROE_PERCENT
      : strategyClass === "scalp"
        ? SCALP_PROFIT_LOCK_INITIAL_ARM_ROE_PERCENT
        : PROFIT_LOCK_INITIAL_ARM_ROE_PERCENT;
  const exitRoePercent = activeTier === "forty-to-thirty-two"
    ? SCALP_PROFIT_LOCK_FINAL_EXIT_ROE_PERCENT
    : activeTier === "thirty-to-twenty-three"
      ? SCALP_PROFIT_LOCK_RUNNER_EXIT_ROE_PERCENT
    : activeTier === "twenty-to-fifteen"
    ? PROFIT_LOCK_EXIT_ROE_PERCENT
    : activeTier === "fifteen-to-ten"
      ? PROFIT_LOCK_INITIAL_EXIT_ROE_PERCENT
      : SCALP_PROFIT_LOCK_INITIAL_EXIT_ROE_PERCENT;
  const armedAt = previous?.armedAt
    ?? (activeTier !== null ? now : null);
  const closeIsPending = Boolean(
    previous?.closeTxid
    && previous.closeSubmittedAt
    && now - previous.closeSubmittedAt < PROFIT_LOCK_CLOSE_RETRY_MS
  );
  const shouldClose = activeTier !== null
    && armedAt !== null
    && options.currentRoePercent <= exitRoePercent + PROFIT_LOCK_ROE_EPSILON;

  return {
    action: closeIsPending
      ? "close-pending"
      : shouldClose
        ? "close"
        : armedAt !== null
          ? "armed"
          : "track",
    currentRoePercent: options.currentRoePercent,
    strategyClass,
    armRoePercent,
    exitRoePercent,
    activeTier,
    state: {
      positionPubkey: options.positionPubkey,
      strategyClass,
      peakRoePercent,
      activeTier,
      armedAt,
      closeTxid: closeIsPending ? previous?.closeTxid ?? null : null,
      closeSubmittedAt: closeIsPending ? previous?.closeSubmittedAt ?? null : null,
      updatedAt: now,
    },
  };
}
