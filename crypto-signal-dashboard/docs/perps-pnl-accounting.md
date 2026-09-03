# Perps PnL presentation

All presentation consumers use `lib/perps/pnlAccounting.ts`. Trading entry,
profit-lock and stop execution policy are unchanged by this display update.

## Open positions

The chart, position cards, widgets, Live Activities and wallet open subtotal
share an estimated **net if closed now** value. It uses the live fee-bearing
PnL baseline, the reconciled opening-funding adjustment and wallet-paid native
fees, then reserves remaining closing/swap/impact/transaction costs. The
remaining-cost allowance is conservative, not an executable closing quote.
Accrued holding/borrowing is retained in the live baseline; an arbitrary future
holding duration is not assumed. Gross-only RPC/portfolio fallbacks display
unavailable net PnL because they cannot supply accrued borrowing costs.

ROE uses actual wallet funding when reconciled, otherwise reported collateral.
Widgets aggregate positions in their displayed market, matching that market's
chart; they do not display a single position's TP/SL for a combined total.
The server snapshot is briefly shared/cached, but OS widget refresh scheduling
can still show an older sample than the foreground app.

## Closed positions

For USDC-funded/settled episodes, reconciliation totals exact wallet token
debits and credits across finalized position-related transactions, then
subtracts actual wallet-paid native transaction/priority fees and tips. Protocol
open/close/borrowing charges and swap effects are already reflected in the cash
movements; subtracting API fee fields again would double-count them. Keeper-paid
fees and refundable rent deposits are not trading expenses.

Native fees remain recorded in SOL and are valued in USD using historical
SOL/USD at settlement (the SOL execution price for SOL trades). That USD
valuation is a conversion convention, not an additional fee or an actual USDC
debit. USDC is valued at $1.

One position episode includes scale-ins and partial exits; it emits one final
realized amount at full closure. Reused position addresses begin new episodes.
Opening events therefore never appear as separate realized losses in the wallet
graph. Unsupported non-USDC token settlements, ambiguous multi-position cash
movements, missing opening history and incomplete receipts remain explicitly
reconciling rather than falling back to rounded API PnL or estimated fees.
Wallet charts label incomplete history as a subtotal.

Receipt pagination and results are cached under the new accounting namespace.
Rate-limited/incomplete audits resume on refresh. Immediate exit notifications
may say reconciling; a final PnL notification is queued until accounting is ready
and delivery succeeds. No historical push notifications are generated merely
by backfilling old accounting records.

## Verification

The September 2 reference SOL long reconciled all 13 actual related transactions:
12 USDC paid, 12.398630 USDC returned, 0.000056755 SOL in wallet-paid fees.
At the $99.93 settlement conversion, final net is $0.392958473 / 3.274653940% ROE,
displayed as **+$0.39 (+3.27%)**. Tests cover shared presentation values,
fee updates, reused positions, partial exits, pending data, failed-notification
retry and duplicate suppression.
