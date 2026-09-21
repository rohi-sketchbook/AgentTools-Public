#!/usr/bin/env node
const watchdog = require('../src/core/devspaceWatchdog');
const { createResourceBudgetMonitor } = require('../src/core/resourceBudgetMonitor');
const workTaskContinuation = require('../src/core/workTaskContinuation');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function print(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

async function runOnce(config) {
  const result = await watchdog.runCheck(watchdog.defaultRuntime(config));
  print({ at: new Date().toISOString(), watchdog: 'devspace', ...result, state: undefined });
  return result;
}

async function main() {
  const config = watchdog.watchdogConfig();
  const once = process.argv.slice(2).includes('--once');
  if (!config.enabled) {
    print({ ok: true, watchdog: 'devspace', enabled: false, message: 'Watchdog is disabled by config/watchdog.json.' });
    return;
  }

  if (once) {
    const result = await runOnce(config);
    if (!result.ok && !['waiting-threshold', 'cooldown', 'circuit-open'].includes(result.event)) process.exitCode = 1;
    return;
  }

  const lock = watchdog.acquireLock(config);
  if (!lock.ok) {
    print({ ok: false, watchdog: 'devspace', ...lock });
    process.exitCode = lock.alreadyRunning ? 0 : 1;
    return;
  }

  const state = watchdog.readState(config);
  state.watchdogPid = process.pid;
  state.watchdogStartedAt = lock.startedAt;
  watchdog.writeState(state, config);
  watchdog.appendHistory({ at: lock.startedAt, event: 'watchdog-started', pid: process.pid }, config);
  print({ ok: true, watchdog: 'devspace', event: 'started', pid: process.pid, intervalMs: config.intervalMs });

  const resourceMonitor = createResourceBudgetMonitor();
  let nextResourceSampleAt = 0;
  let nextContinuationSweepAt = 0;
  let stopping = false;
  const stop = (signal) => {
    if (stopping) return;
    stopping = true;
    try {
      const current = watchdog.readState(config);
      current.watchdogPid = null;
      current.watchdogStartedAt = null;
      watchdog.writeState(current, config);
      watchdog.appendHistory({ at: new Date().toISOString(), event: 'watchdog-stopped', pid: process.pid, signal }, config);
      watchdog.releaseLock(config);
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));

  while (!stopping) {
    try {
      const result = await watchdog.runCheck(watchdog.defaultRuntime(config));
      if (result.event !== 'healthy') {
        print({ at: new Date().toISOString(), watchdog: 'devspace', event: result.event, ok: result.ok, allowForce: result.allowForce || false, status: result.after?.status || result.status?.status || result.before?.status || null });
      }

      const now = Date.now();
      if (now >= nextContinuationSweepAt) {
        const continuationRuntime = workTaskContinuation.continuationConfig();
        nextContinuationSweepAt = now + continuationRuntime.policy.continuationScanIntervalMs;
        const continuationResult = workTaskContinuation.runContinuationSweep({ nowMs: now, runtime: continuationRuntime });
        for (const event of continuationResult.events || []) {
          if (event.action === 'running') continue;
          const payload = {
            at: new Date().toISOString(),
            watchdog: 'work-task-continuation',
            mode: continuationResult.mode,
            ...event,
          };
          watchdog.appendHistory(payload, config);
          print(payload);
        }
      }

      if (now >= nextResourceSampleAt) {
        nextResourceSampleAt = now + 60_000;
        const resourceResult = await resourceMonitor.sample(now);
        if (!resourceResult.ok) {
          watchdog.appendHistory({ at: new Date().toISOString(), event: 'resource-monitor-error', error: resourceResult.error }, config);
        }
        for (const incident of resourceResult.incidents || []) {
          const payload = {
            at: new Date().toISOString(),
            watchdog: 'resource-budget',
            event: 'resource-budget-exceeded',
            ok: false,
            pid: incident.pid,
            name: incident.name,
            cpuOneCorePercent: Number(incident.cpuOneCorePercent.toFixed(1)),
            readMbPerSec: Number(incident.readMbPerSec.toFixed(2)),
            writeMbPerSec: Number(incident.writeMbPerSec.toFixed(2)),
            workingSetMb: Number(incident.workingSetMb.toFixed(1)),
            violations: incident.violations,
            sustainedSamples: incident.sustainedSamples,
          };
          watchdog.appendHistory(payload, config);
          print(payload);
        }
      }
    } catch (error) {
      watchdog.appendHistory({ at: new Date().toISOString(), event: 'watchdog-error', error: error.message }, config);
      print({ ok: false, watchdog: 'devspace', event: 'error', error: error.message });
    }
    await sleep(config.intervalMs);
  }
}

main().catch((error) => {
  try { watchdog.releaseLock(); } catch { /* best effort */ }
  print({ ok: false, watchdog: 'devspace', event: 'fatal', error: error.message });
  process.exitCode = 1;
});
