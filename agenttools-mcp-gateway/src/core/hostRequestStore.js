const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { projectRoot } = require('./config');
const { getWorkTask } = require('./workTaskStore');

const STATE_ROOT = path.resolve(process.env.AGENTTOOLS_STATE_ROOT || path.join(projectRoot, 'state'));
const ROOT = path.join(STATE_ROOT, 'host-requests');
const STATUS_DIRS = Object.freeze({
  pending: path.join(ROOT, 'pending'),
  processing: path.join(ROOT, 'processing'),
  completed: path.join(ROOT, 'completed'),
  failed: path.join(ROOT, 'failed'),
});
const REPORTS_DIR = path.join(ROOT, 'reports');
const REQUEST_ID_PATTERN = /^hostreq_[0-9TZ-]+_[a-f0-9]{8}$/i;
const TASK_ID_PATTERN = /^task_[A-Za-z0-9_-]+$/;
const TYPE_DETAILED_INSPECTION = 'task_detailed_inspection';
const TYPE_TASK_CONTINUE = 'task_continue';
const MIN_REPORT_CHARS = 1500;
const MIN_REPORT_HEADINGS = 5;
const MIN_CONTINUE_REPORT_CHARS = 800;
const MIN_CONTINUE_REPORT_HEADINGS = 5;

function ensureDirectories() {
  fs.mkdirSync(ROOT, { recursive: true });
  for (const directory of Object.values(STATUS_DIRS)) fs.mkdirSync(directory, { recursive: true });
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
}

function nowIso() {
  return new Date().toISOString();
}

function createRequestId() {
  return `hostreq_${nowIso().replace(/[:.]/g, '-').replace(/Z$/, 'Z')}_${crypto.randomBytes(4).toString('hex')}`;
}

function assertTaskId(taskId) {
  const value = String(taskId || '').trim();
  if (!TASK_ID_PATTERN.test(value)) throw new Error('Valid taskId is required.');
  return value;
}

function assertRequestId(requestId) {
  const value = String(requestId || '').trim();
  if (!REQUEST_ID_PATTERN.test(value)) throw new Error('Valid host request id is required.');
  return value;
}

function requestFile(directory, requestId) {
  return path.join(directory, `${assertRequestId(requestId)}.json`);
}

function atomicWriteJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.renameSync(temporary, filePath);
  } finally {
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function sanitizeFilePart(value) {
  return String(value || '').replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 120) || 'unknown';
}

function buildReportRelativePath(taskId, requestId, createdAt) {
  const date = String(createdAt).slice(0, 10);
  return path.join('reports', sanitizeFilePart(taskId), `${date}_${sanitizeFilePart(requestId)}.md`).replace(/\\/g, '/');
}

function reportAbsolutePath(relativePath) {
  const normalized = String(relativePath || '').replace(/\\/g, '/');
  if (!normalized.startsWith('reports/') || normalized.includes('..')) throw new Error('Invalid report path.');
  const full = path.resolve(ROOT, normalized);
  const rootResolved = path.resolve(REPORTS_DIR);
  if (full !== rootResolved && !full.startsWith(`${rootResolved}${path.sep}`)) throw new Error('Report path escaped host request root.');
  return full;
}

function buildDetailedInspectionInstruction({ taskId, taskTitle, project, workspaceRoot, reportPath }) {
  return [
    'Control Centerから要求された「状況確認（詳細）」です。',
    `対象Work Task: ${taskId}${taskTitle ? ` / ${taskTitle}` : ''}`,
    project ? `Project: ${project}` : null,
    workspaceRoot ? `Workspace root: ${workspaceRoot}` : null,
    '',
    'DevSpaceを使って対象Taskの現在の実行状況をread-onlyで詳細調査してください。対象Projectの実装や修正は行わず、調査と報告書作成だけを行います。',
    'Task記録だけを言い換えるのではなく、利用可能な範囲でWork Task履歴、DevSpace Workspace、Git状態と差分概要、関連プロセス/Unity等の実行状態、直近の成果物・ログ・検証結果を突き合わせてください。',
    '',
    'Control Center向けの日本語Markdownレポートを作成してください。短い回答ではなく、調査根拠を含む実務レポートが正本です。原則1500文字以上とし、最低でも次の章を含めてください:',
    '1. 結論 / Executive Summary',
    '2. 対象Taskと依頼の概要',
    '3. 現在のTask状態・担当・停止/待機理由',
    '4. 最後に実施された作業と確認できた成果',
    '5. DevSpace / Workspace / 関連プロセスの状態',
    '6. Git状態・未コミット差分・変更範囲',
    '7. 問題点・ブロッカー・不確実な点',
    '8. 未完了項目と次に行うべき作業',
    '9. ユーザー判断が必要な事項',
    '10. 調査根拠・確認した情報',
    '',
    '推測は推測と明記し、secret/token/cookie等の機密情報や不要な個人情報は記載しないでください。情報が少なく1500文字に届かない場合は、確認できなかった項目と理由を明示してください。',
    `レポート保存先: ${reportPath}`,
  ].filter((line) => line !== null).join('\n');
}

function buildTaskContinuationInstruction({ taskId, taskTitle, project, workspaceRoot, reportPath }) {
  return [
    'Control Centerから要求された「作業続行」です。',
    `対象Work Task: ${taskId}${taskTitle ? ` / ${taskTitle}` : ''}`,
    project ? `Project: ${project}` : null,
    workspaceRoot ? `Workspace root: ${workspaceRoot}` : null,
    '',
    'このRequestはChatGPT Host側で処理する通常の続行要求です。Control Centerの別操作「Codexで続行」ではないため、Codex workerやAstraを自動起動しないでください。',
    '対象Work Task IDをそのまま再利用し、別のWork Taskを新規作成しないでください。既存のDevSpace workspaceが再利用可能なら必ず再利用してください。',
    '最初にWork Task記録、既存DevSpace workspace、Git状態と未コミット差分、直近の成果物・ログ・検証結果を確認し、未完了作業を特定してください。その後、状況確認だけで終了せず、安全なローカル作業の範囲で実装・修正・テスト・検証を実際に続行してください。',
    '既存の未コミット変更やユーザー変更を破棄・巻き戻し・上書きしないでください。',
    '',
    '許可範囲は対象Taskを前進させるためのローカルread / write / test / validationです。git commit/push、PR、外部送信、deploy、本番変更、削除・破壊的操作、課金、アカウント・権限変更などは、このRequestだけを根拠に実行しないでください。元のTask/会話に明示許可が確認できない場合は停止してユーザー判断待ちとして報告してください。',
    '作業開始時・状態変化時・完了時は既存Work Taskを適切に更新してください。完了条件を満たした場合はTaskを完了し、ユーザー判断や外部依存が必要なら適切なwaiting/blocked状態として残してください。',
    '',
    'Control Center向けの日本語Markdown実施レポートを作成してください。最低でも次の章を含めてください:',
    '1. 結論 / Executive Summary',
    '2. 続行前に確認した状態',
    '3. 今回実施した作業',
    '4. 変更ファイル・成果物',
    '5. テスト・検証結果',
    '6. 現在のTask状態',
    '7. 残作業・ブロッカー・ユーザー判断事項',
    '',
    '推測は推測と明記し、secret/token/cookie等の機密情報や不要な個人情報は記載しないでください。変更できなかった場合も、停止理由・確認した内容・次に必要な判断を具体的に記載してください。',
    `レポート保存先: ${reportPath}`,
  ].filter((line) => line !== null).join('\n');
}

function readDirectoryRequests(status) {
  ensureDirectories();
  const directory = STATUS_DIRS[status];
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => {
      try { return readJson(path.join(directory, entry.name)); }
      catch { return null; }
    })
    .filter(Boolean);
}

function findRequest(requestId) {
  ensureDirectories();
  const id = assertRequestId(requestId);
  for (const [status, directory] of Object.entries(STATUS_DIRS)) {
    const filePath = requestFile(directory, id);
    if (fs.existsSync(filePath)) return { status, filePath, request: readJson(filePath) };
  }
  return null;
}

function listHostRequests({ limit = 50, status = 'all', includeReport = false } = {}) {
  ensureDirectories();
  const statuses = status === 'all' ? Object.keys(STATUS_DIRS) : [String(status)];
  for (const item of statuses) {
    if (!STATUS_DIRS[item]) throw new Error(`Unsupported host request status: ${item}`);
  }
  const boundedLimit = Math.max(1, Math.min(200, Number(limit) || 50));
  const requests = statuses.flatMap((item) => readDirectoryRequests(item))
    .sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)))
    .slice(0, boundedLimit)
    .map((request) => {
      const result = { ...request };
      if (includeReport && request.report?.relativePath && request.status === 'completed') {
        try { result.reportContent = fs.readFileSync(reportAbsolutePath(request.report.relativePath), 'utf8'); }
        catch { result.reportContent = null; }
      }
      return result;
    });
  return requests;
}

function enqueueDetailedTaskInspection({ taskId, source = 'control-center', requestedBy = 'Control Center' } = {}) {
  ensureDirectories();
  const id = assertTaskId(taskId);
  const task = getWorkTask(id);
  if (!task) throw new Error(`Work Task not found: ${id}`);

  const existing = [...readDirectoryRequests('pending'), ...readDirectoryRequests('processing')]
    .find((request) => request.type === TYPE_DETAILED_INSPECTION && request.taskId === id);
  if (existing) return { request: existing, duplicate: true };

  const requestId = createRequestId();
  const createdAt = nowIso();
  const relativePath = buildReportRelativePath(id, requestId, createdAt);
  const absoluteReportPath = reportAbsolutePath(relativePath);
  fs.mkdirSync(path.dirname(absoluteReportPath), { recursive: true });

  const request = {
    schema: 'agenttools-host-request/v1',
    requestId,
    type: TYPE_DETAILED_INSPECTION,
    source: String(source || 'control-center'),
    requestedBy: String(requestedBy || 'Control Center'),
    taskId: id,
    taskTitle: task.title || task.summary || id,
    project: task.work?.project || task.metadata?.project || null,
    workspaceRoot: task.work?.workspaceRoot || task.metadata?.workspaceRoot || null,
    status: 'pending',
    createdAt,
    updatedAt: createdAt,
    claimedAt: null,
    completedAt: null,
    failedAt: null,
    failure: null,
    report: {
      format: 'markdown',
      relativePath,
      path: absoluteReportPath,
      minChars: MIN_REPORT_CHARS,
      minHeadings: MIN_REPORT_HEADINGS,
      charCount: null,
      headingCount: null,
    },
  };
  request.instruction = buildDetailedInspectionInstruction({
    taskId: id,
    taskTitle: request.taskTitle,
    project: request.project,
    workspaceRoot: request.workspaceRoot,
    reportPath: absoluteReportPath,
  });
  atomicWriteJson(requestFile(STATUS_DIRS.pending, requestId), request);
  return { request, duplicate: false };
}

function enqueueTaskContinuation({ taskId, source = 'control-center', requestedBy = 'Control Center' } = {}) {
  ensureDirectories();
  const id = assertTaskId(taskId);
  const task = getWorkTask(id);
  if (!task) throw new Error(`Work Task not found: ${id}`);

  const existing = [...readDirectoryRequests('pending'), ...readDirectoryRequests('processing')]
    .find((request) => request.type === TYPE_TASK_CONTINUE && request.taskId === id);
  if (existing) return { request: existing, duplicate: true };

  const requestId = createRequestId();
  const createdAt = nowIso();
  const relativePath = buildReportRelativePath(id, requestId, createdAt);
  const absoluteReportPath = reportAbsolutePath(relativePath);
  fs.mkdirSync(path.dirname(absoluteReportPath), { recursive: true });

  const request = {
    schema: 'agenttools-host-request/v1',
    requestId,
    type: TYPE_TASK_CONTINUE,
    source: String(source || 'control-center'),
    requestedBy: String(requestedBy || 'Control Center'),
    taskId: id,
    taskTitle: task.title || task.summary || id,
    project: task.work?.project || task.metadata?.project || null,
    workspaceRoot: task.work?.workspaceRoot || task.metadata?.workspaceRoot || null,
    status: 'pending',
    createdAt,
    updatedAt: createdAt,
    claimedAt: null,
    completedAt: null,
    failedAt: null,
    failure: null,
    report: {
      format: 'markdown',
      relativePath,
      path: absoluteReportPath,
      minChars: MIN_CONTINUE_REPORT_CHARS,
      minHeadings: MIN_CONTINUE_REPORT_HEADINGS,
      charCount: null,
      headingCount: null,
    },
  };
  request.instruction = buildTaskContinuationInstruction({
    taskId: id,
    taskTitle: request.taskTitle,
    project: request.project,
    workspaceRoot: request.workspaceRoot,
    reportPath: absoluteReportPath,
  });
  atomicWriteJson(requestFile(STATUS_DIRS.pending, requestId), request);
  return { request, duplicate: false };
}

function claimHostRequest({ id = null } = {}) {
  ensureDirectories();
  let requestId = id ? assertRequestId(id) : null;
  if (!requestId) {
    const pending = readDirectoryRequests('pending')
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    if (pending.length === 0) return null;
    requestId = pending[0].requestId;
  }

  const source = requestFile(STATUS_DIRS.pending, requestId);
  if (!fs.existsSync(source)) {
    const existing = findRequest(requestId);
    if (existing?.status === 'processing') return existing.request;
    throw new Error(`Pending host request not found: ${requestId}`);
  }
  const destination = requestFile(STATUS_DIRS.processing, requestId);
  fs.renameSync(source, destination);
  const request = readJson(destination);
  request.status = 'processing';
  request.claimedAt = request.claimedAt || nowIso();
  request.updatedAt = nowIso();
  atomicWriteJson(destination, request);
  return request;
}

function inspectMarkdownReport(content) {
  const text = String(content || '').trim();
  const lines = text.split(/\r?\n/);
  const headings = lines.filter((line) => /^#{1,6}\s+\S/.test(line.trim())).length;
  const summary = lines
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith('#') && !line.startsWith('-') && !/^\d+[.)]\s/.test(line));
  return {
    charCount: text.length,
    headingCount: headings,
    summary: summary ? summary.slice(0, 500) : null,
  };
}

function completeHostRequest({ id } = {}) {
  ensureDirectories();
  const requestId = assertRequestId(id);
  const source = requestFile(STATUS_DIRS.processing, requestId);
  if (!fs.existsSync(source)) throw new Error(`Processing host request not found: ${requestId}`);
  const request = readJson(source);
  if (!request.report?.relativePath) throw new Error('Host request does not define a report path.');
  const reportPath = reportAbsolutePath(request.report.relativePath);
  if (!fs.existsSync(reportPath)) throw new Error(`Detailed report has not been created: ${reportPath}`);
  const content = fs.readFileSync(reportPath, 'utf8');
  const quality = inspectMarkdownReport(content);
  const minChars = Number(request.report.minChars || MIN_REPORT_CHARS);
  const minHeadings = Number(request.report.minHeadings || MIN_REPORT_HEADINGS);
  if (quality.charCount < minChars || quality.headingCount < minHeadings) {
    throw new Error(`Detailed report is too short or insufficiently structured (${quality.charCount} chars, ${quality.headingCount} headings; minimum ${minChars} chars and ${minHeadings} headings).`);
  }

  request.status = 'completed';
  request.completedAt = nowIso();
  request.updatedAt = request.completedAt;
  request.report.charCount = quality.charCount;
  request.report.headingCount = quality.headingCount;
  request.resultSummary = quality.summary;
  const destination = requestFile(STATUS_DIRS.completed, requestId);
  atomicWriteJson(source, request);
  fs.renameSync(source, destination);
  return request;
}

function failHostRequest({ id, error = 'Host request failed.' } = {}) {
  ensureDirectories();
  const requestId = assertRequestId(id);
  const source = requestFile(STATUS_DIRS.processing, requestId);
  if (!fs.existsSync(source)) throw new Error(`Processing host request not found: ${requestId}`);
  const request = readJson(source);
  request.status = 'failed';
  request.failedAt = nowIso();
  request.updatedAt = request.failedAt;
  request.failure = String(error || 'Host request failed.').slice(0, 2000);
  const destination = requestFile(STATUS_DIRS.failed, requestId);
  atomicWriteJson(source, request);
  fs.renameSync(source, destination);
  return request;
}

function getHostRequest({ id, includeReport = true } = {}) {
  const found = findRequest(id);
  if (!found) return null;
  const result = { ...found.request };
  if (includeReport && result.report?.relativePath && result.status === 'completed') {
    try { result.reportContent = fs.readFileSync(reportAbsolutePath(result.report.relativePath), 'utf8'); }
    catch { result.reportContent = null; }
  }
  return result;
}

module.exports = {
  ROOT,
  STATUS_DIRS,
  REPORTS_DIR,
  TYPE_DETAILED_INSPECTION,
  TYPE_TASK_CONTINUE,
  MIN_REPORT_CHARS,
  MIN_REPORT_HEADINGS,
  MIN_CONTINUE_REPORT_CHARS,
  MIN_CONTINUE_REPORT_HEADINGS,
  ensureDirectories,
  listHostRequests,
  enqueueDetailedTaskInspection,
  enqueueTaskContinuation,
  claimHostRequest,
  completeHostRequest,
  failHostRequest,
  getHostRequest,
  inspectMarkdownReport,
};
