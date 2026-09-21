const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { projectRoot } = require('./config');
const { createTask, listTasks, getTask, updateTask } = require('./taskStore');
const { loadSafety } = require('./confirmations');
const { continuationPolicy } = require('./workflowPolicy');
const {
  normalizeResumeContext,
  recordTimeout,
  markAutoResumeStarted,
  markManualResumeStarted,
  markProgress,
  evaluateAutoResume,
} = require('./workTaskResume');
const {
  setGoalContract,
  judgeGoal,
  assertGoalAllowsCompletion,
  updateWorkerLifecycle,
  reconcileWorker,
  recoverWorker,
} = require('./workTaskLifecycle');
const {
  bufferSkillImprovementCandidate,
  flushTaskSkillImprovementCandidates,
} = require('./skillImprovementBuffer');

const WORK_TASK_TYPE = 'work';
const ACTIVE_STATUSES = new Set(['running', 'blocked']);
const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'cancelled']);
const ACTIVE_WORK_STATES = new Set([
  'working',
  'waiting_user',
  'waiting_dependency',
  'paused_timeout',
  'paused',
  'blocked',
]);
const MAX_WORK_LOG = 80;
const NOTIFICATION_ROOT = path.resolve(process.env.AGENTTOOLS_ACTIVITY_ROOT || path.join(projectRoot, 'state', 'activity'));
const NOTIFY_DIR = path.join(NOTIFICATION_ROOT, 'notifications');
const SENDING_NOTIFY_DIR = path.join(NOTIFICATION_ROOT, 'sending-notifications');
const PROCESSED_NOTIFY_DIR = path.join(NOTIFICATION_ROOT, 'processed-notifications');
const LIFECYCLE_NOTIFICATION_KINDS = new Set([
  'continuation_started',
  'continuation_completed',
  'continuation_failed',
]);

function nowIso() {
  return new Date().toISOString();
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

function normalizeWorkState(value, fallback = 'working') {
  const state = String(value || fallback).trim().toLowerCase();
  if (!ACTIVE_WORK_STATES.has(state)) {
    throw new Error(`state must be one of: ${[...ACTIVE_WORK_STATES].join(', ')}.`);
  }
  return state;
}

function defaultStateForStatus(status) {
  if (TERMINAL_STATUSES.has(status)) return null;
  return status === 'blocked' ? 'blocked' : 'working';
}

function statusForState(state) {
  return state === 'working' ? 'running' : 'blocked';
}

function contributorKey(actor) {
  return `${actor.id}\u0000${actor.model || ''}`;
}

function appendContributor(work, actor) {
  work.contributors ||= [];
  const key = contributorKey(actor);
  if (!work.contributors.some((item) => contributorKey(item) === key)) work.contributors.push(actor);
}

function upsertWorker(work, actor, input = {}) {
  work.workers ||= [];
  const key = contributorKey(actor);
  let worker = work.workers.find((item) => contributorKey(item.actor) === key);
  if (!worker) {
    worker = { actor, status: 'running', phase: null, message: null, updatedAt: nowIso(), runs: [] };
    work.workers.push(worker);
  }
  worker.actor = actor;
  updateWorkerLifecycle(worker, input, loadSafety(), input.at || nowIso());
  return worker;
}

function appendWorkLog(work, actor, message, phase, at = null) {
  if (!message && !phase) return;
  work.workLog ||= [];
  work.workLog.push({
    at: at || nowIso(),
    actor,
    phase: phase || work.phase || null,
    message: message || null,
  });
  if (work.workLog.length > MAX_WORK_LOG) work.workLog.splice(0, work.workLog.length - MAX_WORK_LOG);
}

function cloneWork(work) {
  return JSON.parse(JSON.stringify(work || {}));
}

function comparablePath(value) {
  if (!value) return null;
  const resolved = path.resolve(String(value));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function hasWorkspaceConflict(taskId, workspacePath) {
  const target = comparablePath(workspacePath);
  if (!target) return false;
  return listTasks({ limit: 200, type: WORK_TASK_TYPE }).some((candidate) => {
    if (candidate.id === taskId || !ACTIVE_STATUSES.has(candidate.status)) return false;
    const candidatePath = comparablePath(candidate.work?.resumeContext?.worktreePath || candidate.work?.resumeContext?.workspacePath || candidate.work?.workspaceRoot);
    if (!candidatePath || candidatePath !== target) return false;
    const impact = candidate.work?.resumeContext?.nextActionImpact || null;
    const dirty = Boolean(candidate.work?.resumeContext?.hasUncommittedChanges);
    return dirty || (candidate.work?.state === 'working' && impact !== 'read');
  });
}

function taskStatusFromActivity(status) {
  if (status === 'completed') return 'succeeded';
  if (status === 'failed') return 'failed';
  if (status === 'cancelled') return 'cancelled';
  if (status === 'blocked') return 'blocked';
  return 'running';
}

function activityStatusFromTask(status) {
  if (status === 'succeeded') return 'completed';
  return status;
}

function ensureNotificationDirs() {
  fs.mkdirSync(NOTIFY_DIR, { recursive: true });
  fs.mkdirSync(SENDING_NOTIFY_DIR, { recursive: true });
  fs.mkdirSync(PROCESSED_NOTIFY_DIR, { recursive: true });
}

function atomicWriteJson(file, value) {
  ensureNotificationDirs();
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.renameSync(temporary, file);
  } finally {
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function notificationRecord(task) {
  const work = task.work || {};
  return {
    id: task.id,
    title: task.title,
    project: work.project || null,
    status: activityStatusFromTask(task.status),
    summary: task.summary || null,
    phase: work.phase || null,
    currentWork: work.currentWork || null,
    owner: work.owner || null,
    contributors: work.contributors || [],
    workLog: work.workLog || [],
    changedFiles: work.changedFiles || [],
    tests: work.tests || [],
    goal: work.goal || null,
    workers: work.workers || [],
    startedAt: task.startedAt || task.createdAt,
    completedAt: task.finishedAt || null,
  };
}

function notificationAlreadyQueued(fileName) {
  return [NOTIFY_DIR, SENDING_NOTIFY_DIR, PROCESSED_NOTIFY_DIR]
    .some((directory) => fs.existsSync(path.join(directory, fileName)));
}

function emitTerminalNotification(task) {
  if (!TERMINAL_STATUSES.has(task.status)) return;
  ensureNotificationDirs();
  const fileName = `${task.id}.json`;
  if (notificationAlreadyQueued(fileName)) return;
  atomicWriteJson(path.join(NOTIFY_DIR, fileName), {
    schema: 'agenttools-task-notification/v1',
    notificationKind: 'terminal',
    taskId: task.id,
    createdAt: task.finishedAt || task.updatedAt || nowIso(),
    task: notificationRecord(task),
  });
}

function emitLifecycleNotification(task, kind, details = {}) {
  const normalizedKind = String(kind || '').trim().toLowerCase();
  if (!LIFECYCLE_NOTIFICATION_KINDS.has(normalizedKind)) {
    throw new Error(`Unsupported lifecycle notification kind: ${kind}`);
  }
  const attempt = Math.max(1, Math.floor(Number(details.attempt || task?.work?.resumeContext?.continuation?.attempt || 1)));
  ensureNotificationDirs();
  const fileName = `${task.id}--${normalizedKind}--${attempt}.json`;
  if (notificationAlreadyQueued(fileName)) return false;
  atomicWriteJson(path.join(NOTIFY_DIR, fileName), {
    schema: 'agenttools-task-notification/v1',
    notificationKind: normalizedKind,
    taskId: task.id,
    createdAt: details.at || task.updatedAt || nowIso(),
    task: notificationRecord(task),
    continuation: {
      attempt,
      model: details.model || task?.work?.resumeContext?.continuation?.model || null,
      triggerReason: details.triggerReason || null,
      summary: details.summary || null,
      error: details.error || null,
      providerUsage: details.providerUsage || task?.work?.resumeContext?.continuation?.providerUsage || null,
      sessionReused: details.sessionReused === true || task?.work?.resumeContext?.continuation?.sessionReused === true,
    },
  });
  return true;
}

function startWorkTask(input = {}) {
  const title = String(input.title || '').trim();
  if (!title) throw new Error('title is required.');
  const actor = normalizeActor(input);
  const timestamp = nowIso();
  const phase = input.phase ? String(input.phase).trim() : '開始';
  const message = input.message ? String(input.message).trim() : null;
  const request = input.request ? String(input.request).trim() : title;
  const initialState = normalizeWorkState(input.state, 'working');
  const initialStatus = statusForState(initialState);
  const work = {
    schema: 'agenttools-work-task/v1',
    request,
    project: input.project ? String(input.project).trim() : null,
    workspaceRoot: input.workspaceRoot ? path.resolve(String(input.workspaceRoot)) : null,
    source: input.source ? String(input.source).trim() : 'chatgpt',
    phase,
    currentWork: message,
    state: initialState,
    stateReason: input.reason ? String(input.reason).trim() : null,
    owner: actor,
    contributors: [actor],
    workers: [],
    workLog: [],
    changedFiles: [],
    tests: [],
    skillImprovementCandidates: [],
    goal: null,
    resumeContext: null,
    control: null,
    activityId: input.activityId ? String(input.activityId).trim() : null,
  };
  setGoalContract(work, input);
  upsertWorker(work, actor, {
    status: statusForState(initialState) === 'running' ? 'running' : 'blocked',
    phase,
    message: message || '作業中',
    progressSignature: input.progressSignature,
    progressMade: true,
  });
  appendWorkLog(work, actor, message || '作業を開始', phase, timestamp);
  return createTask({
    type: WORK_TASK_TYPE,
    title,
    summary: request,
    status: initialStatus,
    metadata: { source: 'work-task', activityId: work.activityId },
    work,
    createdAt: timestamp,
    updatedAt: timestamp,
    startedAt: timestamp,
  });
}

function updateWorkTask(input = {}) {
  const id = String(input.id || input.taskId || '').trim();
  if (!id) throw new Error('id is required.');
  const current = getTask(id);
  if (!current || current.type !== WORK_TASK_TYPE) throw new Error(`Work task not found: ${id}`);
  if (TERMINAL_STATUSES.has(current.status)) throw new Error(`Task is already terminal: ${id}`);
  const actor = normalizeActor(input);
  const work = cloneWork(current.work);
  appendContributor(work, actor);
  if (input.owner === true || input.takeOwnership === true || String(input.takeOwnership || '').toLowerCase() === 'true') work.owner = actor;
  const phase = input.phase !== undefined ? String(input.phase).trim() || work.phase : work.phase;
  const message = input.message !== undefined ? String(input.message).trim() || null : undefined;
  if (input.phase !== undefined) work.phase = phase;
  if (input.message !== undefined) work.currentWork = message;
  if (input.resumeContext !== undefined || input.resumeContextJson !== undefined) {
    work.resumeContext = normalizeResumeContext(work.resumeContext, input, current);
  }
  if (input.clearResumeContext === true || String(input.clearResumeContext || '').toLowerCase() === 'true') work.resumeContext = null;
  let nextStatus = input.status === undefined ? current.status : String(input.status).trim();
  if (!ACTIVE_STATUSES.has(nextStatus)) throw new Error('update status must be running or blocked.');

  let nextState;
  if (input.state !== undefined) {
    nextState = normalizeWorkState(input.state);
    const impliedStatus = statusForState(nextState);
    if (input.status === undefined) {
      nextStatus = impliedStatus;
    } else if (nextStatus !== impliedStatus) {
      throw new Error(`status ${nextStatus} contradicts state ${nextState}; expected ${impliedStatus}.`);
    }
  } else {
    nextState = normalizeWorkState(work.state, defaultStateForStatus(nextStatus));
    if (input.status !== undefined) {
      if (nextStatus === 'running' && nextState !== 'working') nextState = 'working';
      if (nextStatus === 'blocked' && nextState === 'working') nextState = 'blocked';
    }
  }

  work.state = nextState;
  if (input.reason !== undefined) {
    work.stateReason = String(input.reason || '').trim() || null;
  } else if (nextState === 'working') {
    work.stateReason = null;
  } else if (!work.stateReason) {
    work.stateReason = message === undefined ? work.currentWork : message;
  }

  const workerStatus = input.workerStatus === undefined ? (nextState === 'working' ? 'running' : 'blocked') : String(input.workerStatus).trim();
  if (!['running', 'blocked', 'done'].includes(workerStatus)) throw new Error('workerStatus must be running, blocked, or done.');
  upsertWorker(work, actor, {
    status: workerStatus,
    phase,
    message,
    progressSignature: input.progressSignature,
    progressMade: input.progressMade,
    endReason: input.endReason,
  });
  appendWorkLog(work, actor, message === undefined ? work.currentWork : message, phase);
  return updateTask(id, {
    status: nextStatus,
    work,
    metadata: { ...(current.metadata || {}), activityId: work.activityId || null },
  }, { type: 'work-update', message: message === undefined ? work.currentWork : message });
}

function checkpointWorkTask(input = {}) {
  const id = String(input.id || input.taskId || '').trim();
  if (!id) throw new Error('id is required.');
  const current = getTask(id);
  if (!current || current.type !== WORK_TASK_TYPE) throw new Error(`Work task not found: ${id}`);
  if (TERMINAL_STATUSES.has(current.status)) throw new Error(`Task is already terminal: ${id}`);
  const actor = normalizeActor(input);
  const work = cloneWork(current.work);
  appendContributor(work, actor);
  let resumeContext = normalizeResumeContext(work.resumeContext, { ...input, checkpointAt: input.checkpointAt || nowIso() }, current);
  const progressMade = input.progressMade === true || String(input.progressMade || '').toLowerCase() === 'true';
  if (progressMade) resumeContext = markProgress(resumeContext, { progressSignature: input.progressSignature || resumeContext.progressSignature });
  work.resumeContext = resumeContext;
  if (input.phase !== undefined) work.phase = String(input.phase).trim() || work.phase;
  if (input.message !== undefined) work.currentWork = String(input.message).trim() || null;
  const description = String(input.message || '').trim()
    || `チェックポイント保存${resumeContext.lastCompletedStep ? `: ${resumeContext.lastCompletedStep}` : ''}${resumeContext.nextStep ? ` → 次: ${resumeContext.nextStep}` : ''}`;
  upsertWorker(work, actor, {
    status: work.state === 'working' ? 'running' : 'blocked',
    phase: work.phase,
    message: work.currentWork || description,
    progressSignature: input.progressSignature || resumeContext.progressSignature,
    progressMade,
  });
  appendWorkLog(work, actor, description, work.phase || 'チェックポイント');
  return updateTask(id, {
    status: current.status,
    work,
    metadata: { ...(current.metadata || {}), activityId: work.activityId || null },
  }, { type: 'work-checkpoint', message: description });
}

function timeoutWorkTask(input = {}) {
  const id = String(input.id || input.taskId || '').trim();
  if (!id) throw new Error('id is required.');
  const current = getTask(id);
  if (!current || current.type !== WORK_TASK_TYPE) throw new Error(`Work task not found: ${id}`);
  if (TERMINAL_STATUSES.has(current.status)) throw new Error(`Task is already terminal: ${id}`);
  const actor = normalizeActor(input);
  const work = cloneWork(current.work);
  appendContributor(work, actor);
  const previousProgressSignature = work.resumeContext?.progressSignature || null;
  const normalized = normalizeResumeContext(work.resumeContext, { ...input, checkpointAt: input.checkpointAt || nowIso() }, current);
  const resumeWorkspace = normalized.worktreePath || normalized.workspacePath || work.workspaceRoot;
  normalized.workspaceConflict = normalized.workspaceConflict || hasWorkspaceConflict(id, resumeWorkspace);
  const timeoutKind = input.timeoutKind || normalized.timeoutKind || 'gateway_task';
  const timeout = recordTimeout(normalized, {
    timeoutKind,
    elapsedMs: Number(input.elapsedMs || input.executionElapsedMs || 0),
    progressSignature: input.progressSignature || normalized.progressSignature,
    previousProgressSignature,
  }, loadSafety());
  work.resumeContext = timeout.context;
  work.state = 'paused_timeout';
  work.stateReason = timeout.decision.ok
    ? `${timeoutKind} timeout。チェックポイント保存済み・自動継続可能`
    : `${timeoutKind} timeout。${timeout.decision.reason}`;
  work.phase = input.phase ? String(input.phase).trim() : work.phase;
  work.currentWork = input.message ? String(input.message).trim() : work.currentWork;
  upsertWorker(work, actor, {
    status: 'blocked',
    phase: work.phase || '実行時間終了',
    message: work.currentWork || '実行時間上限に到達',
    progressSignature: input.progressSignature || timeout.context.progressSignature,
    endReason: `${timeoutKind} timeout`,
  });
  appendWorkLog(work, actor, `${timeoutKind}の実行時間上限に到達`, '実行時間終了');
  appendWorkLog(work, actor, `チェックポイント保存${timeout.context.nextStep ? ` / 次: ${timeout.context.nextStep}` : ''}`, 'チェックポイント');

  const autoStart = input.autoResume !== false && String(input.autoResume || 'true').toLowerCase() !== 'false';
  const continuation = continuationPolicy();
  if (timeout.decision.ok && autoStart && continuation.mode === 'chatgpt') {
    work.resumeContext = markAutoResumeStarted(work.resumeContext);
    work.state = 'working';
    work.stateReason = '実行時間上限に到達したため、次のChatGPT executionでチェックポイントから自動継続';
    work.phase = input.resumePhase ? String(input.resumePhase).trim() : '自動継続';
    work.currentWork = timeout.context.nextStep || work.currentWork;
    upsertWorker(work, actor, {
      status: 'running',
      phase: work.phase,
      message: work.currentWork || 'チェックポイントから再開',
      progressSignature: timeout.context.progressSignature,
      progressMade: true,
    });
    appendWorkLog(work, actor, `自動再開(ChatGPT待ち): ${work.currentWork || 'checkpointから継続'}`, '自動継続');
  } else if (timeout.decision.ok && autoStart && continuation.mode === 'codex') {
    work.state = 'paused_timeout';
    work.stateReason = '実行時間上限に到達。Codex自動引き継ぎ待ち';
    work.phase = 'Codex引き継ぎ待ち';
    work.currentWork = timeout.context.nextStep || work.currentWork;
    appendWorkLog(work, actor, `Codex自動引き継ぎ待ち: ${work.currentWork || 'checkpointから継続'}`, 'Codex引き継ぎ待ち');
  } else if (timeout.decision.ok && autoStart && continuation.mode === 'off') {
    work.state = 'paused_timeout';
    work.stateReason = '実行時間上限に到達。自動継続はOFF';
  }

  return updateTask(id, {
    status: work.state === 'working' ? 'running' : 'blocked',
    work,
    metadata: { ...(current.metadata || {}), activityId: work.activityId || null },
  }, {
    type: work.state === 'working' ? 'work-auto-resume' : 'work-timeout',
    message: work.stateReason,
  });
}

function requestContinueWorkTask(input = {}) {
  const id = String(input.id || input.taskId || '').trim();
  if (!id) throw new Error('id is required.');
  const current = getTask(id);
  if (!current || current.type !== WORK_TASK_TYPE) throw new Error(`Work task not found: ${id}`);
  if (TERMINAL_STATUSES.has(current.status)) throw new Error(`Task is already terminal: ${id}`);
  if (current.status === 'running') throw new Error('Task is still running. Continue is only available for stopped/blocked tasks.');

  const actor = normalizeActor(input);
  const work = cloneWork(current.work);
  appendContributor(work, actor);
  for (const worker of work.workers || []) {
    if (worker.status === 'blocked' && (worker.health === 'crashed' || worker.health === 'stalled')) {
      worker.health = 'blocked';
      worker.stalledAt = null;
    }
  }
  const continueRequestedAt = nowIso();
  const hasCheckpoint = Boolean(work.resumeContext?.nextStep);
  work.control = {
    ...(work.control || {}),
    continueRequestedAt,
    continueRequestedBy: actor,
    continueStatus: hasCheckpoint ? 'requested' : 'waiting_host',
  };
  work.state = hasCheckpoint ? 'blocked' : 'waiting_dependency';
  work.stateReason = hasCheckpoint
    ? 'Control Centerから続行要求を受け付けました。安全確認後にDevSpaceで再開します。'
    : '続行要求済み。安全なcheckpointがないため、次回このTaskをChatGPTで再開できる実行待ちです。';
  work.phase = hasCheckpoint ? '続行要求' : '再開待ち';
  work.currentWork = hasCheckpoint ? work.resumeContext.nextStep : (work.currentWork || 'Taskの記録から残作業を確認して再開');
  upsertWorker(work, actor, {
    status: 'blocked',
    phase: work.phase,
    message: work.stateReason,
    endReason: 'control-center continue requested',
  });
  appendWorkLog(work, actor, work.stateReason, work.phase);
  return updateTask(id, {
    status: 'blocked',
    work,
    metadata: { ...(current.metadata || {}), activityId: work.activityId || null },
  }, { type: 'work-continue-requested', message: work.stateReason });
}

function resumeWorkTask(input = {}) {
  const id = String(input.id || input.taskId || '').trim();
  if (!id) throw new Error('id is required.');
  const current = getTask(id);
  if (!current || current.type !== WORK_TASK_TYPE) throw new Error(`Work task not found: ${id}`);
  if (TERMINAL_STATUSES.has(current.status)) throw new Error(`Task is already terminal: ${id}`);
  const actor = normalizeActor(input);
  const work = cloneWork(current.work);
  if (!work.resumeContext) throw new Error('Task has no resumeContext checkpoint.');
  const decision = evaluateAutoResume(work.resumeContext, loadSafety());
  const force = input.force === true || String(input.force || '').toLowerCase() === 'true';
  if (!decision.ok && !force) throw new Error(`Task is not safe to auto-resume: ${decision.reason}`);
  appendContributor(work, actor);
  work.control = null;
  work.resumeContext = force ? markManualResumeStarted(work.resumeContext) : markAutoResumeStarted(work.resumeContext);
  work.state = 'working';
  work.stateReason = force
    ? (decision.ok ? '明示的にチェックポイントから作業を再開' : `明示再開: ${decision.reason}`)
    : '前回executionのチェックポイントから自動継続';
  work.phase = input.phase ? String(input.phase).trim() : (force ? '再開' : '自動継続');
  work.currentWork = input.message ? String(input.message).trim() : work.resumeContext.nextStep || work.currentWork;
  upsertWorker(work, actor, {
    status: 'running',
    phase: work.phase,
    message: work.currentWork || '作業を再開',
    progressSignature: work.resumeContext.progressSignature,
    progressMade: true,
  });
  appendWorkLog(work, actor, `再開: ${work.currentWork || 'checkpointから継続'}`, work.phase);
  return updateTask(id, {
    status: 'running',
    work,
    metadata: { ...(current.metadata || {}), activityId: work.activityId || null },
  }, { type: 'work-resume', message: work.stateReason });
}

function setGoalWorkTask(input = {}) {
  const id = String(input.id || input.taskId || '').trim();
  if (!id) throw new Error('id is required.');
  const current = getTask(id);
  if (!current || current.type !== WORK_TASK_TYPE) throw new Error(`Work task not found: ${id}`);
  if (TERMINAL_STATUSES.has(current.status)) throw new Error(`Task is already terminal: ${id}`);
  const actor = normalizeActor(input);
  const work = cloneWork(current.work);
  appendContributor(work, actor);
  const goal = setGoalContract(work, input);
  appendWorkLog(work, actor, `Goal Contract更新: ${goal.desiredOutcome}`, 'Goal');
  return updateTask(id, {
    work,
    metadata: { ...(current.metadata || {}), activityId: work.activityId || null },
  }, { type: 'work-goal', message: goal.desiredOutcome });
}

function judgeGoalWorkTask(input = {}) {
  const id = String(input.id || input.taskId || '').trim();
  if (!id) throw new Error('id is required.');
  const current = getTask(id);
  if (!current || current.type !== WORK_TASK_TYPE) throw new Error(`Work task not found: ${id}`);
  if (TERMINAL_STATUSES.has(current.status)) throw new Error(`Task is already terminal: ${id}`);
  const actor = normalizeActor(input);
  const work = cloneWork(current.work);
  appendContributor(work, actor);
  const goal = judgeGoal(work, { ...input, actor: actor.id });
  if (goal.status === 'blocked') {
    work.state = 'blocked';
    work.stateReason = goal.lastJudgement?.summary || 'Goal判定がblocked';
  } else if (work.state === 'blocked' && goal.status === 'active') {
    work.state = 'working';
    work.stateReason = null;
  }
  appendWorkLog(work, actor, `Goal判定: ${goal.lastJudgement.result}${goal.lastJudgement.summary ? ` / ${goal.lastJudgement.summary}` : ''}`, 'Goal判定');
  return updateTask(id, {
    status: statusForState(work.state || defaultStateForStatus(current.status)),
    work,
    metadata: { ...(current.metadata || {}), activityId: work.activityId || null },
  }, { type: 'work-goal-judgement', message: goal.lastJudgement.summary || goal.lastJudgement.result });
}

function heartbeatWorkTask(input = {}) {
  const id = String(input.id || input.taskId || '').trim();
  if (!id) throw new Error('id is required.');
  const current = getTask(id);
  if (!current || current.type !== WORK_TASK_TYPE) throw new Error(`Work task not found: ${id}`);
  if (TERMINAL_STATUSES.has(current.status)) throw new Error(`Task is already terminal: ${id}`);
  const actor = normalizeActor(input);
  const work = cloneWork(current.work);
  appendContributor(work, actor);
  const worker = upsertWorker(work, actor, {
    status: 'running',
    phase: input.phase,
    message: input.message,
    progressSignature: input.progressSignature,
    progressMade: input.progressMade,
  });
  const progressMade = input.progressMade === true || String(input.progressMade || '').toLowerCase() === 'true';
  if (progressMade) appendWorkLog(work, actor, input.message || 'worker progress heartbeat', input.phase || worker.phase || '進捗');
  return updateTask(id, {
    status: current.status,
    work,
    metadata: { ...(current.metadata || {}), activityId: work.activityId || null },
  }, progressMade ? { type: 'work-progress', message: input.message || 'worker progress heartbeat' } : null);
}

function reconcileWorkTask(input = {}) {
  const id = String(input.id || input.taskId || '').trim();
  if (!id) throw new Error('id is required.');
  const current = getTask(id);
  if (!current || current.type !== WORK_TASK_TYPE) throw new Error(`Work task not found: ${id}`);
  if (TERMINAL_STATUSES.has(current.status)) return { task: current, changed: false, workers: [] };
  const work = cloneWork(current.work);
  const safety = loadSafety();
  const at = input.at || nowIso();
  let changed = false;
  const reports = [];
  for (const worker of work.workers || []) {
    const result = reconcileWorker(worker, safety, at);
    if (result.changed) changed = true;
    reports.push({
      actor: worker.actor,
      status: worker.status,
      health: worker.health || null,
      attempt: worker.attempt || null,
      currentRunId: worker.currentRunId || null,
      lastHeartbeatAt: worker.lastHeartbeatAt || null,
      lastProgressAt: worker.lastProgressAt || null,
      circuitOpenUntil: worker.circuitOpenUntil || null,
    });
  }
  const crashed = reports.filter((entry) => entry.health === 'crashed' || entry.health === 'circuit_open');
  const stalled = reports.filter((entry) => entry.health === 'stalled');
  const healthyRunning = reports.filter((entry) => entry.status === 'running' && entry.health === 'healthy');
  const waitingHostContinue = Boolean(work.control?.continueRequestedAt)
    && (!work.control?.continueStatus || work.control.continueStatus === 'waiting_host')
    && !work.resumeContext?.nextStep;
  if (waitingHostContinue && healthyRunning.length === 0) {
    const expectedReason = '続行要求済み。安全なcheckpointがないため、次回このTaskをChatGPTで再開できる実行待ちです。';
    if (work.state !== 'waiting_dependency' || work.phase !== '再開待ち' || work.stateReason !== expectedReason) {
      work.state = 'waiting_dependency';
      work.phase = '再開待ち';
      work.stateReason = expectedReason;
      changed = true;
    }
  } else if (crashed.length > 0 && healthyRunning.length === 0) {
    const expectedReason = crashed.some((entry) => entry.health === 'circuit_open')
      ? 'worker crashが連続したためcircuit breaker作動中'
      : 'worker heartbeatが途絶えたためcrashとして回収';
    if (work.state !== 'blocked' || work.stateReason !== expectedReason) {
      work.state = 'blocked';
      work.stateReason = expectedReason;
      changed = true;
    }
  } else if (stalled.length > 0 && work.state === 'working' && work.stateReason !== 'workerの意味のある進捗が一定時間なくstall判定') {
    work.stateReason = 'workerの意味のある進捗が一定時間なくstall判定';
    changed = true;
  } else if (healthyRunning.length > 0 && work.state === 'working' && work.stateReason === 'workerの意味のある進捗が一定時間なくstall判定') {
    work.stateReason = null;
    changed = true;
  }
  if (!changed) return { task: current, changed: false, workers: reports };
  const updated = updateTask(id, {
    status: work.state === 'working' ? 'running' : 'blocked',
    work,
    metadata: { ...(current.metadata || {}), activityId: work.activityId || null },
  }, { type: 'work-reconcile', message: work.stateReason || 'worker lifecycle reconciled' });
  return { task: updated, changed: true, workers: reports };
}

function reconcileWorkTasks(options = {}) {
  const limit = Math.max(1, Math.min(Number(options.limit || 100), 100));
  const tasks = listTasks({ limit, type: WORK_TASK_TYPE }).filter((task) => ACTIVE_STATUSES.has(task.status));
  return tasks.map((task) => reconcileWorkTask({ id: task.id, at: options.at }));
}

function recoverWorkerWorkTask(input = {}) {
  const id = String(input.id || input.taskId || '').trim();
  if (!id) throw new Error('id is required.');
  const current = getTask(id);
  if (!current || current.type !== WORK_TASK_TYPE) throw new Error(`Work task not found: ${id}`);
  if (TERMINAL_STATUSES.has(current.status)) throw new Error(`Task is already terminal: ${id}`);
  const actor = normalizeActor(input);
  const work = cloneWork(current.work);
  const key = contributorKey(actor);
  const worker = (work.workers || []).find((entry) => contributorKey(entry.actor) === key);
  if (!worker) throw new Error(`Worker not found for actor ${actor.id}${actor.model ? `/${actor.model}` : ''}.`);
  recoverWorker(worker, {
    ...input,
    phase: input.phase || '復旧',
    message: input.message || work.resumeContext?.nextStep || work.currentWork || 'workerを再開',
  }, loadSafety(), input.at || nowIso());
  appendContributor(work, actor);
  work.state = 'working';
  work.stateReason = null;
  work.phase = input.phase || '復旧';
  work.currentWork = input.message || work.resumeContext?.nextStep || work.currentWork;
  appendWorkLog(work, actor, `worker recovery attempt=${worker.attempt}: ${work.currentWork || '再開'}`, work.phase);
  return updateTask(id, {
    status: 'running',
    work,
    metadata: { ...(current.metadata || {}), activityId: work.activityId || null },
  }, { type: 'work-worker-recovered', message: work.currentWork || 'worker recovered' });
}

function bufferWorkTaskSkillImprovement(input = {}) {
  const id = String(input.id || input.taskId || '').trim();
  if (!id) throw new Error('id is required.');
  const current = getTask(id);
  if (!current || current.type !== WORK_TASK_TYPE) throw new Error(`Work task not found: ${id}`);
  if (TERMINAL_STATUSES.has(current.status)) throw new Error(`Task is already terminal: ${id}`);
  const actor = normalizeActor(input);
  const buffered = bufferSkillImprovementCandidate({
    ...input,
    taskId: id,
    source: input.source || 'task_completion',
    proposedBy: input.proposedBy || actor.label || actor.id,
  });
  const work = cloneWork(current.work);
  appendContributor(work, actor);
  work.skillImprovementCandidates ||= [];
  const publicCandidate = {
    id: buffered.candidate.id,
    skillName: buffered.candidate.skillName,
    summary: buffered.candidate.summary,
    reason: buffered.candidate.reason,
    status: buffered.candidate.status,
    proposalId: buffered.candidate.proposalId || null,
    error: buffered.candidate.error || null,
    createdAt: buffered.candidate.createdAt,
    updatedAt: buffered.candidate.updatedAt,
  };
  const existingIndex = work.skillImprovementCandidates.findIndex((entry) => entry.id === publicCandidate.id);
  if (existingIndex >= 0) work.skillImprovementCandidates[existingIndex] = publicCandidate;
  else work.skillImprovementCandidates.push(publicCandidate);
  if (work.skillImprovementCandidates.length > 8) {
    work.skillImprovementCandidates = work.skillImprovementCandidates.slice(-8);
  }
  if (!buffered.deduplicated) {
    appendWorkLog(work, actor, `Skill改善候補を保留: ${publicCandidate.summary}`, work.phase || '作業中');
  }
  const task = updateTask(id, {
    work,
    metadata: { ...(current.metadata || {}), activityId: work.activityId || null },
  }, buffered.deduplicated ? null : { type: 'work-skill-improvement-buffered', message: publicCandidate.summary });
  return { task, candidate: publicCandidate, deduplicated: buffered.deduplicated === true };
}

function completeWorkTask(input = {}) {
  const id = String(input.id || input.taskId || '').trim();
  if (!id) throw new Error('id is required.');
  const current = getTask(id);
  if (!current || current.type !== WORK_TASK_TYPE) throw new Error(`Work task not found: ${id}`);
  if (TERMINAL_STATUSES.has(current.status)) return current;
  const actor = normalizeActor(input);
  let status = String(input.status || 'succeeded').trim();
  if (status === 'completed') status = 'succeeded';
  if (!TERMINAL_STATUSES.has(status)) throw new Error('completion status must be succeeded, failed, or cancelled.');
  const work = cloneWork(current.work);
  appendContributor(work, actor);
  assertGoalAllowsCompletion(work, status);
  work.owner = actor;
  for (const worker of work.workers || []) {
    if (worker.status !== 'done') {
      updateWorkerLifecycle(worker, {
        status: 'done',
        phase: status === 'succeeded' ? '完了' : status === 'failed' ? '失敗' : '中止',
        message: input.summary || null,
        endReason: `task ${status}`,
      }, loadSafety(), nowIso());
    }
  }
  const phase = status === 'succeeded' ? '完了' : status === 'failed' ? '失敗' : '中止';
  const summary = String(input.summary || '').trim() || (status === 'succeeded' ? '作業完了' : status === 'failed' ? '作業失敗' : '作業中止');
  upsertWorker(work, actor, { status: 'done', phase, message: summary });
  work.phase = phase;
  work.currentWork = null;
  work.state = null;
  work.stateReason = null;
  work.changedFiles = normalizeList(input.changedFiles);
  work.tests = normalizeList(input.tests);
  try {
    const skillImprovementResults = flushTaskSkillImprovementCandidates(id);
    if (skillImprovementResults.length > 0) {
      work.skillImprovementCandidates ||= [];
      for (const result of skillImprovementResults) {
        const index = work.skillImprovementCandidates.findIndex((entry) => entry.id === result.id);
        const summary = {
          id: result.id,
          skillName: result.skillName,
          summary: result.summary,
          reason: result.reason,
          status: result.status,
          proposalId: result.proposalId || null,
          error: result.error || null,
          createdAt: result.createdAt || null,
          updatedAt: result.updatedAt || nowIso(),
          deduplicated: result.deduplicated === true,
        };
        if (index >= 0) work.skillImprovementCandidates[index] = summary;
        else work.skillImprovementCandidates.push(summary);
      }
      const proposedCount = skillImprovementResults.filter((entry) => entry.status === 'proposed').length;
      const issueCount = skillImprovementResults.length - proposedCount;
      appendWorkLog(
        work,
        actor,
        `Skill改善候補を自動proposal化: ${proposedCount}件${issueCount > 0 ? ` / 要再確認 ${issueCount}件` : ''}`,
        phase,
      );
    }
  } catch (error) {
    work.skillImprovementFlushError = error.message;
    appendWorkLog(work, actor, `Skill改善候補のproposal化に失敗: ${error.message}`, phase);
  }
  work.resumeContext = null;
  work.control = null;
  appendWorkLog(work, actor, summary, phase);
  const completed = updateTask(id, {
    status,
    summary,
    error: status === 'failed' ? summary : null,
    work,
    metadata: { ...(current.metadata || {}), activityId: work.activityId || null },
  }, { type: status, message: summary });
  emitTerminalNotification(completed);
  return completed;
}

function listWorkTasks(options = {}) {
  const mode = String(options.mode || 'active').trim().toLowerCase();
  const limit = Math.max(1, Math.min(Number(options.limit || 50), 200));
  let tasks = listTasks({ limit: 200, type: WORK_TASK_TYPE });
  if (mode === 'active') tasks = tasks.filter((task) => ACTIVE_STATUSES.has(task.status));
  else if (mode === 'recent' || mode === 'terminal') tasks = tasks.filter((task) => TERMINAL_STATUSES.has(task.status));
  else if (mode !== 'all') tasks = tasks.filter((task) => task.status === mode || (mode === 'completed' && task.status === 'succeeded'));
  return tasks.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0, limit);
}

function listResumableWorkTasks(options = {}) {
  const limit = Math.max(1, Math.min(Number(options.limit || 20), 100));
  reconcileWorkTasks({ limit: 100 });
  return listWorkTasks({ mode: 'active', limit: 200 })
    .filter((task) => task.work?.resumeContext?.nextStep || task.work?.control?.continueRequestedAt)
    .slice(0, limit);
}

function getWorkTask(id) {
  const task = getTask(id);
  return task?.type === WORK_TASK_TYPE ? task : null;
}

function findWorkTaskByActivityId(activityId) {
  const id = String(activityId || '').trim();
  if (!id) return null;
  return listTasks({ limit: 200, type: WORK_TASK_TYPE }).find((task) => task.work?.activityId === id || task.metadata?.activityId === id) || null;
}

function importActivityAsWorkTask(activity = {}) {
  if (!activity.id) throw new Error('activity.id is required.');
  const existing = activity.taskId ? getWorkTask(activity.taskId) : findWorkTaskByActivityId(activity.id);
  if (existing) return existing;
  const status = taskStatusFromActivity(activity.status);
  const work = {
    schema: 'agenttools-work-task/v1',
    request: activity.request || activity.title || '',
    project: activity.project || null,
    workspaceRoot: activity.workspaceRoot || null,
    source: activity.source || 'chatgpt',
    phase: activity.phase || null,
    currentWork: activity.currentWork || null,
    state: TERMINAL_STATUSES.has(status) ? null : (activity.state || defaultStateForStatus(status)),
    stateReason: TERMINAL_STATUSES.has(status) ? null : (activity.stateReason || null),
    owner: activity.owner || null,
    contributors: activity.contributors || [],
    workers: activity.workers || [],
    workLog: (activity.workLog || []).slice(-MAX_WORK_LOG),
    changedFiles: activity.changedFiles || [],
    tests: activity.tests || [],
    goal: activity.goal || null,
    resumeContext: activity.resumeContext || null,
    control: activity.control || null,
    activityId: activity.id,
  };
  const task = createTask({
    type: WORK_TASK_TYPE,
    title: activity.title || activity.id,
    summary: activity.summary || activity.request || activity.title || null,
    status,
    metadata: { source: 'activity-migration', activityId: activity.id },
    work,
    createdAt: activity.startedAt || activity.updatedAt || nowIso(),
    updatedAt: activity.updatedAt || activity.completedAt || nowIso(),
    startedAt: activity.startedAt || null,
    finishedAt: activity.completedAt || (TERMINAL_STATUSES.has(status) ? activity.updatedAt || nowIso() : null),
    events: [{
      at: activity.startedAt || activity.updatedAt || nowIso(),
      type: 'migrated-from-activity',
      message: `Migrated from ${activity.id}`,
    }],
  });
  return task;
}

function setActivityLink(taskId, activityId) {
  const current = getWorkTask(taskId);
  if (!current) throw new Error(`Work task not found: ${taskId}`);
  const work = cloneWork(current.work);
  work.activityId = activityId || null;
  return updateTask(taskId, {
    work,
    metadata: { ...(current.metadata || {}), activityId: work.activityId },
  }, { type: 'activity-link', message: work.activityId ? `activity=${work.activityId}` : 'activity link cleared' });
}

module.exports = {
  WORK_TASK_TYPE,
  ACTIVE_STATUSES,
  TERMINAL_STATUSES,
  ACTIVE_WORK_STATES,
  startWorkTask,
  updateWorkTask,
  checkpointWorkTask,
  timeoutWorkTask,
  requestContinueWorkTask,
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
  findWorkTaskByActivityId,
  importActivityAsWorkTask,
  setActivityLink,
  emitLifecycleNotification,
  taskStatusFromActivity,
};
