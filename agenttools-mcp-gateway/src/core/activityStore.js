const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { projectRoot } = require('./config');
const { withStateLock } = require('./stateFile');
const {
  startWorkTask,
  updateWorkTask,
  completeWorkTask,
  importActivityAsWorkTask,
} = require('./workTaskStore');

const ACTIVITY_ROOT = path.resolve(process.env.AGENTTOOLS_ACTIVITY_ROOT || path.join(projectRoot, 'state', 'activity'));
const STATE_FILE = path.join(ACTIVITY_ROOT, 'activities.json');
const NOTIFY_DIR = path.join(ACTIVITY_ROOT, 'notifications');
const PROCESSED_NOTIFY_DIR = path.join(ACTIVITY_ROOT, 'processed-notifications');
const MAX_RECENT = 100;
const MAX_WORK_LOG = 80;
const ACTIVE_STATUSES = new Set(['running', 'blocked']);
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

function nowIso() {
  return new Date().toISOString();
}

function ensureDirs() {
  fs.mkdirSync(ACTIVITY_ROOT, { recursive: true });
  fs.mkdirSync(NOTIFY_DIR, { recursive: true });
  fs.mkdirSync(PROCESSED_NOTIFY_DIR, { recursive: true });
}

function readStoreUnlocked() {
  ensureDirs();
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.activities)) throw new Error('Invalid activity store.');
    return parsed;
  } catch (error) {
    if (error.code === 'ENOENT') return { schema: 'agenttools-activity/v1', updatedAt: nowIso(), activities: [] };
    throw error;
  }
}

function atomicWriteJson(file, value) {
  ensureDirs();
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.renameSync(temporary, file);
  } finally {
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function normalizeActor(input = {}) {
  const id = String(input.actor || input.actorId || '').trim().toLowerCase();
  if (!id) throw new Error('actor is required.');
  const label = String(input.actorLabel || input.label || id).trim();
  const model = input.model ? String(input.model).trim() : null;
  return { id, label, model };
}

function normalizeList(value) {
  if (value === undefined || value === null || value === '') return [];
  return (Array.isArray(value) ? value : [value]).map((item) => String(item).trim()).filter(Boolean);
}

function contributorKey(actor) {
  return `${actor.id}\u0000${actor.model || ''}`;
}

function appendContributor(activity, actor) {
  const key = contributorKey(actor);
  if (!activity.contributors.some((item) => contributorKey(item) === key)) activity.contributors.push(actor);
}

function upsertWorker(activity, actor, input = {}) {
  activity.workers ||= [];
  const key = contributorKey(actor);
  let worker = activity.workers.find((item) => contributorKey(item.actor) === key);
  if (!worker) {
    worker = { actor, status: 'running', phase: null, message: null, updatedAt: nowIso() };
    activity.workers.push(worker);
  }
  worker.actor = actor;
  if (input.status !== undefined) worker.status = input.status;
  if (input.phase !== undefined) worker.phase = input.phase || null;
  if (input.message !== undefined) worker.message = input.message || null;
  worker.updatedAt = nowIso();
  return worker;
}

function appendWorkLog(activity, actor, message, phase) {
  if (!message && !phase) return;
  activity.workLog.push({
    at: nowIso(),
    actor,
    phase: phase || activity.phase || null,
    message: message || null,
  });
  if (activity.workLog.length > MAX_WORK_LOG) activity.workLog.splice(0, activity.workLog.length - MAX_WORK_LOG);
}

function prune(store) {
  const active = store.activities.filter((item) => ACTIVE_STATUSES.has(item.status));
  const terminal = store.activities
    .filter((item) => TERMINAL_STATUSES.has(item.status))
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    .slice(0, MAX_RECENT);
  store.activities = [...active, ...terminal];
}

function startActivity(input = {}) {
  const title = String(input.title || '').trim();
  if (!title) throw new Error('title is required.');
  const actor = normalizeActor(input);
  const timestamp = nowIso();
  const activityId = `act_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const task = startWorkTask({ ...input, activityId });
  const activity = {
    schema: 'agenttools-activity/v1',
    id: activityId,
    taskId: task.id,
    title,
    request: input.request ? String(input.request).trim() : title,
    project: input.project ? String(input.project).trim() : null,
    workspaceRoot: input.workspaceRoot ? path.resolve(String(input.workspaceRoot)) : null,
    source: input.source ? String(input.source).trim() : 'chatgpt',
    status: 'running',
    phase: input.phase ? String(input.phase).trim() : '開始',
    currentWork: input.message ? String(input.message).trim() : null,
    owner: actor,
    contributors: [actor],
    workers: [],
    workLog: [],
    changedFiles: [],
    tests: [],
    summary: null,
    startedAt: timestamp,
    updatedAt: timestamp,
    completedAt: null,
  };
  upsertWorker(activity, actor, { status: 'running', phase: activity.phase, message: activity.currentWork || '作業中' });
  appendWorkLog(activity, actor, activity.currentWork || '作業を開始', activity.phase);
  withStateLock(() => {
    const store = readStoreUnlocked();
    store.activities.push(activity);
    store.updatedAt = timestamp;
    prune(store);
    atomicWriteJson(STATE_FILE, store);
  });
  return activity;
}

function updateActivity(input = {}) {
  const id = String(input.id || input.activityId || '').trim();
  if (!id) throw new Error('id is required.');
  const actor = normalizeActor(input);
  const currentActivity = getActivity(id);
  if (!currentActivity) throw new Error(`Activity not found: ${id}`);
  if (TERMINAL_STATUSES.has(currentActivity.status)) throw new Error(`Activity is already terminal: ${id}`);
  const linkedTask = currentActivity.taskId ? null : importActivityAsWorkTask(currentActivity);
  const taskId = currentActivity.taskId || linkedTask.id;
  updateWorkTask({
    ...input,
    id: taskId,
    status: input.status === undefined ? (currentActivity.status === 'blocked' ? 'blocked' : 'running') : input.status,
  });
  return withStateLock(() => {
    const store = readStoreUnlocked();
    const activity = store.activities.find((item) => item.id === id);
    if (!activity) throw new Error(`Activity not found: ${id}`);
    activity.taskId = taskId;
    appendContributor(activity, actor);
    if (input.owner === true || input.takeOwnership === true || String(input.takeOwnership || '').toLowerCase() === 'true') activity.owner = actor;
    const phase = input.phase !== undefined ? String(input.phase).trim() || activity.phase : activity.phase;
    const message = input.message !== undefined ? String(input.message).trim() || null : undefined;
    if (input.phase !== undefined) activity.phase = phase;
    if (input.message !== undefined) activity.currentWork = message;
    if (input.status !== undefined) {
      const nextStatus = String(input.status).trim();
      if (!ACTIVE_STATUSES.has(nextStatus)) throw new Error('update status must be running or blocked.');
      activity.status = nextStatus;
    }
    const workerStatus = input.workerStatus === undefined ? 'running' : String(input.workerStatus).trim();
    if (!['running', 'blocked', 'done'].includes(workerStatus)) throw new Error('workerStatus must be running, blocked, or done.');
    upsertWorker(activity, actor, { status: workerStatus, phase, message });
    appendWorkLog(activity, actor, message === undefined ? activity.currentWork : message, phase);
    activity.updatedAt = nowIso();
    store.updatedAt = activity.updatedAt;
    atomicWriteJson(STATE_FILE, store);
    return activity;
  });
}

function completeActivity(input = {}) {
  const id = String(input.id || input.activityId || '').trim();
  if (!id) throw new Error('id is required.');
  const actor = normalizeActor(input);
  const status = String(input.status || 'completed').trim();
  if (!TERMINAL_STATUSES.has(status)) throw new Error('completion status must be completed, failed, or cancelled.');
  const currentActivity = getActivity(id);
  if (!currentActivity) throw new Error(`Activity not found: ${id}`);
  const linkedTask = currentActivity.taskId ? null : importActivityAsWorkTask(currentActivity);
  const taskId = currentActivity.taskId || linkedTask.id;
  if (!TERMINAL_STATUSES.has(currentActivity.status)) {
    completeWorkTask({
      ...input,
      id: taskId,
      status: status === 'completed' ? 'succeeded' : status,
    });
  }
  return withStateLock(() => {
    const store = readStoreUnlocked();
    const activity = store.activities.find((item) => item.id === id);
    if (!activity) throw new Error(`Activity not found: ${id}`);
    activity.taskId = taskId;
    if (TERMINAL_STATUSES.has(activity.status)) return activity;
    appendContributor(activity, actor);
    activity.owner = actor;
    for (const worker of activity.workers ?? []) {
      if (worker.status !== 'done') {
        worker.status = 'done';
        worker.updatedAt = nowIso();
      }
    }
    upsertWorker(activity, actor, { status: 'done', phase: status === 'completed' ? '完了' : status === 'failed' ? '失敗' : '中止', message: input.summary ? String(input.summary).trim() : null });
    activity.status = status;
    activity.phase = status === 'completed' ? '完了' : status === 'failed' ? '失敗' : '中止';
    activity.currentWork = null;
    activity.summary = String(input.summary || '').trim() || (status === 'completed' ? '作業完了' : status === 'failed' ? '作業失敗' : '作業中止');
    activity.changedFiles = normalizeList(input.changedFiles);
    activity.tests = normalizeList(input.tests);
    activity.completedAt = nowIso();
    activity.updatedAt = activity.completedAt;
    appendWorkLog(activity, actor, activity.summary, activity.phase);
    store.updatedAt = activity.updatedAt;
    prune(store);
    atomicWriteJson(STATE_FILE, store);
    return activity;
  });
}

function listActivities(options = {}) {
  const store = readStoreUnlocked();
  const mode = String(options.mode || options.status || 'active').trim().toLowerCase();
  const limit = Math.max(1, Math.min(Number(options.limit || 50), 200));
  let items = store.activities.slice();
  if (mode === 'active') items = items.filter((item) => ACTIVE_STATUSES.has(item.status));
  else if (mode === 'recent' || mode === 'terminal') items = items.filter((item) => TERMINAL_STATUSES.has(item.status));
  else if (mode !== 'all') items = items.filter((item) => item.status === mode);
  return items.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0, limit);
}

function getActivity(id) {
  if (!id) return null;
  return readStoreUnlocked().activities.find((item) => item.id === id) || null;
}

function activityPaths() {
  ensureDirs();
  return {
    root: ACTIVITY_ROOT,
    state: STATE_FILE,
    notifications: NOTIFY_DIR,
    processedNotifications: PROCESSED_NOTIFY_DIR,
  };
}

module.exports = {
  startActivity,
  updateActivity,
  completeActivity,
  listActivities,
  getActivity,
  activityPaths,
  ACTIVE_STATUSES,
  TERMINAL_STATUSES,
};
