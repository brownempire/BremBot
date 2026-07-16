type SignalTrigger = {
  enabled: boolean;
  priceUsd?: number | null;
};

type SignalWithTpsl = {
  takeProfit?: SignalTrigger;
  stopLoss?: SignalTrigger;
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

function uiUsdPriceToDecimalString(value: number) {
  return value.toFixed(6);
}

export function getInitialPositionTpsl(signal: SignalWithTpsl): PlannedTpslRequest[] {
  return [
    ...(signal.takeProfit?.enabled && signal.takeProfit.priceUsd
      ? [{ receiveToken: "USDC" as const, requestType: "tp" as const, triggerPrice: uiUsdPriceToDecimalString(signal.takeProfit.priceUsd) }]
      : []),
    ...(signal.stopLoss?.enabled && signal.stopLoss.priceUsd
      ? [{ receiveToken: "USDC" as const, requestType: "sl" as const, triggerPrice: uiUsdPriceToDecimalString(signal.stopLoss.priceUsd) }]
      : []),
  ];
}

export function getStandalonePositionTpsl(signal: SignalWithTpsl): PlannedTpslRequest[] {
  return [
    ...(signal.takeProfit?.enabled && signal.takeProfit.priceUsd
      ? [{ entirePosition: true, receiveToken: "USDC" as const, requestType: "tp" as const, triggerPrice: uiUsdPriceToRawUsdString(signal.takeProfit.priceUsd) }]
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
