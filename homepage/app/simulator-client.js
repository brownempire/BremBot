"use client";

import { useEffect, useRef, useState } from "react";

const SIMULATOR_MENU_ITEMS = [
  { href: "https://app.bremlogic.com/signals-bot", label: "Signals Bot" },
];

const DEFAULT_FORM = {
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

const DEFAULT_METRICS = [
  { label: "Final Balance", value: "$0.00" },
  { label: "Total Profit", value: "$0.00" },
  { label: "Trades to Target", value: "—" },
  { label: "Target Hit?", value: "No" },
];

function money(n) {
  return `$${Number(n).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function pct(n) {
  return `${Number(n).toLocaleString(undefined, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  })}%`;
}

function average(arr) {
  if (!arr.length) {
    return 0;
  }

  return arr.reduce((sum, n) => sum + n, 0) / arr.length;
}

function percentile(sortedArr, p) {
  if (!sortedArr.length) {
    return 0;
  }

  const index = (p / 100) * (sortedArr.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);

  if (lower === upper) {
    return sortedArr[lower];
  }

  const weight = index - lower;
  return sortedArr[lower] * (1 - weight) + sortedArr[upper] * weight;
}

function getMargin(config, balance) {
  if (config.reinvest) {
    return balance;
  }

  if (config.customMarginType === "percent") {
    const percentage = Math.max(0, Math.min(100, config.customMarginValue)) / 100;
    return balance * percentage;
  }

  return Math.min(config.customMarginValue, balance);
}

function simulateTrade(config, balance, tradeNumber, randomMode) {
  const start = balance;
  const margin = getMargin(config, balance);
  const position = margin * config.leverage;

  let isWin;

  if (randomMode) {
    isWin = Math.random() < config.winRate;
  } else {
    const cycle = 100;
    const winThreshold = Math.round(config.winRate * cycle);
    isWin = ((tradeNumber - 1) % cycle) < winThreshold;
  }

  let grossPnl;
  let result;

  if (isWin) {
    grossPnl = position * config.takeProfit;
    result = "WIN";
  } else {
    const rawLoss = position * config.stopLoss;
    const maxAllowedLoss = balance * config.maxRisk;
    grossPnl = -Math.min(rawLoss, maxAllowedLoss);
    result = "LOSS";
  }

  const fees = position * (config.openFee + config.closeFee + config.borrowFee);
  const netPnl = grossPnl - fees;
  const endBalance = Math.max(0, balance + netPnl);

  return {
    i: tradeNumber,
    result,
    start,
    margin,
    position,
    grossPnl,
    fees,
    netPnl,
    balance: endBalance,
  };
}

function runPath(config, randomMode) {
  let balance = config.startingBalance;
  const rows = [];
  const balances = [{ trade: 0, balance: config.startingBalance }];
  let tradesToTarget = null;
  let ruined = false;

  for (let i = 1; i <= config.numTrades; i += 1) {
    const row = simulateTrade(config, balance, i, randomMode);
    balance = row.balance;

    const cumulativeProfit = balance - config.startingBalance;

    if (tradesToTarget === null && cumulativeProfit >= config.targetProfit) {
      tradesToTarget = i;
    }

    if (balance <= config.ruinBalance) {
      ruined = true;
    }

    rows.push(row);
    balances.push({ trade: i, balance });

    if (tradesToTarget !== null || ruined) {
      break;
    }
  }

  return {
    rows,
    balances,
    finalBalance: balance,
    totalProfit: balance - config.startingBalance,
    tradesToTarget,
    hitTarget: tradesToTarget !== null,
    ruined,
  };
}

function drawBase(ctx, w, h, maxBal, maxTrade, targetBalance) {
  const padL = 75;
  const padR = 25;
  const padT = 25;
  const padB = 55;
  const chartW = w - padL - padR;
  const chartH = h - padT - padB;

  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = "#303746";
  ctx.lineWidth = 1;
  ctx.font = "14px Arial";
  ctx.fillStyle = "#b7b7b7";

  for (let i = 0; i <= 5; i += 1) {
    const y = padT + chartH - (i / 5) * chartH;
    const value = (maxBal * i) / 5;

    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(w - padR, y);
    ctx.stroke();

    ctx.fillText(`$${Math.round(value).toLocaleString()}`, 8, y + 5);
  }

  const ty = padT + chartH - (targetBalance / maxBal) * chartH;
  ctx.strokeStyle = "#ff5c5c";
  ctx.setLineDash([8, 6]);
  ctx.beginPath();
  ctx.moveTo(padL, ty);
  ctx.lineTo(w - padR, ty);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.fillStyle = "#ffb0b0";
  ctx.fillText("Target", w - 80, ty - 8);

  ctx.strokeStyle = "#8a93a6";
  ctx.beginPath();
  ctx.moveTo(padL, padT);
  ctx.lineTo(padL, h - padB);
  ctx.lineTo(w - padR, h - padB);
  ctx.stroke();

  ctx.fillStyle = "#d6d6d6";
  ctx.fillText("Trade Number", w / 2 - 40, h - 15);

  ctx.save();
  ctx.translate(20, h / 2 + 35);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText("Wallet Balance", 0, 0);
  ctx.restore();

  return { padL, padT, chartW, chartH };
}

function drawPath(ctx, data, dims, maxBal, maxTrade, strokeStyle, lineWidth, alpha) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = strokeStyle;
  ctx.lineWidth = lineWidth;
  ctx.beginPath();

  data.forEach((d, idx) => {
    const x = dims.padL + (d.trade / maxTrade) * dims.chartW;
    const y = dims.padT + dims.chartH - (d.balance / maxBal) * dims.chartH;

    if (idx === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  });

  ctx.stroke();
  ctx.restore();
}

export default function SimulatorClient() {
  const [form, setForm] = useState(DEFAULT_FORM);
  const [monteCarloMode, setMonteCarloMode] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [metrics, setMetrics] = useState(DEFAULT_METRICS);
  const [rows, setRows] = useState([]);
  const [logTitle, setLogTitle] = useState("Trade Log");
  const [tableNote, setTableNote] = useState("Simple Mode shows the full deterministic trade path.");
  const [chartNote, setChartNote] = useState(
    "The blue curve shows wallet balance over time. The red dashed line marks the target balance: starting balance plus target profit."
  );
  const [interactiveRuns, setInteractiveRuns] = useState([]);
  const [highlightedRunId, setHighlightedRunId] = useState(null);
  const [tooltip, setTooltip] = useState({ visible: false, html: "", left: 8, top: 8 });

  const canvasRef = useRef(null);
  const chartWrapRef = useRef(null);
  const chartStateRef = useRef(null);
  const menuRef = useRef(null);

  const currentModeLabel = monteCarloMode ? "Monte Carlo Mode" : "Simple Mode";
  const modeBadge = monteCarloMode
    ? "Monte Carlo Mode: random futures + probability testing"
    : "v1 simulator default: Simple Mode";
  const modeNote = monteCarloMode
    ? "Monte Carlo Mode runs many random trade paths and estimates target hit rate, risk of ruin, and average outcome."
    : "Simple Mode uses a clean deterministic win/loss pattern. Example: 70% win rate means about 70 wins per 100 trades in order.";

  const customMarginLabel =
    form.customMarginType === "percent"
      ? "Custom Margin If Not Reinvesting (%)"
      : "Custom Margin If Not Reinvesting ($)";

  let customMarginNote =
    form.customMarginType === "percent"
      ? "Example: 80% means each trade uses 80% of the current wallet balance as margin when reinvesting is off."
      : "Example: $15.55 means each trade uses up to $15.55 as margin when reinvesting is off.";

  if (form.reinvest === "yes") {
    customMarginNote += " Since reinvest is on, the simulator currently uses the full balance as margin.";
  }

  function getConfig() {
    return {
      startingBalance: Number(form.startingBalance),
      leverage: Number(form.leverage),
      winRate: Number(form.winRate) / 100,
      takeProfit: Number(form.takeProfit) / 100,
      stopLoss: Number(form.stopLoss) / 100,
      openFee: Number(form.openFee) / 100,
      closeFee: Number(form.closeFee) / 100,
      borrowFee: Number(form.borrowFee) / 100,
      maxRisk: Number(form.maxRisk) / 100,
      numTrades: Math.max(1, Number(form.numTrades)),
      targetProfit: Number(form.targetProfit),
      reinvest: form.reinvest === "yes",
      customMarginValue: Number(form.customMarginValue),
      customMarginType: form.customMarginType,
      mcRuns: Math.max(1, Number(form.mcRuns)),
      ruinBalance: Number(form.ruinBalance),
      samplePaths: Math.max(1, Number(form.samplePaths)),
    };
  }

  function handleChange(event) {
    const { name, value } = event.target;
    setForm((current) => ({
      ...current,
      [name]: value,
    }));
  }

  function calculateSimple(config) {
    const result = runPath(config, false);

    setMetrics([
      { label: "Final Balance", value: money(result.finalBalance) },
      { label: "Total Profit", value: money(result.totalProfit) },
      { label: "Trades to Target", value: result.tradesToTarget === null ? "Not reached" : result.tradesToTarget },
      { label: "Target Hit?", value: result.hitTarget ? "Yes" : "No" },
    ]);
    setLogTitle("Trade Log");
    setTableNote("Simple Mode shows the full deterministic trade path.");
    setChartNote(
      "The blue curve shows wallet balance over time. The red dashed line marks the target balance: starting balance plus target profit."
    );
    setRows(result.rows);
    setInteractiveRuns([]);
    setHighlightedRunId(null);
    setTooltip({ visible: false, html: "", left: 8, top: 8 });

    chartStateRef.current = {
      mode: "simple",
      data: result.balances,
      targetBalance: config.startingBalance + config.targetProfit,
    };
  }

  function calculateMonteCarlo(config) {
    const runs = Math.max(1, config.mcRuns || 1000);
    const sampleLimit = Math.max(1, config.samplePaths || 50);
    const finalBalances = [];
    let hitCount = 0;
    let ruinCount = 0;
    const tradesToTargetList = [];
    const samplePaths = [];
    let sampleRunForTable = null;

    for (let i = 0; i < runs; i += 1) {
      const result = runPath(config, true);
      finalBalances.push(result.finalBalance);

      if (result.hitTarget) {
        hitCount += 1;
        tradesToTargetList.push(result.tradesToTarget);
      }

      if (result.ruined) {
        ruinCount += 1;
      }

      if (samplePaths.length < sampleLimit) {
        samplePaths.push({
          run: i + 1,
          balances: result.balances,
          finalBalance: result.finalBalance,
          totalProfit: result.totalProfit,
          hitTarget: result.hitTarget,
          tradesToTarget: result.tradesToTarget,
          ruined: result.ruined,
          totalTrades: result.rows.length,
        });
      }

      if (sampleRunForTable === null) {
        sampleRunForTable = result;
      }
    }

    finalBalances.sort((a, b) => a - b);
    tradesToTargetList.sort((a, b) => a - b);

    const medianFinal = percentile(finalBalances, 50);
    const targetHitRate = (hitCount / runs) * 100;
    const ruinRate = (ruinCount / runs) * 100;
    const avgTradesToTarget = tradesToTargetList.length ? average(tradesToTargetList) : null;

    setMetrics([
      { label: "Target Hit Rate", value: pct(targetHitRate) },
      { label: "Risk of Ruin", value: pct(ruinRate) },
      { label: "Median Final Balance", value: money(medianFinal) },
      { label: "Avg Trades to Target", value: avgTradesToTarget === null ? "Not reached" : Math.round(avgTradesToTarget) },
    ]);
    setLogTitle("Sample Monte Carlo Trade Log");
    setTableNote("Monte Carlo table shows one sample random run. The graph shows multiple possible paths.");
    setChartNote(
      "Monte Carlo graph shows sample random equity paths. Hover on web or tap on mobile to inspect a path. Green paths reached the target; blue paths did not."
    );
    setRows(sampleRunForTable ? sampleRunForTable.rows : []);
    setInteractiveRuns(samplePaths);
    setHighlightedRunId(null);
    setTooltip({ visible: false, html: "", left: 8, top: 8 });

    chartStateRef.current = {
      mode: "monteCarlo",
      data: samplePaths,
      targetBalance: config.startingBalance + config.targetProfit,
    };
  }

  function calculate() {
    const config = getConfig();

    if (monteCarloMode) {
      calculateMonteCarlo(config);
    } else {
      calculateSimple(config);
    }
  }

  function getCanvasPoint(eventLike) {
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;

    return {
      canvasX: (eventLike.clientX - rect.left) * scaleX,
      canvasY: (eventLike.clientY - rect.top) * scaleY,
      pageX: eventLike.clientX - rect.left,
      pageY: eventLike.clientY - rect.top,
    };
  }

  function findNearestRun(x, y) {
    let nearest = null;

    interactiveRuns.forEach((run) => {
      run.screenPoints.forEach((point) => {
        const dx = x - point.x;
        const dy = y - point.y;
        const distance = Math.sqrt(dx * dx + dy * dy);

        if (!nearest || distance < nearest.distance) {
          nearest = { run, point, distance };
        }
      });
    });

    return nearest;
  }

  function showTooltip(run, point, pageX, pageY) {
    const wrap = chartWrapRef.current;
    const tooltipWidth = 230;
    const tooltipHeight = 150;
    const statusText = run.hitTarget ? "Reached Target" : run.ruined ? "Ruined" : "Did Not Reach Target";
    const statusClass = run.hitTarget ? "good" : "bad";

    let left = pageX + 14;
    let top = pageY + 14;

    if (left + tooltipWidth > wrap.getBoundingClientRect().width) {
      left = pageX - tooltipWidth - 14;
    }

    if (top + tooltipHeight > wrap.getBoundingClientRect().height) {
      top = pageY - tooltipHeight - 14;
    }

    setTooltip({
      visible: true,
      left: Math.max(8, left),
      top: Math.max(8, top),
      html: `
        <strong>Monte Carlo Run #${run.run}</strong>
        <div>Status: <span class="${statusClass}">${statusText}</span></div>
        <div>Hovered trade: ${point.trade}</div>
        <div>Balance at this point: ${money(point.balance)}</div>
        <div>Final balance: ${money(run.finalBalance)}</div>
        <div>Total profit: ${money(run.totalProfit)}</div>
        <div>Trades in run: ${run.totalTrades}</div>
        <div>Trades to target: ${run.tradesToTarget === null ? "Not reached" : run.tradesToTarget}</div>
      `,
    });
  }

  function handleChartPointer(eventLike, sticky) {
    const point = getCanvasPoint(eventLike);
    const nearest = findNearestRun(point.canvasX, point.canvasY);

    if (!nearest || nearest.distance > 24) {
      if (!sticky) {
        setHighlightedRunId(null);
        setTooltip((current) => ({ ...current, visible: false }));
      }
      return;
    }

    setHighlightedRunId(nearest.run.run);
    showTooltip(nearest.run, nearest.point, point.pageX, point.pageY);
  }

  function navigateTo(href) {
    setMenuOpen(false);
    if (typeof window !== "undefined") {
      window.location.assign(href);
    }
  }

  useEffect(() => {
    calculate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [monteCarloMode]);

  useEffect(() => {
    calculate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onPointerDown = (event) => {
      if (!menuRef.current) {
        return;
      }

      if (menuRef.current.contains(event.target)) {
        return;
      }

      setMenuOpen(false);
    };

    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !chartStateRef.current) {
      return;
    }

    const ctx = canvas.getContext("2d");
    const w = canvas.width;
    const h = canvas.height;
    const state = chartStateRef.current;

    if (state.mode === "simple") {
      const maxBal = Math.max(...state.data.map((d) => d.balance), state.targetBalance) * 1.05;
      const maxTrade = Math.max(...state.data.map((d) => d.trade), 1);
      const dims = drawBase(ctx, w, h, maxBal, maxTrade, state.targetBalance);
      drawPath(ctx, state.data, dims, maxBal, maxTrade, "#4f7cff", 3, 1);
      return;
    }

    const allPoints = state.data.flatMap((path) => path.balances);
    const maxBal = Math.max(...allPoints.map((d) => d.balance), state.targetBalance) * 1.05;
    const maxTrade = Math.max(...allPoints.map((d) => d.trade), 1);
    const dims = drawBase(ctx, w, h, maxBal, maxTrade, state.targetBalance);

    const enrichedRuns = state.data.map((pathObj) => {
      const hit = pathObj.hitTarget;
      const color = hit ? "#38d996" : "#4f7cff";

      const screenPoints = pathObj.balances.map((point) => ({
        trade: point.trade,
        balance: point.balance,
        x: dims.padL + (point.trade / maxTrade) * dims.chartW,
        y: dims.padT + dims.chartH - (point.balance / maxBal) * dims.chartH,
      }));

      return {
        ...pathObj,
        color,
        screenPoints,
      };
    });

    enrichedRuns.forEach((run) => {
      const isHighlighted = run.run === highlightedRunId;

      if (!isHighlighted) {
        drawPath(ctx, run.balances, dims, maxBal, maxTrade, run.color, run.hitTarget ? 2.2 : 1.4, run.hitTarget ? 0.55 : 0.2);
      }
    });

    const highlightedRun = enrichedRuns.find((run) => run.run === highlightedRunId);

    if (highlightedRun) {
      drawPath(ctx, highlightedRun.balances, dims, maxBal, maxTrade, "#00aaff", 5, 1);
      ctx.save();
      ctx.fillStyle = "#00aaff";
      highlightedRun.screenPoints.forEach((point, index) => {
        if (index % 3 === 0 || index === highlightedRun.screenPoints.length - 1) {
          ctx.beginPath();
          ctx.arc(point.x, point.y, 3.5, 0, Math.PI * 2);
          ctx.fill();
        }
      });
      ctx.restore();
    }

    setInteractiveRuns(enrichedRuns);
  }, [highlightedRunId, rows]);

  return (
    <main className="simulator-page">
      <div className="simulator-shell">
        <div ref={menuRef} className="simulator-menu">
          <button
            type="button"
            className={`simulator-menu-button ${menuOpen ? "open" : ""}`}
            aria-expanded={menuOpen}
            aria-label={menuOpen ? "Close menu" : "Open menu"}
            onClick={() => setMenuOpen((current) => !current)}
          >
            <span className="simulator-menu-icon" aria-hidden="true">
              <span className="simulator-menu-line simulator-menu-line-top" />
              <span className="simulator-menu-line simulator-menu-line-bottom" />
            </span>
          </button>
          {menuOpen ? (
            <div className="simulator-menu-dropdown">
              {SIMULATOR_MENU_ITEMS.map((item) => (
                <button
                  type="button"
                  key={item.href}
                  className="simulator-menu-link"
                  onPointerDown={() => navigateTo(item.href)}
                >
                  {item.label}
                </button>
              ))}
            </div>
          ) : null}
        </div>

        <div className="simulator-topbar">
          <div className="simulator-hero-copy">
            <img className="hero-logo simulator-hero-logo" src="/header-photo.png" alt="BremLogic" />
            <h1>BremLogic Jupiter Perps Simulator</h1>
            <p className="simulator-sub">
              Test leveraged perps compounding with wallet growth, leverage, take profit, stop
              loss, fees, reinvesting, and Monte Carlo risk testing.
            </p>
          </div>

          <div className="mode-wrap">
            <div className="switch-row" title="Monte Carlo Mode">
              <span className="mode-name">Simple Mode</span>
              <label className="switch" aria-label="Toggle Monte Carlo Mode">
                <input
                  checked={monteCarloMode}
                  onChange={() => setMonteCarloMode((current) => !current)}
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
            <div className="badge">{modeBadge}</div>

            <label htmlFor="startingBalance">Starting Balance ($)</label>
            <input id="startingBalance" name="startingBalance" onChange={handleChange} type="number" value={form.startingBalance} />

            <label htmlFor="leverage">Leverage</label>
            <input id="leverage" name="leverage" onChange={handleChange} type="number" value={form.leverage} />

            <label htmlFor="winRate">Win Rate (%)</label>
            <input id="winRate" name="winRate" onChange={handleChange} type="number" value={form.winRate} />

            <label htmlFor="takeProfit">Take Profit Price Move (%)</label>
            <input id="takeProfit" name="takeProfit" onChange={handleChange} type="number" value={form.takeProfit} />

            <label htmlFor="stopLoss">Stop Loss Price Move (%)</label>
            <input id="stopLoss" name="stopLoss" onChange={handleChange} type="number" value={form.stopLoss} />

            <label htmlFor="openFee">Open Fee (%)</label>
            <input id="openFee" name="openFee" onChange={handleChange} type="number" value={form.openFee} />

            <label htmlFor="closeFee">Close Fee (%)</label>
            <input id="closeFee" name="closeFee" onChange={handleChange} type="number" value={form.closeFee} />

            <label htmlFor="borrowFee">Borrow / Funding Fee Per Trade (%)</label>
            <input id="borrowFee" name="borrowFee" onChange={handleChange} type="number" value={form.borrowFee} />

            <label htmlFor="maxRisk">Max Wallet Risk Per Losing Trade (%)</label>
            <input id="maxRisk" name="maxRisk" onChange={handleChange} type="number" value={form.maxRisk} />

            <label htmlFor="numTrades">Number of Trades</label>
            <input id="numTrades" name="numTrades" onChange={handleChange} type="number" value={form.numTrades} />

            <label htmlFor="targetProfit">Target Profit ($)</label>
            <input id="targetProfit" name="targetProfit" onChange={handleChange} type="number" value={form.targetProfit} />

            <label htmlFor="reinvest">Reinvest Full Balance?</label>
            <select id="reinvest" name="reinvest" onChange={handleChange} value={form.reinvest}>
              <option value="yes">Yes</option>
              <option value="no">No, use custom margin</option>
            </select>

            <label htmlFor="customMarginValue">{customMarginLabel}</label>
            <div className="inline-pair">
              <input
                id="customMarginValue"
                name="customMarginValue"
                onChange={handleChange}
                type="number"
                value={form.customMarginValue}
              />
              <select
                id="customMarginType"
                name="customMarginType"
                onChange={handleChange}
                value={form.customMarginType}
              >
                <option value="percent">% of account</option>
                <option value="dollar">$ amount</option>
              </select>
            </div>

            <div className="note">{customMarginNote}</div>

            {monteCarloMode ? (
              <div className="advanced active">
                <label htmlFor="mcRuns">Monte Carlo Runs</label>
                <input id="mcRuns" name="mcRuns" onChange={handleChange} type="number" value={form.mcRuns} />

                <label htmlFor="ruinBalance">Ruin Balance ($)</label>
                <input id="ruinBalance" name="ruinBalance" onChange={handleChange} type="number" value={form.ruinBalance} />

                <label htmlFor="samplePaths">Sample Paths On Graph</label>
                <input id="samplePaths" name="samplePaths" onChange={handleChange} type="number" value={form.samplePaths} />
              </div>
            ) : null}

            <button onClick={calculate} type="button">
              Calculate
            </button>

            <div className="note">{modeNote}</div>
          </div>

          <div className="simulator-results-column">
            <div className="simulator-card">
              <h2>Results</h2>

              <div className="summary">
                {metrics.map((metric) => (
                  <div className="metric" key={metric.label}>
                    <div className="label">{metric.label}</div>
                    <div className="value">{metric.value}</div>
                  </div>
                ))}
              </div>

              <div className="chart-wrap" ref={chartWrapRef}>
                <canvas
                  height="420"
                  onClick={(event) => {
                    if (monteCarloMode) {
                      handleChartPointer(event, true);
                    }
                  }}
                  onMouseLeave={() => {
                    if (monteCarloMode) {
                      setHighlightedRunId(null);
                      setTooltip((current) => ({ ...current, visible: false }));
                    }
                  }}
                  onMouseMove={(event) => {
                    if (monteCarloMode) {
                      handleChartPointer(event, false);
                    }
                  }}
                  onTouchStart={(event) => {
                    if (monteCarloMode) {
                      event.preventDefault();
                      handleChartPointer(event.touches[0], true);
                    }
                  }}
                  ref={canvasRef}
                  width="900"
                />
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
                        <td>{money(row.start)}</td>
                        <td>{money(row.margin)}</td>
                        <td>{money(row.position)}</td>
                        <td>{money(row.grossPnl)}</td>
                        <td>{money(row.fees)}</td>
                        <td>{money(row.netPnl)}</td>
                        <td>{money(row.balance)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="note">{tableNote}</div>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
