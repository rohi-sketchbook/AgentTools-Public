const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenttools-task-runner-safety-'));
process.env.AGENTTOOLS_STATE_ROOT = path.join(root, 'state');
process.env.AGENTTOOLS_ACTIVITY_ROOT = path.join(root, 'activity');

const { createTask } = require('../src/core/taskStore');
const { runTask, reconcileExecutionTask } = require('../src/core/taskRunner');

(async () => {
  try {
    const workTask = createTask({
      type: 'work',
      title: 'Work Task execution boundary fixture',
      status: 'planned',
      metadata: {
        command: {
          command: process.execPath,
          args: ['--version'],
        },
      },
      work: {
        schema: 'agenttools-work-task/v1',
        state: 'working',
      },
    });

    const result = await runTask({ taskId: workTask.id });
    assert.equal(result.ok, false);
    assert.match(result.error, /Work Tasks cannot be executed/);

    const orphanDead = createTask({
      type: 'execution-test',
      title: 'Dead orphan execution fixture',
      status: 'running',
      metadata: {
        pid: 2147483647,
        gatewayInstanceId: 'gateway_previous',
      },
    });
    const deadReconciled = reconcileExecutionTask(orphanDead);
    assert.equal(deadReconciled.changed, true);
    assert.equal(deadReconciled.state, 'crashed');
    assert.equal(deadReconciled.task.status, 'failed');
    assert.equal(deadReconciled.task.metadata.orphanProcessAlive, false);
    assert.equal(deadReconciled.task.metadata.crashRecoveryEligible, true);

    const orphanAlive = createTask({
      type: 'execution-test',
      title: 'Live orphan execution fixture',
      status: 'running',
      metadata: {
        pid: process.pid,
        gatewayInstanceId: 'gateway_previous',
      },
    });
    const aliveReconciled = reconcileExecutionTask(orphanAlive);
    assert.equal(aliveReconciled.changed, true);
    assert.equal(aliveReconciled.state, 'orphaned_alive');
    assert.equal(aliveReconciled.task.status, 'blocked');
    assert.equal(aliveReconciled.task.metadata.orphanProcessAlive, true);
    assert.match(aliveReconciled.task.error, /no longer attached/);

    console.log('task runner safety tests passed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
