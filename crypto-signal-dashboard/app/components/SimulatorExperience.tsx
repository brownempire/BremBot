"use client";

import Image from "next/image";
import { useCallback, useEffect, useRef, useState, type ChangeEvent } from "react";

type SimulatorInputs = {
  startingBalance: number;
  leverage: number;
  winRate: number;
  takeProfit: number;
  stopLoss: number;
  openFee: number;
  closeFee: number;
  borrowFee: number;
  maxRisk: number;
  numTrades: number;
  targetProfit: number;
  reinvest: "yes" | "no";
  customMarginValue: number;
  customMarginType: "percent" | "dollar";
  mcRuns: number;
  ruinBalance: number;
  samplePaths: number;
};

type TradeRow = {
  i: number;
  result: "WIN" | "LOSS";
  start: number;
  margin: number;
  position: number;
  grossPnl: number;
  fees: number;
  netPnl: number;
  balance: number;
};

type BalancePoint = {
  trade: number;
  balance: number;
};

type SummaryItem = {
  label: string;
  value: string | number;
};

type SimpleRunResult = {
  rows: TradeRow[];
  balances: BalancePoint[];
  finalBalance: number;
  totalProfit: number;
  tradesToTarget: number | null;
  hitTarget: boolean;
  ruined: boolean;
};

type MonteCarloRunSample = {
  run: number;
  balances: BalancePoint[];
  finalBalance: number;
  totalProfit: number;
  hitTarget: boolean;
  tradesToTarget: number | null;
  ruined: boolean;
  totalTrades: number;
};

type ChartRenderState =
  | { mode: "simple"; data: BalancePoint[]; targetBalance: number }
  | { mode: "monteCarlo"; data: MonteCarloRunSample[]; targetBalance: number };

type ChartPadding = {
  padL: number;
  padT: number;
  chartW: number;
  chartH: number;
};

type TooltipState = {
  visible: boolean;
  html: string;
  left: number;
  top: number;
};

type ScreenPoint = BalancePoint & {
  x: number;
  y: number;
};

type MonteCarloScreenRun = MonteCarloRunSample & {
  color: string;
  screenPoints: ScreenPoint[];
};

type ClosestScreenPoint = {
  run: MonteCarloScreenRun;
  point: ScreenPoint;
  distance: number;
};

type PointerCoordinates = {
  clientX: number;
  clientY: number;
};

type NormalizedSimulatorSettings = {
  startingBalance: number;
  leverage: number;
  winRate: number;
  takeProfit: number;
  stopLoss: number;
  openFee: number;
  closeFee: number;
  borrowFee: number;
  maxRisk: number;
  numTrades: number;
  targetProfit: number;
  reinvest: boolean;
  customMarginValue: number;
  customMarginType: "percent" | "dollar";
  mcRuns: number;
  ruinBalance: number;
  samplePaths: number;
};

const DEFAULT_INPUTS: SimulatorInputs = {
  startingBalance: 15.55,
  leverage: 50,
  winRate: 70,
  takeProfit: 1.5,
  stopLoss: 0.6,
  openFee: 0.06,
  closeFee: 0.06,
  borrowFee: 0.02,
  maxRisk: 30,
  numTrades: 100,
  targetProfit: 10000,
  reinvest: "yes",
  customMarginValue: 80,
  customMarginType: "percent",
  mcRuns: 1000,
  ruinBalance: 1,
  samplePaths: 50,
};

const DEFAULT_SUMMARY: SummaryItem[] = [
  { label: "Final Balance", value: "$0.00" },
  { label: "Total Profit", value: "$0.00" },
  { label: "Trades to Target", value: "—" },
  { label: "Target Hit?", value: "No" },
];

function formatCurrency(value: number) {
  return `$${Number(value).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function formatPercent(value: number) {
  return `${Number(value).toLocaleString(undefined, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  })}%`;
}

function simulateTrades(settings: NormalizedSimulatorSettings, randomize: boolean) {
  let balance = settings.startingBalance;
  const rows: TradeRow[] = [];
  const balances: BalancePoint[] = [{ trade: 0, balance: settings.startingBalance }];
  let tradesToTarget: number | null = null;
  let ruined = false;

  for (let tradeIndex = 1; tradeIndex <= settings.numTrades; tradeIndex += 1) {
    const margin = settings.reinvest
      ? balance
      : settings.customMarginType === "percent"
        ? balance * (Math.max(0, Math.min(100, settings.customMarginValue)) / 100)
        : Math.min(settings.customMarginValue, balance);
    const position = margin * settings.leverage;

    let grossPnl: number;
    let result: "WIN" | "LOSS";
    const isWin = randomize
      ? Math.random() < settings.winRate
      : ((tradeIndex - 1) % 100) < Math.round(100 * settings.winRate);

    if (isWin) {
      grossPnl = position * settings.takeProfit;
      result = "WIN";
    } else {
      grossPnl = -Math.min(position * settings.stopLoss, balance * settings.maxRisk);
      result = "LOSS";
    }

    const fees = position * (settings.openFee + settings.closeFee + settings.borrowFee);
    const netPnl = grossPnl - fees;
    balance = Math.max(0, balance + netPnl);

    if (tradesToTarget === null && balance - settings.startingBalance >= settings.targetProfit) {
      tradesToTarget = tradeIndex;
    }
    if (balance <= settings.ruinBalance) {
      ruined = true;
    }

    rows.push({
      i: tradeIndex,
      result,
      start: tradeIndex === 1 ? settings.startingBalance : balances[balances.length - 1]?.balance ?? settings.startingBalance,
      margin,
      position,
      grossPnl,
      fees,
      netPnl,
      balance,
    });
    balances.push({ trade: tradeIndex, balance });

    if (tradesToTarget !== null || ruined) {
      break;
    }
  }

  return {
    rows,
    balances,
    finalBalance: balance,
    totalProfit: balance - settings.startingBalance,
    tradesToTarget,
    hitTarget: tradesToTarget !== null,
    ruined,
  } satisfies SimpleRunResult;
}

function quantile(values: number[]) {
  if (values.length === 0) return 0;
  const midpoint = 0.5 * (values.length - 1);
  const low = Math.floor(midpoint);
  const high = Math.ceil(midpoint);
  if (low === high) return values[low];
  const ratio = midpoint - low;
  return values[low] * (1 - ratio) + values[high] * ratio;
}

function drawChartAxes(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  maxBalance: number,
  maxTrades: number,
  targetBalance: number
) {
  const chartW = width - 75 - 25;
  const chartH = height - 25 - 55;

  context.clearRect(0, 0, width, height);
  context.strokeStyle = "#303746";
  context.lineWidth = 1;
  context.font = "14px Arial";
  context.fillStyle = "#b7b7b7";

  for (let i = 0; i <= 5; i += 1) {
    const y = 25 + chartH - (i / 5) * chartH;
    const balance = (maxBalance * i) / 5;
    context.beginPath();
    context.moveTo(75, y);
    context.lineTo(width - 25, y);
    context.stroke();
    context.fillText(`$${Math.round(balance).toLocaleString()}`, 8, y + 5);
  }

  const targetY = 25 + chartH - (targetBalance / maxBalance) * chartH;
  context.strokeStyle = "#ff5c5c";
  context.setLineDash([8, 6]);
  context.beginPath();
  context.moveTo(75, targetY);
  context.lineTo(width - 25, targetY);
  context.stroke();
  context.setLineDash([]);
  context.fillStyle = "#ffb0b0";
  context.fillText("Target", width - 80, targetY - 8);

  context.strokeStyle = "#8a93a6";
  context.beginPath();
  context.moveTo(75, 25);
  context.lineTo(75, height - 55);
  context.lineTo(width - 25, height - 55);
  context.stroke();

  context.fillStyle = "#d6d6d6";
  context.fillText("Trade Number", width / 2 - 40, height - 15);
  context.save();
  context.translate(20, height / 2 + 35);
  context.rotate(-Math.PI / 2);
  context.fillText("Wallet Balance", 0, 0);
  context.restore();

  return {
    padL: 75,
    padT: 25,
    chartW,
    chartH,
  } satisfies ChartPadding;
}

function drawBalanceLine(
  context: CanvasRenderingContext2D,
  balances: BalancePoint[],
  padding: ChartPadding,
  maxBalance: number,
  maxTrades: number,
  color: string,
  lineWidth: number,
  alpha: number
) {
  context.save();
  context.globalAlpha = alpha;
  context.strokeStyle = color;
  context.lineWidth = lineWidth;
  context.beginPath();
  balances.forEach((point, index) => {
    const x = padding.padL + (point.trade / maxTrades) * padding.chartW;
    const y = padding.padT + padding.chartH - (point.balance / maxBalance) * padding.chartH;
    if (index === 0) {
      context.moveTo(x, y);
    } else {
      context.lineTo(x, y);
    }
  });
  context.stroke();
  context.restore();
}

export function SimulatorExperience() {
  const [inputs, setInputs] = useState<SimulatorInputs>(DEFAULT_INPUTS);
  const [monteCarloMode, setMonteCarloMode] = useState(false);
  const [summary, setSummary] = useState<SummaryItem[]>(DEFAULT_SUMMARY);
  const [rows, setRows] = useState<TradeRow[]>([]);
  const [logTitle, setLogTitle] = useState("Trade Log");
  const [logNote, setLogNote] = useState("Simple Mode shows the full deterministic trade path.");
  const [chartNote, setChartNote] = useState(
    "The blue curve shows wallet balance over time. The red dashed line marks the target balance: starting balance plus target profit."
  );
  const [sampleRuns, setSampleRuns] = useState<MonteCarloScreenRun[]>([]);
  const [highlightedRun, setHighlightedRun] = useState<number | null>(null);
  const [zoom, setZoom] = useState(1);
  const [tooltip, setTooltip] = useState<TooltipState>({
    visible: false,
    html: "",
    left: 8,
    top: 8,
  });

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const chartWrapRef = useRef<HTMLDivElement | null>(null);
  const chartDataRef = useRef<ChartRenderState | null>(null);

  const currentModeLabel = monteCarloMode ? "Monte Carlo Mode" : "Simple Mode";
  const inputsBadge = monteCarloMode ? "Monte Carlo Mode: random futures + probability testing" : "v1 simulator default: Simple Mode";
  const chartModeNote = monteCarloMode
    ? "Monte Carlo graph shows sample random equity paths. Green paths reached the target; red paths did not. Hover on web or tap on mobile to inspect a path, and use zoom to enlarge the chart while keeping it fitted to the screen."
    : "The blue curve shows wallet balance over time. The red dashed line marks the target balance: starting balance plus target profit.";
  const simpleModeNote = monteCarloMode
    ? "Monte Carlo Mode runs many random trade paths and estimates target hit rate, risk of ruin, and average outcome."
    : "Simple Mode uses a clean deterministic win/loss pattern. Example: 70% win rate means about 70 wins per 100 trades in order.";
  const customMarginLabel = inputs.customMarginType === "percent"
    ? "Custom Margin If Not Reinvesting (%)"
    : "Custom Margin If Not Reinvesting ($)";
  let customMarginNote = inputs.customMarginType === "percent"
    ? "Example: 80% means each trade uses 80% of the current wallet balance as margin when reinvesting is off."
    : "Example: $15.55 means each trade uses up to $15.55 as margin when reinvesting is off.";
  if (inputs.reinvest === "yes") {
    customMarginNote += " Since reinvest is on, the simulator currently uses the full balance as margin.";
  }

  function handleInputChange(event: ChangeEvent<HTMLInputElement | HTMLSelectElement>) {
    const { name, value } = event.target;
    setInputs((current) => ({
      ...current,
      [name]: value,
    }) as SimulatorInputs);
  }

  const calculate = useCallback(() => {
    const normalizedSettings = {
      startingBalance: Number(inputs.startingBalance),
      leverage: Number(inputs.leverage),
      winRate: Number(inputs.winRate) / 100,
      takeProfit: Number(inputs.takeProfit) / 100,
      stopLoss: Number(inputs.stopLoss) / 100,
      openFee: Number(inputs.openFee) / 100,
      closeFee: Number(inputs.closeFee) / 100,
      borrowFee: Number(inputs.borrowFee) / 100,
      maxRisk: Number(inputs.maxRisk) / 100,
      numTrades: Math.max(1, Number(inputs.numTrades)),
      targetProfit: Number(inputs.targetProfit),
      reinvest: inputs.reinvest === "yes",
      customMarginValue: Number(inputs.customMarginValue),
      customMarginType: inputs.customMarginType,
      mcRuns: Math.max(1, Number(inputs.mcRuns)),
      ruinBalance: Number(inputs.ruinBalance),
      samplePaths: Math.max(1, Number(inputs.samplePaths)),
    };

    if (monteCarloMode) {
      const runCount = Math.max(1, normalizedSettings.mcRuns || 1000);
      const samplePathCount = Math.max(1, normalizedSettings.samplePaths || 50);
      const finalBalances: number[] = [];
      let hitCount = 0;
      let ruinedCount = 0;
      const tradesToTarget: number[] = [];
      const sampledRuns: MonteCarloRunSample[] = [];
      let firstResult: SimpleRunResult | null = null;

      for (let runIndex = 0; runIndex < runCount; runIndex += 1) {
        const result = simulateTrades(normalizedSettings, true);
        finalBalances.push(result.finalBalance);
        if (result.hitTarget) {
          hitCount += 1;
          if (result.tradesToTarget !== null) {
            tradesToTarget.push(result.tradesToTarget);
          }
        }
        if (result.ruined) {
          ruinedCount += 1;
        }
        if (sampledRuns.length < samplePathCount) {
          sampledRuns.push({
            run: runIndex + 1,
            balances: result.balances,
            finalBalance: result.finalBalance,
            totalProfit: result.totalProfit,
            hitTarget: result.hitTarget,
            tradesToTarget: result.tradesToTarget,
            ruined: result.ruined,
            totalTrades: result.rows.length,
          });
        }
        if (firstResult === null) {
          firstResult = result;
        }
      }

      finalBalances.sort((left, right) => left - right);
      tradesToTarget.sort((left, right) => left - right);

      const medianBalance = quantile(finalBalances);
      const hitRate = (hitCount / runCount) * 100;
      const ruinRate = (ruinedCount / runCount) * 100;
      const averageTradesToTarget = tradesToTarget.length > 0
        ? tradesToTarget.reduce((sum, trade) => sum + trade, 0) / tradesToTarget.length
        : null;

      setSummary([
        { label: "Target Hit Rate", value: formatPercent(hitRate) },
        { label: "Risk of Ruin", value: formatPercent(ruinRate) },
        { label: "Median Final Balance", value: formatCurrency(medianBalance) },
        { label: "Avg Trades to Target", value: averageTradesToTarget === null ? "Not reached" : Math.round(averageTradesToTarget) },
      ]);
      setLogTitle("Sample Monte Carlo Trade Log");
      setLogNote("Monte Carlo table shows one sample random run. The graph shows multiple possible paths.");
      setChartNote(chartModeNote);
      setRows(firstResult ? firstResult.rows : []);
      setSampleRuns([]);
      setHighlightedRun(null);
      setZoom(1);
      setTooltip({ visible: false, html: "", left: 8, top: 8 });
      chartDataRef.current = {
        mode: "monteCarlo",
        data: sampledRuns,
        targetBalance: normalizedSettings.startingBalance + normalizedSettings.targetProfit,
      };
      return;
    }

    const result = simulateTrades(normalizedSettings, false);
    setSummary([
      { label: "Final Balance", value: formatCurrency(result.finalBalance) },
      { label: "Total Profit", value: formatCurrency(result.totalProfit) },
      { label: "Trades to Target", value: result.tradesToTarget === null ? "Not reached" : result.tradesToTarget },
      { label: "Target Hit?", value: result.hitTarget ? "Yes" : "No" },
    ]);
    setLogTitle("Trade Log");
    setLogNote("Simple Mode shows the full deterministic trade path.");
    setChartNote(chartModeNote);
    setRows(result.rows);
    setSampleRuns([]);
    setHighlightedRun(null);
    setZoom(1);
    setTooltip({ visible: false, html: "", left: 8, top: 8 });
    chartDataRef.current = {
      mode: "simple",
      data: result.balances,
      targetBalance: normalizedSettings.startingBalance + normalizedSettings.targetProfit,
    };
  }, [chartModeNote, inputs, monteCarloMode]);

  function showTooltip(run: MonteCarloScreenRun, point: ScreenPoint, pageX: number, pageY: number) {
    const wrap = chartWrapRef.current;
    if (!wrap) return;
    let left = pageX + 14;
    let top = pageY + 14;
    const wrapRect = wrap.getBoundingClientRect();
    if (left + 230 > wrapRect.width) {
      left = pageX - 230 - 14;
    }
    if (top + 150 > wrapRect.height) {
      top = pageY - 150 - 14;
    }

    const status = run.hitTarget ? "Reached Target" : run.ruined ? "Ruined" : "Did Not Reach Target";
    const statusClass = run.hitTarget ? "good" : "bad";

    setTooltip({
      visible: true,
      left: Math.max(8, left),
      top: Math.max(8, top),
      html: `
        <strong>Monte Carlo Run #${run.run}</strong>
        <div>Status: <span class="${statusClass}">${status}</span></div>
        <div>Hovered trade: ${point.trade}</div>
        <div>Balance at this point: ${formatCurrency(point.balance)}</div>
        <div>Final balance: ${formatCurrency(run.finalBalance)}</div>
        <div>Total profit: ${formatCurrency(run.totalProfit)}</div>
        <div>Trades in run: ${run.totalTrades}</div>
        <div>Trades to target: ${run.tradesToTarget === null ? "Not reached" : run.tradesToTarget}</div>
      `,
    });
  }

  function inspectChartPoint(event: PointerCoordinates, forceTap: boolean) {
    const canvas = canvasRef.current;
    if (!canvas || !monteCarloMode) return;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const canvasX = (event.clientX - rect.left) * scaleX;
    const canvasY = (event.clientY - rect.top) * scaleY;
    const pageX = event.clientX - rect.left;
    const pageY = event.clientY - rect.top;

    let closest: ClosestScreenPoint | null = null;
    sampleRuns.forEach((run) => {
      run.screenPoints.forEach((point) => {
        const deltaX = canvasX - point.x;
        const deltaY = canvasY - point.y;
        const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
        if (!closest || distance < closest.distance) {
          closest = { run, point, distance };
        }
      });
    });

    const nearest = closest as ClosestScreenPoint | null;
    if (!nearest || nearest.distance > 24) {
      if (!forceTap) {
        setHighlightedRun(null);
        setTooltip((current) => ({ ...current, visible: false }));
      }
      return;
    }

    setHighlightedRun(nearest.run.run);
    showTooltip(nearest.run, nearest.point, pageX, pageY);
  }

  useEffect(() => {
    calculate();
  }, [calculate]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const chartData = chartDataRef.current;
    if (!canvas || !chartData) return;

    const context = canvas.getContext("2d");
    if (!context) return;

    const width = canvas.width;
    const height = canvas.height;

    if (chartData.mode === "simple") {
      const maxBalance = Math.max(
        ...chartData.data.map((point) => point.balance),
        chartData.targetBalance
      ) * 1.05;
      const maxTrades = Math.max(...chartData.data.map((point) => point.trade), 1);
      const padding = drawChartAxes(context, width, height, maxBalance, maxTrades, chartData.targetBalance);
      drawBalanceLine(context, chartData.data, padding, maxBalance, maxTrades, "#4f7cff", 3, 1);
      return;
    }

    const allBalances = chartData.data.flatMap((run) => run.balances);
    const maxBalance = Math.max(...allBalances.map((point) => point.balance), chartData.targetBalance) * 1.05;
    const maxTrades = Math.max(...allBalances.map((point) => point.trade), 1);
    const padding = drawChartAxes(context, width, height, maxBalance, maxTrades, chartData.targetBalance);
    const nextRuns = chartData.data.map((run) => {
      const hitTarget = run.hitTarget;
      const screenPoints = run.balances.map((point) => ({
        trade: point.trade,
        balance: point.balance,
        x: padding.padL + (point.trade / maxTrades) * padding.chartW,
        y: padding.padT + padding.chartH - (point.balance / maxBalance) * padding.chartH,
      }));
      return {
        ...run,
        color: hitTarget ? "#38d996" : "#ff6b6b",
        screenPoints,
      } satisfies MonteCarloScreenRun;
    });

    nextRuns.forEach((run) => {
      if (run.run !== highlightedRun) {
        drawBalanceLine(
          context,
          run.balances,
          padding,
          maxBalance,
          maxTrades,
          run.color,
          run.hitTarget ? 2.2 : 1.8,
          run.hitTarget ? 0.55 : 0.42
        );
      }
    });

    const activeRun = nextRuns.find((run) => run.run === highlightedRun);
    if (activeRun) {
      drawBalanceLine(context, activeRun.balances, padding, maxBalance, maxTrades, "#00aaff", 5, 1);
      context.save();
      context.fillStyle = "#00aaff";
      activeRun.screenPoints.forEach((point, index) => {
        if (index % 3 === 0 || index === activeRun.screenPoints.length - 1) {
          context.beginPath();
          context.arc(point.x, point.y, 3.5, 0, 2 * Math.PI);
          context.fill();
        }
      });
      context.restore();
    }

    setSampleRuns(nextRuns);
  }, [highlightedRun, rows, sampleRuns.length, zoom]);

  const chartHeight = Math.round(280 + (zoom - 1) * 120);
  const canvasHeight = Math.round(420 + (zoom - 1) * 160);

  return (
    <div className="simulator-shell">
      <div className="simulator-topbar">
        <div className="simulator-hero-copy">
          <Image
            className="hero-logo simulator-hero-logo"
            src="/bremlogic-logo.png"
            alt="BremLogic"
            width={800}
            height={261}
            priority
          />
          <h1>BremLogic Jupiter Perps Simulator</h1>
          <p className="simulator-sub">
            Test leveraged perps compounding with wallet growth, leverage, take profit, stop loss,
            fees, reinvesting, and Monte Carlo risk testing.
          </p>
        </div>
        <div className="mode-wrap">
          <div className="switch-row" title="Monte Carlo Mode">
            <span className="mode-name">Simple Mode</span>
            <label className="switch" aria-label="Toggle Monte Carlo Mode">
              <input
                checked={monteCarloMode}
                onChange={() => setMonteCarloMode((value) => !value)}
                type="checkbox"
              />
              <span className="slider" />
            </label>
            <span className="mode-name">Monte Carlo</span>
          </div>
          <div className="mode-text">
            Current: <strong>{currentModeLabel}</strong>
          </div>
        </div>
      </div>

      <div className="simulator-grid">
        <div className="simulator-card">
          <h2>Inputs</h2>
          <div className="badge">{inputsBadge}</div>

          <label htmlFor="startingBalance">Starting Balance ($)</label>
          <input id="startingBalance" name="startingBalance" onChange={handleInputChange} type="number" value={inputs.startingBalance} />

          <label htmlFor="leverage">Leverage</label>
          <input id="leverage" name="leverage" onChange={handleInputChange} type="number" value={inputs.leverage} />

          <label htmlFor="winRate">Win Rate (%)</label>
          <input id="winRate" name="winRate" onChange={handleInputChange} type="number" value={inputs.winRate} />

          <label htmlFor="takeProfit">Take Profit Price Move (%)</label>
          <input id="takeProfit" name="takeProfit" onChange={handleInputChange} type="number" value={inputs.takeProfit} />

          <label htmlFor="stopLoss">Stop Loss Price Move (%)</label>
          <input id="stopLoss" name="stopLoss" onChange={handleInputChange} type="number" value={inputs.stopLoss} />

          <label htmlFor="openFee">Open Fee (%)</label>
          <input id="openFee" name="openFee" onChange={handleInputChange} type="number" value={inputs.openFee} />

          <label htmlFor="closeFee">Close Fee (%)</label>
          <input id="closeFee" name="closeFee" onChange={handleInputChange} type="number" value={inputs.closeFee} />

          <label htmlFor="borrowFee">Borrow / Funding Fee Per Trade (%)</label>
          <input id="borrowFee" name="borrowFee" onChange={handleInputChange} type="number" value={inputs.borrowFee} />

          <label htmlFor="maxRisk">Max Wallet Risk Per Losing Trade (%)</label>
          <input id="maxRisk" name="maxRisk" onChange={handleInputChange} type="number" value={inputs.maxRisk} />

          <label htmlFor="numTrades">Number of Trades</label>
          <input id="numTrades" name="numTrades" onChange={handleInputChange} type="number" value={inputs.numTrades} />

          <label htmlFor="targetProfit">Target Profit ($)</label>
          <input id="targetProfit" name="targetProfit" onChange={handleInputChange} type="number" value={inputs.targetProfit} />

          <label htmlFor="reinvest">Reinvest Full Balance?</label>
          <select id="reinvest" name="reinvest" onChange={handleInputChange} value={inputs.reinvest}>
            <option value="yes">Yes</option>
            <option value="no">No, use custom margin</option>
          </select>

          <label htmlFor="customMarginValue">{customMarginLabel}</label>
          <div className="inline-pair">
            <input
              id="customMarginValue"
              name="customMarginValue"
              onChange={handleInputChange}
              type="number"
              value={inputs.customMarginValue}
            />
            <select id="customMarginType" name="customMarginType" onChange={handleInputChange} value={inputs.customMarginType}>
              <option value="percent">% of account</option>
              <option value="dollar">$ amount</option>
            </select>
          </div>

          <div className="note">{customMarginNote}</div>

          {monteCarloMode ? (
            <div className="advanced active">
              <label htmlFor="mcRuns">Monte Carlo Runs</label>
              <input id="mcRuns" name="mcRuns" onChange={handleInputChange} type="number" value={inputs.mcRuns} />

              <label htmlFor="ruinBalance">Ruin Balance ($)</label>
              <input id="ruinBalance" name="ruinBalance" onChange={handleInputChange} type="number" value={inputs.ruinBalance} />

              <label htmlFor="samplePaths">Sample Paths On Graph</label>
              <input id="samplePaths" name="samplePaths" onChange={handleInputChange} type="number" value={inputs.samplePaths} />
            </div>
          ) : null}

          <button onClick={calculate} type="button">Calculate</button>
          <div className="note">{simpleModeNote}</div>
        </div>

        <div className="simulator-results-column">
          <div className="simulator-card">
            <h2>Results</h2>
            <div className="summary">
              {summary.map((item) => (
                <div key={item.label} className="metric">
                  <div className="label">{item.label}</div>
                  <div className="value">{item.value}</div>
                </div>
              ))}
            </div>

            {monteCarloMode ? (
              <div className="chart-toolbar">
                <div className="chart-toolbar-group">
                  <span className="chart-toolbar-label">Graph zoom</span>
                  <button
                    className="chart-zoom-button"
                    disabled={zoom <= 1}
                    onClick={() => setZoom((value) => Math.max(1, Number((value - 0.25).toFixed(2))))}
                    type="button"
                  >
                    -
                  </button>
                  <span className="chart-zoom-value">{Math.round(100 * zoom)}%</span>
                  <button
                    className="chart-zoom-button"
                    disabled={zoom >= 3}
                    onClick={() => setZoom((value) => Math.min(3, Number((value + 0.25).toFixed(2))))}
                    type="button"
                  >
                    +
                  </button>
                  <button
                    className="chart-zoom-reset"
                    disabled={zoom === 1}
                    onClick={() => setZoom(1)}
                    type="button"
                  >
                    Reset
                  </button>
                </div>
              </div>
            ) : null}

            <div className="chart-wrap" ref={chartWrapRef}>
              <div className="chart-scroll">
                <canvas
                  ref={canvasRef}
                  width={900}
                  height={canvasHeight}
                  style={{ width: "100%", height: `min(${chartHeight}px, 62vh)` }}
                  onMouseMove={(event) => {
                    if (monteCarloMode) inspectChartPoint(event.nativeEvent, false);
                  }}
                  onMouseLeave={() => {
                    if (monteCarloMode) {
                      setHighlightedRun(null);
                      setTooltip((current) => ({ ...current, visible: false }));
                    }
                  }}
                  onClick={(event) => {
                    if (monteCarloMode) inspectChartPoint(event.nativeEvent, true);
                  }}
                  onTouchStart={(event) => {
                    if (!monteCarloMode) return;
                    event.preventDefault();
                    const touch = event.touches[0];
                    if (touch) inspectChartPoint(touch, true);
                  }}
                />
              </div>
              <div
                className="chart-tooltip"
                dangerouslySetInnerHTML={{ __html: tooltip.html }}
                style={{
                  display: tooltip.visible ? "block" : "none",
                  left: `${tooltip.left}px`,
                  top: `${tooltip.top}px`,
                }}
              />
            </div>
            <div className="note">{chartNote}</div>
          </div>

          <div className="simulator-card">
            <h2>{logTitle}</h2>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Trade</th>
                    <th>Result</th>
                    <th>Start</th>
                    <th>Margin</th>
                    <th>Position</th>
                    <th>Gross PnL</th>
                    <th>Fees</th>
                    <th>Net PnL</th>
                    <th>End</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.i}>
                      <td>{row.i}</td>
                      <td>{row.result}</td>
                      <td>{formatCurrency(row.start)}</td>
                      <td>{formatCurrency(row.margin)}</td>
                      <td>{formatCurrency(row.position)}</td>
                      <td>{formatCurrency(row.grossPnl)}</td>
                      <td>{formatCurrency(row.fees)}</td>
                      <td>{formatCurrency(row.netPnl)}</td>
                      <td>{formatCurrency(row.balance)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="note">{logNote}</div>
          </div>
        </div>
      </div>
    </div>
  );
}
