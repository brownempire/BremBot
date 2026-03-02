# BremBot Auto-Trading Implementation Plan

This document describes how to extend BremBot from **signal generation + manual Jupiter swaps** into **guardrailed automatic execution**.

## Current state (what already exists)

- Signals are produced client-side via `detectSignals(...)` using trend, breakout, and news sentiment inputs.
- The dashboard currently uses the Jupiter plugin widget for wallet-linked swaps and records successful trades in local storage.
- Push notifications are already wired, which can be reused for "order placed / failed" alerts.

## Goal state

When a signal is emitted, BremBot should be able to:

1. decide whether the signal is eligible for trading,
2. size the order,
3. request a Jupiter route,
4. submit the transaction with strict risk checks,
5. track fills and update position/risk state,
6. enforce cooldown/daily loss/session limits.

## Recommended architecture

### 1) Move execution to a trusted server process

Do **not** auto-submit swaps from browser UI code. Keep signal visualization in UI, but execute trades from a backend worker with:

- strategy config,
- risk state,
- idempotency store,
- order/trade journal.

A practical split:

- `signal-engine` (existing logic, made reusable on server),
- `execution-service` (Jupiter quote+swap + Solana send/confirm),
- `risk-service` (limits + position checks),
- `scheduler/stream` (price ingestion + trigger loop).

### 2) Convert signals into executable intents

Create a strict mapping layer:

- `bullish` -> buy base asset / reduce short,
- `bearish` -> sell base asset / reduce long,
- confidence threshold (example: >= 0.72),
- minimum notional (avoid dust trades),
- maximum slippage per market condition.

Use one canonical `TradeIntent` model:

- `symbol`,
- `side`,
- `notionalUsd`,
- `maxSlippageBps`,
- `signalId`,
- `expiresAt`.

### 3) Add hard risk controls before every order

Block order placement unless all checks pass:

- wallet exposure cap per asset,
- max concurrent positions,
- stop-after-N-losses,
- max daily drawdown,
- cooldown per market (already conceptually present for signaling),
- stale-price guard (quote timestamp freshness),
- route sanity checks (price impact, min out, token allowlist).

### 4) Introduce a "paper mode" first

Run identical pipeline with execution disabled:

- capture intents,
- store theoretical fills from quote snapshots,
- compute PnL + slippage + hit-rate.

Promote to real trading only after acceptance criteria are met (e.g., 2+ weeks of stable paper results).

### 5) Add reliable order lifecycle handling

For each intent:

1. create idempotency key (`signalId + side + time bucket`),
2. request quote,
3. validate risk + route,
4. submit swap transaction,
5. confirm transaction,
6. persist terminal status: `filled | failed | cancelled`.

Always persist raw transaction signature and reason codes for failed attempts.

### 6) Make execution observable

Log and alert for:

- signal -> intent conversion,
- rejected-by-risk reasons,
- quote latency,
- send/confirm latency,
- realized slippage,
- PnL and drawdown.

Reuse existing push infrastructure for critical alerts:

- "auto-trade placed",
- "risk halt triggered",
- "RPC degraded / confirmation timeout".

## Security model options

### Option A: Dedicated hot wallet (simpler, higher key risk)

- keep minimal balances,
- strict withdrawal policy,
- encrypted key material + rotation + access audit.

### Option B: External signer service / HSM / custody (preferred for scale)

- unsigned transaction assembled by execution-service,
- signing delegated to managed secure signer,
- clear authorization boundary and better key controls.

## Suggested rollout phases

1. **Phase 1:** server-side signal worker + paper trading ledger.
2. **Phase 2:** live mode with tiny notional + conservative limits.
3. **Phase 3:** adaptive sizing and portfolio-level risk controls.
4. **Phase 4:** multi-market orchestration and strategy versioning.

## Minimal implementation checklist

- [ ] Extract signal engine into shared server-compatible module.
- [ ] Add `TradeIntent` and risk-rule evaluation module.
- [ ] Build execution worker for Jupiter quote/swap flow.
- [ ] Add persistent DB tables: `signals`, `intents`, `orders`, `fills`, `risk_events`.
- [ ] Implement idempotency + retry policy.
- [ ] Add paper/live mode toggle and environment gating.
- [ ] Add dashboards/alerts for risk and execution health.
- [ ] Add kill switch (`AUTO_TRADING_ENABLED=false`) checked at runtime.

## Operational note for different-device development

When working from a different device/session, validate GitHub remote auth/connectivity before pushing any auto-trading changes:

```bash
git remote -v
git ls-remote --heads origin
```

If `git ls-remote` succeeds, remote connectivity and auth are in a good state for that session.
