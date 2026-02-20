"use client";

import { useEffect, useMemo, useState } from "react";
import { createSimulatedFeed, type PricePoint } from "@/lib/price/simulated";
import { detectSignals, type Signal, type UserParams } from "@/lib/signal/engine";
import { getMockNews } from "@/lib/news/mock";
import { formatUsd, percentChange } from "@/lib/utils";

const SYMBOLS = ["BTC/USD", "ETH/USD", "SOL/USD"] as const;
const HAS_CHAOS_EDGE = Boolean(
  process.env.NEXT_PUBLIC_CHAOS_EDGE_URL && process.env.NEXT_PUBLIC_CHAOS_EDGE_TOKEN
);
const HAS_CHAINLINK = Boolean(
  process.env.NEXT_PUBLIC_ETHEREUM_RPC_URL || process.env.NEXT_PUBLIC_SOLANA_RPC_URL
);

const DEFAULT_PARAMS: UserParams = {
  trendWindow: 12,
  trendThreshold: 0.6,
  breakoutPercent: 0.5,
  newsBias: 0.25,
  cooldownMinutes: 2,
};

function urlBase64ToUint8Array(base64String: string) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((char) => char.charCodeAt(0)));
}

export default function Page() {
  const [priceHistory, setPriceHistory] = useState<Record<string, PricePoint[]>>({});
  const [params, setParams] = useState<UserParams>(DEFAULT_PARAMS);
  const [signals, setSignals] = useState<Signal[]>([]);
  const [lastSignalAt, setLastSignalAt] = useState<Record<string, number>>({});
  const [pushStatus, setPushStatus] = useState("Push not enabled");
  const [pushReady, setPushReady] = useState(false);
  const [pushEnabled, setPushEnabled] = useState(false);

  useEffect(() => {
    const feed = createSimulatedFeed([...SYMBOLS]);
    const interval = setInterval(() => {
      const updates = feed();
      setPriceHistory((prev) => {
        const next = { ...prev };
        updates.forEach((update) => {
          const existing = next[update.symbol] ?? [];
          const merged = [...existing, ...update.points];
          next[update.symbol] = merged.slice(-300);
        });
        return next;
      });
    }, 1000);

    return () => clearInterval(interval);
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
  }, [priceHistory, params, lastSignalAt]);

  useEffect(() => {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").then(() => setPushReady(true));
    }
  }, []);

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

    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });

    await fetch("/api/push/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(subscription),
    });

    setPushStatus("Push enabled");
    setPushEnabled(true);
  }

  async function sendTestPush() {
    setPushStatus("Sending test...");
    const response = await fetch("/api/push/test", { method: "POST" });
    if (!response.ok) {
      setPushStatus("Push test failed");
      return;
    }
    setPushStatus("Test push sent");
  }

  return (
    <main>
      <header>
        <div className="header-row">
          <div>
            <div className="title">PulseSignal Desk</div>
            <div className="subtext">
              Real-time crypto signals with Chaos Edge primary feed and Chainlink backup.
            </div>
          </div>
          <div className="badges">
            <div className="badge">Chaos Edge: {HAS_CHAOS_EDGE ? "live" : "simulated"}</div>
            <div className="badge">Chainlink: {HAS_CHAINLINK ? "ready" : "standby"}</div>
            <div className="badge">News: X (mock)</div>
          </div>
        </div>
        <div className="grid">
          {cards.map((card) => (
            <div key={card.symbol} className="panel">
              <h3>{card.symbol}</h3>
              <div className="price">{formatUsd(card.current)}</div>
              <div className="subtext">
                10s change {card.change >= 0 ? "+" : ""}{card.change.toFixed(2)}%
              </div>
            </div>
          ))}
        </div>
      </header>

      <section className="grid" style={{ marginBottom: 22 }}>
        <div className="panel">
          <h3>Signal Parameters</h3>
          <div className="controls">
            <label>
              Trend window (min)
              <input
                type="number"
                value={params.trendWindow}
                min={2}
                max={60}
                step={1}
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
                min={0.2}
                max={5}
                step={0.1}
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
                min={0.2}
                max={5}
                step={0.1}
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
                max={1}
                step={0.05}
                onChange={(event) =>
                  setParams((prev) => ({ ...prev, newsBias: Number(event.target.value) }))
                }
              />
            </label>
            <label>
              Cooldown (min)
              <input
                type="number"
                value={params.cooldownMinutes}
                min={1}
                max={30}
                step={1}
                onChange={(event) =>
                  setParams((prev) => ({ ...prev, cooldownMinutes: Number(event.target.value) }))
                }
              />
            </label>
          </div>
        </div>

        <div className="panel">
          <h3>Alerts & Push</h3>
          <div className="subtext" style={{ marginBottom: 12 }}>
            {pushStatus}
          </div>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            <button onClick={enablePush} disabled={!pushReady}>
              Enable Push
            </button>
            <button className="secondary" onClick={sendTestPush}>
              Send Test Push
            </button>
          </div>
          <div className="footer">
            In-app alerts fire automatically when thresholds are met.
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
                <div>{signal.symbol} · {signal.type.toUpperCase()}</div>
                <div className="signal-meta">{signal.summary}</div>
              </div>
              <div>{Math.round(signal.confidence * 100)}%</div>
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
        Signals are informational only and not financial advice. Configure live feeds and social integrations before trading.
      </div>
    </main>
  );
}
