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
const positionsNewestFirst = new Function(
  `${extractFunction(htmlSource, 'positionsNewestFirst')}
   return positionsNewestFirst;`,
)();

const positions = [
  { id: 'old', entryTime: 100 },
  { id: 'legacy' },
  { id: 'new', entryTime: 300 },
  { id: 'middle', entryTime: 200 },
];
const originalOrder = positions.map((position) => position.id);
const sorted = positionsNewestFirst(positions);

assert.deepEqual(sorted.map((position) => position.id), ['new', 'middle', 'old', 'legacy']);
assert.deepEqual(positions.map((position) => position.id), originalOrder, 'sorting must not mutate stored positions');
assert.match(
  htmlSource,
  /const orderedPositions = positionsNewestFirst\(state\.positions\);[\s\S]*?orderedPositions\.length \? orderedPositions\.map\(/,
  'Paper Positions must render the newest-first view',
);

console.log('paper position ordering checks passed (newest first without mutating stored positions)');
