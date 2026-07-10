import { NextRequest } from "next/server";
import { MINTS, createPerpsClient, type Asset, type InputToken, type Side } from "jupiter-perps-api-sdk";

export const dynamic = "force-dynamic";

const perps = createPerpsClient();
const UPSTREAM_RETRY_MS = 750;
const MAX_UPSTREAM_ATTEMPTS = 2;

type OpenPerpsRequest = {
  asset?: Asset;
  inputToken?: InputToken;
  inputTokenAmount?: string;
  leverage?: string;
  maxSlippageBps?: string;
  orderType?: "market" | "limit";
  side?: Side;
  takeProfitPrice?: string | null;
  stopLossPrice?: string | null;
  triggerPrice?: string | null;
  walletAddress?: string;
};

const ASSET_TO_MINT: Record<Asset, typeof MINTS.SOL | typeof MINTS.ETH | typeof MINTS.BTC> = {
  SOL: MINTS.SOL,
  ETH: MINTS.ETH,
  BTC: MINTS.BTC,
};

function isAsset(value: string | undefined): value is Asset {
  return value === "SOL" || value === "ETH" || value === "BTC";
}

function isInputToken(value: string | undefined): value is InputToken {
  return value === "SOL" || value === "ETH" || value === "BTC" || value === "USDC";
}

function isSide(value: string | undefined): value is Side {
  return value === "long" || value === "short";
}

function normalizePositiveNumberString(value: string | null | undefined) {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return null;

  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return trimmed;
}

function uiUsdToRawUsdString(value: string | null | undefined) {
  const normalized = normalizePositiveNumberString(value);
  if (!normalized) return null;

  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;

  return String(Math.max(1, Math.round(parsed * 1_000_000)));
}

function normalizeRawAmount(value: string | undefined) {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return null;

  if (!/^\d+$/.test(trimmed)) return null;
  if (trimmed === "0") return null;
  return trimmed;
}

function rawUsdToNumber(value: string | null | undefined) {
  if (!value) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return parsed / 1_000_000;
}

function emptyMarketStats() {
  return {
    price: null,
    change24h: null,
    high24h: null,
    low24h: null,
    volume24h: null,
  };
}

function emptyPoolInfo() {
  return {
    longBorrowRatePercent: null,
    shortBorrowRatePercent: null,
    openFeePercent: null,
    maxPriceImpactFeePercent: null,
  };
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shouldRetryPerpsError(error: unknown) {
  if (!(error instanceof Error)) {
    return false;
  }

  return /500|internal server error|backend returned/i.test(error.message);
}

async function withPerpsRetry<T>(task: () => Promise<T>) {
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_UPSTREAM_ATTEMPTS; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      lastError = error;
      if (attempt === MAX_UPSTREAM_ATTEMPTS || !shouldRetryPerpsError(error)) {
        throw error;
      }
      await wait(UPSTREAM_RETRY_MS);
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Jupiter Perps request failed.");
}

export async function POST(request: NextRequest) {
  const payload = await request.json().catch(() => null) as OpenPerpsRequest | null;

  const asset = payload?.asset;
  const inputToken = payload?.inputToken;
  const inputTokenAmount = normalizeRawAmount(payload?.inputTokenAmount);
  const side = payload?.side;
  const leverage = normalizePositiveNumberString(payload?.leverage) ?? "5";
  const maxSlippageBps = normalizePositiveNumberString(payload?.maxSlippageBps) ?? "100";
  const orderType = payload?.orderType === "limit" ? "limit" : "market";
  const walletAddress = payload?.walletAddress?.trim();
  const triggerPrice = normalizePositiveNumberString(payload?.triggerPrice);
  const takeProfitPrice = uiUsdToRawUsdString(payload?.takeProfitPrice);
  const stopLossPrice = uiUsdToRawUsdString(payload?.stopLossPrice);

  if (!walletAddress) {
    return Response.json({ error: "Connect Jupiter Mobile before opening a Perps order." }, { status: 400 });
  }

  if (!isAsset(asset) || !isInputToken(inputToken) || !isSide(side) || !inputTokenAmount) {
    return Response.json({ error: "Incomplete Perps order request." }, { status: 400 });
  }

  if (orderType === "limit" && !triggerPrice) {
    return Response.json({ error: "A trigger price is required for limit/trigger Perps orders." }, { status: 400 });
  }

  try {
    const orderResponse = await withPerpsRetry(() => (
      orderType === "limit"
        ? perps.trading.createLimitOrder({
            asset,
            inputToken,
            inputTokenAmount,
            side,
            triggerPrice: triggerPrice!,
            walletAddress,
            leverage,
            includeSerializedTx: true,
          })
        : perps.trading.increasePosition({
            asset,
            inputToken,
            inputTokenAmount,
            side,
            walletAddress,
            leverage,
            maxSlippageBps,
            tpsl: [
              ...(takeProfitPrice ? [{ receiveToken: inputToken, requestType: "tp" as const, triggerPrice: takeProfitPrice }] : []),
              ...(stopLossPrice ? [{ receiveToken: inputToken, requestType: "sl" as const, triggerPrice: stopLossPrice }] : []),
            ],
          })
    ));

    const [marketStatsResult, poolInfoResult] = await Promise.allSettled([
      perps.markets.getStats({ mint: ASSET_TO_MINT[asset] }),
      perps.markets.getPoolInfo({ mint: ASSET_TO_MINT[asset] }),
    ]);

    const market =
      marketStatsResult.status === "fulfilled"
        ? {
            price: Number(marketStatsResult.value.price),
            change24h: Number(marketStatsResult.value.priceChange24H),
            high24h: Number(marketStatsResult.value.priceHigh24H),
            low24h: Number(marketStatsResult.value.priceLow24H),
            volume24h: Number(marketStatsResult.value.volume),
          }
        : emptyMarketStats();

    const pool =
      poolInfoResult.status === "fulfilled"
        ? {
            longBorrowRatePercent: Number(poolInfoResult.value.longBorrowRatePercent),
            shortBorrowRatePercent: Number(poolInfoResult.value.shortBorrowRatePercent),
            openFeePercent: Number(poolInfoResult.value.openFeePercent),
            maxPriceImpactFeePercent: Number(poolInfoResult.value.maxPriceImpactFeePercent),
          }
        : emptyPoolInfo();

    if (marketStatsResult.status === "rejected" || poolInfoResult.status === "rejected") {
      console.warn("[Perps Open Metadata Warning]", {
        asset,
        orderType,
        side,
        marketError:
          marketStatsResult.status === "rejected"
            ? marketStatsResult.reason instanceof Error
              ? marketStatsResult.reason.message
              : String(marketStatsResult.reason)
            : null,
        poolError:
          poolInfoResult.status === "rejected"
            ? poolInfoResult.reason instanceof Error
              ? poolInfoResult.reason.message
              : String(poolInfoResult.reason)
            : null,
      });
    }

    return Response.json({
      orderType,
      side,
      asset,
      inputToken,
      serializedTxBase64: orderResponse.serializedTxBase64,
      positionPubkey: orderResponse.positionPubkey,
      quote: orderResponse.quote,
      quoteDisplay: {
        averagePriceUsd: rawUsdToNumber(orderResponse.quote.averagePriceUsd),
        collateralUsdDelta: rawUsdToNumber(orderResponse.quote.collateralUsdDelta),
        leverage: Number(orderResponse.quote.leverage),
        liquidationPriceUsd: rawUsdToNumber(orderResponse.quote.liquidationPriceUsd),
        openFeeUsd: rawUsdToNumber(orderResponse.quote.openFeeUsd),
        outstandingBorrowFeeUsd: rawUsdToNumber(orderResponse.quote.outstandingBorrowFeeUsd),
        positionCollateralUsd: rawUsdToNumber(orderResponse.quote.positionCollateralUsd),
        positionSizeUsd: rawUsdToNumber(orderResponse.quote.positionSizeUsd),
        priceImpactFeeBps: Number(orderResponse.quote.priceImpactFeeBps),
        priceImpactFeeUsd: rawUsdToNumber(orderResponse.quote.priceImpactFeeUsd),
        sizeUsdDelta: rawUsdToNumber(orderResponse.quote.sizeUsdDelta),
      },
      market,
      pool,
      tpsl: "tpsl" in orderResponse ? orderResponse.tpsl : [],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to build the Jupiter Perps order right now.";
    console.error("[Perps Open Error]", {
      asset,
      inputToken,
      orderType,
      side,
      walletAddress,
      message,
    });
    return Response.json(
      {
        error:
          "Jupiter Perps could not build the order right now. Check collateral, leverage, and trigger settings, then try again.",
        detail: message,
      },
      { status: 500 }
    );
  }
}
