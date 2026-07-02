"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Capacitor } from "@capacitor/core";
import { LocalNotifications } from "@capacitor/local-notifications";
import Image from "next/image";
import bs58 from "bs58";
import { PublicKey } from "@solana/web3.js";
import { useConnection, useWallet } from "@/app/components/SolanaWalletProvider";

import { ManualSwapWidget, type ManualSwapSuccess } from "@/app/components/ManualSwapWidget";
import { SolanaWalletProvider } from "@/app/components/SolanaWalletProvider";
import { JupiterPerpsPositionWidget } from "@/app/components/JupiterPerpsPositionWidget";
import { TradingViewChart } from "@/app/components/TradingViewChart";
import { useJupiterPerpsPositions } from "@/hooks/useJupiterPerpsPositions";
import { createSimulatedFeed } from "@/lib/price/simulated";
import type { PricePoint } from "@/lib/price/simulated";
import { detectSignals, type Signal, type UserParams } from "@/lib/signal/engine";
import { getMockNews, type NewsItem } from "@/lib/news/mock";
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

const DEFAULT_PARAMS: UserParams = {
  trendWindow: 5,
  trendThreshold: 0.5,
  breakoutPercent: 0.8,
  newsBias: 0.5,
  cooldownSeconds: 60,
};

type AutoTradeToken = "SOL" | "ETH" | "BTC" | "USDC" | "JUP" | "BONK";

type AutoTradeTokenOption = {
  symbol: AutoTradeToken;
  label: string;
  mint: string;
};

type AutoTradeMode = "all" | "buy-only";

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
  slots: AutoTradeSlot[];
  activeSlotId: string | null;
  mode: AutoTradeMode;
  disableTpLock: boolean;
};

const DEFAULT_AUTO_TRADE_SETTINGS: AutoTradeSettings = {
  walletPercent: 25,
  takeProfitPercent: 0,
  slots: [
    { id: "auto-slot-1", token: "SOL" },
    { id: "auto-slot-2", token: "ETH" },
    { id: "auto-slot-3", token: "BTC" },
  ],
  activeSlotId: null,
  mode: "all",
  disableTpLock: false,
};

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
type DashboardSectionId = "chart" | "wallet" | "pnl" | "params" | "signals" | "trades" | "news";
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

type TradeChartOverlay = {
  symbol: string;
  tokenSymbol: string;
  entryPrice: number;
  targetPrice: number | null;
  side: "buy" | "sell";
  updatedAt: number;
};

function normalizeMarketTokenSymbol(value: string | null | undefined) {
  return (value ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

type RemoteAuthChallenge = {
  address: string;
  challengeId: string;
  message: string;
  expiresInSeconds: number;
  expiresAt: string;
};

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
  { id: "pnl", width: 1080, height: 460 },
  { id: "params", width: 1080, height: 500 },
  { id: "signals", width: 1080, height: 430 },
  { id: "trades", width: 1080, height: 500 },
  { id: "news", width: 1080, height: 430 },
];

const DASHBOARD_SECTION_TITLES: Record<DashboardSectionId, string> = {
  chart: "TradingView Chart",
  wallet: "In-App Wallet",
  pnl: "PnL",
  params: "Signal Parameters",
  signals: "Live Signals",
  trades: "Recent Trades",
  news: "News Pulse",
};

function getAutoTradeTokenOption(symbol: AutoTradeToken) {
  return AUTO_TRADE_TOKEN_OPTIONS.find((option) => option.symbol === symbol) ?? AUTO_TRADE_TOKEN_OPTIONS[0];
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
  const { positions: livePerpsPositions, pendingTriggers: livePerpsPendingTriggers } = useJupiterPerpsPositions({
    walletAddress,
    showMockData: false,
  });

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
  const [newsItems, setNewsItems] = useState<NewsItem[]>(getMockNews());
  const [editingMarketSlotId, setEditingMarketSlotId] = useState<string | null>(null);
  const [editingSignalTarget, setEditingSignalTarget] = useState(false);

  const [pushStatus, setPushStatus] = useState("Push not enabled");
  const [pushReady, setPushReady] = useState(false);
  const [pushEnabled, setPushEnabled] = useState(false);
  const [subscription, setSubscription] = useState<PushSubscriptionJSON | null>(null);

  const [solBalance, setSolBalance] = useState<number | null>(null);
  const [walletTokens, setWalletTokens] = useState<WalletTokenHolding[]>([]);
  const [totalBalanceUsd, setTotalBalanceUsd] = useState<number | null>(null);
  const [solValueUsd, setSolValueUsd] = useState<number | null>(null);
  const [portfolioStatus, setPortfolioStatus] = useState("Wallet not connected");
  const [recentTrades, setRecentTrades] = useState<StoredTradeRecord[]>([]);
  const [autoTradeStatus, setAutoTradeStatus] = useState("Auto-trade is off");
  const [autoTradeSettings, setAutoTradeSettings] = useState<AutoTradeSettings>(DEFAULT_AUTO_TRADE_SETTINGS);
  const [pendingTakeProfit, setPendingTakeProfit] = useState<PendingTakeProfit | null>(null);
  const [tradeChartOverlay, setTradeChartOverlay] = useState<TradeChartOverlay | null>(null);
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
  const pendingTakeProfitRef = useRef<PendingTakeProfit | null>(null);
  const lastTpAttemptAtRef = useRef(0);
  const activeAutoTradeSlot = useMemo(
    () => autoTradeSettings.slots.find((slot) => slot.id === autoTradeSettings.activeSlotId) ?? null,
    [autoTradeSettings.activeSlotId, autoTradeSettings.slots]
  );
  const activeAutoTradeToken = activeAutoTradeSlot ? getAutoTradeTokenOption(activeAutoTradeSlot.token) : null;
  const autoTradeEnabled = Boolean(activeAutoTradeToken);
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

  const sendSignalNotification = useCallback(async (title: string, body: string, url?: string) => {
    if (!pushEnabled) return;

    if (nativeShell) {
      try {
        await LocalNotifications.schedule({
          notifications: [
            {
              id: Date.now() % 2147483000,
              title,
              body,
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

  useEffect(() => {
    pendingTakeProfitRef.current = pendingTakeProfit;
  }, [pendingTakeProfit]);

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
    const newsScore = newsItems.reduce((sum, item) => sum + item.sentiment, 0) /
      Math.max(newsItems.length, 1);

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
          newsScore: newsScore * params.newsBias,
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

            void sendSignalNotification(`Signal: ${signal.symbol}`, signal.summary);

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
                    setTradeChartOverlay({
                      symbol: signal.symbol,
                      tokenSymbol: assetSymbol,
                      entryPrice: marketEntryPrice,
                      targetPrice,
                      side: isBullSignal ? "buy" : "sell",
                      updatedAt: Date.now(),
                    });
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
                    if (!nativeShell && pushEnabled) {
                      fetch("/api/push/notify", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                          title: `Auto-trade executed: ${signal.symbol}`,
                          body: `Tx: ${result.txid.slice(0, 12)}... · Tap to view on-chain.`,
                          url: `https://solscan.io/tx/${result.txid}`,
                          subscription,
                        }),
                      }).catch(() => undefined);
                    }
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
                setTradeChartOverlay({
                  symbol: signal.symbol,
                  tokenSymbol: assetSymbol,
                  entryPrice: points[points.length - 1]?.v ?? 0,
                  targetPrice: null,
                  side: signal.direction === "bullish" ? "buy" : "sell",
                  updatedAt: Date.now(),
                });
                setAutoTradeStatus(
                  `Auto-trade paper execution for ${signal.symbol} (${signal.direction === "bullish" ? "buy" : "sell"} ${assetSymbol}, ${autoTradeSettings.walletPercent}% allocation; connect wallet for live)`
                );
              }
            }

            if (!nativeShell && pushEnabled) {
              fetch("/api/push/notify", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  title: `Signal: ${signal.symbol}`,
                  body: signal.summary,
                  url: "/",
                  subscription,
                }),
              }).catch(() => undefined);
            }
          });
        }
      });

      return next;
    });
  }, [
    activeAutoTradeToken,
    autoTradeSettings.disableTpLock,
    autoTradeSettings.mode,
    autoTradeEnabled,
    autoTradeSettings.walletPercent,
    autoTradeSettings.takeProfitPercent,
    lastSignalAt,
    newsItems,
    nativeShell,
    params,
    priceHistory,
    pushEnabled,
    receiveSignalsForSlotId,
    sendSignalNotification,
    subscription,
    trackedMarkets,
    persistTradeRecord,
    wallet,
    wallet.executeSwap,
    wallet.publicKey,
    walletTokens,
    solBalance,
  ]);

  useEffect(() => {
    if (nativeShell) {
      let cancelled = false;

      async function initNativeNotifications() {
        try {
          const permission = await LocalNotifications.checkPermissions();
          if (cancelled) return;
          const enabledPreference = readNativeAlertsEnabled();
          setPushReady(true);
          if (permission.display === "granted" && enabledPreference) {
            setPushEnabled(true);
            setPushStatus("Native alerts enabled");
          } else if (permission.display === "granted") {
            setPushEnabled(false);
            setPushStatus("Native alerts available");
          } else {
            setPushEnabled(false);
            setPushStatus("Native alerts disabled");
          }
        } catch {
          if (cancelled) return;
          setPushReady(false);
          setPushStatus("Native notifications unavailable");
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
  }, [nativeShell]);

  useEffect(() => {
    let cancelled = false;
    const pollNews = async () => {
      try {
        const response = await fetch("/api/news/trending", { cache: "no-store" });
        const payload = await response.json();
        if (!response.ok || !Array.isArray(payload?.items) || cancelled) return;
        setNewsItems(payload.items as NewsItem[]);
      } catch (_error) {
        if (!cancelled) setNewsItems(getMockNews());
      }
    };

    pollNews().catch(() => undefined);
    const interval = setInterval(() => {
      pollNews().catch(() => undefined);
    }, 60000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(PARAMS_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Partial<UserParams>;
      setParams({
        trendWindow: Number(parsed.trendWindow ?? DEFAULT_PARAMS.trendWindow),
        trendThreshold: Number(parsed.trendThreshold ?? DEFAULT_PARAMS.trendThreshold),
        breakoutPercent: Number(parsed.breakoutPercent ?? DEFAULT_PARAMS.breakoutPercent),
        newsBias: Number(parsed.newsBias ?? DEFAULT_PARAMS.newsBias),
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
      const mode = parsed.mode === "buy-only" ? "buy-only" : "all";
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

      setAutoTradeSettings({
        walletPercent: percent,
        takeProfitPercent,
        slots: normalizedSlots,
        activeSlotId,
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

  async function requestRemoteAuthChallenge(address: string) {
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
  }

  async function verifyRemoteAuthChallenge(address: string, challengeId: string, signature: string) {
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
  }

  async function signRemoteAuthMessage(source: RemoteAuthSource, message: string) {
    const encodedMessage = new TextEncoder().encode(message);

    if (source === "in-app") {
      const signature = await wallet.signMessage(encodedMessage);
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
  }

  async function completeRemoteAuth(address: string, source: RemoteAuthSource) {
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
  }

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

  async function persistTradeRecord(trade: StoredTradeRecord) {
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

    wallet.executeSwap({
      inputMint: pendingTakeProfit.tokenMint,
      outputMint: USDC_MINT,
      uiAmount: pendingTakeProfit.amount,
    }).then((result) => {
      const tpTradeRecord: StoredTradeRecord = {
        id: `tp-${pendingTakeProfit.id}-${Date.now()}`,
        txid: result.txid,
        timestamp: Date.now(),
        walletAddress: wallet.publicKey?.toBase58() ?? "paper-auto",
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
      setTradeChartOverlay({
        symbol: pendingTakeProfit.symbol,
        tokenSymbol: pendingTakeProfit.tokenSymbol,
        entryPrice: pendingTakeProfit.entryPrice,
        targetPrice: pendingTakeProfit.targetPrice,
        side: "sell",
        updatedAt: Date.now(),
      });
      setAutoTradeStatus(`TP executed for ${pendingTakeProfit.symbol} at ${formatUsd(latestPrice)}`);
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
    trackedMarkets,
    wallet.executeSwap,
    wallet.publicKey,
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
  }, [phantomAuthAddress, remoteAuthAddress, remoteAuthSource, remoteAuthToken, remoteSyncWalletAddress, wallet.signMessage]);

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

  useEffect(() => {
    const selectedMarket = trackedMarkets.find((market) => market.id === selectedChartSlotId) ?? trackedMarkets[0];
    const selectedTokenSymbol = selectedMarket?.pair.split("/")[0] ?? null;
    const normalizedSelectedSymbol = normalizeMarketTokenSymbol(selectedTokenSymbol);

    if (normalizedSelectedSymbol) {
      const latestPerpsPosition = [...livePerpsPositions]
        .filter(
          (position) =>
            normalizeMarketTokenSymbol(position.marketSymbol) === normalizedSelectedSymbol &&
            Number.isFinite(position.entryPrice) &&
            position.entryPrice !== null
        )
        .sort((left, right) => (right.lastUpdated ?? 0) - (left.lastUpdated ?? 0))[0];

      if (latestPerpsPosition?.entryPrice) {
        const pendingTp =
          latestPerpsPosition.takeProfit ??
          [...livePerpsPendingTriggers]
            .filter(
              (trigger) =>
                normalizeMarketTokenSymbol(trigger.marketSymbol) === normalizedSelectedSymbol &&
                trigger.kind === "take-profit" &&
                Number.isFinite(trigger.triggerPrice) &&
                trigger.triggerPrice !== null
            )
            .sort((left, right) => (right.lastUpdated ?? 0) - (left.lastUpdated ?? 0))[0]?.triggerPrice ??
          null;

        setTradeChartOverlay({
          symbol: selectedMarket?.pair ?? `${selectedTokenSymbol ?? latestPerpsPosition.marketSymbol}/USD`,
          tokenSymbol: selectedTokenSymbol ?? latestPerpsPosition.marketSymbol,
          entryPrice: latestPerpsPosition.entryPrice,
          targetPrice: pendingTp,
          side: latestPerpsPosition.side === "short" ? "sell" : "buy",
          updatedAt: latestPerpsPosition.lastUpdated ?? Date.now(),
        });
        return;
      }
    }

    const latestAutoTrade = [...recentTrades]
      .filter((trade) => trade.source === "auto" && trade.symbol && Number.isFinite(trade.entryPrice))
      .sort((left, right) => right.timestamp - left.timestamp)[0];

    if (!latestAutoTrade?.symbol || !Number.isFinite(latestAutoTrade.entryPrice)) {
      if (!pendingTakeProfit) {
        setTradeChartOverlay(null);
      }
      return;
    }

    const overlayTargetPrice = autoTradeSettings.disableTpLock
      ? null
      : pendingTakeProfit?.symbol === latestAutoTrade.symbol
        ? pendingTakeProfit.targetPrice
        : latestAutoTrade.takeProfitPrice ?? null;

    setTradeChartOverlay({
      symbol: latestAutoTrade.symbol,
      tokenSymbol: latestAutoTrade.symbol.split("/")[0] ?? latestAutoTrade.symbol,
      entryPrice: Number(latestAutoTrade.entryPrice),
      targetPrice: overlayTargetPrice,
      side: latestAutoTrade.tradeDirection === "sell" ? "sell" : "buy",
      updatedAt: latestAutoTrade.timestamp,
    });
  }, [
    autoTradeSettings.disableTpLock,
    livePerpsPendingTriggers,
    livePerpsPositions,
    pendingTakeProfit,
    recentTrades,
    selectedChartSlotId,
    trackedMarkets,
  ]);

  const latestNews = useMemo(() => newsItems, [newsItems]);

  const selectedChartMarket =
    trackedMarkets.find((market) => market.id === selectedChartSlotId) ?? trackedMarkets[0];
  const selectedSignalMarket =
    trackedMarkets.find((market) => market.id === receiveSignalsForSlotId) ?? trackedMarkets[0];

  const cards = trackedMarkets.map((market) => {
    const points = priceHistory[market.id] ?? [];
    const current = points[points.length - 1]?.v ?? 0;
    const change24h = dayChange24h[market.id] ?? 0;
    return { ...market, current, change24h };
  });

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

  const selectableMarketOptions = useMemo(() => {
    const currentProducts = new Set(trackedMarkets.map((market) => market.coinbaseProduct));
    return marketOptions.filter(
      (option) => !currentProducts.has(option.coinbaseProduct) || option.coinbaseProduct ===
        trackedMarkets.find((market) => market.id === editingMarketSlotId)?.coinbaseProduct
    );
  }, [editingMarketSlotId, marketOptions, trackedMarkets]);

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
    setEditingMarketSlotId(null);
  }

  async function enablePush() {
    if (!pushReady) return;
    if (nativeShell) {
      try {
        const permission = await LocalNotifications.requestPermissions();
        if (permission.display !== "granted") {
          writeNativeAlertsEnabled(false);
          setPushEnabled(false);
          setPushStatus("Native alerts disabled");
          return;
        }
        writeNativeAlertsEnabled(true);
        setPushEnabled(true);
        setPushStatus("Native alerts enabled");
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
        body: JSON.stringify(subscriptionJson),
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
      try {
        await LocalNotifications.schedule({
          notifications: [
            {
              id: Date.now() % 2147483000,
              title: "BremLogic",
              body: "Test notification from your native Signals Bot app.",
            },
          ],
        });
        setPushStatus("Native test alert sent");
      } catch (error) {
        setPushStatus(error instanceof Error ? error.message : "Native test alert failed");
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
        body: JSON.stringify({ subscription }),
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
    setTradeChartOverlay(null);
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

  async function handleManualSwapSuccess(result: ManualSwapSuccess) {
    const manualTradeRecord: StoredTradeRecord = {
      id: `manual-${result.txid}-${Date.now()}`,
      txid: result.txid,
      timestamp: Date.now(),
      walletAddress: wallet.publicKey?.toBase58() ?? undefined,
      source: "manual",
      inputMint: result.inputMint,
      outputMint: result.outputMint,
      inputAmount: result.inputAmount,
      outputAmount: result.outputAmount,
      signalSummary: `${result.inputSymbol} -> ${result.outputSymbol}${result.gasless ? " · gasless" : ""}`,
      gasless: result.gasless,
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
      setTradeChartOverlay((previous) => (previous ? { ...previous, targetPrice: null } : previous));
    }
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
          <div className="subtext" style={{ marginBottom: 10 }}>
            Live market chart aligned with signal scanning. Selected: {selectedChartMarket?.pair ?? "-"}
          </div>
          <div className="tradingview-wrap">
            <TradingViewChart
              symbol={selectedChartMarket?.tvSymbol ?? "COINBASE:SOLUSD"}
              guides={
                tradeChartOverlay?.symbol === selectedChartMarket?.pair
                  ? [
                      {
                        label: "Entry",
                        price: tradeChartOverlay.entryPrice,
                        tone: "entry" as const,
                      },
                      ...(tradeChartOverlay.targetPrice
                        ? [
                            {
                              label: "TP",
                              price: tradeChartOverlay.targetPrice,
                              tone: "tp" as const,
                            },
                          ]
                        : []),
                    ]
                  : []
              }
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
          <div className="wallet-trading-grid" style={{ marginTop: 10 }}>
            <div className="wallet-trading-panel wallet-trading-panel-swap">
              <ManualSwapWidget
                connected={wallet.connected}
                walletAddress={wallet.publicKey?.toBase58() ?? null}
                solBalance={solBalance}
                walletTokens={walletTokens}
                onExecuteSwap={wallet.executeSwap}
                onTradeSuccess={handleManualSwapSuccess}
              />
            </div>
            <div className="wallet-trading-panel wallet-trading-panel-perps">
              <JupiterPerpsPositionWidget />
            </div>
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
            <label>Trend window (min)<input type="number" value={params.trendWindow} min={1} max={180} step={1} onChange={(event) => setParams((prev) => ({ ...prev, trendWindow: Number(event.target.value) }))} /></label>
            <label>Trend threshold %<input type="number" value={params.trendThreshold} min={0.1} max={10} step={0.1} onChange={(event) => setParams((prev) => ({ ...prev, trendThreshold: Number(event.target.value) }))} /></label>
            <label>Breakout %<input type="number" value={params.breakoutPercent} min={0.8} max={8} step={0.2} onChange={(event) => setParams((prev) => ({ ...prev, breakoutPercent: Number(event.target.value) }))} /></label>
            <label>News bias (0-1)<input type="number" value={params.newsBias} min={0} max={1} step={0.05} onChange={(event) => setParams((prev) => ({ ...prev, newsBias: Number(event.target.value) }))} /></label>
            <label>Cooldown (sec)<input type="number" value={params.cooldownSeconds} min={5} max={900} step={5} onChange={(event) => setParams((prev) => ({ ...prev, cooldownSeconds: Number(event.target.value) }))} /></label>
            <label>
              Auto-trade wallet allocation (%)
              <input
                type="number"
                value={autoTradeSettings.walletPercent}
                min={1}
                max={100}
                step={1}
                onChange={(event) => {
                  const value = Number(event.target.value);
                  const walletPercent = Number.isFinite(value) ? Math.min(100, Math.max(1, Math.round(value))) : DEFAULT_AUTO_TRADE_SETTINGS.walletPercent;
                  const next = { ...autoTradeSettings, walletPercent };
                  persistAutoTradeSettings(next);
                }}
              />
            </label>
            <label>
              Take Profit % (bull buys only)
              <input
                type="number"
                value={autoTradeSettings.takeProfitPercent}
                min={0}
                step={0.1}
                onChange={(event) => {
                  const value = Number(event.target.value);
                  const takeProfitPercent = Number.isFinite(value) && value >= 0 ? value : 0;
                  const next = { ...autoTradeSettings, takeProfitPercent };
                  persistAutoTradeSettings(next);
                }}
              />
            </label>
          </div>
          <div className="auto-trade-selector-wrap">
            <div className="auto-trade-selector-header">
              <strong>Auto-Trade Selector</strong>
              <span className="subtext">Bull signal: buy selected token with USDC. Bear signal: sell selected token to USDC.</span>
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
                </div>
              ))}
            </div>
            {showAutoTradeSelectorWarning ? (
              <div className="auto-trade-selector-modal" role="alertdialog" aria-modal="true">
                <div className="auto-trade-selector-modal-card">
                  <strong>Only One Token Allowed For Auto-Trade At A Time</strong>
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

    return (
      <>
        {latestNews.map((item) => (
          <div key={item.id} className="news-item">
            <div>{item.url ? (<a href={item.url} target="_blank" rel="noreferrer">{item.headline}</a>) : item.headline}</div>
            <div className="news-meta"><span>{item.source}</span><span>{item.sentiment >= 0 ? "Positive" : "Negative"}</span></div>
          </div>
        ))}
      </>
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
          </div>
        </div>

        <div className="grid">
          {cards.map((card) => (
            <div
              key={card.id}
              className={`panel price-card ${selectedChartSlotId === card.id ? "active" : ""}`}
              onClick={() => {
                setSelectedChartSlotId(card.id);
                setReceiveSignalsForSlotId(card.id);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  setSelectedChartSlotId(card.id);
                  setReceiveSignalsForSlotId(card.id);
                }
              }}
              role="button"
              tabIndex={0}
            >
              <div className="price-card-head">
                <button
                  type="button"
                  className="price-pair-button"
                  onClick={(event) => {
                    event.stopPropagation();
                    setEditingMarketSlotId((prev) => (prev === card.id ? null : card.id));
                  }}
                >
                  {card.pair}
                </button>
              </div>
              {editingMarketSlotId === card.id ? (
                <div className="price-pair-picker" onClick={(event) => event.stopPropagation()}>
                  <select
                    value={card.coinbaseProduct}
                    onChange={(event) => updateTrackedMarket(card.id, event.target.value)}
                  >
                    {selectableMarketOptions.map((option) => (
                      <option key={option.coinbaseProduct} value={option.coinbaseProduct}>
                        {option.pair}
                      </option>
                    ))}
                  </select>
                  <div className="subtext">TradingView-compatible Coinbase symbols</div>
                </div>
              ) : null}
              <div className="price">{formatUsd(card.current)}</div>
              <div className="subtext">
                24h change {card.change24h >= 0 ? "+" : ""}
                {card.change24h.toFixed(2)}%
              </div>
            </div>
          ))}
        </div>
      </header>

      <section className="dashboard-layout" style={{ marginBottom: 22 }}>
        {dashboardLayout.map((section) => (
          <article
            key={section.id}
            className={`panel dashboard-panel ${dragSectionId === section.id ? "dragging" : ""}`}
            style={{ width: section.width, height: section.height }}
            onDragOver={(event) => event.preventDefault()}
            onDrop={() => {
              if (dragSectionId) reorderDashboardSections(dragSectionId, section.id);
              setDragSectionId(null);
            }}
          >
            <div className="dashboard-panel-toolbar">
              <span className="dashboard-panel-title">{DASHBOARD_SECTION_TITLES[section.id]}</span>
              <button
                type="button"
                draggable
                className="drag-handle"
                title="Drag to reorder"
                onDragStart={() => setDragSectionId(section.id)}
                onDragEnd={() => setDragSectionId(null)}
              >
                Drag
              </button>
            </div>
            <div className="dashboard-panel-content">
              {renderDashboardSection(section.id)}
            </div>
            <button
              type="button"
              className="resize-handle"
              title="Drag to resize"
              onPointerDown={(event) => startResizeSection(section.id, event)}
              onPointerMove={resizeSection}
              onPointerUp={stopResizeSection}
              onPointerCancel={stopResizeSection}
            />
          </article>
        ))}
      </section>

      {showDepositModal && wallet.publicKey ? (
        <div className="modal-backdrop" onClick={() => setShowDepositModal(false)}>
          <div className="modal-card" onClick={(event) => event.stopPropagation()}>
            <h3>Deposit Funds</h3>
            <div className="subtext">Send SOL or SPL tokens to this wallet.</div>
            <img
              className="deposit-qr"
              src={`https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=${encodeURIComponent(wallet.publicKey.toBase58())}`}
              alt="Deposit address QR code"
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
