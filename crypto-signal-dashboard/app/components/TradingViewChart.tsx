"use client";

import { useEffect, useMemo, useRef } from "react";

declare global {
  interface Window {
    TradingView?: {
      widget: new (config: Record<string, unknown>) => unknown;
    };
  }
}

type TradingViewGuide = {
  label: string;
  price: number;
  tone: "entry" | "tp";
};

type TradingViewChartProps = {
  symbol?: string;
  guides?: TradingViewGuide[];
};

type IntervalSubscription = {
  subscribe?: (context: unknown, callback: (interval: unknown) => void) => void;
};

type VisibleRange = {
  from: number;
  to: number;
};

type VisibleRangeSubscription = {
  subscribe?: (context: unknown, callback: (range: VisibleRange | null) => void) => void;
};

type WidgetChart = {
  onIntervalChanged?: () => IntervalSubscription;
  onVisibleRangeChanged?: () => VisibleRangeSubscription;
  resolution?: () => string;
  getVisibleRange?: () => VisibleRange | null;
  createMultipointShape?: (
    points: Array<{ time: number; price: number }>,
    options: Record<string, unknown>
  ) => Promise<string | number>;
  removeEntity?: (entityId: string | number) => void;
};

type WidgetApi = {
  onChartReady?: (callback: () => void) => void;
  activeChart?: () => WidgetChart;
  remove?: () => void;
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

function getGuideColor(tone: TradingViewGuide["tone"]) {
  return tone === "tp" ? "#4ce38a" : "#3ba7ff";
}

export function TradingViewChart({
  symbol = "COINBASE:BTCUSD",
  guides = [],
}: TradingViewChartProps) {
  const containerId = useMemo(() => "tradingview_main_chart", []);
  const widgetRef = useRef<WidgetApi | null>(null);
  const guideEntityIdsRef = useRef<Array<string | number>>([]);
  const latestGuidesRef = useRef<TradingViewGuide[]>(guides);

  latestGuidesRef.current = guides;

  useEffect(() => {
    let cancelled = false;

    const clearGuideEntities = () => {
      const chart = widgetRef.current?.activeChart?.();
      if (!chart?.removeEntity) {
        guideEntityIdsRef.current = [];
        return;
      }

      for (const entityId of guideEntityIdsRef.current) {
        try {
          chart.removeEntity(entityId);
        } catch {
          // Ignore stale entity IDs during redraws.
        }
      }
      guideEntityIdsRef.current = [];
    };

    const drawGuides = async () => {
      const chart = widgetRef.current?.activeChart?.();
      if (!chart?.createMultipointShape || !chart?.getVisibleRange) return;

      clearGuideEntities();

      const visibleRange = chart.getVisibleRange();
      if (!visibleRange) return;

      const validGuides = latestGuidesRef.current.filter((guide) => Number.isFinite(guide.price) && guide.price > 0);
      for (const guide of validGuides) {
        try {
          const entityId = await chart.createMultipointShape(
            [
              { time: visibleRange.from, price: guide.price },
              { time: visibleRange.to, price: guide.price },
            ],
            {
              shape: "trend_line",
              lock: true,
              disableSelection: true,
              disableSave: true,
              disableUndo: true,
              overrides: {
                linecolor: getGuideColor(guide.tone),
                linewidth: 2,
                linestyle: 2,
                showLabel: true,
                textcolor: getGuideColor(guide.tone),
              },
              text: `${guide.label} ${guide.price.toFixed(2)}`,
            }
          );
          guideEntityIdsRef.current.push(entityId);
        } catch {
          // Keep the chart usable even if a drawing API call fails.
        }
      }
    };

    const renderWidget = async () => {
      const container = document.getElementById(containerId);
      if (!container) return;

      container.innerHTML = "";
      clearGuideEntities();
      widgetRef.current?.remove?.();
      widgetRef.current = null;

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
        }) as WidgetApi;

        widgetRef.current = widget;

        widget.onChartReady?.(() => {
          const chart = widget.activeChart?.();
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
            void drawGuides();
          });

          chart?.onVisibleRangeChanged?.().subscribe?.(null, () => {
            void drawGuides();
          });

          void drawGuides();
        });
      } catch {
        if (!cancelled) {
          container.innerHTML =
            "<div style='padding:12px;color:#9aa7c7;font-size:13px'>Chart failed to load. Refresh page.</div>";
        }
      }
    };

    void renderWidget();

    return () => {
      cancelled = true;
      clearGuideEntities();
      widgetRef.current?.remove?.();
      widgetRef.current = null;
    };
  }, [containerId, symbol]);

  useEffect(() => {
    const rerenderGuides = async () => {
      const chart = widgetRef.current?.activeChart?.();
      if (!chart?.getVisibleRange || !chart?.createMultipointShape) return;

      const visibleRange = chart.getVisibleRange();
      if (!visibleRange) return;

      for (const entityId of guideEntityIdsRef.current) {
        try {
          chart.removeEntity?.(entityId);
        } catch {
          // Ignore stale entity IDs during redraws.
        }
      }
      guideEntityIdsRef.current = [];

      const validGuides = guides.filter((guide) => Number.isFinite(guide.price) && guide.price > 0);
      for (const guide of validGuides) {
        try {
          const entityId = await chart.createMultipointShape(
            [
              { time: visibleRange.from, price: guide.price },
              { time: visibleRange.to, price: guide.price },
            ],
            {
              shape: "trend_line",
              lock: true,
              disableSelection: true,
              disableSave: true,
              disableUndo: true,
              overrides: {
                linecolor: getGuideColor(guide.tone),
                linewidth: 2,
                linestyle: 2,
                showLabel: true,
                textcolor: getGuideColor(guide.tone),
              },
              text: `${guide.label} ${guide.price.toFixed(2)}`,
            }
          );
          guideEntityIdsRef.current.push(entityId);
        } catch {
          // Ignore drawing failures and leave the chart usable.
        }
      }
    };

    void rerenderGuides();
  }, [guides]);

  return (
    <div className="tradingview-frame">
      <div id={containerId} className="tradingview-container" />
    </div>
  );
}
