# BremLogic Non-Custodial Perps Agent

## Summary
- Every automated Perps action is scoped to the authenticated user's wallet.
- BremLogic never stores the primary wallet's private key.
- Live mode supports either primary-wallet approval or a separately funded, associated agent wallet whose signer is configured server-side.
- Manual spot trading and manual Perps flows remain user-signed.

## Wallet Paths
- Native app: Jupiter Mobile WalletConnect/AppKit flow.
- Web/PWA: existing wallet auth/sync path remains available for user identity and paper mode.
- Web/PWA live Perps automation is not yet delegated-capable, so live mode fails closed there.

## Clock In / Clock Out
- `Clock In` creates a user-scoped session record after wallet-signed auth.
- The session stores mode, execution model, heartbeat state, wallet address, kill switch state, and timestamps.
- `Clock Out` ends the session immediately.
- The session also ends when the app backgrounds, becomes hidden, the wallet disconnects, or the auth/session becomes invalid.

## Execution Models
- `approval-assisted`: the app prepares a Perps action for the authenticated primary wallet and requests its signature.
- `delegated-ready`: the primary wallet authenticates the session, while a separately funded agent wallet owns and signs its own Jupiter positions. The panel aggregates both wallets and routes mutations to the actual position owner.

## Agent Wallet Configuration
- `PERPS_AGENT_OWNER_WALLET`: primary wallet address used for BremLogic authentication.
- `PERPS_AGENT_WALLET_PUBLIC_KEY`: separately funded wallet that owns autonomous Jupiter positions.
- `PERPS_AGENT_WALLET_PRIVATE_KEY`: server-only base58 secret key or JSON secret-key byte array matching the public key.
- `PERPS_AGENT_WALLET_ASSOCIATIONS`: optional JSON owner-to-agent map. The configured signer must still match the resolved agent address.
- `PERPS_LIVE_ALLOWED_WALLETS` and `NEXT_PUBLIC_PERPS_LIVE_ALLOWED_WALLETS` should contain the primary wallet address.

The private key must be stored in the deployment provider's encrypted server environment and must never be committed, logged, returned by an API, or placed in a `NEXT_PUBLIC_` variable. Keep only capped trading collateral and transaction-fee SOL in the agent wallet.

## Ownership Limitation
- Agent positions remain owned on-chain by the agent wallet; the association does not transfer ownership to the primary wallet.
- Jupiter's own UI shows the currently connected wallet. BremLogic's Perps panel is responsible for combining primary and agent data.
