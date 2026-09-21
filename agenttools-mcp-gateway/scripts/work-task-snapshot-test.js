const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const gatewayRoot = path.resolve(__dirname, '..');
const fixtureRoot = path.join(gatewayRoot, 'state', `snapshot-fixture-${process.pid}`);
const stateRoot = path.join(fixtureRoot, 'gateway-state');
fs.rmSync(fixtureRoot, { recursive: true, force: true });
fs.mkdirSync(fixtureRoot, { recursive: true });
process.env.AGENTTOOLS_STATE_ROOT = stateRoot;
process.env.AGENTTOOLS_ACTIVITY_ROOT = path.join(stateRoot, 'activity');

const workTasks = require('../src/core/workTaskStore');
const snapshots = require('../src/core/workTaskSnapshots');

try {
  const source = path.join(fixtureRoot, 'notes.txt');
  fs.writeFileSync(source, 'before\n', 'utf8');
  const task = workTasks.startWorkTask({
    title: 'Snapshot fixture',
    actor: 'chatgpt',
    actorLabel: 'ChatGPT',
    workspaceRoot: fixtureRoot,
  });

  const snapshot = snapshots.createWorkSnapshot({
    taskId: task.id,
    paths: ['notes.txt'],
    label: 'before edit',
  });
  assert.match(snapshot.id, /^snap_\d{14}_[a-f0-9]{8}$/);
  assert.equal(snapshot.files.length, 1);
  assert.equal(snapshot.files[0].relativePath, 'notes.txt');

  fs.writeFileSync(source, 'after\n', 'utf8');
  const preview = snapshots.restorePayload(task.id, snapshot.id);
  assert.equal(preview.files[0].changed, undefined);
  assert.notEqual(preview.files[0].currentHash, preview.files[0].snapshotHash);

  const restored = snapshots.restoreWorkSnapshot({ taskId: task.id, snapshotId: snapshot.id });
  assert.deepEqual(restored.restored, ['notes.txt']);
  assert.equal(fs.readFileSync(source, 'utf8'), 'before\n');
  assert.equal(snapshots.listWorkSnapshots({ taskId: task.id }).length, 1);
  assert.equal(snapshots.readManifest(task.id, snapshot.id).label, 'before edit');

  const denied = path.join(fixtureRoot, '.env');
  fs.writeFileSync(denied, 'API_KEY=secret\n', 'utf8');
  assert.throws(() => snapshots.createWorkSnapshot({ taskId: task.id, paths: ['.env'] }), /denied fragment/);

  const directory = path.join(fixtureRoot, 'folder');
  fs.mkdirSync(directory, { recursive: true });
  assert.throws(() => snapshots.createWorkSnapshot({ taskId: task.id, paths: ['folder'] }), /files only/);

  console.log('work task snapshot tests passed');
} finally {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}
