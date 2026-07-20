import {
  MINTS,
  createPerpsClient,
  type Asset,
  type InputToken,
  type Side,
  type TransactionAction,
} from "jupiter-perps-api-sdk";

import { PerpsExecutionError } from "@/lib/perps/errors";
import {
  getEntryPositionTpsl,
  getStandalonePositionTpsl,
  parseActualPositionForProtection,
  type ActualPositionForProtection,
} from "@/lib/perps/tpslPlan";
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

type PerpsTradingClient = Pick<typeof perps.trading, "increasePosition" | "createTpsl">;
type PerpsPositionsClient = Pick<typeof perps.positions, "get">;

function getAssetForMarket(market: string): Asset {
  const asset = MARKET_TO_ASSET[market.toUpperCase()];
  if (!asset) {
    throw new PerpsExecutionError("MARKET_NOT_SUPPORTED", `${market} cannot be mapped to a Jupiter Perps asset.`, 400);
  }
  return asset;
}

export async function buildPerpsTransactionForSignal(
  signal: PerpsSignalPayload,
  walletAddress: string,
  tradingClient: PerpsTradingClient = perps.trading
) {
  const asset = getAssetForMarket(signal.market);
  const side: Side = signal.side;
  const inputToken: InputToken = "USDC";
  const inputTokenAmount = usdToAtomicUsdcString(signal.collateralUsd);

  if (signal.action === "close") {
    throw new PerpsExecutionError("LIVE_CLOSE_NOT_IMPLEMENTED", "Live close execution is not enabled in this build yet.", 501);
  }

  const request = {
    asset,
    inputToken,
    inputTokenAmount,
    side,
    walletAddress,
    leverage: String(signal.leverage),
    maxSlippageBps: String(signal.maxSlippageBps),
  };

  const response = await tradingClient.increasePosition({ ...request, tpsl: getEntryPositionTpsl() });

  if (!response.serializedTxBase64) {
    throw new PerpsExecutionError("MISSING_SERIALIZED_TX", "Jupiter Perps did not return a serialized transaction.", 502);
  }

  return {
    asset,
    marketMint: ASSET_TO_MINT[asset],
    serializedTxBase64: response.serializedTxBase64,
    positionPubkey: response.positionPubkey ?? null,
    quote: response.quote,
    tpslMode: "deferred" as const,
  };
}

export async function getActualPositionForProtection(
  walletAddress: string,
  positionPubkey: string,
  positionsClient: PerpsPositionsClient = perps.positions
): Promise<ActualPositionForProtection> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, attempt * 500));
    try {
      const response = await positionsClient.get({ walletAddress, includeClosedPositions: false });
      const position = response.dataList.find((item) => item.positionPubkey === positionPubkey);
      if (!position) throw new Error("Jupiter has not indexed the opened position yet.");
      return parseActualPositionForProtection(position);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error("Unable to load the opened Jupiter position.");
    }
  }
  throw lastError ?? new Error("Unable to load the opened Jupiter position.");
}

export async function buildPerpsTpslTransactionForSignal(
  signal: PerpsSignalPayload,
  walletAddress: string,
  positionPubkey: string,
  tradingClient: PerpsTradingClient = perps.trading
) {
  const tpsl = getStandalonePositionTpsl(signal);
  if (tpsl.length === 0) return null;
  return tradingClient.createTpsl({ walletAddress, positionPubkey, tpsl });
}

export async function executeSignedPerpsTransaction(action: TransactionAction, serializedTxBase64: string) {
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
