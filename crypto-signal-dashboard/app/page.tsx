"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
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
const PARAMS_STORAGE_KEY = "brembot.signal-params.v1";
const AUTO_TRADE_STORAGE_KEY = "brembot.auto-trade-enabled.v1";
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
  trendThreshold: 1.0,
  breakoutPercent: 0.9,
  newsBias: 0.25,
  cooldownSeconds: 120,
};

type AutoTradeToken = "SOL" | "USDC";

type AutoTradeSettings = {
  walletPercent: number;
  inputToken: AutoTradeToken;
};

const DEFAULT_AUTO_TRADE_SETTINGS: AutoTradeSettings = {
  walletPercent: 10,
  inputToken: "SOL",
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

function DashboardPage() {
  const { connection } = useConnection();
  const wallet = useWallet();
  const walletAddress = wallet.publicKey?.toBase58() ?? null;

  const [trackedMarkets, setTrackedMarkets] = useState<TrackedMarket[]>(DEFAULT_TRACKED_MARKETS);
  const [priceHistory, setPriceHistory] = useState<Record<string, PricePoint[]>>({});
  const [dayChange24h, setDayChange24h] = useState<Record<string, number>>({});
  const [params, setParams] = useState<UserParams>(DEFAULT_PARAMS);
  const [paramsSaveStatus, setParamsSaveStatus] = useState("Using defaults");
  const [autoTradeEnabled, setAutoTradeEnabled] = useState(false);
  const [signals, setSignals] = useState<Signal[]>([]);
  const [lastSignalAt, setLastSignalAt] = useState<Record<string, number>>({});
  const [selectedChartSlotId, setSelectedChartSlotId] = useState<string>(DEFAULT_TRACKED_MARKETS[0].id);
  const [priceFeedStatus, setPriceFeedStatus] = useState("loading");
  const [marketOptions, setMarketOptions] = useState<MarketOption[]>(DEFAULT_TRACKED_MARKETS);
  const [newsItems, setNewsItems] = useState<NewsItem[]>(getMockNews());
  const [editingMarketSlotId, setEditingMarketSlotId] = useState<string | null>(null);

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
  const [showDepositModal, setShowDepositModal] = useState(false);
  const [showJupiterPlugin, setShowJupiterPlugin] = useState(true);

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
      trackedMarkets.forEach((market) => {
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

            if (autoTradeEnabled) {
              const inputMint = autoTradeSettings.inputToken === "USDC" ? USDC_MINT : SOL_MINT;
              const directionalOutputMint = signal.direction === "bullish" ? SOL_MINT : USDC_MINT;

              if (wallet.publicKey) {
                const outputMint = directionalOutputMint === inputMint
                  ? (inputMint === SOL_MINT ? USDC_MINT : SOL_MINT)
                  : directionalOutputMint;
                const availableInput = autoTradeSettings.inputToken === "USDC"
                  ? (walletTokens.find((token) => token.mint === USDC_MINT)?.amount ?? 0)
                  : (solBalance ?? 0);
                const tradeAmount = Number((availableInput * (autoTradeSettings.walletPercent / 100)).toFixed(6));
                if (!Number.isFinite(tradeAmount) || tradeAmount <= 0) {
                  setAutoTradeStatus(`Signal detected for ${signal.symbol} but no ${autoTradeSettings.inputToken} balance is available`);
                } else {
                  setAutoTradeStatus(`Executing auto-trade for ${signal.symbol} (${tradeAmount} ${autoTradeSettings.inputToken})...`);
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
                      signalSummary: `${signal.summary} · executed ${tradeAmount} ${autoTradeSettings.inputToken}`,
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
                  signalSummary: `${signal.summary} · ${autoTradeSettings.walletPercent}% of wallet in ${autoTradeSettings.inputToken}`,
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
                  `Auto-trade paper execution for ${signal.symbol} using ${autoTradeSettings.walletPercent}% ${autoTradeSettings.inputToken} (connect wallet for live)`
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
    autoTradeEnabled,
    autoTradeSettings.inputToken,
    autoTradeSettings.walletPercent,
    lastSignalAt,
    newsItems,
    params,
    priceHistory,
    pushEnabled,
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
      const raw = window.localStorage.getItem(AUTO_TRADE_STORAGE_KEY);
      const enabled = raw === "true";
      setAutoTradeEnabled(enabled);
      setAutoTradeStatus(enabled ? "Auto-trade is on" : "Auto-trade is off");
    } catch (_error) {
      setAutoTradeEnabled(false);
      setAutoTradeStatus("Auto-trade is off");
    }
  }, []);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(AUTO_TRADE_SETTINGS_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Partial<AutoTradeSettings>;
      const nextPercent = Number(parsed.walletPercent);
      const percent = Number.isFinite(nextPercent)
        ? Math.min(100, Math.max(1, Math.round(nextPercent)))
        : DEFAULT_AUTO_TRADE_SETTINGS.walletPercent;
      const inputToken = parsed.inputToken === "USDC" ? "USDC" : "SOL";
      setAutoTradeSettings({ walletPercent: percent, inputToken });
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

  const cards = trackedMarkets.map((market) => {
    const points = priceHistory[market.id] ?? [];
    const current = points[points.length - 1]?.v ?? 0;
    const change24h = dayChange24h[market.id] ?? 0;
    return { ...market, current, change24h };
  });

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
    try {
      window.localStorage.removeItem(PARAMS_STORAGE_KEY);
      window.localStorage.removeItem(AUTO_TRADE_SETTINGS_STORAGE_KEY);
    } catch (_error) {
      // ignore storage errors
    }
    setParamsSaveStatus("Reset to defaults");
  }

  function toggleAutoTrade() {
    setAutoTradeEnabled((previous) => {
      const next = !previous;
      try {
        window.localStorage.setItem(AUTO_TRADE_STORAGE_KEY, String(next));
      } catch (_error) {
        // ignore storage errors
      }
      setAutoTradeStatus(
        next
          ? `Auto-trade is on (${autoTradeSettings.walletPercent}% ${autoTradeSettings.inputToken})`
          : "Auto-trade is off"
      );
      return next;
    });
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
              onClick={() => setSelectedChartSlotId(card.id)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  setSelectedChartSlotId(card.id);
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

      <section className="panel chart-panel" style={{ marginBottom: 22 }}>
        <h3>TradingView Chart</h3>
        <div className="subtext" style={{ marginBottom: 10 }}>
          Live market chart aligned with signal scanning. Selected: {selectedChartMarket?.pair ?? "-"}
        </div>
        <div className="tradingview-wrap">
          <TradingViewChart symbol={selectedChartMarket?.tvSymbol ?? "COINBASE:SOLUSD"} />
        </div>
      </section>

      <section className="grid" style={{ marginBottom: 22 }}>
        <div className="panel">
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
                fixedMint={autoTradeSettings.inputToken === "USDC" ? USDC_MINT : SOL_MINT}
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
        </div>

        <div className="panel">
          <h3>Signal Parameters</h3>
          <div className="controls params-toolbar">
            <div className="subtext">{paramsSaveStatus}</div>
            <button
              type="button"
              role="switch"
              aria-checked={autoTradeEnabled}
              className={`auto-trade-toggle ${autoTradeEnabled ? "on" : "off"}`}
              onClick={toggleAutoTrade}
            >
              Auto-trade: {autoTradeEnabled ? "On" : "Off"}
            </button>
            <button type="button" onClick={saveSignalParams}>Save</button>
            <button type="button" className="secondary" onClick={resetSignalParams}>Reset</button>
          </div>
          <div className="controls">
            <label>
              Trend window (min)
              <input
                type="number"
                value={params.trendWindow}
                min={15}
                max={180}
                step={5}
                onChange={(event) =>
                  setParams((prev) => ({ ...prev, trendWindow: Number(event.target.value) }))
                }
              />
            </label>
            <label>
              Trend threshold %
              <input
                type="number"
                value={params.trendThreshold}
                min={0.8}
                max={10}
                step={0.2}
                onChange={(event) =>
                  setParams((prev) => ({ ...prev, trendThreshold: Number(event.target.value) }))
                }
              />
            </label>
            <label>
              Breakout %
              <input
                type="number"
                value={params.breakoutPercent}
                min={0.8}
                max={8}
                step={0.2}
                onChange={(event) =>
                  setParams((prev) => ({ ...prev, breakoutPercent: Number(event.target.value) }))
                }
              />
            </label>
            <label>
              News bias (0-1)
              <input
                type="number"
                value={params.newsBias}
                min={0}
                max={0.4}
                step={0.02}
                onChange={(event) =>
                  setParams((prev) => ({ ...prev, newsBias: Number(event.target.value) }))
                }
              />
            </label>
            <label>
              Cooldown (sec)
              <input
                type="number"
                value={params.cooldownSeconds}
                min={5}
                max={900}
                step={5}
                onChange={(event) =>
                  setParams((prev) => ({ ...prev, cooldownSeconds: Number(event.target.value) }))
                }
              />
            </label>
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
                  const walletPercent = Number.isFinite(value)
                    ? Math.min(100, Math.max(1, Math.round(value)))
                    : DEFAULT_AUTO_TRADE_SETTINGS.walletPercent;
                  setAutoTradeSettings((prev) => {
                    const next = { ...prev, walletPercent };
                    try {
                      window.localStorage.setItem(AUTO_TRADE_SETTINGS_STORAGE_KEY, JSON.stringify(next));
                    } catch (_error) {
                      // ignore storage errors
                    }
                    return next;
                  });
                }}
              />
            </label>
            <label>
              Auto-trade token
              <select
                value={autoTradeSettings.inputToken}
                onChange={(event) => {
                  const inputToken: AutoTradeToken = event.target.value === "USDC" ? "USDC" : "SOL";
                  setAutoTradeSettings((prev) => {
                    const next = { ...prev, inputToken };
                    try {
                      window.localStorage.setItem(AUTO_TRADE_SETTINGS_STORAGE_KEY, JSON.stringify(next));
                    } catch (_error) {
                      // ignore storage errors
                    }
                    return next;
                  });
                }}
              >
                <option value="SOL">Solana (SOL)</option>
                <option value="USDC">USDC</option>
              </select>
            </label>
          </div>
        </div>
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

      <section className="grid" style={{ marginBottom: 22 }}>
        <div className="panel">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
            <h3>Live Signals</h3>
            <button className="secondary" onClick={clearRecentSignals}>Clear Signals</button>
          </div>
          {signals.length === 0 && <div className="subtext">Waiting for signal triggers.</div>}
          <div className="signals-scroll">
            {signals.map((signal) => (
              <div
                key={signal.id}
                className={`signal ${signal.direction === "bearish" ? "negative" : ""}`}
              >
                <div>
                  <div>
                    {signal.symbol} · {signal.type.toUpperCase()}
                  </div>
                  <div className="signal-meta">{signal.summary}</div>
                  <div className="subtext">Signal time: {new Date(signal.timestamp).toLocaleTimeString()}</div>
                </div>
                <div>{Math.round(signal.confidence * 100)}%</div>
              </div>
            ))}
          </div>
        </div>

        <div className="panel">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
            <h3>Recent Trades</h3>
            <div className="wallet-controls">
              <button className="secondary" onClick={clearRecentTrades}>Clear Trades</button>
            </div>
          </div>
          {!wallet.publicKey && recentTrades.length === 0 && (
            <div className="subtext">Connect a wallet for live execution. Auto-trade can still run paper executions.</div>
          )}
          {recentTrades.length === 0 && wallet.publicKey && (
            <div className="subtext">No recent trades recorded for this wallet yet.</div>
          )}
          <div className="recent-trades-scroll">
          {recentTrades.map((trade) => (
            <div key={trade.id} className="news-item">
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                <span>{trade.source === "auto" ? "Auto trade" : "Manual trade"}</span>
                <span className="subtext">{new Date(trade.timestamp).toLocaleTimeString()}</span>
              </div>
              {trade.signalSummary ? <div className="subtext">{trade.signalSummary}</div> : null}
              <div className="news-meta">
                <span>
                  {trade.txid.startsWith("auto-") || trade.txid.startsWith("manual-")
                    ? trade.txid.slice(0, 20)
                    : shortAddress(trade.txid)}
                </span>
                {trade.txid.startsWith("auto-") ? (
                  <span>Simulated execution</span>
                ) : trade.txid.startsWith("manual-") ? (
                  <span>Manual entry</span>
                ) : (
                  <a
                    href={`https://solscan.io/tx/${trade.txid}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    View Tx
                  </a>
                )}
              </div>
            </div>
          ))}
          </div>
        </div>

        <div className="panel">
          <h3>News Pulse</h3>
          {latestNews.map((item) => (
            <div key={item.id} className="news-item">
              <div>
                {item.url ? (
                  <a href={item.url} target="_blank" rel="noreferrer">
                    {item.headline}
                  </a>
                ) : item.headline}
              </div>
              <div className="news-meta">
                <span>{item.source}</span>
                <span>{item.sentiment >= 0 ? "Positive" : "Negative"}</span>
              </div>
            </div>
          ))}
        </div>
      </section>

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
