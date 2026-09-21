const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenttools-work-task-test-'));
const stateRoot = path.join(root, 'state');
const activityRoot = path.join(root, 'activity');
process.env.AGENTTOOLS_STATE_ROOT = stateRoot;
process.env.AGENTTOOLS_ACTIVITY_ROOT = activityRoot;

const workTasks = require('../src/core/workTaskStore');
const { createTask, listTasks } = require('../src/core/taskStore');

try {
  const started = workTasks.startWorkTask({
    title: 'User task',
    request: 'Verify Task-centered work tracking',
    actor: 'chatgpt',
    actorLabel: 'ChatGPT',
    model: 'GPT-5.6 Sol',
    project: 'demo',
    workspaceRoot: root,
    phase: '調査',
    message: '構成確認中',
  });
  assert.match(started.id, /^task_\d{14}_[a-f0-9]{8}$/);
  assert.equal(started.type, 'work');
  assert.equal(started.status, 'running');
  assert.equal(started.work.state, 'working');
  assert.equal(started.work.stateReason, null);
  assert.equal(started.work.workers.length, 1);
  assert.equal(started.work.workers[0].attempt, 1);
  assert.equal(started.work.workers[0].runs.length, 1);
  assert.equal(started.work.workers[0].runs[0].status, 'running');
  assert.ok(started.work.workers[0].lastHeartbeatAt);
  assert.equal(workTasks.listWorkTasks({ mode: 'active' }).length, 1);

  for (let index = 0; index < 205; index += 1) {
    createTask({ type: 'execution-test', title: `Execution ${index}`, status: 'planned' });
  }
  assert.equal(listTasks({ type: 'execution-test', limit: 250 }).length, 200);
  assert.equal(workTasks.getWorkTask(started.id)?.id, started.id, 'execution jobs must not evict work task history');

  const updated = workTasks.updateWorkTask({
    id: started.id,
    actor: 'codex',
    actorLabel: 'Codex',
    model: 'Luna',
    phase: '調査',
    message: '影響範囲を調査',
    workerStatus: 'running',
  });
  assert.equal(updated.work.contributors.length, 2);
  assert.equal(updated.work.workers.find((item) => item.actor.id === 'codex').message, '影響範囲を調査');

  const blocked = workTasks.updateWorkTask({
    id: started.id,
    actor: 'chatgpt',
    actorLabel: 'ChatGPT',
    model: 'GPT-5.6 Sol',
    state: 'waiting_user',
    reason: 'ユーザーの確認が必要',
    workerStatus: 'blocked',
    phase: '待機',
    message: '確認待ち',
  });
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.work.state, 'waiting_user');
  assert.equal(blocked.work.stateReason, 'ユーザーの確認が必要');

  const resumed = workTasks.updateWorkTask({
    id: started.id,
    actor: 'chatgpt',
    actorLabel: 'ChatGPT',
    model: 'GPT-5.6 Sol',
    state: 'working',
    workerStatus: 'running',
    phase: '再開',
    message: '作業を再開',
  });
  assert.equal(resumed.status, 'running');
  assert.equal(resumed.work.state, 'working');
  assert.equal(resumed.work.stateReason, null);

  const checkpointed = workTasks.checkpointWorkTask({
    id: started.id,
    actor: 'chatgpt',
    actorLabel: 'ChatGPT',
    model: 'GPT-5.6 Sol',
    phase: 'テスト',
    lastCompletedStep: 'ソース修正',
    nextStep: 'ローカルテストを継続',
    workspacePath: root,
    branch: 'main',
    hasUncommittedChanges: true,
    nextActionImpact: 'local_test',
    progressSignature: 'source-edit-complete',
    progressMade: true,
  });
  assert.equal(checkpointed.work.resumeContext.nextStep, 'ローカルテストを継続');
  assert.equal(checkpointed.work.resumeContext.branch, 'main');

  const timedOut = workTasks.timeoutWorkTask({
    id: started.id,
    actor: 'chatgpt',
    actorLabel: 'ChatGPT',
    model: 'GPT-5.6 Sol',
    timeoutKind: 'chatgpt_execution',
    elapsedMs: 1000,
    nextStep: 'ローカルテストを継続',
    nextActionImpact: 'local_test',
    progressSignature: 'source-edit-complete',
  });
  assert.equal(timedOut.status, 'running');
  assert.equal(timedOut.work.state, 'working');
  assert.equal(timedOut.work.resumeContext.autoResumeStatus, 'resuming');
  assert.equal(timedOut.work.resumeContext.autoResumeCount, 1);
  assert.match(timedOut.work.workLog.at(-3).message, /実行時間上限/);
  assert.match(timedOut.work.workLog.at(-2).message, /チェックポイント保存/);
  assert.match(timedOut.work.workLog.at(-1).message, /自動再開/);

  const externalBoundary = workTasks.timeoutWorkTask({
    id: started.id,
    actor: 'chatgpt',
    actorLabel: 'ChatGPT',
    model: 'GPT-5.6 Sol',
    timeoutKind: 'chatgpt_execution',
    elapsedMs: 1000,
    nextStep: 'originへpush',
    nextActionImpact: 'local_write',
    pendingAction: 'git.push',
    allowedExternalActions: ['git.push'],
    progressSignature: 'tests-complete',
  });
  assert.equal(externalBoundary.status, 'blocked');
  assert.equal(externalBoundary.work.state, 'paused_timeout');
  assert.equal(externalBoundary.work.resumeContext.autoResumeEligible, false);
  assert.match(externalBoundary.work.stateReason, /自動継続禁止操作/);

  const manuallyResumed = workTasks.resumeWorkTask({
    id: started.id,
    actor: 'chatgpt',
    actorLabel: 'ChatGPT',
    model: 'GPT-5.6 Sol',
    force: true,
    phase: '再開',
    message: 'ユーザー確認後に再開',
  });
  assert.equal(manuallyResumed.status, 'running');
  assert.equal(manuallyResumed.work.state, 'working');
  assert.equal(manuallyResumed.work.resumeContext.autoResumeStatus, 'manual');
  assert.equal(manuallyResumed.work.resumeContext.autoResumeCount, 1, 'manual resume must not consume auto-resume quota');

  assert.throws(() => workTasks.updateWorkTask({
    id: started.id,
    actor: 'chatgpt',
    actorLabel: 'ChatGPT',
    model: 'GPT-5.6 Sol',
    status: 'running',
    state: 'waiting_user',
  }), /contradicts state/);

  const loopTask = workTasks.startWorkTask({
    title: 'Loop guard fixture',
    actor: 'chatgpt',
    actorLabel: 'ChatGPT',
    model: 'GPT-5.6 Sol',
    workspaceRoot: path.join(root, 'loop'),
  });
  workTasks.checkpointWorkTask({
    id: loopTask.id,
    actor: 'chatgpt',
    actorLabel: 'ChatGPT',
    nextStep: 'テスト継続',
    workspacePath: path.join(root, 'loop'),
    nextActionImpact: 'local_test',
  });
  const loop1 = workTasks.timeoutWorkTask({ id: loopTask.id, actor: 'chatgpt', nextStep: 'テスト継続', nextActionImpact: 'local_test', progressSignature: 'phase-1' });
  const loop2 = workTasks.timeoutWorkTask({ id: loopTask.id, actor: 'chatgpt', nextStep: 'テスト継続', nextActionImpact: 'local_test', progressSignature: 'phase-2' });
  const loop3 = workTasks.timeoutWorkTask({ id: loopTask.id, actor: 'chatgpt', nextStep: 'テスト継続', nextActionImpact: 'local_test', progressSignature: 'phase-3' });
  assert.equal(loop1.work.state, 'working');
  assert.equal(loop2.work.state, 'working');
  assert.equal(loop3.work.state, 'paused_timeout');
  assert.match(loop3.work.stateReason, /連続timeout/);
  workTasks.completeWorkTask({ id: loopTask.id, actor: 'chatgpt', summary: 'loop guard verified' });

  const abruptCutoffTask = workTasks.startWorkTask({
    title: 'Abrupt host cutoff fixture',
    actor: 'chatgpt',
    actorLabel: 'ChatGPT',
    workspaceRoot: path.join(root, 'abrupt-cutoff'),
  });
  workTasks.checkpointWorkTask({
    id: abruptCutoffTask.id,
    actor: 'chatgpt',
    lastCompletedStep: '調査完了',
    nextStep: '実装を継続',
    workspacePath: path.join(root, 'abrupt-cutoff'),
    nextActionImpact: 'local_write',
    progressMade: true,
  });
  assert.equal(workTasks.listResumableWorkTasks({ limit: 20 }).some((entry) => entry.id === abruptCutoffTask.id), true);
  const abruptResumed = workTasks.resumeWorkTask({
    id: abruptCutoffTask.id,
    actor: 'chatgpt',
  });
  assert.equal(abruptResumed.work.state, 'working');
  assert.equal(abruptResumed.work.resumeContext.autoResumeStatus, 'resuming');
  assert.equal(abruptResumed.work.resumeContext.autoResumeCount, 1);
  assert.match(abruptResumed.work.stateReason, /自動継続/);
  workTasks.completeWorkTask({ id: abruptCutoffTask.id, actor: 'chatgpt', summary: 'abrupt cutoff resume verified' });

  const commandTimeoutTask = workTasks.startWorkTask({
    title: 'Command timeout fixture',
    actor: 'chatgpt',
    actorLabel: 'ChatGPT',
    workspaceRoot: path.join(root, 'command-timeout'),
  });
  workTasks.checkpointWorkTask({
    id: commandTimeoutTask.id,
    actor: 'chatgpt',
    nextStep: 'commandの原因確認',
    workspacePath: path.join(root, 'command-timeout'),
    nextActionImpact: 'local_validation',
  });
  const commandTimeout = workTasks.timeoutWorkTask({
    id: commandTimeoutTask.id,
    actor: 'chatgpt',
    timeoutKind: 'command',
    elapsedMs: 300000,
    nextStep: 'commandの原因確認',
    nextActionImpact: 'local_validation',
    autoResume: false,
  });
  assert.equal(commandTimeout.work.state, 'paused_timeout');
  assert.equal(commandTimeout.work.resumeContext.timeoutKind, 'command');
  assert.match(commandTimeout.work.stateReason, /^command timeout/);
  workTasks.completeWorkTask({ id: commandTimeoutTask.id, actor: 'chatgpt', summary: 'command timeout分類 verified' });

  const holder = workTasks.startWorkTask({
    title: 'Workspace holder',
    actor: 'chatgpt',
    actorLabel: 'ChatGPT',
    workspaceRoot: path.join(root, 'shared'),
  });
  const conflict = workTasks.startWorkTask({
    title: 'Workspace conflict',
    actor: 'chatgpt',
    actorLabel: 'ChatGPT',
    workspaceRoot: path.join(root, 'shared'),
  });
  const conflictTimeout = workTasks.timeoutWorkTask({
    id: conflict.id,
    actor: 'chatgpt',
    nextStep: 'ソース編集継続',
    nextActionImpact: 'local_write',
    workspacePath: path.join(root, 'shared'),
  });
  assert.equal(conflictTimeout.work.state, 'paused_timeout');
  assert.equal(conflictTimeout.work.resumeContext.workspaceConflict, true);
  assert.match(conflictTimeout.work.stateReason, /競合/);
  workTasks.completeWorkTask({ id: holder.id, actor: 'chatgpt', summary: 'holder done' });
  workTasks.completeWorkTask({ id: conflict.id, actor: 'chatgpt', summary: 'conflict verified' });

  const completed = workTasks.completeWorkTask({
    id: started.id,
    actor: 'chatgpt',
    actorLabel: 'ChatGPT',
    model: 'GPT-5.6 Sol',
    summary: 'Task正本で完了',
    changedFiles: ['a.js'],
    tests: ['ok'],
  });
  assert.equal(completed.status, 'succeeded');
  assert.equal(completed.summary, 'Task正本で完了');
  assert.deepEqual(completed.work.changedFiles, ['a.js']);
  assert.equal(workTasks.listWorkTasks({ mode: 'active' }).length, 0);
  assert.equal(workTasks.listWorkTasks({ mode: 'recent' }).length, 6);

  const notification = path.join(activityRoot, 'notifications', `${started.id}.json`);
  assert.equal(fs.existsSync(notification), true);
  const payload = JSON.parse(fs.readFileSync(notification, 'utf8'));
  assert.equal(payload.taskId, started.id);
  assert.equal(payload.task.status, 'completed');
  assert.equal(payload.task.summary, 'Task正本で完了');

  const goalTask = workTasks.startWorkTask({
    title: 'Goal Contract fixture',
    request: 'Goal completion gateを検証',
    actor: 'chatgpt',
    actorLabel: 'ChatGPT',
    workspaceRoot: path.join(root, 'goal-contract'),
    goalOutcome: '検証済みの状態で完了する',
    goalCriteria: ['対象機能が実装済み'],
    goalVerification: ['ローカルテストが成功'],
    goalConstraints: ['外部送信しない'],
    goalEnforce: true,
  });
  assert.equal(goalTask.work.goal.status, 'active');
  assert.equal(goalTask.work.goal.enforceCompletion, true);
  assert.throws(() => workTasks.completeWorkTask({
    id: goalTask.id,
    actor: 'chatgpt',
    summary: 'premature completion',
  }), /Goal Contract is not satisfied/);
  assert.throws(() => workTasks.judgeGoalWorkTask({
    id: goalTask.id,
    actor: 'chatgpt',
    goalResult: 'satisfied',
    summary: 'evidence missing',
  }), /verification evidence is required/);
  const judgedGoal = workTasks.judgeGoalWorkTask({
    id: goalTask.id,
    actor: 'chatgpt',
    goalResult: 'satisfied',
    summary: 'criteria verified',
    evidence: ['work-task-store-test passed'],
  });
  assert.equal(judgedGoal.work.goal.status, 'satisfied');
  assert.equal(judgedGoal.work.goal.lastJudgement.result, 'satisfied');
  const goalCompleted = workTasks.completeWorkTask({
    id: goalTask.id,
    actor: 'chatgpt',
    summary: 'Goal Contract verified',
  });
  assert.equal(goalCompleted.status, 'succeeded');

  const lifecycleTask = workTasks.startWorkTask({
    title: 'Worker lifecycle fixture',
    actor: 'codex',
    actorLabel: 'Codex',
    model: 'Luna',
    workspaceRoot: path.join(root, 'worker-lifecycle'),
  });
  let lifecycleWorker = lifecycleTask.work.workers[0];
  const crash1At = new Date(Date.parse(lifecycleWorker.lastHeartbeatAt) + 31 * 60 * 1000).toISOString();
  const crash1 = workTasks.reconcileWorkTask({ id: lifecycleTask.id, at: crash1At });
  assert.equal(crash1.changed, true);
  lifecycleWorker = crash1.task.work.workers[0];
  assert.equal(lifecycleWorker.health, 'crashed');
  assert.equal(lifecycleWorker.consecutiveFailures, 1);
  assert.equal(crash1.task.work.state, 'blocked');

  const recovery1At = new Date(Date.parse(crash1At) + 1000).toISOString();
  const recovery1 = workTasks.recoverWorkerWorkTask({
    id: lifecycleTask.id,
    actor: 'codex',
    actorLabel: 'Codex',
    model: 'Luna',
    at: recovery1At,
  });
  lifecycleWorker = recovery1.work.workers[0];
  assert.equal(lifecycleWorker.attempt, 2);
  assert.equal(lifecycleWorker.status, 'running');
  assert.equal(lifecycleWorker.consecutiveFailures, 1);

  const crash2At = new Date(Date.parse(recovery1At) + 31 * 60 * 1000).toISOString();
  const crash2 = workTasks.reconcileWorkTask({ id: lifecycleTask.id, at: crash2At });
  assert.equal(crash2.task.work.workers[0].consecutiveFailures, 2);
  const recovery2At = new Date(Date.parse(crash2At) + 1000).toISOString();
  const recovery2 = workTasks.recoverWorkerWorkTask({
    id: lifecycleTask.id,
    actor: 'codex',
    actorLabel: 'Codex',
    model: 'Luna',
    at: recovery2At,
  });
  assert.equal(recovery2.work.workers[0].attempt, 3);

  const crash3At = new Date(Date.parse(recovery2At) + 31 * 60 * 1000).toISOString();
  const crash3 = workTasks.reconcileWorkTask({ id: lifecycleTask.id, at: crash3At });
  lifecycleWorker = crash3.task.work.workers[0];
  assert.equal(lifecycleWorker.health, 'circuit_open');
  assert.equal(lifecycleWorker.consecutiveFailures, 3);
  assert.ok(lifecycleWorker.circuitOpenUntil);
  assert.throws(() => workTasks.recoverWorkerWorkTask({
    id: lifecycleTask.id,
    actor: 'codex',
    actorLabel: 'Codex',
    model: 'Luna',
    at: new Date(Date.parse(crash3At) + 1000).toISOString(),
  }), /circuit breaker is open/);
  const forcedRecovery = workTasks.recoverWorkerWorkTask({
    id: lifecycleTask.id,
    actor: 'codex',
    actorLabel: 'Codex',
    model: 'Luna',
    force: true,
    at: new Date(Date.parse(crash3At) + 2000).toISOString(),
  });
  assert.equal(forcedRecovery.work.workers[0].attempt, 4);
  assert.equal(forcedRecovery.work.workers[0].circuitOpenUntil, null);
  workTasks.completeWorkTask({ id: lifecycleTask.id, actor: 'chatgpt', summary: 'worker lifecycle verified' });

  const migratedTerminal = workTasks.importActivityAsWorkTask({
    id: 'act_terminal_fixture',
    title: 'Migrated terminal task',
    status: 'completed',
    phase: '完了',
    currentWork: null,
    state: 'working',
    stateReason: 'legacy stale state',
    startedAt: new Date(Date.now() - 1000).toISOString(),
    completedAt: new Date().toISOString(),
  });
  assert.equal(migratedTerminal.status, 'succeeded');
  assert.equal(migratedTerminal.work.state, null);
  assert.equal(migratedTerminal.work.stateReason, null);

  console.log('work task store tests passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
