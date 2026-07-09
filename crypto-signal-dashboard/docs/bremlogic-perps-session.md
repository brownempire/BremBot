# BremLogic Non-Custodial Perps Agent

## Summary
- Every automated Perps action is scoped to the authenticated user's wallet.
- BremLogic does not store user private keys on the backend.
- Live mode is approval-assisted today, not delegated signing.
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
- `approval-assisted`: supported now. The app prepares a Perps action for the authenticated user and executes it through the user's own wallet session.
- `delegated-ready`: reserved for future non-custodial session authorization support.

## Current Limitation
- True unattended Perps execution is not implemented because the current Jupiter/Solana wallet path does not expose a safe delegated signing model in this repo.
- The code is structured so a future delegated/session authorization adapter can be added without changing the Clock In / Clock Out UX.
