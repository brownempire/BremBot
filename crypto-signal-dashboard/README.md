# PulseSignal (Crypto Signal Dashboard)

## Quick start

1. Install dependencies

```
npm install
```

2. Create `.env.local`

```
cp .env.local.example .env.local
```

3. Run the app

```
npm run dev
```

## Notes
- Live price priority is: `Chaos Edge -> Coinbase`.
- Trading remains Solana-native (wallet, balances, and swaps use Solana + Jupiter; BTC/ETH are handled as Solana wrapped assets through Jupiter routes).
- Push notifications require VAPID keys and a secure origin (localhost is OK).
- Wallet connect and trading are powered by Solana Wallet Adapter + Jupiter Plugin.
- The read-only Jupiter Perps widget uses Phantom's official mobile deeplink connect flow on supported mobile devices and returns users to BremLogic after approval.
- Signal-driven Perps automation now uses a non-custodial `Clock In / Clock Out` agent model with explicit `Disconnected`, `Connected`, `Clocked In`, `Clocked Out`, `Paper mode`, and `Live mode` session labels in the UI.

## Hidden UI Notes
- The `Jupiter Perps` panel is intentionally kept visually minimal in-app, but its behavior is:
  - Connect a Solana wallet to view Jupiter Perps positions.
  - Native Jupiter Mobile sessions can also submit a full close request.
- Native iOS Jupiter connect flow:
  - BremLogic native app is configured to use a native WalletConnect/AppKit Jupiter flow.
  - Selecting Jupiter should route through Jupiter Mobile and return to BremLogic once the wallet approval finishes.
  - The native connect button uses the native iOS WalletConnect/AppKit Jupiter path.
  - Approve in Jupiter Mobile, then return to BremLogic so the session can finalize there.
  - Adapter label: `Jupiter Mobile`.
- Open-state explanatory copy saved from the panel:
  - `Connect a Solana wallet`
  - This panel primarily reads positions.
  - Native Jupiter Mobile sessions can also submit a full close request with an explicit wallet signature.
- Recent-trades empty-state copy saved from the panel:
  - Closed positions and trigger fills will appear there after Jupiter records them on-chain.
- Perps data-source note saved from the panel:
  - Data source is Jupiter's live Perps API for positions and trade history, with direct Solana RPC account reads kept as a fallback.
  - Liquidation marked `est.` is derived from current on-chain position value and collateral when Jupiter's decoded liquidation field is unavailable.
  - Close requests use Jupiter's live Perps API transaction builder and still require an explicit wallet signature.

### Generate VAPID keys
```
npx web-push generate-vapid-keys
```

Paste generated values into `.env.local`:
- `NEXT_PUBLIC_VAPID_PUBLIC_KEY`
- `VAPID_PUBLIC_KEY`
- `VAPID_PRIVATE_KEY`
- `VAPID_SUBJECT`

For local Jupiter plugin rendering, keep:
- `NEXT_PUBLIC_IS_PLUGIN_DEV=true`

For live feed setup:
- set `CHAOS_EDGE_API_KEY` and three `CHAOS_EDGE_FEED_*` ids
- set `NEXT_PUBLIC_SOLANA_RPC_URL` for wallet balance sync / Jupiter connection
- set `NEXT_PUBLIC_REOWN_PROJECT_ID` to enable Jupiter's official Mobile Adapter flow inside the native iOS shell
- optionally set `NEXT_PUBLIC_PHANTOM_REDIRECT_URL` if you want a fixed post-approval callback URL instead of the current page

## Perps Automation
- `POST /api/perps/session/clock-in` starts a user-scoped Perps agent session after wallet-signed auth.
- `POST /api/perps/session/clock-out` stops the session immediately.
- `GET/PATCH /api/perps/session/status` reads and heartbeats the active user session.
- `POST /api/perps/agent/execute` routes a signal only for the authenticated user wallet.
- `GET/PATCH /api/perps/executions` returns and updates recent execution records for the authenticated user only.
- `GET/PATCH /api/perps/kill-switch` reads or overrides the runtime kill switch.
- `GET /api/perps/portfolio` combines the authenticated primary wallet and its associated agent wallet positions.
- `POST/PATCH/DELETE /api/perps/agent/tpsl` manages an agent-owned position's TP/SL with the server-side agent signer.
- `POST /api/perps/agent/close` closes an agent-owned position after verifying the primary-to-agent association.
- `GET/PUT /api/perps/automation/config` syncs the authenticated wallet's automation settings to Redis with atomic revisions, preventing stale devices from overwriting newer settings.
- `GET /api/perps/automation/run` is the `CRON_SECRET`-protected once-per-minute Vercel worker.
- Active iPhone Live Activities register an ActivityKit token with the server. The worker uses Redis plus the configured `APNS_*` credentials to update Entry, Mark, TP, SL, and PnL through APNs at most once every five minutes, and ends obsolete position activities.
- `GET /api/perps/automation/status` reports the most recent server monitor result for the authenticated wallet.
- `GET/POST /api/perps/training` reads the active wallet-scoped learning profile or reconciles closed Jupiter trades and trains a new version. Profiles and fee-aware outcomes are durable in Redis; failed holdout candidates are retained for audit but never replace the active profile.
- Paper mode simulates user-scoped Perps actions without moving funds.
- Live mode is `approval-assisted` unless an associated agent wallet and matching server-only signer are configured. With an agent wallet, approved signals execute autonomously and the Perps panel combines both wallets while preserving actual position ownership.
- `PERPS_LIVE_ALLOWED_WALLETS` can restrict live Perps automation to specific wallet addresses only.
- Approval-assisted sessions stop after the configured foreground heartbeat timeout. Agent-wallet sessions and their Redis-backed monitor configuration remain active with the app closed until Clock Out, disabling Perps auto-trade, the kill switch, or another guardrail stops execution.
- Agent credentials belong only in server environment variables: `PERPS_AGENT_OWNER_WALLET`, `PERPS_AGENT_WALLET_PUBLIC_KEY`, and `PERPS_AGENT_WALLET_PRIVATE_KEY`. Never expose the private key through a `NEXT_PUBLIC_` variable.
- Redis is authoritative for wallet master controls. Authenticated devices refresh on app open, foreground return, and every 30 seconds; browser storage is only a wallet-scoped cache.
- The upgraded Train Agent flow starts with the operator-selected 15-minute / 0.14% trend / 0.19% breakout / 180-second cooldown / 80% allocation / 25% starting TP / no agent-generated SL / 50x leverage baseline. Runtime protection may raise the TP when fees, volatility, and the required reward/risk ratio demand it, while the ATR-derived risk reference continues to constrain learned allocation. Manual retraining resets to that baseline and reapplies available closed outcomes through bounded online learning. At 50 closed trades, a chronological after-fee validation pass is required before promoting a fully learned profile. The server attempts at most one automatic retraining cycle per day.
- Autonomous Perps trade and exposure guardrails evaluate the selected collateral allocation against the agent wallet's live available USDC. Leveraged notional is controlled separately by `PERPS_MAX_LEVERAGE`; the fixed `PERPS_ASSUMED_CAPITAL_USD` value applies only to the legacy webhook/paper engine.
- Confirmed entry-parameter rejections use a duplicate-safe three-attempt ladder: configured collateral/leverage, then 75%, then 50%. Build-time or explicit HTTP 400/422 parameter failures may retry; timeouts, missing transaction IDs, and other ambiguous submission results stop immediately. Bundled TP/SL still falls back to deferred protection, which has its own three attachment attempts.
- Production also requires a server-only `CRON_SECRET`; Vercel sends it to the configured cron route as a bearer token.
- See [docs/bremlogic-perps-session.md](/Users/lyrastudio/Documents/BremBot/crypto-signal-dashboard/docs/bremlogic-perps-session.md:1) for the architecture and limitations.

## Roadmap
- Integrate Chaos Edge REST/WebSocket feed
- Add Solana-native oracle fallback option (if needed)
- Social/news ingestion from X with sentiment scoring
- Persist user parameters and subscriptions
