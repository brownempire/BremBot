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
- Without live keys, the dashboard runs on a simulated price feed and mock news stream.
- Push notifications require VAPID keys and a secure origin (localhost is OK).
- Chainlink backup feed integration is stubbed and ready for RPC/aggregator wiring.
- Wallet connect and trading are powered by Solana Wallet Adapter + Jupiter Plugin.

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

## Roadmap
- Integrate Chaos Edge REST/WebSocket feed
- Fetch Chainlink data feeds on Ethereum + Solana
- Social/news ingestion from X with sentiment scoring
- Persist user parameters and subscriptions
