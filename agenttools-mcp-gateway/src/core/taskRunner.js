const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const { getTask, listTasks, updateTask, summarizeTask } = require('./taskStore');
const { createConfirmation, verifyConfirmation, loadSafety, policyDecision, safetyPolicySummary } = require('./confirmations');
const { appendTaskLog, taskLogPath } = require('./logs');
const { sanitizeLogText, redactObject } = require('./redaction');
const { validateTaskCommand } = require('./taskCommandPolicy');
const { run } = require('./runner');
const { systemExecutable } = require('./executables');

const running = new Map();
const timers = new Map();
const stallTimers = new Map();
const lastHeartbeatPersistedAt = new Map();
const gatewayInstanceId = `gateway_${process.pid}_${crypto.randomBytes(4).toString('hex')}`;

function truthy(value) {
  return value === true || value === 'true' || value === '1' || value === 'yes';
}

function normalizePositiveInteger(value, fallback, min = 1, max = 86400000) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(Math.trunc(number), max));
}

async function terminateChildTree(child) {
  if (!child?.pid) return { ok: false, error: 'child pid is unavailable' };
  if (process.platform === 'win32') {
    return run(systemExecutable('taskkill.exe'), ['/PID', String(child.pid), '/T'], { timeoutMs: 15000 });
  }
  const ok = child.kill('SIGTERM');
  return { ok, error: ok ? null : 'child.kill returned false' };
}

function clearTaskTimer(taskId) {
  const timer = timers.get(taskId);
  if (timer) clearTimeout(timer);
  timers.delete(taskId);
}

function clearStallTimer(taskId) {
  const timer = stallTimers.get(taskId);
  if (timer) clearTimeout(timer);
  stallTimers.delete(taskId);
}

function clearExecutionTimers(taskId) {
  clearTaskTimer(taskId);
  clearStallTimer(taskId);
  lastHeartbeatPersistedAt.delete(taskId);
}

function isProcessAlive(pid) {
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) return false;
  try {
    process.kill(numericPid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function persistExecutionHeartbeat(taskId, at = new Date().toISOString(), minIntervalMs = 30000) {
  const nowMs = Date.parse(at);
  const previous = lastHeartbeatPersistedAt.get(taskId) || 0;
  if (Number.isFinite(nowMs) && nowMs - previous < minIntervalMs) return false;
  const current = getTask(taskId);
  if (!current || current.status !== 'running') return false;
  updateTask(taskId, {
    metadata: {
      ...(current.metadata || {}),
      lastHeartbeatAt: at,
      lastProgressAt: at,
    },
  });
  lastHeartbeatPersistedAt.set(taskId, Number.isFinite(nowMs) ? nowMs : Date.now());
  return true;
}

function taskCommand(task) {
  return task?.metadata?.command || null;
}

function taskCwd(task) {
  return task?.metadata?.cwd || undefined;
}

function executionBlockedReason(safety, task = null, userExplicitlyRequested = false) {
  const decision = policyDecision(safety, 'task.run', 'longRunning', userExplicitlyRequested);
  if (!decision.ok) return decision.reason;

  const adapter = String(task?.metadata?.adapter || '');
  const allowedAdapters = Array.isArray(safety.actionPolicy?.allowedLongRunningAdapters)
    ? safety.actionPolicy.allowedLongRunningAdapters
    : [];
  if (!adapter || !allowedAdapters.includes(adapter)) {
    return `task adapter is not allowlisted for long-running execution: ${adapter || '<none>'}`;
  }

  if (task?.metadata?.requiresNetwork) {
    const allowedNetworkAdapters = Array.isArray(safety.actionPolicy?.allowedNetworkTaskAdapters)
      ? safety.actionPolicy.allowedNetworkTaskAdapters
      : [];
    if (!allowedNetworkAdapters.includes(adapter)) {
      return `network-requiring task adapter is not allowlisted: ${adapter}`;
    }
  }
  return null;
}

function runPreview(task) {
  const command = taskCommand(task);
  return {
    task: summarizeTask(task),
    command: redactObject(command),
    commandLine: sanitizeLogText(task?.metadata?.commandLine || ''),
    cwd: taskCwd(task) || null,
    logPath: taskLogPath(task.id),
    note: 'No external process is started until an explicit user-request assertion and matching confirmToken are supplied, and the registered adapter passes the action-scoped task policy.',
  };
}

function armStallTimer(taskId, child, stallTimeoutMs) {
  clearStallTimer(taskId);
  const timer = setTimeout(async () => {
    const tracked = running.get(taskId);
    if (!tracked || tracked !== child) return;
    const current = getTask(taskId);
    if (!current || current.status !== 'running') return;
    clearTaskTimer(taskId);
    const stalledAt = new Date().toISOString();
    updateTask(taskId, {
      metadata: {
        ...(current.metadata || {}),
        killRequested: true,
        stalled: true,
        timeoutKind: 'stall',
        stallTimeoutMs,
        stalledAt,
        terminationState: 'stall_requested',
      },
    }, { type: 'stalled', message: `No execution progress for ${stallTimeoutMs}ms` });
    appendTaskLog(taskId, { level: 'error', event: 'stall', stallTimeoutMs, pid: tracked.pid });
    const termination = await terminateChildTree(tracked);
    const afterTermination = getTask(taskId);
    updateTask(taskId, {
      metadata: {
        ...(afterTermination?.metadata || {}),
        terminationState: termination.ok ? 'stall_termination_requested' : 'stall_termination_failed',
        terminationRequestedAt: new Date().toISOString(),
      },
    }, { type: termination.ok ? 'stall-termination-requested' : 'stall-termination-failed', message: termination.ok ? 'stalled child-tree termination requested' : (termination.error || termination.stderr || 'stall termination failed') });
    if (!termination.ok) appendTaskLog(taskId, { level: 'error', event: 'stall_kill_failed', message: termination.error || termination.stderr });
  }, stallTimeoutMs);
  timer.unref?.();
  stallTimers.set(taskId, timer);
}

function noteExecutionProgress(taskId, child, stallTimeoutMs, heartbeatPersistIntervalMs) {
  const at = new Date().toISOString();
  armStallTimer(taskId, child, stallTimeoutMs);
  persistExecutionHeartbeat(taskId, at, heartbeatPersistIntervalMs);
}

function reconcileExecutionTask(taskOrId) {
  const task = typeof taskOrId === 'string' ? getTask(taskOrId) : taskOrId;
  if (!task || task.type === 'work' || task.status !== 'running') return { task, changed: false, state: 'not-running' };
  if (running.has(task.id)) return { task, changed: false, state: 'tracked' };
  const pid = task.metadata?.pid;
  const alive = isProcessAlive(pid);
  const foreignGateway = task.metadata?.gatewayInstanceId && task.metadata.gatewayInstanceId !== gatewayInstanceId;
  const message = alive
    ? `Execution process pid=${pid} is alive but no longer attached to this Gateway instance.`
    : `Execution process pid=${pid || '<unknown>'} is no longer alive; previous Gateway/worker likely exited unexpectedly.`;
  const updated = updateTask(task.id, {
    status: alive ? 'blocked' : 'failed',
    error: message,
    metadata: {
      ...(task.metadata || {}),
      orphaned: true,
      orphanDetectedAt: new Date().toISOString(),
      orphanProcessAlive: alive,
      previousGatewayInstanceId: task.metadata?.gatewayInstanceId || null,
      gatewayInstanceId,
      terminationState: alive ? 'orphaned_process_alive' : 'orphaned_process_dead',
      crashRecoveryEligible: !alive,
      foreignGateway: Boolean(foreignGateway),
    },
  }, { type: alive ? 'orphaned' : 'crashed', message });
  return { task: updated, changed: true, state: alive ? 'orphaned_alive' : 'crashed', pid: pid || null };
}

function reconcileExecutionTasks(options = {}) {
  const limit = Math.max(1, Math.min(Number(options.limit || 200), 200));
  return listTasks({ limit, status: 'running' })
    .filter((task) => task.type !== 'work')
    .map((task) => reconcileExecutionTask(task));
}

async function runTask(options = {}) {
  const taskId = options.taskId || options.id;
  if (!taskId) return { ok: false, error: 'taskId is required' };
  const task = getTask(taskId);
  if (!task) return { ok: false, taskId, error: 'Task not found' };
  if (task.type === 'work') return { ok: false, taskId, error: 'User-visible Work Tasks cannot be executed by task.run. Create a separate internal execution Task.' };
  const command = taskCommand(task);
  if (!command?.command) return { ok: false, taskId, error: 'Task has no runnable command in metadata.command' };
  const commandPolicy = validateTaskCommand(task);
  if (!commandPolicy.ok) return { ok: false, taskId, error: 'Task command rejected by policy.', reason: commandPolicy.reason };
  if (running.has(taskId)) return { ok: false, taskId, error: 'Task is already running' };
  if (['running', 'succeeded', 'failed', 'cancelled'].includes(task.status)) {
    return { ok: false, taskId, status: task.status, error: `Task is not runnable from status: ${task.status}` };
  }

  const userExplicitlyRequested = truthy(options.userExplicitlyRequested);
  const payload = {
    taskId,
    command,
    cwd: taskCwd(task) || null,
    adapter: task.metadata?.adapter || null,
    inputPath: task.metadata?.inputPath || null,
    outputPath: task.outputPath || null,
    logPath: task.logPath || null,
    userExplicitlyRequested,
  };
  if (!options.confirmToken) {
    return createConfirmation({
      action: 'task.run',
      impact: 'longRunning',
      summary: `Run task ${taskId}`,
      payload,
      preview: runPreview(task),
      userExplicitlyRequested,
    });
  }

  const confirmation = verifyConfirmation({
    action: 'task.run',
    token: options.confirmToken,
    payload,
    impact: 'longRunning',
    consume: false,
    userExplicitlyRequested,
  });
  if (!confirmation.ok) return confirmation;

  const safety = loadSafety();
  const stallDetectionEnabled = safety.taskStallDetectionEnabled !== false;
  const stallTimeoutMs = normalizePositiveInteger(task.metadata?.stallTimeoutMs, Number(safety.defaultTaskStallTimeoutMs || 900000), 1000, 86400000);
  const heartbeatPersistIntervalMs = normalizePositiveInteger(safety.taskHeartbeatPersistIntervalMs, 30000, 1000, 600000);
  const blocked = executionBlockedReason(safety, task, userExplicitlyRequested);
  if (blocked) {
    appendTaskLog(taskId, { level: 'info', event: 'execution_blocked', message: blocked });
    return {
      ok: false,
      taskId,
      error: 'Execution is disabled by safety policy.',
      reason: blocked,
      safety: safetyPolicySummary(safety),
      preview: runPreview(task),
    };
  }

  const maxConcurrentTasks = normalizePositiveInteger(safety.maxConcurrentTasks, 1, 1, 32);
  if (running.size >= maxConcurrentTasks) {
    return {
      ok: false,
      taskId,
      error: `Maximum concurrent tasks reached (${maxConcurrentTasks}).`,
      runningTasks: Array.from(running.keys()),
    };
  }

  const consumed = verifyConfirmation({
    action: 'task.run',
    token: options.confirmToken,
    payload,
    impact: 'longRunning',
    consume: true,
    userExplicitlyRequested,
  });
  if (!consumed.ok) return consumed;

  const executionGeneration = crypto.randomUUID();
  const executionAttempt = normalizePositiveInteger(Number(task.metadata?.executionAttempt || 0) + 1, 1, 1, 1000000);
  const executionStartedAt = new Date().toISOString();
  const started = updateTask(taskId, {
    status: 'running',
    logPath: taskLogPath(taskId),
    error: null,
    metadata: {
      ...task.metadata,
      executionEnabled: true,
      executionAttempt,
      executionGeneration,
      gatewayInstanceId,
      executionStartedAt,
      terminationState: 'running',
      timeoutKind: null,
      timedOut: false,
      stalled: false,
      killRequested: false,
      lastHeartbeatAt: executionStartedAt,
      lastProgressAt: executionStartedAt,
      stallTimeoutMs: stallDetectionEnabled ? stallTimeoutMs : null,
    },
  }, { type: 'running', message: `process started attempt=${executionAttempt}` });
  appendTaskLog(taskId, { level: 'info', event: 'start', command: command.command, args: command.args || [], cwd: taskCwd(task) || null });

  const child = spawn(command.command, command.args || [], {
    cwd: taskCwd(task),
    windowsHide: true,
    shell: false,
    env: {
      ...process.env,
      NO_COLOR: '1',
    },
  });
  running.set(taskId, child);
  const timeoutMs = normalizePositiveInteger(task.metadata?.timeoutMs, Number(safety.defaultTaskTimeoutMs || 1800000), 1000, 86400000);
  const timer = setTimeout(async () => {
    const tracked = running.get(taskId);
    if (!tracked) return;
    clearStallTimer(taskId);
    const current = getTask(taskId);
    updateTask(taskId, {
      metadata: {
        ...(current?.metadata || {}),
        killRequested: true,
        timedOut: true,
        timeoutKind: 'gateway_task',
        timeoutMs,
        timeoutAt: new Date().toISOString(),
        terminationState: 'timeout_requested',
      },
    }, { type: 'timeout', message: `Gateway Task execution timeout after ${timeoutMs}ms` });
    appendTaskLog(taskId, { level: 'error', event: 'timeout', timeoutMs, pid: tracked.pid });
    const termination = await terminateChildTree(tracked);
    const afterTermination = getTask(taskId);
    updateTask(taskId, {
      metadata: {
        ...(afterTermination?.metadata || {}),
        terminationState: termination.ok ? 'termination_requested' : 'termination_failed',
        terminationRequestedAt: new Date().toISOString(),
      },
    }, { type: termination.ok ? 'timeout-termination-requested' : 'timeout-termination-failed', message: termination.ok ? 'timeout child-tree termination requested' : (termination.error || termination.stderr || 'timeout termination failed') });
    if (!termination.ok) appendTaskLog(taskId, { level: 'error', event: 'timeout_kill_failed', message: termination.error || termination.stderr });
  }, timeoutMs);
  timer.unref?.();
  timers.set(taskId, timer);
  if (stallDetectionEnabled) armStallTimer(taskId, child, stallTimeoutMs);
  lastHeartbeatPersistedAt.set(taskId, Date.parse(executionStartedAt));

  updateTask(taskId, {
    metadata: {
      ...started.metadata,
      pid: child.pid,
      processStartedAt: new Date().toISOString(),
    },
  }, { type: 'pid', message: `pid=${child.pid}` });

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (text) => {
    appendTaskLog(taskId, { level: 'stdout', data: sanitizeLogText(text) });
    if (stallDetectionEnabled) noteExecutionProgress(taskId, child, stallTimeoutMs, heartbeatPersistIntervalMs);
  });
  child.stderr.on('data', (text) => {
    appendTaskLog(taskId, { level: 'stderr', data: sanitizeLogText(text) });
    if (stallDetectionEnabled) noteExecutionProgress(taskId, child, stallTimeoutMs, heartbeatPersistIntervalMs);
  });
  child.on('error', (error) => {
    clearExecutionTimers(taskId);
    running.delete(taskId);
    appendTaskLog(taskId, { level: 'error', event: 'spawn_error', message: error.message });
    updateTask(taskId, { status: 'failed', error: error.message }, { type: 'failed', message: error.message });
  });
  child.on('exit', (exitCode, signal) => {
    clearExecutionTimers(taskId);
    running.delete(taskId);
    const current = getTask(taskId);
    const killRequested = Boolean(current?.metadata?.killRequested);
    const timedOut = Boolean(current?.metadata?.timedOut);
    const stalled = Boolean(current?.metadata?.stalled);
    const ok = exitCode === 0 && !killRequested && !timedOut && !stalled;
    const finalStatus = (timedOut || stalled) ? 'failed' : (killRequested ? 'cancelled' : (ok ? 'succeeded' : 'failed'));
    const timeoutMs = current?.metadata?.timeoutMs || null;
    const finalStallTimeoutMs = current?.metadata?.stallTimeoutMs || null;
    appendTaskLog(taskId, { level: ok ? 'info' : (killRequested && !timedOut && !stalled ? 'warn' : 'error'), event: 'exit', exitCode, signal, killRequested, timedOut, stalled });
    updateTask(taskId, {
      status: finalStatus,
      error: ok ? null : (stalled ? `Gateway Task stalled${finalStallTimeoutMs ? ` after ${finalStallTimeoutMs}ms without progress` : ''}` : (timedOut ? `Gateway Task execution timeout${timeoutMs ? ` after ${timeoutMs}ms` : ''}` : (killRequested ? 'process terminated by request' : `process exited with code ${exitCode}${signal ? ` signal ${signal}` : ''}`))),
      metadata: {
        ...(current?.metadata || {}),
        exitCode,
        signal,
        terminationState: stalled ? 'stall_exit_confirmed' : (timedOut ? 'timeout_exit_confirmed' : (killRequested ? 'cancel_exit_confirmed' : 'exited')),
        exitConfirmedAt: new Date().toISOString(),
      },
    }, { type: finalStatus, message: stalled ? `Gateway Task stalled${finalStallTimeoutMs ? ` after ${finalStallTimeoutMs}ms without progress` : ''}` : (timedOut ? `Gateway Task execution timeout${timeoutMs ? ` after ${timeoutMs}ms` : ''}` : (killRequested ? 'process terminated by request' : `exitCode=${exitCode}`)) });
  });

  return {
    ok: true,
    taskId,
    status: 'running',
    pid: child.pid,
    logPath: taskLogPath(taskId),
  };
}

async function requestCancelRunningTask(options = {}) {
  const taskId = options.taskId || options.id;
  if (!taskId) return { ok: false, error: 'taskId is required' };
  const task = getTask(taskId);
  if (!task) return { ok: false, taskId, error: 'Task not found' };
  const child = running.get(taskId);
  const payload = { taskId, pid: child?.pid || task.metadata?.pid || null };
  if (!options.confirmToken) {
    return createConfirmation({
      action: 'task.kill',
      impact: 'destructive',
      summary: `Kill running task ${taskId}`,
      payload,
      preview: {
        task: summarizeTask(task),
        running: Boolean(child),
        pid: payload.pid,
      },
    });
  }
  const confirmation = verifyConfirmation({
    action: 'task.kill',
    token: options.confirmToken,
    payload,
    impact: 'destructive',
    consume: true,
  });
  if (!confirmation.ok) return confirmation;
  const safety = loadSafety();
  if (!safety.destructiveActionsEnabled) {
    return { ok: false, taskId, error: 'destructiveActionsEnabled is false; process kill is disabled.' };
  }
  if (!child) return { ok: false, taskId, error: 'No running child process tracked for this task.' };

  clearStallTimer(taskId);
  updateTask(taskId, {
    metadata: {
      ...(task.metadata || {}),
      killRequested: true,
    },
  }, { type: 'kill_requested', message: `pid=${child.pid}` });

  if (process.platform === 'win32') {
    const result = await terminateChildTree(child);
    if (!result.ok) {
      const current = getTask(taskId);
      updateTask(taskId, {
        metadata: {
          ...(current?.metadata || {}),
          killRequested: false,
        },
      }, { type: 'kill_failed', message: result.error || result.stderr || 'taskkill failed' });
    }
    appendTaskLog(taskId, {
      level: result.ok ? 'warn' : 'error',
      event: result.ok ? 'kill_requested' : 'kill_failed',
      pid: child.pid,
      method: 'taskkill /T',
      message: result.ok ? 'process tree termination requested' : (result.error || result.stderr),
    });
    return {
      ok: result.ok,
      taskId,
      pid: child.pid,
      method: 'taskkill /T',
      error: result.ok ? null : result.error || result.stderr,
    };
  }

  const killed = (await terminateChildTree(child)).ok;
  if (!killed) {
    const current = getTask(taskId);
    updateTask(taskId, {
      metadata: {
        ...(current?.metadata || {}),
        killRequested: false,
      },
    }, { type: 'kill_failed', message: 'child.kill returned false' });
  }
  appendTaskLog(taskId, { level: killed ? 'warn' : 'error', event: killed ? 'kill_requested' : 'kill_failed', pid: child.pid, method: 'SIGTERM' });
  return { ok: killed, taskId, pid: child.pid, signal: 'SIGTERM', error: killed ? null : 'child.kill returned false' };
}

module.exports = {
  runTask,
  requestCancelRunningTask,
  reconcileExecutionTask,
  reconcileExecutionTasks,
  running,
  timers,
  stallTimers,
  terminateChildTree,
  _internal: {
    executionBlockedReason,
    isProcessAlive,
    persistExecutionHeartbeat,
  },
};
