const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', 'state', `history-search-test-${process.pid}`);
fs.rmSync(root, { recursive: true, force: true });
process.env.AGENTTOOLS_STATE_ROOT = root;
process.env.AGENTTOOLS_ACTIVITY_ROOT = path.join(root, 'activity');

const workTasks = require('../src/core/workTaskStore');
const history = require('../src/core/historySearch');

try {
  const task = workTasks.startWorkTask({
    title: '透明な水面エフェクト検証',
    request: 'プールのような透明な水面を確認する',
    actor: 'chatgpt',
    actorLabel: 'ChatGPT',
    project: 'VR Avatar Studio',
    workspaceRoot: path.resolve(__dirname, '..'),
    phase: '調査',
    message: '水面の透明度と反射を検証中',
  });
  workTasks.updateWorkTask({
    id: task.id,
    actor: 'chatgpt',
    phase: '検証',
    message: 'Water Materialの反射を確認',
    progressMade: true,
    progressSignature: 'water-reflection-verified',
  });

  const synced = history.syncHistoryIndex();
  assert.equal(synced.ok, true);
  assert.ok(synced.documents >= 1);

  const shortJapanese = history.searchHistory({ query: '水面', kind: 'work_task', sync: false });
  assert.equal(shortJapanese.ok, true);
  assert.equal(shortJapanese.results[0]?.id, task.id);

  const trigramJapanese = history.searchHistory({ query: '透明な水', kind: 'task', sync: false });
  assert.equal(trigramJapanese.results[0]?.id, task.id);

  const english = history.searchHistory({ query: 'Water Material', kinds: ['work_task'], sync: false });
  assert.equal(english.results[0]?.id, task.id);

  const noKind = history.searchHistory({ query: '反射', sync: false });
  assert.equal(noKind.results.some((entry) => entry.id === task.id), true);

  const status = history.historyStatus();
  assert.equal(status.exists, true);
  assert.ok(status.counts.work_task >= 1);
  console.log('history search tests passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
