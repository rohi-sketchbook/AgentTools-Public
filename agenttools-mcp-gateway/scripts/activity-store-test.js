const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenttools-activity-test-'));
process.env.AGENTTOOLS_ACTIVITY_ROOT = path.join(root, 'activity');
process.env.AGENTTOOLS_STATE_ROOT = path.join(root, 'state');
const activity = require('../src/core/activityStore');
const { getWorkTask } = require('../src/core/workTaskStore');

try {
  const started = activity.startActivity({
    title: 'Test task',
    request: 'Verify activity reporting',
    actor: 'chatgpt',
    actorLabel: 'ChatGPT',
    model: 'GPT-5.6 Sol',
    project: 'demo',
    workspaceRoot: root,
    phase: '調査',
    message: '構成確認中',
  });
  assert.match(started.id, /^act_[a-f0-9]{12}$/);
  assert.match(started.taskId, /^task_\d{14}_[a-f0-9]{8}$/);
  assert.equal(started.status, 'running');
  assert.equal(getWorkTask(started.taskId).status, 'running');
  assert.equal(started.workers.length, 1);
  assert.equal(started.workers[0].actor.id, 'chatgpt');
  assert.equal(activity.listActivities({ mode: 'active' }).length, 1);

  const updated = activity.updateActivity({
    id: started.id,
    actor: 'codex',
    actorLabel: 'Codex',
    model: 'Terra',
    phase: '実装',
    message: '単純実装を担当',
    workerStatus: 'running',
    takeOwnership: true,
  });
  assert.equal(updated.owner.id, 'codex');
  assert.equal(updated.contributors.length, 2);
  assert.equal(updated.workers.length, 2);
  assert.equal(updated.workers.find((item) => item.actor.id === 'codex').message, '単純実装を担当');
  assert.match(updated.workLog.at(-1).message, /単純実装/);
  assert.equal(getWorkTask(started.taskId).work.workers.find((item) => item.actor.id === 'codex').message, '単純実装を担当');

  const completed = activity.completeActivity({
    id: started.id,
    actor: 'chatgpt',
    actorLabel: 'ChatGPT',
    model: 'GPT-5.6 Sol',
    summary: 'レビューまで完了',
    changedFiles: ['a.cs', 'b.cs'],
    tests: ['build ok'],
  });
  assert.equal(completed.status, 'completed');
  assert.deepEqual(completed.changedFiles, ['a.cs', 'b.cs']);
  assert.equal(activity.listActivities({ mode: 'active' }).length, 0);
  assert.equal(activity.listActivities({ mode: 'recent' }).length, 1);
  assert.equal(getWorkTask(started.taskId).status, 'succeeded');

  const paths = activity.activityPaths();
  assert.equal(fs.existsSync(path.join(paths.notifications, `${started.taskId}.json`)), true);
  const notification = JSON.parse(fs.readFileSync(path.join(paths.notifications, `${started.taskId}.json`), 'utf8'));
  assert.equal(notification.taskId, started.taskId);
  assert.equal(notification.task.summary, 'レビューまで完了');

  const again = activity.completeActivity({
    id: started.id,
    actor: 'chatgpt',
    actorLabel: 'ChatGPT',
    summary: 'duplicate completion ignored',
  });
  assert.equal(again.summary, 'レビューまで完了');

  console.log('activity store tests passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
