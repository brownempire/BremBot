# TradingView Strategy Factors vs. BremLogic

Date: 2026-07-22

Status: research only. No production strategy, application, or deployment configuration was changed.

## Question

Test whether the useful ideas in the supplied `SOL Spot Trend Scalper`—EMA 20/50 trend filtering, crossover timing, asymmetric long/short filtering, and ATR-based exits—improve the current aggressive BremLogic SOL candidate.

## Frozen BremLogic control

- 145-minute trend window
- 1.65% trend threshold
- 0.35% breakout
- 7.5-hour cooldown
- 10% take profit / 10% stop loss (ROE)
- Dynamic 2–4x leverage
- 68% minimum confidence
- 3% target wallet risk
- 80% maximum wallet allocation
- Existing SOL and BTC 1-hour and 4-hour EMA 8/21 confirmations

All headline comparisons below use a $100 starting balance and the stress-cost model: 10 bps slippage, 5 bps price impact, $0.10 network cost per transaction, and 3x the observed borrow-rate assumption.

## Headline results

| Variant | Recent 12m | Recent 18.5m | Older 2021-06-18–2024-12-31 |
|---|---:|---:|---:|
| BremLogic control | +64.57% | +155.77% | +6.24% |
| Add hard EMA 20/50 alignment | +32.78% | +106.43% | +170.93% |
| EMA crossover within 4 hours | +15.62% | -2.48% | +3.54% |
| EMA crossover within 8 hours | +8.48% | -9.70% | -8.73% |
| Long-only | -3.34% | +8.05% | -49.02% |
| ATR 1.5x stop / 3x target | -24.25% | -29.47% | -55.41% |
| ATR 2x stop / 3x target | -25.15% | -30.47% | -62.59% |
| ATR 1.5x stop / 2.5x target | -17.77% | -21.81% | -55.60% |
| Bounded ATR (7–15% SL, 10–20% TP) | +23.31% | +70.91% | -27.63% |
| ATR with 10% SL floor | +31.72% | +104.64% | +12.62% |

The control would turn $100 into approximately $164.57 over the recent 12-month window and $255.77 over the recent 18.5-month window under stress costs. Hard EMA alignment would instead end near $132.78 and $206.43, respectively. On the older window, hard alignment ends near $270.93 versus $106.24 for the control.

## Quality and risk comparison

| Period | Variant | Trades | Win rate | Profit factor | Max drawdown |
|---|---|---:|---:|---:|---:|
| Recent 12m | Control | 25 | 72.00% | 2.33 | 17.93% |
| Recent 12m | EMA-aligned | 23 | 65.22% | 1.67 | 25.31% |
| Recent 18.5m | Control | 44 | 72.73% | 2.45 | 16.32% |
| Recent 18.5m | EMA-aligned | 42 | 69.05% | 1.98 | 21.18% |
| Older | Control | 138 | 53.62% | 1.02 | 44.81% |
| Older | EMA-aligned | 121 | 60.33% | 1.34 | 31.02% |

## Bootstrap sequence test

Stationary circular block bootstrap, 20,000 iterations, five-trade blocks. This measures uncertainty from rearranging the historical trade sequence; it is not a forecast.

| Period | Variant | Median return | 95% return interval | Chance return ≤ 0 | Median / 95th-pct drawdown |
|---|---|---:|---:|---:|---:|
| Recent 12m | Control | +65.38% | +5.17% to +151.04% | 1.46% | 12.03% / 20.06% |
| Recent 12m | EMA-aligned | +32.70% | -15.84% to +111.80% | 14.45% | 16.25% / 28.33% |
| Older | Control | +7.05% | -65.81% to +221.14% | 45.15% | 45.41% / 70.60% |
| Older | EMA-aligned | +172.64% | -9.86% to +687.05% | 3.83% | 31.12% / 50.86% |

## Findings

1. The current BremLogic control remains the strongest recent-profit configuration. None of the imported TradingView factors increased its recent total profit under stress costs.
2. Hard EMA 20/50 alignment is the only imported factor with a compelling robustness benefit. It sacrificed about half of the recent 12-month profit, but transformed the older-period result from nearly flat (+6.24%) to strongly positive (+170.93%), improved older win rate, and cut older maximum drawdown by roughly 13.8 percentage points.
3. Requiring a *fresh* EMA crossover is too restrictive. It reduced the sample to 3–11 trades in recent tests and was unstable or negative outside the 12-month slice.
4. Long-only is decisively unsuitable. SOL short participation was essential across the tested regimes.
5. The TradingView-style ATR brackets are too tight for this leveraged, delayed-confirmation engine. Locking ATR at entry fixed the script's moving-exit flaw, but did not fix performance. Floors and bounds helped, yet still failed to beat the existing 10%/10% ROE exits.
6. A proposed soft EMA override did not create a useful middle ground: misaligned signals that survived BremLogic's other filters already carried the engine's maximum indicator score, so the override reproduced the unfiltered control.

## Decision

Keep the current BremLogic control as the profit-seeking base. Do not import the TradingView ATR exits, long-only behavior, or fresh-crossover requirement.

Treat EMA 20/50 alignment as a possible regime-risk control—not as a permanent hard entry rule yet. The evidence suggests it may protect older/choppier regimes, but it reduced both recent profit and recent statistical quality. A future walk-forward study can test whether an independently defined regime switch can enable alignment only when broader conditions warrant it, without selecting the switch from these same evaluated periods.

## Limitations

- Historical results are not guaranteed future returns.
- The recent samples contain only 25–44 trades, so estimates remain uncertain.
- The older data was previously inspected during strategy research and is therefore validation evidence, not a pristine untouched holdout.
- Candle-level execution cannot reproduce order-book liquidity, intrabar path, outages, failed transactions, liquidations between candle observations, or every Jupiter fee detail.
- Comparing multiple variants creates selection bias; the winning historical variant should not be assumed to be the future winner.
