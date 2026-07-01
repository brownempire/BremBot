"use client";

import { useEffect, useMemo } from "react";

declare global {
  interface Window {
    TradingView?: {
      widget: new (config: Record<string, unknown>) => unknown;
    };
  }
}

type TradingViewChartProps = {
  symbol?: string;
  pricePoints?: Array<{ t: number; v: number }>;
  guides?: Array<{
    label: string;
    price: number;
    tone: "entry" | "tp";
  }>;
};

const SCRIPT_ID = "tradingview-widget-script";
const INTERVAL_STORAGE_KEY = "brembot.tradingview.interval.v1";
const DEFAULT_INTERVAL = "5";
let scriptLoadingPromise: Promise<void> | null = null;

function loadTradingViewScript() {
  if (window.TradingView?.widget) return Promise.resolve();
  if (scriptLoadingPromise) return scriptLoadingPromise;

  scriptLoadingPromise = new Promise<void>((resolve, reject) => {
    const existingScript = document.getElementById(SCRIPT_ID) as HTMLScriptElement | null;
    if (existingScript) {
      existingScript.addEventListener("load", () => resolve(), { once: true });
      existingScript.addEventListener("error", () => reject(new Error("TradingView script failed")), {
        once: true,
      });
      return;
    }

    const script = document.createElement("script");
    script.id = SCRIPT_ID;
    script.src = "https://s3.tradingview.com/tv.js";
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("TradingView script failed"));
    document.head.appendChild(script);
  });

  return scriptLoadingPromise;
}

export function TradingViewChart({
  symbol = "COINBASE:BTCUSD",
  pricePoints = [],
  guides = [],
}: TradingViewChartProps) {
  const containerId = useMemo(() => "tradingview_main_chart", []);
  const guidePositions = useMemo(() => {
    const validGuides = guides.filter((guide) => Number.isFinite(guide.price) && guide.price > 0);
    if (validGuides.length === 0) return [];

    const recentPoints = pricePoints.slice(-240);
    const values = recentPoints.map((point) => point.v).filter((value) => Number.isFinite(value) && value > 0);
    if (values.length === 0) return [];

    const minPrice = Math.min(...values);
    const maxPrice = Math.max(...values);
    const span = Math.max(maxPrice - minPrice, minPrice * 0.02, 1e-6);
    const paddedMin = minPrice - span * 0.15;
    const paddedMax = maxPrice + span * 0.15;
    const paddedSpan = Math.max(paddedMax - paddedMin, 1e-6);

    return validGuides.map((guide) => {
      const relative = (guide.price - paddedMin) / paddedSpan;
      const top = 100 - Math.min(100, Math.max(0, relative * 100));
      return {
        ...guide,
        top,
      };
    });
  }, [guides, pricePoints]);

  useEffect(() => {
    let cancelled = false;

    const renderWidget = async () => {
      const container = document.getElementById(containerId);
      if (!container) return;

      container.innerHTML = "";

      try {
        await loadTradingViewScript();
        if (cancelled || !window.TradingView?.widget) return;
        const storedInterval =
          typeof window !== "undefined"
            ? window.localStorage.getItem(INTERVAL_STORAGE_KEY) ?? DEFAULT_INTERVAL
            : DEFAULT_INTERVAL;

        const widget = new window.TradingView.widget({
          autosize: true,
          symbol,
          interval: storedInterval,
          timezone: "exchange",
          theme: "dark",
          style: "1",
          locale: "en_US",
          enable_publishing: false,
          allow_symbol_change: true,
          hide_side_toolbar: false,
          withdateranges: true,
          load_last_chart: true,
          enabled_features: [
            "use_localstorage_for_settings",
            "save_chart_properties_to_local_storage",
          ],
          time_hours_format: "12-hours",
          container_id: containerId,
        });

        type IntervalSubscription = {
          subscribe?: (context: unknown, callback: (interval: unknown) => void) => void;
        };
        type WidgetChart = {
          onIntervalChanged?: () => IntervalSubscription;
          resolution?: () => string;
        };
        type WidgetApi = {
          onChartReady?: (callback: () => void) => void;
          activeChart?: () => WidgetChart;
        };

        (widget as WidgetApi).onChartReady?.(() => {
          const chart = (widget as WidgetApi).activeChart?.();
          const currentResolution = chart?.resolution?.();
          if (typeof currentResolution === "string" && currentResolution.length > 0) {
            window.localStorage.setItem(INTERVAL_STORAGE_KEY, currentResolution);
          }

          chart?.onIntervalChanged?.().subscribe?.(null, (nextInterval) => {
            const interval =
              typeof nextInterval === "string"
                ? nextInterval
                : typeof nextInterval === "object" && nextInterval
                  ? String(nextInterval)
                  : "";
            if (interval) {
              window.localStorage.setItem(INTERVAL_STORAGE_KEY, interval);
            }
          });
        });
      } catch {
        if (!cancelled) {
          container.innerHTML =
            "<div style='padding:12px;color:#9aa7c7;font-size:13px'>Chart failed to load. Refresh page.</div>";
        }
      }
    };

    renderWidget().catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [containerId, symbol]);

  return (
    <div className="tradingview-frame">
      <div id={containerId} className="tradingview-container" />
      {guidePositions.length > 0 ? (
        <div className="tradingview-guide-layer" aria-hidden="true">
          {guidePositions.map((guide) => (
            <div
              key={`${guide.label}-${guide.price}-${guide.tone}`}
              className={`tradingview-guide tradingview-guide-${guide.tone}`}
              style={{ top: `${guide.top}%` }}
            >
              <span className="tradingview-guide-label">
                {guide.label} {guide.price.toFixed(2)}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
