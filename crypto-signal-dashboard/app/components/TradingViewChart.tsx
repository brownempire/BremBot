"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  AreaSeries,
  ColorType,
  CrosshairMode,
  LineStyle,
  createChart,
  type AreaData,
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

type ChartRangeKey = "15m" | "1h" | "6h" | "24h" | "all";

const RANGE_STORAGE_KEY = "brembot.lightweight.range.v1";
const DEFAULT_RANGE: ChartRangeKey = "1h";
const RANGE_WINDOW_MS: Record<Exclude<ChartRangeKey, "all">, number> = {
  "15m": 15 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  "6h": 6 * 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
};

function getGuideColor(tone: TradingViewGuide["tone"]) {
  return tone === "tp" ? "#4ce38a" : "#3ba7ff";
}

function normalizeSymbolLabel(symbol: string) {
  if (!symbol) return "Market";
  const normalized = symbol.includes(":") ? symbol.split(":").at(-1) ?? symbol : symbol;
  return normalized.replace("USD", "/USD");
}

function buildSeriesData(
  pricePoints: Array<{ t: number; v: number }>,
  selectedRange: ChartRangeKey
): AreaData<Time>[] {
  const validPoints = pricePoints.filter((point) => Number.isFinite(point.t) && Number.isFinite(point.v) && point.v > 0);
  if (validPoints.length === 0) return [];

  const latestTimestamp = validPoints[validPoints.length - 1]?.t ?? Date.now();
  const filteredPoints =
    selectedRange === "all"
      ? validPoints
      : validPoints.filter((point) => point.t >= latestTimestamp - RANGE_WINDOW_MS[selectedRange]);

  const targetPointCount =
    selectedRange === "15m" ? 180 : selectedRange === "1h" ? 240 : selectedRange === "6h" ? 360 : 480;
  const stride = Math.max(1, Math.ceil(filteredPoints.length / targetPointCount));
  const reduced: typeof filteredPoints = [];

  for (let index = 0; index < filteredPoints.length; index += stride) {
    reduced.push(filteredPoints[index]);
  }

  const lastPoint = filteredPoints[filteredPoints.length - 1];
  if (lastPoint && reduced[reduced.length - 1]?.t !== lastPoint.t) {
    reduced.push(lastPoint);
  }

  return reduced.map((point) => ({
    time: Math.floor(point.t / 1000) as UTCTimestamp,
    value: point.v,
  }));
}

export function TradingViewChart({
  symbol = "COINBASE:BTCUSD",
  guides = [],
  pricePoints = [],
}: TradingViewChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Area", Time> | null>(null);
  const guideLinesRef = useRef<IPriceLine[]>([]);
  const [selectedRange, setSelectedRange] = useState<ChartRangeKey>(DEFAULT_RANGE);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const storedRange = window.localStorage.getItem(RANGE_STORAGE_KEY) as ChartRangeKey | null;
    if (storedRange && ["15m", "1h", "6h", "24h", "all"].includes(storedRange)) {
      setSelectedRange(storedRange);
    }
  }, []);

  const seriesData = useMemo(() => buildSeriesData(pricePoints, selectedRange), [pricePoints, selectedRange]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const chart = createChart(container, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "#0d1119" },
        textColor: "#9aa7c7",
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: "rgba(120, 144, 184, 0.12)" },
        horzLines: { color: "rgba(120, 144, 184, 0.12)" },
      },
      crosshair: {
        mode: CrosshairMode.Magnet,
        vertLine: {
          color: "rgba(101, 217, 255, 0.35)",
          labelBackgroundColor: "#0f2030",
        },
        horzLine: {
          color: "rgba(101, 217, 255, 0.35)",
          labelBackgroundColor: "#0f2030",
        },
      },
      rightPriceScale: {
        borderColor: "rgba(120, 144, 184, 0.2)",
        minimumWidth: 90,
        scaleMargins: {
          top: 0.12,
          bottom: 0.12,
        },
      },
      timeScale: {
        borderColor: "rgba(120, 144, 184, 0.2)",
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 8,
        fixLeftEdge: true,
      },
      localization: {
        priceFormatter: (value: number) => `$${value.toFixed(value >= 1000 ? 2 : 4)}`,
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

    const series = chart.addSeries(AreaSeries, {
      lineColor: "#65d9ff",
      topColor: "rgba(101, 217, 255, 0.30)",
      bottomColor: "rgba(101, 217, 255, 0.03)",
      lineWidth: 2,
      crosshairMarkerRadius: 4,
      priceLineVisible: true,
      lastValueVisible: true,
      priceFormat: {
        type: "price",
        precision: 4,
        minMove: 0.0001,
      },
    });

    chartRef.current = chart;
    seriesRef.current = series;

    const resizeObserver = new ResizeObserver(() => {
      const width = container.clientWidth;
      const height = container.clientHeight;
      chart.resize(width, height);
    });
    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
      guideLinesRef.current = [];
      seriesRef.current = null;
      chartRef.current = null;
      chart.remove();
    };
  }, []);

  useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(RANGE_STORAGE_KEY, selectedRange);
    }
  }, [selectedRange]);

  useEffect(() => {
    const chart = chartRef.current;
    const series = seriesRef.current;
    if (!chart || !series) return;

    series.setData(seriesData);

    guideLinesRef.current.forEach((line) => {
      series.removePriceLine(line);
    });
    guideLinesRef.current = [];

    guides
      .filter((guide) => Number.isFinite(guide.price) && guide.price > 0)
      .forEach((guide) => {
        const priceLine = series.createPriceLine({
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

    if (seriesData.length > 1) {
      chart.timeScale().fitContent();
    }
  }, [guides, seriesData]);

  const latestPoint = seriesData[seriesData.length - 1];
  const latestValue = typeof latestPoint?.value === "number" ? latestPoint.value : null;

  return (
    <div className="tradingview-frame lightweight-chart-shell">
      <div className="lightweight-chart-toolbar">
        <div className="lightweight-chart-symbol">
          <span>{normalizeSymbolLabel(symbol)}</span>
          {latestValue ? <strong>{`$${latestValue.toFixed(latestValue >= 1000 ? 2 : 4)}`}</strong> : null}
        </div>
        <div className="lightweight-chart-range-group">
          {(["15m", "1h", "6h", "24h", "all"] as ChartRangeKey[]).map((range) => (
            <button
              key={range}
              type="button"
              className={range === selectedRange ? "active" : undefined}
              onClick={() => setSelectedRange(range)}
            >
              {range === "all" ? "All" : range}
            </button>
          ))}
        </div>
      </div>
      <div ref={containerRef} className="tradingview-container" />
      {seriesData.length === 0 ? (
        <div className="lightweight-chart-empty">Chart data is loading. Price lines will appear as soon as market data arrives.</div>
      ) : null}
    </div>
  );
}
