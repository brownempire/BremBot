type SignalTrigger = {
  enabled: boolean;
  priceUsd?: number | null;
};

type SignalWithTpsl = {
  side?: "long" | "short";
  takeProfit?: SignalTrigger;
  stopLoss?: SignalTrigger;
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

/** Rebase a deferred TP against the actual fill, fees, and current mark. */
export function rebaseTakeProfitForLivePosition(
  signal: SignalWithTpsl,
  position: LivePositionForTpsl,
  minimumNetProfitUsd = 1
) {
  const requested = signal.takeProfit?.enabled ? signal.takeProfit.priceUsd : null;
  const entryPrice = rawUsdToNumber(position.entryPriceUsd);
  const markPrice = rawUsdToNumber(position.markPriceUsd);
  const sizeUsd = rawUsdToNumber(position.sizeUsd);
  const totalFeesUsd = rawUsdToNumber(position.totalFeesUsd) ?? 0;
  const side = signal.side ?? position.side;

  if (!requested || !entryPrice || !markPrice || !sizeUsd || sizeUsd <= 0) return requested;

  const requestedGrossProfitUsd = Math.abs(requested - entryPrice) / entryPrice * sizeUsd;
  const requiredGrossProfitUsd = totalFeesUsd + Math.max(1, minimumNetProfitUsd);
  const targetGrossProfitUsd = Math.max(requestedGrossProfitUsd, requiredGrossProfitUsd);
  const targetMove = entryPrice * targetGrossProfitUsd / sizeUsd;
  const markBuffer = entryPrice / sizeUsd;

  if (side === "long") {
    return Math.max(entryPrice + targetMove, markPrice + markBuffer);
  }
  return Math.min(entryPrice - targetMove, markPrice - markBuffer);
}

export function getStandalonePositionTpsl(
  signal: SignalWithTpsl,
  livePosition?: LivePositionForTpsl | null
): PlannedTpslRequest[] {
  const takeProfitPrice = livePosition
    ? rebaseTakeProfitForLivePosition(signal, livePosition)
    : signal.takeProfit?.priceUsd;
  return [
    ...(signal.takeProfit?.enabled && takeProfitPrice
      ? [{ entirePosition: true, receiveToken: "USDC" as const, requestType: "tp" as const, triggerPrice: uiUsdPriceToRawUsdString(takeProfitPrice) }]
      : []),
    ...(signal.stopLoss?.enabled && signal.stopLoss.priceUsd
      ? [{ entirePosition: true, receiveToken: "USDC" as const, requestType: "sl" as const, triggerPrice: uiUsdPriceToRawUsdString(signal.stopLoss.priceUsd) }]
      : []),
  ];
}

export async function buildEntryWithTpslFallback<T extends { tpsl?: unknown[] }>(
  requestedTpsl: PlannedTpslRequest[],
  build: (tpsl: PlannedTpslRequest[]) => Promise<T>
) {
  if (requestedTpsl.length === 0) {
    return { response: await build([]), tpslMode: "none" as const };
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
