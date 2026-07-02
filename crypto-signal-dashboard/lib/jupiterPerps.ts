import { clusterApiUrl, Connection, PublicKey } from "@solana/web3.js";

export type JupiterPerpsPositionSide = "long" | "short";
export type JupiterPerpsPositionSource = "portfolio-api" | "mock" | "rpc-direct" | "rpc-placeholder";
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
  accountRef: string | null;
  lastUpdated: number | null;
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
  lastUpdated: number | null;
};

export type JupiterPerpsAccountSnapshot = {
  positions: JupiterPerpsPosition[];
  pendingTriggers: JupiterPerpsPendingTrigger[];
};

type PortfolioResponse = {
  date?: number;
  elements?: PortfolioElement[];
  fetcherReports?: Array<{ id?: string; status?: string; error?: string }>;
  tokenInfo?: {
    solana?: Record<
      string,
      {
        symbol?: string;
        name?: string;
        logoURI?: string;
      }
    >;
  };
};

type PortfolioElement = {
  type?: string;
  label?: string;
  platformId?: string;
  data?: {
    isolated?: {
      positions?: PortfolioLeveragePosition[];
      value?: number;
    };
    cross?: {
      positions?: PortfolioLeveragePosition[];
      value?: number;
      leverage?: number;
    };
    value?: number;
  };
};

type PortfolioLeveragePosition = {
  address?: string;
  name?: string;
  imageUri?: string;
  collateralValue?: number;
  side?: "long" | "short";
  entryPrice?: number;
  markPrice?: number;
  size?: number;
  sizeValue?: number;
  pnlValue?: number;
  liquidationPrice?: number;
  leverage?: number;
  tp?: number;
  sl?: number;
  value?: number;
  ref?: string;
};

const JUPITER_PORTFOLIO_BASE = "https://api.jup.ag/portfolio/v1";
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

function toFiniteNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function atomicUsdToNumber(value: bigint) {
  return Number(value) / 10 ** USDC_DECIMALS;
}

function signedAtomicUsdToNumber(value: bigint) {
  return Number(value) / 10 ** USDC_DECIMALS;
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
    lastUpdated: Number(updateTime || openTime) * 1000,
  };
}

function getFriendlyPortfolioErrorMessage(error: string) {
  if (/Discriminant\s+\d+\s+out of range/i.test(error) || /out of range for \d+ variants/i.test(error)) {
    return "Jupiter's beta Portfolio API could not decode this wallet's Perps positions right now. Live Perps data is temporarily unavailable for this wallet.";
  }

  return error;
}

function normalizeMarketSymbol(position: PortfolioLeveragePosition, tokenSymbol?: string) {
  if (tokenSymbol) return tokenSymbol;
  if (position.name) return position.name.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12) || "PERP";
  if (position.address) return `${position.address.slice(0, 4)}...${position.address.slice(-4)}`;
  return "PERP";
}

function mapLeveragePosition(
  position: PortfolioLeveragePosition,
  platformId: string,
  responseDate: number | null,
  tokenInfo: PortfolioResponse["tokenInfo"]
): JupiterPerpsPosition {
  const tokenMeta = position.address ? tokenInfo?.solana?.[position.address] : undefined;
  const marketSymbol = normalizeMarketSymbol(position, tokenMeta?.symbol);
  const marketName = position.name ?? tokenMeta?.name ?? null;
  const marketAddress = position.address ?? null;
  const accountRef = position.ref ?? null;

  return {
    id: accountRef ?? `${platformId}-${marketAddress ?? marketSymbol}-${position.side ?? "long"}`,
    source: "portfolio-api",
    platformId,
    marketSymbol,
    marketName,
    marketAddress,
    custodyAddress: null,
    collateralCustodyAddress: null,
    collateralSymbol: null,
    imageUri: position.imageUri ?? tokenMeta?.logoURI ?? null,
    side: position.side === "short" ? "short" : "long",
    entryPrice: toFiniteNumber(position.entryPrice),
    markPrice: toFiniteNumber(position.markPrice),
    positionSize: toFiniteNumber(position.size),
    positionValue: toFiniteNumber(position.sizeValue ?? position.value),
    collateralValue: toFiniteNumber(position.collateralValue),
    leverage: toFiniteNumber(position.leverage),
    unrealizedPnl: toFiniteNumber(position.pnlValue),
    realizedPnl: null,
    liquidationPrice: toFiniteNumber(position.liquidationPrice),
    fundingSnapshot: null,
    borrowSnapshot: null,
    takeProfit: toFiniteNumber(position.tp),
    stopLoss: toFiniteNumber(position.sl),
    accountRef,
    lastUpdated: responseDate,
  };
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

export async function fetchJupiterPerpsAccountSnapshot(walletAddress: string): Promise<JupiterPerpsAccountSnapshot> {
  const rpcUrl =
    process.env.SOLANA_RPC_URL?.trim() ||
    process.env.NEXT_PUBLIC_SOLANA_RPC_URL?.trim() ||
    clusterApiUrl("mainnet-beta");

  try {
    return await fetchJupiterPerpsAccountSnapshotFromRpc(walletAddress, rpcUrl);
  } catch {
    // Fall back to Jupiter's Portfolio API if the direct reader cannot complete successfully.
  }

  async function fetchPortfolio(url: string) {
    const response = await fetch(url, { headers: { Accept: "application/json" } });

    if (!response.ok) {
      throw new Error(`Jupiter Portfolio API returned ${response.status}`);
    }

    return (await response.json()) as PortfolioResponse;
  }

  function extractLeveragePositions(payload: PortfolioResponse) {
    const responseDate = toFiniteNumber(payload.date);
    return (payload.elements ?? [])
      .filter((element) => element.type === "leverage" && element.platformId === JUPITER_EXCHANGE_PLATFORM)
      .flatMap((element) => {
        const isolatedPositions = (element.data?.isolated?.positions ?? []).map((position) =>
          mapLeveragePosition(position, element.platformId ?? JUPITER_EXCHANGE_PLATFORM, responseDate, payload.tokenInfo)
        );
        const crossPositions = (element.data?.cross?.positions ?? []).map((position) =>
          mapLeveragePosition(position, element.platformId ?? JUPITER_EXCHANGE_PLATFORM, responseDate, payload.tokenInfo)
        );
        return [...isolatedPositions, ...crossPositions];
      });
  }

  function getFailedReport(payload: PortfolioResponse) {
    return payload.fetcherReports?.find((report) => report.status === "failed" && report.id === JUPITER_EXCHANGE_PLATFORM)
      ?? payload.fetcherReports?.find((report) => report.status === "failed");
  }

  const filteredPayload = await fetchPortfolio(
    `${JUPITER_PORTFOLIO_BASE}/positions/${walletAddress}?platforms=${JUPITER_EXCHANGE_PLATFORM}`
  );

  const filteredPositions = extractLeveragePositions(filteredPayload);
  if (filteredPositions.length > 0) {
    return {
      positions: filteredPositions,
      pendingTriggers: [],
    };
  }

  const filteredFailure = getFailedReport(filteredPayload);
  if (!filteredFailure?.error) {
    return {
      positions: [],
      pendingTriggers: [],
    };
  }

  try {
    const fallbackPayload = await fetchPortfolio(`${JUPITER_PORTFOLIO_BASE}/positions/${walletAddress}`);
    const fallbackPositions = extractLeveragePositions(fallbackPayload);
    if (fallbackPositions.length > 0) {
      return {
        positions: fallbackPositions,
        pendingTriggers: [],
      };
    }

    const fallbackFailure = getFailedReport(fallbackPayload);
    if (!fallbackFailure?.error) {
      return {
        positions: [],
        pendingTriggers: [],
      };
    }
  } catch {
    // Keep the original fetcher error as the user-facing signal when the broader portfolio retry also fails.
  }

  throw new Error(getFriendlyPortfolioErrorMessage(filteredFailure.error));
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
      lastUpdated: Date.now() - 240000,
    },
  ];
}

export function shortenWalletAddress(address: string) {
  return `${address.slice(0, 4)}...${address.slice(-4)}`;
}
