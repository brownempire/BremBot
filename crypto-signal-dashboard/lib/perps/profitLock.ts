import type { JupiterPerpsPosition } from "@/lib/jupiterPerps";
import { DEFAULT_CONSERVATIVE_PERPS_ROUND_TRIP_FEE_RATE } from "@/lib/perps/scalpExit";
import type { PricePoint } from "@/lib/price/simulated";

export const PROFIT_LOCK_INITIAL_ARM_ROE_PERCENT = 15;
export const PROFIT_LOCK_INITIAL_EXIT_ROE_PERCENT = 10;
export const PROFIT_LOCK_ARM_ROE_PERCENT = 20;
export const PROFIT_LOCK_EXIT_ROE_PERCENT = 15;
export const SCALP_PROFIT_LOCK_RESCUE_ARM_ROE_PERCENT = 4;
export const SCALP_PROFIT_LOCK_RESCUE_EXIT_ROE_PERCENT = 2;
export const SCALP_PROFIT_LOCK_INITIAL_ARM_ROE_PERCENT = 10;
export const SCALP_PROFIT_LOCK_INITIAL_EXIT_ROE_PERCENT = 7;
export const SCALP_PROFIT_LOCK_RUNNER_ARM_ROE_PERCENT = 30;
export const SCALP_PROFIT_LOCK_RUNNER_EXIT_ROE_PERCENT = 23;
export const SCALP_PROFIT_LOCK_FINAL_ARM_ROE_PERCENT = 40;
export const SCALP_PROFIT_LOCK_FINAL_EXIT_ROE_PERCENT = 32;
export const SCALP_PROFIT_LOCK_MINIMUM_NET_ROE_PERCENT = 1;
const PROFIT_LOCK_ROE_EPSILON = 1e-9;

export type PerpsProfitLockTier =
  | "four-to-two"
  | "ten-to-seven"
  | "fifteen-to-ten"
  | "twenty-to-fifteen"
  | "thirty-to-twenty-three"
  | "forty-to-thirty-two";
export type PerpsProfitLockStrategyClass = "smart" | "scalp";

export type PerpsProfitLockState = {
  positionPubkey: string;
  /** Immutable execution episode that opened this occurrence of the position. */
  episodeId?: string;
  strategyClass?: PerpsProfitLockStrategyClass;
  peakRoePercent: number;
  activeTier?: PerpsProfitLockTier | null;
  protectedExitRoePercent?: number | null;
  armedAt: number | null;
  closeTxid: string | null;
  closeSubmittedAt: number | null;
  closeClaimedAt?: number | null;
  closeClaimOwnerToken?: string | null;
  closeStatus?: "reserved" | "submitted" | "uncertain" | null;
  closeError?: string | null;
  onChainStopTier?: PerpsProfitLockTier | null;
  onChainStopPrice?: number | null;
  onChainStopStatus?: "reserved" | "submitted" | "confirmed" | "uncertain" | null;
  onChainStopTxid?: string | null;
  onChainStopAttemptedAt?: number | null;
  onChainStopClaimOwnerToken?: string | null;
  onChainStopError?: string | null;
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

/**
 * Jupiter's v2 live API exposes pnlAfterFeesUsd, while the direct-RPC fallback
 * reconstructs price P&L without fees. Normalize only the RPC-derived value so
 * every profit-lock comparison uses the same conservative after-fee ROE.
 */
export function calculatePerpsPositionNetRoePercent(
  position: JupiterPerpsPosition,
  estimatedRoundTripFeeRate = DEFAULT_CONSERVATIVE_PERPS_ROUND_TRIP_FEE_RATE
) {
  const roe = calculatePerpsPositionRoePercent(position);
  if (roe === null || position.source !== "rpc-direct") return roe;
  const leverage = position.leverage;
  if (typeof leverage !== "number" || !Number.isFinite(leverage) || leverage <= 0) return null;
  const feeRate = Number.isFinite(estimatedRoundTripFeeRate) && estimatedRoundTripFeeRate > 0
    ? estimatedRoundTripFeeRate
    : DEFAULT_CONSERVATIVE_PERPS_ROUND_TRIP_FEE_RATE;
  return roe - feeRate * leverage * 100;
}

/** Convert an after-fee scalp-lock ROE floor into a position-relative price. */
export function calculateScalpProfitLockStopPrice(options: {
  side: "long" | "short";
  entryPrice: number;
  leverage: number;
  exitNetRoePercent: number;
  estimatedRoundTripFeeRate?: number | null;
}) {
  if (
    !Number.isFinite(options.entryPrice)
    || options.entryPrice <= 0
    || !Number.isFinite(options.leverage)
    || options.leverage <= 0
    || !Number.isFinite(options.exitNetRoePercent)
    || options.exitNetRoePercent <= 0
  ) return null;
  const feeRate = typeof options.estimatedRoundTripFeeRate === "number"
    && Number.isFinite(options.estimatedRoundTripFeeRate)
    && options.estimatedRoundTripFeeRate > 0
    ? options.estimatedRoundTripFeeRate
    : DEFAULT_CONSERVATIVE_PERPS_ROUND_TRIP_FEE_RATE;
  const feeRoePercent = feeRate * options.leverage * 100;
  const grossRoePercent = options.exitNetRoePercent + feeRoePercent;
  const moveRatio = grossRoePercent / (options.leverage * 100);
  const price = options.side === "long"
    ? options.entryPrice * (1 + moveRatio)
    : options.entryPrice * (1 - moveRatio);
  return Number.isFinite(price) && price > 0 ? Number(price.toFixed(6)) : null;
}

/**
 * Recovers a completed-candle high-water estimate that a minute-cadence cron
 * could otherwise miss between snapshots. This does not observe intraminute
 * ticks and is not a substitute for a future event-driven/on-chain trailing
 * stop, but it prevents completed favorable candles from disappearing from
 * the persisted staircase state.
 */
export function estimatePerpsPeakRoeFromCompletedCandles(options: {
  side: "long" | "short";
  entryPrice: number;
  leverage: number;
  currentRoePercent: number;
  points: PricePoint[];
  since?: number | null;
  estimatedRoundTripFeeRate?: number | null;
}) {
  if (options.entryPrice <= 0 || options.leverage <= 0) return options.currentRoePercent;
  const eligible = options.points.filter((point) => (
    (!options.since || point.t + 60_000 > options.since)
    && Number.isFinite(point.t)
  ));
  const favorablePrices = eligible.flatMap((point) => {
    const price = options.side === "long"
      ? point.h ?? point.v
      : point.l ?? point.v;
    return Number.isFinite(price) && price > 0 ? [price] : [];
  });
  if (favorablePrices.length === 0) return options.currentRoePercent;
  const favorablePrice = options.side === "long"
    ? Math.max(...favorablePrices)
    : Math.min(...favorablePrices);
  const direction = options.side === "long" ? 1 : -1;
  const estimatedGrossRoePercent = direction
    * ((favorablePrice - options.entryPrice) / options.entryPrice)
    * options.leverage
    * 100;
  const feeRate = typeof options.estimatedRoundTripFeeRate === "number"
    && Number.isFinite(options.estimatedRoundTripFeeRate)
    && options.estimatedRoundTripFeeRate > 0
    ? options.estimatedRoundTripFeeRate
    : DEFAULT_CONSERVATIVE_PERPS_ROUND_TRIP_FEE_RATE;
  const estimatedNetRoePercent = estimatedGrossRoePercent - feeRate * options.leverage * 100;
  return Math.max(options.currentRoePercent, estimatedNetRoePercent);
}

export function evaluatePerpsProfitLock(options: {
  positionPubkey: string;
  episodeId?: string;
  currentRoePercent: number;
  previousState: PerpsProfitLockState | null;
  strategyClass?: PerpsProfitLockStrategyClass;
  observedPeakRoePercent?: number | null;
  /**
   * Deprecated compatibility input. `currentRoePercent` is already after fees,
   * so fee-adjusted breakeven must not be added to a net-ROE exit target.
   */
  feeAdjustedBreakevenRoePercent?: number | null;
  leverage?: number | null;
  estimatedRoundTripFeeRate?: number | null;
  now?: number;
}): PerpsProfitLockEvaluation {
  const now = options.now ?? Date.now();
  const previous = options.previousState?.positionPubkey === options.positionPubkey
    && (
      !options.episodeId
      || options.previousState.episodeId === options.episodeId
    )
    ? options.previousState
    : null;
  const strategyClass = options.strategyClass ?? previous?.strategyClass ?? "smart";
  const observedPeakRoePercent = typeof options.observedPeakRoePercent === "number"
    && Number.isFinite(options.observedPeakRoePercent)
    ? options.observedPeakRoePercent
    : options.currentRoePercent;
  const peakRoePercent = Math.max(
    previous?.peakRoePercent ?? options.currentRoePercent,
    options.currentRoePercent,
    observedPeakRoePercent
  );
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
        : strategyClass === "scalp" && peakRoePercent >= SCALP_PROFIT_LOCK_RESCUE_ARM_ROE_PERCENT
          ? "four-to-two"
      : null;
  const armRoePercent = activeTier === "forty-to-thirty-two"
    ? SCALP_PROFIT_LOCK_FINAL_ARM_ROE_PERCENT
    : activeTier === "thirty-to-twenty-three"
      ? SCALP_PROFIT_LOCK_RUNNER_ARM_ROE_PERCENT
    : activeTier === "twenty-to-fifteen"
    ? PROFIT_LOCK_ARM_ROE_PERCENT
    : activeTier === "fifteen-to-ten"
      ? PROFIT_LOCK_INITIAL_ARM_ROE_PERCENT
      : activeTier === "ten-to-seven"
        ? SCALP_PROFIT_LOCK_INITIAL_ARM_ROE_PERCENT
        : strategyClass === "scalp"
          ? SCALP_PROFIT_LOCK_RESCUE_ARM_ROE_PERCENT
          : PROFIT_LOCK_INITIAL_ARM_ROE_PERCENT;
  const baseExitRoePercent = activeTier === "forty-to-thirty-two"
    ? SCALP_PROFIT_LOCK_FINAL_EXIT_ROE_PERCENT
    : activeTier === "thirty-to-twenty-three"
      ? SCALP_PROFIT_LOCK_RUNNER_EXIT_ROE_PERCENT
    : activeTier === "twenty-to-fifteen"
    ? PROFIT_LOCK_EXIT_ROE_PERCENT
    : activeTier === "fifteen-to-ten"
      ? PROFIT_LOCK_INITIAL_EXIT_ROE_PERCENT
      : activeTier === "ten-to-seven"
        ? SCALP_PROFIT_LOCK_INITIAL_EXIT_ROE_PERCENT
        : activeTier === "four-to-two" || strategyClass === "scalp"
          ? SCALP_PROFIT_LOCK_RESCUE_EXIT_ROE_PERCENT
          : PROFIT_LOCK_INITIAL_EXIT_ROE_PERCENT;
  // Jupiter's primary feed supplies after-fee PnL, and the RPC fallback is
  // normalized to the same basis above. Staircase thresholds are therefore
  // net-ROE targets. Adding fee ROE here would count fees twice (and at legacy
  // 49.9x leverage could place the exit above the arm level). Fees are added
  // exactly once only when a net target is converted to an on-chain stop price.
  const minimumProtectedNetRoePercent = strategyClass === "scalp" && activeTier !== null
    ? SCALP_PROFIT_LOCK_MINIMUM_NET_ROE_PERCENT
    : baseExitRoePercent;
  const exitRoePercent = Math.max(
    baseExitRoePercent,
    minimumProtectedNetRoePercent,
    previous?.protectedExitRoePercent ?? 0
  );
  const armedAt = previous?.armedAt
    ?? (activeTier !== null ? now : null);
  const closeIsPending = Boolean(
    previous?.closeTxid
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
      episodeId: options.episodeId ?? previous?.episodeId,
      strategyClass,
      peakRoePercent,
      activeTier,
      protectedExitRoePercent: activeTier === null ? null : exitRoePercent,
      armedAt,
      closeTxid: closeIsPending ? previous?.closeTxid ?? null : null,
      closeSubmittedAt: closeIsPending ? previous?.closeSubmittedAt ?? null : null,
      closeClaimedAt: previous?.closeClaimedAt ?? null,
      closeClaimOwnerToken: previous?.closeClaimOwnerToken ?? null,
      closeStatus: closeIsPending ? previous?.closeStatus ?? "submitted" : previous?.closeStatus ?? null,
      closeError: previous?.closeError ?? null,
      onChainStopTier: previous?.onChainStopTier ?? null,
      onChainStopPrice: previous?.onChainStopPrice ?? null,
      onChainStopStatus: previous?.onChainStopStatus ?? null,
      onChainStopTxid: previous?.onChainStopTxid ?? null,
      onChainStopAttemptedAt: previous?.onChainStopAttemptedAt ?? null,
      onChainStopClaimOwnerToken: previous?.onChainStopClaimOwnerToken ?? null,
      onChainStopError: previous?.onChainStopError ?? null,
      updatedAt: now,
    },
  };
}
