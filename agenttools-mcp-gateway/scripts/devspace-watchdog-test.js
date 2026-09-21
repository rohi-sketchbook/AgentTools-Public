const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const watchdog = require('../src/core/devspaceWatchdog');

function healthy(pid = 100) {
  return { ok: true, status: 'healthy', processRunning: true, portOccupied: true, healthResponsive: true, mcpResponsive: true, pids: [pid] };
}

function unhealthy(status = 'unresponsive', pid = 100) {
  return { ok: true, status, processRunning: status !== 'stopped', portOccupied: status !== 'stopped', healthResponsive: false, mcpResponsive: false, pids: status === 'stopped' ? [] : [pid] };
}

function createRuntime(overrides = {}) {
  let state = watchdog.defaultState();
  let current = overrides.status || healthy();
  let nowMs = overrides.nowMs || Date.parse('2026-07-28T00:00:00.000Z');
  const history = [];
  const recoverCalls = [];
  const config = {
    enabled: true,
    intervalMs: 10000,
    failureThreshold: 3,
    forceAfterFailures: 6,
    allowForceRecovery: true,
    recoveryCooldownMs: 0,
    maxRecoveriesPerHour: 5,
    circuitBreakerMs: 900000,
    historyLimit: 200,
    ...overrides.config,
  };
  const runtime = {
    config,
    now: () => nowMs,
    readStatus: async () => ({ ...current, pids: [...(current.pids || [])] }),
    recover: async ({ allowForce }) => {
      recoverCalls.push({ allowForce, at: nowMs });
      if (overrides.recover) return overrides.recover({ allowForce, setStatus: (value) => { current = value; }, getStatus: () => current });
      current = healthy(200);
      return { ok: true, changed: true, action: allowForce ? 'force-restart' : 'restart' };
    },
    readState: async () => JSON.parse(JSON.stringify(state)),
    writeState: async (next) => { state = JSON.parse(JSON.stringify(next)); },
    appendHistory: async (entry) => { history.push(JSON.parse(JSON.stringify(entry))); },
    readMaintenance: async () => overrides.readMaintenance ? overrides.readMaintenance() : overrides.maintenance || { active: false },
  };
  return {
    runtime,
    getState: () => state,
    getHistory: () => history,
    getRecoverCalls: () => recoverCalls,
    setStatus: (value) => { current = value; },
    advance: (ms) => { nowMs += ms; },
  };
}

async function main() {
  const results = [];
  async function test(name, fn) {
    try {
      await fn();
      results.push({ name, ok: true });
    } catch (error) {
      results.push({ name, ok: false, error: error.message });
    }
  }

  await test('manual maintenance suppresses failure counting and recovery', async () => {
    const fake = createRuntime({
      status: unhealthy(),
      maintenance: {
        active: true,
        reason: 'manual-restart',
        startedAt: '2026-07-28T00:00:00.000Z',
        expiresAt: '2026-07-28T00:02:00.000Z',
      },
    });
    const result = await watchdog.runCheck(fake.runtime);
    assert.equal(result.ok, true);
    assert.equal(result.event, 'manual-maintenance');
    assert.equal(fake.getRecoverCalls().length, 0);
    assert.equal(fake.getState().consecutiveFailures, 0);
  });

  await test('maintenance recheck blocks recovery when manual restart begins mid-check', async () => {
    let reads = 0;
    const fake = createRuntime({
      status: unhealthy(),
      config: { failureThreshold: 1, recoveryCooldownMs: 0 },
      readMaintenance: () => {
        reads += 1;
        return reads === 1 ? { active: false } : {
          active: true,
          reason: 'manual-restart',
          expiresAt: '2026-07-28T00:02:00.000Z',
        };
      },
    });
    const result = await watchdog.runCheck(fake.runtime);
    assert.equal(result.event, 'manual-maintenance');
    assert.equal(fake.getRecoverCalls().length, 0);
    assert.equal(fake.getState().consecutiveFailures, 0);
  });

  await test('healthy DevSpace is observed without recovery', async () => {
    const fake = createRuntime();
    const result = await watchdog.runCheck(fake.runtime);
    assert.equal(result.ok, true);
    assert.equal(result.event, 'healthy');
    assert.equal(fake.getRecoverCalls().length, 0);
    assert.equal(fake.getState().consecutiveFailures, 0);
  });

  await test('recovery waits for consecutive failure threshold', async () => {
    const fake = createRuntime({ status: unhealthy(), config: { failureThreshold: 3, forceAfterFailures: 6 } });
    assert.equal((await watchdog.runCheck(fake.runtime)).event, 'waiting-threshold');
    fake.advance(10000);
    assert.equal((await watchdog.runCheck(fake.runtime)).event, 'waiting-threshold');
    fake.advance(10000);
    const recovered = await watchdog.runCheck(fake.runtime);
    assert.equal(recovered.event, 'recovery-attempt');
    assert.equal(recovered.ok, true);
    assert.deepEqual(fake.getRecoverCalls().map((entry) => entry.allowForce), [false]);
    assert.equal(fake.getState().consecutiveFailures, 0);
  });

  await test('force recovery is delayed until a higher failure threshold', async () => {
    const fake = createRuntime({
      status: unhealthy(),
      config: { failureThreshold: 2, forceAfterFailures: 4, recoveryCooldownMs: 0 },
      recover: async ({ allowForce, setStatus }) => {
        if (!allowForce) return { ok: false, changed: false, action: 'graceful-restart-failed', error: 'graceful stop unavailable' };
        setStatus(healthy(300));
        return { ok: true, changed: true, action: 'force-restart' };
      },
    });
    await watchdog.runCheck(fake.runtime);
    fake.advance(10000);
    await watchdog.runCheck(fake.runtime);
    fake.advance(10000);
    await watchdog.runCheck(fake.runtime);
    fake.advance(10000);
    const result = await watchdog.runCheck(fake.runtime);
    assert.equal(result.ok, true);
    assert.deepEqual(fake.getRecoverCalls().map((entry) => entry.allowForce), [false, false, true]);
  });

  await test('recovery cooldown prevents restart loops', async () => {
    const fake = createRuntime({
      status: unhealthy(),
      config: { failureThreshold: 1, forceAfterFailures: 99, recoveryCooldownMs: 1000 },
      recover: async () => ({ ok: false, changed: false, action: 'restart-failed', error: 'test failure' }),
    });
    await watchdog.runCheck(fake.runtime);
    fake.advance(500);
    const cooldown = await watchdog.runCheck(fake.runtime);
    assert.equal(cooldown.event, 'cooldown');
    assert.equal(fake.getRecoverCalls().length, 1);
    fake.advance(600);
    await watchdog.runCheck(fake.runtime);
    assert.equal(fake.getRecoverCalls().length, 2);
  });

  await test('watchdog history is compacted to a bounded number of recent entries', async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-watchdog-history-'));
    const historyFile = path.join(temp, 'watchdog-history.jsonl');
    try {
      const lines = Array.from({ length: 1000 }, (_, index) => JSON.stringify({ index, message: 'x'.repeat(80) }));
      fs.writeFileSync(historyFile, `${lines.join('\n')}\n`, 'utf8');
      const result = watchdog.compactHistoryFile(historyFile, { historyMaxBytes: 64 * 1024, historyLimit: 10 });
      assert.equal(result.compacted, true);
      const retained = fs.readFileSync(historyFile, 'utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line));
      assert.equal(retained.length, 10);
      assert.equal(retained[0].index, 990);
      assert.equal(retained[9].index, 999);
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  await test('recovery rate limit opens circuit breaker', async () => {
    const fake = createRuntime({
      status: unhealthy(),
      config: { failureThreshold: 1, forceAfterFailures: 99, recoveryCooldownMs: 0, maxRecoveriesPerHour: 2, circuitBreakerMs: 60000 },
      recover: async () => ({ ok: false, changed: false, action: 'restart-failed', error: 'test failure' }),
    });
    await watchdog.runCheck(fake.runtime);
    fake.advance(10000);
    await watchdog.runCheck(fake.runtime);
    fake.advance(10000);
    const limited = await watchdog.runCheck(fake.runtime);
    assert.equal(limited.event, 'circuit-opened');
    assert.equal(fake.getRecoverCalls().length, 2);
    assert.ok(fake.getState().circuitOpenUntil);
  });

  const failed = results.filter((entry) => !entry.ok);
  process.stdout.write(`${JSON.stringify({ ok: failed.length === 0, tests: results }, null, 2)}\n`);
  if (failed.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  process.stdout.write(`${JSON.stringify({ ok: false, error: error.message, stack: error.stack }, null, 2)}\n`);
  process.exitCode = 1;
});
