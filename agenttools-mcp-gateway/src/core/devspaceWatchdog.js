const fs = require('node:fs');
const path = require('node:path');
const { projectRoot, readJson } = require('./config');
const { sanitizeLogText } = require('./redaction');
const manager = require('./devspaceManager');
const devspaceTool = require('../tools/devspace');

const INTERNAL_ROOT = path.join(projectRoot, 'state', 'devspace');

function watchdogConfig() {
  const raw = readJson('config/watchdog.json');
  const integer = (value, fallback, min, max) => {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return fallback;
    return Math.max(min, Math.min(max, Math.floor(numeric)));
  };
  const config = {
    enabled: raw.enabled !== false,
    intervalMs: integer(raw.intervalMs, 10000, 1000, 300000),
    healthyPersistIntervalMs: integer(raw.healthyPersistIntervalMs, 60000, 10000, 3600000),
    failureThreshold: integer(raw.failureThreshold, 3, 1, 100),
    forceAfterFailures: integer(raw.forceAfterFailures, 6, 1, 1000),
    allowForceRecovery: raw.allowForceRecovery === true,
    recoveryCooldownMs: integer(raw.recoveryCooldownMs, 20000, 0, 3600000),
    maxRecoveriesPerHour: integer(raw.maxRecoveriesPerHour, 5, 1, 100),
    circuitBreakerMs: integer(raw.circuitBreakerMs, 900000, 1000, 86400000),
    historyLimit: integer(raw.historyLimit, 200, 10, 5000),
    historyMaxBytes: integer(raw.historyMaxBytes, 1024 * 1024, 64 * 1024, 100 * 1024 * 1024),
    stateFile: String(raw.stateFile || 'state/devspace/watchdog-state.json'),
    historyFile: String(raw.historyFile || 'state/devspace/watchdog-history.jsonl'),
    lockFile: String(raw.lockFile || 'state/devspace/watchdog.lock'),
  };
  if (config.forceAfterFailures < config.failureThreshold) {
    config.forceAfterFailures = config.failureThreshold;
  }
  return config;
}

function maintenancePath() {
  return path.join(INTERNAL_ROOT, 'manual-maintenance.json');
}

function readMaintenance(nowMs = Date.now()) {
  const file = maintenancePath();
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const expiresAtMs = Date.parse(String(parsed.expiresAt || ''));
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs) {
      try { fs.unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      return { active: false, file, expired: true };
    }
    return {
      active: true,
      file,
      reason: String(parsed.reason || 'manual-maintenance'),
      startedAt: parsed.startedAt || null,
      expiresAt: parsed.expiresAt,
      requestedBy: parsed.requestedBy || null,
    };
  } catch (error) {
    if (error.code === 'ENOENT') return { active: false, file };
    return { active: false, file, error: error.message };
  }
}

function beginMaintenance(options = {}) {
  fs.mkdirSync(INTERNAL_ROOT, { recursive: true });
  const ttlMs = Math.max(30000, Math.min(Number(options.ttlMs || 120000), 10 * 60 * 1000));
  const startedAt = new Date().toISOString();
  const record = {
    reason: String(options.reason || 'manual-restart'),
    requestedBy: String(options.requestedBy || 'manual-control'),
    startedAt,
    expiresAt: new Date(Date.now() + ttlMs).toISOString(),
  };
  const file = maintenancePath();
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    fs.renameSync(temp, file);
  } finally {
    try { fs.unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return { active: true, file, ...record };
}

function endMaintenance() {
  const file = maintenancePath();
  try {
    fs.unlinkSync(file);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function internalPath(relativePath) {
  const resolved = path.resolve(projectRoot, String(relativePath || ''));
  const root = path.resolve(INTERNAL_ROOT);
  const child = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  const parent = process.platform === 'win32' ? root.toLowerCase() : root;
  if (child !== parent && !child.startsWith(`${parent}${path.sep}`)) {
    throw new Error(`Watchdog state path must stay under ${root}`);
  }
  return resolved;
}

function statePaths(config = watchdogConfig()) {
  return {
    state: internalPath(config.stateFile),
    history: internalPath(config.historyFile),
    lock: internalPath(config.lockFile),
  };
}

function defaultState() {
  return {
    version: 1,
    watchdogPid: null,
    watchdogStartedAt: null,
    lastCheckAt: null,
    lastStatus: null,
    consecutiveFailures: 0,
    lastFailureAt: null,
    lastRecoveryAt: null,
    lastRecoveryAction: null,
    lastRecoveryOk: null,
    lastError: null,
    totalRecoveries: 0,
    successfulRecoveries: 0,
    failedRecoveries: 0,
    recoveryAttempts: [],
    circuitOpenUntil: null,
  };
}

function readState(config = watchdogConfig()) {
  const file = statePaths(config).state;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { ...defaultState(), ...parsed };
  } catch (error) {
    if (error.code === 'ENOENT') return defaultState();
    throw error;
  }
}

function writeState(state, config = watchdogConfig()) {
  const file = statePaths(config).state;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    fs.renameSync(temp, file);
  } finally {
    try { fs.unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return file;
}

function safeHistoryEntry(entry) {
  const result = { ...entry };
  if (result.error) result.error = sanitizeLogText(result.error, 2000);
  if (Array.isArray(result.pids)) result.pids = result.pids.map(Number).filter(Number.isInteger);
  return result;
}

function compactHistoryFile(file, config = watchdogConfig()) {
  if (!fs.existsSync(file)) return { compacted: false, file, sizeBytes: 0, retainedEntries: 0 };
  const stat = fs.statSync(file);
  const maxBytes = Math.max(64 * 1024, Number(config.historyMaxBytes || 1024 * 1024));
  if (stat.size <= maxBytes) {
    return { compacted: false, file, sizeBytes: stat.size, retainedEntries: null };
  }

  const historyLimit = Math.max(10, Math.min(5000, Number(config.historyLimit || 200)));
  const maxReadBytes = Math.min(stat.size, Math.max(maxBytes * 2, 2 * 1024 * 1024));
  const start = Math.max(0, stat.size - maxReadBytes);
  const fd = fs.openSync(file, 'r');
  let lines;
  try {
    const buffer = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    lines = buffer.toString('utf8').split(/\r?\n/).filter(Boolean);
  } finally {
    fs.closeSync(fd);
  }
  if (start > 0 && lines.length > 0) lines = lines.slice(1);
  const retained = lines.slice(-historyLimit);
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temp, retained.length > 0 ? `${retained.join('\n')}\n` : '', 'utf8');
    fs.renameSync(temp, file);
  } finally {
    try { fs.unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return { compacted: true, file, sizeBytes: fs.statSync(file).size, retainedEntries: retained.length };
}

function appendHistory(entry, config = watchdogConfig()) {
  const file = statePaths(config).history;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(safeHistoryEntry(entry))}\n`, 'utf8');
  compactHistoryFile(file, config);
  return file;
}

function readHistory(options = {}, config = watchdogConfig()) {
  const file = statePaths(config).history;
  const requested = Number(options.limit ?? config.historyLimit ?? 200);
  const limit = Math.max(1, Math.min(Number.isFinite(requested) ? Math.floor(requested) : 200, 5000));
  if (!fs.existsSync(file)) return { ok: true, available: false, file, entries: [] };

  const stat = fs.statSync(file);
  const maxReadBytes = 2 * 1024 * 1024;
  const start = Math.max(0, stat.size - maxReadBytes);
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    let lines = buffer.toString('utf8').split(/\r?\n/).filter(Boolean);
    if (start > 0 && lines.length > 0) lines = lines.slice(1);
    const entries = [];
    for (const line of lines.slice(-limit)) {
      try { entries.push(JSON.parse(line)); } catch { entries.push({ event: 'unparseable', raw: sanitizeLogText(line, 1000) }); }
    }
    return { ok: true, available: true, file, sizeBytes: stat.size, truncatedRead: start > 0, entries };
  } finally {
    fs.closeSync(fd);
  }
}

function pidAlive(pid) {
  const numeric = Number(pid);
  if (!Number.isInteger(numeric) || numeric <= 0) return false;
  try {
    process.kill(numeric, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function readLock(config = watchdogConfig()) {
  const file = statePaths(config).lock;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const pid = Number(parsed.pid);
    return { ...parsed, pid: Number.isInteger(pid) ? pid : null, alive: pidAlive(pid), file };
  } catch (error) {
    if (error.code === 'ENOENT') return { pid: null, alive: false, file };
    return { pid: null, alive: false, file, error: error.message };
  }
}

function acquireLock(config = watchdogConfig()) {
  const file = statePaths(config).lock;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(file, 'wx');
      const record = { pid: process.pid, startedAt: new Date().toISOString() };
      fs.writeFileSync(fd, `${JSON.stringify(record)}\n`, 'utf8');
      fs.closeSync(fd);
      return { ok: true, ...record, file };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const existing = readLock(config);
      if (existing.alive) {
        return { ok: false, alreadyRunning: true, pid: existing.pid, startedAt: existing.startedAt || null, file, error: `Watchdog already running as PID ${existing.pid}.` };
      }
      try { fs.unlinkSync(file); } catch (unlinkError) { if (unlinkError.code !== 'ENOENT') throw unlinkError; }
    }
  }
  return { ok: false, file, error: 'Could not acquire watchdog lock.' };
}

function releaseLock(config = watchdogConfig()) {
  const file = statePaths(config).lock;
  try {
    const existing = readLock(config);
    if (existing.pid && existing.pid !== process.pid) return false;
    fs.unlinkSync(file);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function compactStatus(status) {
  return {
    status: status?.status || 'unknown',
    ok: Boolean(status?.ok),
    processRunning: Boolean(status?.processRunning),
    portOccupied: Boolean(status?.portOccupied),
    healthResponsive: Boolean(status?.healthResponsive),
    mcpResponsive: Boolean(status?.mcpResponsive),
    pids: Array.isArray(status?.pids) ? status.pids : [],
  };
}

function compactRecovery(result) {
  return {
    ok: Boolean(result?.ok),
    changed: Boolean(result?.changed),
    action: result?.action || 'unknown',
    error: result?.error ? sanitizeLogText(result.error, 2000) : null,
  };
}

function recoveryWindow(state, nowMs) {
  const cutoff = nowMs - 3600000;
  return (Array.isArray(state.recoveryAttempts) ? state.recoveryAttempts : [])
    .map((value) => Date.parse(String(value)))
    .filter((value) => Number.isFinite(value) && value >= cutoff)
    .sort((a, b) => a - b)
    .map((value) => new Date(value).toISOString());
}

function defaultRuntime(config = watchdogConfig()) {
  return {
    config,
    now: () => Date.now(),
    // Keep the healthy polling path process-free. Full process ownership
    // inspection is reserved for guarded recovery, not the 10s heartbeat.
    readStatus: manager.watchdogStatus,
    recover: ({ allowForce }) => devspaceTool._internal.recoverInternal({ allowForce }),
    readState: () => readState(config),
    writeState: (state) => writeState(state, config),
    appendHistory: (entry) => appendHistory(entry, config),
    readMaintenance: (nowMs) => readMaintenance(nowMs),
  };
}

async function runCheck(runtime = null) {
  const deps = runtime || defaultRuntime();
  const config = deps.config || watchdogConfig();
  const nowMs = Number(deps.now());
  const now = new Date(nowMs).toISOString();
  const state = { ...defaultState(), ...(await deps.readState()) };
  const previousStatus = state.lastStatus;
  const previousCheckAtMs = state.lastCheckAt ? Date.parse(state.lastCheckAt) : NaN;
  const maintenance = deps.readMaintenance ? await deps.readMaintenance(nowMs) : readMaintenance(nowMs);
  if (maintenance?.active) {
    state.lastCheckAt = now;
    state.lastError = null;
    await deps.writeState(state);
    return {
      ok: true,
      event: 'manual-maintenance',
      maintenance,
      state,
    };
  }
  const before = await deps.readStatus();
  const compactBefore = compactStatus(before);

  state.lastCheckAt = now;
  state.lastStatus = compactBefore.status;
  state.recoveryAttempts = recoveryWindow(state, nowMs);

  if (compactBefore.status === 'healthy') {
    const hadFailures = state.consecutiveFailures > 0 || (previousStatus && previousStatus !== 'healthy');
    state.consecutiveFailures = 0;
    state.lastError = null;
    state.circuitOpenUntil = null;
    const healthyPersistElapsedMs = Number.isFinite(previousCheckAtMs) ? nowMs - previousCheckAtMs : NaN;
    const shouldPersistHealthyState = hadFailures
      || !Number.isFinite(healthyPersistElapsedMs)
      || healthyPersistElapsedMs < 0
      || healthyPersistElapsedMs >= config.healthyPersistIntervalMs;
    if (shouldPersistHealthyState) await deps.writeState(state);
    if (hadFailures) {
      await deps.appendHistory({ at: now, event: 'healthy', previousStatus, status: 'healthy', pids: compactBefore.pids });
    }
    return { ok: true, event: hadFailures ? 'recovered-observed' : 'healthy', status: compactBefore, state };
  }

  state.consecutiveFailures = Number(state.consecutiveFailures || 0) + 1;
  state.lastFailureAt = now;
  state.lastError = compactBefore.status;

  if (state.consecutiveFailures === 1) {
    await deps.appendHistory({ at: now, event: 'failure-detected', status: compactBefore.status, pids: compactBefore.pids });
  }

  const circuitUntilMs = state.circuitOpenUntil ? Date.parse(state.circuitOpenUntil) : NaN;
  if (Number.isFinite(circuitUntilMs) && circuitUntilMs > nowMs) {
    await deps.writeState(state);
    return { ok: false, event: 'circuit-open', status: compactBefore, state, circuitOpenUntil: state.circuitOpenUntil };
  }
  if (Number.isFinite(circuitUntilMs) && circuitUntilMs <= nowMs) state.circuitOpenUntil = null;

  if (state.consecutiveFailures < config.failureThreshold) {
    await deps.writeState(state);
    return { ok: false, event: 'waiting-threshold', status: compactBefore, state, failuresRemaining: config.failureThreshold - state.consecutiveFailures };
  }

  const lastRecoveryMs = state.lastRecoveryAt ? Date.parse(state.lastRecoveryAt) : NaN;
  if (Number.isFinite(lastRecoveryMs) && nowMs - lastRecoveryMs < config.recoveryCooldownMs) {
    await deps.writeState(state);
    return { ok: false, event: 'cooldown', status: compactBefore, state, retryAfterMs: config.recoveryCooldownMs - (nowMs - lastRecoveryMs) };
  }

  if (state.recoveryAttempts.length >= config.maxRecoveriesPerHour) {
    state.circuitOpenUntil = new Date(nowMs + config.circuitBreakerMs).toISOString();
    state.lastError = 'recovery-rate-limit';
    await deps.writeState(state);
    await deps.appendHistory({
      at: now,
      event: 'circuit-opened',
      status: compactBefore.status,
      recoveryAttemptsLastHour: state.recoveryAttempts.length,
      circuitOpenUntil: state.circuitOpenUntil,
    });
    return { ok: false, event: 'circuit-opened', status: compactBefore, state, circuitOpenUntil: state.circuitOpenUntil };
  }

  const maintenanceBeforeRecovery = deps.readMaintenance ? await deps.readMaintenance(nowMs) : readMaintenance(nowMs);
  if (maintenanceBeforeRecovery?.active) {
    state.consecutiveFailures = 0;
    state.lastError = null;
    await deps.writeState(state);
    return {
      ok: true,
      event: 'manual-maintenance',
      maintenance: maintenanceBeforeRecovery,
      state,
    };
  }

  const allowForce = config.allowForceRecovery && state.consecutiveFailures >= config.forceAfterFailures;
  let recovery;
  try {
    recovery = await deps.recover({ allowForce });
  } catch (error) {
    recovery = { ok: false, changed: false, action: 'exception', error: error.message };
  }
  const after = await deps.readStatus();
  const compactAfter = compactStatus(after);
  const compactResult = compactRecovery(recovery);

  state.lastRecoveryAt = now;
  state.lastRecoveryAction = compactResult.action;
  state.lastRecoveryOk = compactResult.ok && compactAfter.status === 'healthy';
  state.totalRecoveries = Number(state.totalRecoveries || 0) + 1;
  state.recoveryAttempts.push(now);
  state.recoveryAttempts = recoveryWindow(state, nowMs);
  if (state.lastRecoveryOk) {
    state.successfulRecoveries = Number(state.successfulRecoveries || 0) + 1;
    state.consecutiveFailures = 0;
    state.lastStatus = compactAfter.status;
    state.lastError = null;
    state.circuitOpenUntil = null;
  } else {
    state.failedRecoveries = Number(state.failedRecoveries || 0) + 1;
    state.lastStatus = compactAfter.status;
    state.lastError = compactResult.error || compactAfter.status;
  }

  await deps.writeState(state);
  await deps.appendHistory({
    at: now,
    event: 'recovery-attempt',
    failures: state.lastRecoveryOk ? 0 : state.consecutiveFailures,
    allowForce,
    before: compactBefore.status,
    after: compactAfter.status,
    action: compactResult.action,
    ok: state.lastRecoveryOk,
    changed: compactResult.changed,
    error: compactResult.error,
    pidsBefore: compactBefore.pids,
    pidsAfter: compactAfter.pids,
  });

  return {
    ok: state.lastRecoveryOk,
    event: 'recovery-attempt',
    allowForce,
    before: compactBefore,
    after: compactAfter,
    recovery: compactResult,
    state,
  };
}

function statusSnapshot(config = watchdogConfig()) {
  const lock = readLock(config);
  const persistedState = readState(config);
  const state = lock.alive
    ? persistedState
    : { ...persistedState, watchdogPid: null, watchdogStartedAt: null };
  return {
    ok: true,
    enabled: config.enabled,
    running: Boolean(lock.alive),
    pid: lock.alive ? lock.pid : null,
    startedAt: lock.alive ? lock.startedAt || null : null,
    intervalMs: config.intervalMs,
    healthyPersistIntervalMs: config.healthyPersistIntervalMs,
    failureThreshold: config.failureThreshold,
    forceAfterFailures: config.forceAfterFailures,
    allowForceRecovery: config.allowForceRecovery,
    recoveryCooldownMs: config.recoveryCooldownMs,
    maxRecoveriesPerHour: config.maxRecoveriesPerHour,
    circuitBreakerMs: config.circuitBreakerMs,
    historyLimit: config.historyLimit,
    historyMaxBytes: config.historyMaxBytes,
    state,
    files: statePaths(config),
  };
}

module.exports = {
  watchdogConfig,
  statePaths,
  defaultState,
  readState,
  writeState,
  compactHistoryFile,
  appendHistory,
  readHistory,
  readLock,
  acquireLock,
  releaseLock,
  compactStatus,
  compactRecovery,
  recoveryWindow,
  maintenancePath,
  readMaintenance,
  beginMaintenance,
  endMaintenance,
  defaultRuntime,
  runCheck,
  statusSnapshot,
};
