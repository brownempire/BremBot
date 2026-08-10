"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { createBremLogicDatafeed } from "@/lib/chart/tradingViewDatafeed";
import { clampFloatingPanelPosition, type FloatingPanelPosition } from "@/lib/chart/floatingPanel";
import type { ScalpAgentOverlaySnapshot } from "@/lib/chart/scalpAgentOverlay";
import {
  projectOverlayGuideNetPnl,
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

type ShapePoint = { price: number; time?: number };

type DrawingShapeApi = {
  getPoints?: () => ShapePoint[];
  setPoints?: (points: ShapePoint[]) => void;
  setSelectionEnabled?: (enabled: boolean) => void;
  setUserEditEnabled?: (enabled: boolean) => void;
};

type ChartPaneApi = {
  collapse?: () => void;
  restore?: () => void;
  isCollapsed?: () => boolean;
  hasMainSeries?: () => boolean;
  setHeight?: (height: number) => void;
  moveTo?: (paneIndex: number) => void;
  paneIndex?: () => number;
};

type WidgetChart = {
  onIntervalChanged?: () => IntervalSubscription;
  resolution?: () => string;
  setResolution?: (resolution: string, callback?: () => void) => void;
  getPanes?: () => ChartPaneApi[];
  createShape?: (
    point: ShapePoint,
    options: Record<string, unknown>
  ) => Promise<string>;
  getShapeById?: (id: string) => DrawingShapeApi;
  removeEntity?: (id: string) => void;
  createStudy?: (
    name: string,
    forceOverlay?: boolean,
    lock?: boolean,
    inputs?: Record<string, unknown>,
    overrides?: Record<string, unknown>,
    options?: Record<string, unknown>
  ) => Promise<string> | string;
};

type WidgetApi = {
  onChartReady?: (callback: () => void) => void;
  chartReady?: () => Promise<void>;
  activeChart?: () => WidgetChart;
  remove?: () => void;
  subscribe?: (event: "drawing_event", callback: (id: string, type: string) => void) => void;
  unsubscribe?: (event: "drawing_event", callback: (id: string, type: string) => void) => void;
};

type TradingViewChartProps = {
  symbol?: string;
  guides?: PositionOverlayGuide[];
  onModifyGuide?: (guide: PositionOverlayGuide, price: number) => Promise<void>;
  scalpOverlayEnabled?: boolean;
  scalpOverlayAuthToken?: string | null;
};

type GuideEditorState = {
  draftValue: string;
  draftPrice: number;
  guide: PositionOverlayGuide;
  mode: "view" | "edit";
  status: string | null;
};

function editablePriceValue(price: number) {
  return Number(price.toFixed(6)).toString();
}

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

function safelyRemoveEntity(chart: WidgetChart | null | undefined, id: string) {
  try {
    chart?.removeEntity?.(id);
  } catch {
    // TradingView can invalidate its chart API before React finishes effect cleanup.
  }
}

function safelyRemoveWidget(widget: WidgetApi | null | undefined) {
  try {
    widget?.remove?.();
  } catch {
    // A detached iOS WebView iframe is already removed for our purposes.
  }
}

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
  onModifyGuide,
  scalpOverlayEnabled = false,
  scalpOverlayAuthToken = null,
}: TradingViewChartProps) {
  const containerId = useMemo(() => "tradingview_advanced_chart", []);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const widgetRef = useRef<WidgetApi | null>(null);
  const shapeIdsRef = useRef<string[]>([]);
  const scalpMarkerIdsRef = useRef<string[]>([]);
  const scalpStudyIdsRef = useRef<string[]>([]);
  const scalpPanelRef = useRef<HTMLDivElement | null>(null);
  const scalpPanelDragRef = useRef<{
    pointerId: number;
    pointerX: number;
    pointerY: number;
    startLeft: number;
    startTop: number;
  } | null>(null);
  const scalpOverlayEnabledRef = useRef(scalpOverlayEnabled);
  const shapeGuideByIdRef = useRef(new Map<string, PositionOverlayGuide>());
  const shapeIdByGuideIdRef = useRef(new Map<string, string>());
  const suppressedShapeEventsRef = useRef(new Set<string>());
  const drawingEventCallbackRef = useRef<((id: string, type: string) => void) | null>(null);
  const drawingEventHandlerRef = useRef<(id: string, type: string) => void>(() => undefined);
  const guidesRef = useRef(guides);
  const [chartReadyVersion, setChartReadyVersion] = useState(0);
  const [isChartLoading, setIsChartLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isAppFullscreen, setIsAppFullscreen] = useState(false);
  const [guideEditor, setGuideEditor] = useState<GuideEditorState | null>(null);
  const [isSavingGuide, setIsSavingGuide] = useState(false);
  const [chartResolution, setChartResolution] = useState(DEFAULT_INTERVAL);
  const [scalpSnapshot, setScalpSnapshot] = useState<ScalpAgentOverlaySnapshot | null>(null);
  const [scalpOverlayError, setScalpOverlayError] = useState<string | null>(null);
  const [indicatorPanesCollapsed, setIndicatorPanesCollapsed] = useState(false);
  const [scalpPanelMinimized, setScalpPanelMinimized] = useState(false);
  const [scalpPanelPosition, setScalpPanelPosition] = useState<FloatingPanelPosition | null>(null);
  scalpOverlayEnabledRef.current = scalpOverlayEnabled;
  guidesRef.current = guides;

  const guideSignature = validOverlayGuides(guides)
    .map((guide) => `${guide.id}:${guide.price}:${guide.label}:${guide.tone}:${guide.editable ? 1 : 0}:${guide.estimatedNetPnlUsd ?? ""}:${guide.pnlPerPriceUnit ?? ""}`)
    .join("|");

  function setIndicatorPanesCollapsedState(collapsed: boolean) {
    const chart = widgetRef.current?.activeChart?.();
    const indicatorPanes = chart?.getPanes?.().filter((pane) => !pane.hasMainSeries?.()) ?? [];
    indicatorPanes.forEach((pane) => {
      try {
        if (collapsed) pane.collapse?.();
        else pane.restore?.();
      } catch {
        // A pane may disappear while the overlay is being removed.
      }
    });
    setIndicatorPanesCollapsed(collapsed);
    window.requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
  }

  function constrainedScalpPanelPosition(left: number, top: number) {
    const frame = frameRef.current;
    const panel = scalpPanelRef.current;
    if (!frame || !panel) return { left, top };

    return clampFloatingPanelPosition({
      left,
      top,
      panelWidth: panel.offsetWidth,
      panelHeight: panel.offsetHeight,
      containerWidth: frame.clientWidth,
      containerHeight: frame.clientHeight,
    });
  }

  function beginScalpPanelDrag(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
    const frame = frameRef.current;
    const panel = scalpPanelRef.current;
    if (!frame || !panel) return;

    const frameBounds = frame.getBoundingClientRect();
    const panelBounds = panel.getBoundingClientRect();
    scalpPanelDragRef.current = {
      pointerId: event.pointerId,
      pointerX: event.clientX,
      pointerY: event.clientY,
      startLeft: panelBounds.left - frameBounds.left,
      startTop: panelBounds.top - frameBounds.top,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  }

  function moveScalpPanel(event: React.PointerEvent<HTMLDivElement>) {
    const drag = scalpPanelDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setScalpPanelPosition(constrainedScalpPanelPosition(
      drag.startLeft + event.clientX - drag.pointerX,
      drag.startTop + event.clientY - drag.pointerY
    ));
  }

  function endScalpPanelDrag(event: React.PointerEvent<HTMLDivElement>) {
    if (scalpPanelDragRef.current?.pointerId !== event.pointerId) return;
    scalpPanelDragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function toggleScalpPanelSize() {
    setScalpPanelMinimized((current) => !current);
  }

  function shapeForGuide(guideId: string) {
    const shapeId = shapeIdByGuideIdRef.current.get(guideId);
    return shapeId ? widgetRef.current?.activeChart?.()?.getShapeById?.(shapeId) ?? null : null;
  }

  function setShapePrice(guideId: string, price: number) {
    const shapeId = shapeIdByGuideIdRef.current.get(guideId);
    const shape = shapeId ? widgetRef.current?.activeChart?.()?.getShapeById?.(shapeId) : null;
    if (!shapeId || !shape?.setPoints) return;
    suppressedShapeEventsRef.current.add(shapeId);
    shape.setPoints([{ price }]);
    window.setTimeout(() => suppressedShapeEventsRef.current.delete(shapeId), 80);
  }

  function setShapeEditing(guideId: string, enabled: boolean) {
    const shape = shapeForGuide(guideId);
    shape?.setSelectionEnabled?.(true);
    shape?.setUserEditEnabled?.(enabled);
  }

  function resetGuideEditor(close = false) {
    if (!guideEditor) return;
    setShapePrice(guideEditor.guide.id, guideEditor.guide.price);
    setShapeEditing(guideEditor.guide.id, false);
    setGuideEditor(close ? null : {
      ...guideEditor,
      draftPrice: guideEditor.guide.price,
      draftValue: editablePriceValue(guideEditor.guide.price),
      mode: "view",
      status: null,
    });
  }

  drawingEventHandlerRef.current = (shapeId, eventType) => {
    const guide = shapeGuideByIdRef.current.get(String(shapeId));
    if (!guide?.editable || !guide.kind) return;
    if (eventType === "click") {
      setGuideEditor((current) => (
        current?.guide.id === guide.id && current.mode === "edit"
          ? current
          : { draftPrice: guide.price, draftValue: editablePriceValue(guide.price), guide, mode: "view", status: null }
      ));
      return;
    }
    if (eventType !== "points_changed" || suppressedShapeEventsRef.current.has(String(shapeId))) return;
    const point = widgetRef.current?.activeChart?.()?.getShapeById?.(String(shapeId))?.getPoints?.()[0];
    if (!point || !Number.isFinite(point.price) || point.price <= 0) return;
    setGuideEditor({ draftPrice: point.price, draftValue: editablePriceValue(point.price), guide, mode: "edit", status: null });
  };

  useEffect(() => {
    let cancelled = false;
    const shapeGuideById = shapeGuideByIdRef.current;
    const shapeIdByGuideId = shapeIdByGuideIdRef.current;

    const renderWidget = async () => {
      const container = document.getElementById(containerId);
      if (!container) return;

      setIsChartLoading(true);
      safelyRemoveWidget(widgetRef.current);
      widgetRef.current = null;
      container.replaceChildren();
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
            "header_fullscreen_button",
            "header_saveload",
            "header_symbol_search",
            "symbol_search_hot_key",
          ],
          enabled_features: [
            "use_localstorage_for_settings",
            "save_chart_properties_to_local_storage",
            "display_legend_on_all_charts",
            "edit_buttons_in_legend",
            "show_hide_button_in_legend",
            "pane_context_menu",
            "legend_context_menu",
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
          setIsChartLoading(false);
          setChartReadyVersion((version) => version + 1);
          const chart = widget.activeChart?.();
          const currentResolution = chart?.resolution?.();
          if (currentResolution) {
            setChartResolution(currentResolution);
            if (!scalpOverlayEnabledRef.current) window.localStorage.setItem(INTERVAL_STORAGE_KEY, currentResolution);
          }
          chart?.onIntervalChanged?.().subscribe?.(null, (nextInterval) => {
            const interval = String(nextInterval || "");
            if (interval) {
              setChartResolution(interval);
              if (!scalpOverlayEnabledRef.current) window.localStorage.setItem(INTERVAL_STORAGE_KEY, interval);
            }
          });
          if (drawingEventCallbackRef.current) {
            try {
              widget.unsubscribe?.("drawing_event", drawingEventCallbackRef.current);
            } catch {
              // Ignore a stale TradingView event bridge during native navigation.
            }
          }
          const drawingEventCallback = (id: string, type: string) => {
            drawingEventHandlerRef.current(String(id), String(type));
          };
          drawingEventCallbackRef.current = drawingEventCallback;
          widget.subscribe?.("drawing_event", drawingEventCallback);
        };

        if (widget.chartReady) {
          await widget.chartReady();
          handleChartReady();
        } else {
          widget.onChartReady?.(handleChartReady);
        }
      } catch (error) {
        if (cancelled) return;
        setIsChartLoading(false);
        const message =
          error instanceof Error ? error.message : "TradingView Advanced Charts failed to load";
        setLoadError(message);
      }
    };

    void renderWidget();

    return () => {
      cancelled = true;
      shapeIdsRef.current = [];
      scalpMarkerIdsRef.current = [];
      scalpStudyIdsRef.current = [];
      shapeGuideById.clear();
      shapeIdByGuideId.clear();
      if (drawingEventCallbackRef.current) {
        try {
          widgetRef.current?.unsubscribe?.("drawing_event", drawingEventCallbackRef.current);
        } catch {
          // Ignore teardown after the native WebView detached the chart frame.
        }
        drawingEventCallbackRef.current = null;
      }
      safelyRemoveWidget(widgetRef.current);
      widgetRef.current = null;
    };
  }, [containerId, symbol]);

  useEffect(() => {
    const chart = widgetRef.current?.activeChart?.();
    if (!chart || chartReadyVersion === 0) return;
    let cancelled = false;

    const removeStudies = () => {
      scalpStudyIdsRef.current.forEach((id) => safelyRemoveEntity(chart, id));
      scalpStudyIdsRef.current = [];
      window.requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
    };

    removeStudies();
    const currentResolution = chart.resolution?.();
    if (!scalpOverlayEnabled) {
      setIndicatorPanesCollapsed(false);
      const storedInterval = window.localStorage.getItem(INTERVAL_STORAGE_KEY) ?? DEFAULT_INTERVAL;
      if (currentResolution === "1" && storedInterval !== "1") {
        try {
          chart.setResolution?.(storedInterval);
        } catch {
          // Keep the current candle view if this licensed chart build cannot restore it.
        }
      }
      return removeStudies;
    }

    if (currentResolution && currentResolution !== "1") {
      window.localStorage.setItem(INTERVAL_STORAGE_KEY, currentResolution);
    }
    if (currentResolution !== "1") {
      try {
        chart.setResolution?.("1");
      } catch {
        // The status strip still identifies the exact timeframe if switching is unavailable.
      }
    }

    const createStudy = async (
      names: string[],
      forceOverlay: boolean,
      inputs: Record<string, unknown>,
      overrides: Record<string, unknown> = {}
    ) => {
      for (const name of names) {
        try {
          const id = await chart.createStudy?.(name, forceOverlay, false, inputs, overrides, {
            disableSave: true,
            disableUndo: true,
          });
          if (!id) continue;
          if (cancelled || !scalpOverlayEnabledRef.current) {
            safelyRemoveEntity(chart, String(id));
          } else {
            scalpStudyIdsRef.current.push(String(id));
          }
          return;
        } catch {
          // Licensed Advanced Charts releases can expose a fallback study name.
        }
      }
    };

    void (async () => {
      await createStudy(["Moving Average Exponential", "EMA"], true, { length: 9 }, { "plot.color": "#39dca0", "plot.linewidth": 2 });
      await createStudy(["Moving Average Exponential", "EMA"], true, { length: 21 }, { "plot.color": "#4c8dff", "plot.linewidth": 2 });
      await createStudy(["Bollinger Bands", "BB"], true, { length: 20, mult: 2 }, {
        "upper.color": "rgba(185, 122, 255, 0.78)",
        "lower.color": "rgba(185, 122, 255, 0.78)",
        "basis.color": "rgba(185, 122, 255, 0.38)",
      });
      await createStudy(["Relative Strength Index", "RSI"], false, { length: 14 }, { "plot.color": "#e1b855" });
      await createStudy(["Directional Movement", "Average Directional Index", "ADX"], false, { length: 14 }, {
        "ADX.color": "#ff9d5c",
        "+DI.color": "#39dca0",
        "-DI.color": "#ff647c",
      });
      await createStudy(["Volume"], false, { length: 20 });
      if (!cancelled) {
        const indicatorPanes = chart.getPanes?.().filter((pane) => !pane.hasMainSeries?.()) ?? [];
        indicatorPanes.forEach((pane) => {
          try {
            pane.restore?.();
            pane.setHeight?.(92);
          } catch {
            // The user can still resize the pane manually if this build rejects a default height.
          }
        });
        setIndicatorPanesCollapsed(false);
        window.requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
      }
    })();

    return () => {
      cancelled = true;
      removeStudies();
    };
  }, [chartReadyVersion, scalpOverlayEnabled]);

  useEffect(() => {
    if (!scalpOverlayEnabled || !scalpOverlayAuthToken) {
      setScalpSnapshot(null);
      setScalpOverlayError(scalpOverlayEnabled ? "Connect and authenticate the Perps wallet to load the live scalp profile." : null);
      return;
    }

    let cancelled = false;
    const loadSnapshot = async () => {
      try {
        const query = new URLSearchParams({ symbol });
        const response = await fetch(`/api/perps/scalp-overlay?${query}`, {
          cache: "no-store",
          headers: { Authorization: `Bearer ${scalpOverlayAuthToken}` },
        });
        const payload = await response.json().catch(() => null) as (ScalpAgentOverlaySnapshot & { error?: string }) | null;
        if (!response.ok || !payload) throw new Error(payload?.error || "Scalp overlay data is unavailable.");
        if (!cancelled) {
          setScalpSnapshot(payload);
          setScalpOverlayError(null);
        }
      } catch (error) {
        if (!cancelled) setScalpOverlayError(error instanceof Error ? error.message : "Scalp overlay data is unavailable.");
      }
    };

    void loadSnapshot();
    const timer = window.setInterval(loadSnapshot, 15_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [scalpOverlayAuthToken, scalpOverlayEnabled, symbol]);

  useEffect(() => {
    const chart = widgetRef.current?.activeChart?.();
    const removeMarkers = () => {
      scalpMarkerIdsRef.current.forEach((id) => safelyRemoveEntity(chart, id));
      scalpMarkerIdsRef.current = [];
    };
    removeMarkers();
    if (!scalpOverlayEnabled || !chart?.createShape || !scalpSnapshot?.markers.length) return removeMarkers;

    let cancelled = false;
    const created: string[] = [];
    const addMarkers = async () => {
      for (const marker of scalpSnapshot.markers) {
        const bullish = marker.direction === "bullish";
        try {
          const id = await chart.createShape?.(
            { time: marker.time, price: marker.price },
            {
              shape: bullish ? "arrow_up" : "arrow_down",
              text: `${bullish ? "LONG" : "SHORT"} ${marker.setupType.replace(/-/g, " ")} · ${(marker.confidence * 100).toFixed(0)}%`,
              lock: true,
              disableSelection: true,
              disableSave: true,
              disableUndo: true,
              showInObjectsTree: false,
              zOrder: "top",
              overrides: {
                color: bullish ? "#39dca0" : "#ff647c",
                textColor: bullish ? "#8fffd2" : "#ffadb9",
                fontsize: 11,
              },
            }
          );
          if (!id) continue;
          if (cancelled) safelyRemoveEntity(chart, String(id));
          else created.push(String(id));
        } catch {
          // Keep native studies/status available if one historical marker cannot be drawn.
        }
      }
      if (!cancelled) scalpMarkerIdsRef.current = created;
    };
    void addMarkers();
    return () => {
      cancelled = true;
      created.forEach((id) => safelyRemoveEntity(chart, id));
      removeMarkers();
    };
  }, [chartReadyVersion, scalpOverlayEnabled, scalpSnapshot]);

  useEffect(() => {
    let cancelled = false;
    const chart = widgetRef.current?.activeChart?.();

    const removeShapes = () => {
      shapeIdsRef.current.forEach((id) => safelyRemoveEntity(chart, id));
      shapeIdsRef.current = [];
      shapeGuideByIdRef.current.clear();
      shapeIdByGuideIdRef.current.clear();
    };

    const syncPositionShapes = async () => {
      removeShapes();
      const currentGuides = validOverlayGuides(guidesRef.current);
      if (!chart?.createShape || !chart.removeEntity || currentGuides.length === 0) {
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
              lock: !guide.editable,
              disableSelection: !guide.editable,
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
          shapeGuideByIdRef.current.set(String(id), guide);
          shapeIdByGuideIdRef.current.set(guide.id, String(id));
          if (guide.editable) {
            const shape = chart.getShapeById?.(String(id));
            shape?.setSelectionEnabled?.(true);
            shape?.setUserEditEnabled?.(false);
          }
          if (cancelled) {
            safelyRemoveEntity(chart, String(id));
          } else {
            created.push(id);
          }
        }
        if (!cancelled) {
          shapeIdsRef.current = created;
        }
      } catch {
        created.forEach((id) => safelyRemoveEntity(chart, String(id)));
      }
    };

    void syncPositionShapes();

    return () => {
      cancelled = true;
      removeShapes();
    };
  }, [chartReadyVersion, guideSignature]);

  useEffect(() => {
    setGuideEditor((current) => {
      if (!current) return null;
      const nextGuide = validOverlayGuides(guidesRef.current).find((guide) => guide.id === current.guide.id);
      if (!nextGuide) return null;
      if (current.mode === "edit") return { ...current, guide: nextGuide };
      return { draftPrice: nextGuide.price, draftValue: editablePriceValue(nextGuide.price), guide: nextGuide, mode: "view", status: null };
    });
  }, [guideSignature]);

  const projectedNetPnl = guideEditor
    ? projectOverlayGuideNetPnl(guideEditor.guide, guideEditor.draftPrice)
    : null;

  async function confirmGuideChange() {
    if (!guideEditor || !onModifyGuide || !Number.isFinite(guideEditor.draftPrice) || guideEditor.draftPrice <= 0) return;
    setIsSavingGuide(true);
    setGuideEditor((current) => current ? { ...current, status: "Updating on-chain request…" } : null);
    try {
      await onModifyGuide(guideEditor.guide, guideEditor.draftPrice);
      setShapeEditing(guideEditor.guide.id, false);
      setGuideEditor(null);
    } catch (error) {
      setGuideEditor((current) => current ? {
        ...current,
        status: error instanceof Error ? error.message : "Unable to update this TP/SL request.",
      } : null);
    } finally {
      setIsSavingGuide(false);
    }
  }

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

  useEffect(() => {
    document.body.classList.toggle("chart-app-fullscreen", isAppFullscreen);

    const resizeChart = () => window.dispatchEvent(new Event("resize"));
    const firstFrame = window.requestAnimationFrame(() => {
      resizeChart();
      window.requestAnimationFrame(resizeChart);
    });

    return () => {
      window.cancelAnimationFrame(firstFrame);
      document.body.classList.remove("chart-app-fullscreen");
    };
  }, [isAppFullscreen]);

  useEffect(() => {
    const keepScalpPanelInsideChart = () => {
      setScalpPanelPosition((current) => {
        if (!current) return current;
        const frame = frameRef.current;
        const panel = scalpPanelRef.current;
        if (!frame || !panel) return current;
        const next = clampFloatingPanelPosition({
          left: current.left,
          top: current.top,
          panelWidth: panel.offsetWidth,
          panelHeight: panel.offsetHeight,
          containerWidth: frame.clientWidth,
          containerHeight: frame.clientHeight,
        });
        return next.left === current.left && next.top === current.top ? current : next;
      });
    };

    const frame = window.requestAnimationFrame(keepScalpPanelInsideChart);
    window.addEventListener("resize", keepScalpPanelInsideChart);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", keepScalpPanelInsideChart);
    };
  }, [isAppFullscreen, scalpPanelMinimized]);

  return (
    <div
      ref={frameRef}
      className={`tradingview-frame${isAppFullscreen ? " tradingview-frame--app-fullscreen" : ""}`}
      data-chart-engine="advanced-charts"
      data-app-fullscreen={isAppFullscreen ? "true" : "false"}
    >
      <div id={containerId} className="tradingview-container" />
      {isChartLoading && !loadError ? (
        <div className="tradingview-loading" role="status" aria-label="Loading TradingView chart">
          <span className="tradingview-loading-spinner" aria-hidden="true" />
          <span>Loading chart…</span>
        </div>
      ) : null}
      <button
        type="button"
        className={`tradingview-fullscreen-button${isAppFullscreen ? " is-close" : ""}`}
        aria-label={isAppFullscreen ? "Close chart fullscreen" : "Open chart fullscreen"}
        aria-pressed={isAppFullscreen}
        onClick={() => setIsAppFullscreen((current) => !current)}
      >
        {isAppFullscreen ? (
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M9 4H4v5M15 4h5v5M20 15v5h-5M4 15v5h5" />
          </svg>
        )}
      </button>
      {scalpOverlayEnabled ? (
        <div
          ref={scalpPanelRef}
          className={`scalp-chart-status scalp-chart-status--${scalpSnapshot?.state ?? "watching"}${scalpPanelMinimized ? " scalp-chart-status--minimized" : ""}`}
          data-testid="scalp-chart-status"
          data-minimized={scalpPanelMinimized ? "true" : "false"}
          style={scalpPanelPosition ? { left: scalpPanelPosition.left, top: scalpPanelPosition.top, bottom: "auto" } : undefined}
        >
          <div
            className="scalp-chart-status-heading"
            onPointerDown={beginScalpPanelDrag}
            onPointerMove={moveScalpPanel}
            onPointerUp={endScalpPanelDrag}
            onPointerCancel={endScalpPanelDrag}
          >
            <span className="scalp-chart-status-dot" aria-hidden="true" />
            <strong>{scalpPanelMinimized ? "Waiting" : scalpOverlayError ? "Scalp profile unavailable" : scalpSnapshot?.headline ?? "Loading Scalp Agent…"}</strong>
            {!scalpPanelMinimized ? <span className="scalp-chart-status-view">1m agent view</span> : null}
            <button
              type="button"
              className="scalp-chart-status-size-button"
              aria-label={scalpPanelMinimized ? "Maximize scalp setup window" : "Minimize scalp setup window"}
              aria-expanded={!scalpPanelMinimized}
              onClick={toggleScalpPanelSize}
            >
              {scalpPanelMinimized ? "+" : "−"}
            </button>
          </div>
          {!scalpPanelMinimized ? <><div className="scalp-chart-pane-controls">
            <button
              type="button"
              onClick={() => setIndicatorPanesCollapsedState(!indicatorPanesCollapsed)}
              aria-pressed={indicatorPanesCollapsed}
            >
              {indicatorPanesCollapsed ? "Expand indicators" : "Collapse indicators"}
            </button>
            <span>Drag pane dividers or use each pane menu to resize and move.</span>
          </div>
          <div className="scalp-chart-status-detail">
            {scalpOverlayError ?? scalpSnapshot?.detail ?? "Loading the learned profile and Coinbase indicator window."}
          </div>
          {chartResolution !== "1" ? (
            <div className="scalp-chart-timeframe-warning" role="status">
              Chart is {chartResolution}m · Select 1m in the chart toolbar for the exact agent view
            </div>
          ) : null}
          {scalpSnapshot ? (
            <div className="scalp-chart-metrics" aria-label="Scalp Agent indicators">
              <span>RSI <b>{scalpSnapshot.indicators.rsi?.toFixed(1) ?? "--"}</b> <small>≤{scalpSnapshot.thresholds.longRsiMaximum.toFixed(0)} / ≥{scalpSnapshot.thresholds.shortRsiMinimum.toFixed(0)}</small></span>
              <span>ADX <b>{scalpSnapshot.indicators.adx?.toFixed(1) ?? "--"}</b> <small>≤{scalpSnapshot.thresholds.maximumAdx.toFixed(1)}</small></span>
              <span>EMA Δ <b>{scalpSnapshot.indicators.emaSpreadPercent?.toFixed(2) ?? "--"}%</b> <small>≤{scalpSnapshot.thresholds.maximumEmaSpreadPercent.toFixed(2)}%</small></span>
              <span>ATR <b>{scalpSnapshot.indicators.atrPercent?.toFixed(2) ?? "--"}%</b> <small>≥{scalpSnapshot.thresholds.minimumAtrPercent.toFixed(2)}%</small></span>
              <span>VOL <b>{scalpSnapshot.indicators.volumeRatio?.toFixed(2) ?? "--"}×</b> <small>≥{scalpSnapshot.thresholds.minimumVolumeRatio.toFixed(2)}×</small></span>
              <span>BB <b>{scalpSnapshot.indicators.bollingerPosition?.toFixed(2) ?? "--"}</b> <small>edge position</small></span>
            </div>
          ) : null}
          {scalpSnapshot?.reasons[0] ? <div className="scalp-chart-reason">{scalpSnapshot.reasons[0]}</div> : null}
          </> : null}
        </div>
      ) : null}
      {guideEditor ? (
        <div className="chart-tpsl-editor" data-testid="chart-tpsl-editor" role="dialog" aria-label={`${guideEditor.guide.kind === "tp" ? "Take profit" : "Stop loss"} chart control`}>
          <div className="chart-tpsl-editor-heading">
            <div>
              <span>{guideEditor.guide.kind === "tp" ? "Take Profit" : "Stop Loss"}</span>
              <strong>${guideEditor.draftPrice.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 })}</strong>
            </div>
            <button type="button" className="chart-tpsl-editor-close" aria-label="Close TP/SL chart control" onClick={() => resetGuideEditor(true)}>×</button>
          </div>
          <div className={`chart-tpsl-net${projectedNetPnl == null ? "" : projectedNetPnl >= 0 ? " pnl-positive" : " pnl-negative"}`}>
            Est. net P&amp;L {projectedNetPnl == null ? "--" : `${projectedNetPnl >= 0 ? "+" : "-"}$${Math.abs(projectedNetPnl).toFixed(2)}`}
          </div>
          {guideEditor.mode === "edit" ? (
            <label className="chart-tpsl-price-input">
              <span>New trigger</span>
              <input
                aria-label="New TP/SL trigger price"
                inputMode="decimal"
                value={guideEditor.draftValue}
                onChange={(event) => {
                  const draftValue = event.target.value;
                  const price = Number(draftValue);
                  setGuideEditor((current) => current ? {
                    ...current,
                    ...(Number.isFinite(price) && price > 0 ? { draftPrice: price } : {}),
                    draftValue,
                    status: null,
                  } : null);
                  if (Number.isFinite(price) && price > 0) setShapePrice(guideEditor.guide.id, price);
                }}
              />
            </label>
          ) : null}
          {guideEditor.status ? <div className="chart-tpsl-editor-status" role="status">{guideEditor.status}</div> : null}
          <div className="chart-tpsl-editor-actions">
            {guideEditor.mode === "view" ? (
              <button type="button" onClick={() => {
                setShapeEditing(guideEditor.guide.id, true);
                setGuideEditor((current) => current ? { ...current, mode: "edit", status: "Drag the line or enter a price, then confirm." } : null);
              }}>Modify</button>
            ) : (
              <>
                <button
                  type="button"
                  disabled={isSavingGuide || !guideEditor.draftValue.trim() || !Number.isFinite(Number(guideEditor.draftValue)) || Number(guideEditor.draftValue) <= 0}
                  onClick={() => void confirmGuideChange()}
                >{isSavingGuide ? "Saving…" : "Confirm"}</button>
                <button type="button" className="secondary" disabled={isSavingGuide} onClick={() => resetGuideEditor(false)}>Cancel</button>
              </>
            )}
          </div>
        </div>
      ) : null}
      {loadError ? (
        <div className="tradingview-load-error" role="alert">
          {loadError}. Run <code>npm run stage:tradingview</code> before building.
        </div>
      ) : null}
    </div>
  );
}
