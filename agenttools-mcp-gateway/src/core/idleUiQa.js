const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { projectRoot, readJson } = require('./config');
const { listWorkTasks } = require('./workTaskStore');
const { resolveCodexRole } = require('./codexModelPolicy');

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);

function nowIso(nowMs = Date.now()) {
  return new Date(nowMs).toISOString();
}

function clampInteger(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function config() {
  const raw = readJson('config/idle-ui-qa.json');
  const workerRole = resolveCodexRole(String(raw.worker?.role || 'idleQa'));
  return {
    enabled: raw.enabled !== false,
    projectRoot: path.resolve(String(raw.projectRoot || projectRoot)),
    idleMinutes: clampInteger(raw.idleMinutes, 30, 5, 24 * 60),
    checkIntervalMinutes: clampInteger(raw.checkIntervalMinutes, 10, 5, 24 * 60),
    maxImages: clampInteger(raw.maxImages, 12, 1, 16),
    maxKnownIssuesInPrompt: clampInteger(raw.maxKnownIssuesInPrompt, 100, 0, 500),
    worker: {
      provider: String(raw.worker?.provider || 'codex'),
      role: workerRole.role,
      model: String(raw.worker?.model || workerRole.model),
      thinking: String(raw.worker?.thinking || workerRole.thinking),
      usageThresholdPercent: clampInteger(raw.worker?.usageThresholdPercent, 90, 1, 100),
    },
    screenshotDirectories: Array.isArray(raw.screenshotDirectories) ? raw.screenshotDirectories.map(String) : [],
    stateFile: String(raw.stateFile || 'state/idle-ui-qa/state.json'),
    issuesFile: String(raw.issuesFile || 'state/idle-ui-qa/issues.json'),
    reportDirectory: String(raw.reportDirectory || 'state/idle-ui-qa/reports'),
  };
}

function internalPath(relativePath) {
  const resolved = path.resolve(projectRoot, relativePath);
  const root = `${path.resolve(projectRoot)}${path.sep}`.toLowerCase();
  if (!`${resolved}${path.sep}`.toLowerCase().startsWith(root)) {
    throw new Error(`Idle UI QA state path must stay under ${projectRoot}`);
  }
  return resolved;
}

function paths(cfg = config()) {
  return {
    state: internalPath(cfg.stateFile),
    issues: internalPath(cfg.issuesFile),
    reports: internalPath(cfg.reportDirectory),
  };
}

function readJsonFile(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, file);
  } finally {
    try { fs.unlinkSync(tmp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function defaultState() {
  return {
    schema: 'agenttools-idle-ui-qa-state/v1',
    observedFingerprint: null,
    lastChangeAt: null,
    lastCheckAt: null,
    lastRunAt: null,
    lastRunFingerprint: null,
    lastRunStatus: 'never',
    lastRunReason: null,
    lastReport: null,
    lastAgentId: null,
    lastImageCount: 0,
    lastNewIssues: 0,
  };
}

function readState(cfg = config()) {
  return { ...defaultState(), ...readJsonFile(paths(cfg).state, {}) };
}

function readIssues(cfg = config()) {
  const store = readJsonFile(paths(cfg).issues, { schema: 'agenttools-idle-ui-qa-issues/v1', issues: [] });
  return {
    schema: 'agenttools-idle-ui-qa-issues/v1',
    issues: Array.isArray(store.issues) ? store.issues : [],
  };
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env || process.env,
    encoding: 'utf8',
    windowsHide: true,
    timeout: options.timeoutMs || 20000,
    maxBuffer: options.maxBuffer || 8 * 1024 * 1024,
  });
  return {
    ok: !result.error && result.status === 0,
    status: result.status,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
    error: result.error?.message || null,
  };
}

function git(commandArgs, cfg = config()) {
  return run('git', commandArgs, { cwd: cfg.projectRoot, timeoutMs: 15000 });
}

function normalizeStatusPath(line) {
  const body = line.slice(3).trim();
  const arrow = body.lastIndexOf(' -> ');
  const value = arrow >= 0 ? body.slice(arrow + 4) : body;
  return value.replace(/^"|"$/g, '').replace(/\\/g, '/');
}

function projectFingerprint(cfg = config()) {
  const head = git(['rev-parse', 'HEAD'], cfg);
  const status = git(['status', '--porcelain=v1', '-z'], cfg);
  if (!head.ok || !status.ok) {
    return { ok: false, fingerprint: null, error: head.error || head.stderr || status.error || status.stderr || 'git status failed' };
  }
  const records = status.stdout.split('\0').filter(Boolean);
  const changed = [];
  for (const record of records) {
    const relative = normalizeStatusPath(record);
    const full = path.resolve(cfg.projectRoot, relative);
    let stat = null;
    try { stat = fs.statSync(full); } catch {}
    changed.push({
      path: relative,
      size: stat?.size ?? null,
      mtimeMs: stat?.mtimeMs ? Math.floor(stat.mtimeMs) : null,
    });
  }
  changed.sort((a, b) => a.path.localeCompare(b.path));
  const payload = JSON.stringify({ head: head.stdout.trim(), changed });
  return {
    ok: true,
    fingerprint: crypto.createHash('sha256').update(payload).digest('hex'),
    head: head.stdout.trim(),
    changed,
    dirty: changed.length > 0,
  };
}

function comparablePath(value) {
  if (!value) return null;
  const resolved = path.resolve(String(value));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function activeDevelopment(cfg = config()) {
  const target = comparablePath(cfg.projectRoot);
  const tasks = listWorkTasks({ mode: 'active', limit: 200 });
  const blocking = tasks.filter((task) => {
    const workspaces = [
      task?.work?.workspaceRoot,
      task?.work?.resumeContext?.workspacePath,
      task?.work?.resumeContext?.worktreePath,
    ].map(comparablePath).filter(Boolean);
    if (!workspaces.includes(target)) return false;
    return (task?.work?.workers || []).some((worker) => worker?.status === 'running');
  });
  return {
    active: blocking.length > 0,
    tasks: blocking.map((task) => ({ id: task.id, title: task.title, phase: task.work?.phase || null })),
  };
}

function collectImages(cfg = config(), options = {}) {
  const items = [];
  const sinceMs = Number(options.sinceMs || 0);
  for (const relativeDir of cfg.screenshotDirectories) {
    const directory = path.resolve(cfg.projectRoot, relativeDir);
    let names = [];
    try { names = fs.readdirSync(directory); } catch { continue; }
    for (const name of names) {
      const full = path.join(directory, name);
      const ext = path.extname(name).toLowerCase();
      if (!IMAGE_EXTENSIONS.has(ext)) continue;
      try {
        const stat = fs.statSync(full);
        if (!stat.isFile()) continue;
        if (sinceMs > 0 && stat.mtimeMs < sinceMs) continue;
        items.push({
          path: full,
          relativePath: path.relative(cfg.projectRoot, full).replace(/\\/g, '/'),
          mtimeMs: stat.mtimeMs,
          size: stat.size,
        });
      } catch {}
    }
  }
  items.sort((a, b) => b.mtimeMs - a.mtimeMs || a.relativePath.localeCompare(b.relativePath));
  return items.slice(0, cfg.maxImages);
}

function normalizeIssueKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^a-z0-9\u3040-\u30ff\u3400-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 160);
}

function knownIssuePrompt(store, cfg) {
  return store.issues
    .filter((issue) => issue.status === 'open')
    .slice(-cfg.maxKnownIssuesInPrompt)
    .map((issue) => ({ key: issue.key, title: issue.title, description: issue.description }))
    .map((issue) => `- ${issue.key}: ${issue.title}${issue.description ? ` — ${issue.description}` : ''}`)
    .join('\n');
}

function buildPrompt(images, issueStore, cfg) {
  const known = knownIssuePrompt(issueStore, cfg);
  return [
    'VR Avatar StudioのUI/UX品質を、添付スクリーンショットを実際に見て読み取り専用で監査してください。コードやファイルは変更しないでください。画像だけでは判断できない戻る/閉じる導線、同種通知の出力経路、状態表示の整合性は、必要な関連UIコードを読み取り専用で確認して構いません。',
    '客観性の高い問題だけを報告してください。対象: 文字切れ/はみ出し、UI重なり、ボタンやラベルの不自然な位置・サイズ、余白や整列の明確な不統一、同種メッセージ/Toast/警告の表示位置や見た目の不統一、戻る/閉じる等の明確な導線欠落、同一画面内の状態表示矛盾。スクリーンショットとコードの両方を見ても確証が持てないもの、単なる好みや微妙な美観差は報告しないでください。',
    '既知の未修正問題はNEWとして再報告しないでください。既知リストに同じ意味の問題があれば除外してください。',
    known ? `既知の未修正問題:\n${known}` : '既知の未修正問題: なし',
    `添付画像:\n${images.map((image, index) => `${index + 1}. ${image.relativePath}`).join('\n')}`,
    '出力は説明文やMarkdownを付けず、次のJSONだけにしてください。',
    '{"summary":"短い総評","issues":[{"key":"画面+カテゴリ+要素を表す安定した短いキー","title":"短い問題名","severity":"low|medium|high","image":"上記relativePath","description":"何がおかしいか","evidence":"画像上の根拠"}]}',
    'keyは座標や日時を含めず、同じ問題なら別のスクリーンショットでも同じ値になるようにしてください。確信がない場合はissuesへ入れないでください。',
  ].join('\n\n');
}

function devspaceRuntime() {
  const devspace = readJson('config/devspace.json');
  return {
    cli: path.resolve(String(devspace.root), String(devspace.entry || 'dist/cli.js')),
    env: { ...process.env, ...(devspace.environment || {}) },
  };
}

function parseJsonOutput(text) {
  const raw = String(text || '').trim();
  if (!raw) throw new Error('empty JSON output');
  try { return JSON.parse(raw); } catch {}
  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first >= 0 && last > first) return JSON.parse(raw.slice(first, last + 1));
  throw new Error('JSON parse failed');
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runAgent(images, issueStore, cfg = config()) {
  const runtime = devspaceRuntime();
  const env = {
    ...runtime.env,
    DEVSPACE_WORKSPACE_ID: 'agenttools-idle-ui-qa',
    DEVSPACE_WORKSPACE_ROOT: cfg.projectRoot,
  };
  const args = [
    runtime.cli,
    'agents', 'run', cfg.worker.provider,
    '--model', cfg.worker.model,
    '--thinking', cfg.worker.thinking,
    '--write-mode', 'read_only',
    '--isolation', 'checkout',
    '--usage-threshold', String(cfg.worker.usageThresholdPercent),
    '--json',
  ];
  for (const image of images) args.push('--image', image.relativePath);
  args.push(buildPrompt(images, issueStore, cfg));
  const start = run(process.execPath, args, { cwd: cfg.projectRoot, env, timeoutMs: 30000 });
  if (!start.ok) throw new Error(start.stderr || start.stdout || start.error || 'DevSpace agent start failed');
  const record = parseJsonOutput(start.stdout);
  if (!record.id) throw new Error('DevSpace agent id missing');

  const deadline = Date.now() + 8 * 60 * 1000;
  let current = record;
  while (['starting', 'running'].includes(String(current.status || '').toLowerCase()) && Date.now() < deadline) {
    await delay(1000);
    const shown = run(process.execPath, [runtime.cli, 'agents', 'show', record.id, '--json'], {
      cwd: cfg.projectRoot,
      env,
      timeoutMs: 20000,
    });
    if (!shown.ok) throw new Error(shown.stderr || shown.stdout || shown.error || 'DevSpace agent status failed');
    current = parseJsonOutput(shown.stdout);
    if (!['starting', 'running'].includes(String(current.status || '').toLowerCase())) break;
  }
  if (['starting', 'running'].includes(String(current.status || '').toLowerCase())) {
    throw new Error('Idle UI QA worker timed out');
  }
  if (current.error) throw new Error(String(current.error));
  const response = parseJsonOutput(current.latestResponse || '');
  return { agent: current, response };
}

function mergeIssues(issueStore, response, runAt) {
  const issues = Array.isArray(response?.issues) ? response.issues : [];
  const byKey = new Map(issueStore.issues.map((issue) => [issue.key, issue]));
  const newIssues = [];
  for (const raw of issues) {
    let key = normalizeIssueKey(raw?.key);
    if (!key) key = normalizeIssueKey(`${raw?.title || ''}-${raw?.image || ''}`);
    if (!key) continue;
    const existing = byKey.get(key);
    if (existing) {
      existing.lastSeenAt = runAt;
      if (existing.status === 'open') {
        existing.duplicateObservations = Number(existing.duplicateObservations || 0) + 1;
        continue;
      }
      existing.status = 'open';
      existing.title = String(raw?.title || existing.title || key).slice(0, 240);
      existing.severity = ['low', 'medium', 'high'].includes(String(raw?.severity)) ? String(raw.severity) : (existing.severity || 'low');
      existing.image = raw?.image ? String(raw.image).slice(0, 1000) : existing.image || null;
      existing.description = raw?.description ? String(raw.description).slice(0, 4000) : existing.description || null;
      existing.evidence = raw?.evidence ? String(raw.evidence).slice(0, 4000) : existing.evidence || null;
      existing.resolvedAt = null;
      existing.resolution = null;
      existing.reopenCount = Number(existing.reopenCount || 0) + 1;
      newIssues.push(existing);
      continue;
    }
    const issue = {
      key,
      status: 'open',
      title: String(raw?.title || key).slice(0, 240),
      severity: ['low', 'medium', 'high'].includes(String(raw?.severity)) ? String(raw.severity) : 'low',
      image: raw?.image ? String(raw.image).slice(0, 1000) : null,
      description: raw?.description ? String(raw.description).slice(0, 4000) : null,
      evidence: raw?.evidence ? String(raw.evidence).slice(0, 4000) : null,
      firstSeenAt: runAt,
      lastSeenAt: runAt,
      resolvedAt: null,
      duplicateObservations: 0,
      reopenCount: 0,
    };
    issueStore.issues.push(issue);
    byKey.set(key, issue);
    newIssues.push(issue);
  }
  return newIssues;
}

function reportPath(cfg, runAt) {
  const date = runAt.slice(0, 10);
  const time = runAt.slice(11, 19).replace(/:/g, '');
  return path.join(paths(cfg).reports, date, `${time}-idle-ui-qa.json`);
}

function statusSnapshot(cfg = config()) {
  const state = readState(cfg);
  const issueStore = readIssues(cfg);
  const dev = activeDevelopment(cfg);
  return {
    ok: true,
    enabled: cfg.enabled,
    projectRoot: cfg.projectRoot,
    idleMinutes: cfg.idleMinutes,
    checkIntervalMinutes: cfg.checkIntervalMinutes,
    developmentActive: dev.active,
    activeTasks: dev.tasks,
    state,
    issues: {
      open: issueStore.issues.filter((issue) => issue.status === 'open').length,
      resolved: issueStore.issues.filter((issue) => issue.status === 'resolved').length,
      total: issueStore.issues.length,
    },
    files: paths(cfg),
  };
}

async function runOnce(options = {}) {
  const cfg = options.config || config();
  const nowMs = options.nowMs ?? Date.now();
  const at = nowIso(nowMs);
  const state = readState(cfg);
  const filePaths = paths(cfg);
  const fingerprint = projectFingerprint(cfg);
  const saveState = (patch) => {
    const next = { ...state, ...patch, lastCheckAt: at };
    atomicWriteJson(filePaths.state, next);
    return next;
  };

  if (!cfg.enabled && options.force !== true) {
    return { ok: true, ran: false, reason: 'disabled', state: saveState({ lastRunStatus: 'skipped', lastRunReason: 'disabled' }) };
  }
  if (!fingerprint.ok) {
    return { ok: false, ran: false, reason: fingerprint.error, state: saveState({ lastRunStatus: 'error', lastRunReason: fingerprint.error }) };
  }

  if (state.observedFingerprint !== fingerprint.fingerprint) {
    const next = saveState({
      observedFingerprint: fingerprint.fingerprint,
      lastChangeAt: at,
      lastRunStatus: 'waiting_idle',
      lastRunReason: 'project changed; idle grace restarted',
    });
    if (options.force !== true) return { ok: true, ran: false, reason: 'project-changed', state: next, fingerprint };
  }

  const development = activeDevelopment(cfg);
  if (development.active && options.force !== true) {
    return { ok: true, ran: false, reason: 'development-active', development, state: saveState({ lastRunStatus: 'waiting_development', lastRunReason: 'active Work Task worker exists' }) };
  }

  const lastChangeMs = Date.parse(state.observedFingerprint === fingerprint.fingerprint ? state.lastChangeAt || at : at);
  const idleMs = Math.max(0, nowMs - (Number.isFinite(lastChangeMs) ? lastChangeMs : nowMs));
  const requiredMs = cfg.idleMinutes * 60 * 1000;
  if (idleMs < requiredMs && options.force !== true) {
    return { ok: true, ran: false, reason: 'idle-grace', idleMs, requiredMs, state: saveState({ lastRunStatus: 'waiting_idle', lastRunReason: `idle ${Math.floor(idleMs / 60000)}/${cfg.idleMinutes} min` }) };
  }

  if (state.lastRunFingerprint === fingerprint.fingerprint && options.force !== true) {
    return { ok: true, ran: false, reason: 'already-checked', state: saveState({ lastRunStatus: 'idle', lastRunReason: 'current project revision already checked' }) };
  }

  const screenshotSinceMs = Math.max(0, (Number.isFinite(lastChangeMs) ? lastChangeMs : nowMs) - cfg.checkIntervalMinutes * 60 * 1000);
  const images = collectImages(cfg, { sinceMs: screenshotSinceMs });
  if (images.length === 0) {
    return { ok: true, ran: false, reason: 'no-screenshots', screenshotSinceMs, state: saveState({ lastRunStatus: 'waiting_images', lastRunReason: 'no recent UI screenshots for this development revision', lastImageCount: 0 }) };
  }

  const issueStore = readIssues(cfg);
  try {
    const worker = options.runAgent ? await options.runAgent(images, issueStore, cfg) : await runAgent(images, issueStore, cfg);
    const newIssues = mergeIssues(issueStore, worker.response, at);
    atomicWriteJson(filePaths.issues, issueStore);
    const report = {
      schema: 'agenttools-idle-ui-qa-report/v1',
      at,
      projectRoot: cfg.projectRoot,
      projectFingerprint: fingerprint.fingerprint,
      images: images.map(({ relativePath, mtimeMs, size }) => ({ relativePath, mtimeMs, size })),
      summary: worker.response?.summary || null,
      newIssues,
      agentId: worker.agent?.id || null,
      model: worker.agent?.model || cfg.worker.model,
      providerUsage: worker.agent?.providerUsage || null,
    };
    const reportFile = reportPath(cfg, at);
    fs.mkdirSync(path.dirname(reportFile), { recursive: true });
    fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    const nextState = saveState({
      observedFingerprint: fingerprint.fingerprint,
      lastRunAt: at,
      lastRunFingerprint: fingerprint.fingerprint,
      lastRunStatus: newIssues.length > 0 ? 'issues' : 'passed',
      lastRunReason: newIssues.length > 0 ? `${newIssues.length} new UI/UX issue(s)` : 'no new UI/UX issues',
      lastReport: reportFile,
      lastAgentId: worker.agent?.id || null,
      lastImageCount: images.length,
      lastNewIssues: newIssues.length,
    });
    return { ok: true, ran: true, newIssues, report, reportFile, state: nextState };
  } catch (error) {
    const nextState = saveState({ lastRunStatus: 'error', lastRunReason: String(error.message || error).slice(0, 1000) });
    return { ok: false, ran: false, reason: error.message, state: nextState };
  }
}

function listIssues(options = {}, cfg = config()) {
  const store = readIssues(cfg);
  const status = options.status ? String(options.status).toLowerCase() : null;
  const limit = clampInteger(options.limit, 100, 1, 1000);
  return {
    ok: true,
    issues: store.issues.filter((issue) => !status || issue.status === status).slice(-limit).reverse(),
  };
}

function resolveIssue(options = {}, cfg = config()) {
  const key = normalizeIssueKey(options.key || options.issueKey);
  if (!key) throw new Error('key is required.');
  const store = readIssues(cfg);
  const issue = store.issues.find((candidate) => candidate.key === key);
  if (!issue) throw new Error(`Idle UI QA issue not found: ${key}`);
  issue.status = 'resolved';
  issue.resolvedAt = nowIso();
  issue.resolution = options.note ? String(options.note).slice(0, 2000) : null;
  atomicWriteJson(paths(cfg).issues, store);
  return { ok: true, issue };
}

module.exports = {
  config,
  paths,
  readState,
  readIssues,
  projectFingerprint,
  activeDevelopment,
  collectImages,
  normalizeIssueKey,
  mergeIssues,
  statusSnapshot,
  runOnce,
  listIssues,
  resolveIssue,
  _internal: {
    buildPrompt,
    knownIssuePrompt,
    defaultState,
  },
};
