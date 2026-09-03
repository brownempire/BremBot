# Scalp overlay traffic

The chart overlay is a UI reader, not the autonomous agent's scheduler.

- Poll only while enabled, authenticated and visible. Browser/desktop windows
  also require focus; Capacitor apps use native app-active state.
- Pause on background/hide/page exit and abort the outstanding browser request.
  A request already received by the server may still finish; no new overlay
  requests are scheduled while hidden.
- Refresh immediately on return, then 15 seconds after each completed request.
  Unmounting, disabling or changing the market/auth cancels the old poller.
- In Redis, scan history in small batches and return at most the latest 20
  qualifying markers for the requested wallet/market within 24 hours, plus the
  latest relevant scalp close. Never download the full histories into the route.
- Cache that history for 30 seconds across workers/devices, with brief in-process
  reuse and concurrent-request coalescing. Settings, monitor health, timeouts and
  current market data still refresh independently on each foreground request.

The first live projection returned 20 markers and the latest closed trade in
73,216 bytes, versus approximately 6.5 MB for the previous full-history reads.
This is a reduction for the **overlay history payload**, not the entire Redis
bill. The autonomous monitor, learning and safety checks still access Redis when
the app is closed. Their scheduling and storage were not changed here.
