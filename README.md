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
- Market data: OKX USDT perpetual swaps plus Gate-only USDT perpetual contracts
- Profit protection: close 50% at +8% and move the remainder to break-even; the existing +15% profit lock and +20% TP1/trailing rules remain active
- Pump classification: a fresh 15m impulse requires at least +4%, 5x baseline volume, and a strong close. It can only enter on the next bar; the following 12 hours block high-range consolidation entries, and a 35-60% retrace must print a bullish higher low before re-entry.
- Public API: `https://momentum-trader-claude-runner.siaosiao1016.workers.dev`
- Signal discovery: anomaly-first scan. Each scan combines OKX and Gate ticker snapshots, prefers OKX for duplicate symbols, and adds Gate contracts that are unavailable on OKX. Gate's liquidity threshold is the median Gate/OKX quote-volume ratio among shared liquid symbols, with a 5M USDT safety floor and the OKX 20M threshold as a ceiling. Cross-exchange ranking uses ratio-normalized volume. K-line requests are then spent on abnormal candidates first: strong 24h change, high 24h range position, volume-rank jump, and quote-volume growth. Each scan is capped at 28 K-line requests across both exchanges, with up to 20 anomaly candidates; core high-liquidity symbols are only sampled every 30 minutes.
- Candidate display: paper entries use only the current scan, while the dashboard retains the latest signal per symbol for 30 minutes (maximum 50) and reports successful/failed K-line evaluations. This keeps the table readable without allowing stale signals to open positions.
- Position activity: each position records opening, early protection, partial reduction, profit lock, TP1 reduction, and final close events with time, price, quantity change, remaining quantity, stop, and realized PnL. Older trades are reconstructed from their existing entry, `partialExits`, and final close data. Events are stored in the existing paper-state write, so they add no KV write operations.
- Rate-limit resilience: Worker K-line requests are paced at least 500ms apart. If the live ticker universe is temporarily rate-limited, a snapshot no older than 30 minutes is used for candidate selection; the dashboard marks degraded or cached scans.
- Subrequest safety: K-lines use OKX `history-candles` or Gate `candlesticks` with one request per symbol and no same-invocation retry. This prevents a burst of exchange retries from exceeding Cloudflare's per-invocation subrequest limit.

Binance Futures works from the browser, but Binance blocks Cloudflare Workers/Pages Functions from fetching the Futures API with a `403`, so the always-on runner uses OKX and Gate public futures market data instead.

## Open-position notifications

New paper positions are notified from the Cloudflare Worker, so notifications still work when the dashboard tab is closed. Configure at least one notification channel as a Worker secret:

New-position notifications are published to Cloudflare Queue `momentum-trader-notifications` and delivered by a separate consumer invocation, avoiding the market scan's external subrequest limit. The consumer retries failures and moves exhausted messages to `momentum-trader-notifications-dlq`. The existing KV pending-delivery path remains as a fallback when publishing to Queue fails.

### Telegram

Create a Telegram bot with BotFather, send one message to the bot, then set:

```bash
cmd /c npx wrangler secret put TELEGRAM_BOT_TOKEN --config worker/wrangler.toml
cmd /c npx wrangler secret put TELEGRAM_CHAT_ID --config worker/wrangler.toml
```

New-position messages are automatically pinned after delivery. Private chats can pin directly; in groups and supergroups the bot needs the `can_pin_messages` administrator right, while channels require `can_edit_messages`.

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
