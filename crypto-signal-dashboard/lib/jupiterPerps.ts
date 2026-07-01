"use client";

import bs58 from "bs58";
import { clusterApiUrl, Connection, PublicKey } from "@solana/web3.js";

export type JupiterPerpsPositionSide = "long" | "short";
export type JupiterPerpsPositionSource = "portfolio-api" | "mock" | "rpc-direct" | "rpc-placeholder";

export type JupiterPerpsPosition = {
  id: string;
  source: JupiterPerpsPositionSource;
  platformId: string;
  marketSymbol: string;
  marketName: string | null;
  marketAddress: string | null;
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
const POSITION_ACCOUNT_DISCRIMINATOR_B58 = bs58.encode(POSITION_ACCOUNT_DISCRIMINATOR);
const USDC_DECIMALS = 6;

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

function decodePositionAccount(accountRef: string, bytes: Uint8Array): JupiterPerpsPosition | null {
  if (bytes.length < 8 + 32 + 32 + 32 + 32 + 8 + 8 + 1 + 8 + 8 + 8 + 8 + 16 + 8 + 1) {
    throw new Error(`Jupiter Perps position account ${accountRef} is smaller than expected.`);
  }

  // This layout follows Jupiter's published Position account fields in order.
  // If Jupiter updates the on-chain struct, this decoder must be updated to match.
  const discriminator = bytes.slice(0, 8);
  if (!discriminator.every((value, index) => value === POSITION_ACCOUNT_DISCRIMINATOR[index])) {
    throw new Error(`Jupiter Perps position account ${accountRef} has an unexpected discriminator.`);
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

  if (sideDiscriminant === 0 || sizeUsd === 0n) {
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

export async function fetchJupiterPerpsPositions(walletAddress: string): Promise<JupiterPerpsPosition[]> {
  const rpcUrl = process.env.NEXT_PUBLIC_SOLANA_RPC_URL?.trim() || clusterApiUrl("mainnet-beta");

  try {
    return await fetchJupiterPerpsPositionsFromRpc(walletAddress, rpcUrl);
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
    return filteredPositions;
  }

  const filteredFailure = getFailedReport(filteredPayload);
  if (!filteredFailure?.error) {
    return [];
  }

  try {
    const fallbackPayload = await fetchPortfolio(`${JUPITER_PORTFOLIO_BASE}/positions/${walletAddress}`);
    const fallbackPositions = extractLeveragePositions(fallbackPayload);
    if (fallbackPositions.length > 0) {
      return fallbackPositions;
    }

    const fallbackFailure = getFailedReport(fallbackPayload);
    if (!fallbackFailure?.error) {
      return [];
    }
  } catch {
    // Keep the original fetcher error as the user-facing signal when the broader portfolio retry also fails.
  }

  throw new Error(getFriendlyPortfolioErrorMessage(filteredFailure.error));
}

export async function fetchJupiterPerpsPositionsFromRpc(walletAddress: string, rpcUrl: string) {
  const connection = new Connection(rpcUrl, "confirmed");
  const owner = new PublicKey(walletAddress);

  // Read Position accounts directly from the Jupiter Perps program for this wallet owner.
  // This avoids the beta Portfolio API decoder path that has been returning enum discriminant errors.
  const accounts = await connection.getProgramAccounts(JUPITER_PERPS_PROGRAM_ID, {
    commitment: "confirmed",
    filters: [
      {
        memcmp: {
          offset: 0,
          bytes: POSITION_ACCOUNT_DISCRIMINATOR_B58,
        },
      },
      {
        memcmp: {
          offset: 8,
          bytes: owner.toBase58(),
        },
      },
    ],
  });

  return accounts
    .map(({ pubkey, account }) => {
      try {
        return decodePositionAccount(pubkey.toBase58(), account.data);
      } catch {
        return null;
      }
    })
    .filter((position): position is JupiterPerpsPosition => position !== null);
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

export function shortenWalletAddress(address: string) {
  return `${address.slice(0, 4)}...${address.slice(-4)}`;
}
