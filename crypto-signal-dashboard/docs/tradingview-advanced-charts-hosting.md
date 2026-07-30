# TradingView Advanced Charts hosting

BremLogic uses TradingView Advanced Charts v32 through a dedicated static Vercel
asset project:

- `https://bremlogic-tradingview-assets.vercel.app/charting_library/`

The licensed TradingView distribution and staged runtime files are intentionally
excluded from this public Git repository. Only BremLogic's integration, datafeed,
and staging script are tracked.

## Refreshing the runtime

The staging script reads the licensed clone from
`~/charting_library` by default. Set
`TRADINGVIEW_CHARTING_LIBRARY_PATH` when the clone is elsewhere.

```bash
npm run stage:tradingview
cd public/vendor/tradingview
npx vercel deploy --prod --archive=tgz --scope brembot
```

Only the browser runtime is staged:

- `charting_library.standalone.js`
- `sameorigin.html`
- `bundles/`

Type definitions, CommonJS/ESM packages, repository metadata, and source-control
history are not staged or deployed.

For a temporary alternate host, set
`NEXT_PUBLIC_TRADINGVIEW_LIBRARY_PATH` to an absolute URL ending in
`/charting_library/`. The host must return an appropriate
`Access-Control-Allow-Origin` header as required by TradingView's cross-origin
hosting documentation.
