"use client";

import { useEffect, useMemo, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { WalletModalButton, WalletMultiButton } from "@solana/wallet-adapter-react-ui";

import { SolanaWalletProvider } from "@/app/components/SolanaWalletProvider";
import { JupiterTradePanel, type JupiterTradeRecord } from "@/app/components/JupiterTradePanel";
import { TradingViewChart } from "@/app/components/TradingViewChart";
import { createSimulatedFeed } from "@/lib/price/simulated";
import type { PricePoint } from "@/lib/price/simulated";
import { detectSignals, type Signal, type UserParams } from "@/lib/signal/engine";
import { getMockNews } from "@/lib/news/mock";
import { formatUsd, percentChange } from "@/lib/utils";

const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const SYMBOLS = ["SOL/USD", "ETH/USD", "BTC/USD"] as const;
const PARAMS_STORAGE_KEY = "brembot.signal-params.v1";

const DEFAULT_PARAMS: UserParams = {
  trendWindow: 30,
  trendThreshold: 2.2,
  breakoutPercent: 1.6,
  newsBias: 0.08,
  cooldownSeconds: 300,
};

type WalletTokenHolding = {
  mint: string;
  amount: number;
};

type StoredTradeRecord = JupiterTradeRecord & {
  id: string;
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
    chainlink: "Chainlink",
    binance: "Binance",
    coinbase: "Coinbase",
  };
  return map[status] ?? status;
}

function toTradingViewSymbol(pair: typeof SYMBOLS[number]) {
  const map: Record<typeof SYMBOLS[number], string> = {
    "SOL/USD": "COINBASE:SOLUSD",
    "ETH/USD": "COINBASE:ETHUSD",
    "BTC/USD": "COINBASE:BTCUSD",
  };
  return map[pair];
}

function tradesStorageKey(walletAddress: string) {
  return `brembot.recent-trades.${walletAddress}`;
}

function DashboardPage() {
  const { connection } = useConnection();
  const wallet = useWallet();

  const [priceHistory, setPriceHistory] = useState<Record<string, PricePoint[]>>({});
  const [params, setParams] = useState<UserParams>(DEFAULT_PARAMS);
  const [paramsSaveStatus, setParamsSaveStatus] = useState("Using defaults");
  const [signals, setSignals] = useState<Signal[]>([]);
  const [lastSignalAt, setLastSignalAt] = useState<Record<string, number>>({});
  const [selectedChartPair, setSelectedChartPair] = useState<typeof SYMBOLS[number]>("SOL/USD");
  const [priceFeedStatus, setPriceFeedStatus] = useState("loading");

  const [pushStatus, setPushStatus] = useState("Push not enabled");
  const [pushReady, setPushReady] = useState(false);
  const [pushEnabled, setPushEnabled] = useState(false);
  const [subscription, setSubscription] = useState<PushSubscriptionJSON | null>(null);

  const [solBalance, setSolBalance] = useState<number | null>(null);
  const [walletTokens, setWalletTokens] = useState<WalletTokenHolding[]>([]);
  const [portfolioStatus, setPortfolioStatus] = useState("Wallet not connected");
  const [recentTrades, setRecentTrades] = useState<StoredTradeRecord[]>([]);

  useEffect(() => {
    let cancelled = false;
    let simulateInterval: ReturnType<typeof setInterval> | null = null;
    const simulatedFeed = createSimulatedFeed([...SYMBOLS]);

    const appendPrices = (
      prices: Partial<Record<typeof SYMBOLS[number], number>>,
      now: number
    ) => {
      setPriceHistory((prev) => {
        const next = { ...prev };
        SYMBOLS.forEach((symbol) => {
          const price = Number(prices[symbol]);
          if (!Number.isFinite(price) || price <= 0) return;
          const existing = next[symbol] ?? [];
          next[symbol] = [...existing, { t: now, v: price }].slice(-5400);
        });
        return next;
      });
    };

    const startSimulationFallback = () => {
      if (simulateInterval) return;
      setPriceFeedStatus("simulated");
      simulateInterval = setInterval(() => {
        const updates = simulatedFeed();
        const prices: Partial<Record<typeof SYMBOLS[number], number>> = {};
        updates.forEach((update) => {
          const point = update.points[0];
          if (point) prices[update.symbol as typeof SYMBOLS[number]] = point.v;
        });
        appendPrices(prices, Date.now());
      }, 1000);
    };

    const stopSimulationFallback = () => {
      if (!simulateInterval) return;
      clearInterval(simulateInterval);
      simulateInterval = null;
    };

    const pollLivePrices = async () => {
      try {
        const response = await fetch("/api/prices/live", { cache: "no-store" });
        const payload = await response.json();
        if (!response.ok || !payload?.prices) {
          if (!cancelled) startSimulationFallback();
          return;
        }

        const now = Number(payload.timestamp) || Date.now();
        const source = String(payload.source ?? "unknown");
        const prices = payload.prices as Partial<Record<typeof SYMBOLS[number], number>>;

        if (cancelled) return;
        stopSimulationFallback();
        setPriceFeedStatus(source);
        appendPrices(prices, now);
      } catch {
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
  }, []);

  useEffect(() => {
    const latestNews = getMockNews();
    const newsScore = latestNews.reduce((sum, item) => sum + item.sentiment, 0) / latestNews.length;

    setSignals((prev) => {
      let next = [...prev];
      SYMBOLS.forEach((symbol) => {
        const points = priceHistory[symbol] ?? [];
        if (points.length === 0) return;
        const now = points[points.length - 1].t;
        const recentPoints = points.filter(
          (point) => now - point.t <= params.trendWindow * 60 * 1000
        );
        const minimumDataPoints = params.trendWindow * 45;
        if (recentPoints.length < minimumDataPoints) return;

        const newSignals = detectSignals({
          symbol,
          points: recentPoints,
          params,
          newsScore: newsScore * params.newsBias,
          lastSignalAt: lastSignalAt[symbol],
        });

        if (newSignals.length > 0) {
          setLastSignalAt((prevTimes) => ({
            ...prevTimes,
            [symbol]: now,
          }));

          newSignals.forEach((signal) => {
            if (next.some((existing) => existing.id === signal.id)) return;
            next = [signal, ...next].slice(0, 12);

            if (typeof window !== "undefined" && Notification.permission === "granted") {
              new Notification(`Signal: ${signal.symbol}`, { body: signal.summary });
            }

            if (pushEnabled) {
              fetch("/api/push/notify", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  title: `Signal: ${signal.symbol}`,
                  body: signal.summary,
                  url: "/",
                }),
              }).catch(() => undefined);
            }
          });
        }
      });

      return next;
    });
  }, [lastSignalAt, params, priceHistory, pushEnabled]);

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;

    navigator.serviceWorker
      .register("/sw.js")
      .then(async () => {
        setPushReady(true);
        const registration = await navigator.serviceWorker.ready;
        const existing = await registration.pushManager.getSubscription();
        if (existing) {
          setSubscription(existing.toJSON());
          setPushEnabled(true);
          setPushStatus("Push already enabled");
        }
      })
      .catch(() => {
        setPushStatus("Service worker registration failed");
      });
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
    } catch {
      setParamsSaveStatus("Failed to load saved preset");
    }
  }, []);

  useEffect(() => {
    const walletAddress = wallet.publicKey?.toBase58();
    if (!walletAddress) {
      setRecentTrades([]);
      return;
    }

    try {
      const raw = window.localStorage.getItem(tradesStorageKey(walletAddress));
      if (!raw) {
        setRecentTrades([]);
        return;
      }
      const parsed = JSON.parse(raw) as StoredTradeRecord[];
      setRecentTrades(Array.isArray(parsed) ? parsed : []);
    } catch {
      setRecentTrades([]);
    }
  }, [wallet.publicKey?.toBase58()]);

  async function refreshWalletPortfolio() {
    if (!wallet.connected || !wallet.publicKey) {
      setSolBalance(null);
      setWalletTokens([]);
      setPortfolioStatus("Wallet not connected");
      return;
    }

    try {
      setPortfolioStatus("Syncing wallet balances...");

      const [lamports, tokenAccounts] = await Promise.all([
        connection.getBalance(wallet.publicKey),
        connection.getParsedTokenAccountsByOwner(wallet.publicKey, {
          programId: TOKEN_PROGRAM_ID,
        }),
      ]);

      const holdings = tokenAccounts.value
        .map((accountInfo) => {
          const parsed = accountInfo.account.data.parsed.info;
          const amount = Number(parsed.tokenAmount.uiAmount ?? 0);
          return {
            mint: String(parsed.mint),
            amount,
          } satisfies WalletTokenHolding;
        })
        .filter((holding) => holding.amount > 0)
        .sort((a, b) => b.amount - a.amount)
        .slice(0, 6);

      setSolBalance(lamports / 1_000_000_000);
      setWalletTokens(holdings);
      setPortfolioStatus("Wallet synced");
    } catch {
      setPortfolioStatus("Failed to sync wallet balances");
    }
  }

  useEffect(() => {
    refreshWalletPortfolio().catch(() => undefined);
    const interval = setInterval(() => {
      refreshWalletPortfolio().catch(() => undefined);
    }, 30000);

    return () => clearInterval(interval);
  }, [wallet.connected, wallet.publicKey?.toBase58()]);

  const latestNews = useMemo(() => getMockNews(), [priceHistory]);

  const cards = SYMBOLS.map((symbol) => {
    const points = priceHistory[symbol] ?? [];
    const current = points[points.length - 1]?.v ?? 0;
    const previous = points[points.length - 10]?.v ?? current;
    const change = percentChange(current, previous);
    return { symbol, current, change };
  });

  async function enablePush() {
    if (!pushReady) return;
    if (!("Notification" in window)) {
      setPushStatus("Notifications not supported");
      return;
    }

    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      setPushStatus("Notifications blocked");
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
      setPushStatus("Push enabled");
      setPushEnabled(true);
    } catch {
      setPushStatus("Push subscribe failed");
    }
  }

  async function sendTestPush() {
    if (!subscription) {
      setPushStatus("Enable push first");
      return;
    }

    setPushStatus("Sending test...");
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
  }

  async function disconnectWallet() {
    try {
      await wallet.disconnect();
      setPortfolioStatus("Wallet disconnected");
    } catch {
      setPortfolioStatus("Wallet disconnect failed");
    }
  }

  function saveSignalParams() {
    try {
      window.localStorage.setItem(PARAMS_STORAGE_KEY, JSON.stringify(params));
      setParamsSaveStatus("Saved");
    } catch {
      setParamsSaveStatus("Save failed");
    }
  }

  function resetSignalParams() {
    setParams(DEFAULT_PARAMS);
    try {
      window.localStorage.removeItem(PARAMS_STORAGE_KEY);
    } catch {
      // ignore storage errors
    }
    setParamsSaveStatus("Reset to defaults");
  }

  function handleTradeSuccess(trade: JupiterTradeRecord) {
    const walletAddress = trade.walletAddress ?? wallet.publicKey?.toBase58();
    if (!walletAddress) return;

    const entry: StoredTradeRecord = {
      ...trade,
      walletAddress,
      id: `${trade.txid}-${trade.timestamp}`,
    };

    setRecentTrades((prev) => {
      const next = [entry, ...prev.filter((item) => item.txid !== entry.txid)].slice(0, 20);
      try {
        window.localStorage.setItem(tradesStorageKey(walletAddress), JSON.stringify(next));
      } catch {
        // ignore storage errors
      }
      return next;
    });
  }

  return (
    <main>
      <JupiterTradePanel onTradeSuccess={handleTradeSuccess} />

      <header>
        <div className="header-row">
          <div>
            <div className="title">PulseSignal Desk</div>
            <div className="subtext">
              Real-time crypto signals with wallet-linked execution via Jupiter Plugin.
            </div>
          </div>
          <div className="header-alert-slot">
            <div className="panel compact-panel alerts-row-panel">
              <strong>Alerts & Push</strong>
              <span className="subtext">{pushStatus}</span>
              <div className="alerts-actions">
                <button onClick={enablePush} disabled={!pushReady}>Enable Push</button>
                <button className="secondary" onClick={sendTestPush}>Send Test Push</button>
              </div>
            </div>
          </div>
          <div className="badges">
            <div className="badge">Price Feed: {formatFeedSource(priceFeedStatus)}</div>
            <div className="badge">Jupiter: widget</div>
          </div>
        </div>

        <div className="grid">
          {cards.map((card) => (
            <button
              key={card.symbol}
              type="button"
              className={`panel price-card ${selectedChartPair === card.symbol ? "active" : ""}`}
              onClick={() => setSelectedChartPair(card.symbol)}
            >
              <h3>{card.symbol}</h3>
              <div className="price">{formatUsd(card.current)}</div>
              <div className="subtext">
                10s change {card.change >= 0 ? "+" : ""}
                {card.change.toFixed(2)}%
              </div>
            </button>
          ))}
        </div>
      </header>

      <section className="panel chart-panel" style={{ marginBottom: 22 }}>
        <h3>TradingView Chart</h3>
        <div className="subtext" style={{ marginBottom: 10 }}>
          Live market chart aligned with signal scanning. Selected: {selectedChartPair}
        </div>
        <div className="tradingview-wrap">
          <TradingViewChart symbol={toTradingViewSymbol(selectedChartPair)} />
        </div>
      </section>

      <section className="grid" style={{ marginBottom: 22 }}>
        <div className="panel">
          <h3>Wallet Connect</h3>
          <div className="wallet-controls">
            <WalletMultiButton key={wallet.publicKey?.toBase58() ?? "wallet-multi-button"} />
            <WalletModalButton className="wallet-adapter-button wallet-change">
              Select Wallet
            </WalletModalButton>
            <button className="secondary" onClick={refreshWalletPortfolio}>Refresh Wallet</button>
            {wallet.connected ? <button onClick={disconnectWallet}>Disconnect</button> : null}
          </div>
          <div className="subtext" style={{ marginTop: 10 }}>
            {wallet.publicKey
              ? `Address: ${shortAddress(wallet.publicKey.toBase58())}`
              : "Connect Phantom or Solflare to trade."}
          </div>
          <div className="subtext" style={{ marginTop: 6 }}>{portfolioStatus}</div>
          <div className="wallet-holdings">
            <div className="holding-row">
              <span>SOL</span>
              <strong>{solBalance === null ? "-" : solBalance.toFixed(4)}</strong>
            </div>
            {walletTokens.map((token) => (
              <div key={token.mint} className="holding-row">
                <span>{shortAddress(token.mint)}</span>
                <strong>{token.amount.toFixed(4)}</strong>
              </div>
            ))}
          </div>
        </div>

        <div className="panel">
          <h3>Signal Parameters</h3>
          <div className="controls params-toolbar">
            <div className="subtext">{paramsSaveStatus}</div>
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
          </div>
        </div>
      </section>

      <section className="grid" style={{ marginBottom: 22 }}>
        <div className="panel">
          <h3>Live Signals</h3>
          {signals.length === 0 && <div className="subtext">Waiting for signal triggers.</div>}
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
              </div>
              <div>{Math.round(signal.confidence * 100)}%</div>
            </div>
          ))}
        </div>

        <div className="panel">
          <h3>Recent Trades</h3>
          {!wallet.publicKey && (
            <div className="subtext">Connect a wallet to view trade history linked to that address.</div>
          )}
          {wallet.publicKey && recentTrades.length === 0 && (
            <div className="subtext">No recent trades recorded for this wallet yet.</div>
          )}
          {wallet.publicKey && recentTrades.map((trade) => (
            <div key={trade.id} className="news-item">
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                <span>Swap via Jupiter</span>
                <span className="subtext">{new Date(trade.timestamp).toLocaleTimeString()}</span>
              </div>
              <div className="news-meta">
                <span>{shortAddress(trade.txid)}</span>
                <a
                  href={`https://solscan.io/tx/${trade.txid}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  View Tx
                </a>
              </div>
            </div>
          ))}
        </div>

        <div className="panel">
          <h3>News Pulse</h3>
          {latestNews.map((item) => (
            <div key={item.id} className="news-item">
              <div>{item.headline}</div>
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
