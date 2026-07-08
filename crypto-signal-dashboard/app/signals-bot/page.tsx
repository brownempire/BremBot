"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Capacitor } from "@capacitor/core";
import { LocalNotifications } from "@capacitor/local-notifications";
import { PushNotifications } from "@capacitor/push-notifications";
import Image from "next/image";
import dynamic from "next/dynamic";
import bs58 from "bs58";
import { PublicKey } from "@solana/web3.js";
import { useConnection, useWallet } from "@/app/components/SolanaWalletProvider";

import { JupiterTradePanel, type JupiterTradeRecord } from "@/app/components/JupiterTradePanel";
import { SolanaWalletProvider } from "@/app/components/SolanaWalletProvider";
import type {
  JupiterPerpsWidgetController,
  JupiterPerpsWidgetSnapshot,
} from "@/app/components/JupiterPerpsPositionWidget";
import { TradingViewChart } from "@/app/components/TradingViewChart";
import { createSimulatedFeed } from "@/lib/price/simulated";
import type { PricePoint } from "@/lib/price/simulated";
import { detectSignals, type Signal, type UserParams } from "@/lib/signal/engine";
import { formatUsd } from "@/lib/utils";

const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN_2022_PROGRAM_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const ETH_MINT = "7vfCXTUXx5WQXj6Yf8sTG6iM6Aq98J4A4P8M7P8yWfYw";
const BTC_MINT = "9n4nbM75f5Ui33ZbPYXn59EwSgE8CGsHtAeTH5YFeJ9E";
const PARAMS_STORAGE_KEY = "brembot.signal-params.v1";
const AUTO_TRADE_SETTINGS_STORAGE_KEY = "brembot.auto-trade-settings.v1";
const REMOTE_AUTH_TOKEN_STORAGE_KEY = "brembot.remote-trades-auth.v2";
const NATIVE_ALERTS_ENABLED_STORAGE_KEY = "brembot.native-alerts-enabled.v1";
const DEFAULT_WALLET_PASSWORD = "bremlogic";
const LOCAL_RECENT_TRADES_CAP = 20;
const NATIVE_NOTIFICATION_SOUNDS = {
  appOpen: "brem_open.wav",
  signal: "brem_signal.wav",
  approval: "brem_approval.wav",
  tp: "brem_tp.wav",
  sl: "brem_sl.wav",
} as const;

type NativeNotificationSound = (typeof NATIVE_NOTIFICATION_SOUNDS)[keyof typeof NATIVE_NOTIFICATION_SOUNDS];

type TrackedMarket = {
  id: string;
  pair: string;
  coinbaseProduct: string;
  tvSymbol: string;
};

type MarketOption = {
  pair: string;
  coinbaseProduct: string;
  tvSymbol: string;
};

const DEFAULT_TRACKED_MARKETS: TrackedMarket[] = [
  { id: "slot-sol", pair: "SOL/USD", coinbaseProduct: "SOL-USD", tvSymbol: "COINBASE:SOLUSD" },
  { id: "slot-eth", pair: "ETH/USD", coinbaseProduct: "ETH-USD", tvSymbol: "COINBASE:ETHUSD" },
  { id: "slot-btc", pair: "BTC/USD", coinbaseProduct: "BTC-USD", tvSymbol: "COINBASE:BTCUSD" },
];

const JupiterPerpsPositionWidget = dynamic(
  () => import("@/app/components/JupiterPerpsPositionWidget").then((mod) => mod.JupiterPerpsPositionWidget),
  { ssr: false }
);

const DEFAULT_PARAMS: UserParams = {
  trendWindow: 5,
  trendThreshold: 0.5,
  breakoutPercent: 0.8,
  cooldownSeconds: 60,
};

type SignalsAppTab = "signals" | "perps" | "wallet";

type AutoTradeToken = "SOL" | "ETH" | "BTC" | "USDC" | "JUP" | "BONK";

type AutoTradeTokenOption = {
  symbol: AutoTradeToken;
  label: string;
  mint: string;
};

type AutoTradeMode = "all" | "buy-only";
type PerpsExecutionMode = "set-parameters" | "smart-trades";
type SmartTradeProfile = "conservative" | "balanced" | "aggressive";

const AUTO_TRADE_TOKEN_OPTIONS: AutoTradeTokenOption[] = [
  { symbol: "SOL", label: "Solana (SOL)", mint: SOL_MINT },
  { symbol: "ETH", label: "Ethereum (ETH)", mint: ETH_MINT },
  { symbol: "BTC", label: "Bitcoin (BTC)", mint: BTC_MINT },
  { symbol: "USDC", label: "USDC", mint: USDC_MINT },
  { symbol: "JUP", label: "Jupiter (JUP)", mint: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN" },
  { symbol: "BONK", label: "Bonk (BONK)", mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263" },
];

type AutoTradeSlot = {
  id: string;
  token: AutoTradeToken;
};

type AutoTradeSettings = {
  walletPercent: number;
  takeProfitPercent: number;
  stopLossPercent: number;
  perpsLeverage: number;
  perpsExecutionMode: PerpsExecutionMode;
  smartTradeProfile: SmartTradeProfile;
  slots: AutoTradeSlot[];
  activeSlotId: string | null;
  perpsActiveSlotId: string | null;
  mode: AutoTradeMode;
  disableTpLock: boolean;
};

const DEFAULT_AUTO_TRADE_SETTINGS: AutoTradeSettings = {
  walletPercent: 25,
  takeProfitPercent: 0,
  stopLossPercent: 0,
  perpsLeverage: 10,
  perpsExecutionMode: "set-parameters",
  smartTradeProfile: "balanced",
  slots: [
    { id: "auto-slot-1", token: "SOL" },
    { id: "auto-slot-2", token: "ETH" },
    { id: "auto-slot-3", token: "BTC" },
  ],
  activeSlotId: null,
  perpsActiveSlotId: null,
  mode: "all",
  disableTpLock: false,
};

const PERPS_AUTO_TRADE_APPROVAL_TIMEOUT_MS = 60_000;
const AUTO_TRADE_ERROR_AUTO_RESET_MS = 20_000;
const ACTIVE_APPROVAL_TIMEOUT_MS = 20_000;

type WalletTokenHolding = {
  mint: string;
  amount: number;
  symbol?: string;
  name?: string;
  logoURI?: string | null;
  usdPrice?: number | null;
  usdValue?: number | null;
};

type StoredTradeRecord = {
  txid: string;
  timestamp: number;
  walletAddress?: string;
  inputMint?: string;
  outputMint?: string;
  inputAmount?: number;
  outputAmount?: number;
  id: string;
  source?: "manual" | "auto";
  signalId?: string;
  signalSummary?: string;
  symbol?: string;
  entryPrice?: number;
  takeProfitPrice?: number | null;
  tradeDirection?: "buy" | "sell";
  gasless?: boolean;
};

type PnlRange = "24h" | "7d" | "30d" | "ytd";
type WalletPnlPoint = { t: number; v: number };
type PnlMode = "app" | "chain";
type RemoteAuthSource = "in-app" | "phantom";
type DashboardSectionId = "chart" | "wallet" | "perps" | "pnl" | "params" | "signals" | "trades";
type DashboardSectionLayout = {
  id: DashboardSectionId;
  width: number;
  height: number;
};
type PendingTakeProfit = {
  id: string;
  symbol: string;
  tokenSymbol: string;
  tokenMint: string;
  amount: number;
  entryPrice: number;
  targetPrice: number;
  signalId: string;
  createdAt: number;
};

type PendingPerpsApprovalRequest = {
  asset: "BTC" | "ETH" | "SOL";
  collateralToken: "BTC" | "ETH" | "SOL" | "USDC";
  leverage: string;
  maxSlippageBps?: string;
  side: "long" | "short";
  stopLossPrice?: number | null;
  takeProfitPrice?: number | null;
  uiAmount: number;
};

type StoredPerpsApproval = {
  id: string;
  walletAddress: string;
  signalId: string;
  signalSummary: string;
  symbol: string;
  status: "pending" | "opened" | "failed" | "cancelled";
  createdAt: number;
  updatedAt: number;
  request: PendingPerpsApprovalRequest;
  openedTxid?: string | null;
  failureReason?: string | null;
};

type SmartPerpsTradePlan = {
  collateralPercent: number;
  leverage: number;
  stopLossPercent: number;
  takeProfitPercent: number;
  volatilityPercent: number;
};

type RemoteAuthChallenge = {
  address: string;
  challengeId: string;
  message: string;
  expiresInSeconds: number;
  expiresAt: string;
};

type StepperNumberInputProps = {
  value: number;
  min?: number;
  max?: number;
  step?: number;
  inputMode?: "decimal" | "numeric";
  onChange: (value: number) => void;
};

function countStepDecimals(step: number) {
  const raw = step.toString();
  if (!raw.includes(".")) return 0;
  return raw.split(".")[1]?.length ?? 0;
}

function clampToRange(value: number, min?: number, max?: number) {
  if (typeof min === "number") value = Math.max(min, value);
  if (typeof max === "number") value = Math.min(max, value);
  return value;
}

function normalizeStepValue(value: number, step: number, min?: number, max?: number) {
  const decimals = countStepDecimals(step);
  return Number(clampToRange(value, min, max).toFixed(decimals));
}

function StepperNumberInput({
  value,
  min,
  max,
  step = 1,
  inputMode = "decimal",
  onChange,
}: StepperNumberInputProps) {
  const applyValue = (next: number) => {
    if (!Number.isFinite(next)) return;
    onChange(normalizeStepValue(next, step, min, max));
  };

  return (
    <div className="stepper-input">
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        inputMode={inputMode}
        onChange={(event) => {
          const next = Number(event.target.value);
          if (!Number.isFinite(next)) return;
          applyValue(next);
        }}
      />
      <div className="stepper-input-buttons">
        <button type="button" aria-label="Increase value" onClick={() => applyValue(value + step)}>▲</button>
        <button type="button" aria-label="Decrease value" onClick={() => applyValue(value - step)}>▼</button>
      </div>
    </div>
  );
}

type PhantomAuthProvider = {
  isPhantom?: boolean;
  publicKey?: PublicKey | { toBase58: () => string } | null;
  isConnected?: boolean;
  connect: (options?: Record<string, unknown>) => Promise<{ publicKey?: PublicKey | { toBase58: () => string } } | void>;
  disconnect?: () => Promise<void>;
  signMessage: (
    message: Uint8Array,
    display?: "utf8" | "hex"
  ) => Promise<{ signature?: Uint8Array } | Uint8Array>;
};

function urlBase64ToUint8Array(base64String: string) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((char) => char.charCodeAt(0)));
}

function shortAddress(address: string) {
  return `${address.slice(0, 4)}...${address.slice(-4)}`;
}

function deriveFeeAdjustedPerpsTriggers(options: {
  desiredStopLossPercent: number;
  desiredTakeProfitPercent: number;
  fallbackEntryPrice: number;
  preview: {
    pool: {
      openFeePercent: number | null;
    };
    quote: {
      averagePriceUsd: number | null;
      openFeeUsd: number | null;
      outstandingBorrowFeeUsd: number | null;
      positionSizeUsd: number | null;
      priceImpactFeeUsd: number | null;
    };
    side: "long" | "short";
  };
}) {
  const desiredTakeProfitFraction = options.desiredTakeProfitPercent > 0 ? options.desiredTakeProfitPercent / 100 : 0;
  const desiredStopLossFraction = options.desiredStopLossPercent > 0 ? options.desiredStopLossPercent / 100 : 0;
  const entryPrice =
    typeof options.preview.quote.averagePriceUsd === "number" && Number.isFinite(options.preview.quote.averagePriceUsd) && options.preview.quote.averagePriceUsd > 0
      ? options.preview.quote.averagePriceUsd
      : options.fallbackEntryPrice;
  const positionSizeUsd = options.preview.quote.positionSizeUsd;
  const openFeeUsd = options.preview.quote.openFeeUsd ?? 0;
  const priceImpactFeeUsd = options.preview.quote.priceImpactFeeUsd ?? 0;
  const outstandingBorrowFeeUsd = options.preview.quote.outstandingBorrowFeeUsd ?? 0;
  const openFeePercent = options.preview.pool.openFeePercent;
  const estimatedCloseFeeUsd =
    typeof positionSizeUsd === "number" &&
    Number.isFinite(positionSizeUsd) &&
    positionSizeUsd > 0 &&
    typeof openFeePercent === "number" &&
    Number.isFinite(openFeePercent) &&
    openFeePercent > 0
      ? positionSizeUsd * (openFeePercent / 100)
      : openFeeUsd;
  const estimatedRoundTripFeesUsd = openFeeUsd + priceImpactFeeUsd + outstandingBorrowFeeUsd + estimatedCloseFeeUsd;
  const feeMoveFraction =
    typeof positionSizeUsd === "number" && Number.isFinite(positionSizeUsd) && positionSizeUsd > 0
      ? estimatedRoundTripFeesUsd / positionSizeUsd
      : 0;

  const takeProfitMoveFraction = desiredTakeProfitFraction > 0 ? desiredTakeProfitFraction + feeMoveFraction : 0;
  const stopLossMoveFraction = desiredStopLossFraction > 0 ? Math.max(0, desiredStopLossFraction - feeMoveFraction) : 0;

  const takeProfitPrice =
    takeProfitMoveFraction > 0
      ? options.preview.side === "long"
        ? entryPrice * (1 + takeProfitMoveFraction)
        : entryPrice * (1 - takeProfitMoveFraction)
      : null;
  const stopLossPrice =
    stopLossMoveFraction > 0 || desiredStopLossFraction > 0
      ? options.preview.side === "long"
        ? entryPrice * (1 - stopLossMoveFraction)
        : entryPrice * (1 + stopLossMoveFraction)
      : null;

  return {
    entryPrice,
    estimatedRoundTripFeesUsd,
    stopLossPrice: typeof stopLossPrice === "number" && Number.isFinite(stopLossPrice) ? stopLossPrice : null,
    takeProfitPrice: typeof takeProfitPrice === "number" && Number.isFinite(takeProfitPrice) ? takeProfitPrice : null,
  };
}

function clampNumber(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function computeRecentVolatilityPercent(points: PricePoint[]) {
  const valid = points.filter((point) => Number.isFinite(point.v) && point.v > 0);
  if (valid.length < 2) return 0;
  const recent = valid.slice(-Math.min(60, valid.length));
  const values = recent.map((point) => point.v);
  const high = Math.max(...values);
  const low = Math.min(...values);
  const last = recent[recent.length - 1]?.v ?? high;
  if (!Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(last) || last <= 0) return 0;
  return ((high - low) / last) * 100;
}

function deriveSmartPerpsTradePlan(options: {
  points: PricePoint[];
  settings: AutoTradeSettings;
  signal: Signal;
}): SmartPerpsTradePlan {
  const volatilityPercent = computeRecentVolatilityPercent(options.points);
  const volatilityFactor = clampNumber(volatilityPercent / 2.5, 0, 1.35);
  const confidenceBias = clampNumber((options.signal.confidence - 0.55) / 0.35, -0.5, 1);
  const profile = options.settings.smartTradeProfile;

  const profileSettings: Record<SmartTradeProfile, {
    collateralBase: number;
    leverageBase: number;
    defaultTp: number;
    defaultSl: number;
    leverageCapMultiplier: number;
  }> = {
    conservative: {
      collateralBase: 0.4,
      leverageBase: 0.3,
      defaultTp: 0.9,
      defaultSl: 1.5,
      leverageCapMultiplier: 0.45,
    },
    balanced: {
      collateralBase: 0.65,
      leverageBase: 0.5,
      defaultTp: 1.5,
      defaultSl: 3.5,
      leverageCapMultiplier: 0.65,
    },
    aggressive: {
      collateralBase: 0.8,
      leverageBase: 1.35,
      defaultTp: 3,
      defaultSl: 7,
      leverageCapMultiplier: 2,
    },
  };

  const profileConfig = profileSettings[profile];
  const collateralPercent = clampNumber(
    options.settings.walletPercent * (profileConfig.collateralBase + confidenceBias * 0.18 - volatilityFactor * 0.16),
    5,
    100
  );
  const leverage = clampNumber(
    options.settings.perpsLeverage * (profileConfig.leverageBase + confidenceBias * 0.12 - volatilityFactor * 0.14),
    1,
    Math.min(250, Math.max(1, options.settings.perpsLeverage * profileConfig.leverageCapMultiplier))
  );
  const baseTp = options.settings.takeProfitPercent > 0 ? options.settings.takeProfitPercent : profileConfig.defaultTp;
  const baseSl = options.settings.stopLossPercent > 0 ? options.settings.stopLossPercent : profileConfig.defaultSl;
  const takeProfitPercent = clampNumber(
    baseTp * (1 + volatilityFactor * 0.28 + confidenceBias * 0.08),
    0.2,
    6
  );
  const stopLossPercent = clampNumber(
    baseSl * (1 + volatilityFactor * 0.18 - confidenceBias * 0.06),
    0.2,
    5
  );

  return {
    collateralPercent: Number(collateralPercent.toFixed(0)),
    leverage: Number(leverage.toFixed(2)),
    stopLossPercent: Number(stopLossPercent.toFixed(2)),
    takeProfitPercent: Number(takeProfitPercent.toFixed(2)),
    volatilityPercent: Number(volatilityPercent.toFixed(2)),
  };
}

function formatFeedSource(status: string) {
  const map: Record<string, string> = {
    loading: "loading",
    offline: "offline",
    simulated: "Simulated",
    chaos_edge: "Chaos Edge",
    coinbase: "Coinbase",
    coingecko: "CoinGecko",
  };
  return map[status] ?? status;
}

function tradesStorageKey(walletAddress: string) {
  return `brembot.recent-trades.${walletAddress}`;
}

function remoteTradesAuthStorageKey(walletAddress: string) {
  return `${REMOTE_AUTH_TOKEN_STORAGE_KEY}.${walletAddress}`;
}

function isNativeShellApp() {
  return typeof window !== "undefined" && Capacitor.isNativePlatform();
}

function readNativeAlertsEnabled() {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(NATIVE_ALERTS_ENABLED_STORAGE_KEY) === "true";
}

function writeNativeAlertsEnabled(enabled: boolean) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(NATIVE_ALERTS_ENABLED_STORAGE_KEY, enabled ? "true" : "false");
}

function getNativePushPluginStatus() {
  return {
    hasLocalNotifications: Capacitor.isPluginAvailable("LocalNotifications"),
    hasPushNotifications: Capacitor.isPluginAvailable("PushNotifications"),
  };
}

function navigateToNotificationUrl(url: string) {
  if (typeof window === "undefined" || !url) return;
  if (/^https?:\/\//i.test(url)) {
    window.location.assign(url);
    return;
  }
  window.location.assign(url.startsWith("/") ? url : `/${url}`);
}

function getPhantomAuthProvider(): PhantomAuthProvider | null {
  if (typeof window === "undefined") return null;
  const candidate =
    (window as typeof window & { phantom?: { solana?: PhantomAuthProvider }; solana?: PhantomAuthProvider }).phantom
      ?.solana
      ?? (window as typeof window & { solana?: PhantomAuthProvider }).solana;
  if (!candidate?.isPhantom || typeof candidate.connect !== "function" || typeof candidate.signMessage !== "function") {
    return null;
  }
  return candidate;
}

function extractPhantomPublicKey(provider: PhantomAuthProvider) {
  const key = provider.publicKey;
  if (!key) return null;
  return typeof key.toBase58 === "function" ? key.toBase58() : null;
}

const DASHBOARD_LAYOUT_STORAGE_KEY = "brembot.dashboard.layout.v1";
const DEFAULT_DASHBOARD_LAYOUT: DashboardSectionLayout[] = [
  { id: "chart", width: 1080, height: 640 },
  { id: "wallet", width: 1080, height: 520 },
  { id: "perps", width: 1080, height: 620 },
  { id: "pnl", width: 1080, height: 460 },
  { id: "params", width: 1080, height: 500 },
  { id: "signals", width: 1080, height: 430 },
  { id: "trades", width: 1080, height: 500 },
];

const DASHBOARD_SECTION_TITLES: Record<DashboardSectionId, string> = {
  chart: "TradingView Chart",
  wallet: "In-App Wallet",
  perps: "Jupiter Perps",
  pnl: "PnL",
  params: "Signal Parameters",
  signals: "Live Signals",
  trades: "Recent Trades",
};

function getAutoTradeTokenOption(symbol: AutoTradeToken) {
  return AUTO_TRADE_TOKEN_OPTIONS.find((option) => option.symbol === symbol) ?? AUTO_TRADE_TOKEN_OPTIONS[0];
}

function normalizeMarketGuideKey(value: string | null | undefined) {
  const raw = value?.trim().toUpperCase() ?? "";
  if (!raw) return null;
  if (raw.includes("SOL")) return "SOL";
  if (raw.includes("ETH")) return "ETH";
  if (raw.includes("BTC")) return "BTC";
  return null;
}

function isSupportedPerpsAutoTradeToken(symbol: AutoTradeToken): symbol is "SOL" | "ETH" | "BTC" {
  return symbol === "SOL" || symbol === "ETH" || symbol === "BTC";
}

function isPerpsBuildFailureMessage(message: string) {
  const normalized = message.trim().toLowerCase();
  return (
    normalized.includes("could not build the order") ||
    normalized.includes("unable to build the jupiter perps order") ||
    normalized.includes("internal server error") ||
    normalized.includes("jupiter support")
  );
}

const PNL_DEFAULT_MINT = SOL_MINT;
const KNOWN_TOKEN_BY_MINT: Record<string, string> = {
  [SOL_MINT]: "SOL",
  [USDC_MINT]: "USDC",
  [ETH_MINT]: "ETH",
  [BTC_MINT]: "BTC",
  JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN: "JUP",
  DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263: "BONK",
};

function DashboardPage() {
  const { connection } = useConnection();
  const wallet = useWallet();
  const walletAddress = wallet.publicKey?.toBase58() ?? null;
  const walletExecuteSwap = wallet.executeSwap;
  const walletPublicKey = wallet.publicKey;
  const walletSignMessage = wallet.signMessage;

  const [trackedMarkets, setTrackedMarkets] = useState<TrackedMarket[]>(DEFAULT_TRACKED_MARKETS);
  const [priceHistory, setPriceHistory] = useState<Record<string, PricePoint[]>>({});
  const [dayChange24h, setDayChange24h] = useState<Record<string, number>>({});
  const [params, setParams] = useState<UserParams>(DEFAULT_PARAMS);
  const [paramsSaveStatus, setParamsSaveStatus] = useState("Using defaults");
  const [signals, setSignals] = useState<Signal[]>([]);
  const [lastSignalAt, setLastSignalAt] = useState<Record<string, number>>({});
  const [selectedChartSlotId, setSelectedChartSlotId] = useState<string>(DEFAULT_TRACKED_MARKETS[0].id);
  const [receiveSignalsForSlotId, setReceiveSignalsForSlotId] = useState<string>(DEFAULT_TRACKED_MARKETS[0].id);
  const [priceFeedStatus, setPriceFeedStatus] = useState("loading");
  const [marketOptions, setMarketOptions] = useState<MarketOption[]>(DEFAULT_TRACKED_MARKETS);
  const [editingSignalTarget, setEditingSignalTarget] = useState(false);

  const [pushStatus, setPushStatus] = useState("Push not enabled");
  const [pushReady, setPushReady] = useState(false);
  const [pushEnabled, setPushEnabled] = useState(false);
  const [subscription, setSubscription] = useState<PushSubscriptionJSON | null>(null);
  const [nativePushToken, setNativePushToken] = useState<string | null>(null);
  const [nativePushIssue, setNativePushIssue] = useState<string | null>(null);
  const [activeApprovalId, setActiveApprovalId] = useState<string | null>(null);
  const [activeApprovalStatus, setActiveApprovalStatus] = useState<string | null>(null);

  const [solBalance, setSolBalance] = useState<number | null>(null);
  const [walletTokens, setWalletTokens] = useState<WalletTokenHolding[]>([]);
  const [totalBalanceUsd, setTotalBalanceUsd] = useState<number | null>(null);
  const [solValueUsd, setSolValueUsd] = useState<number | null>(null);
  const [portfolioStatus, setPortfolioStatus] = useState("Wallet not connected");
  const [recentTrades, setRecentTrades] = useState<StoredTradeRecord[]>([]);
  const [autoTradeStatus, setAutoTradeStatus] = useState("Auto-trade is off");
  const [perpsAutoTradeStatus, setPerpsAutoTradeStatus] = useState("Perps auto-trade is off");
  const [autoTradeSettings, setAutoTradeSettings] = useState<AutoTradeSettings>(DEFAULT_AUTO_TRADE_SETTINGS);
  const [pendingTakeProfit, setPendingTakeProfit] = useState<PendingTakeProfit | null>(null);
  const [readOnlyPerpsSnapshot, setReadOnlyPerpsSnapshot] = useState<JupiterPerpsWidgetSnapshot>({
    walletAddress: null,
    positions: [],
    pendingTriggers: [],
    recentTrades: [],
    isLoading: false,
    error: null,
    isMock: false,
    connected: false,
  });
  const [jupiterPerpsController, setJupiterPerpsController] = useState<JupiterPerpsWidgetController | null>(null);
  const [showAutoTradeSelectorWarning, setShowAutoTradeSelectorWarning] = useState(false);
  const [showDepositModal, setShowDepositModal] = useState(false);
  const [pnlRange, setPnlRange] = useState<PnlRange>("24h");
  const [pnlMode, setPnlMode] = useState<PnlMode>("app");
  const [pnlTokenMint, setPnlTokenMint] = useState<string>(PNL_DEFAULT_MINT);
  const [pnlStatus, setPnlStatus] = useState("PnL tracking recent trades");
  const [remoteAuthSource, setRemoteAuthSource] = useState<RemoteAuthSource | null>(null);
  const [remoteAuthStatus, setRemoteAuthStatus] = useState("Remote auth pending");
  const [remoteSyncStatus, setRemoteSyncStatus] = useState("Remote sync idle");
  const [remoteAuthToken, setRemoteAuthToken] = useState<string | null>(null);
  const [remoteAuthAddress, setRemoteAuthAddress] = useState<string | null>(null);
  const [phantomAuthAddress, setPhantomAuthAddress] = useState<string | null>(null);
  const [remotePnlPoints, setRemotePnlPoints] = useState<WalletPnlPoint[]>([{ t: Date.now(), v: 0 }]);
  const [dashboardLayout, setDashboardLayout] = useState<DashboardSectionLayout[]>(DEFAULT_DASHBOARD_LAYOUT);
  const [dragSectionId, setDragSectionId] = useState<DashboardSectionId | null>(null);
  const resizeStateRef = useRef<{
    id: DashboardSectionId;
    startX: number;
    startY: number;
    startWidth: number;
    startHeight: number;
  } | null>(null);
  const autoTradeBusyRef = useRef(false);
  const perpsAutoTradeBusyRef = useRef(false);
  const pendingTakeProfitRef = useRef<PendingTakeProfit | null>(null);
  const readOnlyPerpsSnapshotRef = useRef<JupiterPerpsWidgetSnapshot>({
    walletAddress: null,
    positions: [],
    pendingTriggers: [],
    recentTrades: [],
    isLoading: false,
    error: null,
    isMock: false,
    connected: false,
  });
  const lastTpAttemptAtRef = useRef(0);
  const perpsAutoTradeAttemptIdRef = useRef(0);
  const perpsAutoTradeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const perpsAutoTradeErrorResetTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const perpsAutoTradeFailureCooldownUntilRef = useRef(0);
  const wakeLockRef = useRef<{ release?: () => Promise<void> } | null>(null);
  const approvalConnectStartedRef = useRef<string | null>(null);
  const approvalExecutionStartedRef = useRef<string | null>(null);
  const activeApprovalTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeAutoTradeSlot = useMemo(
    () => autoTradeSettings.slots.find((slot) => slot.id === autoTradeSettings.activeSlotId) ?? null,
    [autoTradeSettings.activeSlotId, autoTradeSettings.slots]
  );
  const activePerpsAutoTradeSlot = useMemo(
    () => autoTradeSettings.slots.find((slot) => slot.id === autoTradeSettings.perpsActiveSlotId) ?? null,
    [autoTradeSettings.perpsActiveSlotId, autoTradeSettings.slots]
  );
  const activeAutoTradeToken = activeAutoTradeSlot ? getAutoTradeTokenOption(activeAutoTradeSlot.token) : null;
  const activePerpsAutoTradeToken = activePerpsAutoTradeSlot ? getAutoTradeTokenOption(activePerpsAutoTradeSlot.token) : null;
  const autoTradeEnabled = Boolean(activeAutoTradeToken);
  const perpsAutoTradeEnabled = Boolean(activePerpsAutoTradeToken);
  const remoteSyncWalletAddress =
    remoteAuthSource === "phantom"
      ? phantomAuthAddress
      : remoteAuthSource === "in-app"
        ? walletAddress
        : null;
  const tradeStorageAddress =
    remoteAuthSource === "phantom"
      ? phantomAuthAddress ?? walletAddress ?? "paper-auto"
      : walletAddress ?? "paper-auto";
  const nativeShell = isNativeShellApp();
  const [activeSignalsTab, setActiveSignalsTab] = useState<SignalsAppTab>("signals");

  useEffect(() => {
    const syncActiveTab = () => {
      if (typeof window === "undefined") return;
      const tab = new URLSearchParams(window.location.search).get("tab");
      if (tab === "perps" || tab === "wallet") {
        setActiveSignalsTab(tab);
        return;
      }
      setActiveSignalsTab("signals");
    };

    syncActiveTab();
    window.addEventListener("popstate", syncActiveTab);
    return () => window.removeEventListener("popstate", syncActiveTab);
  }, []);

  const clearPerpsAutoTradeTimeout = useCallback(() => {
    if (perpsAutoTradeTimeoutRef.current) {
      clearTimeout(perpsAutoTradeTimeoutRef.current);
      perpsAutoTradeTimeoutRef.current = null;
    }
  }, []);

  const clearPerpsAutoTradeErrorResetTimeout = useCallback(() => {
    if (perpsAutoTradeErrorResetTimeoutRef.current) {
      clearTimeout(perpsAutoTradeErrorResetTimeoutRef.current);
      perpsAutoTradeErrorResetTimeoutRef.current = null;
    }
  }, []);

  const clearPerpsAutoTradeFailureCooldown = useCallback(() => {
    perpsAutoTradeFailureCooldownUntilRef.current = 0;
    clearPerpsAutoTradeErrorResetTimeout();
  }, [clearPerpsAutoTradeErrorResetTimeout]);

  const isPerpsAutoTradeFailureCooldownActive = useCallback(() => {
    return perpsAutoTradeFailureCooldownUntilRef.current > Date.now();
  }, []);

  const clearActiveApprovalTimeout = useCallback(() => {
    if (activeApprovalTimeoutRef.current) {
      clearTimeout(activeApprovalTimeoutRef.current);
      activeApprovalTimeoutRef.current = null;
    }
  }, []);

  const clearActiveApprovalState = useCallback(() => {
    clearActiveApprovalTimeout();
    approvalConnectStartedRef.current = null;
    approvalExecutionStartedRef.current = null;
    setActiveApprovalId(null);
    setActiveApprovalStatus(null);
    if (typeof window !== "undefined") {
      const nextUrl = new URL(window.location.href);
      nextUrl.searchParams.delete("approval");
      window.history.replaceState({}, "", nextUrl.toString());
    }
  }, [clearActiveApprovalTimeout]);

  const getPerpsAutoTradeReadyStatus = useCallback((
    tokenSymbol: string,
    options?: {
      activePositionLabel?: string | null;
      unsupported?: boolean;
      waitingForWallet?: boolean;
    }
  ) => {
    const perpsModeLabel =
      autoTradeSettings.perpsExecutionMode === "smart-trades"
        ? `smart ${autoTradeSettings.smartTradeProfile}`
        : "set params";

    if (options?.unsupported) {
      return `Perps auto-trade only supports SOL, ETH, or BTC. ${tokenSymbol} is not supported.`;
    }

    if (options?.waitingForWallet) {
      return `Perps auto-trade is armed for ${tokenSymbol}, waiting for Jupiter Mobile`;
    }

    if (options?.activePositionLabel) {
      return `Perps auto-trade is on (${tokenSymbol}, ${autoTradeSettings.walletPercent}% collateral, ${autoTradeSettings.perpsLeverage}x, ${perpsModeLabel}) · ${options.activePositionLabel}`;
    }

    return `Perps auto-trade is on (${tokenSymbol}, ${autoTradeSettings.walletPercent}% collateral, ${autoTradeSettings.perpsLeverage}x, ${autoTradeSettings.mode === "buy-only" ? "Buy Only" : "All"}, ${perpsModeLabel})`;
  }, [autoTradeSettings.mode, autoTradeSettings.perpsExecutionMode, autoTradeSettings.perpsLeverage, autoTradeSettings.smartTradeProfile, autoTradeSettings.walletPercent]);

  const setPerpsAutoTradeFailureCooldown = useCallback((tokenSymbol: string, message: string) => {
    clearPerpsAutoTradeErrorResetTimeout();
    perpsAutoTradeFailureCooldownUntilRef.current = Date.now() + AUTO_TRADE_ERROR_AUTO_RESET_MS;
    setPerpsAutoTradeStatus(
      `Perps auto-trade failed for ${tokenSymbol}: ${message} Cooling down for ${Math.round(AUTO_TRADE_ERROR_AUTO_RESET_MS / 1000)}s.`
    );
    perpsAutoTradeErrorResetTimeoutRef.current = setTimeout(() => {
      perpsAutoTradeFailureCooldownUntilRef.current = 0;
      if (!perpsAutoTradeBusyRef.current) {
        setPerpsAutoTradeStatus(getPerpsAutoTradeReadyStatus(tokenSymbol));
      }
      perpsAutoTradeErrorResetTimeoutRef.current = null;
    }, AUTO_TRADE_ERROR_AUTO_RESET_MS);
  }, [clearPerpsAutoTradeErrorResetTimeout, getPerpsAutoTradeReadyStatus]);

  const sendSignalNotification = useCallback(async (
    title: string,
    body: string,
    url?: string,
    sound: NativeNotificationSound = NATIVE_NOTIFICATION_SOUNDS.signal,
  ) => {
    if (!pushEnabled) return;

    if (nativeShell) {
      try {
        await LocalNotifications.schedule({
          notifications: [
            {
              id: Date.now() % 2147483000,
              title,
              body,
              sound,
              extra: url ? { url } : undefined,
            },
          ],
        });
      } catch {
        // ignore native notification delivery failures
      }
      return;
    }

    if (typeof window !== "undefined" && "Notification" in window && Notification.permission === "granted") {
      new Notification(title, { body });
    }
  }, [nativeShell, pushEnabled]);

  const sendRemotePushNotification = useCallback(async (payload: {
    title: string;
    body: string;
    url: string;
    walletAddress?: string | null;
    sound?: NativeNotificationSound;
  }) => {
    if (!pushEnabled) return;

    await fetch("/api/push/notify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...payload,
        subscription,
        nativeToken: nativePushToken,
      }),
    }).catch(() => undefined);
  }, [nativePushToken, pushEnabled, subscription]);

  const createPerpsApproval = useCallback(async (input: {
    signal: Signal;
    request: PendingPerpsApprovalRequest;
    walletAddress: string;
  }) => {
    const response = await fetch("/api/perps/approvals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        walletAddress: input.walletAddress,
        signalId: input.signal.id,
        signalSummary: input.signal.summary,
        symbol: input.signal.symbol,
        request: input.request,
      }),
    });

    const payload = await response.json().catch(() => null) as
      | { approval?: StoredPerpsApproval; approvalUrl?: string; error?: string }
      | null;

    if (!response.ok || !payload?.approval || !payload.approvalUrl) {
      const detail = payload?.error?.trim();
      const statusLabel = response.status ? `HTTP ${response.status}` : "request failed";
      throw new Error(detail ? `Unable to create the Perps approval request. ${statusLabel}: ${detail}` : `Unable to create the Perps approval request. ${statusLabel}.`);
    }

    return {
      approval: payload.approval,
      approvalUrl: payload.approvalUrl,
    };
  }, []);

  useEffect(() => {
    pendingTakeProfitRef.current = pendingTakeProfit;
  }, [pendingTakeProfit]);

  useEffect(() => {
    readOnlyPerpsSnapshotRef.current = readOnlyPerpsSnapshot;
  }, [readOnlyPerpsSnapshot]);

  useEffect(() => {
    if (!activeApprovalId || !jupiterPerpsController) return;

    if (!jupiterPerpsController.connected || !jupiterPerpsController.canWrite) {
      if (approvalConnectStartedRef.current === activeApprovalId) return;
      approvalConnectStartedRef.current = activeApprovalId;
      setActiveApprovalStatus("Opening Jupiter Mobile for approval...");
      void jupiterPerpsController.connect().catch((error: unknown) => {
        const message = error instanceof Error ? error.message : "Wallet connection failed.";
        setActiveApprovalStatus(message);
      });
      return;
    }

    if (approvalExecutionStartedRef.current === activeApprovalId) return;
    approvalExecutionStartedRef.current = activeApprovalId;
    setActiveApprovalStatus("Submitting pending Perps approval...");

    void (async () => {
      const response = await fetch(`/api/perps/approvals?id=${encodeURIComponent(activeApprovalId)}`, {
        cache: "no-store",
      });
      const payload = await response.json().catch(() => null) as
        | { approval?: StoredPerpsApproval; error?: string }
        | null;

      if (!response.ok || !payload?.approval) {
        setActiveApprovalStatus(payload?.error ?? "Approval request could not be loaded.");
        approvalExecutionStartedRef.current = null;
        return;
      }

      const approval = payload.approval;
      if (approval.status === "opened") {
        setActiveApprovalStatus("Approval already executed.");
        return;
      }

      try {
        const result = await jupiterPerpsController.openMarketPosition(approval.request);
        await fetch("/api/perps/approvals", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: approval.id,
            status: "opened",
            openedTxid: result.txid,
          }),
        }).catch(() => undefined);
        await sendSignalNotification(
          `Trade Filled: ${approval.symbol}`,
          `${approval.request.side === "long" ? "Long" : "Short"} executed · ${result.txid.slice(0, 10)}...`,
          "/signals-bot?tab=perps",
          NATIVE_NOTIFICATION_SOUNDS.approval,
        );
        await sendRemotePushNotification({
          title: `Trade Filled: ${approval.symbol}`,
          body: `${approval.request.side === "long" ? "Long" : "Short"} executed · ${result.txid.slice(0, 10)}...`,
          url: "/signals-bot?tab=perps",
          walletAddress: approval.walletAddress,
          sound: NATIVE_NOTIFICATION_SOUNDS.approval,
        });
        setPerpsAutoTradeStatus(
          `Perps approval executed for ${approval.symbol}: ${approval.request.side === "long" ? "long" : "short"} · ${result.txid.slice(0, 10)}...`
        );
        setActiveApprovalStatus("Perps approval executed.");
        clearActiveApprovalState();
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : "Unable to execute approval.";
        await fetch("/api/perps/approvals", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: approval.id,
            status: "failed",
            failureReason: message,
          }),
        }).catch(() => undefined);
        setActiveApprovalStatus(message);
        approvalExecutionStartedRef.current = null;
      }
    })();
  }, [activeApprovalId, clearActiveApprovalState, jupiterPerpsController, sendRemotePushNotification, sendSignalNotification]);

  useEffect(() => {
    clearActiveApprovalTimeout();

    if (!activeApprovalId) {
      return;
    }

    activeApprovalTimeoutRef.current = setTimeout(() => {
      const timeoutMessage = "Perps approval timed out after 20 seconds with no action.";
      void fetch("/api/perps/approvals", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: activeApprovalId,
          status: "cancelled",
          failureReason: timeoutMessage,
        }),
      }).catch(() => undefined);
      setPerpsAutoTradeStatus(timeoutMessage);
      clearActiveApprovalState();
    }, ACTIVE_APPROVAL_TIMEOUT_MS);

    return () => {
      clearActiveApprovalTimeout();
    };
  }, [activeApprovalId, clearActiveApprovalState, clearActiveApprovalTimeout]);

  useEffect(() => {
    if (wallet.connected && walletAddress && !remoteAuthSource) {
      setRemoteAuthSource("in-app");
    }
    if (!wallet.connected && remoteAuthSource === "in-app") {
      setRemoteAuthSource(null);
      setRemoteAuthToken(null);
      setRemoteAuthAddress(null);
    }
  }, [remoteAuthSource, wallet.connected, walletAddress]);

  useEffect(() => {
    const provider = getPhantomAuthProvider();
    const existingAddress = provider ? extractPhantomPublicKey(provider) : null;
    if (existingAddress) {
      setPhantomAuthAddress((current) => current ?? existingAddress);
    }
  }, []);

  useEffect(() => {
    if (wallet.publicKey || !pendingTakeProfit) return;
    setPendingTakeProfit(null);
    pendingTakeProfitRef.current = null;
  }, [pendingTakeProfit, wallet.publicKey]);

  const persistTradeRecord = useCallback(async (trade: StoredTradeRecord) => {
    const activeWallet = trade.walletAddress ?? tradeStorageAddress;
    setRecentTrades((prevTrades) => {
      const nextTrades = [trade, ...prevTrades.filter((item) => item.id !== trade.id)].slice(0, LOCAL_RECENT_TRADES_CAP);
      try {
        window.localStorage.setItem(tradesStorageKey(activeWallet), JSON.stringify(nextTrades));
      } catch (_error) {
        // ignore storage errors
      }
      return nextTrades;
    });

    if (!remoteAuthToken || !remoteAuthAddress || !trade.walletAddress || trade.walletAddress !== remoteAuthAddress) return;
    await fetch("/api/trades", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${remoteAuthToken}`,
      },
      body: JSON.stringify({ trade }),
    }).then(async (response) => {
      if (response.ok) return;
      if (response.status === 401) {
        setRemoteAuthToken(null);
        setRemoteAuthAddress(null);
        setRemoteAuthStatus("Remote auth expired. Re-sign to continue syncing.");
      }
    }).catch(() => undefined);
  }, [remoteAuthAddress, remoteAuthToken, tradeStorageAddress]);

  useEffect(() => {
    let cancelled = false;
    let simulateInterval: ReturnType<typeof setInterval> | null = null;
    const simulatedFeed = createSimulatedFeed(trackedMarkets.map((market) => market.pair));

    const appendPrices = (
      pricesBySlot: Partial<Record<string, number>>,
      changes24hBySlot: Partial<Record<string, number>>,
      now: number
    ) => {
      setPriceHistory((prev) => {
        const next = { ...prev };
        trackedMarkets.forEach((market) => {
          const price = Number(pricesBySlot[market.id]);
          if (!Number.isFinite(price) || price <= 0) return;
          const existing = next[market.id] ?? [];
          next[market.id] = [...existing, { t: now, v: price }].slice(-5400);

          if (changes24hBySlot[market.id] === undefined && next[market.id].length > 1) {
            const history = next[market.id];
            const current = history[history.length - 1]?.v ?? 0;
            const dayAgo = history.find((point) => now - point.t >= 24 * 60 * 60 * 1000) ?? history[0];
            if (dayAgo && dayAgo.v > 0) {
              changes24hBySlot[market.id] = ((current - dayAgo.v) / dayAgo.v) * 100;
            }
          }
        });
        return next;
      });

      setDayChange24h((prev) => {
        const next = { ...prev };
        trackedMarkets.forEach((market) => {
          const value = changes24hBySlot[market.id];
          if (typeof value === "number" && Number.isFinite(value)) {
            next[market.id] = value;
          }
        });
        return next;
      });
    };

    const startSimulationFallback = () => {
      if (simulateInterval) return;
      setPriceFeedStatus("simulated");
      simulateInterval = setInterval(() => {
        const updates = simulatedFeed();
        const pricesBySlot: Partial<Record<string, number>> = {};
        updates.forEach((update) => {
          const slot = trackedMarkets.find((market) => market.pair === update.symbol);
          if (!slot) return;
          const point = update.points[0];
          if (point) pricesBySlot[slot.id] = point.v;
        });
        appendPrices(pricesBySlot, {}, Date.now());
      }, 1000);
    };

    const stopSimulationFallback = () => {
      if (!simulateInterval) return;
      clearInterval(simulateInterval);
      simulateInterval = null;
    };

    const pollLivePrices = async () => {
      try {
        const products = trackedMarkets.map((market) => market.coinbaseProduct).join(",");
        const response = await fetch(`/api/prices/live?products=${encodeURIComponent(products)}`, {
          cache: "no-store",
        });
        const payload = await response.json();
        if (!response.ok || !payload?.markets) {
          if (!cancelled) startSimulationFallback();
          return;
        }

        const now = Number(payload.timestamp) || Date.now();
        const source = String(payload.source ?? "unknown");
        const markets = payload.markets as Record<
          string,
          { price?: number; change24hPercent?: number }
        >;
        const pricesBySlot: Partial<Record<string, number>> = {};
        const changes24hBySlot: Partial<Record<string, number>> = {};
        trackedMarkets.forEach((market) => {
          const entry = markets[market.coinbaseProduct];
          if (!entry) return;
          if (typeof entry.price === "number") pricesBySlot[market.id] = entry.price;
          if (typeof entry.change24hPercent === "number") {
            changes24hBySlot[market.id] = entry.change24hPercent;
          }
        });

        if (cancelled) return;
        stopSimulationFallback();
        setPriceFeedStatus(source);
        appendPrices(pricesBySlot, changes24hBySlot, now);
      } catch (_error) {
        if (!cancelled) startSimulationFallback();
      }
    };

    pollLivePrices().catch(() => undefined);
    const interval = setInterval(() => {
      pollLivePrices().catch(() => undefined);
    }, 1000);

    return () => {
      cancelled = true;
      clearInterval(interval);
      if (simulateInterval) clearInterval(simulateInterval);
    };
  }, [trackedMarkets]);

  useEffect(() => {
    setSignals((prev) => {
      let next = [...prev];
      const targetMarket =
        trackedMarkets.find((market) => market.id === receiveSignalsForSlotId) ?? trackedMarkets[0];
      if (!targetMarket) {
        return next;
      }

      [targetMarket].forEach((market) => {
        const points = priceHistory[market.id] ?? [];
        if (points.length === 0) return;
        const now = points[points.length - 1].t;
        const recentPoints = points.filter(
          (point) => now - point.t <= params.trendWindow * 60 * 1000
        );
        const minimumDataPoints = Math.max(10, params.trendWindow * 2);
        if (recentPoints.length < minimumDataPoints) return;

        const newSignals = detectSignals({
          symbol: market.pair,
          points: recentPoints,
          params,
          lastSignalAt: lastSignalAt[market.id],
        });

        if (newSignals.length > 0) {
          setLastSignalAt((prevTimes) => ({
            ...prevTimes,
            [market.id]: now,
          }));

          newSignals.forEach((signal) => {
            if (next.some((existing) => existing.id === signal.id)) return;
            next = [signal, ...next].slice(0, 12);

            void sendSignalNotification(`Signal: ${signal.symbol}`, signal.summary, undefined, NATIVE_NOTIFICATION_SOUNDS.signal);

            if (autoTradeEnabled && activeAutoTradeToken) {
              if (autoTradeBusyRef.current) {
                return;
              }
              const isBullSignal = signal.direction === "bullish";
              if (autoTradeSettings.mode === "buy-only" && !isBullSignal) {
                setAutoTradeStatus(`Buy-only mode skipped bearish signal for ${signal.symbol}`);
                return;
              }
              const activeTp = pendingTakeProfitRef.current;
              if (activeTp && !autoTradeSettings.disableTpLock) {
                setAutoTradeStatus(
                  `TP lock active for ${activeTp.tokenSymbol}: waiting for ${formatUsd(activeTp.targetPrice)} before new trades`
                );
                return;
              }
              const activeWallet = wallet.publicKey?.toBase58() ?? "paper-auto";
              const assetSymbol = activeAutoTradeToken.symbol;
              const assetMint = activeAutoTradeToken.mint;
              const inputMint = isBullSignal ? USDC_MINT : assetMint;
              const outputMint = isBullSignal ? assetMint : USDC_MINT;
              if (wallet.publicKey) {
                const availableInput = inputMint === SOL_MINT
                  ? (solBalance ?? 0)
                  : (walletTokens.find((token) => token.mint === inputMint)?.amount ?? 0);
                const tradeAmount = Number((availableInput * (autoTradeSettings.walletPercent / 100)).toFixed(6));
                if (!Number.isFinite(tradeAmount) || tradeAmount <= 0) {
                  setAutoTradeStatus(`Signal detected for ${signal.symbol} but no ${isBullSignal ? "USDC" : assetSymbol} balance is available`);
                } else {
                  const sideLabel = isBullSignal ? `buy ${assetSymbol}` : `sell ${assetSymbol}`;
                  setAutoTradeStatus(`Executing auto-trade for ${signal.symbol}: ${sideLabel} (${tradeAmount} ${isBullSignal ? "USDC" : assetSymbol})...`);
                  autoTradeBusyRef.current = true;
                  const marketEntryPrice = points[points.length - 1]?.v ?? 0;
                  wallet.executeSwap({
                    inputMint,
                    outputMint,
                    uiAmount: tradeAmount,
                  }).then((result) => {
                    const shouldArmTp =
                      isBullSignal &&
                      autoTradeSettings.takeProfitPercent > 0 &&
                      !autoTradeSettings.disableTpLock;
                    const targetPrice = shouldArmTp && Number.isFinite(marketEntryPrice) && marketEntryPrice > 0
                      ? marketEntryPrice * (1 + (autoTradeSettings.takeProfitPercent / 100))
                      : null;
                    const autoTradeRecord: StoredTradeRecord = {
                      id: `auto-${signal.id}-${Date.now()}`,
                      txid: result.txid,
                      timestamp: Date.now(),
                      walletAddress: activeWallet,
                      source: "auto",
                      signalId: signal.id,
                      inputMint: result.inputMint,
                      outputMint: result.outputMint,
                      inputAmount: result.inputAmount,
                      outputAmount: result.outputAmount,
                      signalSummary: `${signal.summary} · ${isBullSignal ? "buy" : "sell"} ${assetSymbol} · executed ${tradeAmount} ${isBullSignal ? "USDC" : assetSymbol}`,
                      symbol: signal.symbol,
                      entryPrice: Number.isFinite(marketEntryPrice) ? marketEntryPrice : undefined,
                      takeProfitPrice: targetPrice,
                      tradeDirection: isBullSignal ? "buy" : "sell",
                      gasless: result.gasless,
                    };
                    persistTradeRecord(autoTradeRecord).catch(() => undefined);
                    if (shouldArmTp) {
                      const executedOutputAmount = Number(result.outputAmount ?? 0);
                      if (Number.isFinite(executedOutputAmount) && executedOutputAmount > 0 && Number.isFinite(marketEntryPrice) && marketEntryPrice > 0) {
                        const nextPendingTp: PendingTakeProfit = {
                          id: `tp-${signal.id}-${Date.now()}`,
                          symbol: signal.symbol,
                          tokenSymbol: assetSymbol,
                          tokenMint: assetMint,
                          amount: executedOutputAmount,
                          entryPrice: marketEntryPrice,
                          targetPrice: targetPrice ?? marketEntryPrice,
                          signalId: signal.id,
                          createdAt: Date.now(),
                        };
                        setPendingTakeProfit(nextPendingTp);
                        pendingTakeProfitRef.current = nextPendingTp;
                        setAutoTradeStatus(
                          `TP armed for ${assetSymbol}: sell ${executedOutputAmount.toFixed(6)} at ${formatUsd(targetPrice ?? marketEntryPrice)} (+${autoTradeSettings.takeProfitPercent}%)`
                        );
                      } else {
                        setAutoTradeStatus(`Auto-trade executed for ${signal.symbol} (TP not armed: output amount unavailable)`);
                      }
                    } else {
                      setAutoTradeStatus(
                        `Auto-trade executed for ${signal.symbol}${result.gasless ? " · gasless" : ""}`
                      );
                    }
                    void sendRemotePushNotification({
                      title: `Auto-trade executed: ${signal.symbol}`,
                      body: `Tx: ${result.txid.slice(0, 12)}... · Tap to view on-chain.`,
                      url: `https://solscan.io/tx/${result.txid}`,
                      walletAddress: activeWallet,
                      sound: NATIVE_NOTIFICATION_SOUNDS.signal,
                    });
                  }).catch((error: unknown) => {
                    const message = error instanceof Error ? error.message : "swap failed";
                    setAutoTradeStatus(`Auto-trade failed for ${signal.symbol}: ${message}`);
                  }).finally(() => {
                    autoTradeBusyRef.current = false;
                  });
                }
              } else {
                if (autoTradeSettings.takeProfitPercent > 0 && isBullSignal) {
                  setAutoTradeStatus("TP requires a connected wallet for live token settlement");
                  return;
                }
                const autoTradeRecord: StoredTradeRecord = {
                  id: `auto-${signal.id}`,
                  txid: `auto-${signal.id}`,
                  timestamp: Date.now(),
                  walletAddress: activeWallet,
                  source: "auto",
                  signalId: signal.id,
                  symbol: signal.symbol,
                  entryPrice: points[points.length - 1]?.v ?? undefined,
                  takeProfitPrice: null,
                  tradeDirection: signal.direction === "bullish" ? "buy" : "sell",
                  signalSummary: `${signal.summary} · ${signal.direction === "bullish" ? "buy" : "sell"} ${assetSymbol} · ${autoTradeSettings.walletPercent}% allocation`,
                };
                persistTradeRecord(autoTradeRecord).catch(() => undefined);
                setAutoTradeStatus(
                  `Auto-trade paper execution for ${signal.symbol} (${signal.direction === "bullish" ? "buy" : "sell"} ${assetSymbol}, ${autoTradeSettings.walletPercent}% allocation; connect wallet for live)`
                );
              }
            }

            if (perpsAutoTradeEnabled && activePerpsAutoTradeToken) {
              if (perpsAutoTradeBusyRef.current) {
                return;
              }

              if (isPerpsAutoTradeFailureCooldownActive()) {
                return;
              }

              if (!isSupportedPerpsAutoTradeToken(activePerpsAutoTradeToken.symbol)) {
                setPerpsAutoTradeStatus(`Perps auto-trade does not support ${activePerpsAutoTradeToken.symbol} yet`);
                return;
              }

              if (!jupiterPerpsController?.walletAddress) {
                setPerpsAutoTradeStatus(
                  `Perps signal detected for ${signal.symbol}, but Jupiter Mobile needs to be connected once before approvals can be queued`
                );
                return;
              }
              const perpsWalletAddress = jupiterPerpsController.walletAddress;

              const findActivePerpsPosition = () =>
                readOnlyPerpsSnapshotRef.current.positions.find((position) => position.source !== "mock");

              if (findActivePerpsPosition()) {
                const activePerpsPosition = findActivePerpsPosition();
                setPerpsAutoTradeStatus(
                  `Perps auto-trade is waiting: ${activePerpsPosition?.marketSymbol} ${activePerpsPosition?.side === "long" ? "long" : "short"} already open`
                );
                return;
              }

              const perpsAssetSymbol = activePerpsAutoTradeToken.symbol;
              const isBullSignal = signal.direction === "bullish";
              if (autoTradeSettings.mode === "buy-only" && !isBullSignal) {
                setPerpsAutoTradeStatus(`Buy-only mode skipped bearish Perps signal for ${signal.symbol}`);
                return;
              }

              const perpsTradePlan =
                autoTradeSettings.perpsExecutionMode === "smart-trades"
                  ? deriveSmartPerpsTradePlan({
                      points,
                      settings: autoTradeSettings,
                      signal,
                    })
                  : {
                      collateralPercent: autoTradeSettings.walletPercent,
                      leverage: autoTradeSettings.perpsLeverage,
                      stopLossPercent: autoTradeSettings.stopLossPercent,
                      takeProfitPercent: autoTradeSettings.takeProfitPercent,
                      volatilityPercent: computeRecentVolatilityPercent(points),
                    };

              const usdcBalance = walletTokens.find((token) => token.mint === USDC_MINT)?.amount ?? 0;
              const collateralAmount = Number((usdcBalance * (perpsTradePlan.collateralPercent / 100)).toFixed(6));
              if (!Number.isFinite(collateralAmount) || collateralAmount <= 0) {
                setPerpsAutoTradeStatus(`Perps signal detected for ${signal.symbol} but no USDC collateral is available`);
                return;
              }

              void (async () => {
                perpsAutoTradeBusyRef.current = true;
                let approvalRequest: PendingPerpsApprovalRequest | null = null;

                try {
                  let takeProfitPrice: number | null = null;
                  let stopLossPrice: number | null = null;
                  const marketEntryPrice = points[points.length - 1]?.v ?? 0;

                  if (
                    (autoTradeSettings.takeProfitPercent > 0 || autoTradeSettings.stopLossPercent > 0) &&
                    Number.isFinite(marketEntryPrice) &&
                    marketEntryPrice > 0
                  ) {
                    try {
                      const preview = await jupiterPerpsController.previewMarketPosition({
                        asset: perpsAssetSymbol,
                        collateralToken: "USDC",
                        leverage: String(perpsTradePlan.leverage),
                        maxSlippageBps: "100",
                        side: isBullSignal ? "long" : "short",
                        uiAmount: collateralAmount,
                      });

                      const adjustedTriggers = deriveFeeAdjustedPerpsTriggers({
                        desiredStopLossPercent: perpsTradePlan.stopLossPercent,
                        desiredTakeProfitPercent: perpsTradePlan.takeProfitPercent,
                        fallbackEntryPrice: marketEntryPrice,
                        preview,
                      });

                      takeProfitPrice = adjustedTriggers.takeProfitPrice;
                      stopLossPrice = adjustedTriggers.stopLossPrice;
                    } catch (previewError) {
                      const previewMessage =
                        previewError instanceof Error ? previewError.message : "Unable to estimate Perps TP/SL with fees.";
                      setPerpsAutoTradeStatus(`Perps auto-trade paused for ${signal.symbol}: ${previewMessage}`);
                      return;
                    }
                  }

                  approvalRequest = {
                    asset: perpsAssetSymbol,
                    collateralToken: "USDC",
                    leverage: String(perpsTradePlan.leverage),
                    maxSlippageBps: "100",
                    side: isBullSignal ? "long" : "short",
                    stopLossPrice,
                    takeProfitPrice,
                    uiAmount: collateralAmount,
                  };

                  const { approval, approvalUrl } = await createPerpsApproval({
                    signal,
                    request: approvalRequest,
                    walletAddress: perpsWalletAddress,
                  });

                  setPerpsAutoTradeStatus(
                    `Perps approval queued for ${signal.symbol}: ${approvalRequest.side === "long" ? "long" : "short"} ${perpsAssetSymbol} (${collateralAmount} USDC at ${perpsTradePlan.leverage}x)`
                  );

                  await sendSignalNotification(
                    `Approve Trade: ${signal.symbol}`,
                    `${approvalRequest.side === "long" ? "Long" : "Short"} ${perpsAssetSymbol} pending approval in Jupiter Mobile.`,
                    approvalUrl,
                    NATIVE_NOTIFICATION_SOUNDS.approval,
                  );
                  await sendRemotePushNotification({
                    title: `Approve Trade: ${signal.symbol}`,
                    body: `${approvalRequest.side === "long" ? "Long" : "Short"} ${perpsAssetSymbol} pending approval in Jupiter Mobile.`,
                    url: approvalUrl,
                    walletAddress: approval.walletAddress,
                    sound: NATIVE_NOTIFICATION_SOUNDS.approval,
                  });
                } catch (error: unknown) {
                  const message = error instanceof Error ? error.message : "Unable to queue Perps approval.";
                  const shouldFallbackToDirectOpen =
                    Boolean(jupiterPerpsController.connected && jupiterPerpsController.canWrite);

                  if (shouldFallbackToDirectOpen) {
                    try {
                      setPerpsAutoTradeStatus(
                        `Perps approval queue unavailable for ${signal.symbol}. Falling back to direct Jupiter Mobile approval...`
                      );
                      if (!approvalRequest) {
                        throw new Error("Perps approval request was not prepared for fallback execution.");
                      }
                      const directResult = await jupiterPerpsController.openMarketPosition({
                        asset: approvalRequest.asset,
                        collateralToken: approvalRequest.collateralToken,
                        leverage: approvalRequest.leverage,
                        maxSlippageBps: approvalRequest.maxSlippageBps,
                        side: approvalRequest.side,
                        stopLossPrice: approvalRequest.stopLossPrice,
                        takeProfitPrice: approvalRequest.takeProfitPrice,
                        uiAmount: approvalRequest.uiAmount,
                      });
                      setPerpsAutoTradeStatus(
                        `Perps auto-trade opened for ${signal.symbol} via direct Jupiter Mobile approval · ${directResult.txid.slice(0, 10)}...`
                      );
                      await sendSignalNotification(
                        `Trade Filled: ${signal.symbol}`,
                        `${approvalRequest.side === "long" ? "Long" : "Short"} ${perpsAssetSymbol} executed via direct approval.`,
                        "/signals-bot?tab=perps",
                        NATIVE_NOTIFICATION_SOUNDS.approval,
                      );
                      await sendRemotePushNotification({
                        title: `Trade Filled: ${signal.symbol}`,
                        body: `${approvalRequest.side === "long" ? "Long" : "Short"} ${perpsAssetSymbol} executed via direct approval.`,
                        url: "/signals-bot?tab=perps",
                        walletAddress: perpsWalletAddress,
                        sound: NATIVE_NOTIFICATION_SOUNDS.approval,
                      });
                      return;
                    } catch (fallbackError: unknown) {
                      const fallbackMessage =
                        fallbackError instanceof Error ? fallbackError.message : "Direct Jupiter Mobile approval failed.";
                      setPerpsAutoTradeFailureCooldown(signal.symbol, `${message} Fallback failed: ${fallbackMessage}`);
                      return;
                    }
                  }

                  setPerpsAutoTradeFailureCooldown(signal.symbol, message);
                } finally {
                  perpsAutoTradeBusyRef.current = false;
                }
              })();
            }

            void sendRemotePushNotification({
              title: `Signal: ${signal.symbol}`,
              body: signal.summary,
              url: "/signals-bot",
              walletAddress: walletAddress ?? jupiterPerpsController?.walletAddress ?? undefined,
              sound: NATIVE_NOTIFICATION_SOUNDS.signal,
            });
          });
        }
      });

      return next;
    });
  }, [
    activeAutoTradeToken,
    activePerpsAutoTradeToken,
    autoTradeSettings,
    autoTradeEnabled,
    clearPerpsAutoTradeTimeout,
    getPerpsAutoTradeReadyStatus,
    isPerpsAutoTradeFailureCooldownActive,
    jupiterPerpsController,
    lastSignalAt,
    nativeShell,
    params,
    priceHistory,
    pushEnabled,
    receiveSignalsForSlotId,
    sendRemotePushNotification,
    sendSignalNotification,
    setPerpsAutoTradeFailureCooldown,
    trackedMarkets,
    createPerpsApproval,
    persistTradeRecord,
    perpsAutoTradeEnabled,
    readOnlyPerpsSnapshot.positions,
    wallet,
    wallet.executeSwap,
    walletAddress,
    wallet.publicKey,
    walletTokens,
    solBalance,
  ]);

  useEffect(() => {
    if (nativeShell) {
      let cancelled = false;

      async function initNativeNotifications() {
        const { hasLocalNotifications, hasPushNotifications } = getNativePushPluginStatus();
        if (!hasLocalNotifications) {
          if (!cancelled) {
            setPushReady(false);
            setPushStatus("Native notifications plugin missing in this app build");
          }
          return;
        }

        try {
          const localPermission = await LocalNotifications.checkPermissions();
          const pushPermission = hasPushNotifications
            ? await PushNotifications.checkPermissions()
            : { receive: "prompt" as const };
          if (cancelled) return;
          const enabledPreference = readNativeAlertsEnabled();
          setPushReady(true);
          if (!hasPushNotifications) {
            setPushEnabled(localPermission.display === "granted" && enabledPreference);
            setPushStatus("This installed iPhone app needs a rebuild/reinstall to add APNs push support");
            return;
          }
          if (nativePushIssue && localPermission.display === "granted" && enabledPreference) {
            setPushEnabled(true);
            setPushStatus(`Local native alerts enabled. ${nativePushIssue}`);
            return;
          }
          if (localPermission.display === "granted" && pushPermission.receive === "granted" && enabledPreference) {
            setPushEnabled(true);
            setPushStatus(nativePushToken ? "Native alerts enabled" : "Native alerts enabled, waiting for APNs token");
          } else if (localPermission.display === "granted" || pushPermission.receive === "granted") {
            setPushEnabled(false);
            setPushStatus("Native alerts available");
          } else {
            setPushEnabled(false);
            setPushStatus("Native alerts disabled");
          }
        } catch (error) {
          if (cancelled) return;
          setPushReady(false);
          setPushStatus(error instanceof Error && error.message ? error.message : "Native notifications unavailable");
        }
      }

      void initNativeNotifications();
      return () => {
        cancelled = true;
      };
    }

    if (!window.isSecureContext) {
      setPushStatus("Push requires HTTPS (or localhost)");
      return;
    }

    if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
      setPushStatus("Push is not supported on this browser/device");
      return;
    }

    navigator.serviceWorker
      .register("/sw.js")
      .then(async () => {
        setPushReady(true);
        const registration = await navigator.serviceWorker.ready;
        const existing = await registration.pushManager.getSubscription();
        if (existing) {
          setSubscription(existing.toJSON());
          setPushEnabled(true);
          setPushStatus("Alerts enabled");
        } else {
          setPushEnabled(false);
          setPushStatus("Alerts disabled");
        }
      })
      .catch(() => {
        setPushStatus("Service worker registration failed");
      });
  }, [nativePushIssue, nativePushToken, nativeShell]);

  useEffect(() => {
    if (!nativeShell) return;

    let removed = false;
    const handles: Array<{ remove: () => Promise<void> }> = [];

    const registerListener = async (
      promise: Promise<{ remove: () => Promise<void> }>
    ) => {
      try {
        const handle = await promise;
        if (removed) {
          await handle.remove();
          return;
        }
        handles.push(handle);
      } catch {
        // Ignore listener registration failures.
      }
    };

    void registerListener(LocalNotifications.addListener("localNotificationActionPerformed", (event) => {
      const nextUrl = typeof event.notification.extra?.url === "string"
        ? event.notification.extra.url
        : "";
      if (nextUrl) {
        navigateToNotificationUrl(nextUrl);
      }
    }));

    void registerListener(PushNotifications.addListener("registration", (token) => {
      setNativePushIssue(null);
      setNativePushToken(token.value);
        setPushStatus("Native push token ready");
    }));

    void registerListener(PushNotifications.addListener("registrationError", (error) => {
      setNativePushToken(null);
      const message = error.error?.trim() || "APNs registration failed";
      const lowerMessage = message.toLowerCase();
      const profileMessage =
        lowerMessage.includes("aps-environment")
        || lowerMessage.includes("push notifications")
        || lowerMessage.includes("not entitled")
        || lowerMessage.includes("no valid")
          ? "APNs push is unavailable in the current signing profile. Local native alerts still work."
          : message;
      setNativePushIssue(profileMessage);
      setPushEnabled(readNativeAlertsEnabled());
      setPushStatus(`Local native alerts enabled. ${profileMessage}`);
    }));

    void registerListener(PushNotifications.addListener("pushNotificationActionPerformed", (event) => {
      const nextUrl = typeof event.notification.data?.url === "string"
        ? event.notification.data.url
        : "";
      if (nextUrl) {
        navigateToNotificationUrl(nextUrl);
      }
    }));

    void registerListener(PushNotifications.addListener("pushNotificationReceived", (event) => {
      if (typeof event.notification.title === "string") {
        setPushStatus(`Push received: ${event.notification.title}`);
      }
    }));

    return () => {
      removed = true;
      handles.forEach((handle) => {
        void handle.remove();
      });
    };
  }, [nativeShell]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const approvalId = new URLSearchParams(window.location.search).get("approval")?.trim() ?? "";
    if (!approvalId) return;
    setActiveApprovalId(approvalId);
    setActiveApprovalStatus("Opening approval request...");
  }, []);

  useEffect(() => {
    if (!nativeShell || typeof window === "undefined") return;

    const audio = new Audio(`/sounds/${NATIVE_NOTIFICATION_SOUNDS.appOpen}`);
    audio.volume = 1;
    void audio.play().catch(() => undefined);
  }, [nativeShell]);

  useEffect(() => {
    if (!subscription?.endpoint || nativeShell) return;

    fetch("/api/push/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...subscription,
        walletAddress,
        nativeShell,
        platform: nativeShell ? "native" : "web",
      }),
    }).catch(() => undefined);
  }, [nativeShell, subscription, walletAddress]);

  useEffect(() => {
    if (!nativeShell || !nativePushToken) return;

    fetch("/api/push/native/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: nativePushToken,
        walletAddress,
      }),
    }).catch(() => undefined);
  }, [nativePushToken, nativeShell, walletAddress]);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(PARAMS_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Partial<UserParams>;
      setParams({
        trendWindow: Number(parsed.trendWindow ?? DEFAULT_PARAMS.trendWindow),
        trendThreshold: Number(parsed.trendThreshold ?? DEFAULT_PARAMS.trendThreshold),
        breakoutPercent: Number(parsed.breakoutPercent ?? DEFAULT_PARAMS.breakoutPercent),
        cooldownSeconds: Number(parsed.cooldownSeconds ?? DEFAULT_PARAMS.cooldownSeconds),
      });
      setParamsSaveStatus("Saved preset loaded");
    } catch (_error) {
      setParamsSaveStatus("Failed to load saved preset");
    }
  }, []);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(AUTO_TRADE_SETTINGS_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Partial<AutoTradeSettings & { inputToken?: AutoTradeToken }>;
      const nextPercent = Number(parsed.walletPercent);
      const percent = Number.isFinite(nextPercent)
        ? Math.min(100, Math.max(1, Math.round(nextPercent)))
        : DEFAULT_AUTO_TRADE_SETTINGS.walletPercent;
      const nextTakeProfit = Number(parsed.takeProfitPercent);
      const takeProfitPercent = Number.isFinite(nextTakeProfit) && nextTakeProfit >= 0
        ? nextTakeProfit
        : DEFAULT_AUTO_TRADE_SETTINGS.takeProfitPercent;
      const nextStopLoss = Number(parsed.stopLossPercent);
      const stopLossPercent = Number.isFinite(nextStopLoss) && nextStopLoss >= 0
        ? nextStopLoss
        : DEFAULT_AUTO_TRADE_SETTINGS.stopLossPercent;
      const nextPerpsLeverage = Number(parsed.perpsLeverage);
      const perpsLeverage = Number.isFinite(nextPerpsLeverage) && nextPerpsLeverage >= 1
        ? Math.min(250, Math.max(1, Number(nextPerpsLeverage.toFixed(2))))
        : DEFAULT_AUTO_TRADE_SETTINGS.perpsLeverage;
      const mode = parsed.mode === "buy-only" ? "buy-only" : "all";
      const perpsExecutionMode = parsed.perpsExecutionMode === "smart-trades" ? "smart-trades" : "set-parameters";
      const smartTradeProfile =
        parsed.smartTradeProfile === "conservative" || parsed.smartTradeProfile === "aggressive"
          ? parsed.smartTradeProfile
          : "balanced";
      const disableTpLock = Boolean(parsed.disableTpLock);
      const parsedSlots = Array.isArray(parsed.slots)
        ? parsed.slots
          .map((slot) => {
            if (!slot || typeof slot !== "object") return null;
            const slotId = String((slot as { id?: string }).id ?? "");
            const tokenRaw = String((slot as { token?: string }).token ?? "SOL");
            const token = AUTO_TRADE_TOKEN_OPTIONS.some((option) => option.symbol === tokenRaw)
              ? (tokenRaw as AutoTradeToken)
              : "SOL";
            return slotId ? { id: slotId, token } : null;
          })
          .filter((slot): slot is AutoTradeSlot => Boolean(slot))
          .slice(0, 3)
        : [];
      const normalizedSlots = parsedSlots.length === 3
        ? parsedSlots
        : DEFAULT_AUTO_TRADE_SETTINGS.slots.map((slot, index) => ({
          ...slot,
          token: parsedSlots[index]?.token ?? slot.token,
        }));
      const legacyInputToken = parsed.inputToken;
      const activeSlotId = typeof parsed.activeSlotId === "string"
        ? normalizedSlots.some((slot) => slot.id === parsed.activeSlotId) ? parsed.activeSlotId : null
        : legacyInputToken
          ? normalizedSlots[0]?.id ?? null
          : null;
      const perpsActiveSlotId = typeof parsed.perpsActiveSlotId === "string"
        ? normalizedSlots.some((slot) => slot.id === parsed.perpsActiveSlotId) ? parsed.perpsActiveSlotId : null
        : null;

      setAutoTradeSettings({
        walletPercent: percent,
        takeProfitPercent,
        stopLossPercent,
        perpsLeverage,
        perpsExecutionMode,
        smartTradeProfile,
        slots: normalizedSlots,
        activeSlotId,
        perpsActiveSlotId,
        mode,
        disableTpLock,
      });
    } catch (_error) {
      setAutoTradeSettings(DEFAULT_AUTO_TRADE_SETTINGS);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/markets/coinbase", { cache: "no-store" })
      .then((response) => response.json())
      .then((payload) => {
        if (cancelled) return;
        const options = Array.isArray(payload?.options) ? (payload.options as MarketOption[]) : [];
        if (options.length > 0) {
          setMarketOptions(options);
        }
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!autoTradeSettings.disableTpLock || !pendingTakeProfit) return;
    setPendingTakeProfit(null);
    pendingTakeProfitRef.current = null;
  }, [autoTradeSettings.disableTpLock, pendingTakeProfit]);

  useEffect(() => {
    if (!activeAutoTradeToken) {
      setAutoTradeStatus("Auto-trade is off");
      return;
    }
    if (pendingTakeProfit && !autoTradeSettings.disableTpLock) {
      setAutoTradeStatus(
        `TP armed for ${pendingTakeProfit.tokenSymbol}: waiting for ${formatUsd(pendingTakeProfit.targetPrice)} to sell ${pendingTakeProfit.amount.toFixed(6)}`
      );
      return;
    }
    setAutoTradeStatus(
      `Auto-trade is on (${activeAutoTradeToken.symbol}, ${autoTradeSettings.walletPercent}% allocation, ${autoTradeSettings.mode === "buy-only" ? "Buy Only" : "All"})`
    );
  }, [
    activeAutoTradeToken,
    autoTradeSettings.disableTpLock,
    autoTradeSettings.mode,
    autoTradeSettings.walletPercent,
    pendingTakeProfit,
  ]);

  useEffect(() => {
    if (!activePerpsAutoTradeToken) {
      clearPerpsAutoTradeFailureCooldown();
      clearPerpsAutoTradeTimeout();
      perpsAutoTradeAttemptIdRef.current += 1;
      perpsAutoTradeBusyRef.current = false;
      setPerpsAutoTradeStatus("Perps auto-trade is off");
      return;
    }

    if (!isSupportedPerpsAutoTradeToken(activePerpsAutoTradeToken.symbol)) {
      setPerpsAutoTradeStatus(getPerpsAutoTradeReadyStatus(activePerpsAutoTradeToken.symbol, { unsupported: true }));
      return;
    }

    if (!jupiterPerpsController?.connected || !jupiterPerpsController.canWrite) {
      setPerpsAutoTradeStatus(getPerpsAutoTradeReadyStatus(activePerpsAutoTradeToken.symbol, { waitingForWallet: true }));
      return;
    }

    if (readOnlyPerpsSnapshot.positions.length > 0) {
      setPerpsAutoTradeStatus(getPerpsAutoTradeReadyStatus(activePerpsAutoTradeToken.symbol, { activePositionLabel: "active position open" }));
      return;
    }

    if (isPerpsAutoTradeFailureCooldownActive()) {
      return;
    }

    if (!perpsAutoTradeBusyRef.current) {
      setPerpsAutoTradeStatus(getPerpsAutoTradeReadyStatus(activePerpsAutoTradeToken.symbol));
    }
  }, [
    activePerpsAutoTradeToken,
    autoTradeSettings.mode,
    autoTradeSettings.perpsLeverage,
    autoTradeSettings.walletPercent,
    clearPerpsAutoTradeFailureCooldown,
    clearPerpsAutoTradeTimeout,
    getPerpsAutoTradeReadyStatus,
    isPerpsAutoTradeFailureCooldownActive,
    jupiterPerpsController,
    readOnlyPerpsSnapshot.positions.length,
  ]);

  useEffect(() => {
    return () => {
      clearPerpsAutoTradeFailureCooldown();
      clearPerpsAutoTradeTimeout();
      perpsAutoTradeAttemptIdRef.current = 0;
      perpsAutoTradeBusyRef.current = false;
    };
  }, [clearPerpsAutoTradeFailureCooldown, clearPerpsAutoTradeTimeout]);

  useEffect(() => {
    if (nativeShell || typeof window === "undefined") return;

    const shouldKeepAwake = autoTradeEnabled || perpsAutoTradeEnabled;
    const wakeLockApi = (navigator as Navigator & {
      wakeLock?: {
        request?: (type: "screen") => Promise<{ release?: () => Promise<void> }>;
      };
    }).wakeLock;

    if (!shouldKeepAwake || typeof wakeLockApi?.request !== "function") {
      if (wakeLockRef.current) {
        void wakeLockRef.current.release?.().catch(() => undefined);
        wakeLockRef.current = null;
      }
      return;
    }

    let cancelled = false;

    const requestWakeLock = async () => {
      if (document.visibilityState === "hidden") return;
      try {
        wakeLockRef.current = await wakeLockApi.request("screen");
      } catch {
        wakeLockRef.current = null;
      }
    };

    const handleVisibility = () => {
      if (document.visibilityState === "visible" && !wakeLockRef.current) {
        void requestWakeLock();
      }
    };

    void requestWakeLock();
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", handleVisibility);
      if (!cancelled && wakeLockRef.current) {
        void wakeLockRef.current.release?.().catch(() => undefined);
      } else if (wakeLockRef.current) {
        void wakeLockRef.current.release?.().catch(() => undefined);
      }
      wakeLockRef.current = null;
    };
  }, [autoTradeEnabled, nativeShell, perpsAutoTradeEnabled]);

  const requestRemoteAuthChallenge = useCallback(async (address: string) => {
    const response = await fetch("/api/trades/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address }),
    });
    const payload = (await response.json().catch(() => null)) as RemoteAuthChallenge | { error?: string } | null;
    if (!response.ok || !payload || !("challengeId" in payload) || !payload.challengeId || !payload.message) {
      throw new Error((payload && "error" in payload && payload.error) || "Remote auth challenge failed");
    }
    return payload;
  }, []);

  const verifyRemoteAuthChallenge = useCallback(async (address: string, challengeId: string, signature: string) => {
    const response = await fetch("/api/trades/auth", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address, challengeId, signature }),
    });
    const payload = (await response.json().catch(() => null)) as { token?: string; error?: string } | null;
    if (!response.ok || !payload?.token) {
      throw new Error(payload?.error || "Remote auth verification failed");
    }
    return payload.token;
  }, []);

  const signRemoteAuthMessage = useCallback(async (source: RemoteAuthSource, message: string) => {
    const encodedMessage = new TextEncoder().encode(message);

    if (source === "in-app") {
      const signature = await walletSignMessage(encodedMessage);
      return bs58.encode(signature);
    }

    const provider = getPhantomAuthProvider();
    if (!provider) {
      throw new Error("Phantom is not available for message signing on this device.");
    }
    const signed = await provider.signMessage(encodedMessage, "utf8");
    const signatureBytes = signed instanceof Uint8Array
      ? signed
      : signed?.signature instanceof Uint8Array
        ? signed.signature
        : null;
    if (!signatureBytes) {
      throw new Error("Phantom did not return a signature.");
    }
    return bs58.encode(signatureBytes);
  }, [walletSignMessage]);

  const completeRemoteAuth = useCallback(async (address: string, source: RemoteAuthSource) => {
    setRemoteAuthStatus(
      source === "in-app"
        ? "Requesting in-app wallet signature..."
        : "Requesting Phantom signature..."
    );
    const challenge = await requestRemoteAuthChallenge(address);
    const signature = await signRemoteAuthMessage(source, challenge.message);
    const nextToken = await verifyRemoteAuthChallenge(address, challenge.challengeId, signature);
    setRemoteAuthToken(nextToken);
    setRemoteAuthAddress(address);
    try {
      window.localStorage.setItem(remoteTradesAuthStorageKey(address), nextToken);
    } catch {
      // ignore storage errors
    }
    setRemoteAuthStatus(`Remote auth connected via ${source === "in-app" ? "in-app wallet" : "Phantom"}`);
    return nextToken;
  }, [requestRemoteAuthChallenge, signRemoteAuthMessage, verifyRemoteAuthChallenge]);

  async function connectPhantomForRemoteSync() {
    const provider = getPhantomAuthProvider();
    if (!provider) {
      setRemoteAuthStatus("Phantom extension/app browser not detected for remote sync");
      return;
    }

    try {
      setRemoteAuthStatus("Connecting Phantom for remote sync...");
      const result = await provider.connect({ onlyIfTrusted: false }).catch(() => provider.connect());
      const nextAddress =
        extractPhantomPublicKey(provider)
        ?? (result?.publicKey && typeof result.publicKey.toBase58 === "function" ? result.publicKey.toBase58() : null);
      if (!nextAddress) {
        throw new Error("Phantom connected, but no wallet address was returned.");
      }

      setPhantomAuthAddress(nextAddress);
      setRemoteAuthSource("phantom");
      await completeRemoteAuth(nextAddress, "phantom");
    } catch (connectError) {
      setRemoteAuthToken(null);
      setRemoteAuthAddress(null);
      const message = connectError instanceof Error ? connectError.message : "Phantom connection failed";
      setRemoteAuthStatus(message);
    }
  }

  async function disconnectPhantomForRemoteSync() {
    const provider = getPhantomAuthProvider();
    try {
      await provider?.disconnect?.();
    } catch {
      // ignore provider disconnect failures
    }
    if (phantomAuthAddress) {
      try {
        window.localStorage.removeItem(remoteTradesAuthStorageKey(phantomAuthAddress));
      } catch {
        // ignore storage errors
      }
    }
    setPhantomAuthAddress(null);
    if (remoteAuthSource === "phantom") {
      setRemoteAuthSource(wallet.connected && walletAddress ? "in-app" : null);
      setRemoteAuthToken(null);
      setRemoteAuthAddress(null);
      setRemoteAuthStatus(wallet.connected && walletAddress ? "In-app wallet ready for remote auth" : "Remote auth pending");
      setRemoteSyncStatus(wallet.connected && walletAddress ? "Remote sync waiting for auth" : "Remote sync unavailable");
    }
  }

  useEffect(() => {
    if (!pendingTakeProfit || !wallet.publicKey || !autoTradeEnabled) return;
    if (autoTradeBusyRef.current) return;

    const market = trackedMarkets.find((item) => item.pair === pendingTakeProfit.symbol);
    if (!market) return;
    const latestPrice = priceHistory[market.id]?.[priceHistory[market.id].length - 1]?.v ?? 0;
    if (!Number.isFinite(latestPrice) || latestPrice <= 0) return;
    if (latestPrice < pendingTakeProfit.targetPrice) return;

    const now = Date.now();
    if (now - lastTpAttemptAtRef.current < 15000) return;
    lastTpAttemptAtRef.current = now;
    autoTradeBusyRef.current = true;

    setAutoTradeStatus(
      `TP hit for ${pendingTakeProfit.tokenSymbol}: selling ${pendingTakeProfit.amount.toFixed(6)} at ${formatUsd(latestPrice)}`
    );

      walletExecuteSwap({
        inputMint: pendingTakeProfit.tokenMint,
        outputMint: USDC_MINT,
        uiAmount: pendingTakeProfit.amount,
    }).then((result) => {
      const tpTradeRecord: StoredTradeRecord = {
        id: `tp-${pendingTakeProfit.id}-${Date.now()}`,
        txid: result.txid,
        timestamp: Date.now(),
        walletAddress: walletPublicKey?.toBase58() ?? "paper-auto",
        source: "auto",
        signalId: pendingTakeProfit.signalId,
        inputMint: result.inputMint,
        outputMint: result.outputMint,
        inputAmount: result.inputAmount,
        outputAmount: result.outputAmount,
        symbol: pendingTakeProfit.symbol,
        entryPrice: pendingTakeProfit.entryPrice,
        takeProfitPrice: pendingTakeProfit.targetPrice,
        tradeDirection: "sell",
        gasless: result.gasless,
        signalSummary: `TP sell ${pendingTakeProfit.tokenSymbol} at ${formatUsd(latestPrice)} (target ${formatUsd(pendingTakeProfit.targetPrice)})`,
      };
      persistTradeRecord(tpTradeRecord).catch(() => undefined);
      setPendingTakeProfit(null);
      pendingTakeProfitRef.current = null;
      setAutoTradeStatus(`TP executed for ${pendingTakeProfit.symbol} at ${formatUsd(latestPrice)}`);
      void sendSignalNotification(
        `TP Hit: ${pendingTakeProfit.symbol}`,
        `${pendingTakeProfit.tokenSymbol} take profit executed at ${formatUsd(latestPrice)}.`,
        "/signals-bot?tab=trades",
        NATIVE_NOTIFICATION_SOUNDS.tp,
      );
      void sendRemotePushNotification({
        title: `TP Hit: ${pendingTakeProfit.symbol}`,
        body: `${pendingTakeProfit.tokenSymbol} take profit executed at ${formatUsd(latestPrice)}.`,
        url: "/signals-bot?tab=trades",
        walletAddress: walletPublicKey?.toBase58() ?? walletAddress ?? undefined,
        sound: NATIVE_NOTIFICATION_SOUNDS.tp,
      });
    }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "swap failed";
      setAutoTradeStatus(`TP execution failed for ${pendingTakeProfit.symbol}: ${message}`);
    }).finally(() => {
      autoTradeBusyRef.current = false;
    });
  }, [
    autoTradeEnabled,
    pendingTakeProfit,
    persistTradeRecord,
    priceHistory,
    sendRemotePushNotification,
    sendSignalNotification,
    trackedMarkets,
    wallet.publicKey,
    walletExecuteSwap,
    walletPublicKey,
    walletAddress,
  ]);

  useEffect(() => {
    const activeTradeKey = tradesStorageKey(tradeStorageAddress);
    try {
      const raw = window.localStorage.getItem(activeTradeKey);
      if (!raw) {
        setRecentTrades([]);
        return;
      }
      const parsed = JSON.parse(raw) as StoredTradeRecord[];
      setRecentTrades(Array.isArray(parsed) ? parsed : []);
    } catch (_error) {
      setRecentTrades([]);
    }
  }, [tradeStorageAddress]);

  useEffect(() => {
    if (!remoteAuthSource || !remoteSyncWalletAddress) {
      setRemoteAuthToken(null);
      setRemoteAuthAddress(null);
      setRemoteAuthStatus("Remote auth pending");
      setRemoteSyncStatus("Remote sync unavailable");
      return;
    }

    const walletAddressForAuth = remoteSyncWalletAddress;
    const authSourceForSync = remoteAuthSource;
    let cancelled = false;
    const cachedToken = typeof window !== "undefined"
      ? window.localStorage.getItem(remoteTradesAuthStorageKey(walletAddressForAuth))
      : null;

    if (cachedToken && remoteAuthAddress === walletAddressForAuth && remoteAuthToken === cachedToken) {
      setRemoteAuthStatus(`Remote auth connected via ${authSourceForSync === "in-app" ? "in-app wallet" : "Phantom"}`);
      return;
    }

    if (authSourceForSync === "phantom") {
      setRemoteAuthToken(null);
      setRemoteAuthAddress(null);
      setRemoteAuthStatus(
        phantomAuthAddress
          ? "Tap Sign In with Phantom Sync to finish remote auth."
          : "Connect Phantom Sync to use Phantom for remote auth."
      );
      return;
    }

    async function authenticate() {
      try {
        const nextToken = await completeRemoteAuth(walletAddressForAuth, authSourceForSync);
        if (cancelled) return;
        setRemoteAuthToken(nextToken);
      } catch (authError) {
        if (cancelled) return;
        setRemoteAuthToken(null);
        setRemoteAuthAddress(null);
        const message = authError instanceof Error ? authError.message : "Remote auth failed";
        setRemoteAuthStatus(message);
      }
    }

    if (cachedToken) {
      setRemoteAuthToken(cachedToken);
      setRemoteAuthAddress(walletAddressForAuth);
      setRemoteAuthStatus(`Remote auth connected via ${authSourceForSync === "in-app" ? "in-app wallet" : "Phantom"}`);
      return;
    }

    void authenticate();

    return () => {
      cancelled = true;
    };
  }, [completeRemoteAuth, phantomAuthAddress, remoteAuthAddress, remoteAuthSource, remoteAuthToken, remoteSyncWalletAddress]);

  useEffect(() => {
    if (!remoteSyncWalletAddress || !remoteAuthToken) {
      setRemoteSyncStatus(remoteSyncWalletAddress ? "Remote sync waiting for auth" : "Remote sync unavailable");
      return;
    }

    let cancelled = false;
    setRemoteSyncStatus("Syncing remote trades...");
    fetch(`/api/trades?address=${remoteSyncWalletAddress}`, {
      cache: "no-store",
      headers: { Authorization: `Bearer ${remoteAuthToken}` },
    }).then(async (response) => {
      const payload = await response.json().catch(() => null);
      if (cancelled) return;
      if (!response.ok) {
        if (response.status === 401) {
          try {
            window.localStorage.removeItem(remoteTradesAuthStorageKey(remoteSyncWalletAddress));
          } catch {
            // ignore storage errors
          }
          setRemoteAuthToken(null);
          setRemoteAuthAddress(null);
          setRemoteAuthStatus("Remote auth expired. Re-sign to continue syncing.");
        }
        setRemoteSyncStatus("Remote sync failed");
        return;
      }
      const remoteTrades = Array.isArray(payload?.trades) ? (payload.trades as StoredTradeRecord[]) : [];
      setRecentTrades(remoteTrades);
      try {
        window.localStorage.setItem(tradesStorageKey(tradeStorageAddress), JSON.stringify(remoteTrades));
      } catch (_error) {
        // ignore storage errors
      }
      setRemoteSyncStatus(`Remote sync connected (${remoteTrades.length} trades)`);
    }).catch(() => {
      if (cancelled) return;
      setRemoteSyncStatus("Remote sync failed");
    });

    return () => {
      cancelled = true;
    };
  }, [remoteAuthToken, remoteSyncWalletAddress, tradeStorageAddress]);

  const refreshWalletPortfolio = useCallback(async () => {
    if (!wallet.connected || !wallet.publicKey) {
      setSolBalance(null);
      setWalletTokens([]);
      setTotalBalanceUsd(null);
      setSolValueUsd(null);
      setPortfolioStatus("Wallet not connected");
      return;
    }

    setPortfolioStatus("Syncing wallet balances...");

    try {
      const response = await fetch(`/api/wallet/balances?address=${wallet.publicKey.toBase58()}`, {
        cache: "no-store",
      });
      const payload = await response.json().catch(() => null);
      if (response.ok && payload) {
        setSolBalance(typeof payload.solBalance === "number" ? payload.solBalance : null);
        setWalletTokens(Array.isArray(payload.tokens) ? (payload.tokens as WalletTokenHolding[]) : []);
        setTotalBalanceUsd(typeof payload.totalBalanceUsd === "number" ? payload.totalBalanceUsd : null);
        setSolValueUsd(typeof payload.solValueUsd === "number" ? payload.solValueUsd : null);
        setPortfolioStatus(typeof payload.status === "string" ? payload.status : "Wallet synced");
        return;
      }
    } catch (_error) {
      // fallback to direct client RPC calls below
    }

    const [balanceResult, splTokenAccountsResult, token2022AccountsResult] = await Promise.allSettled([
      connection.getBalance(wallet.publicKey, "processed"),
      connection.getParsedTokenAccountsByOwner(wallet.publicKey, {
        programId: TOKEN_PROGRAM_ID,
      }),
      connection.getParsedTokenAccountsByOwner(wallet.publicKey, {
        programId: TOKEN_2022_PROGRAM_ID,
      }),
    ]);

    let solLoaded = false;
    let tokensLoaded = false;

    if (balanceResult.status === "fulfilled") {
      setSolBalance(balanceResult.value / 1_000_000_000);
      solLoaded = true;
    } else {
      try {
        const accountInfo = await connection.getAccountInfo(wallet.publicKey, "finalized");
        if (accountInfo) {
          setSolBalance(accountInfo.lamports / 1_000_000_000);
          solLoaded = true;
        } else {
          setSolBalance(null);
        }
      } catch (_error) {
        setSolBalance(null);
      }
    }

    const holdingsByMint = new Map<string, WalletTokenHolding>();
    const tokenResults = [splTokenAccountsResult, token2022AccountsResult];
    tokenResults.forEach((result) => {
      if (result.status !== "fulfilled") {
        return;
      }
      tokensLoaded = true;
      result.value.value.forEach((accountInfo) => {
        const parsedInfo = accountInfo.account.data.parsed?.info;
        const mint = String(parsedInfo?.mint ?? "");
        const uiAmount = Number(parsedInfo?.tokenAmount?.uiAmount ?? 0);
        const uiAmountString = Number(parsedInfo?.tokenAmount?.uiAmountString ?? 0);
        const amount = Number.isFinite(uiAmount) && uiAmount > 0 ? uiAmount : uiAmountString;

        if (!mint || !Number.isFinite(amount) || amount <= 0) {
          return;
        }

        const existing = holdingsByMint.get(mint);
        holdingsByMint.set(mint, {
          mint,
          amount: (existing?.amount ?? 0) + amount,
        });
      });
    });

    const holdings = [...holdingsByMint.values()]
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 6);
    setWalletTokens(holdings);
    setTotalBalanceUsd(null);
    setSolValueUsd(null);

    if (solLoaded && tokensLoaded) {
      setPortfolioStatus("Wallet synced");
      return;
    }
    if (solLoaded && !tokensLoaded) {
      setPortfolioStatus("SOL balance synced (token accounts unavailable)");
      return;
    }
    if (!solLoaded && tokensLoaded) {
      setPortfolioStatus("Token balances synced (SOL balance unavailable)");
      return;
    }
    setPortfolioStatus("Failed to sync wallet balances");
  }, [connection, wallet.connected, wallet.publicKey]);

  useEffect(() => {
    refreshWalletPortfolio().catch(() => undefined);
    const interval = setInterval(() => {
      refreshWalletPortfolio().catch(() => undefined);
    }, 30000);

    return () => clearInterval(interval);
  }, [refreshWalletPortfolio]);

  const selectedChartMarket =
    trackedMarkets.find((market) => market.id === selectedChartSlotId) ?? trackedMarkets[0];
  const selectedChartPricePoints = priceHistory[selectedChartMarket?.id ?? ""] ?? [];
  const selectedSignalMarket =
    trackedMarkets.find((market) => market.id === receiveSignalsForSlotId) ?? trackedMarkets[0];
  const selectedChartGuideKey = normalizeMarketGuideKey(selectedChartMarket?.pair ?? selectedChartMarket?.tvSymbol);
  const selectedChartPerpsPositions = readOnlyPerpsSnapshot.positions.filter((position) => {
    if (position.source === "mock") return false;
    if (!selectedChartGuideKey) return false;

    return (
      normalizeMarketGuideKey(position.marketSymbol) === selectedChartGuideKey ||
      normalizeMarketGuideKey(position.marketName) === selectedChartGuideKey ||
      normalizeMarketGuideKey(position.marketAddress) === selectedChartGuideKey ||
      normalizeMarketGuideKey(position.custodyAddress) === selectedChartGuideKey
    );
  });
  const selectedChartGuides = useMemo(() => {
    if (selectedChartPerpsPositions.length === 0) return [];

    const guides: Array<{ id: string; label: string; price: number; tone: "entry" | "tp" | "sl" }> = [];

    selectedChartPerpsPositions.forEach((position, index) => {
      const labelPrefix = selectedChartPerpsPositions.length > 1 ? `${index + 1} ` : "";

      if (typeof position.entryPrice === "number" && Number.isFinite(position.entryPrice)) {
        guides.push({
          id: `${position.id}-entry`,
          label: `${labelPrefix}Entry`,
          price: position.entryPrice,
          tone: "entry",
        });
      }

      if (typeof position.takeProfit === "number" && Number.isFinite(position.takeProfit)) {
        guides.push({
          id: `${position.id}-tp`,
          label: `${labelPrefix}TP`,
          price: position.takeProfit,
          tone: "tp",
        });
      }

      if (typeof position.stopLoss === "number" && Number.isFinite(position.stopLoss)) {
        guides.push({
          id: `${position.id}-sl`,
          label: `${labelPrefix}SL`,
          price: position.stopLoss,
          tone: "sl",
        });
      }
    });

    return guides;
  }, [selectedChartPerpsPositions]);

  const cards = trackedMarkets.map((market) => {
    const points = priceHistory[market.id] ?? [];
    const current = points[points.length - 1]?.v ?? 0;
    const change24h = dayChange24h[market.id] ?? 0;
    return { ...market, current, change24h };
  });
  const selectedChartCard = cards.find((market) => market.id === selectedChartSlotId) ?? cards[0];

  const pnlTokenOptions = useMemo(() => {
    const byMint = new Map<string, string>();
    byMint.set(SOL_MINT, "SOL");
    walletTokens.forEach((token) => {
      if (token.mint) {
        byMint.set(token.mint, token.symbol ?? token.name ?? shortAddress(token.mint));
      }
    });
    recentTrades.forEach((trade) => {
      if (trade.inputMint) byMint.set(trade.inputMint, KNOWN_TOKEN_BY_MINT[trade.inputMint] ?? shortAddress(trade.inputMint));
      if (trade.outputMint) byMint.set(trade.outputMint, KNOWN_TOKEN_BY_MINT[trade.outputMint] ?? shortAddress(trade.outputMint));
    });
    return [...byMint.entries()].map(([mint, label]) => ({ mint, label }));
  }, [recentTrades, walletTokens]);

  useEffect(() => {
    if (!pnlTokenOptions.some((option) => option.mint === pnlTokenMint)) {
      setPnlTokenMint(pnlTokenOptions[0]?.mint ?? PNL_DEFAULT_MINT);
    }
  }, [pnlTokenMint, pnlTokenOptions]);

  const selectedTokenUsdPrice = useMemo(() => {
    if (pnlTokenMint === USDC_MINT) return 1;
    if (pnlTokenMint === SOL_MINT) {
      if (solValueUsd !== null && solBalance !== null && solBalance > 0) {
        const derived = solValueUsd / solBalance;
        if (Number.isFinite(derived) && derived > 0) return derived;
      }
    }
    const token = walletTokens.find((item) => item.mint === pnlTokenMint);
    const price = Number(token?.usdPrice ?? 0);
    if (Number.isFinite(price) && price > 0) return price;
    return pnlTokenMint === USDC_MINT ? 1 : 0;
  }, [pnlTokenMint, solBalance, solValueUsd, walletTokens]);

  const pnlTimeline = useMemo(() => {
    const trades = [...recentTrades]
      .filter((trade) => Number.isFinite(trade.timestamp))
      .sort((a, b) => a.timestamp - b.timestamp);
    let cumulative = 0;
    const points: WalletPnlPoint[] = [];

    trades.forEach((trade) => {
      let delta = 0;
      if (trade.inputMint === pnlTokenMint && Number.isFinite(trade.inputAmount)) {
        delta -= Number(trade.inputAmount);
      }
      if (trade.outputMint === pnlTokenMint && Number.isFinite(trade.outputAmount)) {
        delta += Number(trade.outputAmount);
      }
      cumulative += delta * selectedTokenUsdPrice;
      points.push({ t: trade.timestamp, v: cumulative });
    });

    if (points.length > 0) return points;
    return [{ t: Date.now(), v: 0 }];
  }, [pnlTokenMint, recentTrades, selectedTokenUsdPrice]);

  useEffect(() => {
    if (!remoteSyncWalletAddress || !remoteAuthToken) {
      setRemotePnlPoints([{ t: Date.now(), v: 0 }]);
      return;
    }

    fetch(`/api/wallet/pnl?address=${remoteSyncWalletAddress}`, { cache: "no-store" })
      .then((response) => response.json())
      .then((payload) => {
        const points = Array.isArray(payload?.points)
          ? (payload.points as WalletPnlPoint[]).filter((point) => Number.isFinite(point.t) && Number.isFinite(point.v))
          : [];
        setRemotePnlPoints(points.length > 0 ? points : [{ t: Date.now(), v: 0 }]);
      })
      .catch(() => {
        setRemotePnlPoints([{ t: Date.now(), v: 0 }]);
      });
  }, [remoteAuthToken, remoteSyncWalletAddress]);

  useEffect(() => {
    const tokenLabel = pnlTokenOptions.find((option) => option.mint === pnlTokenMint)?.label ?? "token";
    if (pnlMode === "chain") {
      setPnlStatus("Tracking on-chain Jupiter swap PnL from remote wallet history (secondary mode).");
      return;
    }
    if (recentTrades.length === 0) {
      setPnlStatus(`No recent trades. PnL reset for ${tokenLabel}.`);
      return;
    }
    const priceHint = selectedTokenUsdPrice > 0 ? ` @ ${formatUsd(selectedTokenUsdPrice)}` : "";
    setPnlStatus(`Tracking ${tokenLabel} PnL in USD from recent trades since last clear${priceHint}.`);
  }, [pnlMode, pnlTokenMint, pnlTokenOptions, recentTrades.length, selectedTokenUsdPrice]);

  const displayedPnlTimeline = pnlMode === "app" ? pnlTimeline : remotePnlPoints;

  const pnlValues = useMemo(() => {
    const latest = displayedPnlTimeline[displayedPnlTimeline.length - 1];
    const latestValue = latest?.v ?? 0;
    const now = Date.now();
    const yearStart = new Date(new Date().getFullYear(), 0, 1).getTime();

    const calcSince = (cutoff: number) => {
      const base = displayedPnlTimeline.find((point) => point.t >= cutoff) ?? displayedPnlTimeline[0];
      return latestValue - (base?.v ?? 0);
    };

    return {
      d24: calcSince(now - 24 * 60 * 60 * 1000),
      d7: calcSince(now - 7 * 24 * 60 * 60 * 1000),
      d30: calcSince(now - 30 * 24 * 60 * 60 * 1000),
      ytd: calcSince(yearStart),
    };
  }, [displayedPnlTimeline]);

  const pnlChartPoints = useMemo(() => {
    const now = Date.now();
    const cutoff = pnlRange === "24h"
      ? now - 24 * 60 * 60 * 1000
      : pnlRange === "7d"
        ? now - 7 * 24 * 60 * 60 * 1000
        : pnlRange === "30d"
          ? now - 30 * 24 * 60 * 60 * 1000
          : new Date(new Date().getFullYear(), 0, 1).getTime();

    const filtered = displayedPnlTimeline.filter((point) => point.t >= cutoff);
    if (filtered.length >= 2) return filtered;
    const fallback = displayedPnlTimeline[displayedPnlTimeline.length - 1] ?? { t: now, v: 0 };
    return [{ t: cutoff, v: fallback.v }, fallback];
  }, [displayedPnlTimeline, pnlRange]);

  const pnlChartPolyline = useMemo(() => {
    const width = 640;
    const height = 220;
    const minX = pnlChartPoints[0]?.t ?? Date.now();
    const maxX = pnlChartPoints[pnlChartPoints.length - 1]?.t ?? minX + 1;
    const values = pnlChartPoints.map((point) => point.v);
    const minY = Math.min(...values, 0);
    const maxY = Math.max(...values, 0);
    const xSpan = Math.max(1, maxX - minX);
    const ySpan = Math.max(1e-6, maxY - minY);

    return pnlChartPoints
      .map((point) => {
        const x = ((point.t - minX) / xSpan) * width;
        const y = height - ((point.v - minY) / ySpan) * height;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");
  }, [pnlChartPoints]);

  function updateTrackedMarket(slotId: string, nextProduct: string) {
    const option = marketOptions.find((item) => item.coinbaseProduct === nextProduct);
    if (!option) return;
    const previousPair = trackedMarkets.find((market) => market.id === slotId)?.pair;

    setTrackedMarkets((prev) =>
      prev.map((market) => (market.id === slotId ? { ...market, ...option } : market))
    );
    setPriceHistory((prev) => ({ ...prev, [slotId]: [] }));
    setDayChange24h((prev) => ({ ...prev, [slotId]: 0 }));
    setLastSignalAt((prev) => {
      const next = { ...prev };
      delete next[slotId];
      return next;
    });
    if (previousPair) {
      setSignals((prev) => prev.filter((signal) => signal.symbol !== previousPair));
    }
    setSelectedChartSlotId(slotId);
    setReceiveSignalsForSlotId(slotId);
  }

  async function enablePush() {
    if (!pushReady) return;
    if (nativeShell) {
      const { hasLocalNotifications, hasPushNotifications } = getNativePushPluginStatus();
      if (!hasLocalNotifications) {
        setPushStatus("Native notifications plugin missing in this app build");
        return;
      }
      try {
        const localPermission = await LocalNotifications.requestPermissions();
        const pushPermission = hasPushNotifications
          ? await PushNotifications.requestPermissions()
          : { receive: "prompt" as const };
        if (localPermission.display !== "granted") {
          writeNativeAlertsEnabled(false);
          setPushEnabled(false);
          setPushStatus("Native alerts disabled");
          return;
        }
        if (!hasPushNotifications) {
          writeNativeAlertsEnabled(true);
          setNativePushIssue("APNs push is not included in this installed app build yet.");
          setPushEnabled(true);
          setPushStatus("Local native alerts enabled. Reinstall the iPhone app build to add APNs push.");
          return;
        }
        if (pushPermission.receive !== "granted") {
          writeNativeAlertsEnabled(false);
          setPushEnabled(false);
          setPushStatus("Native push disabled");
          return;
        }
        await PushNotifications.register();
        setNativePushIssue(null);
        writeNativeAlertsEnabled(true);
        setPushEnabled(true);
        setPushStatus("Native alerts enabled, registering APNs token...");
      } catch (error) {
        setPushStatus(error instanceof Error ? error.message : "Native alerts could not be enabled");
      }
      return;
    }

    if (!("Notification" in window)) {
      setPushStatus("Notifications not supported");
      return;
    }

    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      setPushEnabled(false);
      setPushStatus("Alerts disabled");
      return;
    }

    const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
    if (!publicKey) {
      setPushStatus("Missing VAPID public key");
      return;
    }

    try {
      const registration = await navigator.serviceWorker.ready;
      const existing = await registration.pushManager.getSubscription();
      const activeSubscription =
        existing ??
        (await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(publicKey),
        }));

      const subscriptionJson = activeSubscription.toJSON();
      const response = await fetch("/api/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...subscriptionJson,
          walletAddress,
          nativeShell: false,
          platform: "web",
        }),
      });

      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setPushStatus(payload?.error ?? "Push subscribe failed");
        return;
      }

      setSubscription(subscriptionJson);
      setPushEnabled(true);
      setPushStatus("Alerts enabled");
    } catch (error) {
      setPushStatus(error instanceof Error ? error.message : "Push subscribe failed");
    }
  }

  async function disablePush() {
    if (nativeShell) {
      writeNativeAlertsEnabled(false);
      setNativePushIssue(null);
      if (nativePushToken) {
        await fetch("/api/push/native/unsubscribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: nativePushToken }),
        }).catch(() => undefined);
      }
      setNativePushToken(null);
      setPushEnabled(false);
      setPushStatus("Native alerts disabled");
      return;
    }

    try {
      const registration = await navigator.serviceWorker.ready;
      const active = await registration.pushManager.getSubscription();
      const endpoint = active?.endpoint ?? subscription?.endpoint;
      if (active) {
        await active.unsubscribe();
      }
      if (endpoint) {
        await fetch("/api/push/unsubscribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ endpoint }),
        }).catch(() => undefined);
      }
      setSubscription(null);
      setPushEnabled(false);
      setPushStatus("Alerts disabled");
    } catch (error) {
      setPushStatus(error instanceof Error ? error.message : "Failed to disable alerts");
    }
  }

  async function togglePush() {
    if (pushEnabled) {
      await disablePush();
      return;
    }
    await enablePush();
  }

  async function sendTestPush() {
    if (nativeShell) {
      if (!pushEnabled) {
        setPushStatus("Enable native alerts first");
        return;
      }
      const { hasPushNotifications } = getNativePushPluginStatus();
      if (!hasPushNotifications) {
        try {
        await LocalNotifications.schedule({
          notifications: [
            {
              id: Date.now() % 2147483000,
              title: "BremLogic",
              body: "Local native notification works. Install the rebuilt iPhone app to test APNs push.",
              sound: NATIVE_NOTIFICATION_SOUNDS.signal,
            },
          ],
        });
          setPushStatus("Local native test alert sent. APNs push requires the rebuilt app binary.");
        } catch (error) {
          setPushStatus(error instanceof Error ? error.message : "Native local test alert failed");
        }
        return;
      }
      if (!nativePushToken) {
        setPushStatus("Waiting for APNs device token");
        return;
      }
      try {
        const response = await fetch("/api/push/test", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            nativeToken: nativePushToken,
            walletAddress,
            sound: NATIVE_NOTIFICATION_SOUNDS.signal,
          }),
        });
        const payload = await response.json().catch(() => null);
        if (!response.ok) {
          setPushStatus(payload?.error ?? "Native push test failed");
          return;
        }
        setPushStatus("Native test push sent");
      } catch (error) {
        setPushStatus(error instanceof Error ? error.message : "Native push test failed");
      }
      return;
    }

    if (!pushEnabled || !subscription) {
      setPushStatus("Enable push first");
      return;
    }

    setPushStatus("Sending test...");
    try {
      const response = await fetch("/api/push/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subscription, walletAddress, sound: NATIVE_NOTIFICATION_SOUNDS.signal }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setPushStatus(payload?.error ?? "Push test failed");
        return;
      }
      setPushStatus("Test push sent");
    } catch (_error) {
      setPushStatus("Push test failed");
    }
  }

  async function createInAppWallet() {
    const passwordInput = window.prompt(
      "Set wallet password (4-16 chars). Leave blank to use default 'bremlogic':",
      DEFAULT_WALLET_PASSWORD
    );
    try {
      await wallet.createWallet((passwordInput ?? "").trim() || DEFAULT_WALLET_PASSWORD);
      setRemoteAuthSource("in-app");
      setRemoteAuthToken(null);
      setRemoteAuthAddress(null);
      setPortfolioStatus("In-app wallet created");
    } catch (_error) {
      setPortfolioStatus("Wallet creation failed");
    }
  }

  async function importInAppWallet() {
    const secretInput = window.prompt("Paste wallet private key (base58):");
    if (!secretInput) return;
    const passwordInput = window.prompt(
      "Enter wallet password (4-16 chars). Leave blank for default 'bremlogic':",
      DEFAULT_WALLET_PASSWORD
    );
    try {
      await wallet.importWallet(secretInput, (passwordInput ?? "").trim() || DEFAULT_WALLET_PASSWORD);
      setRemoteAuthSource("in-app");
      setRemoteAuthToken(null);
      setRemoteAuthAddress(null);
      setPortfolioStatus("In-app wallet imported");
    } catch (_error) {
      setPortfolioStatus("Wallet import failed");
    }
  }

  async function exportInAppWallet() {
    const exported = wallet.exportWallet();
    if (!exported) {
      setPortfolioStatus("No in-app wallet to export");
      return;
    }
    try {
      await navigator.clipboard.writeText(exported);
      setPortfolioStatus("Wallet secret copied to clipboard");
    } catch (_error) {
      setPortfolioStatus("Copy failed - check browser clipboard permissions");
    }
  }

  async function disconnectInAppWallet() {
    await wallet.disconnect();
    if (walletAddress) {
      try {
        window.localStorage.removeItem(remoteTradesAuthStorageKey(walletAddress));
      } catch {
        // ignore storage errors
      }
    }
    if (remoteAuthSource === "in-app") {
      setRemoteAuthSource(phantomAuthAddress ? "phantom" : null);
      setRemoteAuthToken(null);
      setRemoteAuthAddress(null);
    }
    setShowDepositModal(false);
    setPortfolioStatus("Wallet disconnected and removed from this device");
  }

  async function loginInAppWallet() {
    const passwordInput = window.prompt("Enter wallet password:", DEFAULT_WALLET_PASSWORD);
    if (passwordInput === null) return;
    try {
      await wallet.login((passwordInput ?? "").trim() || DEFAULT_WALLET_PASSWORD);
      setRemoteAuthSource("in-app");
      setRemoteAuthToken(null);
      setRemoteAuthAddress(null);
      setPortfolioStatus("Wallet unlocked");
    } catch (_error) {
      setPortfolioStatus("Wallet login failed");
    }
  }

  async function changeWalletPassword() {
    if (!wallet.connected) {
      setPortfolioStatus("Connect wallet before changing password");
      return;
    }

    const currentPassword = window.prompt("Enter current password:", DEFAULT_WALLET_PASSWORD);
    if (currentPassword === null) return;
    const nextPassword = window.prompt("Enter new password (4-16 chars):");
    if (nextPassword === null) return;
    const confirmText = window.prompt("Type CHANGE to confirm password update:");
    if (confirmText !== "CHANGE") {
      setPortfolioStatus("Password change cancelled");
      return;
    }

    try {
      await wallet.changePassword((currentPassword || DEFAULT_WALLET_PASSWORD).trim(), nextPassword.trim());
      setPortfolioStatus("Wallet password updated");
    } catch (_error) {
      setPortfolioStatus("Password update failed");
    }
  }

  async function copyDepositAddress() {
    if (!wallet.publicKey) return;
    try {
      await navigator.clipboard.writeText(wallet.publicKey.toBase58());
      setPortfolioStatus("Deposit address copied to clipboard");
    } catch (_error) {
      setPortfolioStatus("Address copy failed");
    }
  }

  async function clearRecentTrades() {
    const activeWallet = tradeStorageAddress;
    setRecentTrades([]);
    setPendingTakeProfit(null);
    pendingTakeProfitRef.current = null;
    setPnlStatus("No recent trades. PnL reset.");
    if (remoteAuthToken) {
      await fetch("/api/trades", {
        method: "DELETE",
        headers: { Authorization: `Bearer ${remoteAuthToken}` },
      }).then(async (response) => {
        if (response.ok) {
          setRemoteSyncStatus("Remote trades cleared");
          return;
        }
        if (response.status === 401 && remoteSyncWalletAddress) {
          try {
            window.localStorage.removeItem(remoteTradesAuthStorageKey(remoteSyncWalletAddress));
          } catch {
            // ignore storage errors
          }
          setRemoteAuthToken(null);
          setRemoteAuthAddress(null);
          setRemoteAuthStatus("Remote auth expired. Re-sign to continue syncing.");
        }
      }).catch(() => undefined);
    }
    try {
      window.localStorage.removeItem(tradesStorageKey(activeWallet));
    } catch (_error) {
      // ignore storage errors
    }
  }

  function clearRecentSignals() {
    setSignals([]);
    setLastSignalAt({});
  }

  async function handleManualSwapSuccess(result: JupiterTradeRecord) {
    const manualTradeRecord: StoredTradeRecord = {
      id: `manual-${result.txid}-${Date.now()}`,
      txid: result.txid,
      timestamp: Date.now(),
      walletAddress: wallet.publicKey?.toBase58() ?? result.walletAddress,
      source: "manual",
      inputMint: result.inputMint,
      outputMint: result.outputMint,
      inputAmount: result.inputAmount,
      outputAmount: result.outputAmount,
      signalSummary: "Jupiter widget manual swap",
      gasless: false,
    };
    await persistTradeRecord(manualTradeRecord);
    refreshWalletPortfolio().catch(() => undefined);
  }

  function persistAutoTradeSettings(next: AutoTradeSettings) {
    setAutoTradeSettings(next);
    try {
      window.localStorage.setItem(AUTO_TRADE_SETTINGS_STORAGE_KEY, JSON.stringify(next));
    } catch (_error) {
      // ignore storage errors
    }
  }

  function updateAutoTradeSlotToken(slotId: string, token: AutoTradeToken) {
    const next: AutoTradeSettings = {
      ...autoTradeSettings,
      slots: autoTradeSettings.slots.map((slot) => (slot.id === slotId ? { ...slot, token } : slot)),
    };
    persistAutoTradeSettings(next);
    if (next.activeSlotId === slotId) {
      setAutoTradeStatus(
        `Auto-trade is on (${token}, ${next.walletPercent}% allocation, ${next.mode === "buy-only" ? "Buy Only" : "All"})`
      );
    }
    if (next.perpsActiveSlotId === slotId) {
      setPerpsAutoTradeStatus(
        `Perps auto-trade is on (${token}, ${next.walletPercent}% collateral, ${next.perpsLeverage}x, ${next.mode === "buy-only" ? "Buy Only" : "All"})`
      );
    }
  }

  function toggleAutoTradeSlot(slotId: string, enabled: boolean) {
    if (enabled && autoTradeSettings.activeSlotId && autoTradeSettings.activeSlotId !== slotId) {
      setShowAutoTradeSelectorWarning(true);
      return;
    }

    const nextActiveSlotId = enabled ? slotId : null;
    const slot = autoTradeSettings.slots.find((item) => item.id === slotId);
    const token = slot ? getAutoTradeTokenOption(slot.token) : null;
    const next: AutoTradeSettings = {
      ...autoTradeSettings,
      activeSlotId: nextActiveSlotId,
    };
    persistAutoTradeSettings(next);
    setAutoTradeStatus(
      enabled && token
        ? `Auto-trade is on (${token.symbol}, ${next.walletPercent}% allocation, ${next.mode === "buy-only" ? "Buy Only" : "All"})`
        : "Auto-trade is off"
    );
  }

  function togglePerpsAutoTradeSlot(slotId: string, enabled: boolean) {
    if (enabled && autoTradeSettings.perpsActiveSlotId && autoTradeSettings.perpsActiveSlotId !== slotId) {
      setShowAutoTradeSelectorWarning(true);
      return;
    }

    const nextPerpsActiveSlotId = enabled ? slotId : null;
    const slot = autoTradeSettings.slots.find((item) => item.id === slotId);
    const token = slot ? getAutoTradeTokenOption(slot.token) : null;
    const next: AutoTradeSettings = {
      ...autoTradeSettings,
      perpsActiveSlotId: nextPerpsActiveSlotId,
    };
    persistAutoTradeSettings(next);
    setPerpsAutoTradeStatus(
      enabled && token
        ? `Perps auto-trade is on (${token.symbol}, ${next.walletPercent}% collateral, ${next.perpsLeverage}x, ${next.mode === "buy-only" ? "Buy Only" : "All"})`
        : "Perps auto-trade is off"
    );
  }

  function updateAutoTradeMode(mode: AutoTradeMode) {
    const next: AutoTradeSettings = {
      ...autoTradeSettings,
      mode,
    };
    persistAutoTradeSettings(next);
  }

  function toggleDisableTpLock(disabled: boolean) {
    const next: AutoTradeSettings = {
      ...autoTradeSettings,
      disableTpLock: disabled,
    };
    if (disabled) {
      setPendingTakeProfit(null);
      pendingTakeProfitRef.current = null;
    }
    persistAutoTradeSettings(next);
  }

  function updatePerpsLeverage(value: number) {
    const perpsLeverage = Number.isFinite(value) ? Math.min(250, Math.max(1, Number(value.toFixed(2)))) : DEFAULT_AUTO_TRADE_SETTINGS.perpsLeverage;
    const next: AutoTradeSettings = {
      ...autoTradeSettings,
      perpsLeverage,
    };
    persistAutoTradeSettings(next);
  }

  function saveSignalParams() {
    try {
      window.localStorage.setItem(PARAMS_STORAGE_KEY, JSON.stringify(params));
      window.localStorage.setItem(AUTO_TRADE_SETTINGS_STORAGE_KEY, JSON.stringify(autoTradeSettings));
      setParamsSaveStatus("Saved");
    } catch (_error) {
      setParamsSaveStatus("Save failed");
    }
  }

  function resetSignalParams() {
    setParams(DEFAULT_PARAMS);
    setAutoTradeSettings(DEFAULT_AUTO_TRADE_SETTINGS);
    setPendingTakeProfit(null);
    pendingTakeProfitRef.current = null;
    setAutoTradeStatus("Auto-trade is off");
    setPerpsAutoTradeStatus("Perps auto-trade is off");
    try {
      window.localStorage.removeItem(PARAMS_STORAGE_KEY);
      window.localStorage.removeItem(AUTO_TRADE_SETTINGS_STORAGE_KEY);
    } catch (_error) {
      // ignore storage errors
    }
    setParamsSaveStatus("Reset to defaults");
  }

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(DASHBOARD_LAYOUT_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as DashboardSectionLayout[];
      if (!Array.isArray(parsed)) return;
      const normalized = DEFAULT_DASHBOARD_LAYOUT.map((defaults) => {
        const existing = parsed.find((item) => item?.id === defaults.id);
        return {
          id: defaults.id,
          width: Number.isFinite(existing?.width) ? Math.max(320, Number(existing?.width)) : defaults.width,
          height: Number.isFinite(existing?.height) ? Math.max(260, Number(existing?.height)) : defaults.height,
        };
      });
      setDashboardLayout(normalized);
    } catch {
      setDashboardLayout(DEFAULT_DASHBOARD_LAYOUT);
    }
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(DASHBOARD_LAYOUT_STORAGE_KEY, JSON.stringify(dashboardLayout));
    } catch {
      // ignore storage errors
    }
  }, [dashboardLayout]);

  function getSectionLayout(id: DashboardSectionId) {
    return dashboardLayout.find((section) => section.id === id) ??
      DEFAULT_DASHBOARD_LAYOUT.find((section) => section.id === id) ??
      { id, width: 520, height: 400 };
  }

  function reorderDashboardSections(sourceId: DashboardSectionId, targetId: DashboardSectionId) {
    if (sourceId === targetId) return;
    setDashboardLayout((previous) => {
      const next = [...previous];
      const sourceIndex = next.findIndex((section) => section.id === sourceId);
      const targetIndex = next.findIndex((section) => section.id === targetId);
      if (sourceIndex < 0 || targetIndex < 0) return previous;
      const [moved] = next.splice(sourceIndex, 1);
      next.splice(targetIndex, 0, moved);
      return next;
    });
  }

  function startResizeSection(id: DashboardSectionId, event: ReactPointerEvent<HTMLButtonElement>) {
    const layout = getSectionLayout(id);
    resizeStateRef.current = {
      id,
      startX: event.clientX,
      startY: event.clientY,
      startWidth: layout.width,
      startHeight: layout.height,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function resizeSection(event: ReactPointerEvent<HTMLButtonElement>) {
    const state = resizeStateRef.current;
    if (!state) return;
    const deltaX = event.clientX - state.startX;
    const deltaY = event.clientY - state.startY;
    const width = Math.max(320, Math.round(state.startWidth + deltaX));
    const height = Math.max(260, Math.round(state.startHeight + deltaY));
    setDashboardLayout((previous) =>
      previous.map((section) => (section.id === state.id ? { ...section, width, height } : section))
    );
  }

  function stopResizeSection() {
    resizeStateRef.current = null;
  }

  function renderDashboardSection(id: DashboardSectionId) {
    if (id === "chart") {
      return (
        <>
          <div className="tradingview-wrap">
            <TradingViewChart
              symbol={selectedChartMarket?.tvSymbol ?? "COINBASE:SOLUSD"}
              pricePoints={selectedChartPricePoints}
              guides={selectedChartGuides}
            />
          </div>
        </>
      );
    }

    if (id === "wallet") {
      return (
        <>
          <div className="wallet-controls">
            {!wallet.hasWallet ? <button onClick={createInAppWallet}>Create Wallet</button> : null}
            <button className="secondary" onClick={importInAppWallet}>Import Wallet</button>
            {wallet.hasWallet ? <button className="secondary" onClick={exportInAppWallet}>Export Wallet</button> : null}
            {wallet.connected ? <button onClick={() => setShowDepositModal(true)}>Deposit</button> : null}
            {wallet.hasWallet && !wallet.connected ? <button onClick={loginInAppWallet}>Login</button> : null}
            {wallet.connected ? <button className="secondary" onClick={changeWalletPassword}>Change Password</button> : null}
            {wallet.connected ? <button onClick={disconnectInAppWallet}>Disconnect</button> : null}
            <button className="secondary" onClick={refreshWalletPortfolio}>Refresh Wallet</button>
          </div>
          <div className="subtext" style={{ marginTop: 8 }}>
            Wallet keys are stored in this browser until you disconnect (which removes them from this device).
          </div>
          <div className="subtext" style={{ marginTop: 10 }}>
            {wallet.publicKey
              ? `Address: ${shortAddress(wallet.publicKey.toBase58())}`
              : "Create or import an in-app wallet to start tracking balances and queueing trades."}
          </div>
          <div className="subtext" style={{ marginTop: 6 }}>{portfolioStatus}</div>
          <div className="wallet-trading-panel wallet-trading-panel-swap" style={{ marginTop: 10 }}>
            <JupiterTradePanel
              onTradeSuccess={handleManualSwapSuccess}
              integratedTargetId="bremlogic-manual-swap-widget"
              passthroughWalletContextState={wallet.passthroughWalletContextState}
              onRequestConnectWallet={wallet.hasWallet && !wallet.connected ? loginInAppWallet : undefined}
            />
          </div>
          <div className="wallet-holdings">
            <div className="holding-row total-row">
              <span>Total Balance</span>
              <strong>{totalBalanceUsd === null ? "-" : formatUsd(totalBalanceUsd)}</strong>
            </div>
            <div className="holding-row token-row">
              <span className="token-meta">
                <Image
                  src="https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/solana/info/logo.png"
                  alt="Solana"
                  className="token-icon"
                  width={20}
                  height={20}
                  unoptimized
                />
                <span className="token-lines">
                  <span className="token-line token-top">Solana</span>
                  <span className="token-line token-bottom">SOL</span>
                </span>
              </span>
              <span className="token-values">
                <span className="token-line token-top">{solValueUsd === null ? "-" : formatUsd(solValueUsd)}</span>
                <span className="token-line token-bottom">{solBalance === null ? "-" : solBalance.toFixed(4)}</span>
              </span>
            </div>
            {walletTokens.map((token) => (
              <div key={token.mint} className="holding-row token-row">
                <span className="token-meta">
                  {token.logoURI ? (
                    <Image
                      src={token.logoURI}
                      alt={token.symbol ?? token.name ?? token.mint}
                      className="token-icon"
                      width={20}
                      height={20}
                      unoptimized
                    />
                  ) : null}
                  <span className="token-lines">
                    <span className="token-line token-top">{token.name ?? token.symbol ?? shortAddress(token.mint)}</span>
                    <span className="token-line token-bottom">{shortAddress(token.mint)}</span>
                  </span>
                </span>
                <span className="token-values">
                  <span className="token-line token-top">{token.usdValue !== null && token.usdValue !== undefined ? formatUsd(token.usdValue) : "-"}</span>
                  <span className="token-line token-bottom">{token.amount.toFixed(4)}</span>
                </span>
              </div>
            ))}
          </div>
        </>
      );
    }

    if (id === "perps") {
      return <JupiterPerpsPositionWidget onSnapshotChange={setReadOnlyPerpsSnapshot} onControllerChange={setJupiterPerpsController} />;
    }

    if (id === "pnl") {
      return (
        <>
          <div className="subtext" style={{ marginBottom: 10 }}>{pnlStatus}</div>
          <div className="subtext" style={{ marginBottom: 10 }}>
            Remote status · auth: {remoteAuthStatus} · sync: {remoteSyncStatus}
          </div>
          <div className="pnl-metrics">
            <div className="pnl-metric"><span>24hr</span><strong className={pnlValues.d24 >= 0 ? "pnl-positive" : "pnl-negative"}>{formatUsd(pnlValues.d24)}</strong></div>
            <div className="pnl-metric"><span>7-day</span><strong className={pnlValues.d7 >= 0 ? "pnl-positive" : "pnl-negative"}>{formatUsd(pnlValues.d7)}</strong></div>
            <div className="pnl-metric"><span>30-day</span><strong className={pnlValues.d30 >= 0 ? "pnl-positive" : "pnl-negative"}>{formatUsd(pnlValues.d30)}</strong></div>
            <div className="pnl-metric"><span>YTD</span><strong className={pnlValues.ytd >= 0 ? "pnl-positive" : "pnl-negative"}>{formatUsd(pnlValues.ytd)}</strong></div>
          </div>
          <div className="wallet-controls" style={{ marginTop: 8 }}>
            <button type="button" className={pnlMode === "app" ? "" : "secondary"} onClick={() => setPnlMode("app")}>App Trades (Primary)</button>
            <button type="button" className={pnlMode === "chain" ? "" : "secondary"} onClick={() => setPnlMode("chain")}>On-Chain (Secondary)</button>
          </div>
          <div className="wallet-controls" style={{ marginTop: 8 }}>
            <button type="button" className={pnlRange === "24h" ? "" : "secondary"} onClick={() => setPnlRange("24h")}>24H</button>
            <button type="button" className={pnlRange === "7d" ? "" : "secondary"} onClick={() => setPnlRange("7d")}>7D</button>
            <button type="button" className={pnlRange === "30d" ? "" : "secondary"} onClick={() => setPnlRange("30d")}>30D</button>
            <button type="button" className={pnlRange === "ytd" ? "" : "secondary"} onClick={() => setPnlRange("ytd")}>YTD</button>
            <select
              value={pnlTokenMint}
              onChange={(event) => setPnlTokenMint(event.target.value)}
              style={{ maxWidth: 180 }}
              disabled={pnlMode === "chain"}
              aria-label="PnL token selection"
            >
              {pnlTokenOptions.map((option) => (
                <option key={option.mint} value={option.mint}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <div className="pnl-chart-wrap">
            <svg viewBox="0 0 640 220" role="img" aria-label="PnL chart">
              <polyline points={pnlChartPolyline} fill="none" stroke="var(--accent)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
        </>
      );
    }

    if (id === "params") {
      return (
        <>
          <div className="controls params-toolbar">
            <div className="subtext">{paramsSaveStatus}</div>
            <button type="button" onClick={saveSignalParams}>Save</button>
            <button type="button" className="secondary" onClick={resetSignalParams}>Reset</button>
          </div>
          <div className="controls">
            <label>
              Receive Signals For
              <button type="button" className="secondary" style={{ marginTop: 8 }} onClick={() => setEditingSignalTarget((prev) => !prev)}>
                {selectedSignalMarket?.pair ?? "Select Market"}
              </button>
              {editingSignalTarget ? (
                <select style={{ marginTop: 8 }} value={selectedSignalMarket?.coinbaseProduct ?? ""} onChange={(event) => { updateTrackedMarket(receiveSignalsForSlotId, event.target.value); setEditingSignalTarget(false); }}>
                  {marketOptions.map((option) => (<option key={option.coinbaseProduct} value={option.coinbaseProduct}>{option.pair}</option>))}
                </select>
              ) : null}
            </label>
            <label>Trend window (min)<StepperNumberInput value={params.trendWindow} min={1} max={180} step={1} inputMode="numeric" onChange={(value) => setParams((prev) => ({ ...prev, trendWindow: value }))} /></label>
            <label>Trend threshold %<StepperNumberInput value={params.trendThreshold} min={0.1} max={10} step={0.1} onChange={(value) => setParams((prev) => ({ ...prev, trendThreshold: value }))} /></label>
            <label>Breakout %<StepperNumberInput value={params.breakoutPercent} min={0.8} max={8} step={0.2} onChange={(value) => setParams((prev) => ({ ...prev, breakoutPercent: value }))} /></label>
            <label>Cooldown (sec)<StepperNumberInput value={params.cooldownSeconds} min={5} max={900} step={5} inputMode="numeric" onChange={(value) => setParams((prev) => ({ ...prev, cooldownSeconds: value }))} /></label>
            <label>
              Auto-trade wallet allocation (%)
              <StepperNumberInput
                value={autoTradeSettings.walletPercent}
                min={1}
                max={100}
                step={1}
                inputMode="numeric"
                onChange={(value) => {
                  const walletPercent = Number.isFinite(value) ? Math.min(100, Math.max(1, Math.round(value))) : DEFAULT_AUTO_TRADE_SETTINGS.walletPercent;
                  const next = { ...autoTradeSettings, walletPercent };
                  persistAutoTradeSettings(next);
                }}
              />
            </label>
            <label>
              Take Profit % (bull buys only)
              <StepperNumberInput
                value={autoTradeSettings.takeProfitPercent}
                min={0}
                step={0.1}
                onChange={(value) => {
                  const takeProfitPercent = Number.isFinite(value) && value >= 0 ? value : 0;
                  const next = { ...autoTradeSettings, takeProfitPercent };
                  persistAutoTradeSettings(next);
                }}
              />
            </label>
            <label>
              Stop Loss % (Perps only)
              <StepperNumberInput
                value={autoTradeSettings.stopLossPercent}
                min={0}
                step={0.1}
                onChange={(value) => {
                  const stopLossPercent = Number.isFinite(value) && value >= 0 ? value : 0;
                  const next = { ...autoTradeSettings, stopLossPercent };
                  persistAutoTradeSettings(next);
                }}
              />
            </label>
            <label>
              Perps leverage
              <StepperNumberInput
                value={autoTradeSettings.perpsLeverage}
                min={1}
                max={250}
                step={0.5}
                onChange={updatePerpsLeverage}
              />
            </label>
            <label>
              Perps trade style
              <select
                value={autoTradeSettings.perpsExecutionMode}
                onChange={(event) => {
                  const perpsExecutionMode: PerpsExecutionMode =
                    event.target.value === "smart-trades" ? "smart-trades" : "set-parameters";
                  const next = { ...autoTradeSettings, perpsExecutionMode };
                  persistAutoTradeSettings(next);
                }}
              >
                <option value="set-parameters">Set Parameter Trades</option>
                <option value="smart-trades">Smart Trades</option>
              </select>
            </label>
            {autoTradeSettings.perpsExecutionMode === "smart-trades" ? (
              <label>
                Smart trade profile
                <select
                  value={autoTradeSettings.smartTradeProfile}
                  onChange={(event) => {
                    const smartTradeProfile: SmartTradeProfile =
                      event.target.value === "conservative" || event.target.value === "aggressive"
                        ? event.target.value
                        : "balanced";
                    const next = { ...autoTradeSettings, smartTradeProfile };
                    persistAutoTradeSettings(next);
                  }}
                >
                  <option value="conservative">Conservative</option>
                  <option value="balanced">Balanced</option>
                  <option value="aggressive">Aggressive</option>
                </select>
              </label>
            ) : null}
          </div>
          <div className="auto-trade-selector-wrap">
            <div className="auto-trade-selector-header">
              <strong>Auto-Trade Selector</strong>
              <span className="subtext">Bull signal: buy selected token with USDC. Bear signal: sell selected token to USDC.</span>
              <span className="subtext">
                Perps mode: {autoTradeSettings.perpsExecutionMode === "smart-trades"
                  ? `Smart Trades (${autoTradeSettings.smartTradeProfile}) adjusts collateral, leverage, TP, and SL from confidence and recent volatility.`
                  : "Set Parameter Trades uses the exact wallet %, leverage, TP, and SL values set above."}
              </span>
              {pendingTakeProfit && !autoTradeSettings.disableTpLock ? (
                <span className="subtext">
                  TP lock active: sell {pendingTakeProfit.amount.toFixed(6)} {pendingTakeProfit.tokenSymbol} at {formatUsd(pendingTakeProfit.targetPrice)}
                </span>
              ) : null}
            </div>
            <div className="auto-trade-mode-row">
              <div className="wallet-controls">
                <button
                  type="button"
                  className={autoTradeSettings.mode === "all" ? "" : "secondary"}
                  onClick={() => updateAutoTradeMode("all")}
                >
                  All
                </button>
                <button
                  type="button"
                  className={autoTradeSettings.mode === "buy-only" ? "" : "secondary"}
                  onClick={() => updateAutoTradeMode("buy-only")}
                >
                  Buy Only
                </button>
              </div>
              <label className="auto-trade-checkbox-row">
                <input
                  type="checkbox"
                  checked={autoTradeSettings.disableTpLock}
                  onChange={(event) => toggleDisableTpLock(event.target.checked)}
                />
                <span>Disable TP Lock</span>
              </label>
            </div>
            <div className="auto-trade-selector-grid">
              {autoTradeSettings.slots.map((slot) => (
                <div key={slot.id} className="auto-trade-slot">
                  <label>
                    Token
                    <select value={slot.token} onChange={(event) => updateAutoTradeSlotToken(slot.id, event.target.value as AutoTradeToken)}>
                      {AUTO_TRADE_TOKEN_OPTIONS.map((option) => (<option key={option.symbol} value={option.symbol}>{option.label}</option>))}
                    </select>
                  </label>
                  <label className="auto-trade-slot-toggle">
                    <span className="subtext">Auto-trade</span>
                    <input type="checkbox" checked={autoTradeSettings.activeSlotId === slot.id} onChange={(event) => toggleAutoTradeSlot(slot.id, event.target.checked)} />
                    <span>{autoTradeSettings.activeSlotId === slot.id ? "On" : "Off"}</span>
                  </label>
                  <label className="auto-trade-slot-toggle">
                    <span className="subtext">Perps auto-trade</span>
                    <input type="checkbox" checked={autoTradeSettings.perpsActiveSlotId === slot.id} onChange={(event) => togglePerpsAutoTradeSlot(slot.id, event.target.checked)} />
                    <span>{autoTradeSettings.perpsActiveSlotId === slot.id ? "On" : "Off"}</span>
                  </label>
                </div>
              ))}
            </div>
            {showAutoTradeSelectorWarning ? (
              <div className="auto-trade-selector-modal" role="alertdialog" aria-modal="true">
                <div className="auto-trade-selector-modal-card">
                  <strong>Only One Token Allowed For Each Auto-Trade Mode At A Time</strong>
                  <button type="button" style={{ marginTop: 10 }} onClick={() => setShowAutoTradeSelectorWarning(false)}>OK</button>
                </div>
              </div>
            ) : null}
          </div>
        </>
      );
    }

    if (id === "signals") {
      return (
        <>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
            <button className="secondary" onClick={clearRecentSignals}>Clear Signals</button>
          </div>
          {signals.length === 0 && <div className="subtext">Waiting for signal triggers.</div>}
          <div className="signals-scroll">
            {signals.map((signal) => (
              <div key={signal.id} className={`signal ${signal.direction === "bearish" ? "negative" : ""}`}>
                <div>
                  <div>{signal.symbol} · {signal.type.toUpperCase()}</div>
                  <div className="signal-meta">{signal.summary}</div>
                  <div className="subtext">Signal time: {new Date(signal.timestamp).toLocaleTimeString()}</div>
                </div>
                <div>{Math.round(signal.confidence * 100)}%</div>
              </div>
            ))}
          </div>
        </>
      );
    }

    if (id === "trades") {
      return (
        <>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
            <div className="wallet-controls"><button className="secondary" onClick={clearRecentTrades}>Clear Trades</button></div>
          </div>
          <div className="subtext">Local device view keeps the most recent {LOCAL_RECENT_TRADES_CAP} trades for quick history. Remote sync stores a longer canonical history for cross-device PnL.</div>
          <div className="subtext">Remote status · auth: {remoteAuthStatus} · sync: {remoteSyncStatus}</div>
          {!wallet.publicKey && recentTrades.length === 0 && (<div className="subtext">Connect a wallet for live execution. Auto-trade can still run paper executions.</div>)}
          {recentTrades.length === 0 && wallet.publicKey && (<div className="subtext">No recent trades recorded for this wallet yet.</div>)}
          <div className="recent-trades-scroll">
            {recentTrades.map((trade) => (
              <div key={trade.id} className="news-item">
                <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                  <span>{trade.source === "auto" ? "Auto trade" : "Manual trade"}</span>
                  <span className="subtext">{new Date(trade.timestamp).toLocaleTimeString()}</span>
                </div>
                {trade.signalSummary ? <div className="subtext">{trade.signalSummary}</div> : null}
                <div className="news-meta">
                  <span>{trade.txid.startsWith("auto-") || trade.txid.startsWith("manual-") ? trade.txid.slice(0, 20) : shortAddress(trade.txid)}</span>
                  {trade.txid.startsWith("auto-") ? (
                    <span>Simulated execution</span>
                  ) : trade.txid.startsWith("manual-") ? (
                    <span>Manual entry</span>
                  ) : (
                    <a href={`https://solscan.io/tx/${trade.txid}`} target="_blank" rel="noreferrer">View Tx</a>
                  )}
                </div>
              </div>
            ))}
          </div>
        </>
      );
    }

    return null;
  }

  function renderStructuredPanel(id: DashboardSectionId) {
    return (
      <article key={id} className="panel dashboard-panel dashboard-panel-static">
        <div className="dashboard-panel-toolbar">
          <div className="dashboard-panel-title-group">
            <span className="dashboard-panel-title">{DASHBOARD_SECTION_TITLES[id]}</span>
            {id === "chart" && selectedChartCard ? (
              <span className="subtext">
                {selectedChartCard.pair} {formatUsd(selectedChartCard.current)} · 24h {selectedChartCard.change24h >= 0 ? "+" : ""}
                {selectedChartCard.change24h.toFixed(2)}%
              </span>
            ) : null}
          </div>
        </div>
        <div className="dashboard-panel-content">
          {renderDashboardSection(id)}
        </div>
      </article>
    );
  }

  return (
    <main>
      <header>
        <div className="header-row">
          <div>
            <Image
              className="brand-logo"
              src="/header-photo.png"
              alt="BremLogic"
              width={1038}
              height={338}
              priority
            />
            <div className="subtext">
              Real-time crypto signals with on-app wallet controls and manual trade execution flow.
            </div>
          </div>
          <div className="header-alert-slot">
            <div className="panel compact-panel alerts-row-panel">
              <strong>Alerts & Push</strong>
              <span className="subtext">{pushStatus}</span>
              {activeApprovalStatus ? <span className="subtext">{activeApprovalStatus}</span> : null}
              <div className="alerts-actions">
                <button
                  onClick={togglePush}
                  disabled={!pushReady}
                  className={pushEnabled ? "push-toggle on" : "push-toggle off"}
                >
                  {pushEnabled ? "Alerts Enabled" : "Alerts Disabled"}
                </button>
                <button className="secondary" onClick={sendTestPush}>Send Test Push</button>
              </div>
            </div>
          </div>
        <div className="badges">
          <div className="badge">Price Feed: {formatFeedSource(priceFeedStatus)}</div>
          <div className="badge">Wallet: in-app</div>
          <div className="badge">{autoTradeStatus}</div>
          <div className="badge">{perpsAutoTradeStatus}</div>
        </div>
      </div>
      </header>

      <section className="dashboard-layout dashboard-layout-static" style={{ marginBottom: 22 }}>
        <div className="tab-panel" hidden={activeSignalsTab !== "signals"}>
          {renderStructuredPanel("chart")}
          {renderStructuredPanel("params")}
          {renderStructuredPanel("signals")}
        </div>
        <div className="tab-panel" hidden={activeSignalsTab !== "perps"}>
          {renderStructuredPanel("perps")}
        </div>
        <div className="tab-panel" hidden={activeSignalsTab !== "wallet"}>
          {renderStructuredPanel("wallet")}
          {renderStructuredPanel("pnl")}
          {renderStructuredPanel("trades")}
        </div>
      </section>

      {showDepositModal && wallet.publicKey ? (
        <div className="modal-backdrop" onClick={() => setShowDepositModal(false)}>
          <div className="modal-card" onClick={(event) => event.stopPropagation()}>
            <h3>Deposit Funds</h3>
            <div className="subtext">Send SOL or SPL tokens to this wallet.</div>
            <Image
              className="deposit-qr"
              src={`https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=${encodeURIComponent(wallet.publicKey.toBase58())}`}
              alt="Deposit address QR code"
              width={240}
              height={240}
              unoptimized
            />
            <code className="deposit-address">{wallet.publicKey.toBase58()}</code>
            <div className="wallet-controls">
              <button onClick={copyDepositAddress}>Copy Address</button>
              <button className="secondary" onClick={() => setShowDepositModal(false)}>Close</button>
            </div>
          </div>
        </div>
      ) : null}

      <div className="footer">
        Signals are informational only and not financial advice. Always verify on-chain details before placing live trades.
      </div>
    </main>
  );
}

export default function Page() {
  return (
    <SolanaWalletProvider>
      <DashboardPage />
    </SolanaWalletProvider>
  );
}
