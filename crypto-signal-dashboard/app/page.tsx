"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import Image from "next/image";
import { PublicKey } from "@solana/web3.js";
import { useConnection, useWallet } from "@/app/components/SolanaWalletProvider";

import { SolanaWalletProvider } from "@/app/components/SolanaWalletProvider";
import { JupiterPluginPanel } from "@/app/components/JupiterPluginPanel";
import { TradingViewChart } from "@/app/components/TradingViewChart";
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
const DEFAULT_WALLET_PASSWORD = "bremlogic";

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
  slots: AutoTradeSlot[];
  activeSlotId: string | null;
};

const DEFAULT_AUTO_TRADE_SETTINGS: AutoTradeSettings = {
  walletPercent: 25,
  slots: [
    { id: "auto-slot-1", token: "SOL" },
    { id: "auto-slot-2", token: "ETH" },
    { id: "auto-slot-3", token: "BTC" },
  ],
  activeSlotId: null,
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
};

type PnlRange = "24h" | "7d" | "30d" | "ytd";
type WalletPnlPoint = { t: number; v: number };
type DashboardSectionId = "chart" | "wallet" | "pnl" | "params" | "signals" | "trades" | "news";
type DashboardSectionLayout = {
  id: DashboardSectionId;
  width: number;
  height: number;
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

const DASHBOARD_LAYOUT_STORAGE_KEY = "brembot.dashboard.layout.v1";
const DEFAULT_DASHBOARD_LAYOUT: DashboardSectionLayout[] = [
  { id: "chart", width: 980, height: 610 },
  { id: "wallet", width: 520, height: 680 },
  { id: "pnl", width: 520, height: 460 },
  { id: "params", width: 520, height: 700 },
  { id: "signals", width: 440, height: 470 },
  { id: "trades", width: 440, height: 470 },
  { id: "news", width: 440, height: 470 },
];

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
  const [showAutoTradeSelectorWarning, setShowAutoTradeSelectorWarning] = useState(false);
  const [showDepositModal, setShowDepositModal] = useState(false);
  const [showJupiterPlugin, setShowJupiterPlugin] = useState(true);
  const [pnlRange, setPnlRange] = useState<PnlRange>("24h");
  const [pnlTokenMint, setPnlTokenMint] = useState<string>(PNL_DEFAULT_MINT);
  const [pnlStatus, setPnlStatus] = useState("PnL tracking recent trades");
  const [dashboardLayout, setDashboardLayout] = useState<DashboardSectionLayout[]>(DEFAULT_DASHBOARD_LAYOUT);
  const [dragSectionId, setDragSectionId] = useState<DashboardSectionId | null>(null);
  const resizeStateRef = useRef<{
    id: DashboardSectionId;
    startX: number;
    startY: number;
    startWidth: number;
    startHeight: number;
  } | null>(null);
  const activeAutoTradeSlot = useMemo(
    () => autoTradeSettings.slots.find((slot) => slot.id === autoTradeSettings.activeSlotId) ?? null,
    [autoTradeSettings.activeSlotId, autoTradeSettings.slots]
  );
  const activeAutoTradeToken = activeAutoTradeSlot ? getAutoTradeTokenOption(activeAutoTradeSlot.token) : null;
  const autoTradeEnabled = Boolean(activeAutoTradeToken);

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

            if (typeof window !== "undefined" && Notification.permission === "granted") {
              new Notification(`Signal: ${signal.symbol}`, { body: signal.summary });
            }

            if (autoTradeEnabled && activeAutoTradeToken) {
              const assetSymbol = activeAutoTradeToken.symbol;
              const assetMint = activeAutoTradeToken.mint;
              const isBullSignal = signal.direction === "bullish";
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
                  wallet.executeSwap({
                    inputMint,
                    outputMint,
                    uiAmount: tradeAmount,
                  }).then((result) => {
                    const activeWallet = wallet.publicKey?.toBase58() ?? "paper-auto";
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
                    };
                    setRecentTrades((prevTrades) => {
                      const nextTrades = [autoTradeRecord, ...prevTrades].slice(0, 20);
                      try {
                        window.localStorage.setItem(tradesStorageKey(activeWallet), JSON.stringify(nextTrades));
                      } catch (_error) {
                        // ignore storage errors
                      }
                      return nextTrades;
                    });
                    setAutoTradeStatus(`Auto-trade executed for ${signal.symbol}`);
                    if (pushEnabled) {
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
                  });
                }
              } else {
                const activeWallet = "paper-auto";
                const autoTradeRecord: StoredTradeRecord = {
                  id: `auto-${signal.id}`,
                  txid: `auto-${signal.id}`,
                  timestamp: Date.now(),
                  walletAddress: activeWallet,
                  source: "auto",
                  signalId: signal.id,
                  signalSummary: `${signal.summary} · ${signal.direction === "bullish" ? "buy" : "sell"} ${assetSymbol} · ${autoTradeSettings.walletPercent}% allocation`,
                };
                setRecentTrades((prevTrades) => {
                  const nextTrades = [
                    autoTradeRecord,
                    ...prevTrades.filter((item) => item.id !== autoTradeRecord.id),
                  ].slice(0, 20);
                  try {
                    window.localStorage.setItem(tradesStorageKey(activeWallet), JSON.stringify(nextTrades));
                  } catch (_error) {
                    // ignore storage errors
                  }
                  return nextTrades;
                });
                setAutoTradeStatus(
                  `Auto-trade paper execution for ${signal.symbol} (${signal.direction === "bullish" ? "buy" : "sell"} ${assetSymbol}, ${autoTradeSettings.walletPercent}% allocation; connect wallet for live)`
                );
              }
            }

            if (pushEnabled) {
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
    autoTradeEnabled,
    autoTradeSettings.walletPercent,
    lastSignalAt,
    newsItems,
    params,
    priceHistory,
    pushEnabled,
    receiveSignalsForSlotId,
    subscription,
    trackedMarkets,
    wallet.executeSwap,
    wallet.publicKey,
    walletTokens,
    solBalance,
  ]);

  useEffect(() => {
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
  }, []);

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
        slots: normalizedSlots,
        activeSlotId,
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
    if (!activeAutoTradeToken) {
      setAutoTradeStatus("Auto-trade is off");
      return;
    }
    setAutoTradeStatus(`Auto-trade is on (${activeAutoTradeToken.symbol}, ${autoTradeSettings.walletPercent}% allocation)`);
  }, [activeAutoTradeToken, autoTradeSettings.walletPercent]);

  useEffect(() => {
    const activeTradeKey = tradesStorageKey(walletAddress ?? "paper-auto");
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
  }, [walletAddress]);

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
    const tokenLabel = pnlTokenOptions.find((option) => option.mint === pnlTokenMint)?.label ?? "token";
    if (recentTrades.length === 0) {
      setPnlStatus(`No recent trades. PnL reset for ${tokenLabel}.`);
      return;
    }
    const priceHint = selectedTokenUsdPrice > 0 ? ` @ ${formatUsd(selectedTokenUsdPrice)}` : "";
    setPnlStatus(`Tracking ${tokenLabel} PnL in USD from recent trades since last clear${priceHint}.`);
  }, [pnlTokenMint, pnlTokenOptions, recentTrades.length, selectedTokenUsdPrice]);

  const pnlValues = useMemo(() => {
    const latest = pnlTimeline[pnlTimeline.length - 1];
    const latestValue = latest?.v ?? 0;
    const now = Date.now();
    const yearStart = new Date(new Date().getFullYear(), 0, 1).getTime();

    const calcSince = (cutoff: number) => {
      const base = pnlTimeline.find((point) => point.t >= cutoff) ?? pnlTimeline[0];
      return latestValue - (base?.v ?? 0);
    };

    return {
      d24: calcSince(now - 24 * 60 * 60 * 1000),
      d7: calcSince(now - 7 * 24 * 60 * 60 * 1000),
      d30: calcSince(now - 30 * 24 * 60 * 60 * 1000),
      ytd: calcSince(yearStart),
    };
  }, [pnlTimeline]);

  const pnlChartPoints = useMemo(() => {
    const now = Date.now();
    const cutoff = pnlRange === "24h"
      ? now - 24 * 60 * 60 * 1000
      : pnlRange === "7d"
        ? now - 7 * 24 * 60 * 60 * 1000
        : pnlRange === "30d"
          ? now - 30 * 24 * 60 * 60 * 1000
          : new Date(new Date().getFullYear(), 0, 1).getTime();

    const filtered = pnlTimeline.filter((point) => point.t >= cutoff);
    if (filtered.length >= 2) return filtered;
    const fallback = pnlTimeline[pnlTimeline.length - 1] ?? { t: now, v: 0 };
    return [{ t: cutoff, v: fallback.v }, fallback];
  }, [pnlRange, pnlTimeline]);

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
      setPortfolioStatus("In-app wallet created");
      setShowJupiterPlugin(true);
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
      setPortfolioStatus("In-app wallet imported");
      setShowJupiterPlugin(true);
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
    setShowDepositModal(false);
    setPortfolioStatus("Wallet disconnected and removed from this device");
  }

  async function loginInAppWallet() {
    const passwordInput = window.prompt("Enter wallet password:", DEFAULT_WALLET_PASSWORD);
    if (passwordInput === null) return;
    try {
      await wallet.login((passwordInput ?? "").trim() || DEFAULT_WALLET_PASSWORD);
      setPortfolioStatus("Wallet unlocked");
      setShowJupiterPlugin(true);
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

  function clearRecentTrades() {
    const activeWallet = wallet.publicKey?.toBase58() ?? "paper-auto";
    setRecentTrades([]);
    setPnlStatus("No recent trades. PnL reset.");
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
      setAutoTradeStatus(`Auto-trade is on (${token}, ${next.walletPercent}% allocation)`);
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
        ? `Auto-trade is on (${token.symbol}, ${next.walletPercent}% allocation)`
        : "Auto-trade is off"
    );
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
          <h3>TradingView Chart</h3>
          <div className="subtext" style={{ marginBottom: 10 }}>
            Live market chart aligned with signal scanning. Selected: {selectedChartMarket?.pair ?? "-"}
          </div>
          <div className="tradingview-wrap">
            <TradingViewChart symbol={selectedChartMarket?.tvSymbol ?? "COINBASE:SOLUSD"} />
          </div>
        </>
      );
    }

    if (id === "wallet") {
      return (
        <>
          <h3>In-App Wallet</h3>
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
          <div className="wallet-controls" style={{ marginTop: 8 }}>
            <button className="secondary" onClick={() => setShowJupiterPlugin((prev) => !prev)}>
              {showJupiterPlugin ? "Hide Jupiter Plugin" : "Show Jupiter Plugin"}
            </button>
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
          {showJupiterPlugin ? (
            <div style={{ marginTop: 10 }}>
              <JupiterPluginPanel
                targetId="jupiter-plugin-container"
                fixedMint={activeAutoTradeToken?.mint ?? SOL_MINT}
                passthroughWalletContextState={wallet.passthroughWalletContextState}
                onRequestConnectWallet={loginInAppWallet}
              />
            </div>
          ) : null}
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
          <h3>PnL</h3>
          <div className="subtext" style={{ marginBottom: 10 }}>{pnlStatus}</div>
          <div className="pnl-metrics">
            <div className="pnl-metric"><span>24hr</span><strong className={pnlValues.d24 >= 0 ? "pnl-positive" : "pnl-negative"}>{formatUsd(pnlValues.d24)}</strong></div>
            <div className="pnl-metric"><span>7-day</span><strong className={pnlValues.d7 >= 0 ? "pnl-positive" : "pnl-negative"}>{formatUsd(pnlValues.d7)}</strong></div>
            <div className="pnl-metric"><span>30-day</span><strong className={pnlValues.d30 >= 0 ? "pnl-positive" : "pnl-negative"}>{formatUsd(pnlValues.d30)}</strong></div>
            <div className="pnl-metric"><span>YTD</span><strong className={pnlValues.ytd >= 0 ? "pnl-positive" : "pnl-negative"}>{formatUsd(pnlValues.ytd)}</strong></div>
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
          <h3>Signal Parameters</h3>
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
          </div>
          <div className="auto-trade-selector-wrap">
            <div className="auto-trade-selector-header">
              <strong>Auto-Trade Selector</strong>
              <span className="subtext">Bull signal: buy selected token with USDC. Bear signal: sell selected token to USDC.</span>
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
            <h3>Live Signals</h3>
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
            <h3>Recent Trades</h3>
            <div className="wallet-controls"><button className="secondary" onClick={clearRecentTrades}>Clear Trades</button></div>
          </div>
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
        <h3>News Pulse</h3>
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
