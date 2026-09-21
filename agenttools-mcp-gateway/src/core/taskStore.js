const crypto = require('node:crypto');
const { readState, mutateState } = require('./stateFile');

const STORE_FILE = 'tasks.json';
const TASK_ID_PATTERN = /^task_\d{14}_[a-f0-9]{8}$/;
const TASK_STATUSES = new Set(['planned', 'queued', 'running', 'blocked', 'succeeded', 'failed', 'cancelled']);
const MAX_WORK_TASKS = 100;
const MAX_EXECUTION_TASKS = 200;

function assertTaskId(id) {
  const value = String(id || '');
  if (!TASK_ID_PATTERN.test(value)) throw new Error(`Invalid taskId: ${value}`);
  return value;
}

function normalizeLimit(value, fallback = 20, max = 200) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(1, Math.min(Math.trunc(number), max));
}

function nowIso() {
  return new Date().toISOString();
}

function loadStore() {
  return readState(STORE_FILE, { tasks: [] });
}

function normalizeTask(entry) {
  return {
    id: entry.id,
    type: entry.type,
    status: entry.status,
    title: entry.title || null,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    startedAt: entry.startedAt || null,
    finishedAt: entry.finishedAt || null,
    progress: entry.progress ?? null,
    summary: entry.summary || null,
    outputPath: entry.outputPath || null,
    logPath: entry.logPath || null,
    error: entry.error || null,
    metadata: entry.metadata || {},
    work: entry.work || null,
  };
}

function pruneTasks(tasks) {
  let workCount = 0;
  let executionCount = 0;
  return tasks.filter((task) => {
    if (task.type === 'work') {
      workCount += 1;
      return workCount <= MAX_WORK_TASKS;
    }
    executionCount += 1;
    return executionCount <= MAX_EXECUTION_TASKS;
  });
}

function createTask({
  type,
  title = null,
  summary = null,
  status = 'queued',
  metadata = {},
  outputPath = null,
  logPath = null,
  work = null,
  createdAt = null,
  updatedAt = null,
  startedAt = undefined,
  finishedAt = undefined,
  events = null,
}) {
  if (!TASK_STATUSES.has(status)) throw new Error(`Invalid task status: ${status}`);
  const id = `task_${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}_${crypto.randomBytes(4).toString('hex')}`;
  const timestamp = nowIso();
  const created = createdAt || timestamp;
  const updated = updatedAt || created;
  const task = {
    id,
    type,
    title,
    status,
    createdAt: created,
    updatedAt: updated,
    startedAt: startedAt === undefined ? (status === 'running' || status === 'blocked' ? created : null) : startedAt,
    finishedAt: finishedAt === undefined ? (['succeeded', 'failed', 'cancelled'].includes(status) ? updated : null) : finishedAt,
    progress: null,
    summary,
    outputPath,
    logPath,
    error: null,
    metadata,
    work,
    events: events || [
      {
        at: created,
        type: 'created',
        message: summary || `${type} task created`,
      },
    ],
  };

  return mutateState(STORE_FILE, { tasks: [] }, (store) => {
    store.tasks = pruneTasks([task, ...(store.tasks || [])]);
    return normalizeTask(task);
  });
}

function listTasks({ limit = 20, status = null, type = null } = {}) {
  const store = loadStore();
  let tasks = store.tasks || [];
  if (type) tasks = tasks.filter((task) => task.type === type);
  if (status) tasks = tasks.filter((task) => task.status === status);
  return tasks.slice(0, normalizeLimit(limit)).map(normalizeTask);
}

function getTask(id) {
  assertTaskId(id);
  const store = loadStore();
  return (store.tasks || []).find((entry) => entry.id === id) || null;
}

function updateTask(id, patch = {}, event = null) {
  assertTaskId(id);
  if (patch.status != null && !TASK_STATUSES.has(patch.status)) throw new Error(`Invalid task status: ${patch.status}`);

  return mutateState(STORE_FILE, { tasks: [] }, (store) => {
    const tasks = store.tasks || [];
    const index = tasks.findIndex((entry) => entry.id === id);
    if (index < 0) return null;

    const current = tasks[index];
    const timestamp = nowIso();
    const next = {
      ...current,
      ...patch,
      updatedAt: timestamp,
    };

    if ((patch.status === 'running' || patch.status === 'blocked') && !next.startedAt) next.startedAt = timestamp;
    if (['succeeded', 'failed', 'cancelled'].includes(patch.status) && !next.finishedAt) next.finishedAt = timestamp;
    if (event) {
      next.events = [
        ...(current.events || []),
        {
          at: timestamp,
          ...event,
        },
      ];
    }

    tasks[index] = next;
    store.tasks = tasks;
    return next;
  });
}

function cancelTask(id, reason = 'cancel requested') {
  const task = getTask(id);
  if (!task) return null;
  if (task.status === 'running') throw new Error('Running task cannot be cancelled without terminating its process.');
  if (['succeeded', 'failed', 'cancelled'].includes(task.status)) return task;
  return updateTask(id, { status: 'cancelled', error: reason }, { type: 'cancelled', message: reason });
}

function summarizeTask(task) {
  if (!task) return null;
  return {
    ...normalizeTask(task),
    events: task.events || [],
  };
}

module.exports = {
  createTask,
  listTasks,
  getTask,
  updateTask,
  cancelTask,
  summarizeTask,
  assertTaskId,
  normalizeLimit,
};
