"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { PricePoint } from "@/lib/price/simulated";

declare global {
  interface Window {
    TradingView?: {
      widget: new (config: Record<string, unknown>) => unknown;
    };
  }
}

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
  remove?: () => void;
};

type TradingViewChartProps = {
  symbol?: string;
  pricePoints?: PricePoint[];
  guides?: Array<{
    id: string;
    label: string;
    price: number;
    tone: "entry" | "tp" | "sl";
  }>;
};

const SCRIPT_ID = "tradingview-widget-script";
const INTERVAL_STORAGE_KEY = "brembot.tradingview.interval.v1";
const DEFAULT_INTERVAL = "5";
const OVERLAY_REFRESH_MS = 1_000;
let scriptLoadingPromise: Promise<void> | null = null;

type ComputedGuide = {
  id: string;
  label: string;
  price: number;
  tone: "entry" | "tp" | "sl";
  top: number;
};

type OverlayScaleSnapshot = {
  paneTop: number;
  paneBottom: number;
  minPrice: number;
  maxPrice: number;
};

function getIntervalWindowMs(interval: string) {
  const normalized = interval.trim().toUpperCase();
  if (normalized === "1") return 60 * 60 * 1000;
  if (normalized === "3") return 3 * 60 * 60 * 1000;
  if (normalized === "5") return 6 * 60 * 60 * 1000;
  if (normalized === "15") return 18 * 60 * 60 * 1000;
  if (normalized === "30") return 24 * 60 * 60 * 1000;
  if (normalized === "60" || normalized === "1H") return 3 * 24 * 60 * 60 * 1000;
  if (normalized === "120" || normalized === "2H") return 5 * 24 * 60 * 60 * 1000;
  if (normalized === "240" || normalized === "4H") return 10 * 24 * 60 * 60 * 1000;
  if (normalized === "1D" || normalized === "D") return 45 * 24 * 60 * 60 * 1000;
  return 6 * 60 * 60 * 1000;
}

function computeGuidePositions(
  pricePoints: PricePoint[],
  guides: TradingViewChartProps["guides"],
  interval: string
): ComputedGuide[] {
  const validGuides = (guides ?? []).filter(
    (guide): guide is NonNullable<TradingViewChartProps["guides"]>[number] =>
      Boolean(guide) && Number.isFinite(guide.price) && guide.price > 0
  );
  if (validGuides.length === 0) return [];

  const validPoints = pricePoints.filter(
    (point): point is PricePoint => Number.isFinite(point.t) && Number.isFinite(point.v) && point.v > 0
  );
  if (validPoints.length === 0) {
    const guidePrices = validGuides.map((guide) => guide.price);
    const minGuidePrice = Math.min(...guidePrices);
    const maxGuidePrice = Math.max(...guidePrices);
    const midpoint = (minGuidePrice + maxGuidePrice) / 2;
    const span = Math.max(maxGuidePrice - minGuidePrice, midpoint * 0.02, 1e-6);
    const paddedMin = minGuidePrice - span * 0.2;
    const paddedMax = maxGuidePrice + span * 0.2;
    const paddedSpan = Math.max(paddedMax - paddedMin, 1e-6);

    return validGuides.map((guide) => {
      const relative = (guide.price - paddedMin) / paddedSpan;
      const top = 100 - Math.min(100, Math.max(0, relative * 100));
      return {
        ...guide,
        top,
      };
    });
  }

  const latestTimestamp = validPoints[validPoints.length - 1]?.t ?? Date.now();
  const intervalWindowMs = getIntervalWindowMs(interval);
  const visiblePoints = validPoints.filter((point) => point.t >= latestTimestamp - intervalWindowMs);
  const effectivePoints = visiblePoints.length >= 8 ? visiblePoints : validPoints.slice(-240);
  const values = effectivePoints.map((point) => point.v);
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
}

function parseVisiblePrice(text: string) {
  const normalized = text.replace(/[,\s\u202f]/g, "");
  const match = normalized.match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;

  const value = Number(match[0]);
  return Number.isFinite(value) ? value : null;
}

function readOverlayScaleSnapshot(frameNode: HTMLDivElement | null) {
  if (!frameNode) return null;

  const iframe = frameNode.querySelector("iframe");
  if (!iframe) return null;

  let iframeDocument: Document | null = null;
  try {
    iframeDocument = iframe.contentDocument ?? iframe.contentWindow?.document ?? null;
  } catch {
    return null;
  }
  if (!iframeDocument) return null;

  const pane = iframeDocument.querySelector(".chart-markup-table.pane");
  const axis = iframeDocument.querySelector(".price-axis");
  if (!(pane instanceof HTMLElement) || !(axis instanceof HTMLElement)) return null;

  const paneRect = pane.getBoundingClientRect();
  const iframeRect = iframe.getBoundingClientRect();
  if (paneRect.height <= 0 || iframeRect.height <= 0) return null;

  const paneTop = paneRect.top - iframeRect.top;
  const paneBottom = paneRect.bottom - iframeRect.top;
  if (!Number.isFinite(paneTop) || !Number.isFinite(paneBottom) || paneBottom <= paneTop) return null;

  const labelNodes = Array.from(axis.querySelectorAll<HTMLElement>("div, span"))
    .map((node) => {
      const rect = node.getBoundingClientRect();
      const price = parseVisiblePrice(node.textContent ?? "");
      return {
        price,
        top: rect.top - iframeRect.top,
        height: rect.height,
      };
    })
    .filter(
      (item): item is { price: number; top: number; height: number } =>
        item.price !== null
        && Number.isFinite(item.top)
        && Number.isFinite(item.height)
        && item.height > 0
        && item.top + item.height >= paneTop
        && item.top <= paneBottom
    )
    .sort((left, right) => left.top - right.top);

  if (labelNodes.length < 2) return null;

  const topNode = labelNodes[0];
  const bottomNode = labelNodes[labelNodes.length - 1];
  if (topNode.price === bottomNode.price) return null;

  return {
    paneTop,
    paneBottom,
    maxPrice: Math.max(topNode.price, bottomNode.price),
    minPrice: Math.min(topNode.price, bottomNode.price),
  } satisfies OverlayScaleSnapshot;
}

function buildFallbackScaleSnapshot(
  frameNode: HTMLDivElement | null,
  pricePoints: PricePoint[],
  guides: TradingViewChartProps["guides"],
  interval: string
) {
  const frameHeight = frameNode?.clientHeight ?? 0;
  const paneTop = Math.min(90, Math.max(54, frameHeight * 0.105));
  const paneBottom = Math.max(paneTop + 120, frameHeight - Math.min(42, Math.max(26, frameHeight * 0.055)));

  const validGuides = (guides ?? []).filter(
    (guide): guide is NonNullable<TradingViewChartProps["guides"]>[number] =>
      Boolean(guide) && Number.isFinite(guide.price) && guide.price > 0
  );
  const validPoints = pricePoints.filter(
    (point): point is PricePoint => Number.isFinite(point.t) && Number.isFinite(point.v) && point.v > 0
  );

  const guidePrices = validGuides.map((guide) => guide.price);
  const latestTimestamp = validPoints[validPoints.length - 1]?.t ?? Date.now();
  const intervalWindowMs = getIntervalWindowMs(interval);
  const visiblePoints = validPoints.filter((point) => point.t >= latestTimestamp - intervalWindowMs);
  const effectivePoints = visiblePoints.length >= 8 ? visiblePoints : validPoints.slice(-240);
  const pointValues = effectivePoints.map((point) => point.v);
  const scaleValues = [...pointValues, ...guidePrices].filter((value) => Number.isFinite(value) && value > 0);

  if (scaleValues.length === 0) {
    return null;
  }

  const minPrice = Math.min(...scaleValues);
  const maxPrice = Math.max(...scaleValues);
  const midpoint = (minPrice + maxPrice) / 2;
  const span = Math.max(maxPrice - minPrice, midpoint * 0.02, 1e-6);

  return {
    paneTop,
    paneBottom,
    minPrice: minPrice - span * 0.15,
    maxPrice: maxPrice + span * 0.15,
  } satisfies OverlayScaleSnapshot;
}

function computeGuidePositionsFromScale(
  guides: TradingViewChartProps["guides"],
  scale: OverlayScaleSnapshot,
  frameHeight: number
) {
  if (!Number.isFinite(frameHeight) || frameHeight <= 0) return [];

  const validGuides = (guides ?? []).filter(
    (guide): guide is NonNullable<TradingViewChartProps["guides"]>[number] =>
      Boolean(guide) && Number.isFinite(guide.price) && guide.price > 0
  );
  if (validGuides.length === 0) return [];

  const clampedPaneHeight = Math.max(scale.paneBottom - scale.paneTop, 1);
  const scaleSpan = Math.max(scale.maxPrice - scale.minPrice, 1e-6);

  return validGuides.map((guide) => {
    const relative = (guide.price - scale.minPrice) / scaleSpan;
    const paneOffset = 1 - Math.min(1, Math.max(0, relative));
    const y = scale.paneTop + paneOffset * clampedPaneHeight;
    return {
      ...guide,
      top: (y / frameHeight) * 100,
    };
  });
}

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
  pricePoints = [],
  guides = [],
}: TradingViewChartProps) {
  const containerId = useMemo(() => "tradingview_main_chart", []);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const widgetRef = useRef<WidgetApi | null>(null);
  const [currentInterval, setCurrentInterval] = useState(DEFAULT_INTERVAL);
  const [computedGuides, setComputedGuides] = useState<ComputedGuide[]>([]);
  const [isVisible, setIsVisible] = useState(true);

  const refreshOverlay = useCallback(() => {
    const frameNode = frameRef.current;
    const frameHeight = frameNode?.clientHeight ?? 0;
    const liveScale = readOverlayScaleSnapshot(frameNode);
    const fallbackScale = buildFallbackScaleSnapshot(frameNode, pricePoints, guides, currentInterval);
    const resolvedScale = liveScale ?? fallbackScale;

    if (!resolvedScale || frameHeight <= 0) {
      setComputedGuides(computeGuidePositions(pricePoints, guides, currentInterval));
      return;
    }

    setComputedGuides(computeGuidePositionsFromScale(guides, resolvedScale, frameHeight));
  }, [currentInterval, guides, pricePoints]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    setCurrentInterval(window.localStorage.getItem(INTERVAL_STORAGE_KEY) ?? DEFAULT_INTERVAL);
  }, []);

  useEffect(() => {
    let cancelled = false;

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
        setCurrentInterval(storedInterval);

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
            setCurrentInterval(currentResolution);
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
              setCurrentInterval(interval);
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

    void renderWidget();

    return () => {
      cancelled = true;
      widgetRef.current?.remove?.();
      widgetRef.current = null;
    };
  }, [containerId, symbol]);

  useEffect(() => {
    const node = frameRef.current;
    if (!node || typeof IntersectionObserver === "undefined") return;

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        setIsVisible(entry?.isIntersecting ?? true);
      },
      { threshold: 0.15 }
    );

    observer.observe(node);

    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const node = frameRef.current;
    if (!node) return;

    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
    };

    node.addEventListener("wheel", handleWheel, { passive: false });

    return () => {
      node.removeEventListener("wheel", handleWheel);
    };
  }, []);

  useEffect(() => {
    const node = frameRef.current;
    if (!node || !shouldLockPageScrollForChartHover()) return;

    const lockPageScroll = () => {
      document.body.classList.add("chart-scroll-lock");
    };

    const unlockPageScroll = () => {
      document.body.classList.remove("chart-scroll-lock");
    };

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

  useEffect(() => {
    refreshOverlay();

    const handleViewportChange = () => {
      refreshOverlay();
      window.setTimeout(refreshOverlay, 180);
    };

    window.addEventListener("resize", handleViewportChange);
    window.addEventListener("orientationchange", handleViewportChange);

    return () => {
      window.removeEventListener("resize", handleViewportChange);
      window.removeEventListener("orientationchange", handleViewportChange);
    };
  }, [refreshOverlay]);

  useEffect(() => {
    if (!isVisible) return;

    refreshOverlay();
    const intervalId = window.setInterval(() => {
      if (document.visibilityState === "hidden") return;
      refreshOverlay();
    }, OVERLAY_REFRESH_MS);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [isVisible, refreshOverlay]);

  return (
    <div ref={frameRef} className="tradingview-frame">
      <div id={containerId} className="tradingview-container" />
      {computedGuides.length > 0 ? (
        <div className="tradingview-overlay-layer" aria-hidden="true">
          {computedGuides.map((guide) => (
            <div
              key={guide.id}
              className={`tradingview-overlay-line tradingview-overlay-line-${guide.tone}`}
              style={{ top: `${guide.top}%` }}
            >
              <span className="tradingview-overlay-label">
                {guide.label} {guide.price.toFixed(2)}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
