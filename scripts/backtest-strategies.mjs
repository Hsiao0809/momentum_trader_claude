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
    'stopAtBarOpen', 'effectiveStopFor', 'stopReasonFor',
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
let robustIters = 0, robustKeep = 0.85;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--label') label = args[++i];
  else if (args[i] === '--patch') { patchOld = args[++i]; patchNew = args[++i]; }
  else if (args[i] === '--robust') robustIters = Number(args[++i]) || 200;
  else if (args[i] === '--keep') robustKeep = Number(args[++i]) || 0.85;
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
        trade.quoteVolume = quoteVolume; // applyPortfolio 的 tie-break 需要（對齊線上 signalSort）
        trade.atrPctEntry = sig.atrPct;  // 供 tie-break 實驗用
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

// ── 穩健性：組合 PnL 對「候選集長什麼樣」極度敏感（只隨機移除 158 筆多單中的 5 筆，
// PnL 的 5–95% 就是 91~266）。單一數字比較會嚴重誤導，所以對候選集做子抽樣，
// 回報中位數與 5/95 百分位。比較兩個設定時看區間有沒有分離，不要看單點差。
// 見 LESSONS 2026-07-29。
function percentile(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * p)))];
}
function robustness(list, iters, keepFrac) {
  if (!iters) return null;
  // 決定性種子，讓同一份候選集重跑得到同樣的分布（A/B 才可比）
  let seed = 20260729;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const pnls = [];
  for (let it = 0; it < iters; it++) {
    const sub = list.filter(() => rand() < keepFrac);
    if (!sub.length) continue;
    pnls.push(mod.summarize(mod.applyPortfolio(sub.map((t) => ({ ...t })))).netPnl);
  }
  const raw = [...pnls];
  pnls.sort((a, b) => a - b);
  return {
    iters: pnls.length,
    keepFrac,
    p05: +percentile(pnls, 0.05).toFixed(1),
    median: +percentile(pnls, 0.5).toFixed(1),
    p95: +percentile(pnls, 0.95).toFixed(1),
    // 未排序的逐次結果，供「同種子＝同子樣本」的配對比較用（比獨立比中位數有力得多）
    samples: raw.map((v) => +v.toFixed(2)),
  };
}
const robust = robustness(candidates, robustIters, robustKeep);

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
  robustness: robust,
};

mkdirSync(CACHE_DIR, { recursive: true });
const outFile = new URL(`.cache/backtest-${label}.json`, import.meta.url);
writeFileSync(outFile, JSON.stringify(result, null, 1));

console.log(JSON.stringify({
  label,
  candidateCount: result.candidates.n,
  // 候選層總R：不經過倉位額度分配，因此不受路徑噪音影響——比較兩個設定時以此為主要訊號
  candidateTotalR: +(result.candidates.avgR * result.candidates.n).toFixed(1),
  candidateAvgR: +result.candidates.avgR.toFixed(3),
  portfolioTrades: result.portfolio.n,
  portfolioPnl: +result.portfolio.pnl.toFixed(1),
  winRate: +result.portfolio.winRate.toFixed(1),
  pf: +result.portfolio.pf.toFixed(2),
  maxDrawdownPct: +result.portfolio.summary.maxDrawdownPct.toFixed(1),
  robustness: result.robustness && { ...result.robustness, samples: undefined },
  perStrategyPnl: Object.fromEntries(
    Object.entries(result.byStrategy).map(([k, s]) => [k, +s.pnl.toFixed(1)]),
  ),
}, null, 2));
if (!result.robustness) {
  console.log('\n⚠️  portfolioPnl 對候選集極度敏感（誤差棒可達 ±100 以上）。比較兩個設定時請加 --robust 200，');
  console.log('   並以 candidateTotalR（確定性）與 robustness 區間是否分離為準，不要只看 portfolioPnl 單點差。');
}
console.log(`\nFull detail written to ${outFile.pathname}`);
