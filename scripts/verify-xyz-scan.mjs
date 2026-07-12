import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

function extractFunction(source, name) {
  const markers = [`async function ${name}(`, `function ${name}(`];
  const start = markers.map((marker) => source.indexOf(marker)).find((index) => index >= 0);
  assert.notEqual(start, undefined, `${name} was not found`);
  const bodyStart = source.indexOf('{', source.indexOf(')', start));
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

const source = readFileSync('worker/src/index.js', 'utf8');
const dependencyNames = ['positiveInt', 'anomalyScore', 'rotatingSlice', 'buildTickerSnapshot', 'fillCryptoScanBudget'];
const ranked = [
  ...Array.from({ length: 60 }, (_, index) => ({
    instId: `TOKEN${index}-USDT-SWAP`,
    symbol: `TOKEN${index}USDT`,
    marketProvider: 'okx',
    rank: index + 1,
    last: 10 + index,
    change24h: index % 4,
    range24hPosition: 0.7,
    quoteVolumeFloat: 200_000_000 - index * 1_000_000,
    normalizedQuoteVolume: 200_000_000 - index * 1_000_000,
    minQuoteVolume: 20_000_000,
  })),
  ...Array.from({ length: 20 }, (_, index) => ({
    instId: `xyz:ASSET${index}`,
    symbol: `ASSET${index}`,
    marketProvider: 'xyz',
    rank: index + 1,
    last: 100 + index,
    change24h: index % 5,
    range24hPosition: 0.5,
    quoteVolumeFloat: 100_000_000 - index * 2_000_000,
    normalizedQuoteVolume: 100_000_000 - index * 2_000_000,
    minQuoteVolume: 5_000_000,
  })),
];
const rankedInstruments = async () => ({
  ranked,
  providerMeta: {
    okxListed: 60,
    okxEligible: 60,
    gateListed: 0,
    gateEligible: 0,
    xyzListed: 20,
    xyzEligible: 20,
    xyzMinQuoteVolume: 5_000_000,
  },
});
const scanUniverse = new Function(
  'rankedInstruments',
  ...dependencyNames,
  `return (${extractFunction(source, 'scanUniverse')});`,
)(
  rankedInstruments,
  ...dependencyNames.map((name) => new Function(`return (${extractFunction(source, name)});`)()),
);

const cfg = {
  maxKlineScans: 16,
  anomalyScanLimit: 10,
  coreScanLimit: 3,
  coreScanEveryMs: 30 * 60 * 1000,
  extendedScanStart: 35,
  extendedScanEnd: 160,
  extendedScanBatch: 3,
  xyzScanLimit: 4,
  xyzAnomalyScanLimit: 2,
  xyzCoreScanLimit: 1,
  xyzExtendedScanStart: 8,
  xyzExtendedScanBatch: 1,
};
const state = {
  cfg,
  lastCoreScanAt: 0,
  scanCursor: 0,
  xyzScanCursor: 0,
  tickerSnapshot: null,
};
const first = await scanUniverse(state);
assert.equal(first.tickers.length, 16);
assert.equal(first.tickers.filter((ticker) => ticker.marketProvider === 'xyz').length, 4);
assert.equal(first.tickers.filter((ticker) => ticker.marketProvider !== 'xyz').length, 12);
assert.equal(first.meta.providerMeta.xyzScanned, 4);
assert.ok(first.tickers.some((ticker) => ticker.universeTier === 'xyz-core'));
assert.ok(first.tickers.some((ticker) => ticker.universeTier === 'xyz-extended'));

state.lastCoreScanAt = Date.now();
const second = await scanUniverse(state);
assert.equal(second.tickers.length, 16);
assert.equal(second.tickers.filter((ticker) => ticker.marketProvider === 'xyz').length, 4);
assert.equal(second.meta.xyzCoreScanned, 0);
assert.notEqual(second.meta.nextXyzCursor, first.meta.nextXyzCursor);

const reserveState = {
  cfg: {
    ...cfg,
    anomalyScanLimit: 2,
    coreScanLimit: 1,
    extendedScanBatch: 1,
  },
  lastCoreScanAt: 0,
  scanCursor: 0,
  xyzScanCursor: 0,
  tickerSnapshot: null,
};
const reserveFilled = await scanUniverse(reserveState);
assert.equal(reserveFilled.tickers.length, 16);
assert.ok(reserveFilled.tickers.some((ticker) => ticker.universeTier === 'reserve'));

console.log('XYZ scan allocation checks passed (16 total, reserve fill, XYZ anomaly/core/rotation coverage)');
