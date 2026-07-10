import { MINTS, createPerpsClient, type Asset, type InputToken, type Side } from "jupiter-perps-api-sdk";

import { PerpsExecutionError } from "@/lib/perps/errors";
import type { PerpsSignalPayload } from "@/lib/perps/types";

const perps = createPerpsClient();

const MARKET_TO_ASSET: Record<string, Asset> = {
  "SOL-PERP": "SOL",
  "ETH-PERP": "ETH",
  "BTC-PERP": "BTC",
};

const ASSET_TO_MINT = {
  SOL: MINTS.SOL,
  ETH: MINTS.ETH,
  BTC: MINTS.BTC,
} as const;

function usdToAtomicUsdcString(value: number) {
  return String(Math.max(1, Math.floor(value * 1_000_000)));
}

function uiUsdPriceToRawUsdString(value: number) {
  return String(Math.max(1, Math.round(value * 1_000_000)));
}

function getAssetForMarket(market: string): Asset {
  const asset = MARKET_TO_ASSET[market.toUpperCase()];
  if (!asset) {
    throw new PerpsExecutionError("MARKET_NOT_SUPPORTED", `${market} cannot be mapped to a Jupiter Perps asset.`, 400);
  }
  return asset;
}

export async function buildPerpsTransactionForSignal(signal: PerpsSignalPayload, walletAddress: string) {
  const asset = getAssetForMarket(signal.market);
  const side: Side = signal.side;
  const inputToken: InputToken = "USDC";
  const inputTokenAmount = usdToAtomicUsdcString(signal.collateralUsd);

  if (signal.action === "close") {
    throw new PerpsExecutionError("LIVE_CLOSE_NOT_IMPLEMENTED", "Live close execution is not enabled in this build yet.", 501);
  }

  const response = await perps.trading.increasePosition({
    asset,
    inputToken,
    inputTokenAmount,
    side,
    walletAddress,
    leverage: String(signal.leverage),
    maxSlippageBps: String(signal.maxSlippageBps),
    tpsl: [
      ...(signal.takeProfit?.enabled && signal.takeProfit.priceUsd
        ? [{ receiveToken: inputToken, requestType: "tp" as const, triggerPrice: uiUsdPriceToRawUsdString(signal.takeProfit.priceUsd) }]
        : []),
      ...(signal.stopLoss?.enabled && signal.stopLoss.priceUsd
        ? [{ receiveToken: inputToken, requestType: "sl" as const, triggerPrice: uiUsdPriceToRawUsdString(signal.stopLoss.priceUsd) }]
        : []),
    ],
  });

  if (!response.serializedTxBase64) {
    throw new PerpsExecutionError("MISSING_SERIALIZED_TX", "Jupiter Perps did not return a serialized transaction.", 502);
  }

  return {
    asset,
    marketMint: ASSET_TO_MINT[asset],
    serializedTxBase64: response.serializedTxBase64,
    positionPubkey: response.positionPubkey ?? null,
    quote: response.quote,
  };
}

export async function executeSignedPerpsTransaction(action: "increase-position" | "close-position", serializedTxBase64: string) {
  const baseUrl = process.env.PERPS_JUPITER_API_BASE?.trim() || "https://perps-api.jup.ag/v1";
  const response = await fetch(`${baseUrl}/transaction/execute`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "x-perps-api-version": "v2",
    },
    cache: "no-store",
    body: JSON.stringify({
      action,
      serializedTxBase64,
    }),
  });

  const body = await response.text();
  if (!response.ok) {
    throw new PerpsExecutionError("JUPITER_EXECUTE_FAILED", body || "Jupiter Perps execution failed.", response.status);
  }

  try {
    return JSON.parse(body) as { txid?: string; positionPubkey?: string };
  } catch {
    return { txid: null, positionPubkey: null };
  }
}
