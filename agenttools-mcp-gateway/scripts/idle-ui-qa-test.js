#!/usr/bin/env node
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const qa = require('../src/core/idleUiQa');

function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `git ${args.join(' ')} failed`);
}

(async () => {
  const token = `${process.pid}-${Date.now()}`;
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'agenttools-idle-ui-qa-'));
  const stateRoot = `state/idle-ui-qa/test-${token}`;
  const cfg = {
    enabled: true,
    projectRoot: project,
    idleMinutes: 30,
    checkIntervalMinutes: 10,
    maxImages: 12,
    maxKnownIssuesInPrompt: 100,
    worker: { provider: 'codex', model: 'gpt-5.6-luna', usageThresholdPercent: 90 },
    screenshotDirectories: ['Screenshots'],
    stateFile: `${stateRoot}/state.json`,
    issuesFile: `${stateRoot}/issues.json`,
    reportDirectory: `${stateRoot}/reports`,
  };
  const internalRoot = path.resolve(__dirname, '..', stateRoot);
  try {
    fs.mkdirSync(path.join(project, 'Screenshots'), { recursive: true });
    fs.writeFileSync(path.join(project, 'app.txt'), 'v1\n', 'utf8');
    fs.writeFileSync(path.join(project, 'Screenshots', 'settings.png'), Buffer.from('fake-png'));
    git(project, ['init']);
    git(project, ['config', 'user.email', 'qa@example.invalid']);
    git(project, ['config', 'user.name', 'Idle QA Test']);
    git(project, ['add', '.']);
    git(project, ['commit', '-m', 'initial']);

    const t0 = Date.parse('2026-09-04T00:00:00.000Z');
    const first = await qa.runOnce({ config: cfg, nowMs: t0, runAgent: async () => { throw new Error('must not run'); } });
    assert.equal(first.ran, false);
    assert.equal(first.reason, 'project-changed');

    const mockAgent = async () => ({
      agent: { id: 'agt_test', model: 'gpt-5.6-luna' },
      response: {
        summary: '1 issue',
        issues: [{
          key: 'settings-description-text-clipped',
          title: '説明文が切れている',
          severity: 'medium',
          image: 'Screenshots/settings.png',
          description: '説明文の末尾が表示領域外に出ている',
          evidence: '右端で文字が欠けている',
        }],
      },
    });
    const second = await qa.runOnce({ config: cfg, nowMs: t0 + 31 * 60 * 1000, runAgent: mockAgent });
    assert.equal(second.ran, true);
    assert.equal(second.newIssues.length, 1);

    const third = await qa.runOnce({ config: cfg, nowMs: t0 + 32 * 60 * 1000, runAgent: mockAgent });
    assert.equal(third.ran, false);
    assert.equal(third.reason, 'already-checked');

    fs.writeFileSync(path.join(project, 'app.txt'), 'v2\n', 'utf8');
    const changed = await qa.runOnce({ config: cfg, nowMs: t0 + 33 * 60 * 1000, runAgent: mockAgent });
    assert.equal(changed.ran, false);
    assert.equal(changed.reason, 'project-changed');

    const duplicate = await qa.runOnce({ config: cfg, nowMs: t0 + 64 * 60 * 1000, runAgent: mockAgent });
    assert.equal(duplicate.ran, true);
    assert.equal(duplicate.newIssues.length, 0, 'same unresolved issue must not be emitted as new');
    const stored = qa.readIssues(cfg);
    assert.equal(stored.issues.length, 1);
    assert.equal(stored.issues[0].status, 'open');
    assert.equal(stored.issues[0].duplicateObservations, 1);

    const resolved = qa.resolveIssue({ key: 'settings-description-text-clipped', note: 'fixed' }, cfg);
    assert.equal(resolved.issue.status, 'resolved');
    assert.equal(qa.listIssues({ status: 'open' }, cfg).issues.length, 0);

    fs.writeFileSync(path.join(project, 'app.txt'), 'v3\n', 'utf8');
    const changedAgain = await qa.runOnce({ config: cfg, nowMs: t0 + 65 * 60 * 1000, runAgent: mockAgent });
    assert.equal(changedAgain.ran, false);
    assert.equal(changedAgain.reason, 'project-changed');
    const recurrence = await qa.runOnce({ config: cfg, nowMs: t0 + 96 * 60 * 1000, runAgent: mockAgent });
    assert.equal(recurrence.ran, true);
    assert.equal(recurrence.newIssues.length, 1, 'resolved issue should become new work again when it recurs');
    const reopened = qa.readIssues(cfg);
    assert.equal(reopened.issues.length, 1, 'recurrence must reopen the existing record instead of duplicating its key');
    assert.equal(reopened.issues[0].status, 'open');
    assert.equal(reopened.issues[0].reopenCount, 1);
    assert.equal(reopened.issues[0].resolvedAt, null);

    assert.equal(qa.normalizeIssueKey(' Settings / Text Clip '), 'settings-text-clip');
    console.log('idle-ui-qa-test: ok');
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
    fs.rmSync(internalRoot, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
