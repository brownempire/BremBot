"use client";

import { useEffect, useMemo, useRef, useState, type PointerEvent, type WheelEvent } from "react";

import type { PerpsPnlPoint, PerpsPnlTradeDetails } from "@/lib/perps/pnl";
import {
  normalizePnlChartDomain,
  panPnlChartDomain,
  zoomPnlChartDomain,
  type PnlChartDomain,
} from "@/lib/perps/pnlChart";
import { formatUsd } from "@/lib/utils";

const WIDTH = 640;
const HEIGHT = 250;
const PLOT_LEFT = 54;
const PLOT_RIGHT = 16;
const PLOT_TOP = 18;
const PLOT_BOTTOM = 34;
const PLOT_WIDTH = WIDTH - PLOT_LEFT - PLOT_RIGHT;
const PLOT_HEIGHT = HEIGHT - PLOT_TOP - PLOT_BOTTOM;

function formatTimestamp(timestamp: number) {
  return new Date(timestamp).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function tradeTone(trade: PerpsPnlTradeDetails) {
  if (trade.pnlUsd > 0) return "pnl-trade-win";
  if (trade.pnlUsd < 0) return "pnl-trade-loss";
  return "pnl-trade-neutral";
}

export function PerpsPnlChart({
  points,
  rangeLabel,
  walletLabel,
}: {
  points: PerpsPnlPoint[];
  rangeLabel: string;
  walletLabel: string;
}) {
  const ordered = useMemo(
    () => [...points]
      .filter((point) => Number.isFinite(point.t) && Number.isFinite(point.v))
      .sort((left, right) => left.t - right.t),
    [points]
  );
  const bounds = useMemo<PnlChartDomain>(() => {
    const start = ordered[0]?.t ?? Date.now() - 60_000;
    const rawEnd = ordered.at(-1)?.t ?? start + 60_000;
    return { start, end: Math.max(start + 60_000, rawEnd) };
  }, [ordered]);
  const [domain, setDomain] = useState<PnlChartDomain>(bounds);
  const [selectedTrade, setSelectedTrade] = useState<PerpsPnlTradeDetails | null>(null);
  const dragRef = useRef<{ pointerId: number; x: number } | null>(null);

  useEffect(() => {
    setDomain(bounds);
    setSelectedTrade(null);
  }, [bounds, rangeLabel, walletLabel]);

  const visible = useMemo(
    () => ordered.filter((point) => point.t >= domain.start && point.t <= domain.end),
    [domain.end, domain.start, ordered]
  );
  const values = visible.length > 0 ? visible.map((point) => point.v) : [0];
  const rawMinY = Math.min(...values, 0);
  const rawMaxY = Math.max(...values, 0);
  const yPadding = Math.max(0.25, (rawMaxY - rawMinY) * 0.12);
  const minY = rawMinY - yPadding;
  const maxY = rawMaxY + yPadding;
  const ySpan = Math.max(1e-6, maxY - minY);
  const xSpan = Math.max(1, domain.end - domain.start);
  const coordinates = visible.map((point) => ({
    point,
    x: PLOT_LEFT + ((point.t - domain.start) / xSpan) * PLOT_WIDTH,
    y: PLOT_TOP + (1 - (point.v - minY) / ySpan) * PLOT_HEIGHT,
  }));
  const polyline = coordinates.map(({ x, y }) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const zoomed = domain.start > bounds.start || domain.end < bounds.end;

  function zoom(anchorRatio: number, scale: number) {
    setDomain((current) => zoomPnlChartDomain(current, bounds, anchorRatio, scale));
  }

  function handleWheel(event: WheelEvent<SVGSVGElement>) {
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    const anchorRatio = Math.min(1, Math.max(0, (event.clientX - rect.left) / Math.max(1, rect.width)));
    zoom(anchorRatio, event.deltaY > 0 ? 1.25 : 0.8);
  }

  function handlePointerDown(event: PointerEvent<SVGSVGElement>) {
    dragRef.current = { pointerId: event.pointerId, x: event.clientX };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handlePointerMove(event: PointerEvent<SVGSVGElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - drag.x;
    drag.x = event.clientX;
    const rect = event.currentTarget.getBoundingClientRect();
    setDomain((current) => panPnlChartDomain(current, bounds, -deltaX / Math.max(1, rect.width)));
  }

  function handlePointerEnd(event: PointerEvent<SVGSVGElement>) {
    if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  return (
    <div className="pnl-chart-shell">
      <div className="pnl-chart-toolbar">
        <span>{coordinates.filter(({ point }) => point.trade).length} trades visible</span>
        <div className="pnl-chart-actions">
          <button type="button" className="secondary" aria-label="Zoom PnL chart in" onClick={() => zoom(0.5, 0.7)}>+</button>
          <button type="button" className="secondary" aria-label="Zoom PnL chart out" onClick={() => zoom(0.5, 1.4)}>−</button>
          <button
            type="button"
            className="secondary"
            disabled={!zoomed}
            onClick={() => setDomain(normalizePnlChartDomain(bounds, bounds))}
          >
            Reset
          </button>
        </div>
      </div>
      <div className="pnl-chart-wrap">
        <svg
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          role="img"
          aria-label={`${walletLabel} PnL chart for ${rangeLabel}. Scroll to zoom, drag to move, and select a trade for details.`}
          onWheel={handleWheel}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerEnd}
          onPointerCancel={handlePointerEnd}
        >
          {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
            const y = PLOT_TOP + ratio * PLOT_HEIGHT;
            const value = maxY - ratio * ySpan;
            return (
              <g key={ratio}>
                <line className="pnl-grid-line" x1={PLOT_LEFT} x2={WIDTH - PLOT_RIGHT} y1={y} y2={y} />
                <text className="pnl-axis-label" x={PLOT_LEFT - 7} y={y + 4} textAnchor="end">{formatUsd(value)}</text>
              </g>
            );
          })}
          <text className="pnl-axis-label" x={PLOT_LEFT} y={HEIGHT - 8}>{formatTimestamp(domain.start)}</text>
          <text className="pnl-axis-label" x={WIDTH - PLOT_RIGHT} y={HEIGHT - 8} textAnchor="end">{formatTimestamp(domain.end)}</text>
          <polyline
            points={polyline}
            fill="none"
            stroke="var(--accent)"
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          {coordinates.flatMap(({ point, x, y }) => point.trade ? [(
            <circle
              key={point.trade.id}
              className={`pnl-trade-marker ${tradeTone(point.trade)} ${selectedTrade?.id === point.trade.id ? "selected" : ""}`}
              cx={x}
              cy={y}
              r={selectedTrade?.id === point.trade.id ? 7 : 5}
              role="button"
              tabIndex={0}
              aria-label={`${point.trade.marketSymbol} ${point.trade.side} ${point.trade.action}, ${formatUsd(point.trade.pnlUsd)} PnL`}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() => setSelectedTrade(point.trade ?? null)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  setSelectedTrade(point.trade ?? null);
                }
              }}
            />
          )] : [])}
        </svg>
      </div>
      <div className="pnl-chart-hint">Scroll or use +/− to zoom · drag left or right to browse · tap a trade dot for details</div>
      {selectedTrade ? (
        <div className="pnl-trade-popover" role="dialog" aria-label="Selected trade details">
          <div className="pnl-trade-popover-heading">
            <strong>{selectedTrade.marketSymbol} {selectedTrade.side.toUpperCase()} · {selectedTrade.action}</strong>
            <button type="button" className="secondary" onClick={() => setSelectedTrade(null)} aria-label="Close trade details">×</button>
          </div>
          <div className="pnl-trade-detail-grid">
            <span><small>Time</small>{formatTimestamp(selectedTrade.timestamp)}</span>
            <span><small>Order</small>{selectedTrade.orderType || "Unknown"}</span>
            <span><small>Price</small>{selectedTrade.price === null ? "—" : formatUsd(selectedTrade.price)}</span>
            <span><small>Size</small>{selectedTrade.sizeUsd === null ? "—" : formatUsd(selectedTrade.sizeUsd)}</span>
            <span><small>Collateral Δ</small>{selectedTrade.collateralUsdDelta === null ? "—" : formatUsd(selectedTrade.collateralUsdDelta)}</span>
            <span><small>Fee</small>{selectedTrade.feeUsd === null ? "—" : formatUsd(selectedTrade.feeUsd)}</span>
            <span><small>Trade PnL</small><b className={selectedTrade.pnlUsd >= 0 ? "pnl-positive" : "pnl-negative"}>{formatUsd(selectedTrade.pnlUsd)}</b></span>
            <span><small>Cumulative</small>{formatUsd(selectedTrade.cumulativePnlUsd)}</span>
          </div>
          <div className="pnl-trade-identifiers">
            Position {selectedTrade.positionPubkey ?? "Unavailable"}
            {selectedTrade.txHash ? <> · Transaction {selectedTrade.txHash}</> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
