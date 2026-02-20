# PulseSignal (Crypto Signal Dashboard)

## Quick start

1. Install dependencies

```
npm install
```

2. Create `.env.local`

```
# Chaos Edge (primary feed)
NEXT_PUBLIC_CHAOS_EDGE_URL=
NEXT_PUBLIC_CHAOS_EDGE_TOKEN=

# Chainlink (backup oracle RPCs)
NEXT_PUBLIC_ETHEREUM_RPC_URL=
NEXT_PUBLIC_SOLANA_RPC_URL=

# Push notifications (VAPID)
NEXT_PUBLIC_VAPID_PUBLIC_KEY=
VAPID_PUBLIC_KEY=
VAPID_PRIVATE_KEY=
VAPID_SUBJECT=mailto:you@example.com
```

3. Run the app

```
npm run dev
```

## Notes
- Without live keys, the dashboard runs on a simulated price feed and mock news stream.
- Push notifications require VAPID keys and a secure origin (localhost is OK).
- Chainlink backup feed integration is stubbed and ready for RPC/aggregator wiring.

### Generate VAPID keys
```
npx web-push generate-vapid-keys
```

## Roadmap
- Integrate Chaos Edge REST/WebSocket feed
- Fetch Chainlink data feeds on Ethereum + Solana
- Social/news ingestion from X with sentiment scoring
- Persist user parameters and subscriptions
