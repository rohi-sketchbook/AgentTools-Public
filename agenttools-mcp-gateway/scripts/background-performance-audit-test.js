const assert = require('node:assert/strict');
const { analyzeSource } = require('./background-performance-audit');

assert.equal(analyzeSource(`setInterval(() => { doWork(); }, 10_000);`).length, 0);
assert.equal(analyzeSource(`setInterval(() => { fs.readFileSync('x'); }, 2_000);`).length, 1);
assert.equal(analyzeSource(`setInterval(() => { tick(); }, 500);`).length, 1);
assert.equal(analyzeSource(`setInterval(() => { tick(); }, runtimeIntervalMs);`).length, 1);
assert.equal(analyzeSource(`// performance-audit: allow-bounded-poll — one file only\nsetInterval(() => { fs.readFileSync('x'); }, 5_000);`).length, 0);

process.stdout.write('background-performance-audit-test: PASS\n');
