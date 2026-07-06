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

const source = readFileSync('worker/src/index.js', 'utf8');
const functionNames = [
  'providerFromInstId',
  'symbolFromInstId',
  'validTicker',
  'normalizeOkxTickers',
  'normalizeGateTickers',
  'deriveGateVolumeRatio',
  'mergeProviderInstruments',
  'normalizeGateKlines',
];
const functions = new Function(
  'GATE_FALLBACK_VOLUME_RATIO',
  `${functionNames.map((name) => extractFunction(source, name)).join('\n')}
   return { ${functionNames.join(', ')} };`,
)(0.25);

const okxRows = Array.from({ length: 12 }, (_, index) => ({
  instId: `TOKEN${index}-USDT-SWAP`,
  last: '2',
  open24h: '1.8',
  high24h: '2.1',
  low24h: '1.7',
  volCcy24h: String(15_000_000 + index),
}));
const gateRows = Array.from({ length: 12 }, (_, index) => ({
  contract: `TOKEN${index}_USDT`,
  last: '2',
  change_percentage: '11.11',
  high_24h: '2.1',
  low_24h: '1.7',
  volume_24h_quote: String(3_000_000 + index),
}));
gateRows.push({
  contract: 'GATEONLY_USDT',
  last: '0.5',
  change_percentage: '5',
  high_24h: '0.55',
  low_24h: '0.4',
  volume_24h_quote: '6000000',
});

const okx = functions.normalizeOkxTickers(okxRows);
const gate = functions.normalizeGateTickers(gateRows);
assert.equal(okx[0].quoteVolumeFloat, 30_000_000);
assert.equal(okx[0].marketProvider, 'okx');
assert.equal(gate[0].symbol, 'TOKEN0USDT');
assert.equal(gate.at(-1).marketProvider, 'gate');

const ratio = functions.deriveGateVolumeRatio(okx, gate, 20_000_000);
assert.ok(ratio > 0.099 && ratio < 0.101, `unexpected Gate/OKX volume ratio ${ratio}`);
assert.equal(functions.deriveGateVolumeRatio(okx.slice(0, 2), gate, 20_000_000), 0.25);

const merged = functions.mergeProviderInstruments(okx, gate, okx);
assert.equal(merged.filter((ticker) => ticker.symbol === 'TOKEN0USDT').length, 1);
assert.equal(merged.find((ticker) => ticker.symbol === 'TOKEN0USDT').marketProvider, 'okx');
assert.equal(merged.find((ticker) => ticker.symbol === 'GATEONLYUSDT').marketProvider, 'gate');

assert.equal(functions.symbolFromInstId('BTC-USDT-SWAP'), 'BTCUSDT');
assert.equal(functions.symbolFromInstId('GATE_ONLY_USDT'), 'GATEONLYUSDT');
assert.equal(functions.providerFromInstId('GATE_ONLY_USDT'), 'gate');

assert.deepEqual(
  functions.normalizeGateKlines([
    { t: '200', o: '2', h: '3', l: '1', c: '2.5', v: '20' },
    { t: '100', o: '1', h: '2', l: '0.5', c: '1.5', v: '10' },
  ]),
  [
    [100000, 1, 2, 0.5, 1.5, 10],
    [200000, 2, 3, 1, 2.5, 20],
  ],
);

assert.match(source, /GATE_MIN_QUOTE_VOLUME = 5_000_000/);
assert.match(source, /marketKlines\(ticker\.marketProvider, ticker\.instId/);
assert.match(source, /maxKlineScans: 28/);
assert.match(source, /marketProvider: sig\.marketProvider/);
assert.match(source, /Gate \$\{path\} \$\{response\.status\}/);

console.log('market provider checks passed (volume normalization, proportional threshold, OKX preference, Gate candles)');
