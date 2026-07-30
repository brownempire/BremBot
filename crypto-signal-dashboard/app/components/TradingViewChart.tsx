"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { createBremLogicDatafeed } from "@/lib/chart/tradingViewDatafeed";
import {
  validOverlayGuides,
  type PositionOverlayGuide,
} from "@/lib/chart/positionOverlay";

declare global {
  interface Window {
    TradingView?: {
      widget: new (config: Record<string, unknown>) => WidgetApi;
    };
  }
}

type IntervalSubscription = {
  subscribe?: (context: unknown, callback: (interval: unknown) => void) => void;
};

type WidgetChart = {
  onIntervalChanged?: () => IntervalSubscription;
  resolution?: () => string;
  getPanes?: () => Array<{
    getMainSourcePriceScale?: () => {
      getVisiblePriceRange?: () => { from: number; to: number } | null;
      setAutoScale?: (enabled: boolean) => void;
      setVisiblePriceRange?: (range: { from: number; to: number }) => void;
    } | null;
  }>;
  createShape?: (
    point: { price: number },
    options: Record<string, unknown>
  ) => Promise<string>;
  removeEntity?: (id: string) => void;
};

type WidgetApi = {
  onChartReady?: (callback: () => void) => void;
  chartReady?: () => Promise<void>;
  activeChart?: () => WidgetChart;
  remove?: () => void;
};

type TradingViewChartProps = {
  symbol?: string;
  guides?: PositionOverlayGuide[];
};

const SCRIPT_ID = "tradingview-advanced-charts-script";
const DEFAULT_LIBRARY_PATH =
  "https://bremlogic-tradingview-assets.vercel.app/charting_library/";
const LIBRARY_PATH = `${
  process.env.NEXT_PUBLIC_TRADINGVIEW_LIBRARY_PATH?.trim() || DEFAULT_LIBRARY_PATH
}`.replace(/\/?$/, "/");
const SCRIPT_SRC = `${LIBRARY_PATH}charting_library.standalone.js`;
const INTERVAL_STORAGE_KEY = "brembot.tradingview.interval.v3";
const DEFAULT_INTERVAL = "15";
const DEFAULT_FAVORITE_INTERVALS = ["1", "5", "15", "60", "360", "1D"];
let scriptLoadingPromise: Promise<void> | null = null;

function loadTradingViewScript() {
  if (window.TradingView?.widget) return Promise.resolve();
  if (scriptLoadingPromise) return scriptLoadingPromise;

  scriptLoadingPromise = new Promise<void>((resolve, reject) => {
    const existingScript = document.getElementById(SCRIPT_ID) as HTMLScriptElement | null;
    if (existingScript) {
      existingScript.addEventListener("load", () => resolve(), { once: true });
      existingScript.addEventListener(
        "error",
        () => reject(new Error("TradingView Advanced Charts failed to load")),
        { once: true }
      );
      return;
    }

    const script = document.createElement("script");
    script.id = SCRIPT_ID;
    script.src = SCRIPT_SRC;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      scriptLoadingPromise = null;
      reject(new Error("TradingView Advanced Charts failed to load"));
    };
    document.head.appendChild(script);
  });

  return scriptLoadingPromise;
}

function shouldLockPageScrollForChartHover() {
  if (typeof window === "undefined" || typeof navigator === "undefined") return false;

  const hasDesktopHover =
    typeof window.matchMedia === "function"
      ? window.matchMedia("(hover: hover) and (pointer: fine)").matches
      : false;
  const looksLikeMac = /Mac/i.test(navigator.userAgent);
  const hasNoTouchPoints = Number(navigator.maxTouchPoints ?? 0) === 0;

  return hasDesktopHover && (looksLikeMac || hasNoTouchPoints);
}

export function TradingViewChart({
  symbol = "COINBASE:BTCUSD",
  guides = [],
}: TradingViewChartProps) {
  const containerId = useMemo(() => "tradingview_advanced_chart", []);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const widgetRef = useRef<WidgetApi | null>(null);
  const shapeIdsRef = useRef<string[]>([]);
  const guidesRef = useRef(guides);
  const [chartReadyVersion, setChartReadyVersion] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  guidesRef.current = guides;

  const guideSignature = validOverlayGuides(guides)
    .map((guide) => `${guide.id}:${guide.price}:${guide.label}:${guide.tone}`)
    .join("|");

  useEffect(() => {
    let cancelled = false;

    const renderWidget = async () => {
      const container = document.getElementById(containerId);
      if (!container) return;

      container.innerHTML = "";
      widgetRef.current?.remove?.();
      widgetRef.current = null;
      setLoadError(null);

      try {
        await loadTradingViewScript();
        if (cancelled || !window.TradingView?.widget) return;

        const storedInterval =
          window.localStorage.getItem(INTERVAL_STORAGE_KEY) ?? DEFAULT_INTERVAL;
        const widget = new window.TradingView.widget({
          autosize: true,
          container,
          datafeed: createBremLogicDatafeed(),
          library_path: LIBRARY_PATH,
          symbol,
          interval: storedInterval,
          favorites: {
            intervals: DEFAULT_FAVORITE_INTERVALS,
          },
          timezone: "America/New_York",
          theme: "dark",
          locale: "en",
          load_last_chart: false,
          disabled_features: [
            "header_saveload",
            "header_symbol_search",
            "symbol_search_hot_key",
          ],
          enabled_features: [
            "use_localstorage_for_settings",
            "save_chart_properties_to_local_storage",
          ],
          time_frames: [
            { text: "1d", resolution: "5", description: "1 Day" },
            { text: "5d", resolution: "15", description: "5 Days" },
            { text: "1m", resolution: "60", description: "1 Month" },
            { text: "3m", resolution: "360", description: "3 Months" },
          ],
          custom_css_url: new URL(
            "/tradingview-advanced.css",
            window.location.origin
          ).href,
          overrides: {
            "paneProperties.background": "#07111f",
            "paneProperties.backgroundType": "solid",
            "paneProperties.vertGridProperties.color": "rgba(133, 164, 205, 0.08)",
            "paneProperties.horzGridProperties.color": "rgba(133, 164, 205, 0.08)",
            "scalesProperties.textColor": "#9fb0ca",
            "mainSeriesProperties.candleStyle.upColor": "#2ed89b",
            "mainSeriesProperties.candleStyle.downColor": "#ff647c",
            "mainSeriesProperties.candleStyle.borderUpColor": "#2ed89b",
            "mainSeriesProperties.candleStyle.borderDownColor": "#ff647c",
            "mainSeriesProperties.candleStyle.wickUpColor": "#2ed89b",
            "mainSeriesProperties.candleStyle.wickDownColor": "#ff647c",
          },
        });

        widgetRef.current = widget;
        const handleChartReady = () => {
          if (cancelled) return;
          setChartReadyVersion((version) => version + 1);
          const chart = widget.activeChart?.();
          const currentResolution = chart?.resolution?.();
          if (currentResolution) {
            window.localStorage.setItem(INTERVAL_STORAGE_KEY, currentResolution);
          }
          chart?.onIntervalChanged?.().subscribe?.(null, (nextInterval) => {
            const interval = String(nextInterval || "");
            if (interval) {
              window.localStorage.setItem(INTERVAL_STORAGE_KEY, interval);
            }
          });
        };

        if (widget.chartReady) {
          await widget.chartReady();
          handleChartReady();
        } else {
          widget.onChartReady?.(handleChartReady);
        }
      } catch (error) {
        if (cancelled) return;
        const message =
          error instanceof Error ? error.message : "TradingView Advanced Charts failed to load";
        setLoadError(message);
      }
    };

    void renderWidget();

    return () => {
      cancelled = true;
      shapeIdsRef.current = [];
      widgetRef.current?.remove?.();
      widgetRef.current = null;
    };
  }, [containerId, symbol]);

  useEffect(() => {
    let cancelled = false;
    const chart = widgetRef.current?.activeChart?.();

    const removeShapes = () => {
      shapeIdsRef.current.forEach((id) => chart?.removeEntity?.(id));
      shapeIdsRef.current = [];
    };

    const includePositionLevelsInScale = (currentGuides: PositionOverlayGuide[]) => {
      const priceScale = chart
        ?.getPanes?.()
        ?.[0]
        ?.getMainSourcePriceScale?.();
      const currentRange = priceScale?.getVisiblePriceRange?.();
      if (!priceScale || !currentRange || currentGuides.length === 0) return;

      const prices = [
        currentRange.from,
        currentRange.to,
        ...currentGuides.map((guide) => guide.price),
      ];
      const minimum = Math.min(...prices);
      const maximum = Math.max(...prices);
      const span = Math.max(maximum - minimum, maximum * 0.002);
      const padding = span * 0.08;
      priceScale.setAutoScale?.(false);
      priceScale.setVisiblePriceRange?.({
        from: minimum - padding,
        to: maximum + padding,
      });
    };

    const syncPositionShapes = async () => {
      removeShapes();
      const currentGuides = validOverlayGuides(guidesRef.current);
      if (!chart?.createShape || !chart.removeEntity || currentGuides.length === 0) {
        chart?.getPanes?.()?.[0]?.getMainSourcePriceScale?.()?.setAutoScale?.(true);
        return;
      }

      const colors = {
        entry: "#65d9ff",
        tp: "#4ce38a",
        sl: "#ff6f7f",
        liquidation: "#ffae57",
      } as const;
      const created: string[] = [];

      try {
        for (const guide of currentGuides) {
          const color = colors[guide.tone];
          const id = await chart.createShape(
            { price: guide.price },
            {
              shape: "horizontal_line",
              text: `${guide.label}  ${guide.price.toLocaleString(undefined, {
                maximumFractionDigits: 3,
              })}`,
              lock: true,
              disableSelection: true,
              disableSave: true,
              disableUndo: true,
              showInObjectsTree: false,
              zOrder: "top",
              overrides: {
                linecolor: color,
                linestyle: 2,
                linewidth: guide.tone === "entry" ? 2 : 1,
                showPrice: true,
                textcolor: color,
                fontsize: 12,
                horzLabelsAlign: "right",
                vertLabelsAlign: "middle",
              },
            }
          );
          if (cancelled) {
            chart.removeEntity(id);
          } else {
            created.push(id);
          }
        }
        if (!cancelled) {
          shapeIdsRef.current = created;
          includePositionLevelsInScale(currentGuides);
        }
      } catch {
        created.forEach((id) => chart.removeEntity?.(id));
      }
    };

    void syncPositionShapes();

    return () => {
      cancelled = true;
      removeShapes();
    };
  }, [chartReadyVersion, guideSignature]);

  useEffect(() => {
    const node = frameRef.current;
    if (!node) return;

    const handleWheel = (event: WheelEvent) => event.preventDefault();
    node.addEventListener("wheel", handleWheel, { passive: false });
    return () => node.removeEventListener("wheel", handleWheel);
  }, []);

  useEffect(() => {
    const node = frameRef.current;
    if (!node || !shouldLockPageScrollForChartHover()) return;

    const lockPageScroll = () => document.body.classList.add("chart-scroll-lock");
    const unlockPageScroll = () => document.body.classList.remove("chart-scroll-lock");
    node.addEventListener("pointerenter", lockPageScroll);
    node.addEventListener("pointerleave", unlockPageScroll);
    window.addEventListener("blur", unlockPageScroll);
    document.addEventListener("visibilitychange", unlockPageScroll);

    return () => {
      node.removeEventListener("pointerenter", lockPageScroll);
      node.removeEventListener("pointerleave", unlockPageScroll);
      window.removeEventListener("blur", unlockPageScroll);
      document.removeEventListener("visibilitychange", unlockPageScroll);
      unlockPageScroll();
    };
  }, []);

  return (
    <div ref={frameRef} className="tradingview-frame" data-chart-engine="advanced-charts">
      <div id={containerId} className="tradingview-container" />
      {loadError ? (
        <div className="tradingview-load-error" role="alert">
          {loadError}. Run <code>npm run stage:tradingview</code> before building.
        </div>
      ) : null}
    </div>
  );
}
