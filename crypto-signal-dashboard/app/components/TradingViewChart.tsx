"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineStyle,
  PriceScaleMode,
  createChart,
  type CandlestickData,
  type HistogramData,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";

type TradingViewGuide = {
  label: string;
  price: number;
  tone: "entry" | "tp";
};

type TradingViewChartProps = {
  symbol?: string;
  guides?: TradingViewGuide[];
  pricePoints?: Array<{ t: number; v: number }>;
};

type CandleIntervalKey = "1m" | "5m" | "15m" | "1h" | "1d";

type CandleWithVolume = CandlestickData<Time> & {
  volume: number;
};

const INTERVAL_STORAGE_KEY = "brembot.lightweight.interval.v2";
const DEFAULT_INTERVAL: CandleIntervalKey = "5m";
const CANDLE_INTERVALS: Array<{ key: CandleIntervalKey; label: string; seconds: number }> = [
  { key: "1m", label: "1m", seconds: 60 },
  { key: "5m", label: "5m", seconds: 5 * 60 },
  { key: "15m", label: "15m", seconds: 15 * 60 },
  { key: "1h", label: "1H", seconds: 60 * 60 },
  { key: "1d", label: "1D", seconds: 24 * 60 * 60 },
];

function getGuideColor(tone: TradingViewGuide["tone"]) {
  return tone === "tp" ? "#4ce38a" : "#3ba7ff";
}

function normalizeSymbolLabel(symbol: string) {
  if (!symbol) return "Market";
  const normalized = symbol.includes(":") ? symbol.split(":").at(-1) ?? symbol : symbol;
  return normalized.replace("USD", "/USD");
}

function formatPrice(value: number) {
  if (!Number.isFinite(value)) return "-";
  return `$${value.toLocaleString(undefined, {
    minimumFractionDigits: value >= 1000 ? 2 : 4,
    maximumFractionDigits: value >= 1000 ? 2 : 4,
  })}`;
}

function aggregateCandles(
  pricePoints: Array<{ t: number; v: number }>,
  intervalKey: CandleIntervalKey
): CandleWithVolume[] {
  const intervalSeconds = CANDLE_INTERVALS.find((entry) => entry.key === intervalKey)?.seconds ?? 300;
  const intervalMs = intervalSeconds * 1000;
  const validPoints = pricePoints.filter((point) => Number.isFinite(point.t) && Number.isFinite(point.v) && point.v > 0);
  if (validPoints.length === 0) return [];

  const buckets = new Map<number, CandleWithVolume & { tickCount: number; movement: number; lastValue: number }>();

  validPoints.forEach((point) => {
    const bucketTime = Math.floor(point.t / intervalMs) * intervalMs;
    const existing = buckets.get(bucketTime);

    if (!existing) {
      buckets.set(bucketTime, {
        time: Math.floor(bucketTime / 1000) as UTCTimestamp,
        open: point.v,
        high: point.v,
        low: point.v,
        close: point.v,
        volume: 1,
        tickCount: 1,
        movement: 0,
        lastValue: point.v,
      });
      return;
    }

    existing.high = Math.max(existing.high, point.v);
    existing.low = Math.min(existing.low, point.v);
    existing.close = point.v;
    existing.tickCount += 1;
    existing.movement += Math.abs(point.v - existing.lastValue);
    existing.lastValue = point.v;
  });

  return [...buckets.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([, bucket]) => {
      const directionalMove = Math.abs(bucket.close - bucket.open);
      const movementWeight = bucket.open > 0 ? (bucket.movement + directionalMove) / bucket.open : 0;
      // Lightweight Charts needs a volume series value; until a real exchange volume feed is wired in,
      // derive a stable activity bar from tick density plus absolute price travel inside the candle.
      const syntheticVolume = Math.max(1, bucket.tickCount * 8 + movementWeight * 12000);

      return {
        time: bucket.time,
        open: bucket.open,
        high: bucket.high,
        low: bucket.low,
        close: bucket.close,
        volume: syntheticVolume,
      };
    });
}

export function TradingViewChart({
  symbol = "COINBASE:BTCUSD",
  guides = [],
  pricePoints = [],
}: TradingViewChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick", Time> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<"Histogram", Time> | null>(null);
  const guideLinesRef = useRef<IPriceLine[]>([]);
  const [selectedInterval, setSelectedInterval] = useState<CandleIntervalKey>(DEFAULT_INTERVAL);
  const [showVolume, setShowVolume] = useState(true);
  const [showGrid, setShowGrid] = useState(true);
  const [showWicks, setShowWicks] = useState(true);
  const [showSettings, setShowSettings] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const storedInterval = window.localStorage.getItem(INTERVAL_STORAGE_KEY) as CandleIntervalKey | null;
    if (storedInterval && CANDLE_INTERVALS.some((entry) => entry.key === storedInterval)) {
      setSelectedInterval(storedInterval);
    }
  }, []);

  const candles = useMemo(() => aggregateCandles(pricePoints, selectedInterval), [pricePoints, selectedInterval]);

  const volumeBars = useMemo<HistogramData<Time>[]>(() => {
    if (!showVolume) return [];
    return candles.map((candle) => ({
      time: candle.time,
      value: candle.volume,
      color: candle.close >= candle.open ? "rgba(76, 227, 138, 0.68)" : "rgba(255, 96, 96, 0.68)",
    }));
  }, [candles, showVolume]);

  const latestCandle = candles[candles.length - 1] ?? null;
  const previousCandle = candles[candles.length - 2] ?? null;
  const changeValue = latestCandle && previousCandle ? latestCandle.close - previousCandle.close : 0;
  const changePercent =
    latestCandle && previousCandle && previousCandle.close > 0
      ? (changeValue / previousCandle.close) * 100
      : 0;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const chart = createChart(container, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "#0b0f17" },
        textColor: "#9aa7c7",
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: "rgba(120, 144, 184, 0.12)", visible: true },
        horzLines: { color: "rgba(120, 144, 184, 0.12)", visible: true },
      },
      crosshair: {
        mode: CrosshairMode.Magnet,
        vertLine: {
          color: "rgba(101, 217, 255, 0.32)",
          labelBackgroundColor: "#0f2030",
        },
        horzLine: {
          color: "rgba(101, 217, 255, 0.32)",
          labelBackgroundColor: "#0f2030",
        },
      },
      rightPriceScale: {
        borderColor: "rgba(120, 144, 184, 0.16)",
        minimumWidth: 96,
        mode: PriceScaleMode.Normal,
        autoScale: true,
        scaleMargins: {
          top: 0.08,
          bottom: 0.24,
        },
      },
      leftPriceScale: {
        visible: false,
      },
      timeScale: {
        borderColor: "rgba(120, 144, 184, 0.16)",
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 12,
        barSpacing: 12,
        minBarSpacing: 4,
        fixLeftEdge: true,
      },
      localization: {
        priceFormatter: (value: number) => formatPrice(value),
      },
      handleScroll: {
        mouseWheel: true,
        pressedMouseMove: true,
        horzTouchDrag: true,
        vertTouchDrag: false,
      },
      handleScale: {
        axisPressedMouseMove: true,
        mouseWheel: true,
        pinch: true,
      },
    });

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: "#22c55e",
      downColor: "#ff5f5f",
      borderVisible: true,
      wickVisible: true,
      borderUpColor: "#22c55e",
      borderDownColor: "#ff5f5f",
      wickUpColor: "#63f59b",
      wickDownColor: "#ff8585",
      priceLineVisible: true,
      lastValueVisible: true,
      priceFormat: {
        type: "price",
        precision: 4,
        minMove: 0.0001,
      },
    });

    const volumeSeries = chart.addSeries(HistogramSeries, {
      priceScaleId: "",
      priceFormat: {
        type: "volume",
      },
    });
    volumeSeries.priceScale().applyOptions({
      scaleMargins: {
        top: 0.78,
        bottom: 0,
      },
    });

    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;
    volumeSeriesRef.current = volumeSeries;

    const resizeObserver = new ResizeObserver(() => {
      chart.resize(container.clientWidth, container.clientHeight);
    });
    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
      guideLinesRef.current = [];
      candleSeriesRef.current = null;
      volumeSeriesRef.current = null;
      chartRef.current = null;
      chart.remove();
    };
  }, []);

  useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(INTERVAL_STORAGE_KEY, selectedInterval);
    }
  }, [selectedInterval]);

  useEffect(() => {
    const chart = chartRef.current;
    const candleSeries = candleSeriesRef.current;
    const volumeSeries = volumeSeriesRef.current;
    if (!chart || !candleSeries || !volumeSeries) return;

    candleSeries.setData(candles);
    volumeSeries.setData(volumeBars);

    guideLinesRef.current.forEach((line) => {
      candleSeries.removePriceLine(line);
    });
    guideLinesRef.current = [];

    guides
      .filter((guide) => Number.isFinite(guide.price) && guide.price > 0)
      .forEach((guide) => {
        const priceLine = candleSeries.createPriceLine({
          price: guide.price,
          color: getGuideColor(guide.tone),
          lineWidth: 2,
          lineStyle: guide.tone === "tp" ? LineStyle.Dashed : LineStyle.Solid,
          axisLabelVisible: true,
          lineVisible: true,
          title: guide.label,
        });
        guideLinesRef.current.push(priceLine);
      });

    candleSeries.applyOptions({
      wickVisible: showWicks,
      borderVisible: true,
      lastValueVisible: true,
      priceLineVisible: true,
    });

    chart.applyOptions({
      grid: {
        vertLines: { color: "rgba(120, 144, 184, 0.12)", visible: showGrid },
        horzLines: { color: "rgba(120, 144, 184, 0.12)", visible: showGrid },
      },
      rightPriceScale: {
        borderColor: "rgba(120, 144, 184, 0.16)",
        minimumWidth: 96,
        mode: PriceScaleMode.Normal,
        autoScale: true,
        scaleMargins: {
          top: 0.08,
          bottom: showVolume ? 0.24 : 0.08,
        },
      },
    });

    if (candles.length > 1) {
      chart.timeScale().fitContent();
    }
  }, [candles, guides, showGrid, showVolume, showWicks, volumeBars]);

  function zoomBy(delta: number) {
    const chart = chartRef.current;
    if (!chart) return;
    const current = chart.timeScale().getVisibleLogicalRange();
    if (!current) return;
    const midpoint = (current.from + current.to) / 2;
    const currentSpan = current.to - current.from;
    const nextSpan = Math.max(8, currentSpan + delta);
    chart.timeScale().setVisibleLogicalRange({
      from: midpoint - nextSpan / 2,
      to: midpoint + nextSpan / 2,
    });
  }

  function fitChart() {
    chartRef.current?.timeScale().fitContent();
  }

  return (
    <div className="tradingview-frame lightweight-chart-shell">
      <div className="lightweight-chart-topbar">
        <div className="lightweight-chart-topbar-left">
          <div className="lightweight-chart-symbol-block">
            <strong>{normalizeSymbolLabel(symbol)}</strong>
            {latestCandle ? (
              <span className={changeValue >= 0 ? "positive" : "negative"}>
                {formatPrice(latestCandle.close)} {changePercent >= 0 ? "+" : ""}
                {changePercent.toFixed(2)}%
              </span>
            ) : (
              <span>Waiting for live data</span>
            )}
          </div>
          <div className="lightweight-chart-ohlc">
            <span>O {latestCandle ? latestCandle.open.toFixed(2) : "-"}</span>
            <span>H {latestCandle ? latestCandle.high.toFixed(2) : "-"}</span>
            <span>L {latestCandle ? latestCandle.low.toFixed(2) : "-"}</span>
            <span>C {latestCandle ? latestCandle.close.toFixed(2) : "-"}</span>
          </div>
        </div>
        <div className="lightweight-chart-topbar-right">
          <div className="lightweight-chart-range-group">
            {CANDLE_INTERVALS.map((interval) => (
              <button
                key={interval.key}
                type="button"
                className={interval.key === selectedInterval ? "active" : undefined}
                onClick={() => setSelectedInterval(interval.key)}
              >
                {interval.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            className={`lightweight-chart-toolbar-button${showSettings ? " active" : ""}`}
            onClick={() => setShowSettings((current) => !current)}
          >
            Settings
          </button>
        </div>
      </div>

      <div className="lightweight-chart-main">
        <aside className="lightweight-chart-sidebar" aria-label="Chart tools">
          <button type="button" title="Zoom in" onClick={() => zoomBy(-12)}>+</button>
          <button type="button" title="Zoom out" onClick={() => zoomBy(12)}>-</button>
          <button type="button" title="Fit chart" onClick={fitChart}>Fit</button>
          <button type="button" className={showGrid ? "active" : ""} title="Toggle grid" onClick={() => setShowGrid((current) => !current)}>Grid</button>
          <button type="button" className={showVolume ? "active" : ""} title="Toggle volume" onClick={() => setShowVolume((current) => !current)}>Vol</button>
          <button type="button" className={showWicks ? "active" : ""} title="Toggle wicks" onClick={() => setShowWicks((current) => !current)}>Wick</button>
        </aside>

        <div className="lightweight-chart-stage">
          <div ref={containerRef} className="tradingview-container" />
          {showSettings ? (
            <div className="lightweight-chart-settings">
              <strong>Chart settings</strong>
              <label>
                <input type="checkbox" checked={showVolume} onChange={() => setShowVolume((current) => !current)} />
                Show volume bars
              </label>
              <label>
                <input type="checkbox" checked={showGrid} onChange={() => setShowGrid((current) => !current)} />
                Show grid
              </label>
              <label>
                <input type="checkbox" checked={showWicks} onChange={() => setShowWicks((current) => !current)} />
                Show candle wicks
              </label>
              <p>Entry and TP stay attached as native chart price lines.</p>
              <p>Volume is activity-derived until a direct exchange volume feed is wired in.</p>
            </div>
          ) : null}
        </div>
      </div>

      {candles.length === 0 ? (
        <div className="lightweight-chart-empty">
          Chart data is loading. OHLC candles, volume bars, and Entry/TP lines will appear as soon as market data arrives.
        </div>
      ) : null}
    </div>
  );
}
