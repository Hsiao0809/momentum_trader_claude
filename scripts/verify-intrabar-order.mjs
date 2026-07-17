import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} was not found`);
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  for (let i = bodyStart; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`${name} has no closing brace`);
}

const htmlSource = readFileSync('momentum_trader_claude.html', 'utf8');
const workerSource = readFileSync('worker/src/index.js', 'utf8');

const buildStops = (source) => new Function(
  `${extractFunction(source, 'effectiveStopFor')}
   ${extractFunction(source, 'stopReasonFor')}
   ${extractFunction(source, 'stopAtBarOpen')}
   return { effectiveStopFor, stopReasonFor, stopAtBarOpen };`,
)();

const htmlStops = buildStops(htmlSource);
const workerStops = buildStops(workerSource);
const stopFixtures = [
  [{ side: 'long', entry: 100, stop: 95, highest: 100, lowest: 100 }, 109, 95],
  [{ side: 'short', entry: 100, stop: 105, highest: 100, lowest: 100 }, 105, 94],
  [{ side: 'long', entry: 100, stop: 95, highest: 109, lowest: 100, beTrigger: 108 }, 107, 100],
];
for (const [position, high, low] of stopFixtures) {
  assert.deepEqual(
    htmlStops.stopAtBarOpen(position, high, low),
    workerStops.stopAtBarOpen(position, high, low),
    'dashboard and Worker must use the same pre-candle stop decision',
  );
}

const simulateTrade = new Function(
  'CFG', 'LABELS', 'kOpen', 'kHigh', 'kLow', 'kClose', 'kTime', 'atrPct',
  'sideForStrategy', 'buildRisk', 'positionSize', 'pct', 'safeDiv',
  `${extractFunction(htmlSource, 'effectiveStopFor')}
   ${extractFunction(htmlSource, 'stopReasonFor')}
   ${extractFunction(htmlSource, 'stopAtBarOpen')}
   ${extractFunction(htmlSource, 'simulateTrade')}
   return simulateTrade;`,
)(
  { maxHoldHours: 1 },
  { long_test: 'Long test', short_test: 'Short test' },
  (row) => row[1],
  (row) => row[2],
  (row) => row[3],
  (row) => row[4],
  (row) => row[0],
  () => 4,
  (strategy) => strategy === 'short_test' ? 'short' : 'long',
  (_entry, _atr, side) => side === 'short'
    ? { stop: 105, stopPct: 5, tp1: 85, beTrigger: 95, lockTrigger: 90, lockLevel: 97, trailPct: 8 }
    : { stop: 95, stopPct: 5, tp1: 120, beTrigger: 108, lockTrigger: 115, lockLevel: 105, trailPct: 8 },
  () => ({ qty: 10, riskUsdt: 50 }),
  (from, to) => (to / from - 1) * 100,
  (value, divisor, fallback) => divisor ? value / divisor : fallback,
);

const candle = (time, open, high, low, close) => [time, open, high, low, close, 1];
const prior = candle(0, 100, 101, 99, 100);
const long = simulateTrade('LONG', 'long_test', 80, [prior, candle(1, 100, 109, 95, 100)], 1, 1000);
assert.equal(long.reason, 'stop');
assert.equal(long.exit, 95);
assert.equal(long.rMultiple, -1, 'the original stop wins when stop and a new protection trigger share a candle');
assert.ok(Math.abs(long.maePct + 5) < 1e-9);

const short = simulateTrade('SHORT', 'short_test', 80, [prior, candle(1, 100, 105, 94, 100)], 1, 1000);
assert.equal(short.reason, 'stop');
assert.equal(short.exit, 105);
assert.equal(short.rMultiple, -1, 'short trades must use the same conservative ordering');
assert.ok(Math.abs(short.maePct + 5) < 1e-9);

const nextBarStop = simulateTrade('NEXT', 'long_test', 80, [
  prior,
  candle(1, 100, 109, 96, 108),
  candle(2, 108, 109, 99, 100),
], 1, 1000);
assert.equal(nextBarStop.reason, 'be_stop');
assert.equal(nextBarStop.exit, 100, 'a stop raised by one candle becomes active on the next candle');

console.log('intrabar ordering checks passed (pre-candle stop priority and Worker/dashboard parity)');
