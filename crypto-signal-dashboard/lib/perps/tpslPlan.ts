type SignalTrigger = {
  enabled: boolean;
  priceUsd?: number | null;
};

type SignalWithTpsl = {
  takeProfit?: SignalTrigger;
  stopLoss?: SignalTrigger;
};

export type ActualPositionForProtection = {
  side: "long" | "short";
  entryPriceUsd: number;
  markPriceUsd: number;
  sizeUsd: number;
  totalFeesUsd: number;
};

export type RawActualPositionForProtection = {
  side: "long" | "short";
  entryPriceUsd: string;
  markPriceUsd: string;
  sizeUsd: string;
  totalFeesUsd: string;
};

type ActualPositionProtectionInput = {
  position: ActualPositionForProtection;
  referencePriceUsd: number;
  referenceSizeUsd: number;
  requestedTakeProfitPrice?: number | null;
  requestedStopLossPrice?: number | null;
  minimumTakeProfitUsd?: number;
  marketBufferBps?: number;
};

export type PlannedTpslRequest = {
  entirePosition?: boolean;
  receiveToken: "USDC";
  requestType: "tp" | "sl";
  triggerPrice: string;
};

export function getEntryPositionTpsl(): PlannedTpslRequest[] {
  return [];
}

function uiUsdPriceToRawUsdString(value: number) {
  return String(Math.max(1, Math.round(value * 1_000_000)));
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

function positiveFinite(value: number, fallback: number) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function rawUsdToNumber(value: string) {
  const parsed = Number(value) / 1_000_000;
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseActualPositionForProtection(position: RawActualPositionForProtection): ActualPositionForProtection {
  const entryPriceUsd = rawUsdToNumber(position.entryPriceUsd);
  const markPriceUsd = rawUsdToNumber(position.markPriceUsd);
  const sizeUsd = rawUsdToNumber(position.sizeUsd);
  const totalFeesUsd = rawUsdToNumber(position.totalFeesUsd);
  if (!entryPriceUsd || !markPriceUsd || !sizeUsd || totalFeesUsd === null) {
    throw new Error("Jupiter returned incomplete live position values for TP calculation.");
  }
  return { side: position.side, entryPriceUsd, markPriceUsd, sizeUsd, totalFeesUsd };
}

export function calculateActualPositionProtection(input: ActualPositionProtectionInput) {
  const { position } = input;
  const referencePriceUsd = positiveFinite(input.referencePriceUsd, position.entryPriceUsd);
  const referenceSizeUsd = positiveFinite(input.referenceSizeUsd, position.sizeUsd);
  const minimumTakeProfitUsd = positiveFinite(input.minimumTakeProfitUsd ?? 2, 2);
  const marketBuffer = positiveFinite(input.marketBufferBps ?? 10, 10) / 10_000;
  const requestedTakeProfitUsd = input.requestedTakeProfitPrice && referencePriceUsd > 0
    ? Math.abs(input.requestedTakeProfitPrice - referencePriceUsd) / referencePriceUsd * referenceSizeUsd
    : 0;
  const targetNetProfitUsd = Math.max(minimumTakeProfitUsd, requestedTakeProfitUsd);
  const grossProfitUsd = targetNetProfitUsd + Math.max(0, position.totalFeesUsd);
  const takeProfitMove = grossProfitUsd / position.sizeUsd;
  const entryBasedTakeProfit = position.side === "long"
    ? position.entryPriceUsd * (1 + takeProfitMove)
    : position.entryPriceUsd * (1 - takeProfitMove);
  const markBasedTakeProfit = position.side === "long"
    ? position.markPriceUsd * (1 + marketBuffer)
    : position.markPriceUsd * (1 - marketBuffer);
  const takeProfitPrice = position.side === "long"
    ? Math.max(entryBasedTakeProfit, markBasedTakeProfit)
    : Math.min(entryBasedTakeProfit, markBasedTakeProfit);

  let stopLossPrice: number | null = null;
  if (input.requestedStopLossPrice && referencePriceUsd > 0) {
    const stopLossMove = Math.abs(input.requestedStopLossPrice - referencePriceUsd) / referencePriceUsd;
    const entryBasedStopLoss = position.side === "long"
      ? position.entryPriceUsd * (1 - stopLossMove)
      : position.entryPriceUsd * (1 + stopLossMove);
    const markBasedStopLoss = position.side === "long"
      ? position.markPriceUsd * (1 - marketBuffer)
      : position.markPriceUsd * (1 + marketBuffer);
    stopLossPrice = position.side === "long"
      ? Math.min(entryBasedStopLoss, markBasedStopLoss)
      : Math.max(entryBasedStopLoss, markBasedStopLoss);
  }

  return {
    takeProfitPrice: Number(takeProfitPrice.toFixed(6)),
    stopLossPrice: stopLossPrice === null ? null : Number(stopLossPrice.toFixed(6)),
    targetNetProfitUsd: Number(targetNetProfitUsd.toFixed(6)),
  };
}
