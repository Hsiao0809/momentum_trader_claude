import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

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

function loadClassifier(source) {
  const functionSource = extractFunction(source, 'classifyMarketContext');
  const factory = new Function(
    'kOpen', 'kHigh', 'kLow', 'kClose', 'kVol', 'pct', 'safeDiv', 'median', 'clamp',
    `return (${functionSource});`,
  );
  return factory(
    (k) => Number(k[1]),
    (k) => Number(k[2]),
    (k) => Number(k[3]),
    (k) => Number(k[4]),
    (k) => Number(k[5]),
    (a, b) => (!a || b === null || b === undefined ? null : (b / a - 1) * 100),
    (a, b, fallback = 0) => (!b || a === null || a === undefined ? fallback : a / b),
    (values) => {
      if (!values.length) return 0;
      const sorted = [...values].sort((a, b) => a - b);
      const middle = Math.floor(sorted.length / 2);
      return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
    },
    (value, low, high) => Math.max(low, Math.min(high, value)),
  );
}

function loadEvaluator(source) {
  const dependencies = [
    'evaluateSignal', 'classifyMarketContext', 'closedKlines', 'atrPct',
    'rangePosition', 'buildRisk', 'strategyKey', 'kOpen', 'kHigh', 'kLow',
    'kClose', 'kVol', 'kTime', 'pct', 'safeDiv', 'clamp', 'mean', 'median', 'ema',
  ].map((name) => extractFunction(source, name)).join('\n');
  return new Function(`
    const INTERVAL_MS = { '15m': 900000 };
    const nowMs = () => Date.now();
    const LABELS = {
      pullback_uptrend: '上升趨勢回檔',
      volume_breakout_follow: '放量突破跟進',
      impulse_pullback_reclaim: '急拉回檔確認',
      rally_downtrend: '下降趨勢反彈',
      strong_momentum_breakout: '強動量突破追價',
      volume_ignition: '放量啟動追隨',
      high_range_continuation: '高位續勢承接',
      narrative_momentum: '題材動量順勢',
    };
    const CFG = { minQuoteVolume: 20000000 };
    ${dependencies}
    return evaluateSignal;
  `)();
}

function bar(index, open, high, low, close, volume = 1000) {
  return [index * 900000, open, high, low, close, volume];
}

function baseRows(count = 60) {
  return Array.from({ length: count }, (_, i) => bar(i, 100, 100.5, 99.5, 100, 1000));
}

function withImpulse() {
  const rows = baseRows(120);
  rows.push(bar(rows.length, 100, 110, 99, 108, 10000));
  return rows;
}

const workerSource = readFileSync('worker/src/index.js', 'utf8');
const htmlSource = readFileSync('momentum_trader_claude.html', 'utf8');
const workerClassifier = loadClassifier(workerSource);
const htmlClassifier = loadClassifier(htmlSource);
const workerEvaluator = loadEvaluator(workerSource);
const htmlEvaluator = loadEvaluator(htmlSource);

const cases = [
  {
    name: 'normal market',
    rows: baseRows(),
    expected: { marketType: 'normal_trend', hasRecentImpulse: false },
  },
  {
    name: 'fresh volume impulse',
    rows: withImpulse(),
    expected: { marketType: 'volume_impulse', isImpulseFollow: true, barsSinceImpulse: 0 },
  },
  {
    name: '19 percent retrace remains high-range consolidation',
    rows: [...withImpulse(), bar(121, 107.5, 109, 106.5, 107.9, 1200)],
    expected: { marketType: 'high_range_consolidation', isConfirmedPullback: false },
  },
  {
    name: 'deep pullback without stabilization waits',
    rows: [...withImpulse(), bar(121, 106, 107, 103, 104, 1800)],
    expected: { marketType: 'pump_pullback_wait', isConfirmedPullback: false },
  },
  {
    name: '35 to 60 percent retrace with bullish higher low confirms',
    rows: [
      ...withImpulse(),
      bar(121, 106, 107, 103, 104, 1800),
      bar(122, 104, 106, 103.5, 105.2, 1400),
    ],
    expected: { marketType: 'confirmed_pump_pullback', isConfirmedPullback: true },
  },
  {
    name: 'more than 60 percent retrace is exhaustion',
    rows: [...withImpulse(), bar(121, 104, 105, 101, 102, 2000)],
    expected: { marketType: 'pump_exhaustion', isConfirmedPullback: false },
  },
];

for (const testCase of cases) {
  const workerResult = workerClassifier(testCase.rows, 2);
  const htmlResult = htmlClassifier(testCase.rows, 2);
  assert.deepEqual(htmlResult, workerResult, `${testCase.name}: dashboard and Worker differ`);
  for (const [key, expected] of Object.entries(testCase.expected)) {
    assert.equal(workerResult[key], expected, `${testCase.name}: expected ${key}=${expected}`);
  }
}

function workerSignal(rows) {
  return workerEvaluator(
    'TESTUSDT', 'TEST-USDT-SWAP', rows, 30000000, 123, false,
    { minQuoteVolume: 20000000, minSignalScore: 82 },
  );
}

function htmlSignal(rows) {
  return htmlEvaluator('TESTUSDT', rows, 30000000, 123, false, 82);
}

const signalCases = [
  {
    name: 'fresh impulse enters only as volume breakout follow',
    rows: withImpulse(),
    strategyKey: 'volume_breakout_follow',
  },
  {
    name: '19 percent retrace does not enter',
    rows: [...withImpulse(), bar(121, 107.5, 109, 106.5, 107.9, 1200)],
    strategyKey: null,
  },
  {
    name: 'confirmed deep pullback enters with dedicated strategy',
    rows: [
      ...withImpulse(),
      bar(121, 106, 107, 103, 104, 1800),
      bar(122, 104, 106, 103.5, 105.2, 1400),
    ],
    strategyKey: 'impulse_pullback_reclaim',
  },
];

for (const testCase of signalCases) {
  const workerResult = workerSignal(testCase.rows);
  const htmlResult = htmlSignal(testCase.rows);
  assert.equal(workerResult?.strategyKey || null, testCase.strategyKey, `${testCase.name}: Worker strategy`);
  assert.equal(htmlResult?.strategyKey || null, testCase.strategyKey, `${testCase.name}: dashboard strategy`);
}

console.log(`market context checks passed (${cases.length} classifier cases, ${signalCases.length} signal cases)`);
