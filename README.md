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

- Cron trigger and signal scan: every 5 minutes
- State storage: Cloudflare KV binding `PAPER_STATE`
- Free-plan KV budget: 288 scheduled runs/day, using about 576 writes/day (lock + state), leaving about 424 writes/day for manual actions
- Market data: OKX USDT perpetual swaps
- Public API: `https://momentum-trader-claude-runner.siaosiao1016.workers.dev`
- Signal discovery: anomaly-first scan. Each scan uses a full OKX swap ticker snapshot, then spends K-line requests on abnormal candidates first: strong 24h change, high 24h range position, volume-rank jump, and quote-volume growth. Each scan is capped at 28 K-line requests, with up to 20 anomaly candidates; core high-liquidity symbols are only sampled every 30 minutes.

Binance Futures works from the browser, but Binance blocks Cloudflare Workers/Pages Functions from fetching the Futures API with a `403`, so the always-on runner uses OKX public swap market data instead.

## Open-position notifications

New paper positions are notified from the Cloudflare Worker, so notifications still work when the dashboard tab is closed. Configure at least one notification channel as a Worker secret:

Delivery retries transient failures up to three times. The latest result and up to 100 notification records are saved in the existing paper state without additional KV writes.

### Telegram

Create a Telegram bot with BotFather, send one message to the bot, then set:

```bash
cmd /c npx wrangler secret put TELEGRAM_BOT_TOKEN --config worker/wrangler.toml
cmd /c npx wrangler secret put TELEGRAM_CHAT_ID --config worker/wrangler.toml
```

### Discord

Create a Discord channel webhook, then set:

```bash
cmd /c npx wrangler secret put DISCORD_WEBHOOK_URL --config worker/wrangler.toml
```

### Generic webhook

Any HTTPS webhook that accepts JSON can be used:

```bash
cmd /c npx wrangler secret put NOTIFY_WEBHOOK_URL --config worker/wrangler.toml
```

Test the configured channel:

```bash
cmd /c curl -X POST https://momentum-trader-claude-runner.siaosiao1016.workers.dev/notify/test
```

If no channel is configured, paper trading continues normally but notifications are skipped.

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
