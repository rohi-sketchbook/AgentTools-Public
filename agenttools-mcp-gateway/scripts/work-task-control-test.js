const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenttools-work-task-control-'));
process.env.AGENTTOOLS_STATE_ROOT = path.join(root, 'state');
process.env.AGENTTOOLS_ACTIVITY_ROOT = path.join(root, 'activity');

const workTasks = require('../src/core/workTaskStore');
const control = require('../src/core/workTaskControl');

try {
  const started = workTasks.startWorkTask({
    title: 'Control Center fixture',
    request: 'Verify task control actions',
    actor: 'chatgpt',
    actorLabel: 'ChatGPT',
    model: 'GPT-5.6 Sol',
    project: 'fixture',
    workspaceRoot: root,
    phase: '実装',
    message: 'UIを実装中',
  });
  const blocked = workTasks.updateWorkTask({
    id: started.id,
    actor: 'chatgpt',
    actorLabel: 'ChatGPT',
    model: 'GPT-5.6 Sol',
    state: 'paused',
    phase: '待機',
    message: '作業を一時停止',
    reason: 'manual pause',
    workerStatus: 'blocked',
  });

  const inspection = control.inspectWorkTask({ id: blocked.id });
  assert.equal(inspection.taskId, blocked.id);
  assert.equal(inspection.latestChatGpt.message, '作業を一時停止');
  assert.match(inspection.note, /not the full ChatGPT product conversation history/);

  const resumePrompt = control.buildResumePrompt({ id: blocked.id });
  assert.equal(resumePrompt.ok, true);
  assert.match(resumePrompt.prompt, new RegExp(blocked.id));
  assert.match(resumePrompt.prompt, /Sol/);
  assert.match(resumePrompt.prompt, /Codex\/Astra.*自動起動しない/);
  assert.equal(workTasks.getWorkTask(blocked.id).work.control, null, 'prompt generation must not mutate the Task');

  const requested = control.requestContinue({ id: blocked.id });
  assert.equal(requested.ok, true);
  assert.equal(requested.action, 'waiting-host');
  const queued = workTasks.getWorkTask(blocked.id);
  assert.ok(queued.work.control.continueRequestedAt);
  assert.equal(queued.work.control.continueStatus, 'waiting_host');
  assert.equal(queued.work.state, 'waiting_dependency');
  assert.equal(queued.work.phase, '再開待ち');
  assert.equal(workTasks.listResumableWorkTasks({ limit: 20 }).some((item) => item.id === blocked.id), true);
  const queuedInspection = control.inspectWorkTask({ id: blocked.id });
  assert.equal(queuedInspection.continueRequest.status, 'waiting_host');

  const crashedTask = workTasks.startWorkTask({
    title: 'Continue after crashed worker fixture',
    request: 'Resume after stale heartbeat',
    actor: 'chatgpt',
    actorLabel: 'ChatGPT',
    workspaceRoot: root,
    message: 'working before crash',
  });
  const farFuture = new Date(Date.now() + (2 * 60 * 60 * 1000)).toISOString();
  workTasks.reconcileWorkTask({ id: crashedTask.id, at: farFuture });
  assert.equal(workTasks.getWorkTask(crashedTask.id).status, 'blocked');
  control.requestContinue({ id: crashedTask.id });
  assert.equal(workTasks.getWorkTask(crashedTask.id).work.workers[0].health, 'blocked');
  const reconciledContinue = workTasks.reconcileWorkTask({ id: crashedTask.id, at: farFuture }).task;
  assert.equal(reconciledContinue.work.state, 'waiting_dependency');
  assert.equal(reconciledContinue.work.phase, '再開待ち');
  assert.match(reconciledContinue.work.stateReason, /続行要求済み/);

  assert.throws(() => control.finishForgotten({ id: blocked.id }), /userExplicitlyRequested=true/);
  assert.throws(() => control.finishForgotten({
    id: blocked.id,
    userExplicitlyRequested: true,
    expectedUpdatedAt: new Date(0).toISOString(),
  }), /Task changed after it was displayed/);

  const current = workTasks.getWorkTask(blocked.id);
  const completed = control.finishForgotten({
    id: blocked.id,
    userExplicitlyRequested: true,
    expectedUpdatedAt: current.updatedAt,
  });
  assert.equal(completed.ok, true);
  assert.equal(completed.task.status, 'succeeded');
  assert.equal(completed.task.work.control, null);

  const activeTask = workTasks.startWorkTask({
    title: 'Active worker fixture',
    actor: 'chatgpt',
    actorLabel: 'ChatGPT',
    workspaceRoot: root,
    message: 'still working',
  });
  assert.throws(() => control.finishForgotten({
    id: activeTask.id,
    userExplicitlyRequested: true,
    expectedUpdatedAt: activeTask.updatedAt,
  }), /active worker/);

  const goalTask = workTasks.startWorkTask({
    title: 'Goal protected fixture',
    actor: 'chatgpt',
    actorLabel: 'ChatGPT',
    workspaceRoot: root,
    goalOutcome: 'Validated completion only',
    goalCriteria: ['verified'],
    goalVerification: ['test passes'],
    goalEnforce: true,
  });
  workTasks.updateWorkTask({
    id: goalTask.id,
    actor: 'chatgpt',
    actorLabel: 'ChatGPT',
    state: 'paused',
    workerStatus: 'blocked',
    message: 'paused',
  });
  assert.throws(() => control.finishForgotten({
    id: goalTask.id,
    userExplicitlyRequested: true,
    expectedUpdatedAt: workTasks.getWorkTask(goalTask.id).updatedAt,
  }), /Goal Contract/);

  console.log('work task control tests passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
