# BremLogic Comprehensive Backtest
This directory contains an isolated research harness for commit
`ba6ec3fcf8eb787931a364cbdf1c3f74c47dfa55`.

It must not import wallet credentials, write Redis, submit transactions, alter
production configuration, or change application code. Generated market data and
results are ignored by Git.

## Frozen primary control

- Asset currently active in production: SOL
- Trend window: 15 completed one-minute candles
- Form parameters: 0.14% trend, 0.19% breakout, 180-second cooldown
- Active learned SOL parameters: 0.149% trend, 0.181% breakout
- Wallet allocation: 80%
- Configured leverage: 50x
- Execution mode: Smart Trades / Active / Aggressive
- Direction: long and short
- Starting-capital scale: 115.480621 USDC
- Active profile version: 8, trained incrementally from seven recorded outcomes

BTC and ETH runs are counterfactual tests using the same engine and clearly
identified as such; they are not represented as currently active production
markets.

## Primary anti-bias rules

- Indicators and signals use only candles whose close time is available at the
  simulated decision timestamp.
- A signal observed at a completed candle close enters no earlier than the next
  candle open in the primary execution model.
- If TP and liquidation/SL are both touched in one candle and intrabar ordering
  is unknowable, the primary model uses the adverse outcome. Optimistic ordering
  is reported only as a sensitivity case.
- Parameter selection never sees the untouched test segment.
- Learning and promotion are replayed chronologically; future outcomes cannot
  affect past decisions.
- Fees are charged separately from price PnL and are never double-subtracted.
- Open positions block new positions, matching the server monitor.
- Results always disclose open/unresolved positions at the end of a period.

## Known parity limitation

The production Coinbase fetcher can include the still-forming current minute.
Historical OHLC data cannot reconstruct the partial candle visible at an
arbitrary Vercel cron second. The primary backtest therefore uses completed
candles. An explicitly labeled close-entry sensitivity case is used to bound the
effect, and this live/backtest mismatch is retained as an audit finding.
