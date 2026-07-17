import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} was not found`);
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index++) {
    if (source[index] === '{') depth++;
    if (source[index] === '}' && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`${name} has no closing brace`);
}

const source = readFileSync('worker/src/index.js', 'utf8');
const controlAuthError = new Function(
  'json',
  `${extractFunction(source, 'timingSafeEqual')}
   ${extractFunction(source, 'controlAuthError')}
   return controlAuthError;`,
)((body, status) => ({ body, status }));

const request = (authorization = '') => ({
  headers: { get: (name) => name === 'Authorization' ? authorization : null },
});

let result = controlAuthError(request(), {});
assert.equal(result.status, 503);
assert.equal(result.body.error, 'paper_control_auth_not_configured');

result = controlAuthError(request(), { PAPER_CONTROL_TOKEN: 'correct-horse' });
assert.equal(result.status, 401);
assert.equal(result.body.error, 'paper_control_unauthorized');

result = controlAuthError(request('Bearer wrong'), { PAPER_CONTROL_TOKEN: 'correct-horse' });
assert.equal(result.status, 401);

result = controlAuthError(request('Bearer correct-horse'), { PAPER_CONTROL_TOKEN: 'correct-horse' });
assert.equal(result, null);

assert.match(source, /'Access-Control-Allow-Headers': 'Content-Type, Authorization'/);
console.log('Worker control authentication checks passed (missing, invalid, and valid token)');
