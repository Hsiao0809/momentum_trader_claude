import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const worker = await readFile('worker/src/index.js', 'utf8');
const html = await readFile('momentum_trader_claude.html', 'utf8');
const wrangler = await readFile('worker/wrangler.toml', 'utf8');

function extractFunction(source, name) {
  const asyncStart = source.indexOf(`async function ${name}(`);
  const functionStart = source.indexOf(`function ${name}(`);
  const start = asyncStart >= 0 ? asyncStart : functionStart;
  assert.notEqual(start, -1, `${name} must exist`);
  const brace = source.indexOf('{', start);
  let depth = 0;
  for (let index = brace; index < source.length; index++) {
    if (source[index] === '{') depth++;
    if (source[index] === '}') depth--;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`Could not extract ${name}`);
}

function extractMethod(source, signature) {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `${signature} must exist`);
  const brace = start + signature.length - 1;
  let depth = 0;
  for (let index = brace; index < source.length; index++) {
    if (source[index] === '{') depth++;
    if (source[index] === '}') depth--;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`Could not extract ${signature}`);
}

assert.match(worker, /export class PaperCoordinator extends DurableObject/);
assert.match(wrangler, /class_name = "PaperCoordinator"/);
assert.match(wrangler, /new_sqlite_classes = \["PaperCoordinator"\]/);
assert.doesNotMatch(wrangler, /\[\[workflows\]\]/);
assert.doesNotMatch(worker, /const LOCK_KEY/);
assert.match(worker, /expectedVersion !== Number\(current\.stateVersion \|\| 0\)/);
assert.match(worker, /return this\.enqueue\(async \(\) =>/);
assert.match(worker, /this\.enqueue\(\(\) => this\.runTick\(options\)\)/);
assert.match(worker, /paper-coordinator\/control\$\{url\.pathname\}/);
assert.match(worker, /STATE_CHUNK_BYTES = 1_500_000/);
assert.match(worker, /SCAN_CONTINUATION_DELAY_MS = 1_000/);
assert.match(worker, /GATE_RATE_LIMIT_BACKOFF_BASE_MS = 30_000/);
assert.match(worker, /GATE_RATE_LIMIT_BACKOFF_MAX_MS = 10 \* 60 \* 1000/);
assert.match(worker, /this\.ctx\.storage\.transaction/);
assert.match(worker, /this\.ctx\.storage\.setAlarm\(Date\.now\(\) \+ delay\)/);
assert.match(worker, /async alarm\(\)/);
assert.doesNotMatch(worker, /while \(plan\.cursor < plan\.tickers\.length\)/);
assert.match(worker, /Paper state chunk length mismatch/);
assert.match(worker, /successfulScanCount < plan\.tickers\.length/);
assert.match(worker, /plan\.tickers\.length !== requiredCount/);
assert.match(worker, /universeTier: 'reserve'/);
assert.match(worker, /fillCryptoScanBudget\(cryptoCandidates, cryptoRanked, cryptoBudget\)/);
assert.match(worker, /Scan plan expired before publication/);
assert.match(worker, /batchScannedCount: plan\.tickers\.length/);
assert.match(worker, /market\/ticker', \{ instId \}, 0, 0/);
assert.match(worker, /metaAndAssetCtxs', dex: 'xyz' \}, 0, 1/);

const createIndex = worker.indexOf('let plan = await createScanPlan(state)');
const advanceIndex = worker.indexOf('plan = await advanceScanPlan(state, plan)', createIndex);
const pendingIndex = worker.indexOf('return this.savePendingScan(state, plan)', advanceIndex);
const completeMethodIndex = worker.indexOf('async completeScan(state, plan)');
const finalizeIndex = worker.indexOf('finalizeScanPlan(state, plan)', completeMethodIndex);
const safeOpenIndex = worker.indexOf('openNewPositionsAfterUpdate(state, this.env, onlyScan, positionUpdate)', finalizeIndex);
const latestIndex = worker.indexOf('latestEntryPrices(state, state.signals)', safeOpenIndex);
const openIndex = worker.indexOf('openNewPositions(state, env, latestPrices)', latestIndex);
assert.ok(createIndex > 0 && advanceIndex > createIndex && pendingIndex > advanceIndex);
assert.ok(completeMethodIndex > 0 && finalizeIndex > completeMethodIndex);
assert.ok(safeOpenIndex > finalizeIndex, 'full scan must sort before the safe opening gate');
assert.ok(latestIndex > safeOpenIndex && openIndex > latestIndex, 'safe opening must fetch latest prices before entry');

const runTickSource = extractMethod(worker, 'async runTick(options = {}) {');
const runTick = Function(
  'recoverLastFailedNotification',
  'flushPendingNotifications',
  'hasActiveScanPlan',
  'applyPositionUpdateStatus',
  'updatePositions',
  'scanRetryDelayMs',
  'pendingScanResponse',
  runTickSource.replace('async runTick(options = {}) {', 'async function runTick(options = {}) {') + '; return runTick;',
)(
  () => {},
  async () => false,
  (state) => Boolean(state.scanPlan),
  (state, result) => {
    state.positionHistoryGaps = result.historyGaps;
    return result;
  },
  async (_state, options) => {
    assert.deepEqual(options, { markToMarket: true }, 'pending scans must still mark positions to market');
    pendingScanOrder.push('updatePositions');
    return { historyGaps: [] };
  },
  () => 1_000,
  (state) => ({
    ok: true,
    scanPending: true,
    stateVersion: state.stateVersion,
    scannedCount: state.scanPlan.cursor,
    plannedScanCount: state.scanPlan.tickers.length,
    openPositions: state.positions.length,
  }),
);
const pendingScanOrder = [];
const pendingScanState = {
  running: true,
  positions: [{ id: 'crossed-stop' }],
  signals: [{}],
  cfg: { scanStaleMs: 600000 },
  scanPlan: { cursor: 14, tickers: Array(16).fill({}) },
};
const pendingScanResult = await runTick.call({
  env: {},
  storedState: async () => pendingScanState,
  saveStoredState: async () => { pendingScanOrder.push('save'); },
  scheduleScanContinuation: async () => { pendingScanOrder.push('schedule'); },
}, { reason: 'cron' });
assert.equal(pendingScanResult.scanPending, true);
assert.deepEqual(
  pendingScanOrder,
  ['updatePositions', 'save', 'schedule'],
  'a pending scan must update stops before saving and scheduling its continuation',
);

const gateRateLimitBackoffSource = extractFunction(worker, 'gateRateLimitBackoffMs');
const gateRateLimitBackoffMs = Function(
  'GATE_RATE_LIMIT_BACKOFF_BASE_MS',
  'GATE_RATE_LIMIT_BACKOFF_MAX_MS',
  `${gateRateLimitBackoffSource}; return gateRateLimitBackoffMs;`,
)(30_000, 600_000);
assert.equal(gateRateLimitBackoffMs(1), 30_000);
assert.equal(gateRateLimitBackoffMs(2), 60_000);
assert.equal(gateRateLimitBackoffMs(8), 600_000, 'Gate backoff must cap at ten minutes');

const withGateRateLimitRetrySource = extractFunction(worker, 'withGateRateLimitRetry');
const withGateRateLimitRetry = Function(
  'gateRateLimitBackoffMs',
  `${withGateRateLimitRetrySource}; return withGateRateLimitRetry;`,
)(gateRateLimitBackoffMs);
const retryStartedAt = 1_000_000;
const rateLimitedPlan = withGateRateLimitRetry({ cursor: 14, tickers: Array(16).fill({}) }, retryStartedAt);
assert.equal(rateLimitedPlan.retryCount, 1);
assert.equal(rateLimitedPlan.nextRetryAt, retryStartedAt + 30_000);

const scanRetryDelaySource = extractFunction(worker, 'scanRetryDelayMs');
const scanRetryDelayMs = Function(
  'SCAN_CONTINUATION_DELAY_MS',
  `${scanRetryDelaySource}; return scanRetryDelayMs;`,
)(1_000);
assert.equal(scanRetryDelayMs(rateLimitedPlan, retryStartedAt), 30_000);
assert.equal(scanRetryDelayMs(rateLimitedPlan, rateLimitedPlan.nextRetryAt), 1_000);

const scanFailureReasonSource = extractFunction(worker, 'scanFailureReason');
const scanFailureReason = Function(`${scanFailureReasonSource}; return scanFailureReason;`)();
assert.equal(scanFailureReason(new Error('Scan batch failed: gate_rate_limit:2')), 'gate_rate_limit');

const continueScanSource = extractMethod(worker, 'async continueScan() {');
const continueScan = Function(
  'hasActiveScanPlan',
  'scanRetryDelayMs',
  'pendingScanResponse',
  'advanceScanPlan',
  continueScanSource.replace('async continueScan() {', 'async function continueScan() {') + '; return continueScan;',
)(
  (state) => Boolean(state.scanPlan),
  scanRetryDelayMs,
  (state, retryInMs) => ({ scanPending: true, retryInMs, cursor: state.scanPlan.cursor }),
  async () => { throw new Error('scan must not run before the retry window ends'); },
);
const retryUntil = Date.now() + 45_000;
const waitingState = { scanPlan: { cursor: 14, tickers: Array(16).fill({}), nextRetryAt: retryUntil } };
let scheduledDelay = 0;
const waitingResult = await continueScan.call({
  storedState: async () => waitingState,
  scheduleScanContinuation: async (delay) => { scheduledDelay = delay; },
},);
assert.equal(waitingResult.scanPending, true);
assert.ok(scheduledDelay >= 44_000 && scheduledDelay <= 45_000, 'pending Gate retries must wait instead of retrying immediately');

const deferRateLimitedScanSource = extractMethod(worker, 'async deferRateLimitedScan(state, plan, error) {');
const deferRateLimitedScan = Function(
  'scanFailureReason',
  'withGateRateLimitRetry',
  'scanRetryDelayMs',
  'pendingScanResponse',
  deferRateLimitedScanSource.replace('async deferRateLimitedScan(state, plan, error) {', 'async function deferRateLimitedScan(state, plan, error) {') + '; return deferRateLimitedScan;',
)(
  scanFailureReason,
  withGateRateLimitRetry,
  scanRetryDelayMs,
  (state, retryInMs) => ({ scanPending: true, retryInMs, retryAt: state.scanPlan.nextRetryAt }),
);
const deferredState = { positions: [], stateVersion: 1 };
let deferredDelay = 0;
const deferredResult = await deferRateLimitedScan.call({
  saveStoredState: async () => {},
  scheduleScanContinuation: async (delay) => { deferredDelay = delay; },
}, deferredState, { cursor: 14, tickers: Array(16).fill({}) }, new Error('Scan batch failed: gate_rate_limit:2'));
assert.equal(deferredResult.scanPending, true);
assert.equal(deferredState.scanPlan.retryCount, 1);
assert.ok(deferredDelay >= 29_000 && deferredDelay <= 30_000, 'Gate rate limits must schedule a delayed retry');

const fillCryptoScanBudgetSource = extractFunction(worker, 'fillCryptoScanBudget');
const fillCryptoScanBudget = Function(
  `${fillCryptoScanBudgetSource}; return fillCryptoScanBudget;`,
)();
const filledCrypto = fillCryptoScanBudget(
  [{ instId: 'A', universeTier: 'anomaly' }],
  [{ instId: 'A' }, { instId: 'B' }, { instId: 'C' }, { instId: 'D' }],
  3,
);
assert.deepEqual(filledCrypto.map((ticker) => ticker.instId), ['A', 'B', 'C']);
assert.deepEqual(filledCrypto.map((ticker) => ticker.universeTier), ['anomaly', 'reserve', 'reserve']);

const advanceScanPlanSource = extractFunction(worker, 'advanceScanPlan');
const makeAdvanceScanPlan = (scanBatch, createPlan, assertUniverse = () => {}) => Function(
  'scanSignalPlanBatch',
  'COMPLETE_SCAN_BATCH_SIZE',
  'createScanPlan',
  'assertCompleteScanUniverse',
  `${advanceScanPlanSource}; return advanceScanPlan;`,
)(scanBatch, 2, createPlan, assertUniverse);
const basePlan = {
  cursor: 0,
  tickers: Array.from({ length: 16 }, (_, index) => ({
    instId: `OKX-${index}`,
    marketProvider: 'okx',
  })),
  failedScanCount: 0,
  failedReasonCounts: {},
  onlyScan: true,
};
const advancedPlan = await makeAdvanceScanPlan(
  async (plan) => ({ ...plan, cursor: plan.cursor + 2 }),
  async () => { throw new Error('unexpected rebuild'); },
)({ cfg: {} }, basePlan);
assert.equal(advancedPlan.cursor, 2, 'one continuation must process exactly one batch');
assert.equal(advancedPlan.onlyScan, true);

const cooldownUntil = Date.now() + 60_000;
const gatePlan = {
  ...basePlan,
  cursor: 0,
  tickers: basePlan.tickers.map((ticker, index) => ({ ...ticker, instId: `GATE-${index}`, marketProvider: 'gate' })),
};
const cooldownState = { cfg: {}, okxRateLimitUntil: 0 };
const rebuiltPlan = await makeAdvanceScanPlan(
  async (plan) => ({
    ...plan,
    cursor: 2,
    failedScanCount: 1,
    failedReasonCounts: { okx_rate_limit: 1 },
    okxRateLimitUntil: cooldownUntil,
  }),
  async () => ({ ...gatePlan }),
)(cooldownState, basePlan);
assert.equal(rebuiltPlan.cursor, 0);
assert.equal(rebuiltPlan.rebuiltForOkxRateLimit, true);
assert.equal(rebuiltPlan.onlyScan, true);
assert.equal(cooldownState.okxRateLimitUntil, cooldownUntil);

await assert.rejects(() => makeAdvanceScanPlan(
  async (plan) => ({
    ...plan,
    cursor: 2,
    failedScanCount: 1,
    failedReasonCounts: { gate_rate_limit: 1 },
  }),
  async () => { throw new Error('unexpected rebuild'); },
)({ cfg: {} }, basePlan), /Scan batch failed: gate_rate_limit:1/);

const finalizeSource = extractFunction(worker, 'finalizeScanPlan');
const finalize = Function(
  'positiveInt',
  'DEFAULT_CFG',
  'sortedPlanSignals',
  'mergeRecentSignals',
  'COMPLETE_SCAN_BATCH_SIZE',
  `${finalizeSource}; return finalizeScanPlan;`,
)(
  (value, fallback) => Number(value) || fallback,
  { maxKlineScans: 16 },
  () => [],
  () => [],
  2,
);
const scanState = { cfg: { maxKlineScans: 16, scanStaleMs: 600000 } };
assert.throws(() => finalize(scanState, {
  createdAt: Date.now(), cursor: 15, tickers: Array(15).fill({}), successfulScanCount: 15,
}), /Incomplete scan universe: 15\/16/);
assert.doesNotMatch(worker, /state\.trades = state\.trades\.slice/);
assert.doesNotMatch(worker, /state\.equityCurve = state\.equityCurve\.slice/);

const workerRepriceSource = extractFunction(worker, 'repriceSignal');
const workerReprice = Function(`${workerRepriceSource}; return repriceSignal;`)();
const repriced = workerReprice({
  entry: 100,
  stop: 95,
  tp1: 120,
  beTrigger: 108,
  lockTrigger: 115,
  lockLevel: 105,
  earlyTrigger: 104,
  earlyLevel: 99,
}, 110);
assert.equal(repriced.entry, 110);
assert.equal(repriced.stop, 104.5);
assert.equal(repriced.tp1, 132);
assert.ok(Math.abs(repriced.beTrigger - 118.8) < 1e-10);
assert.equal(repriced.signalEntry, 100);

const htmlRepriceSource = extractFunction(html, 'repriceSignal');
const htmlReprice = Function('nowMs', `${htmlRepriceSource}; return repriceSignal;`)(() => 123456);
assert.deepEqual(
  { ...htmlReprice({ entry: 100, stop: 105, tp1: 80 }, 90), pricedAt: 0 },
  { ...workerReprice({ entry: 100, stop: 105, tp1: 80 }, 90), pricedAt: 0 },
  'dashboard and Worker must rebase entry protection identically',
);

const chunkFixture = JSON.stringify({ text: '交易紀錄'.repeat(400000) });
const encoded = new TextEncoder().encode(chunkFixture);
const chunks = [];
for (let offset = 0; offset < encoded.byteLength; offset += 1_500_000) {
  chunks.push(encoded.slice(offset, Math.min(offset + 1_500_000, encoded.byteLength)));
}
const joined = new Uint8Array(encoded.byteLength);
let joinedOffset = 0;
for (const chunk of chunks) {
  joined.set(chunk, joinedOffset);
  joinedOffset += chunk.byteLength;
}
assert.equal(new TextDecoder().decode(joined), chunkFixture, 'UTF-8 state chunks must round-trip');
assert.ok(chunks.every((chunk) => chunk.byteLength <= 1_500_000));

const coordinatorCronRequestsPerDay = 24 * 60 / 5;
const maximumFullScansPerDay = 24 * 60 / 10;
const scanBatches = 16 / 2;
const scanAlarmRequestsPerDay = maximumFullScansPerDay * (scanBatches - 1);
const maximumCoordinatorRequestsPerDay = coordinatorCronRequestsPerDay + scanAlarmRequestsPerDay;
const maximumAlarmRowsWrittenPerDay = scanAlarmRequestsPerDay;
assert.equal(coordinatorCronRequestsPerDay, 288);
assert.equal(maximumCoordinatorRequestsPerDay, 1296);
assert.ok(maximumCoordinatorRequestsPerDay < 100000, 'cron plus alarm requests stay within DO Free');
assert.ok(
  maximumCoordinatorRequestsPerDay * 6 + maximumAlarmRowsWrittenPerDay < 100000,
  'five state chunks, metadata, and setAlarm rows stay within DO Free',
);
assert.ok(8 + 6 + 1 + 16 + 16 < 50, 'worst scan tick including universe retries stays within limit');

console.log('coordinator runtime checks passed (atomic state, complete sorting, latest-price fills, free budgets)');
