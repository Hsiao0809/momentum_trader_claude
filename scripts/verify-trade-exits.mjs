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

const html = readFileSync('momentum_trader_claude.html', 'utf8');
const tradeExitSummary = new Function(`return (${extractFunction(html, 'tradeExitSummary')});`)();

const ub = tradeExitSummary({
  qty: 1973.2113284187133,
  exit: 0.1029,
  partialExits: [{
    type: 'be_partial',
    exit: 0.111132,
    qty: 986.6056642093566,
  }],
});
assert.ok(Math.abs(ub.averageExit - 0.107016) < 1e-12);
assert.equal(ub.legs.length, 2);
assert.equal(ub.legs[0].sharePct, 50);
assert.equal(ub.legs[1].sharePct, 50);

const single = tradeExitSummary({ qty: 10, exit: 5, partialExits: [] });
assert.equal(single.averageExit, 5);
assert.equal(single.legs.length, 1);
assert.equal(single.legs[0].sharePct, 100);

const threeLegs = tradeExitSummary({
  qty: 100,
  exit: 12,
  partialExits: [
    { type: 'be_partial', exit: 11, qty: 50 },
    { type: 'tp1', exit: 14, qty: 25 },
  ],
});
assert.equal(threeLegs.averageExit, 12);
assert.deepEqual(threeLegs.legs.map((leg) => leg.sharePct), [50, 25, 25]);

assert.match(html, /<th>Avg Exit<\/th>/);
assert.match(html, /REASON_LABELS\[t\.reason\]/);

console.log('trade exit checks passed (single, partial, and three-leg exits)');
