// Backtest all strategies in momentum_trader_claude.html against cached OKX
// candles (see fetch-okx-candles.mjs). Extracts the real evaluateSignal /
// simulateTrade functions from the dashboard source via new Function() — the
// same technique scripts/verify-market-context.mjs already uses for parity
// checks — so the backtest runs the actual production logic, not a reimplementation.
//
// Usage:
//   node scripts/fetch-okx-candles.mjs        # once, or to refresh
//   node scripts/backtest-strategies.mjs       # baseline run
//   node scripts/backtest-strategies.mjs --patch 'OLD_STRING' 'NEW_STRING'
//     # test a proposed change without editing the real file — pass the exact
//     # substring to replace (e.g. a condition line) and its replacement.
//     # Fails loudly if OLD_STRING isn't found, so typos can't silently no-op.
//
// Output: scripts/.cache/backtest-<label>.json (full trade list + stats) and
// a one-line summary on stdout.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import assert from 'node:assert/strict';

const CACHE_DIR = new URL('.cache/', import.meta.url);
const DATASET_FILE = new URL('.cache/okx-candles.json', import.meta.url);

function braceMatchedSlice(source, start, openIndex) {
  let depth = 0;
  for (let i = openIndex; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error('no closing brace found');
}

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `function ${name} was not found in source`);
  return braceMatchedSlice(source, start, source.indexOf('{', start));
}

// Extract a `const NAME = {...}` object literal so the harness always runs
// with the dashboard's real constants — hardcoded copies would silently go
// stale when someone tunes CFG or adds a strategy.
function extractConst(source, name) {
  const start = source.indexOf(`const ${name} = {`);
  assert.notEqual(start, -1, `const ${name} was not found in source`);
  return braceMatchedSlice(source, start, source.indexOf('{', start)) + ';';
}

function loadStrategyModule(source) {
  const constants = ['INTERVAL_MS', 'LABELS', 'STRATEGY_SIDES', 'CFG']
    .map((name) => extractConst(source, name)).join('\n');
  const names = [
    'nowMs', 'evaluateSignal', 'classifyMarketContext', 'closedKlines', 'atrPct', 'rangePosition',
    'buildRisk', 'strategyKey', 'sideForStrategy', 'btcRiskOff',
    'kOpen', 'kHigh', 'kLow', 'kClose', 'kVol', 'kTime',
    'pct', 'safeDiv', 'clamp', 'mean', 'median', 'ema',
    'simulateTrade', 'positionSize', 'applyPortfolio', 'summarize', 'findIndex',
  ];
  const dependencies = names.map((name) => extractFunction(source, name)).join('\n');
  const factory = new Function(`
    ${constants}
    ${dependencies}
    return { evaluateSignal, simulateTrade, applyPortfolio, summarize, findIndex, kTime, kClose, pct, CFG };
  `);
  return factory();
}

function riskOffLookup(btcCandles, { kTime, kClose, pct }) {
  const table = new Map();
  for (let j = 16; j < btcCandles.length; j++) {
    const last = kClose(btcCandles[j]);
    const oneH = pct(kClose(btcCandles[j - 4]), last);
    const fourH = pct(kClose(btcCandles[j - 16]), last);
    table.set(kTime(btcCandles[j]), oneH <= -1.5 && fourH <= -3);
  }
  const sortedTimes = [...table.keys()].sort((a, b) => a - b);
  return (t) => {
    let lo = 0, hi = sortedTimes.length - 1, ans = false;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (sortedTimes[mid] <= t) { ans = table.get(sortedTimes[mid]) ?? false; lo = mid + 1; }
      else hi = mid - 1;
    }
    return ans;
  };
}

function statsFor(trades) {
  const s = { n: trades.length, wins: 0, pnl: 0, gp: 0, gl: 0, avgR: 0, reasons: {} };
  for (const t of trades) {
    s.pnl += t.pnl;
    s.avgR += t.rMultiple;
    if (t.pnl >= 0) { s.wins++; s.gp += t.pnl; } else s.gl += Math.abs(t.pnl);
    s.reasons[t.reason] = (s.reasons[t.reason] || 0) + 1;
  }
  s.avgR = s.n ? s.avgR / s.n : 0;
  s.winRate = s.n ? (s.wins / s.n) * 100 : 0;
  s.pf = s.gl ? s.gp / s.gl : (s.gp ? Infinity : 0);
  return s;
}

// ── CLI args ──────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
let label = 'baseline';
let patchOld = null, patchNew = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--label') label = args[++i];
  else if (args[i] === '--patch') { patchOld = args[++i]; patchNew = args[++i]; }
}

let html = readFileSync(new URL('../momentum_trader_claude.html', import.meta.url), 'utf8');
if (patchOld !== null) {
  const count = html.split(patchOld).length - 1;
  assert.equal(count, 1, `--patch OLD_STRING must match exactly once (found ${count}) — check for whitespace/formatting drift`);
  html = html.replace(patchOld, patchNew);
  if (label === 'baseline') label = 'patched';
}

const mod = loadStrategyModule(html);
const dataset = JSON.parse(readFileSync(DATASET_FILE, 'utf8'));
const { candles, quoteVols } = dataset;

const btc = candles['BTC-USDT-SWAP'];
if (!btc) throw new Error('BTC-USDT-SWAP missing from dataset — re-run fetch-okx-candles.mjs');
const riskOffAt = riskOffLookup(btc, mod);

// Gates mirror production paperTick (HTML) / openNewPositions (worker):
// paperMinScore for everything, +8 extra for narrative_momentum (the
// catch-all bucket). Values come from the extracted CFG so they track the
// dashboard automatically.
const MIN_SCORE = mod.CFG.paperMinScore;
const NARRATIVE_MIN = mod.CFG.paperMinScore + 8;
const COOLDOWN_BARS = mod.CFG.cooldownBars;

const candidates = [];
for (const [instId, rows] of Object.entries(candles)) {
  const symbol = instId.replace('-USDT-SWAP', 'USDT');
  const quoteVolume = quoteVols[instId] || 5e7;
  if (rows.length < 140) continue;
  let i = 110;
  while (i < rows.length - 2) {
    const barTime = mod.kTime(rows[i]);
    const sig = mod.evaluateSignal(symbol, rows.slice(0, i + 1), quoteVolume, barTime, riskOffAt(barTime), MIN_SCORE);
    if (sig && sig.score >= MIN_SCORE && !(sig.strategyKey === 'narrative_momentum' && sig.score < NARRATIVE_MIN)) {
      const trade = mod.simulateTrade(symbol, sig.strategyKey, sig.score, rows, i + 1, 1000);
      if (trade) {
        candidates.push(trade);
        i = Math.max(i + 1, mod.findIndex(rows, trade.exitTime) + COOLDOWN_BARS);
        continue;
      }
    }
    i++;
  }
}

const portfolio = mod.applyPortfolio(candidates.map((t) => ({ ...t })));
const byStrategy = {};
for (const t of candidates) (byStrategy[t.strategyKey] ??= []).push(t);

const result = {
  label,
  patch: patchOld !== null ? { old: patchOld, new: patchNew } : null,
  window: {
    days: dataset.days,
    universe: Object.keys(candles).length,
    fetchedAt: new Date(dataset.fetchedAt).toISOString(),
  },
  candidates: statsFor(candidates),
  byStrategy: Object.fromEntries(Object.entries(byStrategy).map(([k, v]) => [k, statsFor(v)])),
  portfolio: { ...statsFor(portfolio), summary: mod.summarize(portfolio) },
};

mkdirSync(CACHE_DIR, { recursive: true });
const outFile = new URL(`.cache/backtest-${label}.json`, import.meta.url);
writeFileSync(outFile, JSON.stringify(result, null, 1));

console.log(JSON.stringify({
  label,
  candidateCount: result.candidates.n,
  portfolioTrades: result.portfolio.n,
  portfolioPnl: +result.portfolio.pnl.toFixed(1),
  winRate: +result.portfolio.winRate.toFixed(1),
  pf: +result.portfolio.pf.toFixed(2),
  maxDrawdownPct: +result.portfolio.summary.maxDrawdownPct.toFixed(1),
  perStrategyPnl: Object.fromEntries(
    Object.entries(result.byStrategy).map(([k, s]) => [k, +s.pnl.toFixed(1)]),
  ),
}, null, 2));
console.log(`\nFull detail written to ${outFile.pathname}`);
