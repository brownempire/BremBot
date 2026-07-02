"use client";

import { useEffect, useMemo, useRef, useState } from "react";

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
  pricePoints?: Array<{ t: number; v: number }>;
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

type CrosshairSubscription = {
  subscribe?: (context: unknown, callback: (params: { price?: number | null }) => void) => void;
};

type WidgetChart = {
  onIntervalChanged?: () => IntervalSubscription;
  onVisibleRangeChanged?: () => VisibleRangeSubscription;
  crossHairMoved?: () => CrosshairSubscription;
  resolution?: () => string;
  getVisibleRange?: () => VisibleRange | null;
  createMultipointShape?: (
    points: Array<{ time: number; price: number }>,
    options: Record<string, unknown>
  ) => Promise<string | number>;
  removeEntity?: (entityId: string | number) => void;
  exportData?: (options?: Record<string, unknown>) => Promise<{
    data?: Array<{ value?: number; close?: number; high?: number; low?: number }>;
  }>;
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
  pricePoints = [],
}: TradingViewChartProps) {
  const containerId = useMemo(() => "tradingview_main_chart", []);
  const widgetRef = useRef<WidgetApi | null>(null);
  const [guidePositions, setGuidePositions] = useState<Array<TradingViewGuide & { top: number }>>([]);
  const latestGuidesRef = useRef<TradingViewGuide[]>(guides);

  latestGuidesRef.current = guides;

  function buildGuidePositions(
    guideSet: TradingViewGuide[],
    values: number[]
  ): Array<TradingViewGuide & { top: number }> {
    if (guideSet.length === 0 || values.length === 0) return [];

    const minPrice = Math.min(...values);
    const maxPrice = Math.max(...values);
    const span = Math.max(maxPrice - minPrice, minPrice * 0.02, 1e-6);
    const paddedMin = minPrice - span * 0.15;
    const paddedMax = maxPrice + span * 0.15;
    const paddedSpan = Math.max(paddedMax - paddedMin, 1e-6);

    return guideSet.map((guide) => {
      const relative = (guide.price - paddedMin) / paddedSpan;
      const top = 100 - Math.min(100, Math.max(0, relative * 100));
      return {
        ...guide,
        top,
      };
    });
  }

  useEffect(() => {
    let cancelled = false;

    const recomputeGuidePositions = async () => {
      const chart = widgetRef.current?.activeChart?.();
      if (!chart?.exportData) {
        setGuidePositions([]);
        return;
      }

      const validGuides = latestGuidesRef.current.filter((guide) => Number.isFinite(guide.price) && guide.price > 0);
      if (validGuides.length === 0) {
        setGuidePositions([]);
        return;
      }

      const fallbackValues = pricePoints
        .map((point) => point.v)
        .filter((value): value is number => Number.isFinite(value) && value > 0);

      try {
        const exported = await chart.exportData({
          includedStudies: [],
          includeDisplayedValues: true,
        });
        if (cancelled) return;

        const values = (exported.data ?? [])
          .flatMap((point) => [point.value, point.close, point.high, point.low])
          .filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0);

        const effectiveValues = values.length > 0 ? values : fallbackValues;

        if (effectiveValues.length === 0) {
          setGuidePositions([]);
          return;
        }

        setGuidePositions(buildGuidePositions(validGuides, effectiveValues));
      } catch {
        if (!cancelled) {
          setGuidePositions(buildGuidePositions(validGuides, fallbackValues));
        }
      }
    };

    const renderWidget = async () => {
      const container = document.getElementById(containerId);
      if (!container) return;

      container.innerHTML = "";
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
            void recomputeGuidePositions();
          });

          chart?.onVisibleRangeChanged?.().subscribe?.(null, () => {
            void recomputeGuidePositions();
          });

          void recomputeGuidePositions();
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
      widgetRef.current?.remove?.();
      widgetRef.current = null;
    };
  }, [containerId, pricePoints, symbol]);

  useEffect(() => {
    let cancelled = false;

    const recomputeGuidePositions = async () => {
      const chart = widgetRef.current?.activeChart?.();
      if (!chart?.exportData) {
        setGuidePositions([]);
        return;
      }

      const validGuides = latestGuidesRef.current.filter((guide) => Number.isFinite(guide.price) && guide.price > 0);
      if (validGuides.length === 0) {
        setGuidePositions([]);
        return;
      }

      const fallbackValues = pricePoints
        .map((point) => point.v)
        .filter((value): value is number => Number.isFinite(value) && value > 0);

      try {
        const exported = await chart.exportData({
          includedStudies: [],
          includeDisplayedValues: true,
        });
        if (cancelled) return;

        const values = (exported.data ?? [])
          .flatMap((point) => [point.value, point.close, point.high, point.low])
          .filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0);

        const effectiveValues = values.length > 0 ? values : fallbackValues;

        if (effectiveValues.length === 0) {
          setGuidePositions([]);
          return;
        }

        setGuidePositions(buildGuidePositions(validGuides, effectiveValues));
      } catch {
        if (!cancelled) {
          setGuidePositions(buildGuidePositions(validGuides, fallbackValues));
        }
      }
    };

    void recomputeGuidePositions();

    return () => {
      cancelled = true;
    };
  }, [guides, pricePoints]);

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
              <span
                className="tradingview-guide-label"
                style={{
                  color: getGuideColor(guide.tone),
                  borderColor: `${getGuideColor(guide.tone)}66`,
                }}
              >
                {guide.label} {guide.price.toFixed(2)}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
