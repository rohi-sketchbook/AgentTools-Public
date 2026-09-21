const { createConfirmation, verifyConfirmation } = require('../core/confirmations');
const manager = require('../core/devspaceManager');
const processCore = require('../core/processes');

function truthy(value) {
  return value === true || value === 'true' || value === '1' || value === 'yes';
}

function defaultRuntime() {
  return {
    readStatus: manager.status,
    readLogs: manager.readLogs,
    runDiagnose: manager.diagnose,
    installationState: manager.installationState,
    startProcess: manager.startProcess,
    waitFor: manager.waitFor,
    devspaceProcesses: manager.devspaceProcesses,
    managerConfig: manager.managerConfig,
    requestGracefulShutdown: manager.requestGracefulShutdown,
    stopPid: processCore.stopPid,
    clearControlState: manager.clearControlState,
  };
}

async function status() {
  return manager.status();
}

async function health() {
  const current = await manager.status();
  return {
    ok: current.ok,
    status: current.status,
    processRunning: current.processRunning,
    portOccupied: current.portOccupied,
    listenerPids: current.listenerPids,
    mcpResponsive: current.mcpResponsive,
    healthResponsive: current.healthResponsive,
    pid: current.pid,
    pids: current.pids,
    version: current.version,
    checkedAt: current.checkedAt,
    endpoint: current.endpoint,
  };
}

async function logs(options = {}) {
  return manager.readLogs(options);
}

async function workspaceLookup(options = {}) {
  return manager.workspaceLookup(options.path, { mode: options.mode });
}

async function diagnose() {
  return manager.diagnose();
}

async function startInternal(deps = defaultRuntime()) {
  const before = await deps.readStatus();
  if (before.status === 'healthy') {
    return { ok: true, changed: false, action: 'none', before, after: before, message: 'DevSpace is already healthy.' };
  }
  if (before.processRunning) {
    return {
      ok: false,
      changed: false,
      action: 'start',
      before,
      error: `DevSpace process already exists but status is ${before.status}; use devspace.restart or devspace.recover instead.`,
    };
  }
  if (before.portOccupied || before.healthResponsive || before.mcpResponsive) {
    return {
      ok: false,
      changed: false,
      action: 'start',
      before,
      error: 'Configured DevSpace endpoint/port is already in use without a trusted DevSpace process match; refusing a duplicate start. Diagnose ownership first.',
    };
  }

  const installation = await deps.installationState();
  if (!installation.startable) {
    return { ok: false, changed: false, action: 'start', before, installation, error: 'DevSpace installation failed preflight checks; automatic reinstall/update is disabled.' };
  }

  const spawned = deps.startProcess();
  if (!spawned.ok) return { ok: false, changed: false, action: 'start', before, spawned, error: spawned.error };

  const cfg = deps.managerConfig();
  const wait = await deps.waitFor(async () => {
    const current = await deps.readStatus();
    return current.status === 'healthy' ? current : null;
  }, Math.max(Number(cfg.startupTimeoutMs || 15000), 45000));
  const after = wait.ok ? wait.value : await deps.readStatus();
  return {
    ok: wait.ok && after.status === 'healthy',
    changed: true,
    action: 'start',
    before,
    spawned,
    after,
    error: wait.ok ? null : `DevSpace started as PID ${spawned.pid}, but did not become healthy: ${wait.error}`,
  };
}

async function stopInternal({ force = false } = {}, deps = defaultRuntime()) {
  const before = await deps.readStatus();
  if (!before.processRunning) {
    return { ok: true, changed: false, action: 'none', before, after: before, message: 'DevSpace is already stopped.' };
  }

  const currentProcesses = await deps.devspaceProcesses();
  if (!currentProcesses.ok || !currentProcesses.ownershipVerified || currentProcesses.processes.length === 0) {
    return { ok: false, changed: false, action: 'stop', before, error: currentProcesses.error || 'DevSpace process ownership could not be revalidated against the configured port/launcher.' };
  }

  if (!force && currentProcesses.processes.some((processInfo) => !processInfo.ownership?.gracefulStopAvailable)) {
    return {
      ok: false,
      changed: false,
      action: 'stop',
      before,
      requiresForce: true,
      error: 'Graceful supervisor stop is unavailable for this externally-started DevSpace process. Refusing to substitute a force kill without explicit force permission.',
    };
  }

  const results = [];
  for (const processInfo of currentProcesses.processes) {
    if (force) results.push(await deps.stopPid(processInfo.pid, { force: true, tree: true, timeoutMs: 15000, expectedCreationDate: processInfo.creationDate || null }));
    else results.push(deps.requestGracefulShutdown(processInfo.pid));
  }
  if (results.every((result) => !result.ok)) {
    return {
      ok: false,
      changed: false,
      action: force ? 'force-stop' : 'stop',
      before,
      stopResults: results,
      error: results.map((result) => result.error).filter(Boolean).join('; ') || 'All stop requests failed.',
    };
  }

  const cfg = deps.managerConfig();
  const wait = await deps.waitFor(async () => {
    const current = await deps.readStatus();
    return !current.processRunning && !current.healthResponsive ? current : null;
  }, Number(cfg.stopTimeoutMs || 10000));
  const after = wait.ok ? wait.value : await deps.readStatus();
  if (!after.processRunning) deps.clearControlState(currentProcesses.processes.map((processInfo) => processInfo.pid));
  return {
    ok: wait.ok && !after.processRunning,
    changed: true,
    action: force ? 'force-stop' : 'stop',
    before,
    stopResults: results,
    after,
    error: wait.ok ? null : `DevSpace did not stop within the configured timeout: ${wait.error}`,
  };
}

async function restartInternal({ force = false } = {}, deps = defaultRuntime()) {
  const stopped = await stopInternal({ force }, deps);
  if (!stopped.ok) return { ok: false, action: 'restart', stopped, error: stopped.error || 'DevSpace stop failed.' };
  const started = await startInternal(deps);
  return { ok: started.ok, action: 'restart', stopped, started, error: started.ok ? null : started.error };
}

async function recoverInternal({ allowForce = false } = {}, deps = defaultRuntime()) {
  const diagnostic = await deps.runDiagnose();
  if (diagnostic.status === 'healthy') {
    return { ok: true, changed: false, action: 'none', diagnostic, message: 'DevSpace is already healthy.' };
  }
  if (!diagnostic.restartPossible) {
    return { ok: false, changed: false, action: 'manual-repair-required', diagnostic, error: 'DevSpace installation/configuration is not safely startable; automatic reinstall/update is disabled.' };
  }

  const fresh = await deps.runDiagnose();
  if (fresh.status === 'healthy') return { ok: true, changed: false, action: 'none', diagnostic: fresh };
  if (fresh.status === 'stopped') {
    const started = await startInternal(deps);
    return { ok: started.ok, changed: true, action: 'start', diagnostic: fresh, result: started, error: started.ok ? null : started.error };
  }

  const gracefulStop = await stopInternal({ force: false }, deps);
  if (gracefulStop.ok) {
    const started = await startInternal(deps);
    return { ok: started.ok, changed: true, action: 'restart', diagnostic: fresh, gracefulStop, started, error: started.ok ? null : started.error };
  }
  if (!allowForce) {
    return {
      ok: false,
      changed: true,
      action: 'graceful-restart-failed',
      diagnostic: fresh,
      gracefulStop,
      error: 'Graceful stop did not complete or is unavailable. Retry recover with allowForce=true only after reviewing the diagnosis.',
    };
  }

  const forceStop = await stopInternal({ force: true }, deps);
  if (!forceStop.ok) return { ok: false, changed: true, action: 'force-stop-failed', diagnostic: fresh, gracefulStop, forceStop, error: forceStop.error };
  const started = await startInternal(deps);
  return { ok: started.ok, changed: true, action: 'force-restart', diagnostic: fresh, gracefulStop, forceStop, started, error: started.ok ? null : started.error };
}

function confirmationFor(action, options = {}, preview = null) {
  const force = truthy(options.force) || truthy(options.allowForce);
  const payload = { action, force };
  const impact = force ? 'destructive' : 'write';
  return {
    payload,
    impact,
    preview,
    create() {
      return createConfirmation({
        action: `devspace.${action}`,
        impact,
        summary: `${action} the registered DevSpace instance${force ? ' with force escalation allowed' : ''}`,
        payload,
        preview,
      });
    },
    verify(token) {
      return verifyConfirmation({ action: `devspace.${action}`, token, payload, impact, consume: true });
    },
  };
}

async function start(options = {}) {
  const current = await manager.status();
  if (current.status === 'healthy') return { ok: true, changed: false, action: 'none', status: current, message: 'DevSpace is already healthy.' };
  const guard = confirmationFor('start', options, { status: current.status, pids: current.pids, installationStartable: current.installation.startable });
  if (!options.confirmToken) return guard.create();
  const confirmation = guard.verify(options.confirmToken);
  if (!confirmation.ok) return confirmation;
  return startInternal();
}

async function stop(options = {}) {
  const force = truthy(options.force);
  const current = await manager.status();
  if (!current.processRunning) return { ok: true, changed: false, action: 'none', status: current, message: 'DevSpace is already stopped.' };
  const guard = confirmationFor('stop', { force }, { status: current.status, pids: current.pids, force });
  if (!options.confirmToken) return guard.create();
  const confirmation = guard.verify(options.confirmToken);
  if (!confirmation.ok) return confirmation;
  return stopInternal({ force });
}

async function restart(options = {}) {
  const force = truthy(options.force);
  const current = await manager.status();
  const guard = confirmationFor('restart', { force }, { status: current.status, pids: current.pids, force, sequence: ['revalidate', 'stop', 'wait', 'start', 'health-check'] });
  if (!options.confirmToken) return guard.create();
  const confirmation = guard.verify(options.confirmToken);
  if (!confirmation.ok) return confirmation;
  return restartInternal({ force });
}

async function recover(options = {}) {
  const allowForce = truthy(options.allowForce) || truthy(options.force);
  const diagnostic = await manager.diagnose();
  if (diagnostic.status === 'healthy') {
    return { ok: true, changed: false, action: 'none', diagnostic, message: 'DevSpace is already healthy.' };
  }
  if (!diagnostic.restartPossible) {
    return { ok: false, changed: false, action: 'manual-repair-required', diagnostic, error: 'DevSpace installation/configuration is not safely startable; automatic reinstall/update is disabled.' };
  }

  const plannedAction = diagnostic.status === 'stopped' ? 'start' : 'restart';
  const guard = confirmationFor('recover', { allowForce }, {
    status: diagnostic.status,
    recommendedAction: diagnostic.recommendedAction,
    plannedAction,
    allowForce,
    policy: 'diagnose -> no-op if healthy -> start if stopped -> supervisor graceful restart when available -> optional force restart -> health check',
  });
  if (!options.confirmToken) return guard.create();
  const confirmation = guard.verify(options.confirmToken);
  if (!confirmation.ok) return confirmation;
  return recoverInternal({ allowForce });
}

module.exports = {
  status,
  health,
  logs,
  workspaceLookup,
  start,
  stop,
  restart,
  diagnose,
  recover,
  _internal: { defaultRuntime, startInternal, stopInternal, restartInternal, recoverInternal },
};
