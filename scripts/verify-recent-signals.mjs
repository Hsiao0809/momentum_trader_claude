import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const TTL_MS = 30 * 60 * 1000;
const LIMIT = 50;

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} was not found`);
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  for (let i = bodyStart; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`${name} has no closing brace`);
}

function loadMerger(source) {
  const functionSource = extractFunction(source, 'mergeRecentSignals');
  return new Function(
    'RECENT_SIGNAL_TTL_MS',
    'RECENT_SIGNAL_LIMIT',
    `return (${functionSource});`,
  )(TTL_MS, LIMIT);
}

function loadSnapshotRanker(source) {
  const functionSource = extractFunction(source, 'rankedFromTickerSnapshot');
  return new Function(
    'TICKER_SNAPSHOT_MAX_AGE_MS',
    'symbolFromInstId',
    'providerFromInstId',
    'GATE_MIN_QUOTE_VOLUME',
    'XYZ_MIN_QUOTE_VOLUME',
    `return (${functionSource});`,
  )(
    TTL_MS,
    (instId) => instId.endsWith('_USDT')
      ? instId.slice(0, -5).replaceAll('_', '') + 'USDT'
      : instId.replace('-USDT-SWAP', 'USDT').replaceAll('-', ''),
    (instId) => instId.startsWith('xyz:') ? 'xyz' : instId.endsWith('_USDT') ? 'gate' : 'okx',
    5_000_000,
    5_000_000,
  );
}

function loadFailureReason(source) {
  return new Function(`return (${extractFunction(source, 'scanFailureReason')});`)();
}

const workerSource = readFileSync('worker/src/index.js', 'utf8');
const htmlSource = readFileSync('momentum_trader_claude.html', 'utf8');
const workerMerge = loadMerger(workerSource);
const htmlMerge = loadMerger(htmlSource);
const snapshotRanker = loadSnapshotRanker(workerSource);
const failureReason = loadFailureReason(workerSource);
const now = 10_000_000;

const recent = {
  symbol: 'OLDUSDT',
  strategyKey: 'pullback_uptrend',
  score: 88,
  scannedAt: now - 20 * 60 * 1000,
  lastSeenAt: now - 20 * 60 * 1000,
};
const expired = {
  symbol: 'EXPIREDUSDT',
  strategyKey: 'volume_ignition',
  score: 90,
  scannedAt: now - 31 * 60 * 1000,
  lastSeenAt: now - 31 * 60 * 1000,
};
const updated = {
  symbol: 'OLDUSDT',
  strategyKey: 'impulse_pullback_reclaim',
  score: 94,
  scannedAt: now,
};

const cases = [
  {
    name: 'empty current scan preserves recent candidates',
    previous: [recent],
    current: [],
    verify(result) {
      assert.equal(result.length, 1);
      assert.equal(result[0].symbol, 'OLDUSDT');
    },
  },
  {
    name: 'expired candidates are removed',
    previous: [expired],
    current: [],
    verify(result) {
      assert.deepEqual(result, []);
    },
  },
  {
    name: 'same symbol is updated instead of duplicated',
    previous: [recent],
    current: [updated],
    verify(result) {
      assert.equal(result.length, 1);
      assert.equal(result[0].strategyKey, 'impulse_pullback_reclaim');
      assert.equal(result[0].lastSeenAt, now);
      assert.equal(result[0].firstSeenAt, recent.scannedAt);
    },
  },
  {
    name: 'recent candidate list is capped',
    previous: [],
    current: Array.from({ length: LIMIT + 10 }, (_, index) => ({
      symbol: `TOKEN${index}USDT`,
      strategyKey: 'narrative_momentum',
      score: index,
      scannedAt: now,
    })),
    verify(result) {
      assert.equal(result.length, LIMIT);
    },
  },
];

for (const testCase of cases) {
  const workerResult = workerMerge(testCase.previous, testCase.current, now);
  const htmlResult = htmlMerge(testCase.previous, testCase.current, now);
  assert.deepEqual(htmlResult, workerResult, `${testCase.name}: Worker/dashboard differ`);
  testCase.verify(workerResult);
}

assert.match(
  workerSource,
  /eligibleEntrySignals\(state, signals = state\.signals\)/,
  'paper entries must continue to use only complete current-scan signals',
);
assert.doesNotMatch(
  workerSource,
  /for \(const sig of state\.recentSignals\)/,
  'recent display signals must never drive paper entries',
);
assert.match(workerSource, /successfulScanCount/);
assert.match(workerSource, /failedScanCount/);
assert.match(workerSource, /scanRequestDelayMs: 500/);
assert.match(workerSource, /universeSource = 'cached'/);
assert.match(workerSource, /\/api\/v5\/market\/history-candles/);
assert.match(workerSource, /history-candles'.+0, 0\)/);
assert.match(htmlSource, /掃描失敗 · \$\{state\.lastError\}/);
assert.match(htmlSource, /Universe使用快取/);
assert.equal(failureReason(new Error('OKX /api/v5/market/history-candles 429')), 'okx_rate_limit');
assert.equal(failureReason(new Error('Gate /api/v4/futures/usdt/candlesticks 429')), 'gate_rate_limit');
assert.equal(failureReason(new Error('Too many subrequests by single Worker invocation.')), 'worker_subrequest_limit');
assert.equal(failureReason(new Error('network unavailable')), 'other');

const snapshot = {
  savedAt: now - 5 * 60 * 1000,
  items: {
    'BTC-USDT-SWAP': { rank: 1, last: 62000, change24h: 2, range24hPosition: 0.8, quoteVolumeFloat: 100000000 },
    'LOW-USDT-SWAP': { rank: 2, last: 1, change24h: 1, range24hPosition: 0.5, quoteVolumeFloat: 1000 },
  },
};
const cachedRanked = snapshotRanker(snapshot, { minQuoteVolume: 20000000 }, now);
assert.equal(cachedRanked.length, 1);
assert.equal(cachedRanked[0].symbol, 'BTCUSDT');
assert.deepEqual(snapshotRanker({ ...snapshot, savedAt: now - TTL_MS - 1 }, { minQuoteVolume: 20000000 }, now), []);

console.log(`recent signal checks passed (${cases.length} merge cases, cached-universe fallback, bounded K-line subrequests, Worker/dashboard parity)`);
