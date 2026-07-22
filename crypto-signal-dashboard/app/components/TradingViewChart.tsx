"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  buildPositionOverlayScale,
  positionOverlayGuides,
  type PositionedOverlayGuide,
  type PositionOverlayGuide,
  type PositionOverlayScale,
} from "@/lib/chart/positionOverlay";
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

type ChartSubscription<T> = {
  subscribe?: (context: unknown, callback: (value: T) => void) => void;
};

type WidgetPriceScale = {
  getVisiblePriceRange?: () => { from: number; to: number } | null;
  isInverted?: () => boolean;
};

type WidgetPane = {
  getHeight?: () => number;
  getMainSourcePriceScale?: () => WidgetPriceScale | null;
  hasMainSeries?: () => boolean;
};

type WidgetChart = {
  onIntervalChanged?: () => IntervalSubscription;
  onVisibleRangeChanged?: () => ChartSubscription<{ from: number; to: number }>;
  resolution?: () => string;
  createShape?: (
    point: { price: number },
    options: Record<string, unknown>
  ) => string | number | Promise<string | number>;
  getAllShapes?: () => Array<{ id: string | number }>;
  getPanes?: () => WidgetPane[];
  removeEntity?: (id: string | number) => void;
};

type WidgetApi = {
  onChartReady?: (callback: () => void) => void;
  activeChart?: () => WidgetChart;
  remove?: () => void;
};

type TradingViewChartProps = {
  symbol?: string;
  pricePoints?: PricePoint[];
  guides?: PositionOverlayGuide[];
};

const SCRIPT_ID = "tradingview-widget-script";
const INTERVAL_STORAGE_KEY = "brembot.tradingview.interval.v2";
const DEFAULT_INTERVAL = "15";
const DEFAULT_FAVORITE_INTERVALS = ["1", "5", "15", "60"];
export const OVERLAY_REFRESH_MS = 5_000;
let scriptLoadingPromise: Promise<void> | null = null;

type NativeGuideRecord = {
  entityId: string | number;
  signature: string;
};

function getGuideColor(tone: PositionOverlayGuide["tone"]) {
  if (tone === "tp") return "#4ce38a";
  if (tone === "sl") return "#ff7a7a";
  if (tone === "liquidation") return "#ff9f43";
  return "#65d9ff";
}

export function getNativeGuideDrawing(guide: PositionOverlayGuide) {
  const color = getGuideColor(guide.tone);
  return {
    point: { price: guide.price },
    options: {
      shape: "horizontal_line" as const,
      text: `${guide.label} ${guide.price.toFixed(2)}`,
      lock: true,
      disableSelection: true,
      disableSave: true,
      disableUndo: true,
      showInObjectsTree: false,
      zOrder: "top" as const,
      overrides: {
        linecolor: color,
        linestyle: 2,
        linewidth: 2,
        showLabel: true,
        showPrice: true,
        textcolor: color,
        bold: true,
        fontsize: 11,
      },
    },
  };
}

export function buildChartPriceScaleSnapshot({
  frameHeight,
  paneHeight,
  range,
  inverted = false,
  paneBounds,
}: {
  frameHeight: number;
  paneHeight?: number | null;
  range: { from: number; to: number } | null | undefined;
  inverted?: boolean;
  paneBounds?: Pick<PositionOverlayScale, "paneTop" | "paneBottom"> | null;
}): PositionOverlayScale | null {
  if (!Number.isFinite(frameHeight) || frameHeight <= 0 || !range) return null;
  if (!Number.isFinite(range.from) || !Number.isFinite(range.to) || range.from === range.to) return null;

  const fallbackPaneTop = Math.min(90, Math.max(54, frameHeight * 0.105));
  const resolvedPaneHeight = Number.isFinite(paneHeight) && Number(paneHeight) > 0
    ? Number(paneHeight)
    : frameHeight - fallbackPaneTop - Math.min(42, Math.max(26, frameHeight * 0.055));
  const paneTop = paneBounds?.paneTop ?? fallbackPaneTop;
  const paneBottom = paneBounds?.paneBottom
    ?? Math.min(frameHeight - 8, paneTop + Math.max(1, resolvedPaneHeight));

  if (paneBottom <= paneTop) return null;
  return {
    paneTop,
    paneBottom,
    minPrice: Math.min(range.from, range.to),
    maxPrice: Math.max(range.from, range.to),
    inverted,
  };
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

  const pane = iframeDocument.querySelector<HTMLElement>(".chart-markup-table.pane");
  const axis = iframeDocument.querySelector<HTMLElement>(".price-axis");
  if (!pane || !axis) return null;

  const paneRect = pane.getBoundingClientRect();
  const iframeRect = iframe.getBoundingClientRect();
  if (paneRect.height <= 0 || iframeRect.height <= 0) return null;

  const paneTop = paneRect.top - iframeRect.top;
  const paneBottom = paneRect.bottom - iframeRect.top;
  if (!Number.isFinite(paneTop) || !Number.isFinite(paneBottom) || paneBottom <= paneTop) return null;

  const labelNodes = Array.from(axis.querySelectorAll<HTMLElement>("div, span"))
    .filter((node) => node.childElementCount === 0)
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
  } satisfies PositionOverlayScale;
}

function readChartPriceScaleSnapshot(
  chart: WidgetChart | undefined,
  frameHeight: number,
  paneBounds: PositionOverlayScale | null
) {
  if (!chart?.getPanes) return null;

  try {
    const panes = chart.getPanes();
    const pane = panes.find((candidate) => candidate.hasMainSeries?.()) ?? panes[0];
    const priceScale = pane?.getMainSourcePriceScale?.();
    const range = priceScale?.getVisiblePriceRange?.();
    return buildChartPriceScaleSnapshot({
      frameHeight,
      paneHeight: pane?.getHeight?.(),
      range,
      inverted: priceScale?.isInverted?.() ?? false,
      paneBounds,
    });
  } catch {
    return null;
  }
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
  const nativeGuideRecordsRef = useRef(new Map<string, NativeGuideRecord>());
  const nativeGuideSyncingRef = useRef(false);
  const syncNativeGuidesRef = useRef<() => Promise<void>>(async () => undefined);
  const refreshOverlayRef = useRef<() => void>(() => undefined);
  const [currentInterval, setCurrentInterval] = useState(DEFAULT_INTERVAL);
  const [computedGuides, setComputedGuides] = useState<PositionedOverlayGuide[]>([]);
  const [nativeOverlayActive, setNativeOverlayActive] = useState(false);
  const [isVisible, setIsVisible] = useState(true);

  const clearNativeGuides = useCallback((chart = widgetRef.current?.activeChart?.()) => {
    if (chart?.removeEntity) {
      nativeGuideRecordsRef.current.forEach(({ entityId }) => {
        try {
          chart.removeEntity?.(entityId);
        } catch {
          // TradingView may already have discarded the drawing during a reload.
        }
      });
    }
    nativeGuideRecordsRef.current.clear();
    setNativeOverlayActive(false);
  }, []);

  const syncNativeGuides = useCallback(async () => {
    if (nativeGuideSyncingRef.current) return;
    const chart = widgetRef.current?.activeChart?.();
    const validGuides = guides.filter((guide) => Number.isFinite(guide.price) && guide.price > 0);

    if (!chart?.createShape || !chart.removeEntity) {
      setNativeOverlayActive(false);
      return;
    }

    nativeGuideSyncingRef.current = true;
    try {
      const desiredIds = new Set(validGuides.map((guide) => guide.id));
      const visibleShapeIds = chart.getAllShapes
        ? new Set(chart.getAllShapes().map((shape) => String(shape.id)))
        : null;

      nativeGuideRecordsRef.current.forEach((record, guideId) => {
        const shapeIsMissing = visibleShapeIds && !visibleShapeIds.has(String(record.entityId));
        if (!desiredIds.has(guideId) || shapeIsMissing) {
          try {
            chart.removeEntity?.(record.entityId);
          } catch {
            // The drawing is already gone.
          }
          nativeGuideRecordsRef.current.delete(guideId);
        }
      });

      for (const guide of validGuides) {
        const signature = `${guide.price}:${guide.label}:${guide.tone}`;
        const existing = nativeGuideRecordsRef.current.get(guide.id);
        if (existing?.signature === signature) continue;

        if (existing) {
          try {
            chart.removeEntity(existing.entityId);
          } catch {
            // The drawing is already gone.
          }
          nativeGuideRecordsRef.current.delete(guide.id);
        }

        const drawing = getNativeGuideDrawing(guide);
        const entityId = await Promise.resolve(chart.createShape(drawing.point, drawing.options));
        nativeGuideRecordsRef.current.set(guide.id, { entityId, signature });
      }

      setNativeOverlayActive(
        validGuides.length > 0
        && validGuides.every((guide) => nativeGuideRecordsRef.current.has(guide.id))
      );
    } catch {
      clearNativeGuides(chart);
    } finally {
      nativeGuideSyncingRef.current = false;
    }
  }, [clearNativeGuides, guides]);
  syncNativeGuidesRef.current = syncNativeGuides;

  const refreshOverlay = useCallback(() => {
    const frameNode = frameRef.current;
    const frameHeight = frameNode?.clientHeight ?? 0;
    const domScale = readOverlayScaleSnapshot(frameNode);
    const chartScale = readChartPriceScaleSnapshot(
      widgetRef.current?.activeChart?.(),
      frameHeight,
      domScale
    );
    const fallbackScale = buildPositionOverlayScale({
      frameHeight,
      pricePoints,
      guides,
      interval: currentInterval,
    });
    const resolvedScale = chartScale ?? domScale ?? fallbackScale;

    if (!resolvedScale || frameHeight <= 0) {
      // Do not blink existing labels away during iframe reloads, orientation changes,
      // or short gaps in the price feed.
      if ((guides?.length ?? 0) === 0) {
        setComputedGuides([]);
      }
      return;
    }

    const nextGuides = positionOverlayGuides(guides, resolvedScale, frameHeight);
    setComputedGuides(nextGuides);
  }, [currentInterval, guides, pricePoints]);
  refreshOverlayRef.current = refreshOverlay;

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
      clearNativeGuides();
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
          favorites: {
            intervals: DEFAULT_FAVORITE_INTERVALS,
          },
          timezone: "America/New_York",
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
              refreshOverlayRef.current();
              void syncNativeGuidesRef.current();
            }
          });

          chart?.onVisibleRangeChanged?.().subscribe?.(null, () => {
            refreshOverlayRef.current();
            void syncNativeGuidesRef.current();
          });

          refreshOverlayRef.current();
          void syncNativeGuidesRef.current();
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
      clearNativeGuides();
      widgetRef.current?.remove?.();
      widgetRef.current = null;
    };
  }, [clearNativeGuides, containerId, symbol]);

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
    window.addEventListener("focus", handleViewportChange);
    document.addEventListener("visibilitychange", handleViewportChange);

    const node = frameRef.current;
    let resizeObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined" && node) {
      resizeObserver = new ResizeObserver(handleViewportChange);
      resizeObserver.observe(node);
    }

    return () => {
      window.removeEventListener("resize", handleViewportChange);
      window.removeEventListener("orientationchange", handleViewportChange);
      window.removeEventListener("focus", handleViewportChange);
      document.removeEventListener("visibilitychange", handleViewportChange);
      resizeObserver?.disconnect();
    };
  }, [refreshOverlay]);

  useEffect(() => {
    if (!isVisible) return;

    refreshOverlay();
    void syncNativeGuides();
    const intervalId = window.setInterval(() => {
      if (document.visibilityState === "hidden") return;
      refreshOverlay();
      void syncNativeGuides();
    }, OVERLAY_REFRESH_MS);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [isVisible, refreshOverlay, syncNativeGuides]);

  return (
    <div ref={frameRef} className="tradingview-frame">
      <div id={containerId} className="tradingview-container" />
      {!nativeOverlayActive && computedGuides.length > 0 ? (
        <div className="tradingview-overlay-layer" aria-hidden="true">
          {computedGuides.map((guide) => (
            <div
              key={guide.id}
              className={`tradingview-overlay-line tradingview-overlay-line-${guide.tone}${guide.edge ? ` tradingview-overlay-line-${guide.edge}` : ""}`}
              style={{ top: `${guide.top}%` }}
            >
              <span className="tradingview-overlay-label">
                {guide.edge === "above" ? "↑ " : guide.edge === "below" ? "↓ " : ""}
                {guide.label} {guide.price.toFixed(2)}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
