import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

function extractFunction(source, name, prefix = 'function') {
  const start = source.indexOf(`${prefix} ${name}(`);
  assert.notEqual(start, -1, `${name} was not found`);
  const spacedBody = source.indexOf(') {', start);
  const compactBody = source.indexOf('){', start);
  const bodyStart = spacedBody >= 0 && (compactBody < 0 || spacedBody < compactBody)
    ? spacedBody + 2
    : compactBody + 1;
  assert.ok(bodyStart > 0, `${name} body was not found`);
  let depth = 0;
  for (let i = bodyStart; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`${name} has no closing brace`);
}

const source = readFileSync('worker/src/index.js', 'utf8');
const htmlSource = readFileSync('momentum_trader_claude.html', 'utf8');
const intervalMs = 15 * 60 * 1000;
const currentOpen = Math.floor(Date.now() / intervalMs) * intervalMs;
let mode = 'mixed';

const marketKlines = async (_provider, instId) => {
  if (mode === 'fetch-failure') throw new Error('temporary provider failure');
  if (instId === 'GAP') {
    const times = mode === 'recovered'
      ? [currentOpen - 3 * intervalMs, currentOpen - 2 * intervalMs, currentOpen - intervalMs]
      : [currentOpen - 2 * intervalMs, currentOpen - intervalMs];
    return times.map((time) => [time, 100, 101, 99, 100, 1]);
  }
  return [[currentOpen - intervalMs, 100, 101, 99, 100, 1]];
};

const functions = new Function(
  'INTERVAL_MS', 'marketKlines', 'closedKlines', 'providerFromInstId', 'instIdFromSymbol',
  'positionKlineLimit', 'kTime', 'kHigh', 'kLow', 'kClose', 'recordProtectionEvents',
  'takeBreakEvenPartial', 'effectiveStopFor', 'stopReasonFor', 'closePosition', 'takeTP1',
  'tickerPrice', 'sleep', 'console',
  `${extractFunction(source, 'positionKlinesAfter')}
   ${extractFunction(source, 'updatePositionIds', 'async function')}
   return { positionKlinesAfter, updatePositionIds };`,
)(
  { '15m': intervalMs },
  marketKlines,
  (rows) => rows,
  () => 'okx',
  (symbol) => symbol,
  () => 300,
  (row) => Number(row[0]),
  (row) => Number(row[2]),
  (row) => Number(row[3]),
  (row) => Number(row[4]),
  () => {},
  () => {},
  (position) => position.stop,
  () => 'stop',
  () => { throw new Error('unexpected close'); },
  () => { throw new Error('unexpected TP1'); },
  async () => { throw new Error('unexpected ticker'); },
  async () => {},
  { warn: () => {} },
);

const position = (id, lastTime) => ({
  id,
  symbol: id,
  instId: id,
  marketProvider: 'okx',
  lastTime,
  entryTime: currentOpen - intervalMs,
  entry: 100,
  last: 100,
  highest: 100,
  lowest: 100,
  side: 'long',
  stop: 50,
  tp1: 200,
  events: [],
});

const gap = position('GAP', currentOpen - 4 * intervalMs);
const healthy = position('HEALTHY', currentOpen - 2 * intervalMs);
const state = { positions: [gap, healthy], equity: 1000, cfg: { maxHoldHours: 72 } };
const beforeGap = { lastTime: gap.lastTime, last: gap.last, highest: gap.highest, lowest: gap.lowest };

const firstResult = await functions.updatePositionIds(state, ['GAP', 'HEALTHY'], { markToMarket: false });
assert.equal(firstResult.historyGaps.length, 1);
assert.equal(firstResult.historyGaps[0].symbol, 'GAP');
assert.deepEqual(
  { lastTime: gap.lastTime, last: gap.last, highest: gap.highest, lowest: gap.lowest },
  beforeGap,
  'a gap must not mutate trading state',
);
assert.equal(healthy.lastTime, currentOpen - intervalMs, 'other positions must continue updating');
assert.equal(state.equity, 1000);
assert.deepEqual(gap.events, []);
assert.ok(gap.historyGap, 'the position must retain its gap marker');

mode = 'fetch-failure';
const failedRetry = await functions.updatePositionIds(state, ['GAP'], { markToMarket: false });
assert.equal(failedRetry.historyGaps.length, 1, 'a provider failure must not clear an existing gap');
assert.ok(gap.historyGap);

mode = 'recovered';
const recovered = await functions.updatePositionIds(state, ['GAP'], { markToMarket: false });
assert.equal(recovered.historyGaps.length, 0);
assert.equal(gap.historyGap, undefined, 'a fully continuous replay clears the gap');
assert.equal(gap.lastTime, currentOpen - intervalMs);

let latestPriceCalls = 0;
let openCalls = 0;
const orchestration = new Function(
  'latestEntryPrices', 'openNewPositions',
  `${extractFunction(source, 'applyPositionUpdateStatus')}
   ${extractFunction(source, 'openNewPositionsAfterUpdate', 'async function')}
   return { applyPositionUpdateStatus, openNewPositionsAfterUpdate };`,
)(
  async () => { latestPriceCalls++; return {}; },
  async () => { openCalls++; },
);

const coordinatorState = { running: true, signals: [], positionHistoryGaps: [], lastError: null };
const updateWithGap = orchestration.applyPositionUpdateStatus(coordinatorState, firstResult);
assert.equal(coordinatorState.positionHistoryGaps.length, 1);
assert.equal(await orchestration.openNewPositionsAfterUpdate(coordinatorState, {}, false, updateWithGap), false);
assert.equal(latestPriceCalls, 0);
assert.equal(openCalls, 0);

const visibleError = new Function(
  `${extractFunction(htmlSource, 'runnerErrorSummary')}; return runnerErrorSummary;`,
)();
coordinatorState.lastError = 'scan failed after position update';
const summary = visibleError(coordinatorState);
assert.equal(summary.label, '持倉資料缺口');
assert.match(summary.text, /position_history_gap: GAP/);
assert.match(summary.text, /scan failed after position update/);

orchestration.applyPositionUpdateStatus(coordinatorState, recovered);
assert.equal(await orchestration.openNewPositionsAfterUpdate(coordinatorState, {}, false, recovered), true);
assert.equal(latestPriceCalls, 1);
assert.equal(openCalls, 1);

console.log('position history recovery checks passed (isolation, persistence, recovery, and entry gate)');
