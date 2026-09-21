const { createTask, listTasks, getTask, cancelTask, summarizeTask } = require('../core/taskStore');
const {
  startWorkTask,
  updateWorkTask,
  checkpointWorkTask,
  timeoutWorkTask,
  resumeWorkTask,
  setGoalWorkTask,
  judgeGoalWorkTask,
  heartbeatWorkTask,
  reconcileWorkTask,
  reconcileWorkTasks,
  recoverWorkerWorkTask,
  bufferWorkTaskSkillImprovement,
  completeWorkTask,
  listWorkTasks,
  listResumableWorkTasks,
  getWorkTask,
} = require('../core/workTaskStore');
const { createConfirmation, verifyConfirmation } = require('../core/confirmations');
const {
  runTask,
  requestCancelRunningTask,
  reconcileExecutionTask,
  reconcileExecutionTasks,
} = require('../core/taskRunner');
const { readTaskLog } = require('../core/logs');
const {
  createWorkSnapshot,
  listWorkSnapshots,
  readManifest,
  restorePayload,
  restoreWorkSnapshot,
} = require('../core/workTaskSnapshots');
const {
  inspectWorkTask,
  buildResumePrompt,
  requestContinue,
  finishForgotten,
} = require('../core/workTaskControl');

function truthy(value) {
  return value === true || value === 'true' || value === '1' || value === 'yes';
}

async function list(options = {}) {
  if (options.work === true || options.kind === 'work' || options.type === 'work' || options.mode) {
    return {
      ok: true,
      tasks: listWorkTasks({
        limit: Number(options.limit || 20),
        mode: options.mode || options.status || 'active',
      }),
    };
  }
  return {
    ok: true,
    tasks: listTasks({
      limit: Number(options.limit || 20),
      status: options.status || null,
      type: options.type || null,
    }),
  };
}

async function resumable(options = {}) {
  return {
    ok: true,
    tasks: listResumableWorkTasks({ limit: Number(options.limit || 20) }),
  };
}

async function get(options = {}) {
  const taskId = options.taskId || options.id;
  if (!taskId) return { ok: false, error: 'taskId is required' };
  const task = options.work === true ? getWorkTask(taskId) : getTask(taskId);
  if (!task) return { ok: false, taskId, error: 'Task not found' };
  return {
    ok: true,
    task: summarizeTask(task),
  };
}

async function start(options = {}) {
  try {
    return { ok: true, task: startWorkTask(options) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function update(options = {}) {
  try {
    return { ok: true, task: updateWorkTask(options) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function checkpoint(options = {}) {
  try {
    return { ok: true, task: checkpointWorkTask(options) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function timeout(options = {}) {
  try {
    return { ok: true, task: timeoutWorkTask(options) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function resume(options = {}) {
  try {
    return { ok: true, task: resumeWorkTask(options) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function goal(options = {}) {
  try {
    return { ok: true, task: setGoalWorkTask(options) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function judge(options = {}) {
  try {
    return { ok: true, task: judgeGoalWorkTask(options) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function heartbeat(options = {}) {
  try {
    return { ok: true, task: heartbeatWorkTask(options) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function reconcile(options = {}) {
  try {
    const taskId = options.id || options.taskId;
    if (taskId) {
      const task = getTask(taskId);
      if (!task) return { ok: false, taskId, error: 'Task not found' };
      if (task.type === 'work') return { ok: true, ...reconcileWorkTask(options) };
      return { ok: true, ...reconcileExecutionTask(task) };
    }
    return {
      ok: true,
      work: reconcileWorkTasks(options),
      executions: reconcileExecutionTasks(options),
    };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function recover(options = {}) {
  try {
    return { ok: true, task: recoverWorkerWorkTask(options) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function snapshot(options = {}) {
  try {
    return { ok: true, snapshot: createWorkSnapshot(options) };
  } catch (error) {
    return { ok: false, error: error.message, details: error.details || null };
  }
}

async function snapshots(options = {}) {
  try {
    const taskId = options.taskId || options.id;
    if (options.snapshotId || options.snapshot) {
      return { ok: true, snapshot: readManifest(taskId, options.snapshotId || options.snapshot) };
    }
    return { ok: true, snapshots: listWorkSnapshots(options) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function snapshotRestore(options = {}) {
  try {
    const taskId = String(options.taskId || options.id || '').trim();
    const snapshotId = String(options.snapshotId || options.snapshot || '').trim();
    if (!taskId || !snapshotId) return { ok: false, error: 'taskId and snapshotId are required.' };
    const userExplicitlyRequested = truthy(options.userExplicitlyRequested);
    const payload = { ...restorePayload(taskId, snapshotId), userExplicitlyRequested };
    if (!options.confirmToken) {
      return createConfirmation({
        action: 'task.snapshotRestore',
        impact: 'write',
        summary: `Restore Work Task snapshot ${snapshotId}`,
        payload,
        preview: {
          taskId,
          snapshotId,
          workspaceRoot: payload.workspaceRoot,
          files: payload.files,
          note: 'Restore overwrites only files stored in this snapshot. It never deletes files that were absent from the snapshot.',
        },
        userExplicitlyRequested,
      });
    }
    const confirmation = verifyConfirmation({
      action: 'task.snapshotRestore',
      token: options.confirmToken,
      payload,
      impact: 'write',
      consume: true,
      userExplicitlyRequested,
    });
    if (!confirmation.ok) return confirmation;
    const currentPayload = { ...restorePayload(taskId, snapshotId), userExplicitlyRequested };
    if (JSON.stringify(currentPayload) !== JSON.stringify(payload)) {
      return { ok: false, error: 'Snapshot restore targets changed after confirmation. Request a fresh preview.' };
    }
    const restored = restoreWorkSnapshot({ taskId, snapshotId });
    return { ok: true, ...restored, confirmation };
  } catch (error) {
    return { ok: false, error: error.message, details: error.details || null };
  }
}

async function inspect(options = {}) {
  try {
    return { ok: true, inspection: inspectWorkTask(options) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function resumePrompt(options = {}) {
  try {
    return buildResumePrompt(options);
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function continueRequest(options = {}) {
  try {
    return requestContinue(options);
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function skillCandidate(options = {}) {
  try {
    return { ok: true, ...bufferWorkTaskSkillImprovement(options) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function finishForgottenTask(options = {}) {
  try {
    return finishForgotten(options);
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function complete(options = {}) {
  try {
    return { ok: true, task: completeWorkTask({ ...options, status: options.status || 'succeeded' }) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function fail(options = {}) {
  try {
    return { ok: true, task: completeWorkTask({ ...options, status: 'failed' }) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function create(options = {}) {
  const type = options.type || 'manual';
  const requestedStatus = options.status || 'planned';
  if (!['planned', 'queued'].includes(requestedStatus)) {
    return { ok: false, error: 'Manual task creation only allows status planned or queued.' };
  }
  const task = createTask({
    type,
    title: options.title || null,
    summary: options.summary || 'Manual placeholder task created by Gateway CLI',
    status: requestedStatus,
    metadata: {
      source: 'cli',
      dryRun: options.dryRun !== false,
    },
  });
  return {
    ok: true,
    task,
  };
}

async function run(options = {}) {
  return runTask(options);
}

async function kill(options = {}) {
  return requestCancelRunningTask(options);
}

async function tailLog(options = {}) {
  const taskId = options.taskId || options.id;
  if (!taskId) return { ok: false, error: 'taskId is required' };
  return readTaskLog(taskId, { limit: Number(options.limit || options.lines || 100) });
}

async function cancel(options = {}) {
  const taskId = options.taskId || options.id;
  if (!taskId) return { ok: false, error: 'taskId is required' };

  const currentTask = getTask(taskId);
  if (!currentTask) return { ok: false, taskId, error: 'Task not found' };
  if (currentTask.status === 'running') {
    return { ok: false, taskId, error: 'Running tasks cannot be marked cancelled. Use task.kill so the tracked process is terminated.' };
  }
  const payload = { taskId, status: currentTask.status, updatedAt: currentTask.updatedAt };
  if (!options.confirmToken) {
    return createConfirmation({
      action: 'task.cancel',
      impact: 'write',
      summary: `Mark task ${taskId} as cancelled`,
      payload,
      preview: {
        task: summarizeTask(currentTask),
        note: 'This only marks a non-running task as cancelled. Use task.kill for tracked running child processes.',
      },
    });
  }

  const confirmation = verifyConfirmation({
    action: 'task.cancel',
    token: options.confirmToken,
    payload,
    impact: 'write',
    consume: true,
  });
  if (!confirmation.ok) return confirmation;

  const latest = getTask(taskId);
  if (!latest) return { ok: false, taskId, error: 'Task not found' };
  if (latest.status === 'running') return { ok: false, taskId, error: 'Task became running after confirmation. Use task.kill.' };
  const cancelled = cancelTask(taskId, options.reason || 'cancel requested through Gateway');
  if (!cancelled) return { ok: false, taskId, error: 'Task not found' };
  return {
    ok: true,
    task: summarizeTask(cancelled),
  };
}

module.exports = {
  list,
  resumable,
  get,
  start,
  update,
  checkpoint,
  timeout,
  resume,
  goal,
  judge,
  heartbeat,
  reconcile,
  recover,
  snapshot,
  snapshots,
  snapshotRestore,
  inspect,
  resumePrompt,
  continueRequest,
  skillCandidate,
  finishForgottenTask,
  complete,
  fail,
  create,
  run,
  kill,
  tailLog,
  cancel,
};
