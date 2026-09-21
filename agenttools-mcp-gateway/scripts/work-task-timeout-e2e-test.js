const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenttools-work-timeout-e2e-'));
process.env.AGENTTOOLS_STATE_ROOT = path.join(root, 'state');
process.env.AGENTTOOLS_ACTIVITY_ROOT = path.join(root, 'activity');

function reloadWorkTaskStore() {
  for (const modulePath of [
    '../src/core/workTaskStore',
    '../src/core/workTaskResume',
    '../src/core/taskStore',
    '../src/core/stateFile',
  ]) {
    try { delete require.cache[require.resolve(modulePath)]; } catch {}
  }
  return require('../src/core/workTaskStore');
}

(async () => {
  try {
    let workTasks = reloadWorkTaskStore();
    const task = workTasks.startWorkTask({
      title: 'Short timeout auto-resume fixture',
      request: 'Verify timeout -> checkpoint -> automatic resume -> persistence -> completion',
      actor: 'chatgpt',
      actorLabel: 'ChatGPT',
      model: 'GPT-5.6 Sol',
      project: 'fixture',
      workspaceRoot: path.join(root, 'checkout'),
      phase: '実装',
      message: 'テスト用のローカル作業を実行中',
    });

    workTasks.checkpointWorkTask({
      id: task.id,
      actor: 'chatgpt',
      actorLabel: 'ChatGPT',
      model: 'GPT-5.6 Sol',
      phase: '実装',
      lastCompletedStep: 'テスト用実装',
      nextStep: '短時間timeout後のローカル検証',
      workspacePath: path.join(root, 'checkout'),
      branch: 'main',
      hasUncommittedChanges: true,
      nextActionImpact: 'local_validation',
      progressSignature: 'fixture-implementation-complete',
      progressMade: true,
    });
    assert.equal(workTasks.listResumableWorkTasks({ limit: 10 }).some((entry) => entry.id === task.id), true, 'checkpoint alone must be recoverable after an abrupt host cutoff');

    const timeoutMs = 25;
    await new Promise((resolve) => setTimeout(resolve, timeoutMs));

    const timedOut = workTasks.timeoutWorkTask({
      id: task.id,
      actor: 'chatgpt',
      actorLabel: 'ChatGPT',
      model: 'GPT-5.6 Sol',
      timeoutKind: 'gateway_task',
      elapsedMs: timeoutMs,
      nextStep: '短時間timeout後のローカル検証',
      workspacePath: path.join(root, 'checkout'),
      branch: 'main',
      hasUncommittedChanges: true,
      nextActionImpact: 'local_validation',
      progressSignature: 'fixture-implementation-complete',
    });

    assert.equal(timedOut.status, 'running');
    assert.equal(timedOut.work.state, 'working');
    assert.equal(timedOut.work.resumeContext.timeoutKind, 'gateway_task');
    assert.equal(timedOut.work.resumeContext.autoResumeStatus, 'resuming');
    assert.equal(timedOut.work.resumeContext.autoResumeCount, 1);
    assert.equal(timedOut.work.currentWork, '短時間timeout後のローカル検証');
    assert.match(timedOut.work.workLog.at(-3).message, /実行時間上限/);
    assert.match(timedOut.work.workLog.at(-2).message, /チェックポイント保存/);
    assert.match(timedOut.work.workLog.at(-1).message, /自動再開/);

    workTasks = reloadWorkTaskStore();
    const recovered = workTasks.getWorkTask(task.id);
    assert.ok(recovered, 'Task must remain available after store/module reload.');
    assert.equal(recovered.work.resumeContext.nextStep, '短時間timeout後のローカル検証');
    assert.equal(recovered.work.resumeContext.autoResumeStatus, 'resuming');
    assert.equal(workTasks.listResumableWorkTasks({ limit: 10 }).some((entry) => entry.id === task.id), true);

    const completed = workTasks.completeWorkTask({
      id: task.id,
      actor: 'chatgpt',
      actorLabel: 'ChatGPT',
      model: 'GPT-5.6 Sol',
      summary: '短時間timeoutからcheckpoint経由で自動継続し完了',
      tests: ['25ms timeout boundary', 'resumeContext reload persistence'],
    });
    assert.equal(completed.status, 'succeeded');
    assert.equal(completed.work.resumeContext, null);

    console.log('work task timeout e2e tests passed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
