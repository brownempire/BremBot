import type { ScalpEntryPath } from "@/lib/decision/learningTypes";

export const SCALP_MINIMUM_LEVERAGE = 25;
export const SCALP_NORMAL_MAXIMUM_LEVERAGE = 40;
export const SCALP_EXCEPTIONAL_MAXIMUM_LEVERAGE = 50;

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

export function isExceptionalScalpLeverageSetup(input: {
  entryPath: ScalpEntryPath | null;
  confidence: number;
  priceActionScore: number;
  indicatorScore: number;
  indicatorBypass: boolean;
  adx: number | null;
  volumeRatio: number | null;
}) {
  const scoreQualified = input.confidence >= 0.85
    && input.priceActionScore >= 0.9;
  if (!scoreQualified) return false;

  if (input.entryPath === "reversal" || input.entryPath === "range-reversal") {
    return input.indicatorBypass
      && (input.adx === null || input.adx <= 45)
      && (input.volumeRatio === null || input.volumeRatio >= 0.75);
  }

  return (input.entryPath === "continuation" || input.entryPath === "breakout-retest")
    && input.indicatorScore >= 5
    && typeof input.adx === "number"
    && input.adx >= 25
    && input.adx <= 45
    && typeof input.volumeRatio === "number"
    && input.volumeRatio >= 1.15;
}

/**
 * Preserve learned quality ordering while translating a persisted profile's
 * range into the dedicated scalp range. Ordinary setups use 25-40x and only
 * independently exceptional setups can enter the 40-50x tier.
 */
export function resolveScalpTradeLeverage(input: {
  learnedLeverage: number;
  learnedFloor?: number | null;
  learnedCap?: number | null;
  exceptional: boolean;
}) {
  const learnedCap = typeof input.learnedCap === "number"
    && Number.isFinite(input.learnedCap)
    && input.learnedCap > 0
    ? input.learnedCap
    : SCALP_NORMAL_MAXIMUM_LEVERAGE;
  const learnedFloor = typeof input.learnedFloor === "number"
    && Number.isFinite(input.learnedFloor)
    && input.learnedFloor > 0
    ? Math.min(input.learnedFloor, learnedCap)
    : Math.min(1, learnedCap);
  const quality = learnedCap > learnedFloor
    ? clamp((input.learnedLeverage - learnedFloor) / (learnedCap - learnedFloor), 0, 1)
    : 0;
  const minimum = input.exceptional
    ? SCALP_NORMAL_MAXIMUM_LEVERAGE
    : SCALP_MINIMUM_LEVERAGE;
  const maximum = input.exceptional
    ? SCALP_EXCEPTIONAL_MAXIMUM_LEVERAGE
    : SCALP_NORMAL_MAXIMUM_LEVERAGE;
  return Number((minimum + (maximum - minimum) * quality).toFixed(2));
}
