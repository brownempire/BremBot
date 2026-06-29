"use client";

export type JupiterPerpsPositionSide = "long" | "short";
export type JupiterPerpsPositionSource = "portfolio-api" | "mock" | "rpc-placeholder";

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

function toFiniteNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
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
  const response = await fetch(
    `${JUPITER_PORTFOLIO_BASE}/positions/${walletAddress}?platforms=jupiter-exchange`,
    { headers: { Accept: "application/json" } }
  );

  if (!response.ok) {
    throw new Error(`Jupiter Portfolio API returned ${response.status}`);
  }

  const payload = (await response.json()) as PortfolioResponse;
  const responseDate = toFiniteNumber(payload.date);

  const failedReport = payload.fetcherReports?.find((report) => report.status === "failed");
  if (failedReport?.error) {
    throw new Error(failedReport.error);
  }

  return (payload.elements ?? [])
    .filter((element) => element.type === "leverage" && element.platformId === "jupiter-exchange")
    .flatMap((element) => {
      const isolatedPositions = (element.data?.isolated?.positions ?? []).map((position) =>
        mapLeveragePosition(position, element.platformId ?? "jupiter-exchange", responseDate, payload.tokenInfo)
      );
      const crossPositions = (element.data?.cross?.positions ?? []).map((position) =>
        mapLeveragePosition(position, element.platformId ?? "jupiter-exchange", responseDate, payload.tokenInfo)
      );
      return [...isolatedPositions, ...crossPositions];
    });
}

export async function fetchJupiterPerpsPositionsFromRpc(_walletAddress: string, _rpcUrl: string) {
  // Official Jupiter Perps docs currently mark the lower-level account docs as work in progress.
  // Keep this abstraction in place for a future RPC reader once the account parsing contract is
  // confirmed from Jupiter's published docs / IDL. Do not guess undocumented layouts here.
  return [] as JupiterPerpsPosition[];
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
