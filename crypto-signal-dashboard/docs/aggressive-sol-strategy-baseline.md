# BremLogic Aggressive SOL Strategy Baseline

Status: Research baseline for later implementation
Recorded: July 20, 2026
Production status: Not implemented

## Purpose

This document preserves the strongest aggressive SOL parameter combination identified by the historical backtests completed through July 20, 2026. It is intended to become the starting profile for BremLogic's learning engine after a separate implementation and production-validation pass.

The profile favors profitability over conservative capital preservation, while avoiding the additional instability observed with a permanent 4% target-wallet-risk setting.

## Recommended parameter combination

| Parameter | Setting |
|---|---:|
| Primary asset | SOL |
| Trend window | 145 minutes |
| Trend threshold | 1.65% |
| Breakout threshold | 0.35% |
| Signal cooldown | 27,000 seconds (7.5 hours) |
| Maximum wallet allocation | 80% |
| Target wallet risk | 3% |
| Take profit | 10% ROE |
| Stop loss | 10% ROE |
| Leverage | Dynamic 2x–4x |
| Minimum signal confidence | 0.68 |
| Indicator lookback | 900 minutes |
| Stop-loss cooldown | 27,000 seconds (7.5 hours) |
| Indicators | Enabled |
| Learned confirmation | Enabled |
| Decision layer | Enabled |
| Source candle resolution | 1 minute |

### Dynamic leverage controls

| Control | Setting |
|---|---:|
| Minimum leverage | 2x |
| Maximum leverage | 4x |
| Quality exponent | 2.5 |
| Volatility penalty | 1.25 |
| Loss stepdown | 1 |

The 80% wallet allocation is a ceiling, not an instruction to deploy 80% on every trade. Actual collateral should be constrained by the 3% target-wallet-risk calculation, the stop distance, learned allocation adjustment, and all existing execution guardrails.

## Supporting stress-cost results

Results used a $100 starting balance and included stress-adjusted trading and borrowing costs.

| Evaluation period | Return | Ending balance | Maximum drawdown | Win rate | Profit factor | Trades |
|---|---:|---:|---:|---:|---:|---:|
| Recent 18.5 months | +155.77% | $255.77 | 16.32% | 72.73% | 2.45 | 44 |
| Recent 12 months | +64.57% | $164.57 | 17.93% | 72.00% | 2.33 | 25 |
| Older 43 months | +6.24% | $106.24 | 44.81% | 53.62% | 1.02 | 138 |

The recent 12-month result corresponds to approximately 4.2% compounded monthly. It does not imply a dependable 64% monthly return.

## Bootstrap validation

The recent samples were evaluated with 20,000 circular block-bootstrap paths using five-trade blocks.

| Evaluation period | Median return | Probability of nonpositive return | 95th-percentile drawdown |
|---|---:|---:|---:|
| Recent 18.5 months | +156.99% | 0.005% | 19.75% |
| Recent 12 months | +65.53% | 1.51% | 19.75% |

Bootstrap results measure sequence uncertainty within the historical trade samples. They do not establish future-market certainty.

## Decisions and boundaries

1. Keep the cooldown at 7.5 hours. Reducing it to 7.2 hours caused the aggressive profiles to lose money in the recent holdout tests.
2. Use 3% target wallet risk for this aggressive baseline. A permanent 4% setting produced higher recent returns but weaker profit factors, higher drawdowns, and almost no stressed edge in the older period.
3. Do not use the previous 50x leverage cap to reproduce these results. This profile was tested with dynamic leverage constrained to 2x–4x.
4. Keep the 1-minute candle source unless a later equivalence test demonstrates that a coarser source preserves signal timing and results.
5. The learning engine may adjust parameters only within separately defined bounds. It should not silently shorten the protected cooldown or raise target risk and leverage beyond their validated limits.
6. Before production activation, rerun the profile against newly accumulated out-of-sample data and verify Jupiter execution behavior, fees, slippage, TP/SL attachment, Redis persistence, and server-side scheduling.

## Complete research record

This strategy decision is the final layer of a much larger research program. The exhaustive, line-by-line report is preserved in [`../research/backtest/REPORT.md`](../research/backtest/REPORT.md). That report is part of this strategy record and must be reviewed with this document before implementation. The following sections consolidate every completed research phase and the conclusions that led to the selected baseline.

### Dataset, execution model, and validation protocol

- Official Coinbase Exchange one-minute OHLCV was collected for SOL, ETH, and BTC from January 1, 2025 through July 2026. The later SOL-only validation was extended backward to June 18, 2021 for older-regime testing.
- The original split used January–October 2025 for training, November 2025–March 2026 for validation, and April–July 2026 as the sealed/later period.
- Later studies used independently reset development folds, continuous 12-month and 18.5-month replays, older half-year regimes, and baseline plus stressed-cost models.
- Signals were normally evaluated on a completed candle and entered at the next available candle open. Signal-close execution was tested separately as a timing sensitivity.
- Intrabar ambiguity was resolved adversely: liquidation before stop loss, and stop loss before take profit when more than one boundary occurred in the same candle.
- Costs included Jupiter entry and exit fees, price impact, observed borrowing costs, and a network allowance. Base-fee-only, conservative, and stress variants were also tested.
- Capital compounded after closed trades, and only one position was open at a time.
- The harness was checked for deterministic replay, future-data isolation, boundary enforcement, strict TypeScript compilation, and repeatable file hashes. The original project suite passed 65 of 65 tests.
- The 20,000-path uncertainty studies used circular five-trade block bootstraps. These preserve short clusters of historical trades but cannot manufacture unseen market regimes.

### Production audit findings discovered before optimization

1. Reused Jupiter position addresses could cause the historical reconciler to attach later exits, fees, and PnL to earlier executions. Existing live training outcomes were therefore not accepted as clean evidence.
2. The learned runtime returned a zero stop loss even while using a nominal stop reference for collateral sizing. A target-wallet-risk label was not an enforceable maximum loss without an attached SL.
3. The decision layer imposed a stronger hidden momentum requirement than the visible trend and breakout fields suggested.
4. Production could consume an incomplete Coinbase minute, while historical OHLCV can only reproduce completed candles reliably.
5. The configured daily-loss percentage was loaded but not enforced by the user-scoped trade guard.
6. Incremental automatic training did not guarantee a fresh chronological holdout test after enough outcomes accumulated.

These findings remain implementation prerequisites. Parameter optimization cannot compensate for contaminated outcomes, missing protection, or unenforced risk controls.

### Original deployed-profile replay

The original configuration used a 15-minute window, approximately 0.14% trend, 0.19% breakout, a three-minute cooldown, an 80% allocation ceiling, no effective stop, and roughly 45x realized leverage from a 50x cap.

| Frozen SOL profile | Training return | Validation return | Sealed return | Sealed drawdown | Sealed trades / liquidations |
|---|---:|---:|---:|---:|---:|
| Active learned 0.149/0.181 | -77.14% | -66.11% | -40.49% | 66.57% | 93 / 14 |
| Visible 0.14/0.19 | -76.20% | -65.91% | -4.26% | 56.42% | 88 / 12 |
| Proposed 0.25/0.25 | -65.92% | -76.63% | -5.82% | 70.04% | 67 / 9 |

The active sealed run won 79 of 93 trades, but all 14 losses were liquidations. The average winner was $4.73 and the average loss was -$30.03. Gross price PnL was positive, but fees, borrowing, and the asymmetric liquidation losses made the net result negative. This established that a high win rate by itself is not a profitable strategy.

### Broad visible-parameter and risk searches

- A 144-combination signal grid varied 5–60-minute windows, 0.10–0.50% trend thresholds, and 0.10–0.40% breakouts. Zero configurations were profitable in both training and validation, and all 12 preselected candidates lost in the sealed period.
- A 144-combination risk grid varied 5–50x leverage, 10–40% TP, and 0.5–2% target risk. Three 5x configurations passed development but all failed sealed testing.
- A 240-combination TP/SL grid varied 3–10x leverage, 5–20% TP, 2–10% SL, and 0.5–1.6% target risk. Zero configurations were profitable in both training and validation.
- A wider 512-configuration joint search expanded to 5–180-minute windows, thresholds up to 10%, breakouts up to 8%, cooldowns from five to 900 seconds, 2–125x leverage, 5–50% TP, and 0.25–5% target risk. Seven candidates were positive across development folds, but forward samples were sparse and drawdowns remained excessive.

The early leading no-stop family—10-minute window, 0.15% trend, 0.65% breakout, five-minute cooldown, roughly 2x leverage, 15% TP, and 0.75% risk—was rejected because its forward samples contained only a few trades and worst drawdown reached 56.92%.

### Stop-loss and post-stop cooldown research

- A 384-sample local stop study tested 8–25% SL. Thirteen configurations were positive in contiguous SOL development and forward periods, but none stayed below the 35% drawdown ceiling in both.
- A fixed 15% SL did not generalize. With a 25% TP it increased the SOL development run from 19 trades without a stop to 112 trades, including 79 stop-outs, and returned -94.49%.
- Post-stop lockouts of 5, 15, 30, 45, and 60 minutes and 2, 3, 4, 8, 12, and 24 hours were tested. No fixed lockout was profitable and controlled across SOL, ETH, and BTC development/forward segments.
- Two- and four-hour lockouts were less bad than many shorter choices, while the exact three-hour result was sharply worse. This demonstrated that cooldown outcomes do not interpolate smoothly.
- The current high-leverage engine was separately swept across 3–50% SL. Stops reduced liquidations but increased repeated entries into normal noise; no SL repaired the architecture.

The conclusion was that a stop must be paired with lower leverage, stronger entries, and a meaningful re-entry lockout or fresh-regime requirement.

### Multi-timeframe and cross-asset studies

- Completed 15-minute SOL entry candles, 1-hour direction, and optional 4-hour regimes were tested without higher-timeframe lookahead.
- A simple 1-hour EMA confirmation improved aggregate results relative to 15-minute-only signals. Adding a rigid 4-hour filter increased the number of positive segments but did not produce consistent profitability.
- A 384-candidate multi-timeframe search varied 45–180-minute lookbacks, thresholds, 30-minute to three-hour cooldowns, and EMA(5/13), EMA(9/21), and EMA(12/26). Five configurations survived four SOL development folds, but all lost in the later SOL period.
- Joint reranking across 12 SOL/ETH/BTC development folds produced no universally profitable candidate. SOL and BTC often shared broad direction, but their volatility, entries, and stop frequency differed enough that SOL results could not simply be assumed to transfer.
- BTC confirmation remained useful as a non-traded market-regime input for later SOL-specific studies.

### SOL-specialized and joint risk searches

A 1,024-candidate SOL study found an initially promising 120-minute/0.65%/0.50% profile with SOL 1-hour EMA(5/13), BTC 1-hour and 4-hour confirmation, a two-hour cooldown, 25% TP, 15% SL, and approximately 2x leverage. A later correction showed that its original replay had not propagated the fixed stop consistently into collateral sizing, so the stricter joint-search result superseded it.

A subsequent 4,096-candidate joint search varied signal window, thresholds, cooldown, EMA confirmation, TP, SL, leverage, and wallet risk together. A 2,048-candidate local refinement then identified a stronger shadow candidate:

- 90-minute window, 1.00% trend, and 0.80% breakout
- SOL 1-hour EMA(8/21) and BTC 1-hour plus 4-hour EMA(8/21)
- three-hour cooldown and post-stop lockout
- 20% TP, 7% SL, 2.5x leverage, and 0.75% target risk

It remained positive in development and later cost-stress tests with zero liquidations, but its weakest development stress return was only +0.80%, so it was retained as research rather than promoted.

### 20x leverage and wider-stop rejection

Changing only the selected 2.5x profile to approximately 18.84x realized leverage made every period negative. The continuous $1,000 stressed run lost 92.89%. SL values from no stop through 90% ROE were tested; none restored profitability. Wider stops reduced the number of stop-outs but increased loss size and eventually allowed liquidations to return.

This rejected the hypothesis that high leverage merely needed more stop-loss breathing room. At that leverage, ordinary SOL movement and transaction costs overwhelmed the signal edge.

### Capital-preservation search

A separate 4,096-candidate study emphasized positive stressed returns and low drawdown. At a $100 starting balance:

| Profile | Risk settings | Baseline ending value | Stress ending value | Stress drawdown |
|---|---|---:|---:|---:|
| Conservative | 1.25x, TP 10%, SL 7%, 4h cooldown | $113.45 | $106.65 | 6.39% |
| Balanced | 2x, TP 25%, SL 7%, 6h cooldown | $141.62 | $111.95 | 12.72% |
| Higher return | 3x, TP 7%, SL 15%, 3h cooldown | $158.25 | $119.13 | 14.62% |

These profiles established that lower leverage and slower turnover could preserve capital, but they did not meet the requested growth objective.

### Search for 50–100% monthly ROI

A 4,096-candidate search explicitly targeted a stressed median month of at least +50%, a nonnegative worst month, and no more than 40% drawdown. It varied leverage through 15x, wallet-risk labels through 10%, and broad signal/exit settings.

Zero candidates qualified. Some produced isolated +50% months or very high cumulative returns, but the apparent winners carried approximately 54–62% drawdowns and roughly -27% to -30% worst months. The research therefore rejected the claim that this signal family could defensibly promise repeatable 50–100% monthly ROI.

### Adaptive-leverage research

A 1,152-policy test sized leverage from confidence, indicator score, ADX, volume, and ATR volatility. The strongest confirmed growth policy used a 1.25x floor, 5x cap, 1.4 quality exponent, and 0.75 volatility penalty. Realized leverage averaged only 1.94x because weaker or more volatile signals stayed near the floor.

The continuous stressed return improved to +98.30% with 54.17% wins and 20.50% drawdown. Adaptive leverage improved the payoff distribution, but did not create a 50% monthly strategy. A mechanical post-loss reduction was not consistently beneficial and was retained as a circuit-breaker question rather than an assumed advantage.

### Expanded adaptive search and exact 12-month repeat

The expanded 18.5-month balanced profile used a 150-minute window, 1.60% trend, 0.20% breakout, seven-hour cooldown, SOL 1-hour/4-hour and BTC 1-hour EMA(8/21), 10% TP, 7% SL, 3.5% risk, and adaptive 1.25–4x leverage. Its continuous stressed result was +99.98%, with 58.33% wins and 19.28% drawdown.

The exact 12-month repeat produced different leaders, demonstrating start-date and regime sensitivity:

| Candidate | Stressed return | Win rate | Profit factor | Drawdown |
|---|---:|---:|---:|---:|
| Balanced 120m profile | +55.38% | 69.57% | 1.93 | 17.45% |
| Higher-return 135m profile | +101.40% | 70.83% | 3.45 | 16.66% |
| Lower-drawdown 150m profile | +47.01% | 55.17% | 1.85 | 13.33% |

The 135-minute profile used 1.50% trend, 0.25% breakout, an eight-hour cooldown, EMA(8/21), 10% TP, 7% SL, 5% risk, and adaptive 1.5–4x leverage. It was a strong 12-month hypothesis but had only 24 trades and could not be treated as universal.

### Aggressive high-win extension

Two 8,192-candidate sweeps expanded thresholds, cooldowns, TP/SL, wallet-risk labels, and leverage ceilings. Important candidates included:

| Candidate | Main result | Limitation |
|---|---|---|
| 155m, 2.00/0.35, 7h, TP/SL 15%, adaptive 2–5x | +159.50% stressed over 12 months, 88.24% wins | 35.32% extended drawdown and weaker older folds |
| 150m, 2.00/0.40, 7h, TP 7%, SL 15%, adaptive 1–5x | +89.19% stressed, 92.86% wins | Lower return than the earlier 135m candidate |
| 145m, 1.90/0.45, 8h, TP 12%, SL 15%, adaptive 2–5x | +112.24% stressed over 18.5 months, 80.77% wins | Only +42.72% in the exact 12-month replay |

Increasing only the nominal wallet-risk label from 5% through 10% sometimes changed nothing because base allocation and the decision layer were already binding. Higher labels must not be assumed to cause higher returns.

### 135/155-minute hybrid cross-test

An 8,192-candidate hybrid search crossed the strongest 135- and 155-minute families. The strongest cross-period merge was the foundation of the selected profile:

- 145-minute window, 1.65% trend, and 0.35% breakout
- 7.5-hour cooldown
- EMA(8/21), SOL 1-hour plus 4-hour direction, and BTC 1-hour plus 4-hour confirmation
- 10% TP and 10% SL
- adaptive 2–4x leverage, 2.5 quality exponent, 1.25 volatility penalty, and no mechanical loss stepdown

| Hybrid result | 12-month stress | 18.5-month stress |
|---|---:|---:|
| Return | +100.56% | +165.65% |
| Win rate | 78.26% | 70.21% |
| Profit factor | 3.02 | 2.16 |
| Maximum drawdown | 13.06% | 23.07% |
| Median month | +6.13% | +5.97% |
| Worst month | -6.58% | -12.38% |

This profile did not maximize the isolated 12-month return. It was selected because it improved the 18.5-month return and drawdown relative to the 155-minute parent while retaining a strong result in the 12-month replay.

### Older-history, allocation, cooldown, and target-risk follow-up

The hybrid was then evaluated over older SOL history and through direct sizing changes:

- The 80% allocation value was confirmed to be a ceiling. Actual collateral is determined by the target-risk calculation and other decision constraints.
- At the original 7.5-hour cooldown, 1.6% and 2% risk controls remained strong in recent tests. The 2% control returned +103.05% over 18.5 months and +50.74% over 12 months under stress.
- Shortening cooldown to 7.2 hours caused both 3% and 4% risk profiles to become negative in recent tests. This small timing change altered which signals were eligible and therefore changed the entire trade path.
- Restoring the 7.5-hour cooldown produced +155.77% at 3% risk and +179.83% at 4% risk over the recent 18.5 months under stress.
- Over the recent 12 months, the corresponding results were +64.57% and +70.99%.
- Over June 2021–December 2024, the 3% profile returned only +6.24% under stress with 44.81% drawdown; the 4% profile returned +3.17% with 49.72% drawdown.
- Target risk did not change the entries or win rate in this isolated test. It scaled the same trade path. Four percent therefore increased recent profit by accepting more drawdown while reducing the already thin older stressed margin.

| Final risk comparison | Recent 18.5m stress | Recent 12m stress | Older 43m stress |
|---|---:|---:|---:|
| 3% risk | +155.77%, 16.32% DD | +64.57%, 17.93% DD | +6.24%, 44.81% DD |
| 4% risk | +179.83%, 18.84% DD | +70.99%, 20.87% DD | +3.17%, 49.72% DD |

The 20,000-path recent bootstraps supported both risk levels within those recent samples, but the direct older-regime replay is the reason 3% was selected over 4%.

### Cost, timing, account-size, and cross-asset sensitivities

- The deployed profile remained negative under next-open versus signal-close timing and across observed, conservative, and stressed costs. Only an unrealistic zero-impact/zero-borrow/zero-network combination became positive, with a 65.73% drawdown.
- The frozen deployed profile also failed in separate ETH and BTC sealed diagnostics. This justified using BTC as confirmation rather than assuming the SOL profile could trade every asset.
- A $1,000 starting balance did not repair the original edge. The smaller account merely stopped trading earlier when collateral fell below Jupiter's minimum.
- A 20,000-path bootstrap of the original deployed sealed sequence estimated a 67.38% chance of a nonpositive result and a 94.12% 95th-percentile drawdown.

### Research conclusion

The research did not discover a permanent golden ratio or a guaranteed return. It did identify an aggressive cross-period hypothesis that is materially stronger than the original high-frequency/high-leverage profile. The selected 145-minute, 3%-risk hybrid is the most confident aggressive foundation because it combines stronger entries, slower cadence, enforced exit geometry, and bounded adaptive leverage. Its older stressed edge remains thin, so it must begin as a versioned shadow/paper profile and earn promotion on genuinely new data.

## Later implementation checklist

- Map the visible wallet settings and server-side learning profile to these exact values.
- Make 3% target wallet risk distinct from the 80% allocation ceiling in both storage and UI descriptions.
- Add bounded learning ranges and reject updates outside approved limits.
- Preserve the 7.5-hour cooldown after losses and ordinary completed trades.
- Confirm dynamic leverage remains between 2x and 4x at order construction time.
- Confirm TP and SL are expressed as ROE and converted correctly for Jupiter trigger prices.
- Add a profile version so executions and training history identify the parameter set used.
- Run unit, integration, historical replay, and paper-execution tests before enabling live trading.
- Deploy only after explicit approval; do not infer approval from this research document.

## Research artifacts

The canonical exhaustive report is:

`research/backtest/REPORT.md`

Raw and generated reports are stored under:

`research/backtest/results/recent-aggressive-cross-test/`

This strategy remains experimental. Historical and simulated performance does not guarantee future profitability, and leverage can magnify losses.
