const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenttools-host-request-'));
process.env.AGENTTOOLS_STATE_ROOT = path.join(root, 'state');
process.env.AGENTTOOLS_ACTIVITY_ROOT = path.join(root, 'activity');

const workTasks = require('../src/core/workTaskStore');
const hostRequests = require('../src/core/hostRequestStore');

try {
  const task = workTasks.startWorkTask({
    title: 'Detailed inspection fixture',
    request: 'Verify detailed inspection queue',
    actor: 'chatgpt',
    actorLabel: 'ChatGPT',
    model: 'GPT-5.6 Sol',
    project: 'fixture',
    workspaceRoot: root,
    phase: '検証',
    message: 'Host Request Queueを検証中',
  });

  const first = hostRequests.enqueueDetailedTaskInspection({ taskId: task.id });
  assert.equal(first.duplicate, false);
  assert.equal(first.request.status, 'pending');
  assert.equal(first.request.type, hostRequests.TYPE_DETAILED_INSPECTION);
  assert.match(first.request.instruction, /1500文字以上/);
  assert.ok(fs.existsSync(path.dirname(first.request.report.path)));

  const duplicate = hostRequests.enqueueDetailedTaskInspection({ taskId: task.id });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.request.requestId, first.request.requestId);

  const claimed = hostRequests.claimHostRequest({});
  assert.equal(claimed.requestId, first.request.requestId);
  assert.equal(claimed.status, 'processing');
  assert.equal(hostRequests.listHostRequests({ status: 'pending' }).length, 0);
  assert.equal(hostRequests.listHostRequests({ status: 'processing' }).length, 1);

  fs.writeFileSync(claimed.report.path, '# 結論\n短いレポート\n', 'utf8');
  assert.throws(() => hostRequests.completeHostRequest({ id: claimed.requestId }), /too short/);

  const report = [
    '# 結論 / Executive Summary',
    '対象Taskは詳細確認の検証用Taskであり、Queueの状態遷移とレポート品質検査を確認する。'.repeat(6),
    '## 対象Taskと依頼の概要',
    'Taskの目的、依頼内容、現在のphaseを確認した。'.repeat(6),
    '## 現在のTask状態',
    'Work Task記録とworker状態を確認した。'.repeat(6),
    '## DevSpace / Workspace',
    'Workspace rootと再利用対象を確認した。'.repeat(6),
    '## Git状態',
    'Git状態はfixtureのため実Project差分を持たない。'.repeat(6),
    '## 問題点・ブロッカー',
    'このfixtureでは実運用上のブロッカーはない。'.repeat(6),
    '## 未完了項目と次の作業',
    'Queue完了後にControl Center表示を確認する。'.repeat(6),
    '## ユーザー判断が必要な事項',
    'fixtureでは追加判断は不要。'.repeat(6),
    '## 調査根拠',
    'Host Request JSON、Work Task記録、生成レポートを根拠とした。'.repeat(6),
  ].join('\n\n');
  fs.writeFileSync(claimed.report.path, `${report}\n`, 'utf8');
  const completed = hostRequests.completeHostRequest({ id: claimed.requestId });
  assert.equal(completed.status, 'completed');
  assert.ok(completed.report.charCount >= hostRequests.MIN_REPORT_CHARS);
  assert.ok(completed.report.headingCount >= hostRequests.MIN_REPORT_HEADINGS);

  const detailed = hostRequests.getHostRequest({ id: claimed.requestId, includeReport: true });
  assert.equal(detailed.status, 'completed');
  assert.match(detailed.reportContent, /Executive Summary/);
  assert.equal(hostRequests.listHostRequests({ status: 'completed' }).length, 1);

  const continueTask = workTasks.startWorkTask({
    title: 'Continuation fixture',
    request: 'Continue implementation through ChatGPT host queue',
    actor: 'chatgpt',
    actorLabel: 'ChatGPT',
    model: 'GPT-5.6 Sol',
    project: 'fixture',
    workspaceRoot: root,
    phase: '停止',
    message: 'Host Request経由の続行待ち',
  });
  const continueRequest = hostRequests.enqueueTaskContinuation({ taskId: continueTask.id });
  assert.equal(continueRequest.duplicate, false);
  assert.equal(continueRequest.request.type, hostRequests.TYPE_TASK_CONTINUE);
  assert.equal(continueRequest.request.report.minChars, hostRequests.MIN_CONTINUE_REPORT_CHARS);
  assert.match(continueRequest.request.instruction, /状況確認だけで終了せず/);
  assert.match(continueRequest.request.instruction, /Codex workerやAstraを自動起動しない/);
  assert.match(continueRequest.request.instruction, /git commit\/push/);

  const continueDuplicate = hostRequests.enqueueTaskContinuation({ taskId: continueTask.id });
  assert.equal(continueDuplicate.duplicate, true);
  assert.equal(continueDuplicate.request.requestId, continueRequest.request.requestId);

  const continueClaimed = hostRequests.claimHostRequest({ id: continueRequest.request.requestId });
  const continueReport = [
    '# 結論 / Executive Summary',
    '対象Taskの既存状態を確認し、安全なローカル作業の範囲で未完了実装を続行した。'.repeat(6),
    '## 続行前に確認した状態',
    'Work Task、Workspace、Git差分、直近成果を確認した。'.repeat(6),
    '## 今回実施した作業',
    'fixtureではHost Requestの状態遷移と続行レポート品質検査を実施した。'.repeat(6),
    '## 変更ファイル・成果物',
    'fixture用レポートのみを生成し、外部影響のある操作は実施していない。'.repeat(6),
    '## テスト・検証結果',
    '続行Requestのclaim、duplicate抑止、report検査を確認した。'.repeat(6),
    '## 現在のTask状態',
    'fixture上は検証完了として扱える状態である。'.repeat(6),
    '## 残作業・ブロッカー・ユーザー判断事項',
    'fixtureでは追加の判断事項はない。'.repeat(6),
  ].join('\n\n');
  fs.writeFileSync(continueClaimed.report.path, `${continueReport}\n`, 'utf8');
  const continueCompleted = hostRequests.completeHostRequest({ id: continueClaimed.requestId });
  assert.equal(continueCompleted.status, 'completed');
  assert.ok(continueCompleted.report.charCount >= hostRequests.MIN_CONTINUE_REPORT_CHARS);
  assert.ok(continueCompleted.report.headingCount >= hostRequests.MIN_CONTINUE_REPORT_HEADINGS);

  const secondTask = workTasks.startWorkTask({
    title: 'Failure fixture',
    actor: 'chatgpt',
    actorLabel: 'ChatGPT',
    workspaceRoot: root,
    message: 'failure path',
  });
  const second = hostRequests.enqueueDetailedTaskInspection({ taskId: secondTask.id });
  hostRequests.claimHostRequest({ id: second.request.requestId });
  const failed = hostRequests.failHostRequest({ id: second.request.requestId, error: 'fixture failure' });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.failure, 'fixture failure');

  console.log('host-request-store-test: ok');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
