const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenttools-work-continuation-test-'));
process.env.AGENTTOOLS_STATE_ROOT = path.join(root, 'state');
process.env.AGENTTOOLS_ACTIVITY_ROOT = path.join(root, 'activity');

const workTasks = require('../src/core/workTaskStore');
const continuation = require('../src/core/workTaskContinuation');
const workflow = require('../src/core/workflowPolicy');

try {
  workflow.setContinuationMode('codex');
  const started = workTasks.startWorkTask({
    title: 'Auto continuation test',
    request: 'Continue a safe local validation after host execution disappears',
    actor: 'chatgpt',
    actorLabel: 'ChatGPT',
    model: 'GPT-5.6 Sol',
    project: 'demo',
    workspaceRoot: root,
    phase: '実装',
    message: 'ローカル修正中',
  });
  const checkpointed = workTasks.checkpointWorkTask({
    id: started.id,
    actor: 'chatgpt',
    actorLabel: 'ChatGPT',
    model: 'GPT-5.6 Sol',
    lastCompletedStep: '実装完了',
    nextStep: 'ローカルテストを実行してエラーを修正',
    workspacePath: root,
    branch: 'main',
    hasUncommittedChanges: true,
    nextActionImpact: 'local_validation',
    progressSignature: 'implementation-done',
    progressMade: true,
  });
  assert.equal(checkpointed.work.resumeContext.continuation, null);

  const firstHeartbeat = Date.parse(checkpointed.work.workers.find((worker) => worker.actor.id === 'chatgpt').lastHeartbeatAt);
  const calls = [];
  const runtime = continuation.continuationConfig();
  runtime.runAgent = (task, _runtime, args) => {
    calls.push(args);
    if (args[1] === 'run') {
      return {
        id: 'agt_test_auto_continue',
        status: 'running',
        provider: 'codex',
        model: runtime.policy.codexModel,
        providerUsage: { usedPercent: 24, remainingPercent: 76, resetsAt: 1234567890, source: 'codex-app-server' },
      };
    }
    if (args[1] === 'continue') {
      return {
        id: args[2],
        status: 'running',
        provider: 'codex',
        model: runtime.policy.codexModel,
        providerUsage: { usedPercent: 25, remainingPercent: 75, resetsAt: 1234567890, source: 'codex-app-server' },
      };
    }
    if (args[1] === 'handoff') {
      return {
        id: 'agt_test_auto_continue',
        status: 'idle',
        provider: 'codex',
        model: runtime.policy.codexModel,
        providerUsage: { usedPercent: 24, remainingPercent: 76, resetsAt: 1234567890, source: 'codex-app-server' },
        latestResponse: 'ローカルテストを実行し、問題を修正しました。',
        changedFiles: ['src/example.js'],
        commandsRun: ['npm test'],
      };
    }
    throw new Error(`unexpected agent args: ${args.join(' ')}`);
  };

  const launched = continuation.runContinuationSweep({
    nowMs: firstHeartbeat + runtime.policy.codexHandoffAfterMs + 1,
    runtime,
  });
  assert.equal(launched.events.length, 1);
  assert.equal(launched.events[0].action, 'launched');
  assert.equal(launched.events[0].notificationQueued, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'agents');
  assert.equal(calls[0][1], 'run');
  let current = workTasks.getWorkTask(started.id);
  assert.equal(current.work.owner.id, 'codex');
  assert.equal(current.work.resumeContext.autoResumeStatus, 'resuming');
  assert.equal(current.work.resumeContext.autoResumeCount, 1);
  assert.equal(current.work.resumeContext.continuation.status, 'running');
  assert.equal(current.work.resumeContext.continuation.agentId, 'agt_test_auto_continue');
  assert.equal(current.work.resumeContext.continuation.providerUsage.usedPercent, 24);
  const notificationDir = path.join(root, 'activity', 'notifications');
  const startedNotification = `${started.id}--continuation_started--1.json`;
  assert.equal(fs.existsSync(path.join(notificationDir, startedNotification)), true);
  const startedPayload = JSON.parse(fs.readFileSync(path.join(notificationDir, startedNotification), 'utf8'));
  assert.equal(startedPayload.notificationKind, 'continuation_started');
  assert.equal(startedPayload.continuation.model, 'gpt-5.6-terra');
  assert.equal(startedPayload.continuation.sessionReused, false);
  assert.equal(startedPayload.continuation.providerUsage.remainingPercent, 76);
  assert.equal(calls[0].includes('--thinking'), true);
  assert.equal(calls[0][calls[0].indexOf('--thinking') + 1], 'medium');

  const monitored = continuation.runContinuationSweep({
    nowMs: firstHeartbeat + runtime.policy.codexHandoffAfterMs + 60_001,
    runtime,
  });
  assert.equal(monitored.events.length, 1);
  assert.equal(monitored.events[0].action, 'completed');
  assert.equal(monitored.events[0].notificationQueued, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[1][1], 'handoff');
  current = workTasks.getWorkTask(started.id);
  assert.equal(current.status, 'blocked');
  assert.equal(current.work.state, 'waiting_dependency');
  assert.equal(current.work.owner.id, 'chatgpt');
  assert.equal(current.work.resumeContext.continuation.status, 'completed');
  assert.deepEqual(current.work.resumeContext.continuation.changedFiles, ['src/example.js']);
  assert.match(current.work.resumeContext.nextStep, /最終確認/);
  assert.match(current.work.stateReason, /ChatGPTの最終確認待ち/);
  const completedNotification = `${started.id}--continuation_completed--1.json`;
  assert.equal(fs.existsSync(path.join(notificationDir, completedNotification)), true);
  const completedPayload = JSON.parse(fs.readFileSync(path.join(notificationDir, completedNotification), 'utf8'));
  assert.equal(completedPayload.notificationKind, 'continuation_completed');
  assert.match(completedPayload.continuation.summary, /ローカルテスト/);

  const noRepeat = continuation.runContinuationSweep({
    nowMs: firstHeartbeat + runtime.policy.codexHandoffAfterMs + 120_001,
    runtime,
  });
  assert.equal(noRepeat.events.length, 0, 'same checkpoint must not launch Codex twice');

  workTasks.checkpointWorkTask({
    id: started.id,
    actor: 'chatgpt',
    actorLabel: 'ChatGPT',
    model: 'GPT-5.6 Sol',
    lastCompletedStep: 'Codex結果を確認',
    nextStep: '追加のローカル検証を続ける',
    workspacePath: root,
    branch: 'main',
    hasUncommittedChanges: true,
    nextActionImpact: 'local_validation',
    progressSignature: 'second-checkpoint',
    progressMade: true,
  });
  workTasks.timeoutWorkTask({
    id: started.id,
    actor: 'chatgpt',
    actorLabel: 'ChatGPT',
    model: 'GPT-5.6 Sol',
    timeoutKind: 'chatgpt_execution',
    elapsedMs: 1800000,
  });
  const reused = continuation.runContinuationSweep({ nowMs: Date.now(), runtime });
  const reusedEvent = reused.events.find((event) => event.taskId === started.id);
  assert.equal(reusedEvent.action, 'continued');
  assert.equal(reusedEvent.sessionReused, true);
  const continueCall = calls.find((args) => args[1] === 'continue');
  assert.ok(continueCall);
  assert.equal(continueCall[2], 'agt_test_auto_continue');
  current = workTasks.getWorkTask(started.id);
  assert.equal(current.work.resumeContext.continuation.sessionReused, true);
  assert.equal(current.work.resumeContext.continuation.sessionReuseCount, 1);
  const reusedNotification = `${started.id}--continuation_started--2.json`;
  const reusedPayload = JSON.parse(fs.readFileSync(path.join(notificationDir, reusedNotification), 'utf8'));
  assert.equal(reusedPayload.continuation.sessionReused, true);
  const reusedCompleted = continuation.runContinuationSweep({ nowMs: Date.now() + 60_001, runtime });
  assert.equal(reusedCompleted.events.some((event) => event.taskId === started.id && event.action === 'completed'), true);

  const timeoutTask = workTasks.startWorkTask({
    title: 'Explicit timeout continuation',
    request: 'Hand off an explicit ChatGPT execution timeout immediately',
    actor: 'chatgpt',
    actorLabel: 'ChatGPT',
    model: 'GPT-5.6 Sol',
    project: 'demo',
    workspaceRoot: path.join(root, 'timeout-workspace'),
    phase: '実装',
    message: '長時間作業中',
  });
  fs.mkdirSync(path.join(root, 'timeout-workspace'), { recursive: true });
  workTasks.checkpointWorkTask({
    id: timeoutTask.id,
    actor: 'chatgpt',
    actorLabel: 'ChatGPT',
    model: 'GPT-5.6 Sol',
    lastCompletedStep: '途中まで実装',
    nextStep: 'ローカルテストを続ける',
    workspacePath: path.join(root, 'timeout-workspace'),
    nextActionImpact: 'local_test',
    progressSignature: 'timeout-checkpoint',
    progressMade: true,
  });
  const timedOut = workTasks.timeoutWorkTask({
    id: timeoutTask.id,
    actor: 'chatgpt',
    actorLabel: 'ChatGPT',
    model: 'GPT-5.6 Sol',
    timeoutKind: 'chatgpt_execution',
    elapsedMs: 1800000,
  });
  assert.equal(timedOut.work.state, 'paused_timeout');
  assert.equal(timedOut.work.resumeContext.autoResumeStatus, 'pending');
  assert.equal(timedOut.work.resumeContext.autoResumeCount, 0);
  assert.match(timedOut.work.stateReason, /Codex自動引き継ぎ待ち/);

  const explicitRuntime = continuation.continuationConfig();
  explicitRuntime.runAgent = runtime.runAgent;
  const immediate = continuation.runContinuationSweep({ nowMs: Date.now(), runtime: explicitRuntime });
  assert.equal(immediate.events.some((event) => event.taskId === timeoutTask.id && event.action === 'launched'), true);
  const explicitCurrent = workTasks.getWorkTask(timeoutTask.id);
  assert.equal(explicitCurrent.work.resumeContext.autoResumeCount, 1);
  assert.equal(explicitCurrent.work.resumeContext.continuation.status, 'running');

  const failureTask = workTasks.startWorkTask({
    title: 'Continuation launch failure notification',
    request: 'Report an automatic continuation launch failure',
    actor: 'chatgpt',
    actorLabel: 'ChatGPT',
    model: 'GPT-5.6 Sol',
    project: 'demo',
    workspaceRoot: path.join(root, 'failure-workspace'),
    phase: '実装',
    message: 'checkpoint準備',
  });
  fs.mkdirSync(path.join(root, 'failure-workspace'), { recursive: true });
  workTasks.checkpointWorkTask({
    id: failureTask.id,
    actor: 'chatgpt',
    actorLabel: 'ChatGPT',
    model: 'GPT-5.6 Sol',
    lastCompletedStep: '実装途中',
    nextStep: 'ローカル検証を続ける',
    workspacePath: path.join(root, 'failure-workspace'),
    nextActionImpact: 'local_validation',
    progressSignature: 'failure-checkpoint',
    progressMade: true,
  });
  const failureRuntime = continuation.continuationConfig();
  failureRuntime.runAgent = () => { throw new Error('Codex unavailable for test'); };
  const failedLaunch = continuation.launchContinuation(failureTask, failureRuntime, Date.now(), 'test launch failure');
  assert.equal(failedLaunch.action, 'launch-failed');
  const failureNotification = `${failureTask.id}--continuation_failed--1.json`;
  assert.equal(fs.existsSync(path.join(notificationDir, failureNotification)), true);
  const failurePayload = JSON.parse(fs.readFileSync(path.join(notificationDir, failureNotification), 'utf8'));
  assert.equal(failurePayload.notificationKind, 'continuation_failed');
  assert.match(failurePayload.continuation.error, /Codex unavailable/);

  const off = workflow.setContinuationMode('off');
  assert.equal(off.mode, 'off');
  const offRuntime = continuation.continuationConfig();
  offRuntime.runAgent = runtime.runAgent;
  const disabled = continuation.runContinuationSweep({ nowMs: Date.now() + 10_000_000, runtime: offRuntime });
  assert.equal(disabled.mode, 'off');
  assert.equal(disabled.events.length, 0);

  const chatgpt = workflow.setContinuationMode('chatgpt');
  assert.equal(chatgpt.mode, 'chatgpt');
  const hostRuntime = continuation.continuationConfig();
  hostRuntime.runAgent = runtime.runAgent;
  const hostOnly = continuation.runContinuationSweep({ nowMs: Date.now() + 10_000_000, runtime: hostRuntime });
  assert.equal(hostOnly.mode, 'chatgpt');
  assert.equal(hostOnly.events.length, 0);

  workflow.setContinuationMode('codex');
  console.log('work task continuation tests passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
