const assert = require('node:assert/strict');
const { DEFAULT_BUDGET, evaluateResourceDelta } = require('../src/core/resourceBudgetMonitor');

const base = {
  pid: 10,
  name: 'node.exe',
  commandLine: 'node D:/projects/AgentTools/test.js',
  creationDate: '2026-08-21T00:00:00.000Z',
  kernelTime100ns: 1_000_000,
  userTime100ns: 2_000_000,
  readBytes: 10_000_000,
  writeBytes: 1_000_000,
  workingSetBytes: 100 * 1024 * 1024,
};

const idle = evaluateResourceDelta(base, {
  ...base,
  kernelTime100ns: base.kernelTime100ns + 100_000,
  userTime100ns: base.userTime100ns + 100_000,
  readBytes: base.readBytes + 64 * 1024,
  writeBytes: base.writeBytes + 16 * 1024,
}, 10_000, DEFAULT_BUDGET);
assert.ok(idle);
assert.deepEqual(idle.violations, []);

const hot = evaluateResourceDelta(base, {
  ...base,
  kernelTime100ns: base.kernelTime100ns + 10_000_000,
  userTime100ns: base.userTime100ns + 20_000_000,
  readBytes: base.readBytes + 120 * 1024 * 1024,
  writeBytes: base.writeBytes + 30 * 1024 * 1024,
  workingSetBytes: 2 * 1024 * 1024 * 1024,
}, 10_000, DEFAULT_BUDGET);
assert.ok(hot.violations.includes('cpu'));
assert.ok(hot.violations.includes('read'));
assert.ok(hot.violations.includes('write'));
assert.ok(hot.violations.includes('memory'));

process.stdout.write('resource-budget-test: PASS\n');
