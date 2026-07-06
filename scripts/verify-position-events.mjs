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

function loadRecorder(source, clockName) {
  const functions = ['recordPositionEvent', 'ensurePositionEvents', 'recordProtectionEvents']
    .map((name) => extractFunction(source, name))
    .join('\n');
  return new Function(
    clockName,
    `${functions}
     return { recordPositionEvent, ensurePositionEvents, recordProtectionEvents };`,
  )(() => 999999);
}

const workerSource = readFileSync('worker/src/index.js', 'utf8');
const htmlSource = readFileSync('momentum_trader_claude.html', 'utf8');
const worker = loadRecorder(workerSource, 'unusedClock');
const dashboard = loadRecorder(htmlSource, 'nowMs');

const basePosition = {
  id: 'p_1_TESTUSDT',
  symbol: 'TESTUSDT',
  side: 'long',
  entryTime: 1000,
  lastTime: 4000,
  entry: 100,
  qty: 10,
  remainingQty: 5,
  stop: 100,
  originalStop: 95,
  earlyTrigger: 104,
  earlyLevel: 99,
  lockTrigger: 115,
  lockLevel: 105,
  highest: 116,
  lowest: 98,
  partialExits: [{ type: 'be_partial', exitTime: 2000, exit: 108, qty: 5, pnl: 40 }],
};

const workerPosition = structuredClone(basePosition);
const dashboardPosition = structuredClone(basePosition);
worker.ensurePositionEvents(workerPosition);
dashboard.ensurePositionEvents(dashboardPosition);
assert.deepEqual(dashboardPosition.events, workerPosition.events, 'Worker/dashboard reconstructed events differ');
assert.deepEqual(workerPosition.events.map((event) => event.type), [
  'open',
  'partial_exit',
  'early_protection',
  'lock_protection',
]);
assert.equal(workerPosition.events[1].remainingQty, 5);
assert.equal(workerPosition.events[1].pnl, 40);
assert.ok(workerPosition.events.every((event) => event.note === 'reconstructed'));

const freshWorker = {
  ...structuredClone(basePosition),
  partialExits: [],
  events: [],
  remainingQty: 10,
  highest: 116,
};
const freshDashboard = structuredClone(freshWorker);
worker.recordPositionEvent(freshWorker, {
  type: 'open', time: 1000, price: 100, qtyDelta: 10, remainingQty: 10, stop: 95,
});
dashboard.recordPositionEvent(freshDashboard, {
  type: 'open', time: 1000, price: 100, qtyDelta: 10, remainingQty: 10, stop: 95,
});
worker.recordProtectionEvents(freshWorker, 3000);
dashboard.recordProtectionEvents(freshDashboard, 3000);
worker.recordProtectionEvents(freshWorker, 3001);
dashboard.recordProtectionEvents(freshDashboard, 3001);
assert.deepEqual(freshDashboard.events, freshWorker.events, 'Worker/dashboard live events differ');
assert.deepEqual(freshWorker.events.map((event) => event.type), [
  'open',
  'early_protection',
  'lock_protection',
]);

const synthesizePositionEvents = new Function(
  `return (${extractFunction(htmlSource, 'synthesizePositionEvents')});`,
)();
const buildPositionActivity = new Function(
  'synthesizePositionEvents',
  `return (${extractFunction(htmlSource, 'buildPositionActivity')});`,
)(synthesizePositionEvents);

const ubTrade = {
  symbol: 'UBUSDT',
  marketProvider: 'okx',
  side: 'long',
  entryTime: 1000,
  exitTime: 3000,
  entry: 0.1029,
  exit: 0.1029,
  qty: 10,
  pnl: 8,
  reason: 'be_stop',
  partialExits: [{ type: 'be_partial', exitTime: 2000, exit: 0.111132, qty: 5, pnl: 8 }],
};
const ubEvents = synthesizePositionEvents(ubTrade, true);
assert.deepEqual(ubEvents.map((event) => event.type), ['open', 'partial_exit', 'close']);
assert.deepEqual(ubEvents.map((event) => event.remainingQty), [10, 5, 0]);
assert.deepEqual(buildPositionActivity([], [ubTrade]).map((event) => event.type), [
  'close',
  'partial_exit',
  'open',
]);

assert.match(workerSource, /events: p\.events \|\| \[\]/);
assert.match(htmlSource, /id="activityBody"/);
assert.match(htmlSource, /倉位活動紀錄/);

console.log('position activity checks passed (reconstruction, live milestones, Worker/dashboard parity)');
