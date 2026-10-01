const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { readJson } = require('./config');
const { loadSafety } = require('./confirmations');
const { continuationPolicy } = require('./workflowPolicy');
const {
  resumePolicy,
  evaluateAutoResume,
} = require('./workTaskResume');
const {
  listWorkTasks,
  reconcileWorkTasks,
  updateWorkTask,
  heartbeatWorkTask,
  resumeWorkTask,
  getWorkTask,
  emitLifecycleNotification,
} = require('./workTaskStore');

const RUNNING_CONTINUATION_STATES = new Set(['launching', 'starting', 'running']);
const TERMINAL_AGENT_STATES = new Set(['completed', 'failed', 'stopped']);

function nowIso(nowMs = Date.now()) {
  return new Date(nowMs).toISOString();
}

function truncate(value, limit = 2000) {
  const text = String(value || '').trim();
  if (!text) return null;
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`;
}

function agentErrorMessage(error) {
  if (!error) return null;
  if (typeof error === 'string') return truncate(error);
  if (typeof error.message === 'string') return truncate(error.message);
  try {
    return truncate(JSON.stringify(error));
  } catch {
    return truncate(String(error));
  }
}

function comparablePath(value) {
  if (!value) return null;
  const resolved = path.resolve(String(value));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function continuationConfig() {
  const safety = loadSafety();
  const policy = resumePolicy(safety);
  const devspace = readJson('config/devspace.json');
  return {
    safety,
    policy,
    workflow: continuationPolicy(),
    devspace,
  };
}

function taskWorkspace(task) {
  return task?.work?.resumeContext?.worktreePath
    || task?.work?.resumeContext?.workspacePath
    || task?.work?.workspaceRoot
    || null;
}

function syntheticWorkspaceId(taskId) {
  return `agenttools-${String(taskId || '').replace(/[^A-Za-z0-9_-]/g, '_')}`;
}

function workerFor(task, actorId) {
  const id = String(actorId || '').trim().toLowerCase();
  return (task?.work?.workers || []).find((worker) => String(worker?.actor?.id || '').trim().toLowerCase() === id) || null;
}

function heartbeatAgeMs(task, nowMs) {
  const worker = workerFor(task, 'chatgpt');
  const stamp = Date.parse(String(worker?.lastHeartbeatAt || worker?.updatedAt || task?.updatedAt || ''));
  return Number.isFinite(stamp) ? Math.max(0, nowMs - stamp) : Number.POSITIVE_INFINITY;
}

function hasOtherLiveWorker(task) {
  return (task?.work?.workers || []).some((worker) => {
    const actor = String(worker?.actor?.id || '').trim().toLowerCase();
    return actor !== 'chatgpt' && actor !== 'codex' && worker?.status === 'running';
  });
}

function hasWorkspaceConflict(task, tasks) {
  const candidate = comparablePath(taskWorkspace(task));
  if (!candidate) return false;
  return tasks.some((other) => {
    if (!other || other.id === task.id) return false;
    if (comparablePath(taskWorkspace(other)) !== candidate) return false;
    if (other.status !== 'running' || other.work?.state !== 'working') return false;
    return (other.work?.workers || []).some((worker) => worker?.status === 'running');
  });
}

function continuationFor(task) {
  return task?.work?.resumeContext?.continuation || null;
}

function sameCheckpoint(task, continuation = continuationFor(task)) {
  if (!continuation) return false;
  return Boolean(
    continuation.sourceCheckpointAt
    && continuation.sourceCheckpointAt === task?.work?.resumeContext?.checkpointAt,
  );
}

function reusableContinuationSession(task, runtime) {
  const continuation = continuationFor(task);
  if (!runtime.policy.reuseCodexSession || !continuation?.agentId) return null;
  if (String(continuation.provider || '').toLowerCase() !== 'codex') return null;
  if (String(continuation.status || '').toLowerCase() !== 'completed') return null;
  if (continuation.model && continuation.model !== runtime.policy.codexModel) return null;
  return {
    agentId: continuation.agentId,
    reuseCount: Number(continuation.sessionReuseCount || 0) + 1,
  };
}

function shouldMonitor(task) {
  const continuation = continuationFor(task);
  return Boolean(
    continuation?.agentId
    && RUNNING_CONTINUATION_STATES.has(String(continuation.status || '').toLowerCase()),
  );
}

function shouldLaunch(task, tasks, runtime, nowMs) {
  const context = task?.work?.resumeContext;
  if (!context?.nextStep) return { ok: false, reason: 'checkpointなし' };
  if (runtime.workflow.mode !== 'codex') return { ok: false, reason: `mode=${runtime.workflow.mode}` };
  if (!runtime.policy.enabled) return { ok: false, reason: 'safety auto-resume disabled' };
  if (hasOtherLiveWorker(task)) return { ok: false, reason: '別workerが実行中' };
  if (hasWorkspaceConflict(task, tasks)) return { ok: false, reason: '同じcheckoutで別Taskが実行中' };

  const continuation = continuationFor(task);
  if (continuation && sameCheckpoint(task, continuation)) {
    const status = String(continuation.status || '').toLowerCase();
    if (RUNNING_CONTINUATION_STATES.has(status)) return { ok: false, reason: 'Codex継続中' };
    if (['completed', 'failed', 'stopped', 'blocked'].includes(status)) {
      return { ok: false, reason: `checkpoint処理済み(${status})` };
    }
  }

  const safetyDecision = evaluateAutoResume({ ...context, workspaceConflict: false }, runtime.safety);
  if (!safetyDecision.ok) return { ok: false, reason: safetyDecision.reason };

  const modeChangedAt = Date.parse(String(runtime.workflow.changedAt || ''));
  const checkpointAt = Date.parse(String(context.checkpointAt || ''));
  if (Number.isFinite(modeChangedAt) && (!Number.isFinite(checkpointAt) || checkpointAt < modeChangedAt)) {
    return { ok: false, reason: 'Codex自動継続を有効化する前のcheckpoint' };
  }

  const timeoutImmediate = context.timeoutKind === 'chatgpt_execution'
    && ['pending', 'resuming'].includes(String(context.autoResumeStatus || '').toLowerCase());
  if (timeoutImmediate) return { ok: true, reason: 'chatgpt_execution timeout' };

  const worker = workerFor(task, 'chatgpt');
  const health = String(worker?.health || '').toLowerCase();
  if (health === 'crashed' || health === 'circuit_open') return { ok: true, reason: `ChatGPT worker ${health}` };

  const age = heartbeatAgeMs(task, nowMs);
  if (age >= runtime.policy.codexHandoffAfterMs) {
    return { ok: true, reason: `ChatGPT heartbeat停止 ${age}ms` };
  }
  return { ok: false, reason: `heartbeat猶予中 ${age}ms` };
}

function buildContinuationPrompt(task) {
  const context = task.work.resumeContext;
  const constraints = [
    'この実行はChatGPT host execution終了後の自動継続です。ユーザーへ確認を要求せず、安全なローカル作業だけを進めてください。',
    '現在のcheckout/workspaceに残っている未コミット変更を前提として扱い、既存変更を巻き戻したり上書きで失わせたりしないでください。',
    'git commit/push、PR、任意のDiscord/SNS/メール送信、本番反映、削除、課金・アカウント操作など外部・破壊的操作は行わないでください。必要になったらそこで止めて報告してください。AgentTools自身が出す定型の継続状態通知は別経路なので、あなたがDiscordを操作する必要はありません。',
    '可能な範囲で実装・ローカルテスト・検証まで進め、最後に実施内容、変更ファイル、テスト結果、残作業またはブロッカーを簡潔に報告してください。',
  ];
  if (Array.isArray(context.safetyChecks) && context.safetyChecks.length > 0) {
    constraints.push(`保存済み安全確認: ${context.safetyChecks.join(' / ')}`);
  }
  return [
    `User request:\n${task.work.request || task.title}`,
    task.work.project ? `Project:\n${task.work.project}` : null,
    context.lastCompletedStep ? `Last completed step:\n${context.lastCompletedStep}` : null,
    `Continue from this checkpoint:\n${context.nextStep}`,
    `Workspace:\n${taskWorkspace(task)}`,
    `Rules:\n- ${constraints.join('\n- ')}`,
  ].filter(Boolean).join('\n\n');
}

function devspaceCliPath(devspace) {
  const root = path.resolve(String(devspace.root || ''));
  const entry = String(devspace.entry || 'dist/cli.js');
  return path.resolve(root, entry);
}

function devspaceEnvironment(task, runtime) {
  const extra = runtime.devspace.environment && typeof runtime.devspace.environment === 'object'
    ? runtime.devspace.environment
    : {};
  return {
    ...process.env,
    ...extra,
    DEVSPACE_WORKSPACE_ID: syntheticWorkspaceId(task.id),
    DEVSPACE_WORKSPACE_ROOT: path.resolve(taskWorkspace(task)),
  };
}

function parseJsonOutput(stdout) {
  const text = String(stdout || '').trim();
  if (!text) throw new Error('DevSpace agent command returned no JSON.');
  try {
    return JSON.parse(text);
  } catch {
    const first = text.indexOf('{');
    const last = text.lastIndexOf('}');
    if (first >= 0 && last > first) return JSON.parse(text.slice(first, last + 1));
    throw new Error(`DevSpace agent JSON parse failed: ${truncate(text, 500)}`);
  }
}

function runDevspaceAgent(task, runtime, args, timeoutMs = 20000) {
  const workspace = taskWorkspace(task);
  if (!workspace) throw new Error('Task checkpointにworkspacePathがありません。');
  const cli = devspaceCliPath(runtime.devspace);
  const result = spawnSync(process.execPath, [cli, ...args, '--json'], {
    cwd: path.resolve(workspace),
    env: devspaceEnvironment(task, runtime),
    encoding: 'utf8',
    windowsHide: true,
    timeout: timeoutMs,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(truncate(result.stderr || result.stdout || `DevSpace exited ${result.status}`, 1500));
  }
  return parseJsonOutput(result.stdout);
}

function continuationPayload(task, values = {}) {
  const previous = continuationFor(task) || {};
  return {
    ...previous,
    mode: 'codex',
    provider: 'codex',
    model: values.model || previous.model || null,
    sourceCheckpointAt: task.work.resumeContext.checkpointAt,
    attempt: Number(values.attempt ?? previous.attempt ?? 0),
    ...values,
  };
}

function updateResumeContinuation(task, continuation, extra = {}) {
  return updateWorkTask({
    id: task.id,
    actor: extra.actor || 'chatgpt',
    actorLabel: extra.actorLabel || (extra.actor === 'codex' ? 'Codex' : 'ChatGPT'),
    model: extra.model || null,
    ...(extra.phase !== undefined ? { phase: extra.phase } : {}),
    ...(extra.message !== undefined ? { message: extra.message } : {}),
    ...(extra.state !== undefined ? { state: extra.state } : {}),
    ...(extra.reason !== undefined ? { reason: extra.reason } : {}),
    ...(extra.workerStatus !== undefined ? { workerStatus: extra.workerStatus } : {}),
    ...(extra.takeOwnership === true ? { takeOwnership: true } : {}),
    resumeContextJson: JSON.stringify({
      ...(extra.nextStep ? { nextStep: extra.nextStep } : {}),
      ...(extra.lastCompletedStep ? { lastCompletedStep: extra.lastCompletedStep } : {}),
      continuation,
    }),
  });
}

function prepareResumeForCodex(task, runtime) {
  const context = task.work.resumeContext;
  if (context.autoResumeStatus === 'resuming') return task;
  return resumeWorkTask({
    id: task.id,
    actor: 'codex',
    actorLabel: 'Codex',
    model: runtime.policy.codexModel,
    phase: 'Codex自動継続',
    message: context.nextStep,
  });
}

function notifyContinuation(task, kind, details = {}) {
  try {
    return emitLifecycleNotification(task, kind, details);
  } catch {
    // Discord/system notification delivery is best-effort and must never break continuation execution.
    return false;
  }
}

function launchContinuation(task, runtime, nowMs = Date.now(), triggerReason = null, launchOptions = {}) {
  const requestedAt = nowIso(nowMs);
  let current = getWorkTask(task.id) || task;
  const reusableSession = reusableContinuationSession(current, runtime);
  const attempt = Number(current.work.resumeContext?.continuation?.attempt || 0) + 1;
  let continuation = continuationPayload(current, {
    status: 'launching',
    model: runtime.policy.codexModel,
    agentId: reusableSession?.agentId || null,
    requestedAt,
    startedAt: null,
    finishedAt: null,
    lastCheckedAt: requestedAt,
    attempt,
    providerUsage: null,
    summary: null,
    error: null,
    changedFiles: [],
    commandsRun: [],
    sessionReused: Boolean(reusableSession),
    sessionReuseCount: reusableSession?.reuseCount || Number(current.work.resumeContext?.continuation?.sessionReuseCount || 0),
  });

  const manualLaunch = launchOptions.manual === true;
  current = updateResumeContinuation(current, continuation, {
    actor: 'chatgpt',
    actorLabel: 'ChatGPT',
    phase: manualLaunch ? '手動続行' : 'Codex引き継ぎ',
    message: manualLaunch
      ? `Control Centerから続行要求。DevSpaceへ引き継ぎ: ${current.work.resumeContext.nextStep}`
      : `ChatGPT execution停止を検知。Codexへ引き継ぎ: ${current.work.resumeContext.nextStep}`,
    state: 'working',
    reason: manualLaunch
      ? (triggerReason || 'Control CenterからDevSpace継続を開始')
      : (triggerReason ? `Codex自動継続: ${triggerReason}` : 'Codex自動継続を開始'),
    workerStatus: 'blocked',
  });

  try {
    current = prepareResumeForCodex(current, runtime);
    const prompt = buildContinuationPrompt(current);
    const agentRunner = runtime.runAgent || runDevspaceAgent;
    const agentArgs = reusableSession
      ? [
        'agents', 'continue', reusableSession.agentId,
        '--model', runtime.policy.codexModel,
        '--effort', runtime.policy.codexThinking,
        prompt,
      ]
      : [
        'agents', 'run', 'codex',
        '--model', runtime.policy.codexModel,
        '--effort', runtime.policy.codexThinking,
        prompt,
      ];
    const record = agentRunner(current, runtime, agentArgs);
    const startedAt = nowIso();
    continuation = continuationPayload(current, {
      ...continuation,
      status: record.status === 'starting' ? 'starting' : 'running',
      model: record.model || runtime.policy.codexModel,
      agentId: record.id || reusableSession?.agentId || null,
      startedAt,
      lastCheckedAt: startedAt,
      providerUsage: record.providerUsage || null,
      error: record.error || null,
    });
    current = updateResumeContinuation(current, continuation, {
      actor: 'codex',
      actorLabel: 'Codex',
      model: continuation.model,
      phase: 'Codex自動継続',
      message: current.work.resumeContext.nextStep,
      state: 'working',
      reason: manualLaunch
        ? (reusableSession
          ? `Control CenterからDevSpaceへ手動続行 (session再利用: ${continuation.agentId || reusableSession.agentId})`
          : `Control CenterからDevSpaceへ手動続行 (${continuation.agentId || 'agent起動中'})`)
        : (reusableSession
          ? `ChatGPTからCodexへ自動引き継ぎ (Codex session再利用: ${continuation.agentId || reusableSession.agentId})`
          : `ChatGPTからCodexへ自動引き継ぎ (${continuation.agentId || 'agent起動中'})`),
      workerStatus: 'running',
      takeOwnership: true,
    });
    const notificationQueued = notifyContinuation(current, 'continuation_started', {
      attempt,
      model: continuation.model,
      triggerReason,
      providerUsage: continuation.providerUsage,
      sessionReused: continuation.sessionReused,
    });
    return { ok: true, action: reusableSession ? 'continued' : 'launched', taskId: current.id, agentId: continuation.agentId, triggerReason, providerUsage: continuation.providerUsage, sessionReused: continuation.sessionReused, notificationQueued };
  } catch (error) {
    const failedAt = nowIso();
    continuation = continuationPayload(current, {
      ...continuation,
      status: 'failed',
      finishedAt: failedAt,
      lastCheckedAt: failedAt,
      error: truncate(error.message, 1500),
    });
    try {
      current = updateResumeContinuation(current, continuation, {
        actor: 'codex',
        actorLabel: 'Codex',
        model: runtime.policy.codexModel,
        phase: 'Codex引き継ぎ失敗',
        message: continuation.error,
        state: 'blocked',
        reason: `Codex自動継続を開始できませんでした: ${continuation.error}`,
        workerStatus: 'blocked',
      });
      current = updateWorkTask({
        id: current.id,
        actor: 'chatgpt',
        actorLabel: 'ChatGPT',
        model: 'GPT-5.6 Sol',
        phase: '再開待ち',
        message: 'Codex自動継続の起動失敗を確認してChatGPTで再開',
        state: 'blocked',
        reason: `Codex自動継続失敗: ${continuation.error}`,
        workerStatus: 'blocked',
        takeOwnership: true,
      });
      notifyContinuation(current, 'continuation_failed', {
        attempt,
        model: continuation.model || runtime.policy.codexModel,
        triggerReason,
        error: continuation.error,
        providerUsage: continuation.providerUsage,
      });
    } catch {
      // Task observability/notification failure must not hide the original launch failure.
    }
    return { ok: false, action: 'launch-failed', taskId: task.id, error: continuation.error };
  }
}

function monitorContinuation(task, runtime) {
  const continuation = continuationFor(task);
  if (!continuation?.agentId) return { ok: false, action: 'monitor-skipped', taskId: task.id, reason: 'agentIdなし' };
  let record;
  try {
    const agentRunner = runtime.runAgent || runDevspaceAgent;
    record = agentRunner(task, runtime, ['agents', 'show', continuation.agentId], 10000);
  } catch (error) {
    return { ok: false, action: 'monitor-error', taskId: task.id, agentId: continuation.agentId, error: truncate(error.message, 1000) };
  }

  const observedAt = nowIso();
  if (!TERMINAL_AGENT_STATES.has(String(record.status || '').toLowerCase())) {
    try {
      heartbeatWorkTask({
        id: task.id,
        actor: 'codex',
        actorLabel: 'Codex',
        model: continuation.model || runtime.policy.codexModel,
      });
    } catch {
      // Heartbeat is best-effort; the DevSpace agent remains the execution source of truth.
    }
    return {
      ok: true,
      action: 'running',
      taskId: task.id,
      agentId: continuation.agentId,
      status: record.status,
      providerUsage: record.providerUsage || continuation.providerUsage || null,
    };
  }

  let current = getWorkTask(task.id) || task;
  const errorMessage = agentErrorMessage(record.error);
  const successful = record.status === 'completed' && !errorMessage;
  const finalStatus = successful ? 'completed' : record.status === 'stopped' ? 'stopped' : 'failed';
  const summary = truncate(record.response || record.latestResponse || errorMessage || (successful ? 'Codex自動継続が完了' : 'Codex自動継続が終了'), 2500);
  const nextStep = successful
    ? 'Codex自動継続の変更とテスト結果をChatGPTで最終確認する'
    : 'Codex自動継続の失敗内容を確認し、ChatGPTでcheckpointから再開する';
  const updatedContinuation = continuationPayload(current, {
    ...continuation,
    status: finalStatus,
    finishedAt: observedAt,
    lastCheckedAt: observedAt,
    providerUsage: record.providerUsage || continuation.providerUsage || null,
    summary,
    error: errorMessage,
    changedFiles: Array.isArray(record.changedFiles) ? record.changedFiles : [],
    commandsRun: Array.isArray(record.commandsRun) ? record.commandsRun : [],
  });

  current = updateResumeContinuation(current, updatedContinuation, {
    actor: 'codex',
    actorLabel: 'Codex',
    model: updatedContinuation.model || runtime.policy.codexModel,
    phase: successful ? 'Codex継続完了' : 'Codex継続停止',
    message: summary,
    state: successful ? 'working' : 'blocked',
    reason: successful ? 'Codex自動継続のローカル作業が完了' : `Codex自動継続停止: ${errorMessage || record.handoffReason || record.status}`,
    workerStatus: successful ? 'done' : 'blocked',
    nextStep,
    lastCompletedStep: successful
      ? `Codex自動継続完了: ${task.work.resumeContext.nextStep}`
      : task.work.resumeContext.lastCompletedStep,
  });

  current = updateWorkTask({
    id: current.id,
    actor: 'chatgpt',
    actorLabel: 'ChatGPT',
    model: 'GPT-5.6 Sol',
    phase: successful ? '最終確認待ち' : '再開待ち',
    message: nextStep,
    state: successful ? 'waiting_dependency' : 'blocked',
    reason: successful ? 'Codexから引き継ぎ済み。ChatGPTの最終確認待ち' : `Codex自動継続失敗: ${errorMessage || record.handoffReason || record.status}`,
    workerStatus: 'blocked',
    takeOwnership: true,
  });

  const notificationQueued = notifyContinuation(current, successful ? 'continuation_completed' : 'continuation_failed', {
    attempt: updatedContinuation.attempt,
    model: updatedContinuation.model || runtime.policy.codexModel,
    summary,
    error: errorMessage || (successful ? null : record.handoffReason || record.status),
    providerUsage: updatedContinuation.providerUsage,
  });

  return {
    ok: successful,
    action: successful ? 'completed' : 'failed',
    taskId: task.id,
    agentId: continuation.agentId,
    providerUsage: updatedContinuation.providerUsage,
    changedFiles: updatedContinuation.changedFiles,
    summary,
    error: errorMessage,
    handoffReason: record.handoffReason || null,
    notificationQueued,
  };
}

function runContinuationSweep(options = {}) {
  const nowMs = Number(options.nowMs || Date.now());
  const runtime = options.runtime || continuationConfig();
  if (!runtime.policy.enabled) {
    return { ok: true, enabled: false, mode: runtime.workflow.mode, reason: 'safety auto-resume disabled', events: [] };
  }
  if (runtime.workflow.mode !== 'codex') {
    return { ok: true, enabled: runtime.workflow.mode !== 'off', mode: runtime.workflow.mode, events: [] };
  }

  reconcileWorkTasks({ limit: 100, at: nowIso(nowMs) });
  const tasks = listWorkTasks({ mode: 'active', limit: 100 });
  const events = [];
  let processed = 0;

  for (const task of tasks) {
    if (processed >= runtime.policy.maxContinuationTasksPerSweep) break;
    if (!shouldMonitor(task)) continue;
    events.push(monitorContinuation(task, runtime));
    processed += 1;
  }

  const refreshed = listWorkTasks({ mode: 'active', limit: 100 });
  for (const task of refreshed) {
    if (processed >= runtime.policy.maxContinuationTasksPerSweep) break;
    if (shouldMonitor(task)) continue;
    const decision = shouldLaunch(task, refreshed, runtime, nowMs);
    if (!decision.ok) continue;
    events.push(launchContinuation(task, runtime, nowMs, decision.reason));
    processed += 1;
  }

  return {
    ok: events.every((event) => event.ok !== false || ['monitor-error'].includes(event.action)),
    enabled: true,
    mode: runtime.workflow.mode,
    scanned: tasks.length,
    processed,
    events,
  };
}

module.exports = {
  RUNNING_CONTINUATION_STATES,
  TERMINAL_AGENT_STATES,
  continuationConfig,
  taskWorkspace,
  syntheticWorkspaceId,
  heartbeatAgeMs,
  hasWorkspaceConflict,
  shouldLaunch,
  buildContinuationPrompt,
  parseJsonOutput,
  launchContinuation,
  monitorContinuation,
  runContinuationSweep,
};
