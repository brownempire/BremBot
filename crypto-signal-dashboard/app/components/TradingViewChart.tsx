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

type WidgetChart = {
  onIntervalChanged?: () => IntervalSubscription;
  resolution?: () => string;
  createShape?: (
    point: { price: number },
    options: Record<string, unknown>
  ) => string | Promise<string>;
  removeEntity?: (id: string) => void;
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
const OVERLAY_REFRESH_MS = 1_500;
let scriptLoadingPromise: Promise<void> | null = null;

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
  } satisfies PositionOverlayScale;
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
  const nativeShapeIdsRef = useRef<string[]>([]);
  const guidesRef = useRef(guides);
  const [currentInterval, setCurrentInterval] = useState(DEFAULT_INTERVAL);
  const [computedGuides, setComputedGuides] = useState<PositionedOverlayGuide[]>([]);
  const [nativeOverlayActive, setNativeOverlayActive] = useState(false);
  const [chartReadyVersion, setChartReadyVersion] = useState(0);
  const [isVisible, setIsVisible] = useState(true);
  guidesRef.current = guides;
  const guideSignature = guides
    .map((guide) => `${guide.id}:${guide.price}:${guide.label}:${guide.tone}`)
    .join("|");

  const refreshOverlay = useCallback(() => {
    const frameNode = frameRef.current;
    const frameHeight = frameNode?.clientHeight ?? 0;
    const liveScale = readOverlayScaleSnapshot(frameNode);
    const fallbackScale = buildPositionOverlayScale({
      frameHeight,
      pricePoints,
      guides,
      interval: currentInterval,
    });
    const resolvedScale = liveScale ?? fallbackScale;

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
          setChartReadyVersion((version) => version + 1);
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
    let cancelled = false;
    const chart = widgetRef.current?.activeChart?.();

    const removeNativeShapes = () => {
      nativeShapeIdsRef.current.forEach((id) => chart?.removeEntity?.(id));
      nativeShapeIdsRef.current = [];
    };

    const syncNativeShapes = async () => {
      removeNativeShapes();
      setNativeOverlayActive(false);

      const currentGuides = guidesRef.current;
      if (!chart?.createShape || !chart.removeEntity || currentGuides.length === 0) return;
      const createShape = chart.createShape.bind(chart);
      const removeEntity = chart.removeEntity.bind(chart);

      const colors = {
        entry: "#65d9ff",
        tp: "#4ce38a",
        sl: "#ff7a7a",
        liquidation: "#ff9f43",
      } as const;
      const created: string[] = [];

      try {
        for (const guide of currentGuides) {
          if (!Number.isFinite(guide.price) || guide.price <= 0) continue;
          const id = await Promise.resolve(createShape(
            { price: guide.price },
            {
              shape: "horizontal_line",
              text: `${guide.label} ${guide.price.toFixed(2)}`,
              lock: true,
              disableSelection: true,
              disableSave: true,
              disableUndo: true,
              showInObjectsTree: false,
              zOrder: "top",
              overrides: {
                linecolor: colors[guide.tone],
                linestyle: 2,
                linewidth: 2,
                showLabel: true,
                showPrice: true,
                textcolor: colors[guide.tone],
              },
            }
          ));
          if (cancelled) {
            removeEntity(id);
          } else {
            created.push(id);
          }
        }

        if (!cancelled && created.length > 0) {
          nativeShapeIdsRef.current = created;
          setNativeOverlayActive(true);
        }
      } catch {
        created.forEach(removeEntity);
        if (!cancelled) setNativeOverlayActive(false);
      }
    };

    void syncNativeShapes();

    return () => {
      cancelled = true;
      removeNativeShapes();
    };
  }, [chartReadyVersion, guideSignature]);

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
