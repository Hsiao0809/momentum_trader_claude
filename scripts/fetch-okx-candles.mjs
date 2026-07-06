// Fetch N days of 15m candles for the top-quote-volume OKX USDT perpetual swaps.
// Output feeds scripts/backtest-strategies.mjs. Cache is local-only (gitignored),
// not committed — re-run to refresh before each backtest session.
//
// Usage: node scripts/fetch-okx-candles.mjs [days] [universeSize]
import { writeFile, mkdir } from 'node:fs/promises';

const OKX = 'https://www.okx.com';
const DAYS = Number(process.argv[2] || 30);
const UNIVERSE = Number(process.argv[3] || 25);
const BARS = DAYS * 96;
const CACHE_DIR = new URL('.cache/', import.meta.url);
const OUT_FILE = new URL('.cache/okx-candles.json', import.meta.url);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function okx(path) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(OKX + path);
    if (res.status === 429 || res.status >= 500) {
      await sleep(800 * (attempt + 1));
      continue;
    }
    const json = await res.json();
    if (json.code !== '0') throw new Error(`${json.code} ${json.msg}`);
    return json.data;
  }
  throw new Error(`OKX request failed after retries: ${path}`);
}

console.log(`Fetching top ${UNIVERSE} USDT swaps, ${DAYS} days of 15m candles...`);
const tickers = await okx('/api/v5/market/tickers?instType=SWAP');
const usdt = tickers
  .filter((t) => t.instId.endsWith('-USDT-SWAP'))
  .map((t) => ({ instId: t.instId, quoteVol: Number(t.volCcy24h) * Number(t.last) }))
  .filter((t) => t.quoteVol >= 20_000_000)
  .sort((a, b) => b.quoteVol - a.quoteVol)
  .slice(0, UNIVERSE);
console.log('universe:', usdt.map((t) => t.instId).join(', '));

const targets = ['BTC-USDT-SWAP', ...usdt.map((t) => t.instId).filter((i) => i !== 'BTC-USDT-SWAP')];
const candles = {};
for (const instId of targets) {
  const rows = {};
  let after = Date.now() + 1;
  while (Object.keys(rows).length < BARS) {
    const batch = await okx(`/api/v5/market/history-candles?instId=${instId}&bar=15m&after=${after}&limit=100`);
    if (!batch.length) break;
    for (const row of batch) rows[Number(row[0])] = row;
    after = Math.min(...batch.map((row) => Number(row[0])));
    await sleep(130);
  }
  candles[instId] = Object.keys(rows).map(Number).sort((a, b) => a - b).map((k) => rows[k]);
  console.log(instId, candles[instId].length, 'bars');
}

await mkdir(CACHE_DIR, { recursive: true });
await writeFile(OUT_FILE, JSON.stringify({
  fetchedAt: Date.now(),
  days: DAYS,
  quoteVols: Object.fromEntries(usdt.map((t) => [t.instId, t.quoteVol])),
  candles,
}));
console.log(`Wrote ${OUT_FILE.pathname}`);
