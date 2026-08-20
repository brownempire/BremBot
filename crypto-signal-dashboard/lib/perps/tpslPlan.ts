import {
  DEFAULT_CONSERVATIVE_PERPS_ROUND_TRIP_FEE_RATE,
  SCALP_MINIMUM_NET_PROFIT_USD,
} from "@/lib/perps/scalpExit";

type SignalTrigger = {
  enabled: boolean;
  priceUsd?: number | null;
};

type SignalWithTpsl = {
  side?: "long" | "short";
  takeProfit?: SignalTrigger;
  stopLoss?: SignalTrigger;
  /** Spot reference used to create the pre-entry triggers. */
  referenceEntryPriceUsd?: number | null;
  estimatedRoundTripFeeRate?: number | null;
};

export type LivePositionForTpsl = {
  side: "long" | "short";
  entryPriceUsd: string;
  markPriceUsd: string;
  sizeUsd: string;
  totalFeesUsd: string;
};

export type PlannedTpslRequest = {
  entirePosition?: boolean;
  receiveToken: "USDC";
  requestType: "tp" | "sl";
  triggerPrice: string;
};

function uiUsdPriceToRawUsdString(value: number) {
  return String(Math.max(1, Math.round(value * 1_000_000)));
}

export function getInitialPositionTpsl(signal: SignalWithTpsl): PlannedTpslRequest[] {
  return [
    ...(signal.takeProfit?.enabled && signal.takeProfit.priceUsd
      ? [{ receiveToken: "USDC" as const, requestType: "tp" as const, triggerPrice: uiUsdPriceToRawUsdString(signal.takeProfit.priceUsd) }]
      : []),
    ...(signal.stopLoss?.enabled && signal.stopLoss.priceUsd
      ? [{ receiveToken: "USDC" as const, requestType: "sl" as const, triggerPrice: uiUsdPriceToRawUsdString(signal.stopLoss.priceUsd) }]
      : []),
  ];
}

function rawUsdToNumber(value: string) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed / 1_000_000 : null;
}

export type RebasedLivePositionTpsl = {
  takeProfitPrice: number | null | undefined;
  stopLossPrice: number | null | undefined;
};

export class LivePositionTriggerAlreadyCrossedError extends Error {
  readonly code = "LIVE_POSITION_TRIGGER_ALREADY_CROSSED";
  readonly triggerKind: "take-profit" | "stop-loss";

  constructor(triggerKind: "take-profit" | "stop-loss") {
    super(`The confirmed scalp position has already crossed its intended ${triggerKind}; it must close instead of moving protection farther away.`);
    this.name = "LivePositionTriggerAlreadyCrossedError";
    this.triggerKind = triggerKind;
  }
}

/** Rebase both protections from the confirmed fill instead of the quoted spot. */
export function rebaseTpslForLivePosition(
  signal: SignalWithTpsl,
  position: LivePositionForTpsl,
  minimumNetProfitUsd = 1
): RebasedLivePositionTpsl {
  const requestedTakeProfit = signal.takeProfit?.enabled ? signal.takeProfit.priceUsd : null;
  const requestedStopLoss = signal.stopLoss?.enabled ? signal.stopLoss.priceUsd : null;
  const entryPrice = rawUsdToNumber(position.entryPriceUsd);
  const markPrice = rawUsdToNumber(position.markPriceUsd);
  const sizeUsd = rawUsdToNumber(position.sizeUsd);
  const totalFeesUsd = rawUsdToNumber(position.totalFeesUsd) ?? 0;
  const side = signal.side ?? position.side;
  const hasFillAwareReference = typeof signal.referenceEntryPriceUsd === "number"
    && Number.isFinite(signal.referenceEntryPriceUsd)
    && signal.referenceEntryPriceUsd > 0;
  const referenceEntryPrice = hasFillAwareReference
    ? signal.referenceEntryPriceUsd!
    : entryPrice;

  if (!entryPrice || !markPrice || !sizeUsd || sizeUsd <= 0 || !referenceEntryPrice) {
    return {
      takeProfitPrice: requestedTakeProfit,
      stopLossPrice: requestedStopLoss,
    };
  }

  const hasEstimatedFeeRate = typeof signal.estimatedRoundTripFeeRate === "number"
    && Number.isFinite(signal.estimatedRoundTripFeeRate)
    && signal.estimatedRoundTripFeeRate > 0;
  const estimatedFeeRate = hasEstimatedFeeRate
    ? signal.estimatedRoundTripFeeRate!
    : DEFAULT_CONSERVATIVE_PERPS_ROUND_TRIP_FEE_RATE;
  const estimatedRoundTripFeesUsd = hasEstimatedFeeRate || hasFillAwareReference
    ? Math.max(totalFeesUsd, sizeUsd * estimatedFeeRate)
    : totalFeesUsd;
  let takeProfitPrice = requestedTakeProfit;
  if (requestedTakeProfit) {
    const requestedMoveRatio = Math.abs(requestedTakeProfit - referenceEntryPrice) / referenceEntryPrice;
    const requestedGrossProfitUsd = requestedMoveRatio * sizeUsd;
    const requiredGrossProfitUsd = estimatedRoundTripFeesUsd + Math.max(
      SCALP_MINIMUM_NET_PROFIT_USD,
      minimumNetProfitUsd
    );
    const targetGrossProfitUsd = Math.max(requestedGrossProfitUsd, requiredGrossProfitUsd);
    const targetMove = entryPrice * targetGrossProfitUsd / sizeUsd;
    const fillRelativeTakeProfit = side === "long"
      ? entryPrice + targetMove
      : entryPrice - targetMove;
    const takeProfitAlreadyCrossed = side === "long"
      ? markPrice >= fillRelativeTakeProfit
      : markPrice <= fillRelativeTakeProfit;
    if (hasFillAwareReference && takeProfitAlreadyCrossed) {
      throw new LivePositionTriggerAlreadyCrossedError("take-profit");
    }
    const legacyMarkBuffer = entryPrice / sizeUsd;
    takeProfitPrice = hasFillAwareReference
      ? fillRelativeTakeProfit
      : side === "long"
        ? Math.max(fillRelativeTakeProfit, markPrice + legacyMarkBuffer)
        : Math.min(fillRelativeTakeProfit, markPrice - legacyMarkBuffer);
  }

  let stopLossPrice = requestedStopLoss;
  if (requestedStopLoss) {
    if (!hasFillAwareReference) {
      stopLossPrice = requestedStopLoss;
      return { takeProfitPrice, stopLossPrice };
    }
    const requestedMoveRatio = Math.abs(requestedStopLoss - referenceEntryPrice) / referenceEntryPrice;
    const stopMove = entryPrice * requestedMoveRatio;
    const fillRelativeStop = side === "long"
      ? entryPrice - stopMove
      : entryPrice + stopMove;
    const stopAlreadyBreached = side === "long"
      ? markPrice <= fillRelativeStop
      : markPrice >= fillRelativeStop;
    if (stopAlreadyBreached) throw new LivePositionTriggerAlreadyCrossedError("stop-loss");
    stopLossPrice = fillRelativeStop;
  }

  return { takeProfitPrice, stopLossPrice };
}

/** Rebase a deferred TP against the actual fill, fees, and current mark. */
export function rebaseTakeProfitForLivePosition(
  signal: SignalWithTpsl,
  position: LivePositionForTpsl,
  minimumNetProfitUsd = 1
) {
  return rebaseTpslForLivePosition(signal, position, minimumNetProfitUsd).takeProfitPrice;
}

export function rebaseStopLossForLivePosition(
  signal: SignalWithTpsl,
  position: LivePositionForTpsl
) {
  return rebaseTpslForLivePosition(signal, position).stopLossPrice;
}

export function getStandalonePositionTpsl(
  signal: SignalWithTpsl,
  livePosition?: LivePositionForTpsl | null,
  minimumNetProfitUsd = 1
): PlannedTpslRequest[] {
  const rebased = livePosition
    ? rebaseTpslForLivePosition(signal, livePosition, minimumNetProfitUsd)
    : {
        takeProfitPrice: signal.takeProfit?.priceUsd,
        stopLossPrice: signal.stopLoss?.priceUsd,
      };
  return [
    ...(signal.takeProfit?.enabled && rebased.takeProfitPrice
      ? [{ entirePosition: true, receiveToken: "USDC" as const, requestType: "tp" as const, triggerPrice: uiUsdPriceToRawUsdString(rebased.takeProfitPrice) }]
      : []),
    ...(signal.stopLoss?.enabled && rebased.stopLossPrice
      ? [{ entirePosition: true, receiveToken: "USDC" as const, requestType: "sl" as const, triggerPrice: uiUsdPriceToRawUsdString(rebased.stopLossPrice) }]
      : []),
  ];
}

export async function buildEntryWithTpslFallback<T extends { tpsl?: unknown[] }>(
  requestedTpsl: PlannedTpslRequest[],
  build: (tpsl: PlannedTpslRequest[]) => Promise<T>,
  options: { forceDeferredProtection?: boolean } = {}
) {
  if (requestedTpsl.length === 0) {
    return { response: await build([]), tpslMode: "none" as const };
  }

  if (options.forceDeferredProtection) {
    return { response: await build([]), tpslMode: "deferred" as const };
  }

  try {
    const response = await build(requestedTpsl);
    return {
      response,
      tpslMode: response.tpsl?.length ? "bundled" as const : "deferred" as const,
    };
  } catch {
    return { response: await build([]), tpslMode: "deferred" as const };
  }
}
