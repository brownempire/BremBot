# Jupiter/Pyth Price-Feed Migration Plan

Status: Deferred for later implementation
Production changes made: None
Coinbase should remain in place until the staged migration is deliberately started.
## Objective

Move BremLogic's trading-authoritative market data from Coinbase to the same pricing family used by Jupiter Perpetuals. The intended final state is:

- Jupiter Perps supplies current market, position, and executable-order pricing.
- The exact Pyth oracle feeds configured by Jupiter's on-chain custody accounts supply historical and streaming price data.
- Signals, indicators, widgets, position displays, notifications, charts, training, and backtests use the same source family.
- Coinbase is removed only after the replacement has passed shadow validation.
- If Jupiter/Pyth data is unavailable or stale, autonomous trading fails closed and skips the trade. It must never use simulated prices or an unrelated exchange feed to authorize a live order.

This migration can remove Coinbase-versus-Jupiter price discrepancies. It cannot guarantee that a candle-close price and the eventual execution price are identical because the market and oracle may update while the signal is evaluated and the Solana transaction is built and submitted.

## Why this is deferred rather than performed as a hard cutover

The current system relies on Coinbase for more than a single ticker value. A direct removal could silently change indicator behavior, eliminate required candle fields, interrupt charts or widgets, invalidate learned profiles, increase upstream traffic, or stop server-side automation.

The safer long-term choice is Jupiter/Pyth, but the safer implementation method is a dual-feed migration with measurable acceptance gates.

## Current Coinbase dependencies to replace

- Autonomous agent one-minute candles
- Trend, breakout, and short-momentum calculations
- EMA, RSI, MACD, ADX/DMI, ATR, volume, and Bollinger inputs
- Live dashboard price cards and 24-hour change
- Client-side signal history
- Push signal scanning
- Widget price and expected-PnL calculations
- Position mark-price fallback/enrichment
- TradingView `COINBASE:*` symbols
- Market-selection identifiers and the Coinbase market-list route
- Coinbase-specific source labels and error messages
- Backtest datasets and assumptions

Special attention is required in `lib/jupiterPerps.ts`: direct-RPC position fallbacks currently enrich/replace mark prices with Coinbase ticker prices. Jupiter's own `markPriceUsd` should ultimately remain authoritative.

## Target pricing architecture

### 1. Jupiter current mark price

Use the Jupiter Perps market statistics endpoint for current BTC, ETH, and SOL Perps market prices. Use Jupiter position responses for position mark price, PnL, liquidation price, and fees whenever those fields are available.

### 2. Verified Jupiter oracle mapping

Read and verify the oracle accounts configured in Jupiter's live on-chain custody records. Do not assume that a generic BTC/USD, ETH/USD, or SOL/USD feed is necessarily the exact feed Jupiter uses.

Store the verified mapping, program/version information, price exponent, confidence data, and publish timestamp. Revalidate it when Jupiter changes its program or custody configuration.

### 3. Pyth historical and streaming data

Use the verified Pyth feeds for completed one-minute OHLC candles and live oracle updates. All data access should pass through BremLogic's backend so API credentials are never shipped in the web app, native app, or widget.

The implementation must account for Pyth authentication changes scheduled in July and August 2026. Configure a server-only API key from the beginning rather than relying on temporary unauthenticated access.

### 4. Fresh Jupiter executable quote

Immediately before signing an order, use Jupiter's returned quote fields, including:

- `averagePriceUsd`
- `priceImpactFeeBps`
- `priceImpactFeeUsd`
- `openFeeUsd`
- `liquidationPriceUsd`
- Final position size, collateral, and leverage

Compare the fresh executable quote with the price that generated the signal. If the quote is stale, missing, or outside a bounded divergence tolerance, reject or rebuild the order. Do not blindly submit it.

### 5. Server-side cache and canonical timestamps

Fetch and cache current data server-side so multiple phones, browsers, widgets, cron invocations, and server functions do not independently hammer upstream APIs. Every response should include source, feed ID, publish timestamp, retrieval timestamp, confidence, and freshness status.

## Volume decision

Coinbase candles contain Coinbase exchange volume. Pyth oracle prices do not represent the same volume series, and Jupiter's 24-hour Perps volume is not a one-for-one replacement.

Before switching production, choose and validate one of these approaches:

1. Derive minute activity from Jupiter Perps volume snapshots stored in Redis.
2. Replace exchange-volume confirmation with Jupiter-specific Perps volume, pool liquidity, utilization, borrow rates, and price-impact conditions.
3. Temporarily make volume scoring optional until enough Jupiter-specific history has accumulated.

Do not append Jupiter-derived observations to Coinbase-volume learning history as though they were the same feature. Version the feature definition.

## Learning-profile and data versioning

Existing outcomes and profiles were generated from Coinbase-derived inputs. The migration must introduce an explicit market-data version, for example:

- `coinbase-v1`
- `jupiter-pyth-v1`

Training must not mix incompatible feature histories without an intentional normalization study. Preserve the old profile for audit and rollback, create a new candidate profile for Jupiter/Pyth, and require the normal minimum sample and chronological validation rules before promotion.

Thresholds such as trend percentage, breakout percentage, RSI ranges, ADX minimums, volume ratios, and volatility ceilings must be revalidated because their observed distributions may change with the candle source.

## Staged rollout

### Phase 1: Provider abstraction

- Introduce a source-neutral market-data interface for live prices, completed candles, market statistics, and freshness metadata.
- Keep Coinbase as the active production provider.
- Add contract tests so callers cannot silently receive incomplete or stale data.
- Remove assumptions that market identifiers are Coinbase product IDs.

### Phase 2: Dual-feed collection

- Fetch Coinbase and Jupiter/Pyth in parallel without changing trade decisions.
- Store timestamp-aligned comparisons for at least 7-14 days.
- Measure price divergence, candle OHLC differences, missing bars, latency, staleness, confidence intervals, and API failure rates.
- Measure differences in trend, breakout, EMA, RSI, MACD, ADX/DMI, ATR, Bollinger, volume-related features, indicator score, and candidate direction.

### Phase 3: Full shadow decisions

- Run the complete signal and learning engine independently on both providers.
- Coinbase remains production-authoritative.
- Jupiter/Pyth decisions are recorded but cannot submit transactions.
- Compare signal counts, agreement rate, skipped-trade reasons, hypothetical outcomes, and cost-adjusted performance.

### Phase 4: Jupiter/Pyth becomes trading-authoritative

- Switch signal generation and indicator calculations to Jupiter/Pyth.
- Require valid freshness, confidence, and candle-completeness checks.
- Revalidate every order against Jupiter's executable quote.
- Pause live automation when authoritative data is stale or unavailable.
- Disable simulated price fallback anywhere it could influence live execution.
- Retain Coinbase temporarily only as a diagnostic comparison source.

### Phase 5: Backtest and retrain

- Run the comprehensive backtest against the exact new source and production decision path.
- Include fees, price-impact fees, funding/borrow costs, transaction latency, rejected orders, and liquidation behavior as accurately as the available history permits.
- Use chronological walk-forward validation and an untouched test period.
- Establish new asset-specific thresholds and a new source-versioned learning profile.

### Phase 6: Remove Coinbase

After all acceptance gates pass, remove Coinbase fetchers, routes, identifiers, chart symbols, error messages, fallback enrichment, documentation, and shadow comparison code.

## Chart migration

The existing TradingView component uses `COINBASE:*` symbols. Eliminating Coinbase completely may require a custom TradingView-compatible Pyth data feed or a different chart component; it is not guaranteed to be a simple symbol rename.

Verify licensing, authentication, streaming reconnect behavior, background/foreground behavior on iOS, candle alignment, and Mac/iPhone rendering before removing the existing chart path.

## Required failure behavior

- Stale or incomplete authoritative candle data: no signal and no trade.
- Stale or missing current mark: no new live trade.
- Missing or invalid executable quote: no signing.
- Excessive signal-to-quote divergence: rebuild once within a strict bound or skip.
- Pyth/Jupiter authentication or rate-limit failure: back off and skip; never simulate a live decision.
- Missing volume data: explicitly mark the feature unavailable; never substitute zero as though it were real volume.
- Feed ID, exponent, or custody mapping mismatch: halt that asset until verified.

Display-only components may show a clearly labeled cached value, but cached or fallback display data must never authorize an autonomous transaction.

## Acceptance gates before removing Coinbase

- Exact Jupiter custody-to-Pyth feed mapping independently verified
- Completed-candle timestamp and timezone alignment verified
- No look-ahead use of incomplete candles
- Price decimals, exponents, and confidence intervals tested
- At least 7-14 days of dual-feed reliability data
- Defined acceptable divergence and signal-agreement thresholds
- No live decisions produced by simulated fallback data
- Server-side cache and rate-limit handling verified under multiple devices
- Widget, chart, push scanner, and background monitor tested
- Learning histories correctly separated by source version
- Walk-forward backtest completed using Jupiter/Pyth data
- Production-like shadow run completed without unexplained decisions
- Rollback path tested
- Independent second-pass review of calculations, tests, and data accounting completed

## Backtest sequencing

Perform the extensive parameter backtest after this migration is validated. Backtesting Coinbase-derived signals and then changing the production feed would reduce the relevance of the findings.

The backtest should keep the existing Coinbase configuration as a comparison control, but the primary recommendation should come from the same Jupiter/Pyth-aligned data path that will run in production.

## Expected environment/configuration needs

Names should be finalized during implementation, but likely server-only configuration includes:

- Pyth API/access token
- Explicit market-data provider version
- Freshness and maximum confidence limits
- Signal-to-executable-quote divergence tolerance
- Cache duration and historical-candle retention
- Dual-feed shadow-mode switch
- Fail-closed live-trading switch

No Pyth or Jupiter credential should be exposed through `NEXT_PUBLIC_*` variables.

## Final recommendation

Do not make a hard Coinbase removal. When this work resumes, implement the provider abstraction and dual-feed validation first. The intended final production state should use Jupiter/Pyth as the sole trading-authoritative source, with autonomous trading paused whenever that source cannot be trusted.
