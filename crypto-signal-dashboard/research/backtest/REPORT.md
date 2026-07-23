# BremLogic autonomous Perps engine: independent historical backtest

Status: complete. Production engine frozen at `ba6ec3fcf8eb787931a364cbdf1c3f74c47dfa55`.

## Scope and non-interference

- Production source, Redis records, Vercel configuration, and Git history were not modified.
- Historical data and generated results live under `research/backtest/`; data/results are gitignored.
- The current wallet-scoped configuration and active learning profile were snapshotted into `frozen-control.json` before testing.
- SOL is the currently enabled live slot. ETH and BTC are evaluated separately as cross-asset robustness checks, not as a simultaneous portfolio.
- Two later UI/WalletConnect commits landed in the shared worktree during the research. A Git diff confirmed that they did not change the frozen signal, decision, monitor, price, or risk files.

## Test protocol

- Data: official Coinbase Exchange one-minute OHLCV, 2025-01-01 through 2026-07-19 inclusive (812,726–812,769 validated candles per asset).
- Training: 2025-01-01 through 2025-10-31.
- Validation: 2025-11-01 through 2026-03-31.
- Sealed test: 2026-04-01 through 2026-07-19. The grid selector cannot load this period.
- Baseline execution: signal evaluated on a completed candle, entry at the next available candle open.
- Timing sensitivity: signal-candle close, which brackets production's use of an in-progress Coinbase minute.
- Intrabar ambiguity: liquidation is assumed before take profit when both prices occur inside one minute (adverse ordering).
- Baseline costs: Jupiter's 0.06% entry and exit base fee, observed 0.01% price impact on each side, observed hourly borrow rates, $0.01 network allowance, and no extra slippage.
- Sensitivities include base-fees-only, conservative costs, and stress costs.
- One open position at a time, matching the server monitor.
- Capital compounds after every closed trade.
- Current actual agent capital is the primary test balance: $115.480621. A $1,000 scale sensitivity separates strategy behavior from Jupiter's $10 minimum collateral.

## Harness validation

- Project suite: 65/65 tests passed at completion.
- Isolated harness: deterministic replay passed.
- Entries occur after the signal candle in the baseline.
- Appending future candles does not alter already-closed prefix trades.
- Candles outside the requested end boundary cannot influence results.
- Requests beyond available history fail closed.
- TypeScript strict compilation passed.
- Final SOL control files reproduced byte-for-byte on a second run (`b8ddf04...` sealed and `dae8e172...` training SHA-256 prefixes).

## Production audit findings that affect interpretation

### 1. Stored training outcomes are contaminated by reused Jupiter position addresses

Jupiter can reuse the same long/short position account for sequential trades. The current reconciler groups every later trade with the same `positionPubkey` after an execution timestamp and selects the last later exit. That can attach a later exit, later fees, and combined PnL to an earlier execution. Read-only comparison with raw Jupiter trades reproduced the mismatch, including directionally impossible stored results. Therefore the active v8 profile is tested exactly as deployed, but its reported seven-trade 85.71% win rate and 26.63 profit factor are not accepted as evidence.

### 2. The runtime suppresses stop losses

`applyLearnedTradePlan` returns a zero stop loss for both baseline and learned profiles. The current profile sizes collateral using a nominal stop-risk reference, but the actual on-chain position has no stop. Consequently the stated `targetWalletRiskPercent` is not the true maximum loss: liquidation can lose the full selected collateral.

### 3. The decision layer creates an implicit high-momentum gate

At 50x leverage, with no stop and a non-light allocation, a sideways 15-minute trend cannot reach the active 0.621 decision threshold even at the signal engine's maximum 0.95 confidence. An aligned trend receives a +0.12 adjustment; because `computeTrendBias` requires a 1% 15-minute move, the decision layer effectively imposes a much stronger momentum requirement than the visible 0.149%/0.181% SOL thresholds.

### 4. Production consumes an incomplete Coinbase minute

The fetch window ends at the current wall-clock time and does not remove the current in-progress candle, despite an error message referring to completed candles. Historical OHLCV cannot reconstruct the exact price visible at each 30/60-second cron invocation. The primary result therefore uses closed candles and next-open execution, with signal-close timing reported as a sensitivity bracket.

### 5. The configured daily-loss percentage is not enforced by the live user-scoped guard

`maxDailyLossPct` is loaded, but `userScopedRisk.ts` only checks trade collateral and aggregate collateral exposure. The backtest does not invent a daily-loss stop that production lacks.

### 6. Automatic training can remain on the incremental path

Once an active profile exists, each newly reconciled outcome can trigger an incremental update. The full chronological holdout training path is not necessarily reached automatically at 50 outcomes, so online adaptation does not by itself guarantee a fresh out-of-sample promotion test.

## Results

### Bottom line

The current autonomous engine does **not** demonstrate a robust profitable edge. It should not be described as historically validated or safe to run at 50x. No tested visible trend/breakout setting was profitable in both training and validation, and every preselected candidate lost money in the sealed period.

### Frozen SOL controls at the actual account size

| Configuration | Training return / PF | Validation return / PF | Sealed return / PF | Sealed max DD | Sealed trades / liquidations |
|---|---:|---:|---:|---:|---:|
| Active learned profile (0.149 / 0.181) | -77.14% / 0.28 | -66.11% / 0.38 | -40.49% / 0.89 | 66.57% | 93 / 14 |
| Visible form (0.14 / 0.19) | -76.20% / 0.31 | -65.91% / 0.39 | -4.26% / 0.99 | 56.42% | 88 / 12 |
| Proposed 0.25 / 0.25 | -65.92% / 0.88 | -76.63% / 0.70 | -5.82% / 0.99 | 70.04% | 67 / 9 |

The 0.25/0.25 proposal is therefore not supported. Its high win rates (82.7%, 81.2%, and 86.6%) conceal poor payoff asymmetry and liquidations.

### Why the deployed result loses despite an 84.9% sealed win rate

- 79 winners and 14 losers; all 14 losses were liquidations.
- Average winner: $4.73. Average loss: -$30.03.
- Gross price PnL before costs: +$142.13.
- Entry/exit fees: $186.98; borrow plus network allowance added about $1.91.
- Net result: -40.49%, with -0.155 daily Sharpe and -0.202 Sortino.

At roughly 45x average executed leverage, the 0.06% entry and exit base fees alone translate into several percentage points of collateral ROE per round trip. Small frequent TP wins cannot reliably pay for fees plus occasional full-collateral liquidations.

### Parameter searches

- Signal grid: 144 broad combinations of 5/15/30/60-minute trend windows, 0.10–0.50% trend thresholds, and 0.10–0.40% breakout thresholds. **Zero** were profitable in both training and validation. All 12 preselected candidates lost in the sealed period.
- Risk grid: 144 combinations of 5–50x leverage, 10–40% TP ROE, and 0.5–2.0% target wallet risk. Three 5x combinations passed training and validation, but all failed sealed testing: -1.41%, -22.86%, and -40.69%.
- Research-only SL grid: 240 combinations at 3/5/8/10x with 5–20% TP ROE, 2–10% SL ROE, and 0.5–1.6% target risk. **Zero** were profitable in both training and validation. The least-bad development result was -4.78% training / +3.92% validation with 73.06% / 49.53% drawdowns.

### Expanded search and 15% stop-loss study

The follow-up search deliberately moved beyond the original narrow threshold range. It sampled 512 joint configurations spanning 5–180-minute trend windows, 0.10–10% trend thresholds, 0.10–8% breakout thresholds, 5–900-second cooldowns, 2–125x leverage caps, 5–50% TP ROE, and 0.25–5% target wallet risk. Seven configurations were positive in all four development folds, but forward testing exposed sparse trades and high drawdowns rather than a dependable golden setting.

The leading no-stop development family used a 10-minute window, 0.15% trend, 0.65% breakout, 300-second cooldown, roughly 2x leverage, 15% TP ROE, and 0.75% target wallet risk. It was positive across the SOL/ETH/BTC development and forward segments, but the forward samples contained only 5/2/2 trades and its worst segment drawdown was 56.92%. A long-lived open trade also made the result boundary-sensitive.

A 384-sample local neighborhood then tested 8/10/12/15/18/20/25% SL ROE around that family. Thirteen configurations were positive in both the contiguous SOL development and forward periods, but **zero** satisfied the 35% drawdown ceiling in both. The best local score used 20% TP and 20% SL at 1.5x; it returned +85.23% development and +43.99% forward, but development drawdown was 49.27% and the forward period had only seven trades.

The exact 15% SL result did not generalize. With the broad-search center and 15% TP, only one of six SOL/ETH/BTC development/forward segments was positive; average segment return was -35.30% and worst drawdown was 92.10%. With the requested 25% TP baseline, three of six segments were positive, average segment return was -20.10%, and worst drawdown was 96.22%. The stop reduced individual loss size but increased turnover because stopped positions could re-enter after the ordinary signal cooldown. For example, the 25% TP SOL development run rose from 19 trades without a stop to 112 trades with the 15% SL, producing 79 stop-outs and a -94.49% return.

Therefore, a fixed 15% SL should **not** be promoted by itself. The next defensible design test is a 15%-centered stop paired with an explicit post-stop re-entry lockout or fresh-regime requirement, followed by the same multi-asset, cost-stress, and drawdown gates.

The post-stop lockout follow-up tested 5/15/30/45/60 minutes and 2/3/4/8/12/24 hours using 25% TP, 15% SL, 2x leverage, and the broad-search signal center. A 15-minute lockout was negative in all six SOL/ETH/BTC development/forward segments, averaging -32.33% with an 81.15% worst drawdown. The exact 45-minute test was also negative in all six segments, averaging -50.20% with a 95.93% worst drawdown; it was worse than both 30 and 60 minutes because changed exit timing changes the later signal and decision-history path rather than producing a smooth interpolation. Two and four hours improved average segment returns to -3.34% and -1.52%, but still produced only three and two positive segments out of six with 86%+ worst drawdowns. The exact three-hour point was negative in all six segments, averaging -36.31% with a 77.36% worst drawdown, reinforcing that cooldown length does not interpolate into signal quality. The 24-hour lockout made all three forward segments slightly positive, but all three development segments remained negative. No fixed lockout was profitable and controlled across all markets and periods. A fresh-regime requirement and consecutive-stop circuit breaker are more defensible than selecting a timer from these unstable results.

### Coarse-candle multi-timeframe study

A research-only production-shaped test resampled the local minute archive into completed 15-minute entry candles, 1-hour trend candles, and 4-hour regime candles without higher-timeframe lookahead. It used the existing indicator score on 15-minute candles, EMA(9/21) direction on higher timeframes, 25% TP, 15% SL, 2x leverage, and one-hour signal/post-stop cooldown. Entries occurred at the next 15-minute candle open, with adverse liquidation/SL/TP ordering inside each OHLC candle.

| Confirmation | Positive SOL/ETH/BTC development/forward segments | Average segment return | Worst DD | Total trades / stops |
|---|---:|---:|---:|---:|
| 15m only | 1/6 | -31.38% | 68.79% | 234 / 149 |
| 15m + 1h EMA direction | 3/6 | +3.13% | 62.48% | 223 / 132 |
| 15m + 1h + 4h EMA direction | 4/6 | -3.87% | 61.16% | 224 / 138 |

The 1-hour confirmation materially improved the aggregate result, but it was still negative in SOL forward, ETH development, and BTC development. The 4-hour filter produced more positive segments but worsened the aggregate because SOL development and BTC development remained large losses. This supports continued research on a 15m+1h architecture, not immediate promotion. A rigid 4-hour EMA filter is not yet justified.

An expanded 384-candidate multi-timeframe search varied 45–180-minute entry lookbacks, 0.10–1.00% trend thresholds, 0.15–1.25% breakout thresholds, 30-minute to 3-hour cooldowns, 1h/4h EMA pairs of 5/13, 9/21, and 12/26, while keeping 25% TP, 15% SL, and 2x leverage fixed. Five candidates were profitable in all four SOL development folds. The leading development candidate used a 120-minute entry lookback, 0.10% trend, 1.25% breakout, 30-minute cooldown, and matching 1h/4h EMA(5/13) direction. Its four fold returns were +27.32%, +18.61%, +10.39%, and +19.41%, with 16–36 trades per fold and 18.45–35.36% drawdowns.

Forward and cross-asset confirmation rejected promotion. The leader returned -5.57% in SOL forward (-11.87% under cost stress), -10.45% in ETH development, and -19.55% in BTC development. All five four-fold SOL survivors lost in the later SOL period, ranging from -2.71% to -11.54%. No survivor was positive across all SOL/ETH/BTC development and forward segments, and none passed forward cost stress across all assets. The architecture is more promising than the one-minute-only signal design, but these exact controls remain regime-sensitive and overfit to earlier SOL history.

The same 384 candidates were then reranked jointly across 12 development folds: four folds for each of SOL, ETH, and BTC. Zero candidates were profitable in all 12 folds, and zero achieved at least three profitable folds for every asset. The joint leader used a 60-minute entry lookback, 0.50% trend, 0.65% breakout, 30-minute cooldown, and matching 1h/4h EMA(5/13) direction. It passed 6/12 folds—SOL 3/4, ETH 2/4, BTC 1/4—with a -23.64% worst fold and 39.40% worst drawdown. Forward results were SOL -8.06%, ETH +3.32%, and BTC +8.68%; under cost stress only BTC remained positive.

The 4-hour branch was directionally helpful but insufficient. Candidates using 4h agreement averaged 4.39 profitable folds out of 12 versus 3.87 without it, had a less-negative median return across configurations (-5.06% versus -7.88%), and occupied 13 of the top 20 joint ranks. However, no 4h candidate cleared the multi-asset consistency gate. SOL and BTC often share broad direction, but their volatility paths, entry timing, and stop frequency were different enough that a SOL-valid configuration did not automatically transfer.

### SOL-specialized study

Because SOL is the intended traded market, the final study optimized only SOL outcomes while permitting BTC to serve as a non-traded market-direction filter. It evaluated 1,024 deterministic candidates using completed 15-minute SOL entry candles, SOL 1-hour and optional 4-hour EMA direction, optional BTC 1-hour/4-hour EMA confirmation, 45–180-minute entry lookbacks, 0.10–1.25% trend thresholds, 0.25–2.00% breakouts, 30-minute to 3-hour cooldowns, and four EMA pairs. TP, SL, and leverage remained fixed at 25% ROE, 15% ROE, and approximately 2x. Ranking used only four SOL development folds ending before April 1, 2026.

Twenty-one candidates were profitable in all four development folds. Five also remained positive in both the later April–July 2026 diagnostic period and the higher-cost stress replay. The best balance of consistency, drawdown, sample size, and forward behavior—not the candidate with the largest isolated forward return—was:

- 15-minute SOL entry candles with a 120-minute signal lookback
- 0.65% SOL trend threshold and 0.50% breakout threshold
- SOL 1-hour EMA(5/13) direction
- BTC 1-hour and 4-hour EMA(5/13) direction confirmation; BTC is not traded
- no rigid SOL 4-hour direction requirement
- two-hour ordinary cooldown and post-stop re-entry lockout
- 25% TP ROE, 15% SL ROE, and approximately 2x leverage

| SOL period | Return | Max DD | PF | Trades | Wins / losses |
|---|---:|---:|---:|---:|---:|
| 2025 early development | +66.20% | 15.49% | 1.91 | 32 | 15 / 17 |
| 2025 mid development | +38.21% | 18.50% | 1.95 | 14 | 8 / 6 |
| 2025 late development | +8.68% | 24.79% | 1.13 | 20 | 9 / 11 |
| Jan–Mar 2026 validation | +29.21% | 17.66% | 2.22 | 12 | 7 / 5 |
| Apr–Jul 2026 diagnostic | +16.23% | 23.01% | 1.42 | 10 | 5 / 5 |
| Apr–Jul 2026 cost stress | +7.53% | 24.61% | 1.18 | 10 | 5 / 5 |

This is the first tested candidate family to clear all four SOL development folds and remain positive in both later baseline and cost-stress diagnostics. It is still a **paper/shadow candidate, not a proven live optimum**. The later period is no longer pristine because earlier studies had already inspected it, and it contains only ten completed trades. Its average forward holding time was 14,500 minutes (about 10.1 days), so borrow costs and execution quality matter materially. The result supports SOL-specific shadow validation with BTC regime confirmation; it does not establish a universal “golden ratio” or justify immediate autonomous deployment.

**Subsequent correction:** the joint SL/risk search below propagated the fixed SL into collateral risk sizing as well as the exit trigger. Under that stricter and more internally consistent model, this exact 2x/25% TP/15% SL candidate was positive in only three of four development folds: +13.67%, +11.26%, -1.62%, and +15.84%. It remained positive later at +5.40% baseline and +2.65% under stress, but it no longer qualifies as a four-fold survivor. The earlier figures attached the SL exit without fully sizing collateral against the same fixed stop distance and therefore overstated the result. The joint-search results supersede the earlier candidate for selection purposes.

### Current primary-wallet parameters on the same SOL periods

A separate replay used the primary wallet's Redis configuration and active version-eight learning profile, verified on July 20, 2026. The saved controls were a 15-minute window, 0.14% trend threshold, 0.19% breakout, 180-second cooldown, 80% allocation, aggressive Smart Trades, 50x leverage cap, and zero TP/SL entered in the UI. The active profile adjusted SOL thresholds to 0.149% trend and 0.181% breakout, retained a 25% adaptive TP target and no generated SL, and applied a 1.015 leverage multiplier. The production-shaped replay therefore averaged 45x executed leverage; it did not assume that every fill occurred at the full 50x cap.

| SOL period | Return | Max DD | PF | Trades | Win rate | Liquidations |
|---|---:|---:|---:|---:|---:|---:|
| 2025 early development | -96.56% | 96.57% | 0.47 | 110 | 77.27% | 25 |
| 2025 mid development | -96.60% | 97.06% | 0.53 | 87 | 75.86% | 21 |
| 2025 late development | -96.23% | 97.41% | 0.27 | 54 | 68.52% | 17 |
| Jan–Mar 2026 validation | -96.26% | 96.86% | 0.46 | 72 | 72.22% | 20 |
| Apr–Jul 2026 diagnostic | -40.08% | 66.42% | 0.89 | 93 | 84.95% | 14 |
| Apr–Jul 2026 cost stress | -94.38% | 95.53% | 0.31 | 89 | 84.27% | 14 |

The high win rate is misleading: frequent small winners were overwhelmed by 14–25 liquidations per segment and high leveraged turnover costs. Baseline fees alone ranged from $315.86 to $1,624.82 per independently reset $1,000 segment. This confirms that the current low thresholds, three-minute cooldown, absence of a real stop, and approximately 45x average executed leverage are not robust on the tested SOL history. The result is directly comparable by calendar period to the SOL-specialized study, but the candle architecture intentionally differs: it replays the current one-minute engine rather than imposing the candidate's 15-minute entries and higher-timeframe filters.

### Stop-loss sweep on the current SOL engine

To isolate whether protection alone could repair the current configuration, fixed SL levels of 3%, 5%, 7%, 10%, 15%, 20%, 25%, 30%, 40%, and 50% ROE were added without changing its learned signal thresholds, one-minute engine, aggressive Smart Trades behavior, approximately 45x average leverage, or three-minute cooldown. A three-minute post-stop lockout matched the configured signal cooldown. The zero-stop run is included as the control.

| SL ROE | Avg development return | Worst development DD | Development trades / stops / liquidations | Forward return | Forward stress |
|---:|---:|---:|---:|---:|---:|
| None | -96.41% | 97.41% | 323 / 0 / 83 | -40.08% | -94.38% |
| 3% | -96.69% | 96.84% | 717 / 634 / 4 | -96.65% | -96.65% |
| 5% | -96.68% | 96.75% | 846 / 699 / 1 | -96.65% | -96.77% |
| 7% | -96.69% | 96.84% | 767 / 604 / 3 | -96.65% | -96.74% |
| 10% | -96.68% | 96.97% | 801 / 592 / 0 | -96.56% | -96.78% |
| 15% | -96.71% | 97.21% | 864 / 544 / 2 | -96.73% | -96.87% |
| 20% | -96.66% | 97.21% | 825 / 470 / 2 | -96.25% | -96.72% |
| 25% | -96.71% | 97.67% | 775 / 402 / 2 | -96.84% | -96.87% |
| 30% | -96.72% | 97.26% | 733 / 350 / 2 | -96.61% | -96.69% |
| 40% | -96.85% | 97.26% | 679 / 282 / 2 | -96.94% | -96.76% |
| 50% | -96.75% | 97.35% | 664 / 236 / 3 | -96.86% | -97.15% |

Stops nearly eliminated liquidations, but none created a profitable development fold or positive forward result. At approximately 45x, a 10% ROE stop represents only about a 0.22% adverse underlying move before fees and execution effects. The low thresholds and three-minute lockout repeatedly re-entered ordinary SOL noise: total development trades rose from 323 without a stop to 664–864 with stops, and hundreds of realized stop-outs plus leveraged fees depleted the account. Therefore the failure is architectural rather than the absence of one ideal SL number. A stop must be paired with substantially lower leverage, slower entry cadence, and stronger regime confirmation; the joint search below evaluates those controls together.

### Joint SOL signal, TP/SL, leverage, and cooldown search

A 4,096-candidate SOL search jointly varied 60–180-minute signal windows, 0.30–1.25% trend thresholds, 0.25–1.50% breakouts, 30-minute to 4-hour cooldowns, four EMA pairs, optional SOL 4-hour and BTC 1-hour/4-hour confirmation, 15–50% TP ROE, 3–50% SL ROE, and 1.5–5x leverage. Four development folds determined ranking; later data was not used during initial selection. Fifty-three candidates were profitable in all four baseline development folds, and 43 also met the <=40% drawdown, sample-size, and per-fold trade gates. Five configurations—including the exact prior benchmark—were positive in the later baseline and stress replays, but none survived stressed costs in every earlier development fold.

The best robustness-first broad candidate used 1.5x leverage, 25% TP, 7% SL, a four-hour cooldown, 90-minute window, 0.80% trend, 0.65% breakout, and SOL 1-hour EMA(5/13) without BTC or rigid SOL 4-hour confirmation. It passed all eight baseline/stress development checks and returned +1.00% later, but missed the final later stress gate at -0.66%. This near miss anchored a separate 2,048-candidate local refinement that ranked against both baseline and stressed costs in every development fold before checking later data.

Thirteen local candidates passed all eight development cost/fold gates. Three also remained positive in both later baseline and stress. The strongest balance of sample size, drawdown, and later behavior was:

- completed 15-minute SOL entry candles and a 90-minute signal window
- 1.00% trend threshold and 0.80% breakout threshold
- SOL 1-hour EMA(8/21) direction
- BTC 1-hour and 4-hour EMA(8/21) confirmation; BTC is not traded
- no rigid SOL 4-hour direction requirement
- three-hour ordinary cooldown and post-stop lockout
- 20% TP ROE, 7% SL ROE, and 2.5x leverage
- 0.75% target-wallet risk sizing; the 80% allocation remains only a ceiling

| SOL period | Baseline return | Stress return | Worst DD | Baseline trades |
|---|---:|---:|---:|---:|
| 2025 early development | +12.17% | +6.00% | 8.90% | 43 |
| 2025 mid development | +10.16% | +5.55% | 7.72% | 30 |
| 2025 late development | +5.26% | +0.80% | 11.57% | 31 |
| Jan–Mar 2026 validation | +5.69% | +2.31% | 8.46% | 25 |
| Apr–Jul 2026 diagnostic | +5.85% | +2.62% | 7.53% | 20 |

The candidate produced zero liquidations, 129 development trades, and 20 later trades. Its later profit factor was 1.40 baseline and 1.16 under stress. Two other local candidates also cleared every gate: a lower-risk 1.5x/20% TP/5% SL configuration with only ten later trades and a 2x/25% TP/15% SL configuration with seven. The selected 2.5x/20% TP/7% SL candidate has the broadest later sample and strongest combined later result, but the weakest development stress return is only +0.80%. Multiple-testing risk and reuse of the later diagnostic period mean this is a **shadow/paper candidate**, not proof of future profitability or authorization for live deployment.

### Selected SOL candidate at 20x leverage

An exact sensitivity replay changed only configured leverage from 2.5x to 20x. Signal thresholds, three-hour cooldown, EMA confirmation, 20% TP, 7% SL, 0.75% target-wallet risk sizing, periods, and cost models remained fixed. The decision layer reduced average executed leverage to approximately 18.84x. Every independently reset period became negative:

| SOL period | $1,000 baseline return | $1,000 stress return | $100 baseline ending value | $100 stress ending value |
|---|---:|---:|---:|---:|
| 2025 early | -25.44% | -59.06% | $76.26 | $68.59 |
| 2025 mid | -20.25% | -41.46% | $72.07 | $71.38 |
| 2025 late | -15.17% | -40.67% | $82.00 | $72.22 |
| Jan–Mar 2026 | -4.19% | -25.47% | $93.68 | $76.74 |
| Apr–Jul 2026 | -14.37% | -32.97% | $83.27 | $71.23 |

In one continuous January 2025–July 2026 replay, $100 ended at **$72.00 baseline** (-$28.00) and **$68.59 under stress** (-$31.41). The $1,000 run ended at $410.06 baseline (-58.99%) and $71.09 under stress (-92.89%). The smaller account stopped placing trades after collateral fell below the $10 minimum, so its percentage loss is artificially capped and cannot be scaled linearly from the $1,000 result. For comparison, the same continuous $100 replay at 2.5x ended at $143.81 baseline (+$43.81) and $108.92 under stress (+$8.92).

At approximately 18.84x executed leverage, 20% TP and 7% SL correspond to only about +1.06% and -0.37% underlying SOL moves. This moved exits back into ordinary short-term noise: the continuous baseline replay recorded 57 wins and 166 losses, with $513.87 in fees on the independently simulated $1,000 account. Almost all failures were stops rather than liquidations. The test rejects 20x for this signal/TP/SL package.

#### Wider SL sensitivity at 20x

The continuous replay then held every other selected control fixed and tested no SL plus 7%, 10%, 15%, 20%, 25%, 30%, 40%, 50%, 60%, 75%, and 90% SL ROE. Wider stops provided more breathing room: on the $1,000 baseline run, stop-outs declined from 166 at 7% to 121 at 15%, 72 at 40%, 52 at 60%, and 32 at 90%. None was profitable.

| SL ROE | Approx. underlying stop at 18.8x | $1,000 baseline return | $1,000 stress return | $100 baseline ending value | $100 stress ending value |
|---:|---:|---:|---:|---:|---:|
| None | None | -65.74% | -92.17% | $70.44 | $65.23 |
| 7% | 0.37% | -58.99% | -92.89% | $72.00 | $68.59 |
| 10% | 0.53% | -46.51% | -91.51% | $71.91 | $70.38 |
| 15% | 0.80% | -44.47% | -91.96% | $72.36 | $63.88 |
| 20% | 1.07% | -73.55% | -92.82% | $71.95 | $71.63 |
| 30% | 1.60% | -70.38% | -92.78% | $71.20 | $66.81 |
| 40% | 2.13% | -61.27% | -93.14% | $68.99 | $69.11 |
| 60% | 3.19% | -49.30% | -92.83% | $72.27 | $70.69 |
| 90% | 4.78% | -58.86% | -93.39% | $69.80 | $71.12 |

Fifteen percent was the least-bad baseline SL on the $1,000 account, but still lost 44.47%; under stress it lost 91.96%. At wider levels the reduced stop count was offset by larger losses per stop, continued leveraged fees, and eventually renewed liquidations near 90% ROE. The $100 outcomes cluster near $65–$72 because trading stops when collateral falls below Jupiter's $10 minimum. The sensitivity rejects every tested SL at 20x while TP remains 20% and the other controls remain fixed; simply widening the stop cannot restore the 2.5x edge.

### Capital-preservation and lower-TP search

A separate 4,096-candidate refinement changed the objective from maximum return to positive stressed returns with low drawdown. It expanded TP down to 5%, leverage down to 1x, and cooldown up to eight hours while varying 75–150-minute windows, stronger signal thresholds, 3–15% SL, EMA regimes, and BTC confirmation. Ranking used baseline and stressed costs in all four development folds before later confirmation. Twenty candidates passed all eight development fold/cost checks; five also stayed positive in both later baseline and stress.

Direct continuous simulation at $100 showed why account size must be part of selection. The development-leading 1.25x/5% TP/5% SL candidate returned +24.81% baseline but -6.34% under stress because its 92 trades incurred fixed costs large relative to the account. Three alternatives remained positive at $100 in both models:

| Profile | Core risk settings | $100 baseline ending value | $100 stress ending value | Stress max DD | Trades |
|---|---|---:|---:|---:|---:|
| Conservative | 1.25x, TP 10%, SL 7%, 4h cooldown | $113.45 | $106.65 | 6.39% | 45–46 |
| Balanced | 2x, TP 25%, SL 7%, 6h cooldown | $141.62 | $111.95 | 12.72% | 107 |
| Higher-return | 3x, TP 7%, SL 15%, 3h cooldown | $158.25 | $119.13 | 14.62% | 122 |

The conservative profile best matches the stated priority of accepting small profit to minimize loss:

- completed 15-minute SOL entries and a 75-minute signal window
- 1.25% trend threshold and 0.50% breakout threshold
- SOL 1-hour and 4-hour EMA(8/21) direction
- BTC 1-hour and 4-hour EMA(8/21) confirmation
- four-hour ordinary cooldown and post-stop lockout
- 10% TP ROE, 7% SL ROE, 1.25x leverage, and 0.75% target-wallet risk

The continuous $100 replay produced 23 wins and 23 losses baseline, no liquidations, +$13.45 baseline profit, and +$6.65 stressed profit. Maximum drawdown was 6.04% baseline and 6.39% under stress. Its weaker limitation is sample size: only four trades occurred in the later isolated period, and its weakest development stress fold was only +0.10%. It is a capital-preservation shadow candidate, not proof that losses are eliminated. The balanced and higher-return profiles earned more historically but accepted roughly double the drawdown.

### Monthly 50–100% ROI target search

A further 4,096-candidate SOL search asked whether the known-working architecture could credibly approach at least 50% ROI each month on a continuously compounded $100 account. It covered 60–150-minute signal windows, 0.50–1.50% trend thresholds, 0.35–1.25% breakouts, 30-minute to six-hour cooldowns, three EMA pairs, optional SOL 4-hour and BTC confirmation, 5–30% TP, 3–30% SL, 1.5–15x leverage, and 0.75–10% target-wallet risk. Monthly evaluation used the 18 complete months from January 2025 through June 2026; partial July 2026 was excluded. Qualification required a stressed median month of at least +50%, a non-negative stressed worst month, and no more than 40% stressed maximum drawdown.

Zero candidates qualified. Although 557 candidates reached +50% in at least one baseline month and 193 did so in at least one stressed month, none produced a +50% median month in either model. The maximum count was five of 18 baseline months or three of 18 stressed months. Maximizing that count selected unstable configurations with roughly 90%+ drawdown or account failure, so occasional +50% months are not evidence of a repeatable +50% monthly strategy.

| Result selected by | Core settings | Total baseline / stress return | Median month baseline / stress | Worst month baseline / stress | Max DD baseline / stress |
|---|---|---:|---:|---:|---:|
| Best risk-adjusted | 1.5x, 0.75% risk, TP 10%, SL 7%, 4h cooldown | +18.85% / +8.82% | +1.11% / +0.64% | -2.08% / -2.41% | 6.59% / 7.46% |
| Highest stressed median | 4x, 2.5% risk, TP 30%, SL 30%, 3h cooldown | +423.71% / +215.18% | +11.94% / +11.02% | -27.20% / -29.57% | 54.40% / 61.53% |
| Highest total return | 5x, 10% risk, TP 20%, SL 15%, 6h cooldown | +671.64% / +277.26% | +10.44% / +7.40% | -26.25% / -28.61% | 56.20% / 60.53% |
| Higher-growth compromise | 1.5x, 2.5% risk, TP 7%, SL 7%, 4h cooldown | +100.30% / +50.42% | +7.34% / +4.33% | -3.18% / -5.20% | 18.36% / 21.43% |

The higher-growth compromise used a 75-minute signal window, 1.25% trend, 0.35% breakout, EMA(8/21), SOL 1-hour direction, BTC 1-hour confirmation, and no SOL 4-hour gate. It doubled the account in the baseline replay and gained 50.42% total under stress, but those are **18.5-month cumulative** returns, not monthly returns. It is the most relevant candidate for additional sealed-data or paper testing if faster growth is prioritized, yet it still had negative months and a 21.43% stressed drawdown. It is not validated for production and does not meet the requested minimum monthly ROI.

The highest-return rows are especially vulnerable to selection bias because they were identified after searching thousands of combinations on the same history. Their 54–62% drawdowns and roughly -27% to -30% worst months make them unsuitable as claimed 50% monthly solutions. The search therefore rejects the premise that the current signal family has a defensible parameter setup for repeatable 50–100% monthly ROI; achieving that target historically required accepting loss behavior incompatible with the stated goal of less loss.

### Quality- and volatility-adjusted leverage

A 1,152-policy follow-up held the higher-growth signal architecture fixed—75-minute window, 1.25% trend, 0.35% breakout, four-hour cooldown, SOL and BTC 1-hour EMA(8/21), 7% TP, 7% SL, and 2.5% target-wallet risk—and varied only adaptive leverage behavior. Leverage was derived per entry from signal confidence, indicator score, ADX, volume, and ATR volatility, with optional reduction after consecutive losses. Policy ranking used four development folds through March 2026; April 1–July 20, 2026 was reserved for forward confirmation.

Thirty-one policies met the development requirement of more wins than losses under both cost models, at least three profitable folds, a stressed worst fold above -10%, and stressed drawdown no greater than 30%. Only five also produced positive forward returns, more forward wins than losses, and no more than 20% forward stressed drawdown. The most relevant confirmed growth policy used a 1.25x floor and 5x cap, a 1.4 quality exponent, a 0.75 volatility penalty, and no mechanical post-loss leverage reduction. Despite the 5x cap, its realized average leverage was only 1.94x over the continuous replay and 1.74x forward because weak or volatile signals stayed near the floor.

| Metric | Prior 1.5x cap | Adaptive 1.25–5x baseline | Adaptive 1.25–5x stress |
|---|---:|---:|---:|
| Continuous return | +100.30% baseline / +50.42% stress | +181.71% | +98.30% |
| Wins / losses | 46 / 45 | 52 / 44 | 52 / 44 |
| Win rate | 50.55% | 54.17% | 54.17% |
| Maximum drawdown | 18.36% baseline / 21.43% stress | 18.67% | 20.50% |
| Median complete month | +7.34% baseline / +4.33% stress | +5.62% | +4.32% |
| Worst complete month | -3.18% baseline / -5.20% stress | -4.37% | -6.21% |

The reserved forward period contained only nine trades. It returned +10.56% baseline and +6.96% stress, with five wins, four losses, no liquidations, and 6.53–6.86% drawdown. The result supports the user's narrower objective of more wins than losses and improved cumulative profitability, but the sample is too small for production promotion. It did not improve median monthly stressed return, and its worst month was slightly worse than the 1.5x-cap comparison. Adaptive leverage improved historical payoff distribution; it did not create a 50% monthly strategy or eliminate losses.

Loss-streak stepdown was not selected by the strongest confirmed growth policy. Lowering leverage after prior losses sometimes reduced damage, but it also changed TP/SL distances and missed recoveries; several conservative 1.5–2x policies survived forward testing with 53.1% continuous and 57.1% forward win rates, but lower stressed cumulative returns near +70%. A production design should therefore treat post-loss reduction as a circuit-breaker decision tested separately, not assume it automatically improves the edge.

### Expanded adaptive joint and local search

The next pass jointly varied the signal window, thresholds, cooldown, EMA pair, SOL/BTC confirmation, TP, SL, wallet risk, and adaptive-leverage policy across 4,096 deterministic configurations. Ranking continued to use only the four development folds through March 2026. Forty-seven configurations passed the development guardrails and 12 also passed the reserved April–July 2026 confirmation. A separate 4,096-policy local robustness sweep around the strongest slower-signal region produced 126 development survivors and 39 later-period survivors. Because the later period had already been inspected after the broad pass, the local sweep uses it as a robustness check rather than a second unseen validation set.

The most defensible balanced candidate was:

- 150-minute signal window, 1.60% trend threshold, and 0.20% breakout
- seven-hour cooldown
- SOL 1-hour and 4-hour EMA(8/21) direction plus BTC 1-hour EMA(8/21) confirmation
- 10% TP ROE, 7% SL ROE, and 3.5% target-wallet risk
- adaptive 1.25–4x leverage, quality exponent 2, ATR volatility penalty 0.75, and 0.70 post-loss stepdown

It was positive in all four development folds under both cost models. Development stress produced 27 wins and 21 losses, a +29.23% median fold, a +0.61% worst fold, and 19.14% worst drawdown. The reserved-period stress replay returned +7.70% with three wins and two losses and 7.98% drawdown. Across the continuous 18.5-month stress replay it returned +99.98%, recorded 28 wins and 20 losses (58.33%), had a 1.75 profit factor, 19.28% maximum drawdown, +1.22% median complete month, and -7.16% worst month. Average realized leverage was only 1.35x.

| Continuous stressed result | Prior adaptive leader | Expanded balanced candidate |
|---|---:|---:|
| Return | +98.30% | +99.98% |
| Wins / losses | 52 / 44 | 28 / 20 |
| Win rate | 54.17% | 58.33% |
| Profit factor | not selection-defining | 1.75 |
| Maximum drawdown | 20.50% | 19.28% |
| Median month | +4.32% | +1.22% |
| Worst month | -6.21% | -7.16% |

A higher-return candidate used a 120-minute window, 1.75% trend, 0.30% breakout, five-hour cooldown, EMA(9/21), SOL 4-hour plus BTC 1-hour confirmation, TP 5%, SL 10%, 5% wallet risk, and adaptive 1.5–3x leverage. It returned +141.32% stressed with 26 wins and 11 losses (70.27%), a 2.16 profit factor, and +10.64% in the reserved stress period. Its tradeoff was 23.38% drawdown, a -12.67% worst month, only three profitable stressed development folds, and greater nearby-parameter sensitivity. It is therefore an aggressive research candidate, not the preferred balanced candidate.

The expanded balanced setup improves win rate and drawdown modestly, but not the median monthly return. Its lower trade count and parameter sensitivity still require fresh future shadow data before production use. It is a better historical balance, not a guarantee or a validated 50% monthly strategy.

### Exact 12-month repeat

The expanded adaptive search was repeated without changing its methodology, candidate budgets, starting balance, cost models, development-only ranking, or later confirmation rules. The only change was the analysis horizon: the 12 complete months from July 1, 2025 through June 30, 2026. Four development folds covered July 2025 through March 2026; April through June 2026 remained the later confirmation period. The broad and local stages each evaluated 4,096 configurations. The local stage produced 124 development-qualified and 31 later-confirmed configurations. Automated verification confirmed that every continuous result contains exactly 12 monthly observations.

The most defensible balanced 12-month candidate used:

- 120-minute signal window, 1.50% trend threshold, and 0.30% breakout
- seven-hour cooldown
- SOL 1-hour and 4-hour EMA(9/21) direction plus BTC 1-hour and 4-hour confirmation
- 7% TP ROE, 10% SL ROE, and 4% target-wallet risk
- adaptive 1–4x leverage, quality exponent 1.4, ATR volatility penalty 1.0, and 0.85 post-loss stepdown

It was profitable in all four development folds under both cost models. Development stress recorded 14 wins and six losses, a +12.50% median fold, a +7.95% worst fold, and 16.53% worst drawdown. The later stressed confirmation returned +17.87% with three wins, no losses, and 3.56% drawdown. Across the continuous 12-month stressed replay, $100 ended at **$155.38**: +55.38%, 16 wins and seven losses (69.57%), a 1.93 profit factor, 17.45% maximum drawdown, +5.13% median month, and -7.75% worst month. Average realized leverage was 1.34x.

The highest-return confirmed continuous result used a 135-minute window, 1.50% trend, 0.25% breakout, eight-hour cooldown, EMA(8/21), SOL 4-hour plus BTC 1-hour and 4-hour confirmation, 10% TP, 7% SL, 5% wallet risk, and adaptive 1.5–4x leverage. It produced:

| 12-month metric | Baseline costs | Stressed costs |
|---|---:|---:|
| Ending value from $100 | $225.28 | $201.40 |
| Cumulative return | +125.28% | +101.40% |
| Wins / losses | 17 / 7 | 17 / 7 |
| Win rate | 70.83% | 70.83% |
| Profit factor | 4.19 | 3.45 |
| Maximum drawdown | 15.53% | 16.66% |
| Median month | +7.02% | +6.16% |
| Worst month | -4.36% | -4.77% |

This higher-return candidate was positive in every development fold and returned +14.91% stressed in the later period with three wins and one loss. It nevertheless has only 24 continuous trades, only seven positive stressed months, and was selected from thousands of configurations. Its +101.40% is a **12-month cumulative** result, not a monthly return. It should be treated as a regime-sensitive research candidate, not a production setting or evidence of repeatability.

A lower-drawdown alternative used a 150-minute window, 1.50% trend, 0.25% breakout, eight-hour cooldown, EMA(8/21), SOL 4-hour plus BTC 1-hour confirmation, 5% TP/SL, 4% wallet risk, and adaptive 1–3x leverage. Its continuous stressed result was +47.01%, 16 wins and 13 losses, a 1.85 profit factor, 13.33% maximum drawdown, +4.00% median month, and -3.24% worst month. This is the safer of the three historically, but its win-rate margin is much narrower.

The 12-month winner differs from the 18.5-month winner. That divergence is important evidence of regime and start-date sensitivity, not a reason to discard the longer test. The balanced 12-month setup is the cleaner candidate for prospective shadow testing; the +101.40% setup is the higher-return hypothesis. Neither should replace production parameters without untouched future results and live execution reconciliation.

### Aggressive high-win extension

An 8,192-candidate aggressive sweep and a separate 8,192-candidate neighborhood sweep expanded wallet-risk labels to 10%, adaptive leverage ceilings to 10x, TP to 18%, SL to 18%, trend thresholds to 2.2%, and cooldowns to ten hours. Development qualification required at least a 60% win rate under baseline and stressed costs, at least three profitable folds, no worse than -12% in the weakest stressed fold, and no more than 35% stressed development drawdown. The April–June 2026 period remained unseen for the first sweep. It was already inspected before the neighborhood sweep, so the latter is only a sensitivity check.

The highest-return 12-month neighborhood candidate used a 155-minute window, 2.00% trend threshold, 0.35% breakout, seven-hour cooldown, EMA(8/21), SOL 4-hour plus BTC 1-hour and 4-hour confirmation, 15% TP, 15% SL, and adaptive 2–5x leverage with a 2.5 quality exponent, 1.25 ATR penalty, and 0.85 post-loss stepdown. The decision layer reduced realized average leverage to 1.89x.

| Metric | 12-month baseline | 12-month stress | 18.5-month baseline | 18.5-month stress |
|---|---:|---:|---:|---:|
| Return from $100 | +180.06% | +159.50% | +186.96% | +140.88% |
| Wins / losses | 15 / 2 | 15 / 2 | 24 / 10 | 24 / 10 |
| Win rate | 88.24% | 88.24% | 70.59% | 70.59% |
| Profit factor | 8.51 | 7.48 | 2.82 | 2.39 |
| Maximum drawdown | 13.29% | 13.96% | 31.00% | 35.32% |
| Median month | +8.14% | +7.50% | +3.89% | +1.99% |
| Worst month | -8.52% | -8.94% | -13.21% | -13.97% |

This is the strongest aggressive 12-month hypothesis, but not the strongest robust candidate. It had one slightly negative 12-month development stress fold (-0.81%) and failed the extended-history aggressive qualification: the extended development win rate fell to 58.62%, the weakest stress fold was -19.83%, and stressed drawdown rose above 35%. The apparent 12-month improvement is therefore partly regime-dependent.

The strongest strictly robust high-win candidate in the 12-month sweep used a 150-minute window, 2.00% trend, 0.40% breakout, seven-hour cooldown, EMA(10/24), SOL 4-hour plus BTC 1-hour confirmation, 7% TP, 15% SL, and adaptive 1–5x leverage. It was profitable in all development folds and in the later period, recording 13 wins and one loss continuously (92.86%), +89.19% stressed return, a 6.14 profit factor, and 13.45% drawdown. Its win rate improved sharply, but its return did not exceed the prior +101.40% candidate. In this sample, requiring both higher profit and full fold robustness eliminated the apparent aggressive improvement.

The strongest extended-history robust aggressive candidate used a 145-minute window, 1.90% trend, 0.45% breakout, eight-hour cooldown, EMA(10/24), SOL 4-hour plus BTC 1-hour confirmation, 12% TP, 15% SL, and adaptive 2–5x leverage. Across 18.5 months under stress it returned +112.24%, recorded 21 wins and five losses (80.77%), had a 2.90 profit factor, 18.18% drawdown, +5.19% median month, and -9.00% worst month. It passed all development folds and returned +19.98% in the later stress period. However, its exact 12-month replay returned only +42.72% and failed one 12-month stress threshold, demonstrating start-date sensitivity in the opposite direction.

A controlled five-step test increased only the nominal target-wallet-risk field from 5% to 10% on the prior +101.40% setup. Returns, trades, and drawdown were identical at every step because the base allocation and decision layer were already the binding sizing constraints. Consequently, the aggressive search's nominal 6–10% wallet-risk labels are not causal, are above the validated learning-profile schema, and must not be copied into production. Higher historical returns came from entry selectivity, exit geometry, and adaptive leverage. They did not come from raising that field.

The actionable conclusion is a tradeoff rather than a new production setting: the aggressive 155-minute candidate maximized the requested 12-month return/win combination, while the 150-minute candidate preserved fold robustness and the 145-minute candidate was stronger over the longer history. None dominates across both start dates. Prospective shadow testing should freeze these three hypotheses before any live promotion; selecting one now from the inspected history would compound multiple-testing bias.

### 135/155-minute hybrid cross-test

An 8,192-candidate hybrid search crossed the earlier 135-minute +101.40% stressed setup with the aggressive 155-minute +159.50% setup. Midpoints were added for signal window, trend threshold, breakout, cooldown, TP, SL, adaptive-leverage floor and ceiling, quality exponent, volatility penalty, and post-loss stepdown. Their shared EMA(8/21), SOL 4-hour regime, and BTC 1-hour plus 4-hour confirmation remained fixed. The same candidate set was replayed separately over the 12-month and 18.5-month histories.

The highest-return 12-month hybrid retained the 155-minute window, 2.00% trend, 0.35% breakout, and seven-hour cooldown, but changed SL from 15% to 12%, ATR penalty from 1.25 to 1.125, and post-loss stepdown from 0.85 to 0.70. It returned +153.46% stressed with 14 wins and two losses (87.50%), a 9.58 profit factor, 14.07% drawdown, +5.83% median month, and -4.68% worst month. This improved profit factor and worst-month loss relative to the +159.50% parent, but did not increase return. Over 18.5 months it returned +121.14%, had 24 wins and 13 losses, and reached 35.47% drawdown; it failed extended development qualification. It is not the successful cross-period merge.

The strongest cross-period hybrid was:

- 145-minute signal window, 1.65% trend threshold, and 0.35% breakout
- 7.5-hour cooldown
- EMA(8/21), SOL 1-hour plus 4-hour direction, and BTC 1-hour plus 4-hour confirmation
- 10% TP ROE and 10% SL ROE
- adaptive 2–4x leverage, quality exponent 2.5, ATR penalty 1.25, and no mechanical post-loss leverage reduction

| Metric | Hybrid 12-month stress | Hybrid 18.5-month stress |
|---|---:|---:|
| Return from $100 | +100.56% | +165.65% |
| Ending value | $200.56 | $265.65 |
| Wins / losses | 18 / 5 | 33 / 14 |
| Win rate | 78.26% | 70.21% |
| Profit factor | 3.02 | 2.16 |
| Maximum drawdown | 13.06% | 23.07% |
| Median month | +6.13% | +5.97% |
| Worst month | -6.58% | -12.38% |
| Later stress confirmation | +15.93%, 4 / 1 | +15.93%, 4 / 1 |

This hybrid was profitable in all development folds and passed later confirmation under both cost models in both horizon definitions. It does not beat the 155-minute parent's 12-month return; it trails by 58.94 percentage points. It does, however, beat the 155-minute parent over 18.5 months (+165.65% versus +140.88%), lower its extended drawdown from 35.32% to 23.07%, and improve the earlier 135-minute parent's 18.5-month stressed result from +83.22% to +165.65%. It also retains a higher win rate than the earlier 135-minute parent in both continuous comparisons.

The cross-test therefore found a better **merged robustness profile**, not a higher 12-month maximum. Among the inspected candidates, the 145-minute hybrid is the most balanced aggressive hypothesis across both start dates. The later period is no longer unseen after these repeated searches, so this remains a shadow-test candidate rather than production validation.

### Cost and timing sensitivity

For the deployed profile in the sealed period:

| Timing / cost model | Return | PF | Max DD |
|---|---:|---:|---:|
| Next open, observed baseline | -40.49% | 0.89 | 66.57% |
| Signal close, observed baseline | -41.37% | 0.89 | 67.31% |
| Next open, base-fees-only optimistic | -28.14% | 0.93 | 65.24% |
| Next open, conservative | -65.80% | 0.74 | 72.28% |
| Next open, stress | -69.60% | 0.30 | 71.45% |

Only the unrealistic combination of signal-close execution and removal of impact, borrow, and network costs was positive (+26.24%), and it still had a 65.73% drawdown. Under observed costs, timing does not change the conclusion.

### Cross-asset sealed robustness

| Frozen deployed profile | Return | PF | Max DD | Trades / liquidations |
|---|---:|---:|---:|---:|
| SOL | -40.49% | 0.89 | 66.57% | 93 / 14 |
| ETH | -66.29% | 0.60 | 80.49% | 41 / 9 |
| BTC | -11.87% | 0.78 | 40.27% | 12 / 2 |

The failure is not isolated to SOL. These are separate-market diagnostics; the current live configuration only enables SOL.

### Account-size sensitivity

At $1,000 starting capital, the deployed SOL profile lost 96.56% in training and 96.67% in validation. The smaller real account stopped trading sooner because learned sizing eventually produced less than Jupiter's $10 minimum. The minimum collateral hides additional losses; a larger balance does not repair the edge.

### Uncertainty check

A deterministic 20,000-sample circular five-trade block bootstrap of the sealed deployed sequence estimated a 67.38% probability of a non-positive result. The median resampled return was -38.84%; the median and 95th-percentile maximum drawdowns were 74.08% and 94.12%. The return interval is extremely wide because rare liquidations dominate the distribution, which is itself evidence that the estimate is unstable and risk-heavy—not evidence of a dependable upside.

## Recommendations before any further live autonomous use

1. Do not select a new trend/breakout number from this test; none earned promotion.
2. Fix outcome reconciliation using trade/transaction boundaries rather than reusable position addresses, then delete or quarantine contaminated outcomes and retrain from clean records.
3. Make the wallet-risk target real: attach an enforced SL or size against full-collateral liquidation loss. The present 1.6% label is not a 1.6% maximum loss.
4. Implement and enforce the configured daily-loss circuit breaker.
5. Add a fee-aware expected-move/turnover gate. At 45–50x, the current high-frequency TP structure is economically fragile even with many winners.
6. Keep leverage in paper/shadow testing until a revised engine is positive in training, validation, sealed testing, and cost stress with materially lower drawdown. The exploratory 5x result was safer than 50x but still failed sealed testing, so 5x is not yet a validated recommendation.
7. After the deferred Jupiter/Pyth price migration, rerun this same frozen protocol against the new feed; do not transfer Coinbase-calibrated thresholds blindly.

## Limitations

- Historical minute bars cannot reconstruct the exact in-progress candle seen by each live server invocation; next-open and signal-close bracket that uncertainty.
- OHLC bars do not reveal TP/SL ordering inside a minute. The replay uses adverse ordering (liquidation, then SL, then TP).
- Coinbase documents incomplete historical intervals. Repeated refetch confirmed 831–874 sparse minutes per market (~0.10%); they remain gaps rather than fabricated candles.
- Current observed Jupiter impact and borrow rates are used because a complete historical fee-rate series was unavailable. Multipliers are stress-tested, but this is not exact tick-by-tick on-chain reconstruction.
- Operational rejection/retry frequency, Solana congestion, oracle-vs-Coinbase basis, and partial intraminute fills are not probabilistically invented.
- The active profile is static in the replay. Simulating intended online learning would be misleading while production training outcomes are contaminated by reconciliation.
- One 18.5-month history is not proof of future behavior. Backtest multiple-testing risk remains even with a sealed sample; the report rejects, rather than promotes, marginal results.

## Sources

- Jupiter Perpetual Exchange mechanics and fees: https://support.jup.ag/hc/en-us/articles/23283805064860-How-it-works
- Coinbase Exchange historical candles API and incompleteness warning: https://docs.cdp.coinbase.com/api-reference/exchange-api/rest-api/products/get-product-candles
- Bailey et al., *Statistical Overfitting and Backtest Performance*: https://sdm.lbl.gov/oapapers/ssrn-id2507040-bailey.pdf
- Hudson et al., *Technical analysis in cryptocurrency markets: Do transaction costs and bubbles matter?*: https://www.sciencedirect.com/science/article/pii/S1042443122000816
- Corbet et al., *Technical trading and cryptocurrencies*: https://link.springer.com/article/10.1007/s10479-019-03357-1
- CFTC, *Understand the Risks of Virtual Currency Trading*: https://www.cftc.gov/LearnAndProtect/AdvisoriesAndArticles/understand_risks_of_virtual_currency.html
