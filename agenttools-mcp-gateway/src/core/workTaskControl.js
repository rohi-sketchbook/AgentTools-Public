const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const manager = require('./devspaceManager');
const { loadSafety } = require('./confirmations');
const { evaluateAutoResume } = require('./workTaskResume');
const { resolveCodexRole } = require('./codexModelPolicy');
const {
  getWorkTask,
  reconcileWorkTask,
  requestContinueWorkTask,
  completeWorkTask,
} = require('./workTaskStore');
const {
  continuationConfig,
  launchContinuation,
} = require('./workTaskContinuation');

const MAX_STATUS_TEXT = 4000;

function truncate(value, limit = MAX_STATUS_TEXT) {
  const text = String(value || '').trim();
  if (!text) return null;
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`;
}

function latestChatGptLog(task) {
  const entries = Array.isArray(task?.work?.workLog) ? task.work.workLog : [];
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (String(entry?.actor?.id || '').trim().toLowerCase() !== 'chatgpt') continue;
    return {
      at: entry.at || null,
      phase: truncate(entry.phase, 200),
      message: truncate(entry.message, 1600),
    };
  }
  return null;
}

function taskWorkspace(task) {
  return task?.work?.resumeContext?.worktreePath
    || task?.work?.resumeContext?.workspacePath
    || task?.work?.workspaceRoot
    || null;
}

function gitStatus(workspace) {
  if (!workspace || !fs.existsSync(workspace)) {
    return { available: false, branch: null, summary: 'Workspace path is unavailable.' };
  }
  const result = spawnSync('git', ['status', '--short', '--branch'], {
    cwd: path.resolve(workspace),
    encoding: 'utf8',
    windowsHide: true,
    timeout: 5000,
    maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    return {
      available: false,
      branch: null,
      summary: truncate(result.stderr || result.error?.message || 'Git status unavailable.', 800),
    };
  }
  const lines = String(result.stdout || '').split(/\r?\n/u).filter(Boolean);
  const branch = lines[0]?.startsWith('## ') ? lines[0].slice(3).trim() : null;
  const changes = branch ? lines.slice(1) : lines;
  return {
    available: true,
    branch,
    changeCount: changes.length,
    summary: changes.length === 0 ? 'Git working tree is clean.' : truncate(changes.slice(0, 30).join('\n'), 2200),
  };
}

function inspectWorkTask(options = {}) {
  const id = String(options.id || options.taskId || '').trim();
  if (!id) throw new Error('id is required.');
  const task = getWorkTask(id);
  if (!task) throw new Error(`Work task not found: ${id}`);

  const workspace = taskWorkspace(task);
  let lookup = null;
  if (workspace) {
    try {
      lookup = manager.workspaceLookup(workspace, { mode: 'checkout' });
    } catch (error) {
      lookup = { ok: false, found: false, reusable: false, error: truncate(error.message, 800) };
    }
  }

  return {
    taskId: task.id,
    title: truncate(task.title, 300),
    status: task.status,
    state: task.work?.state || null,
    stateReason: truncate(task.work?.stateReason, 1200),
    phase: truncate(task.work?.phase, 300),
    currentWork: truncate(task.work?.currentWork, 1600),
    updatedAt: task.updatedAt || null,
    latestChatGpt: latestChatGptLog(task),
    continueRequest: task.work?.control?.continueRequestedAt ? {
      requestedAt: task.work.control.continueRequestedAt,
      status: task.work.control.continueStatus || (task.work?.resumeContext?.nextStep ? 'requested' : 'waiting_host'),
      requestedBy: truncate(task.work.control.continueRequestedBy?.label || task.work.control.continueRequestedBy?.id, 200),
    } : null,
    resume: task.work?.resumeContext ? {
      checkpointAt: task.work.resumeContext.checkpointAt || null,
      nextStep: truncate(task.work.resumeContext.nextStep, 1600),
      nextActionImpact: task.work.resumeContext.nextActionImpact || null,
      requiresUserConfirmation: task.work.resumeContext.requiresUserConfirmation === true,
    } : null,
    devspace: lookup ? {
      ok: lookup.ok !== false,
      found: lookup.found === true,
      reusable: lookup.reusable === true,
      status: lookup.workspace?.status || null,
      workspaceId: truncate(lookup.workspace?.id, 300),
      lastUsedAt: lookup.workspace?.lastUsedAt || null,
      error: truncate(lookup.error, 800),
    } : {
      ok: false,
      found: false,
      reusable: false,
      status: null,
      workspaceId: null,
      lastUsedAt: null,
      error: 'Task has no workspace path.',
    },
    git: gitStatus(workspace),
    note: 'latestChatGpt is the latest ChatGPT progress entry recorded in the Work Task, not the full ChatGPT product conversation history.',
  };
}

function buildResumePrompt(options = {}) {
  const id = String(options.id || options.taskId || '').trim();
  if (!id) throw new Error('id is required.');
  const task = getWorkTask(id);
  if (!task) throw new Error(`Work task not found: ${id}`);
  const latest = latestChatGptLog(task);
  const context = task.work?.resumeContext;
  const lines = [
    'AgentTools Control Centerからの再開です。',
    '',
    `Task ID: ${task.id}`,
    `Task: ${truncate(task.title, 300) || '—'}`,
    task.work?.project ? `Project: ${truncate(task.work.project, 300)}` : null,
    `状態: ${task.status}${task.work?.state ? ` / ${task.work.state}` : ''}`,
    task.work?.phase ? `Phase: ${truncate(task.work.phase, 300)}` : null,
    task.work?.currentWork ? `現在の進行: ${truncate(task.work.currentWork, 1600)}` : null,
    latest?.message ? `最新ChatGPT進捗: ${latest.phase ? `${latest.phase}: ` : ''}${latest.message}` : null,
    context?.nextStep ? `保存済みの次作業: ${truncate(context.nextStep, 1600)}` : null,
    '',
    'このTaskを正本として状態を確認し、既存Taskを再利用して残作業を続けてください。新しいTaskは作らないでください。',
    '既存のDevSpace workspaceが再利用できる場合はそれを使い、利用できない場合だけ同じProject/checkoutを開き直してください。',
    'この再開はChatGPTホストのSol系列で進めてください。Codex/Astraはユーザーが明示的に依頼しない限り自動起動しないでください。',
  ].filter((line) => line !== null);
  return {
    ok: true,
    action: 'resume-prompt',
    taskId: task.id,
    prompt: lines.join('\n'),
    message: 'ChatGPT再開用プロンプトを生成しました。AIは起動していません。',
  };
}

function requestContinue(options = {}) {
  const id = String(options.id || options.taskId || '').trim();
  if (!id) throw new Error('id is required.');
  const requested = requestContinueWorkTask({
    id,
    actor: options.actor || 'control-center',
    actorLabel: options.actorLabel || 'Control Center',
    model: options.model || null,
  });
  const context = requested.work?.resumeContext;
  if (!context?.nextStep) {
    return {
      ok: true,
      task: requested,
      action: 'waiting-host',
      message: '続行要求を記録しました。安全なcheckpointがないため、このTaskは「再開待ち」として保持され、次回このTaskをChatGPTで再開できる実行を待ちます。',
    };
  }

  const decision = evaluateAutoResume(context, loadSafety());
  if (!decision.ok) {
    return {
      ok: true,
      task: requested,
      action: 'blocked-by-safety',
      message: `続行要求を記録しましたが、自動DevSpace再開は安全条件により停止しました: ${decision.reason}`,
    };
  }

  const runtime = continuationConfig();
  if (options.manualModelRole) {
    const role = resolveCodexRole(options.manualModelRole);
    runtime.policy = {
      ...runtime.policy,
      codexModel: role.model,
      codexThinking: role.thinking,
    };
  }
  const launched = launchContinuation(requested, runtime, Date.now(), 'Control Centerから手動続行', {
    manual: true,
    source: 'control-center',
  });
  return {
    ok: true,
    task: getWorkTask(id) || requested,
    action: launched.ok ? launched.action : 'waiting-host',
    message: launched.ok
      ? 'DevSpaceで続行を開始しました。'
      : `DevSpaceでの続行開始に失敗したため、ChatGPT再開待ちとして保持します: ${launched.error || 'unknown error'}`,
    continuation: launched,
  };
}

function finishForgotten(options = {}) {
  const id = String(options.id || options.taskId || '').trim();
  if (!id) throw new Error('id is required.');
  const userExplicitlyRequested = options.userExplicitlyRequested === true
    || String(options.userExplicitlyRequested || '').toLowerCase() === 'true';
  if (!userExplicitlyRequested) throw new Error('userExplicitlyRequested=true is required.');
  const beforeReconcile = getWorkTask(id);
  if (!beforeReconcile) throw new Error(`Work task not found: ${id}`);
  if (options.expectedUpdatedAt) {
    const expectedMs = Date.parse(String(options.expectedUpdatedAt));
    const displayedMs = Date.parse(String(beforeReconcile.updatedAt));
    if (!Number.isFinite(expectedMs) || !Number.isFinite(displayedMs) || Math.abs(expectedMs - displayedMs) >= 1) {
      throw new Error('Task changed after it was displayed. Refresh the task before completing it.');
    }
  }

  const reconciled = reconcileWorkTask({ id });
  const current = reconciled.task || getWorkTask(id);
  const activeWorkers = (current?.work?.workers || []).filter((worker) => worker.status === 'running' && worker.health !== 'crashed' && worker.health !== 'circuit_open');
  if (current?.status === 'running' && activeWorkers.length > 0) {
    throw new Error('Task still has an active worker. Use 状況確認 before treating it as a forgotten task.');
  }
  const task = completeWorkTask({
    id,
    actor: options.actor || 'control-center',
    actorLabel: options.actorLabel || 'Control Center',
    summary: options.summary || '閉じ忘れタスクとして手動完了',
    status: 'succeeded',
  });
  return { ok: true, task, action: 'completed' };
}

module.exports = {
  inspectWorkTask,
  buildResumePrompt,
  requestContinue,
  finishForgotten,
  latestChatGptLog,
  gitStatus,
};
