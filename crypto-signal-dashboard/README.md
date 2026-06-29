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
- optionally set `NEXT_PUBLIC_PHANTOM_REDIRECT_URL` if you want a fixed post-approval callback URL instead of the current page

## Roadmap
- Integrate Chaos Edge REST/WebSocket feed
- Add Solana-native oracle fallback option (if needed)
- Social/news ingestion from X with sentiment scoring
- Persist user parameters and subscriptions
