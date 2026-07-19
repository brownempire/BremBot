import { clusterApiUrl, Connection, PublicKey } from "@solana/web3.js";

export type JupiterPerpsPositionSide = "long" | "short";
export type JupiterPerpsPositionSource = "live-api" | "portfolio-api" | "mock" | "rpc-direct" | "rpc-placeholder";
export type JupiterPerpsPendingTriggerKind = "take-profit" | "stop-loss";

export type JupiterPerpsPosition = {
  id: string;
  source: JupiterPerpsPositionSource;
  platformId: string;
  marketSymbol: string;
  marketName: string | null;
  marketAddress: string | null;
  custodyAddress: string | null;
  collateralCustodyAddress: string | null;
  collateralSymbol: string | null;
  imageUri: string | null;
  side: JupiterPerpsPositionSide;
  entryPrice: number | null;
  markPrice: number | null;
  positionSize: number | null;
  positionValue: number | null;
  collateralValue: number | null;
  leverage: number | null;
  unrealizedPnl: number | null;
  realizedPnl: number | null;
  liquidationPrice: number | null;
  fundingSnapshot: string | null;
  borrowSnapshot: string | null;
  takeProfit: number | null;
  stopLoss: number | null;
  markPriceIsLive: boolean;
  liquidationPriceIsEstimated: boolean;
  accountRef: string | null;
  lastUpdated: number | null;
  walletAddress?: string | null;
  walletRole?: "primary" | "agent";
};

export type JupiterPerpsPendingTrigger = {
  id: string;
  source: Exclude<JupiterPerpsPositionSource, "portfolio-api" | "rpc-placeholder">;
  platformId: string;
  marketSymbol: string;
  marketName: string | null;
  marketAddress: string | null;
  custodyAddress: string | null;
  collateralCustodyAddress: string | null;
  collateralSymbol: string | null;
  side: JupiterPerpsPositionSide;
  kind: JupiterPerpsPendingTriggerKind;
  triggerPrice: number | null;
  sizeDeltaUsd: number | null;
  collateralDelta: number | null;
  entirePosition: boolean;
  triggerAboveThreshold: boolean;
  executed: boolean;
  accountRef: string | null;
  positionPubkey: string | null;
  positionRequestPubkey: string | null;
  lastUpdated: number | null;
  walletAddress?: string | null;
  walletRole?: "primary" | "agent";
};

export type JupiterPerpsAccountSnapshot = {
  positions: JupiterPerpsPosition[];
  pendingTriggers: JupiterPerpsPendingTrigger[];
  recentTrades: JupiterPerpsTrade[];
};

export type JupiterPerpsTrade = {
  id: string;
  source: "live-api";
  positionPubkey: string | null;
  marketSymbol: string;
  marketName: string | null;
  side: JupiterPerpsPositionSide;
  action: string;
  orderType: string;
  price: number | null;
  sizeUsd: number | null;
  collateralUsdDelta: number | null;
  feeUsd: number | null;
  pnl: number | null;
  pnlPercentage: number | null;
  txHash: string | null;
  lastUpdated: number | null;
  createdAt: number | null;
  walletAddress?: string | null;
  walletRole?: "primary" | "agent";
};

type LivePerpsPositionsResponse = {
  dataList?: LivePerpsPosition[];
  count?: number;
};

type LivePerpsTradesResponse = {
  dataList?: LivePerpsTradeResponse[];
  count?: number;
};

export type JupiterPerpsTradeHistory = {
  trades: JupiterPerpsTrade[];
  totalCount: number;
  complete: boolean;
};

type LivePerpsPosition = {
  positionPubkey?: string;
  mint?: string;
  positionName?: string;
  side?: "long" | "short";
  sizeUsd?: string | number;
  collateralUsd?: string | number;
  entryPriceUsd?: string | number;
  markPriceUsd?: string | number;
  liquidationPriceUsd?: string | number;
  pnlAfterFeesUsd?: string | number;
  realizedPnlUsd?: string | number;
  createdTime?: number | string;
  updatedTime?: number | string;
  tpslRequests?: LivePerpsTriggerRequest[];
  imageUri?: string;
};

type LivePerpsTriggerRequest = {
  positionRequestPubkey?: string;
  triggerPriceUsd?: string | number;
  price?: string | number;
  side?: "long" | "short";
  triggerAboveThreshold?: boolean;
  entirePosition?: boolean;
  sizeUsdDelta?: string | number;
  collateralUsdDelta?: string | number;
  updatedTime?: number | string;
  createdTime?: number | string;
  orderType?: string;
  requestType?: string;
  txType?: string;
};

type LivePerpsTradeResponse = {
  mint?: string;
  positionName?: string;
  side?: "long" | "short";
  action?: string;
  orderType?: string;
  collateralUsdDelta?: string | number;
  price?: string | number;
  size?: string | number;
  fee?: string | number;
  pnl?: string | number | null;
  pnlPercentage?: string | number | null;
  txHash?: string;
  createdTime?: number | string;
  updatedTime?: number | string;
  positionPubkey?: string;
};

const JUPITER_PERPS_API_BASE = "https://perps-api.jup.ag/v1";
const JUPITER_EXCHANGE_PLATFORM = "jupiter-exchange";
const JUPITER_PERPS_PROGRAM_ID = new PublicKey("PERPHjGBqRHArX4DySjwM6UJHiR3sWAatqfdBS2qQJu");
const POSITION_ACCOUNT_DISCRIMINATOR = Uint8Array.from([0xa2, 0xbf, 0x9c, 0x22, 0x97, 0x83, 0x41, 0x8c]);
const INSTANT_TPSL_ACCOUNT_DISCRIMINATOR = Uint8Array.from([0x0c, 0x26, 0xfa, 0xc7, 0x2e, 0x9a, 0x20, 0xd8]);
const USDC_DECIMALS = 6;
const POSITION_REQUEST_MIN_BYTES = 8 + 32 + 32 + 32 + 32 + 32 + 8 + 8 + 8 + 8 + 1 + 1 + 1 + 8 + 8 + 8 + 8 + 1 + 1 + 1 + 8 + 1;
const MIN_PLAUSIBLE_UNIX_SECONDS = 1577836800n;
const MAX_PLAUSIBLE_UNIX_SECONDS = 4102444800n;

const JUPITER_CUSTODY_MARKETS = new Map([
  [
    "7xS2gz2bTp3fwCC7knJvUWTEU9Tycczu6VhJYKgi1wdz",
    {
      symbol: "SOL",
      marketName: "Jupiter SOL Perps",
      marketAddress: "So11111111111111111111111111111111111111112",
    },
  ],
  [
    "AQCGyheWPLeo6Qp9WpYS9m3Qj479t7R636N9ey1rEjEn",
    {
      symbol: "ETH",
      marketName: "Jupiter ETH Perps",
      marketAddress: "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs",
    },
  ],
  [
    "5Pv3gM9JrFFH883SWAhvJC9RPYmo8UNxuFtv5bMMALkm",
    {
      symbol: "BTC",
      marketName: "Jupiter BTC Perps",
      marketAddress: "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh",
    },
  ],
]);

const JUPITER_COLLATERAL_SYMBOLS = new Map([
  ["G18jKKXQwBbrHeiK3C9MRXhkHsLHf7XgCSisykV46EZa", "USDC"],
  ["4vkNeXiYEUizLdrpdPS1eC2mccyM4NUPRtERrk6ZETkk", "USDT"],
  ["7xS2gz2bTp3fwCC7knJvUWTEU9Tycczu6VhJYKgi1wdz", "SOL"],
  ["AQCGyheWPLeo6Qp9WpYS9m3Qj479t7R636N9ey1rEjEn", "ETH"],
  ["5Pv3gM9JrFFH883SWAhvJC9RPYmo8UNxuFtv5bMMALkm", "BTC"],
]);

const JUPITER_COINBASE_PRODUCTS = new Map([
  ["SOL", "SOL-USD"],
  ["ETH", "ETH-USD"],
  ["BTC", "BTC-USD"],
]);

function toFiniteNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function toFiniteNumberish(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function toOptionalTimestamp(value: unknown) {
  const numeric = toFiniteNumberish(value);
  if (numeric === null || numeric <= 0) return null;
  return Math.round(numeric * 1000);
}

function decimalUsdToNumber(value: unknown) {
  const numeric = toFiniteNumberish(value);
  if (numeric === null) return null;
  return roundUsd(numeric);
}

function atomicUsdLikeToNumber(value: unknown) {
  const numeric = toFiniteNumberish(value);
  if (numeric === null) return null;
  return roundUsd(numeric / 10 ** USDC_DECIMALS);
}

function atomicUsdToNumber(value: bigint) {
  return Number(value) / 10 ** USDC_DECIMALS;
}

function signedAtomicUsdToNumber(value: bigint) {
  return Number(value) / 10 ** USDC_DECIMALS;
}

function roundUsd(value: number | null, fractionDigits = 6) {
  if (value === null || !Number.isFinite(value)) return null;
  return Number(value.toFixed(fractionDigits));
}

function readPublicKey(bytes: Uint8Array, offset: number) {
  return new PublicKey(bytes.slice(offset, offset + 32));
}

function readU64(bytes: Uint8Array, offset: number) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.getBigUint64(offset, true);
}

function readI64(bytes: Uint8Array, offset: number) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.getBigInt64(offset, true);
}

function readU128(bytes: Uint8Array, offset: number) {
  const lower = readU64(bytes, offset);
  const upper = readU64(bytes, offset + 8);
  return lower + (upper << 64n);
}

function readBool(bytes: Uint8Array, offset: number) {
  return bytes[offset] === 1;
}

function hasDiscriminator(bytes: Uint8Array, discriminator: Uint8Array) {
  if (bytes.length < discriminator.length) return false;
  return discriminator.every((value, index) => bytes[index] === value);
}

function getPositionKey(parts: {
  custodyAddress: string | null;
  collateralCustodyAddress: string | null;
  side: JupiterPerpsPositionSide;
}) {
  return `${parts.custodyAddress ?? "unknown-custody"}:${parts.collateralCustodyAddress ?? "unknown-collateral"}:${parts.side}`;
}

function getTriggerKind(side: JupiterPerpsPositionSide, triggerAboveThreshold: boolean): JupiterPerpsPendingTriggerKind {
  if (side === "long") {
    return triggerAboveThreshold ? "take-profit" : "stop-loss";
  }

  return triggerAboveThreshold ? "stop-loss" : "take-profit";
}

function isPlausibleUnixSeconds(value: bigint) {
  return value >= MIN_PLAUSIBLE_UNIX_SECONDS && value <= MAX_PLAUSIBLE_UNIX_SECONDS;
}

function calculateUnrealizedPnl(position: JupiterPerpsPosition, markPrice: number | null) {
  if (
    markPrice === null ||
    position.entryPrice === null ||
    position.positionSize === null ||
    !Number.isFinite(markPrice) ||
    !Number.isFinite(position.entryPrice) ||
    !Number.isFinite(position.positionSize)
  ) {
    return null;
  }

  const priceDelta = position.side === "long"
    ? markPrice - position.entryPrice
    : position.entryPrice - markPrice;

  return roundUsd(priceDelta * position.positionSize);
}

function estimateLiquidationPrice(position: JupiterPerpsPosition) {
  if (
    position.entryPrice === null ||
    position.positionValue === null ||
    position.collateralValue === null ||
    position.positionValue <= 0 ||
    position.collateralValue <= 0
  ) {
    return null;
  }

  const collateralRatio = position.collateralValue / position.positionValue;
  const liquidationPrice = position.side === "long"
    ? position.entryPrice * (1 - collateralRatio)
    : position.entryPrice * (1 + collateralRatio);

  if (!Number.isFinite(liquidationPrice) || liquidationPrice <= 0) {
    return null;
  }

  return roundUsd(liquidationPrice);
}

async function fetchCoinbaseMarkPrices(symbols: string[]) {
  const products = [...new Set(
    symbols
      .map((symbol) => JUPITER_COINBASE_PRODUCTS.get(symbol))
      .filter((product): product is string => typeof product === "string" && product.length > 0)
  )];

  if (products.length === 0) {
    return new Map<string, number>();
  }

  const entries = await Promise.all(
    products.map(async (product) => {
      const response = await fetch(`https://api.exchange.coinbase.com/products/${product}/ticker`, {
        cache: "no-store",
        headers: { Accept: "application/json" },
      });

      if (!response.ok) return [product, null] as const;

      const payload = await response.json() as { price?: string };
      const price = Number(payload?.price);
      return [product, Number.isFinite(price) && price > 0 ? price : null] as const;
    })
  );

  return new Map(entries.filter((entry): entry is [string, number] => entry[1] !== null));
}

async function enrichPositionsWithLiveMetrics(positions: JupiterPerpsPosition[]) {
  if (positions.length === 0) return positions;

  const markPricesByProduct = await fetchCoinbaseMarkPrices(positions.map((position) => position.marketSymbol));

  return positions.map((position) => {
    const product = JUPITER_COINBASE_PRODUCTS.get(position.marketSymbol);
    const liveMarkPrice = product ? markPricesByProduct.get(product) ?? null : null;
    const markPrice = liveMarkPrice ?? position.markPrice;
    const unrealizedPnl = calculateUnrealizedPnl(position, markPrice) ?? position.unrealizedPnl;
    const liquidationPrice = position.liquidationPrice ?? estimateLiquidationPrice(position);

    return {
      ...position,
      markPrice,
      unrealizedPnl,
      liquidationPrice,
      markPriceIsLive: liveMarkPrice !== null,
      liquidationPriceIsEstimated: position.liquidationPrice === null && liquidationPrice !== null,
    };
  });
}

function decodePositionAccount(accountRef: string, bytes: Uint8Array): JupiterPerpsPosition | null {
  if (bytes.length < 8 + 32 + 32 + 32 + 32 + 8 + 8 + 1 + 8 + 8 + 8 + 8 + 16 + 8 + 1) {
    throw new Error(`Jupiter Perps position account ${accountRef} is smaller than expected.`);
  }

  // This layout follows Jupiter's published Position account fields in order.
  // We validate the documented field sequence directly instead of trusting a
  // single account discriminator, because Jupiter's Perps account headers are
  // still evolving and exact discriminator matching has not been reliable.

  let offset = 8;
  const owner = readPublicKey(bytes, offset);
  offset += 32;
  const pool = readPublicKey(bytes, offset);
  offset += 32;
  const custody = readPublicKey(bytes, offset);
  offset += 32;
  const collateralCustody = readPublicKey(bytes, offset);
  offset += 32;
  const openTime = readI64(bytes, offset);
  offset += 8;
  const updateTime = readI64(bytes, offset);
  offset += 8;
  const sideDiscriminant = bytes[offset];
  offset += 1;
  const price = readU64(bytes, offset);
  offset += 8;
  const sizeUsd = readU64(bytes, offset);
  offset += 8;
  const collateralUsd = readU64(bytes, offset);
  offset += 8;
  const realisedPnlUsd = readI64(bytes, offset);
  offset += 8;
  const cumulativeInterestSnapshot = readU128(bytes, offset);
  offset += 16;
  const lockedAmount = readU64(bytes, offset);
  offset += 8;
  const bump = bytes[offset];

  if (
    sideDiscriminant === 0 ||
    sizeUsd === 0n ||
    owner.equals(PublicKey.default) ||
    pool.equals(PublicKey.default) ||
    custody.equals(PublicKey.default) ||
    collateralCustody.equals(PublicKey.default) ||
    !isPlausibleUnixSeconds(openTime) ||
    !isPlausibleUnixSeconds(updateTime)
  ) {
    return null;
  }

  const market = JUPITER_CUSTODY_MARKETS.get(custody.toBase58());
  const collateralSymbol = JUPITER_COLLATERAL_SYMBOLS.get(collateralCustody.toBase58()) ?? "Unknown";
  const entryPrice = atomicUsdToNumber(price);
  const positionValue = atomicUsdToNumber(sizeUsd);
  const collateralValue = atomicUsdToNumber(collateralUsd);
  const leverage = collateralValue > 0 ? positionValue / collateralValue : null;
  const positionSize = entryPrice > 0 ? positionValue / entryPrice : null;

  return {
    id: accountRef,
    source: "rpc-direct",
    platformId: JUPITER_EXCHANGE_PLATFORM,
    marketSymbol: market?.symbol ?? `${custody.toBase58().slice(0, 4)}...${custody.toBase58().slice(-4)}`,
    marketName: market?.marketName ?? "Jupiter Perps position",
    marketAddress: market?.marketAddress ?? custody.toBase58(),
    custodyAddress: custody.toBase58(),
    collateralCustodyAddress: collateralCustody.toBase58(),
    collateralSymbol,
    imageUri: null,
    side: sideDiscriminant === 2 ? "short" : "long",
    entryPrice,
    markPrice: null,
    positionSize,
    positionValue,
    collateralValue,
    leverage,
    unrealizedPnl: null,
    realizedPnl: signedAtomicUsdToNumber(realisedPnlUsd),
    liquidationPrice: null,
    fundingSnapshot: null,
    borrowSnapshot: `Interest snapshot ${cumulativeInterestSnapshot.toString()} via ${collateralSymbol}`,
    takeProfit: null,
    stopLoss: null,
    markPriceIsLive: false,
    liquidationPriceIsEstimated: false,
    accountRef,
    lastUpdated: Number(updateTime) * 1000,
  };
}

function decodePositionRequestAccount(accountRef: string, bytes: Uint8Array): JupiterPerpsPendingTrigger | null {
  if (
    bytes.length < POSITION_REQUEST_MIN_BYTES ||
    hasDiscriminator(bytes, POSITION_ACCOUNT_DISCRIMINATOR) ||
    hasDiscriminator(bytes, INSTANT_TPSL_ACCOUNT_DISCRIMINATOR)
  ) {
    return null;
  }

  let offset = 8;
  const owner = readPublicKey(bytes, offset);
  offset += 32;
  const pool = readPublicKey(bytes, offset);
  offset += 32;
  const custody = readPublicKey(bytes, offset);
  offset += 32;
  const collateralCustody = readPublicKey(bytes, offset);
  offset += 32;
  const mint = readPublicKey(bytes, offset);
  offset += 32;
  const openTime = readI64(bytes, offset);
  offset += 8;
  const updateTime = readI64(bytes, offset);
  offset += 8;
  const sizeUsdDelta = readU64(bytes, offset);
  offset += 8;
  const collateralDelta = readU64(bytes, offset);
  offset += 8;
  const requestChangeDiscriminant = bytes[offset];
  offset += 1;
  const requestTypeDiscriminant = bytes[offset];
  offset += 1;
  const sideDiscriminant = bytes[offset];
  offset += 1;
  const priceSlippage = readU64(bytes, offset);
  offset += 8;
  const jupiterMinimumOut = readU64(bytes, offset);
  offset += 8;
  const preSwapAmount = readU64(bytes, offset);
  offset += 8;
  const triggerPrice = readU64(bytes, offset);
  offset += 8;
  const triggerAboveThresholdByte = bytes[offset];
  const triggerAboveThreshold = readBool(bytes, offset);
  offset += 1;
  const entirePositionByte = bytes[offset];
  const entirePosition = readBool(bytes, offset);
  offset += 1;
  const executedByte = bytes[offset];
  const executed = readBool(bytes, offset);
  offset += 1;
  const counter = readU64(bytes, offset);
  offset += 8;
  const bump = bytes[offset];

  if (
    sideDiscriminant === 0 ||
    triggerPrice === 0n ||
    executed ||
    owner.equals(PublicKey.default) ||
    pool.equals(PublicKey.default) ||
    custody.equals(PublicKey.default) ||
    collateralCustody.equals(PublicKey.default) ||
    mint.equals(PublicKey.default) ||
    !isPlausibleUnixSeconds(openTime) ||
    !isPlausibleUnixSeconds(updateTime)
  ) {
    return null;
  }

  // These fields are documented by Jupiter and used here as sanity checks so we
  // do not mis-classify unrelated owner-scoped accounts as TP/SL requests.
  if (
    requestChangeDiscriminant > 2 ||
    requestTypeDiscriminant > 3 ||
    (triggerAboveThresholdByte !== 0 && triggerAboveThresholdByte !== 1) ||
    (entirePositionByte !== 0 && entirePositionByte !== 1) ||
    (executedByte !== 0 && executedByte !== 1)
  ) {
    return null;
  }

  const side: JupiterPerpsPositionSide = sideDiscriminant === 2 ? "short" : "long";
  const market = JUPITER_CUSTODY_MARKETS.get(custody.toBase58());
  const collateralSymbol = JUPITER_COLLATERAL_SYMBOLS.get(collateralCustody.toBase58()) ?? "Unknown";

  return {
    id: accountRef,
    source: "rpc-direct",
    platformId: JUPITER_EXCHANGE_PLATFORM,
    marketSymbol: market?.symbol ?? `${custody.toBase58().slice(0, 4)}...${custody.toBase58().slice(-4)}`,
    marketName: market?.marketName ?? "Jupiter Perps trigger request",
    marketAddress: market?.marketAddress ?? custody.toBase58(),
    custodyAddress: custody.toBase58(),
    collateralCustodyAddress: collateralCustody.toBase58(),
    collateralSymbol,
    side,
    kind: getTriggerKind(side, triggerAboveThreshold),
    triggerPrice: atomicUsdToNumber(triggerPrice),
    sizeDeltaUsd: atomicUsdToNumber(sizeUsdDelta),
    collateralDelta: Number(collateralDelta),
    entirePosition,
    triggerAboveThreshold,
    executed,
    accountRef,
    positionPubkey: null,
    positionRequestPubkey: accountRef,
    lastUpdated: Number(updateTime || openTime) * 1000,
  };
}

function inferTriggerKindFromPrice(
  side: JupiterPerpsPositionSide,
  entryPrice: number | null,
  triggerPrice: number | null
): JupiterPerpsPendingTriggerKind {
  if (entryPrice === null || triggerPrice === null) {
    return side === "long" ? "take-profit" : "stop-loss";
  }

  if (side === "long") {
    return triggerPrice >= entryPrice ? "take-profit" : "stop-loss";
  }

  return triggerPrice <= entryPrice ? "take-profit" : "stop-loss";
}

function inferLiveTriggerKind(
  trigger: LivePerpsTriggerRequest,
  side: JupiterPerpsPositionSide,
  entryPrice: number | null,
  triggerPrice: number | null
) {
  const requestLabel = `${trigger.orderType ?? ""} ${trigger.requestType ?? ""} ${trigger.txType ?? ""}`.toLowerCase();
  if (requestLabel.includes("tp") || requestLabel.includes("take")) {
    return "take-profit" as const;
  }
  if (requestLabel.includes("sl") || requestLabel.includes("stop")) {
    return "stop-loss" as const;
  }

  return inferTriggerKindFromPrice(side, entryPrice, triggerPrice);
}

function normalizeLiveMarketSymbol(positionName: string | null, mint: string | null) {
  if (positionName) {
    return positionName.replace(/-PERP$/i, "").replace(/[^A-Z0-9]/gi, "").toUpperCase() || "PERP";
  }

  if (mint && mint === "So11111111111111111111111111111111111111112") {
    return "SOL";
  }

  if (mint) {
    return `${mint.slice(0, 4)}...${mint.slice(-4)}`;
  }

  return "PERP";
}

function resolveMarketMetadataFromLivePosition(positionName: string | null, mint: string | null) {
  const marketSymbol = normalizeLiveMarketSymbol(positionName, mint);
  const custodyEntry = [...JUPITER_CUSTODY_MARKETS.entries()].find(([, market]) => market.symbol === marketSymbol);
  return {
    marketSymbol,
    marketName: positionName ? `Jupiter ${positionName.replace(/-/g, " ")}` : custodyEntry?.[1].marketName ?? "Jupiter Perps position",
    marketAddress: mint ?? custodyEntry?.[1].marketAddress ?? null,
    custodyAddress: custodyEntry?.[0] ?? null,
  };
}

function mapLiveTriggerRequest(
  trigger: LivePerpsTriggerRequest,
  position: JupiterPerpsPosition
): JupiterPerpsPendingTrigger | null {
  const triggerPrice = atomicUsdLikeToNumber(trigger.triggerPriceUsd ?? trigger.price);
  if (triggerPrice === null) return null;

  const kind = inferLiveTriggerKind(trigger, position.side, position.entryPrice, triggerPrice);
  const triggerAboveThreshold = position.entryPrice !== null ? triggerPrice >= position.entryPrice : kind === "take-profit";
  const sizeDeltaUsd = atomicUsdLikeToNumber(trigger.sizeUsdDelta);
  const collateralDelta = atomicUsdLikeToNumber(trigger.collateralUsdDelta);
  const lastUpdated = toOptionalTimestamp(trigger.updatedTime) ?? toOptionalTimestamp(trigger.createdTime) ?? position.lastUpdated;

  return {
    id: trigger.positionRequestPubkey?.trim() || `${position.id}:${kind}:${triggerPrice}:${lastUpdated ?? "na"}`,
    source: "live-api",
    platformId: JUPITER_EXCHANGE_PLATFORM,
    marketSymbol: position.marketSymbol,
    marketName: position.marketName,
    marketAddress: position.marketAddress,
    custodyAddress: position.custodyAddress,
    collateralCustodyAddress: position.collateralCustodyAddress,
    collateralSymbol: position.collateralSymbol,
    side: position.side,
    kind,
    triggerPrice,
    sizeDeltaUsd,
    collateralDelta,
    entirePosition: trigger.entirePosition ?? true,
    triggerAboveThreshold,
    executed: false,
    accountRef: trigger.positionRequestPubkey?.trim() || null,
    positionPubkey: position.accountRef,
    positionRequestPubkey: trigger.positionRequestPubkey?.trim() || null,
    lastUpdated,
  };
}

function mapLivePerpsPosition(position: LivePerpsPosition) {
  const market = resolveMarketMetadataFromLivePosition(position.positionName ?? null, position.mint ?? null);
  const entryPrice = atomicUsdLikeToNumber(position.entryPriceUsd);
  const markPrice = atomicUsdLikeToNumber(position.markPriceUsd);
  const positionValue = atomicUsdLikeToNumber(position.sizeUsd);
  const collateralValue = atomicUsdLikeToNumber(position.collateralUsd);
  const leverage =
    collateralValue !== null && collateralValue > 0 && positionValue !== null
      ? roundUsd(positionValue / collateralValue, 4)
      : null;
  const positionSize =
    positionValue !== null && entryPrice !== null && entryPrice > 0
      ? Number((positionValue / entryPrice).toFixed(4))
      : null;

  const mappedPosition: JupiterPerpsPosition = {
    id: position.positionPubkey?.trim() || `${market.marketSymbol}-${position.side ?? "long"}`,
    source: "live-api",
    platformId: JUPITER_EXCHANGE_PLATFORM,
    marketSymbol: market.marketSymbol,
    marketName: market.marketName,
    marketAddress: market.marketAddress,
    custodyAddress: market.custodyAddress,
    collateralCustodyAddress: null,
    collateralSymbol: "USDC",
    imageUri: position.imageUri ?? null,
    side: position.side === "short" ? "short" : "long",
    entryPrice,
    markPrice,
    positionSize,
    positionValue,
    collateralValue,
    leverage,
    unrealizedPnl: atomicUsdLikeToNumber(position.pnlAfterFeesUsd),
    realizedPnl: atomicUsdLikeToNumber(position.realizedPnlUsd) ?? 0,
    liquidationPrice: atomicUsdLikeToNumber(position.liquidationPriceUsd),
    fundingSnapshot: null,
    borrowSnapshot: null,
    takeProfit: null,
    stopLoss: null,
    markPriceIsLive: markPrice !== null,
    liquidationPriceIsEstimated: false,
    accountRef: position.positionPubkey?.trim() || null,
    lastUpdated: toOptionalTimestamp(position.updatedTime) ?? toOptionalTimestamp(position.createdTime),
  };

  const pendingTriggers = (position.tpslRequests ?? [])
    .map((trigger) => mapLiveTriggerRequest(trigger, mappedPosition))
    .filter((trigger): trigger is JupiterPerpsPendingTrigger => trigger !== null);

  const takeProfit = pendingTriggers.find((trigger) => trigger.kind === "take-profit")?.triggerPrice ?? null;
  const stopLoss = pendingTriggers.find((trigger) => trigger.kind === "stop-loss")?.triggerPrice ?? null;

  return {
    position: {
      ...mappedPosition,
      takeProfit,
      stopLoss,
    },
    pendingTriggers,
  };
}

function mapLivePerpsTrade(trade: LivePerpsTradeResponse): JupiterPerpsTrade {
  const market = resolveMarketMetadataFromLivePosition(trade.positionName ?? null, trade.mint ?? null);
  const createdAt = toOptionalTimestamp(trade.createdTime);
  const lastUpdated = toOptionalTimestamp(trade.updatedTime) ?? createdAt;
  const grossPnlUsd = decimalUsdToNumber(trade.pnl);
  const feeUsd = decimalUsdToNumber(trade.fee);
  const netPnlUsd =
    typeof grossPnlUsd === "number" && Number.isFinite(grossPnlUsd)
      ? grossPnlUsd - (typeof feeUsd === "number" && Number.isFinite(feeUsd) ? feeUsd : 0)
      : grossPnlUsd;

  return {
    id: trade.txHash?.trim() || `${trade.positionPubkey ?? market.marketSymbol}-${lastUpdated ?? Date.now()}`,
    source: "live-api",
    positionPubkey: trade.positionPubkey?.trim() || null,
    marketSymbol: market.marketSymbol,
    marketName: trade.positionName ? `Jupiter ${trade.positionName.replace(/-/g, " ")}` : market.marketName,
    side: trade.side === "short" ? "short" : "long",
    action: trade.action?.trim() || "Unknown",
    orderType: trade.orderType?.trim() || "Unknown",
    price: decimalUsdToNumber(trade.price),
    sizeUsd: decimalUsdToNumber(trade.size),
    collateralUsdDelta: decimalUsdToNumber(trade.collateralUsdDelta),
    feeUsd,
    pnl: netPnlUsd,
    pnlPercentage: decimalUsdToNumber(trade.pnlPercentage),
    txHash: trade.txHash?.trim() || null,
    lastUpdated,
    createdAt,
  };
}

export async function fetchJupiterPerpsTradeHistory(
  walletAddress: string,
  options: { batchSize?: number; maxTrades?: number } = {}
): Promise<JupiterPerpsTradeHistory> {
  const batchSize = Math.min(250, Math.max(10, options.batchSize ?? 100));
  const maxTrades = Math.min(10_000, Math.max(batchSize, options.maxTrades ?? 5_000));
  const trades: JupiterPerpsTrade[] = [];
  let totalCount = 0;

  let start = 0;
  while (start < maxTrades) {
    const end = Math.min(start + batchSize, maxTrades);
    const response = await fetch(
      `${JUPITER_PERPS_API_BASE}/trades?walletAddress=${encodeURIComponent(walletAddress)}&start=${start}&end=${end}`,
      {
        headers: {
          Accept: "application/json",
          "x-perps-api-version": "v2",
        },
        cache: "no-store",
      }
    );
    if (!response.ok) throw new Error(`Jupiter Perps trade history returned ${response.status}`);
    const payload = (await response.json()) as LivePerpsTradesResponse;
    const page = payload.dataList ?? [];
    const reportedCount = Number(payload.count ?? page.length);
    totalCount = Math.max(totalCount, Number.isFinite(reportedCount) && reportedCount >= 0 ? reportedCount : page.length);
    trades.push(...page.map((item) => mapLivePerpsTrade(item)));
    if (page.length === 0 || trades.length >= totalCount) break;
    start += page.length;
  }

  return {
    trades,
    totalCount,
    complete: totalCount <= trades.length,
  };
}

async function fetchLivePerpsSnapshot(walletAddress: string, includeRecentTrades = true): Promise<JupiterPerpsAccountSnapshot> {
  const positionsResponse = await fetch(
    `${JUPITER_PERPS_API_BASE}/positions?walletAddress=${encodeURIComponent(walletAddress)}&includeClosedPositions=false`,
    {
      headers: {
        Accept: "application/json",
        "x-perps-api-version": "v2",
      },
      cache: "no-store",
    }
  );

  if (!positionsResponse.ok) {
    throw new Error(`Jupiter live Perps positions returned ${positionsResponse.status}`);
  }

  const positionsPayload = (await positionsResponse.json()) as LivePerpsPositionsResponse;
  let recentTrades: JupiterPerpsTrade[] = [];

  if (includeRecentTrades) {
    try {
      const tradesResponse = await fetch(
        `${JUPITER_PERPS_API_BASE}/trades?walletAddress=${encodeURIComponent(walletAddress)}`,
        {
          headers: {
            Accept: "application/json",
            "x-perps-api-version": "v2",
          },
          cache: "no-store",
        }
      );

      if (tradesResponse.ok) {
        const tradesPayload = (await tradesResponse.json()) as LivePerpsTradesResponse;
        recentTrades = (tradesPayload.dataList ?? []).map((item) => mapLivePerpsTrade(item));
      }
    } catch {
      // Recent trade history is supplementary. Keep open-position visibility available even if the trade feed hiccups.
    }
  }

  const livePositionRecords = (positionsPayload.dataList ?? []).map((item) => mapLivePerpsPosition(item));
  const positions = livePositionRecords.map((item) => item.position);
  const pendingTriggers = livePositionRecords.flatMap((item) => item.pendingTriggers);

  return {
    positions,
    pendingTriggers,
    recentTrades,
  };
}

function decodeInstantTpslAccount(
  accountRef: string,
  bytes: Uint8Array,
  positionsByAccountRef: Map<string, JupiterPerpsPosition>
): JupiterPerpsPendingTrigger | null {
  if (bytes.length < 232 || !hasDiscriminator(bytes, INSTANT_TPSL_ACCOUNT_DISCRIMINATOR)) {
    return null;
  }

  let offset = 8;
  const owner = readPublicKey(bytes, offset);
  offset += 32;
  const pool = readPublicKey(bytes, offset);
  offset += 32;
  const custody = readPublicKey(bytes, offset);
  offset += 32;
  const positionAccount = readPublicKey(bytes, offset);
  offset += 32;
  const collateralMint = readPublicKey(bytes, offset);
  offset += 32;
  const openTime = readI64(bytes, offset);
  offset += 8;
  const updateTime = readI64(bytes, offset);
  offset += 8;
  const sizeUsdDelta = readU64(bytes, offset);
  offset += 8;
  const collateralDelta = readU64(bytes, offset);
  offset += 8;
  const requestChangeDiscriminant = bytes[offset];
  offset += 1;
  const requestTypeDiscriminant = bytes[offset];
  offset += 1;
  const sideDiscriminant = bytes[offset];
  offset += 1;

  // The live InstantCreateTpsl account uses a packed header after the enum bytes.
  // Mainnet account inspection shows the trigger price begins at byte 207.
  // We anchor to the account discriminator and shared header above, then decode
  // only the fields that have been verified against live owner-scoped accounts.
  const triggerPrice = atomicUsdToNumber(readU64(bytes, 207));
  const executionFeeOrPriorityBps = readU64(bytes, 220);
  const maxSlippageBps = readU64(bytes, 228);

  if (
    owner.equals(PublicKey.default) ||
    pool.equals(PublicKey.default) ||
    custody.equals(PublicKey.default) ||
    positionAccount.equals(PublicKey.default) ||
    collateralMint.equals(PublicKey.default) ||
    !isPlausibleUnixSeconds(openTime) ||
    !isPlausibleUnixSeconds(updateTime) ||
    sideDiscriminant === 0 ||
    !Number.isFinite(triggerPrice) ||
    triggerPrice <= 0
  ) {
    return null;
  }

  const market = JUPITER_CUSTODY_MARKETS.get(custody.toBase58());
  const linkedPosition = positionsByAccountRef.get(positionAccount.toBase58());
  const side: JupiterPerpsPositionSide = sideDiscriminant === 2 ? "short" : "long";
  const inferredSizeUsd = atomicUsdToNumber(sizeUsdDelta) || atomicUsdToNumber(executionFeeOrPriorityBps);
  const inferredCollateralDelta = atomicUsdToNumber(collateralDelta) || Number(maxSlippageBps);
  const kind = inferTriggerKindFromPrice(side, linkedPosition?.entryPrice ?? null, triggerPrice);

  return {
    id: accountRef,
    source: "rpc-direct",
    platformId: JUPITER_EXCHANGE_PLATFORM,
    marketSymbol: linkedPosition?.marketSymbol ?? market?.symbol ?? `${custody.toBase58().slice(0, 4)}...${custody.toBase58().slice(-4)}`,
    marketName: linkedPosition?.marketName ?? market?.marketName ?? "Jupiter Perps TP/SL request",
    marketAddress: linkedPosition?.marketAddress ?? market?.marketAddress ?? custody.toBase58(),
    custodyAddress: linkedPosition?.custodyAddress ?? custody.toBase58(),
    collateralCustodyAddress: linkedPosition?.collateralCustodyAddress ?? null,
    collateralSymbol: linkedPosition?.collateralSymbol ?? JUPITER_COLLATERAL_SYMBOLS.get(collateralMint.toBase58()) ?? "Unknown",
    side,
    kind,
    triggerPrice,
    sizeDeltaUsd: inferredSizeUsd > 0 ? inferredSizeUsd : null,
    collateralDelta: inferredCollateralDelta > 0 ? inferredCollateralDelta : null,
    entirePosition: linkedPosition?.positionValue !== null && inferredSizeUsd > 0
      ? Math.abs((linkedPosition?.positionValue ?? 0) - inferredSizeUsd) < 0.01
      : false,
    triggerAboveThreshold:
      linkedPosition?.entryPrice !== null ? triggerPrice >= (linkedPosition?.entryPrice ?? 0) : kind === "take-profit",
    executed: false,
    accountRef,
    positionPubkey: positionAccount.toBase58(),
    positionRequestPubkey: accountRef,
    lastUpdated: Number(updateTime || openTime) * 1000,
  };
}

function getFriendlyPortfolioErrorMessage(error: string) {
  if (/Discriminant\s+\d+\s+out of range/i.test(error) || /out of range for \d+ variants/i.test(error)) {
    return "Jupiter's legacy fallback decoder could not parse this wallet's Perps accounts right now. BremLogic will keep using the live Perps feed when it is available.";
  }

  return error;
}

function applyPendingTriggersToPositions(
  positions: JupiterPerpsPosition[],
  pendingTriggers: JupiterPerpsPendingTrigger[]
) {
  const triggersByKey = new Map<string, JupiterPerpsPendingTrigger[]>();
  for (const trigger of pendingTriggers) {
    const key = getPositionKey(trigger);
    const existing = triggersByKey.get(key) ?? [];
    existing.push(trigger);
    triggersByKey.set(key, existing);
  }

  return positions.map((position) => {
    const matches = triggersByKey.get(getPositionKey(position)) ?? [];
    let takeProfit = position.takeProfit;
    let stopLoss = position.stopLoss;

    for (const trigger of matches) {
      if (trigger.kind === "take-profit" && takeProfit === null) {
        takeProfit = trigger.triggerPrice;
      }
      if (trigger.kind === "stop-loss" && stopLoss === null) {
        stopLoss = trigger.triggerPrice;
      }
    }

    return {
      ...position,
      takeProfit,
      stopLoss,
    };
  });
}

export async function fetchJupiterPerpsAccountSnapshot(
  walletAddress: string,
  options: { includeRecentTrades?: boolean } = {}
): Promise<JupiterPerpsAccountSnapshot> {
  const rpcUrl =
    process.env.SOLANA_RPC_URL?.trim() ||
    process.env.NEXT_PUBLIC_SOLANA_RPC_URL?.trim() ||
    clusterApiUrl("mainnet-beta");

  try {
    const liveSnapshot = await fetchLivePerpsSnapshot(walletAddress, options.includeRecentTrades ?? true);
    if (liveSnapshot.positions.length > 0 || liveSnapshot.pendingTriggers.length > 0) {
      return liveSnapshot;
    }

    try {
      const directSnapshot = await fetchJupiterPerpsAccountSnapshotFromRpc(walletAddress, rpcUrl);
      return {
        ...liveSnapshot,
        positions: await enrichPositionsWithLiveMetrics(directSnapshot.positions),
        pendingTriggers: directSnapshot.pendingTriggers,
      };
    } catch {
      return liveSnapshot;
    }
  } catch {
    try {
      const directSnapshot = await fetchJupiterPerpsAccountSnapshotFromRpc(walletAddress, rpcUrl);
      return {
        positions: await enrichPositionsWithLiveMetrics(directSnapshot.positions),
        pendingTriggers: directSnapshot.pendingTriggers,
        recentTrades: [],
      };
    } catch (rpcError) {
      const message = rpcError instanceof Error ? rpcError.message : "Unable to load Jupiter Perps positions right now.";
      throw new Error(getFriendlyPortfolioErrorMessage(message));
    }
  }
}

export async function fetchJupiterPerpsPositions(walletAddress: string): Promise<JupiterPerpsPosition[]> {
  const snapshot = await fetchJupiterPerpsAccountSnapshot(walletAddress);
  return snapshot.positions;
}

export async function fetchJupiterPerpsAccountSnapshotFromRpc(walletAddress: string, rpcUrl: string): Promise<JupiterPerpsAccountSnapshot> {
  const connection = new Connection(rpcUrl, "confirmed");
  const owner = new PublicKey(walletAddress);

  // Scan all owner-scoped accounts once, then classify Position vs
  // PositionRequest by Jupiter's documented field layouts.
  const ownerScopedAccounts = await connection.getProgramAccounts(JUPITER_PERPS_PROGRAM_ID, {
    commitment: "confirmed",
    filters: [
      {
        memcmp: {
          offset: 8,
          bytes: owner.toBase58(),
        },
      },
    ],
  });

  const positions = ownerScopedAccounts
    .map(({ pubkey, account }) => {
      try {
        return decodePositionAccount(pubkey.toBase58(), account.data);
      } catch {
        return null;
      }
    })
    .filter((position): position is JupiterPerpsPosition => position !== null);

  const positionsByAccountRef = new Map(
    positions
      .filter((position) => typeof position.accountRef === "string" && position.accountRef.length > 0)
      .map((position) => [position.accountRef as string, position])
  );

  const pendingTriggers = ownerScopedAccounts
    .map(({ pubkey, account }) => {
      try {
        return (
          decodeInstantTpslAccount(pubkey.toBase58(), account.data, positionsByAccountRef) ??
          decodePositionRequestAccount(pubkey.toBase58(), account.data)
        );
      } catch {
        return null;
      }
    })
    .filter((trigger): trigger is JupiterPerpsPendingTrigger => trigger !== null);

  if (ownerScopedAccounts.length > 0 && positions.length === 0 && pendingTriggers.length === 0) {
    throw new Error("Direct Jupiter Perps account reads returned owner-scoped data, but none matched the documented Position or PositionRequest layouts.");
  }

  return {
    positions: applyPendingTriggersToPositions(positions, pendingTriggers),
    pendingTriggers,
    recentTrades: [],
  };
}

export function getMockJupiterPerpsPositions(): JupiterPerpsPosition[] {
  return [
    {
      id: "mock-sol-long",
      source: "mock",
      platformId: "jupiter-exchange",
      marketSymbol: "SOL",
      marketName: "Solana Perps",
      marketAddress: "So11111111111111111111111111111111111111112",
      custodyAddress: "7xS2gz2bTp3fwCC7knJvUWTEU9Tycczu6VhJYKgi1wdz",
      collateralCustodyAddress: "G18jKKXQwBbrHeiK3C9MRXhkHsLHf7XgCSisykV46EZa",
      collateralSymbol: "USDC",
      imageUri: null,
      side: "long",
      entryPrice: 148.2,
      markPrice: 151.74,
      positionSize: 12.5,
      positionValue: 1896.75,
      collateralValue: 420,
      leverage: 4.52,
      unrealizedPnl: 44.25,
      realizedPnl: null,
      liquidationPrice: 131.9,
      fundingSnapshot: null,
      borrowSnapshot: "Portfolio API does not expose borrow snapshots",
      takeProfit: 165,
      stopLoss: 142,
      markPriceIsLive: false,
      liquidationPriceIsEstimated: false,
      accountRef: "mock-position-sol",
      lastUpdated: Date.now() - 180000,
    },
    {
      id: "mock-btc-short",
      source: "mock",
      platformId: "jupiter-exchange",
      marketSymbol: "BTC",
      marketName: "Bitcoin Perps",
      marketAddress: "9n4nbM75f5Ui33ZbPYXn59EwSgE8CGsHtAeTH5YFeJ9E",
      custodyAddress: "5Pv3gM9JrFFH883SWAhvJC9RPYmo8UNxuFtv5bMMALkm",
      collateralCustodyAddress: "4vkNeXiYEUizLdrpdPS1eC2mccyM4NUPRtERrk6ZETkk",
      collateralSymbol: "USDT",
      imageUri: null,
      side: "short",
      entryPrice: 104250,
      markPrice: 103780,
      positionSize: 0.18,
      positionValue: 1868.04,
      collateralValue: 520,
      leverage: 3.59,
      unrealizedPnl: 84.6,
      realizedPnl: null,
      liquidationPrice: 109800,
      fundingSnapshot: null,
      borrowSnapshot: "Portfolio API does not expose borrow snapshots",
      takeProfit: 101000,
      stopLoss: 105500,
      markPriceIsLive: false,
      liquidationPriceIsEstimated: false,
      accountRef: "mock-position-btc",
      lastUpdated: Date.now() - 420000,
    },
  ];
}

export function getMockJupiterPerpsPendingTriggers(): JupiterPerpsPendingTrigger[] {
  return [
    {
      id: "mock-sol-tp",
      source: "mock",
      platformId: "jupiter-exchange",
      marketSymbol: "SOL",
      marketName: "Solana Perps",
      marketAddress: "So11111111111111111111111111111111111111112",
      custodyAddress: "7xS2gz2bTp3fwCC7knJvUWTEU9Tycczu6VhJYKgi1wdz",
      collateralCustodyAddress: "G18jKKXQwBbrHeiK3C9MRXhkHsLHf7XgCSisykV46EZa",
      collateralSymbol: "USDC",
      side: "long",
      kind: "take-profit",
      triggerPrice: 165,
      sizeDeltaUsd: 1896.75,
      collateralDelta: 0,
      entirePosition: true,
      triggerAboveThreshold: true,
      executed: false,
      accountRef: "mock-sol-tp-ref",
      positionPubkey: "mock-position-sol",
      positionRequestPubkey: "mock-sol-tp-ref",
      lastUpdated: Date.now() - 120000,
    },
    {
      id: "mock-btc-sl",
      source: "mock",
      platformId: "jupiter-exchange",
      marketSymbol: "BTC",
      marketName: "Bitcoin Perps",
      marketAddress: "9n4nbM75f5Ui33ZbPYXn59EwSgE8CGsHtAeTH5YFeJ9E",
      custodyAddress: "5Pv3gM9JrFFH883SWAhvJC9RPYmo8UNxuFtv5bMMALkm",
      collateralCustodyAddress: "4vkNeXiYEUizLdrpdPS1eC2mccyM4NUPRtERrk6ZETkk",
      collateralSymbol: "USDT",
      side: "short",
      kind: "stop-loss",
      triggerPrice: 105500,
      sizeDeltaUsd: 1868.04,
      collateralDelta: 0,
      entirePosition: false,
      triggerAboveThreshold: true,
      executed: false,
      accountRef: "mock-btc-sl-ref",
      positionPubkey: "mock-position-btc",
      positionRequestPubkey: "mock-btc-sl-ref",
      lastUpdated: Date.now() - 240000,
    },
  ];
}

export function shortenWalletAddress(address: string) {
  return `${address.slice(0, 4)}...${address.slice(-4)}`;
}
