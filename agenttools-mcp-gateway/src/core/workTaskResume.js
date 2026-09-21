const path = require('node:path');
const { resolveCodexRole } = require('./codexModelPolicy');

const SAFE_IMPACTS = new Set(['read', 'local_write', 'local_test', 'local_validation', 'local_generation']);
const BLOCKED_ACTIONS = new Set([
  'git.push',
  'pull_request.create',
  'pull_request.merge',
  'discord.post',
  'email.send',
  'sns.post',
  'deploy.production',
  'file.delete',
  'directory.delete',
  'purchase',
  'billing.change',
  'account.change',
]);
const TIMEOUT_KINDS = new Set(['gateway_task', 'command', 'chatgpt_execution', 'dependency', 'user']);

function positiveInteger(value, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(Math.trunc(number), max));
}

function booleanOr(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return value === true || value === 'true' || value === '1' || value === 'yes';
}

function stringOrNull(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text || null;
}

function stringList(value, fallback = []) {
  if (value === undefined || value === null || value === '') return [...fallback];
  const items = Array.isArray(value) ? value : [value];
  return items.map((entry) => String(entry).trim()).filter(Boolean);
}

function objectValue(value, fallback = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...fallback };
  return { ...value };
}

function normalizeProviderUsage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const usedPercent = Number(value.usedPercent);
  const remainingPercent = Number(value.remainingPercent);
  const resetsAt = Number(value.resetsAt);
  return {
    usedPercent: Number.isFinite(usedPercent) ? Math.max(0, Math.min(100, usedPercent)) : null,
    remainingPercent: Number.isFinite(remainingPercent) ? Math.max(0, Math.min(100, remainingPercent)) : null,
    resetsAt: Number.isFinite(resetsAt) ? Math.max(0, Math.trunc(resetsAt)) : null,
    source: stringOrNull(value.source),
  };
}

function normalizeContinuation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return {
    mode: stringOrNull(value.mode),
    status: stringOrNull(value.status),
    provider: stringOrNull(value.provider),
    model: stringOrNull(value.model),
    agentId: stringOrNull(value.agentId),
    requestedAt: stringOrNull(value.requestedAt),
    startedAt: stringOrNull(value.startedAt),
    finishedAt: stringOrNull(value.finishedAt),
    lastCheckedAt: stringOrNull(value.lastCheckedAt),
    sourceCheckpointAt: stringOrNull(value.sourceCheckpointAt),
    attempt: positiveInteger(value.attempt, 0, 0, 100),
    providerUsage: normalizeProviderUsage(value.providerUsage),
    summary: stringOrNull(value.summary),
    error: stringOrNull(value.error),
    changedFiles: stringList(value.changedFiles, []).slice(0, 200),
    commandsRun: stringList(value.commandsRun, []).slice(0, 200),
    sessionReused: Boolean(value.sessionReused),
    sessionReuseCount: positiveInteger(value.sessionReuseCount, 0, 0, 100),
  };
}

function parseResumeContext(input = {}) {
  if (input.resumeContext && typeof input.resumeContext === 'object' && !Array.isArray(input.resumeContext)) {
    return { ...input.resumeContext };
  }
  if (!input.resumeContextJson) return {};
  const parsed = JSON.parse(String(input.resumeContextJson));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('resumeContextJson must be a JSON object.');
  return parsed;
}

function normalizeTimeoutKind(value, fallback = null) {
  const kind = stringOrNull(value) || fallback;
  if (!kind) return null;
  if (!TIMEOUT_KINDS.has(kind)) throw new Error(`timeoutKind must be one of: ${[...TIMEOUT_KINDS].join(', ')}.`);
  return kind;
}

function normalizeResumeContext(existing = null, input = {}, task = null) {
  const supplied = parseResumeContext(input);
  const previous = objectValue(existing);
  const workspacePath = stringOrNull(supplied.workspacePath ?? input.workspacePath ?? previous.workspacePath ?? task?.work?.workspaceRoot);
  const nextActionImpact = stringOrNull(supplied.nextActionImpact ?? input.nextActionImpact ?? previous.nextActionImpact);
  const pendingAction = stringOrNull(supplied.pendingAction ?? input.pendingAction ?? previous.pendingAction);
  const checkpointAt = stringOrNull(supplied.checkpointAt ?? input.checkpointAt ?? previous.checkpointAt) || new Date().toISOString();
  const continuationInput = Object.prototype.hasOwnProperty.call(supplied, 'continuation')
    ? supplied.continuation
    : previous.continuation;

  return {
    schema: 'agenttools-work-task-resume/v1',
    checkpointAt,
    phase: stringOrNull(supplied.phase ?? input.resumePhase ?? previous.phase ?? task?.work?.phase),
    lastCompletedStep: stringOrNull(supplied.lastCompletedStep ?? input.lastCompletedStep ?? previous.lastCompletedStep),
    nextStep: stringOrNull(supplied.nextStep ?? input.nextStep ?? previous.nextStep),
    workspacePath: workspacePath ? path.resolve(workspacePath) : null,
    worktreePath: stringOrNull(supplied.worktreePath ?? input.worktreePath ?? previous.worktreePath),
    branch: stringOrNull(supplied.branch ?? input.branch ?? previous.branch),
    hasUncommittedChanges: booleanOr(supplied.hasUncommittedChanges ?? input.hasUncommittedChanges, Boolean(previous.hasUncommittedChanges)),
    activeOperation: stringOrNull(supplied.activeOperation ?? input.activeOperation ?? previous.activeOperation),
    externalApps: stringList(supplied.externalApps ?? input.externalApps, previous.externalApps || []),
    safetyChecks: stringList(supplied.safetyChecks ?? input.safetyChecks, previous.safetyChecks || []),
    requiresUserConfirmation: booleanOr(supplied.requiresUserConfirmation ?? input.requiresUserConfirmation, Boolean(previous.requiresUserConfirmation)),
    allowedExternalActions: stringList(supplied.allowedExternalActions ?? input.allowedExternalActions, previous.allowedExternalActions || []),
    nextActionImpact,
    pendingAction,
    workspaceConflict: booleanOr(supplied.workspaceConflict ?? input.workspaceConflict, Boolean(previous.workspaceConflict)),
    timeoutKind: normalizeTimeoutKind(supplied.timeoutKind ?? input.timeoutKind, previous.timeoutKind || null),
    timeoutCount: positiveInteger(supplied.timeoutCount ?? previous.timeoutCount, 0),
    consecutiveTimeouts: positiveInteger(supplied.consecutiveTimeouts ?? previous.consecutiveTimeouts, 0),
    autoResumeCount: positiveInteger(supplied.autoResumeCount ?? previous.autoResumeCount, 0),
    totalRuntimeMs: positiveInteger(supplied.totalRuntimeMs ?? previous.totalRuntimeMs, 0),
    progressSignature: stringOrNull(supplied.progressSignature ?? input.progressSignature ?? previous.progressSignature),
    repeatedProgressCount: positiveInteger(supplied.repeatedProgressCount ?? previous.repeatedProgressCount, 0),
    autoResumeEligible: Boolean(supplied.autoResumeEligible ?? previous.autoResumeEligible),
    autoResumeReason: stringOrNull(supplied.autoResumeReason ?? previous.autoResumeReason),
    autoResumeStatus: stringOrNull(supplied.autoResumeStatus ?? previous.autoResumeStatus),
    continuation: normalizeContinuation(continuationInput),
  };
}

function resumePolicy(safety = {}) {
  const policy = objectValue(safety.workTaskAutoResumePolicy);
  const continuationRole = resolveCodexRole('continuation');
  return {
    enabled: policy.enabled !== false,
    maxAutoResumeCount: positiveInteger(policy.maxAutoResumeCount, 3, 0, 100),
    maxConsecutiveTimeouts: positiveInteger(policy.maxConsecutiveTimeouts, 3, 1, 100),
    maxTotalRuntimeMs: positiveInteger(policy.maxTotalRuntimeMs, 4 * 60 * 60 * 1000, 60000, 7 * 24 * 60 * 60 * 1000),
    maxRepeatedProgressCount: positiveInteger(policy.maxRepeatedProgressCount, 2, 0, 100),
    continuationScanIntervalMs: positiveInteger(policy.continuationScanIntervalMs, 60000, 10000, 60 * 60 * 1000),
    codexHandoffAfterMs: positiveInteger(policy.codexHandoffAfterMs, 10 * 60 * 1000, 60000, 24 * 60 * 60 * 1000),
    codexUsageThresholdPercent: positiveInteger(policy.codexUsageThresholdPercent, 90, 1, 100),
    codexModel: stringOrNull(policy.codexModel) || continuationRole.model,
    codexThinking: stringOrNull(policy.codexThinking) || continuationRole.thinking,
    reuseCodexSession: policy.reuseCodexSession !== false,
    maxContinuationTasksPerSweep: positiveInteger(policy.maxContinuationTasksPerSweep, 8, 1, 50),
  };
}

function evaluateAutoResume(context, safety = {}) {
  const policy = resumePolicy(safety);
  if (!policy.enabled) return { ok: false, reason: '自動継続ポリシーが無効' };
  if (context.requiresUserConfirmation) return { ok: false, reason: 'ユーザー確認が必要' };
  if (context.workspaceConflict) return { ok: false, reason: '同じworkspace / checkoutが別Taskと競合中' };
  if (!context.nextStep) return { ok: false, reason: '次に行う作業がcheckpointへ保存されていない' };
  if (!context.nextActionImpact || !SAFE_IMPACTS.has(context.nextActionImpact)) {
    return { ok: false, reason: `次操作のimpactが自動継続対象外: ${context.nextActionImpact || '未指定'}` };
  }
  if (context.pendingAction && BLOCKED_ACTIONS.has(context.pendingAction)) {
    return { ok: false, reason: `自動継続禁止操作の直前: ${context.pendingAction}` };
  }
  if (context.autoResumeCount >= policy.maxAutoResumeCount) {
    return { ok: false, reason: `自動継続回数が上限${policy.maxAutoResumeCount}回に到達` };
  }
  if (context.consecutiveTimeouts >= policy.maxConsecutiveTimeouts) {
    return { ok: false, reason: `連続timeoutが上限${policy.maxConsecutiveTimeouts}回に到達` };
  }
  if (context.totalRuntimeMs >= policy.maxTotalRuntimeMs) {
    return { ok: false, reason: `累積実行時間が上限${policy.maxTotalRuntimeMs}msに到達` };
  }
  if (context.repeatedProgressCount >= policy.maxRepeatedProgressCount) {
    return { ok: false, reason: '同じcheckpointが繰り返されloopの可能性がある' };
  }
  return { ok: true, reason: '安全なローカル作業として自動継続可能' };
}

function recordTimeout(context, { timeoutKind = 'gateway_task', elapsedMs = 0, progressSignature = null, previousProgressSignature = undefined } = {}, safety = {}) {
  const previousSignature = previousProgressSignature === undefined
    ? stringOrNull(context?.progressSignature)
    : stringOrNull(previousProgressSignature);
  const next = normalizeResumeContext(context, { timeoutKind });
  next.timeoutCount += 1;
  next.consecutiveTimeouts += 1;
  next.totalRuntimeMs += positiveInteger(elapsedMs, 0);

  const signature = stringOrNull(progressSignature) || next.progressSignature;
  if (signature && previousSignature === signature) next.repeatedProgressCount += 1;
  else if (signature) next.repeatedProgressCount = 0;
  next.progressSignature = signature;

  const decision = evaluateAutoResume(next, safety);
  next.autoResumeEligible = decision.ok;
  next.autoResumeReason = decision.reason;
  next.autoResumeStatus = decision.ok ? 'pending' : 'blocked';
  return { context: next, decision };
}

function markAutoResumeStarted(context) {
  const next = normalizeResumeContext(context);
  next.autoResumeCount += 1;
  next.autoResumeStatus = 'resuming';
  next.autoResumeEligible = true;
  next.autoResumeReason = 'checkpointから自動継続を開始';
  return next;
}

function markManualResumeStarted(context) {
  const next = normalizeResumeContext(context);
  next.autoResumeStatus = 'manual';
  next.autoResumeEligible = false;
  next.autoResumeReason = 'blocking conditionを明示的に解消して再開';
  return next;
}

function markProgress(context, { progressSignature = null } = {}) {
  const next = normalizeResumeContext(context, { progressSignature });
  next.consecutiveTimeouts = 0;
  next.repeatedProgressCount = 0;
  next.autoResumeStatus = null;
  next.autoResumeEligible = false;
  next.autoResumeReason = null;
  const continuationStatus = String(next.continuation?.status || '').toLowerCase();
  if (!next.continuation?.agentId || continuationStatus !== 'completed') next.continuation = null;
  return next;
}

module.exports = {
  SAFE_IMPACTS,
  BLOCKED_ACTIONS,
  TIMEOUT_KINDS,
  normalizeResumeContext,
  resumePolicy,
  evaluateAutoResume,
  recordTimeout,
  markAutoResumeStarted,
  markManualResumeStarted,
  markProgress,
};
