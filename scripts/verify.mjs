// Static verification gate: `npm run verify`
// Checks worker syntax, dashboard inline-script syntax, and that the build runs.
// This catches syntax-level breakage only; logic changes still need the
// checklists in .claude/docs/30-JUDGMENT.md.
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

let failed = false;
const step = (name, fn) => {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failed = true;
    console.error(`FAIL ${name}\n${err.stdout?.toString() || ''}${err.stderr?.toString() || err.message}`);
  }
};

step('worker syntax (node --check)', () => {
  execFileSync(process.execPath, ['--check', 'worker/src/index.js']);
});

step('market context behavior and Worker/dashboard parity', () => {
  execFileSync(process.execPath, ['scripts/verify-market-context.mjs']);
});

step('recent signal retention and scan health behavior', () => {
  execFileSync(process.execPath, ['scripts/verify-recent-signals.mjs']);
});

step('OKX and Gate market provider behavior', () => {
  execFileSync(process.execPath, ['scripts/verify-market-providers.mjs']);
});

step('closed-trade average exit and partial-exit display', () => {
  execFileSync(process.execPath, ['scripts/verify-trade-exits.mjs']);
});

step('position activity recording and legacy reconstruction', () => {
  execFileSync(process.execPath, ['scripts/verify-position-events.mjs']);
});

const html = await readFile('momentum_trader_claude.html', 'utf8');
// Match <script> tags with or without attributes; skip external (src=) scripts.
const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
  .filter((m) => !/\bsrc\s*=/i.test(m[1]))
  .map((m) => m[2]);
if (scripts.length === 0) {
  failed = true;
  console.error('FAIL dashboard inline script: no <script> block found in momentum_trader_claude.html');
}
const dir = await mkdtemp(join(tmpdir(), 'verify-'));
try {
  for (let i = 0; i < scripts.length; i++) {
    const file = join(dir, `inline-${i}.js`);
    await writeFile(file, scripts[i]);
    step(`dashboard inline script #${i} syntax (node --check)`, () => {
      execFileSync(process.execPath, ['--check', file]);
    });
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}

step('build (scripts/build.mjs)', () => {
  execFileSync(process.execPath, ['scripts/build.mjs']);
});

if (failed) {
  console.error('\nverify FAILED');
  process.exit(1);
}
console.log('\nverify passed');
