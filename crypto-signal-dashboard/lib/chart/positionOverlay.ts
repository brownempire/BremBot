import { estimateNetExitPnl, type OpenPnlAccounting } from "@/lib/perps/pnlAccounting";

export type PositionOverlayGuide = {
  editable?: boolean;
  estimatedNetPnlUsd?: number | null;
  id: string;
  kind?: "tp" | "sl";
  label: string;
  pnlPerPriceUnit?: number | null;
  positionId?: string;
  price: number;
  tone: "entry" | "tp" | "sl" | "liquidation";
};

export type PositionGuideSource = {
  id: string;
  accountRef?: string | null;
  collateralValue?: number | null;
  entryPrice: number | null;
  marketSymbol?: string | null;
  markPrice?: number | null;
  positionSize?: number | null;
  positionValue?: number | null;
  source?: string | null;
  takeProfit: number | null;
  stopLoss: number | null;
  liquidationPrice: number | null;
  side?: "long" | "short";
  unrealizedPnl?: number | null;
  pnlCostBasis?: OpenPnlAccounting | null;
};

export type PositionEntryMarker = {
  id: string;
  label: string;
  positionId: string;
  price: number;
  side: "long" | "short";
  time: number;
};

type PositionEntryTradeSource = {
  action?: string | null;
  createdAt?: number | null;
  lastUpdated?: number | null;
  marketSymbol?: string | null;
  orderType?: string | null;
  positionPubkey?: string | null;
  side?: "long" | "short" | null;
};

type PositionEntryExecutionSource = {
  asset?: string | null;
  createdAt?: string | null;
  positionPubkey?: string | null;
  side?: "long" | "short" | null;
  status?: string | null;
};

export type EstimatedPositionNetPnl = {
  estimatedExitCostsUsd: number;
  estimatedNetPnlUsd: number;
};


function finite(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function marketAsset(value: string | null | undefined) {
  const normalized = (value ?? "").replace(/[^A-Z0-9]/gi, "").toUpperCase();
  if (normalized.includes("BTC")) return "BTC";
  if (normalized.includes("ETH")) return "ETH";
  if (normalized.includes("SOL")) return "SOL";
  return normalized;
}

function timestampSeconds(value: number | string | null | undefined) {
  const numeric = typeof value === "string" ? Date.parse(value) : value;
  if (typeof numeric !== "number" || !Number.isFinite(numeric) || numeric <= 0) return null;
  return Math.round(numeric > 10_000_000_000 ? numeric / 1_000 : numeric);
}

function isOpeningTrade(trade: PositionEntryTradeSource) {
  return /increase|open/i.test(`${trade.action ?? ""} ${trade.orderType ?? ""}`);
}

function isFullCloseTrade(trade: PositionEntryTradeSource) {
  return /close|liquidat/i.test(`${trade.action ?? ""} ${trade.orderType ?? ""}`);
}

function positionReference(position: PositionGuideSource) {
  return position.accountRef?.trim() || position.id;
}

/**
 * Jupiter's live `pnlAfterFeesUsd` is the best baseline because it retains the
 * actual open fee and accrued borrow costs. The close has not happened yet, so
 * reserve the unconsumed part of the conservative observed round-trip rate plus
 * a small transaction allowance. Gross-only fallback feeds cannot provide
 * accrued borrowing and deliberately do not publish an all-in net figure.
 */
export function estimatePositionNetExitPnl(
  position: PositionGuideSource
): EstimatedPositionNetPnl | null {
  const result = estimateNetExitPnl({ ...position,
    positionValue: finite(position.positionValue), positionSize: finite(position.positionSize),
    collateralValue: finite(position.collateralValue), unrealizedPnl: finite(position.unrealizedPnl),
  });
  return result ? {estimatedExitCostsUsd:result.estimatedExitCostsUsd,estimatedNetPnlUsd:result.estimatedNetPnlUsd} : null;
}

export function summarizePositionOverlayEstimatedNetPnl(
  positions: readonly PositionGuideSource[]
) {
  if (positions.length === 0) return null;
  const estimates = positions.map(estimatePositionNetExitPnl);
  if (estimates.some((estimate) => estimate === null)) return null;
  return Number(estimates.reduce((sum, estimate) => sum + estimate!.estimatedNetPnlUsd, 0).toFixed(2));
}

export function summarizePositionOverlayEstimatedNetPnlPercent(
  positions: readonly PositionGuideSource[]
) {
  const estimatedPnl = summarizePositionOverlayEstimatedNetPnl(positions);
  if (estimatedPnl === null || positions.some(
    (position) => finite(position.pnlCostBasis?.capitalUsd ?? position.collateralValue) === null || finite(position.pnlCostBasis?.capitalUsd ?? position.collateralValue)! <= 0
  )) return null;
  const totalCollateral = positions.reduce((sum, position) => sum + finite(position.pnlCostBasis?.capitalUsd ?? position.collateralValue)!, 0);
  return Number(((estimatedPnl / totalCollateral) * 100).toFixed(2));
}

export function buildPositionEntryMarkers(options: {
  positions: readonly PositionGuideSource[];
  trades?: readonly PositionEntryTradeSource[];
  executions?: readonly PositionEntryExecutionSource[];
}): PositionEntryMarker[] {
  const trades = options.trades ?? [];
  const executions = options.executions ?? [];

  return options.positions.flatMap((position, index) => {
    const entryPrice = finite(position.entryPrice);
    const reference = positionReference(position);
    if (entryPrice === null || entryPrice <= 0 || !position.side || !reference) return [];

    const directTrades = trades
      .filter((trade) => trade.positionPubkey?.trim() === reference && trade.side === position.side)
      .filter((trade) => timestampSeconds(trade.createdAt ?? trade.lastUpdated) !== null)
      .sort((left, right) => (
        timestampSeconds(left.createdAt ?? left.lastUpdated)! - timestampSeconds(right.createdAt ?? right.lastUpdated)!
      ));
    const lastFullCloseIndex = directTrades.reduce(
      (lastIndex, trade, tradeIndex) => isFullCloseTrade(trade) ? tradeIndex : lastIndex,
      -1
    );

    const activeStatuses = new Set(["submitted", "confirmed"]);
    const directExecutions = executions
      .filter((execution) => (
        execution.positionPubkey?.trim() === reference
        && execution.side === position.side
          && activeStatuses.has(execution.status ?? "")
      ));
    const positionAsset = marketAsset(position.marketSymbol);
    const fallbackExecutions = directExecutions.length > 0
      ? directExecutions
      : executions.filter((execution) => (
          positionAsset.length > 0
          && marketAsset(execution.asset) === positionAsset
          && execution.side === position.side
          && activeStatuses.has(execution.status ?? "")
        ));
    const execution = fallbackExecutions
      .filter((candidate) => timestampSeconds(candidate.createdAt) !== null)
      .sort((left, right) => timestampSeconds(right.createdAt)! - timestampSeconds(left.createdAt)!)[0]
      ?? null;
    const executionTime = timestampSeconds(execution?.createdAt);
    const openingTrade = directTrades.slice(lastFullCloseIndex + 1).find((trade) => {
      if (!isOpeningTrade(trade)) return false;
      const tradeTime = timestampSeconds(trade.createdAt ?? trade.lastUpdated);
      return tradeTime !== null && (executionTime === null || tradeTime >= executionTime - 5 * 60);
    }) ?? null;
    const time = timestampSeconds(openingTrade?.createdAt ?? openingTrade?.lastUpdated)
      ?? executionTime;
    if (time === null) return [];

    return [{
      id: `${position.id}:entry:${time}`,
      label: options.positions.length > 1 ? `${index + 1} Entry` : "Entry",
      positionId: position.id,
      price: entryPrice,
      side: position.side,
      time,
    }];
  });
}

function projectedNetPnl(position: PositionGuideSource, targetPrice: number) {
  const markPrice = finite(position.markPrice);
  const positionSize = finite(position.positionSize);
  const unrealizedPnl = finite(position.unrealizedPnl);
  if (markPrice === null || positionSize === null || positionSize <= 0 || unrealizedPnl === null) {
    return null;
  }

  const pnlPerPriceUnit = position.side === "short" ? -positionSize : positionSize;
  const estimate = estimatePositionNetExitPnl(position);
  return estimate ? Number((estimate.estimatedNetPnlUsd + (targetPrice - markPrice) * pnlPerPriceUnit).toFixed(2)) : null;
}

export function summarizePositionOverlayPnl(
  positions: readonly PositionGuideSource[]
) {
  if (positions.length === 0) return null;

  const pnlValues = positions
    .map((position) => position.unrealizedPnl)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));

  if (pnlValues.length === 0) return null;
  return Number(pnlValues.reduce((sum, value) => sum + value, 0).toFixed(2));
}

export function summarizePositionOverlayPnlPercent(
  positions: readonly PositionGuideSource[]
) {
  const positionsWithPnl = positions.filter(
    (position) => typeof position.unrealizedPnl === "number" && Number.isFinite(position.unrealizedPnl)
  );
  if (positionsWithPnl.length === 0) return null;
  if (positionsWithPnl.some(
    (position) => typeof position.collateralValue !== "number"
      || !Number.isFinite(position.collateralValue)
      || position.collateralValue <= 0
  )) return null;

  const totalPnl = positionsWithPnl.reduce((sum, position) => sum + (position.unrealizedPnl ?? 0), 0);
  const totalCollateral = positionsWithPnl.reduce((sum, position) => sum + (position.collateralValue ?? 0), 0);
  return Number(((totalPnl / totalCollateral) * 100).toFixed(2));
}

export function buildPositionOverlayGuides(
  positions: readonly PositionGuideSource[]
): PositionOverlayGuide[] {
  const guides: PositionOverlayGuide[] = [];

  positions.forEach((position, index) => {
    const labelPrefix = positions.length > 1 ? `${index + 1} ` : "";
    const levels = [
      { suffix: "entry", label: "Entry", price: position.entryPrice, tone: "entry", kind: null },
      { suffix: "tp", label: "TP", price: position.takeProfit, tone: "tp", kind: "tp" },
      {
        suffix: "liquidation",
        label: "Liq",
        price: position.liquidationPrice,
        tone: "liquidation",
        kind: null,
      },
      { suffix: "sl", label: "SL", price: position.stopLoss, tone: "sl", kind: "sl" },
    ] as const;

    levels.forEach((level) => {
      if (typeof level.price !== "number" || !Number.isFinite(level.price) || level.price <= 0) {
        return;
      }
      guides.push({
        ...(level.kind
          ? {
              editable: true,
              estimatedNetPnlUsd: projectedNetPnl(position, level.price),
              kind: level.kind,
              pnlPerPriceUnit:
                typeof position.positionSize === "number" && Number.isFinite(position.positionSize)
                  ? (position.side === "short" ? -position.positionSize : position.positionSize)
                  : null,
              positionId: position.id,
            }
          : {}),
        id: `${position.id}-${level.suffix}`,
        label: `${labelPrefix}${level.label}`,
        price: level.price,
        tone: level.tone,
      });
    });
  });

  return guides;
}

export function validOverlayGuides(guides: PositionOverlayGuide[] | undefined) {
  return (guides ?? []).filter(
    (guide): guide is PositionOverlayGuide =>
      Boolean(guide?.id) && Boolean(guide?.label) && Number.isFinite(guide?.price) && guide.price > 0
  );
}

export function projectOverlayGuideNetPnl(guide: PositionOverlayGuide, price: number) {
  if (
    !Number.isFinite(price)
    || typeof guide.estimatedNetPnlUsd !== "number"
    || !Number.isFinite(guide.estimatedNetPnlUsd)
    || typeof guide.pnlPerPriceUnit !== "number"
    || !Number.isFinite(guide.pnlPerPriceUnit)
  ) {
    return null;
  }
  return Number((guide.estimatedNetPnlUsd + (price - guide.price) * guide.pnlPerPriceUnit).toFixed(2));
}
