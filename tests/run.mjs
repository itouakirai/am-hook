#!/usr/bin/env node
// Runs the Node test suites (cargo runs the Rust ones):
//   node tests/run.mjs unit                 offline, Node only (tests/unit/, all run in CI)
//   node tests/run.mjs ui   [filter...]     offline, Playwright + installed Chrome with local fixtures (tests/ui/)
//   node tests/run.mjs live [filter...]     needs a running am-hook, wrapper-lite and Apple access (tests/live/)
// A filter keeps the files whose name contains it (`node tests/run.mjs ui library`).
// ui / live pass the Playwright package as the first argument: $PLAYWRIGHT, else target/pw/node_modules/playwright-core
// when present, else `playwright` from node_modules. live scripts read the server from $AM_HOOK_URL
// (default http://127.0.0.1:8888); the MV / radio scripts take it as their second argument, which is passed through.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const [suite, ...filters] = process.argv.slice(2);
if (!['unit', 'ui', 'live'].includes(suite)) {
  console.error('usage: node tests/run.mjs unit|ui|live [filter...]');
  process.exit(2);
}
const dir = path.join(root, 'tests', suite);
const files = fs.readdirSync(dir)
  .filter((f) => /\.(c|m)?js$/.test(f) && (!filters.length || filters.some((x) => f.includes(x))))
  .sort();
if (!files.length) {
  console.error(`no tests in tests/${suite} match ${filters.join(' ')}`);
  process.exit(2);
}

if (suite === 'unit') {
  const result = spawnSync(process.execPath, ['--test', ...files.map((f) => path.join('tests', suite, f))], { cwd: root, stdio: 'inherit' });
  process.exit(result.status ?? 1);
}

const local = path.join(root, 'target/pw/node_modules/playwright-core');
const playwright = process.env.PLAYWRIGHT || (fs.existsSync(local) ? local : 'playwright');
const base = process.env.AM_HOOK_URL;
const results = [];
for (const file of files) {
  const started = Date.now();
  console.log(`\n=== ${suite}/${file}`);
  const args = [path.join('tests', suite, file), playwright, ...(suite === 'live' && base ? [base] : [])];
  const { status } = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
  results.push({ file, ok: status === 0, seconds: ((Date.now() - started) / 1000).toFixed(1) });
}
console.log(`\n${suite} summary:`);
for (const { file, ok, seconds } of results) console.log(`  ${ok ? 'pass' : 'FAIL'}  ${file}  ${seconds}s`);
const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `${failed} of ${results.length} failed` : `all ${results.length} passed`);
process.exit(failed ? 1 : 0);
