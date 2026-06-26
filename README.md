# Claude Momentum Dashboard

Single-page momentum dashboard configured for Cloudflare Pages, with a Cloudflare Worker runner for 24/7 paper trading.

## Cloudflare Pages deploy

1. In Cloudflare, create a Pages project connected to this GitHub repository.
2. Use these build settings:
   - Framework preset: None
   - Build command: `npm run build`
   - Build output directory: `dist`
3. Deploy. The dashboard is served as static files.

## 24/7 paper trading

The browser dashboard is only the UI. Continuous paper trading runs in `worker/src/index.js` on Cloudflare Workers:

- Cron trigger: every minute
- State storage: Cloudflare KV binding `PAPER_STATE`
- Market data: OKX USDT perpetual swaps
- Public API: `https://momentum-trader-claude-runner.siaosiao1016.workers.dev`

Binance Futures works from the browser, but Binance blocks Cloudflare Workers/Pages Functions from fetching the Futures API with a `403`, so the always-on runner uses OKX public swap market data instead.

## Wrangler deploy

```bash
npm run deploy
```

For local Cloudflare-compatible preview:

```bash
npm run dev
```

On Windows PowerShell, if script execution policy blocks `npm` or `npx`, run the commands through Command Prompt instead, for example `cmd /c npm run deploy`.

The app also works when opened directly from the filesystem.

## Deploy both frontend and runner

```bash
npm run deploy:all
```
