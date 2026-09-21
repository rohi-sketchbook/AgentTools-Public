const crypto = require('node:crypto');

const GOAL_RESULTS = new Set(['continue', 'satisfied', 'blocked']);
const WORKER_RUN_STATUSES = new Set(['running', 'succeeded', 'blocked', 'crashed']);

function nowIso() {
  return new Date().toISOString();
}

function stringOrNull(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text || null;
}

function stringList(value, fallback = []) {
  if (value === undefined || value === null || value === '') return [...fallback];
  const list = Array.isArray(value) ? value : [value];
  return list.map((entry) => String(entry).trim()).filter(Boolean);
}

function booleanOr(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return value === true || value === 'true' || value === '1' || value === 'yes';
}

function positiveInteger(value, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(Math.trunc(number), max));
}

function timestampMs(value) {
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function workerPolicy(safety = {}) {
  const raw = safety.workTaskWorkerPolicy && typeof safety.workTaskWorkerPolicy === 'object'
    ? safety.workTaskWorkerPolicy
    : {};
  return {
    stallAfterMs: positiveInteger(raw.stallAfterMs, 10 * 60 * 1000, 1000, 24 * 60 * 60 * 1000),
    crashAfterMs: positiveInteger(raw.crashAfterMs, 30 * 60 * 1000, 1000, 7 * 24 * 60 * 60 * 1000),
    maxConsecutiveFailures: positiveInteger(raw.maxConsecutiveFailures, 3, 1, 100),
    circuitBreakerMs: positiveInteger(raw.circuitBreakerMs, 15 * 60 * 1000, 1000, 24 * 60 * 60 * 1000),
    maxRunsPerWorker: positiveInteger(raw.maxRunsPerWorker, 20, 1, 200),
  };
}

function hasGoalInput(input = {}) {
  return [
    'goalOutcome',
    'goalCriteria',
    'completionCriteria',
    'goalVerification',
    'verificationSteps',
    'goalConstraints',
    'goalEnforce',
  ].some((key) => input[key] !== undefined);
}

function normalizeGoalContract(existing = null, input = {}) {
  if (!existing && !hasGoalInput(input)) return null;
  const previous = existing && typeof existing === 'object' ? existing : {};
  const desiredOutcome = stringOrNull(input.goalOutcome ?? previous.desiredOutcome);
  const completionCriteria = stringList(
    input.goalCriteria ?? input.completionCriteria,
    previous.completionCriteria || [],
  );
  const verificationSteps = stringList(
    input.goalVerification ?? input.verificationSteps,
    previous.verificationSteps || [],
  );
  const constraints = stringList(input.goalConstraints, previous.constraints || []);
  const enforceCompletion = booleanOr(input.goalEnforce, previous.enforceCompletion ?? true);
  const goalChanged = hasGoalInput(input);
  const status = goalChanged
    ? 'active'
    : (['active', 'satisfied', 'blocked'].includes(previous.status) ? previous.status : 'active');

  return {
    schema: 'agenttools-goal-contract/v1',
    desiredOutcome,
    completionCriteria,
    verificationSteps,
    constraints,
    enforceCompletion,
    status,
    createdAt: previous.createdAt || nowIso(),
    updatedAt: nowIso(),
    satisfiedAt: goalChanged ? null : (previous.satisfiedAt || null),
    blockedAt: goalChanged ? null : (previous.blockedAt || null),
    lastJudgement: previous.lastJudgement || null,
    judgements: Array.isArray(previous.judgements) ? previous.judgements.slice(-19) : [],
  };
}

function setGoalContract(work, input = {}) {
  const next = normalizeGoalContract(work.goal, input);
  if (!next) return null;
  if (!next.desiredOutcome) throw new Error('goalOutcome is required when a Goal Contract is configured.');
  work.goal = next;
  return next;
}

function judgeGoal(work, input = {}, at = nowIso()) {
  if (!work.goal) throw new Error('Task has no Goal Contract.');
  const result = String(input.goalResult || input.result || '').trim().toLowerCase();
  if (!GOAL_RESULTS.has(result)) throw new Error(`goalResult must be one of: ${[...GOAL_RESULTS].join(', ')}.`);
  const evidence = stringList(input.evidence);
  const summary = stringOrNull(input.summary || input.message);
  if (result === 'satisfied' && work.goal.verificationSteps.length > 0 && evidence.length === 0) {
    throw new Error('Goal verification evidence is required before marking a verified goal satisfied.');
  }
  const judgement = {
    at,
    result,
    summary,
    evidence,
    actor: input.actor ? String(input.actor).trim().toLowerCase() : null,
  };
  work.goal.judgements ||= [];
  work.goal.judgements.push(judgement);
  if (work.goal.judgements.length > 20) work.goal.judgements.splice(0, work.goal.judgements.length - 20);
  work.goal.lastJudgement = judgement;
  work.goal.updatedAt = at;
  if (result === 'satisfied') {
    work.goal.status = 'satisfied';
    work.goal.satisfiedAt = at;
    work.goal.blockedAt = null;
  } else if (result === 'blocked') {
    work.goal.status = 'blocked';
    work.goal.blockedAt = at;
  } else {
    work.goal.status = 'active';
    work.goal.blockedAt = null;
    work.goal.satisfiedAt = null;
  }
  return work.goal;
}

function assertGoalAllowsCompletion(work, status) {
  if (status !== 'succeeded' || !work.goal?.enforceCompletion) return;
  if (work.goal.status !== 'satisfied') {
    throw new Error('Goal Contract is not satisfied. Run task.judge with goalResult=satisfied and verification evidence before completing this task.');
  }
}

function normalizeRun(run) {
  const status = WORKER_RUN_STATUSES.has(run?.status) ? run.status : 'running';
  return {
    id: run?.id || `run_${crypto.randomBytes(6).toString('hex')}`,
    attempt: positiveInteger(run?.attempt, 1, 1, 1000000),
    status,
    startedAt: run?.startedAt || nowIso(),
    lastHeartbeatAt: run?.lastHeartbeatAt || run?.startedAt || nowIso(),
    lastProgressAt: run?.lastProgressAt || run?.startedAt || nowIso(),
    endedAt: run?.endedAt || null,
    progressSignature: stringOrNull(run?.progressSignature),
    endReason: stringOrNull(run?.endReason),
    stalledAt: run?.stalledAt || null,
  };
}

function activeRun(worker) {
  const runs = Array.isArray(worker.runs) ? worker.runs : [];
  if (worker.currentRunId) {
    const current = runs.find((run) => run.id === worker.currentRunId && run.status === 'running');
    if (current) return current;
  }
  return runs.find((run) => run.status === 'running') || null;
}

function nextAttempt(worker) {
  const runs = Array.isArray(worker.runs) ? worker.runs : [];
  return runs.reduce((max, run) => Math.max(max, Number(run.attempt || 0)), 0) + 1;
}

function startWorkerRun(worker, policy, at, progressSignature = null) {
  worker.runs ||= [];
  const run = {
    id: `run_${crypto.randomBytes(6).toString('hex')}`,
    attempt: nextAttempt(worker),
    status: 'running',
    startedAt: at,
    lastHeartbeatAt: at,
    lastProgressAt: at,
    endedAt: null,
    progressSignature: stringOrNull(progressSignature),
    endReason: null,
    stalledAt: null,
  };
  worker.runs.push(run);
  if (worker.runs.length > policy.maxRunsPerWorker) {
    worker.runs.splice(0, worker.runs.length - policy.maxRunsPerWorker);
  }
  worker.currentRunId = run.id;
  worker.attempt = run.attempt;
  worker.startedAt = run.startedAt;
  return run;
}

function circuitIsOpen(worker, atMs) {
  const until = timestampMs(worker.circuitOpenUntil);
  return until !== null && until > atMs;
}

function updateWorkerLifecycle(worker, input = {}, safety = {}, at = nowIso()) {
  const policy = workerPolicy(safety);
  worker.runs = Array.isArray(worker.runs) ? worker.runs.map(normalizeRun) : [];
  worker.consecutiveFailures = positiveInteger(worker.consecutiveFailures, 0, 0, 1000000);
  worker.recoveryCount = positiveInteger(worker.recoveryCount, 0, 0, 1000000);

  const requestedStatus = input.status === undefined ? (worker.status || 'running') : String(input.status).trim();
  if (!['running', 'blocked', 'done'].includes(requestedStatus)) throw new Error('worker status must be running, blocked, or done.');
  const atMs = timestampMs(at) ?? Date.now();
  if (requestedStatus === 'running' && circuitIsOpen(worker, atMs)) {
    throw new Error(`Worker circuit breaker is open until ${worker.circuitOpenUntil}.`);
  }

  let run = activeRun(worker);
  const forceNewRun = booleanOr(input.forceNewRun, false);
  if (requestedStatus === 'running' && (!run || forceNewRun)) {
    if (run && forceNewRun) {
      run.status = 'blocked';
      run.endedAt = at;
      run.endReason = 'superseded by a new worker run';
    }
    run = startWorkerRun(worker, policy, at, input.progressSignature);
  }

  const previousPhase = worker.phase || null;
  const previousMessage = worker.message || null;
  const previousSignature = run?.progressSignature || null;
  const nextPhase = input.phase === undefined ? previousPhase : (stringOrNull(input.phase));
  const nextMessage = input.message === undefined ? previousMessage : stringOrNull(input.message);
  const nextSignature = stringOrNull(input.progressSignature) || previousSignature;
  const explicitProgress = booleanOr(input.progressMade, false);
  const signatureProgress = input.progressSignature !== undefined && nextSignature !== previousSignature;
  const semanticProgress = explicitProgress
    || (input.phase !== undefined && nextPhase !== previousPhase)
    || (input.message !== undefined && nextMessage !== previousMessage)
    || signatureProgress;

  if (run && requestedStatus === 'running') {
    run.lastHeartbeatAt = at;
    worker.lastHeartbeatAt = at;
    if (semanticProgress) {
      run.lastProgressAt = at;
      run.progressSignature = nextSignature;
      run.stalledAt = null;
      worker.lastProgressAt = at;
      if (explicitProgress || signatureProgress) worker.consecutiveFailures = 0;
    } else {
      worker.lastProgressAt = worker.lastProgressAt || run.lastProgressAt;
    }
    worker.health = 'healthy';
  }

  if (run && requestedStatus !== 'running' && run.status === 'running') {
    run.status = requestedStatus === 'done' ? 'succeeded' : 'blocked';
    run.endedAt = at;
    run.lastHeartbeatAt = at;
    run.endReason = stringOrNull(input.endReason) || (requestedStatus === 'done' ? 'worker finished' : 'worker blocked');
    worker.currentRunId = null;
    worker.lastHeartbeatAt = at;
    worker.health = requestedStatus === 'done' ? 'done' : 'blocked';
  }

  worker.status = requestedStatus;
  if (input.phase !== undefined) worker.phase = nextPhase;
  if (input.message !== undefined) worker.message = nextMessage;
  worker.updatedAt = at;
  return worker;
}

function reconcileWorker(worker, safety = {}, at = nowIso()) {
  const policy = workerPolicy(safety);
  const atMs = timestampMs(at) ?? Date.now();
  const before = JSON.stringify(worker);
  worker.runs = Array.isArray(worker.runs) ? worker.runs.map(normalizeRun) : [];
  worker.consecutiveFailures = positiveInteger(worker.consecutiveFailures, 0, 0, 1000000);

  const circuitUntil = timestampMs(worker.circuitOpenUntil);
  if (circuitUntil !== null && circuitUntil <= atMs) worker.circuitOpenUntil = null;

  let run = activeRun(worker);
  if (worker.status === 'running' && !run) {
    const legacyHeartbeat = worker.lastHeartbeatAt || worker.updatedAt || at;
    run = startWorkerRun(worker, policy, legacyHeartbeat, worker.progressSignature || null);
    worker.lastHeartbeatAt = legacyHeartbeat;
    worker.lastProgressAt = worker.lastProgressAt || legacyHeartbeat;
  }
  if (worker.status === 'running' && run) {
    const heartbeatAt = timestampMs(run.lastHeartbeatAt || worker.lastHeartbeatAt || run.startedAt) ?? atMs;
    const progressAt = timestampMs(run.lastProgressAt || worker.lastProgressAt || run.startedAt) ?? heartbeatAt;
    const heartbeatAge = Math.max(0, atMs - heartbeatAt);
    const progressAge = Math.max(0, atMs - progressAt);

    if (heartbeatAge >= policy.crashAfterMs) {
      run.status = 'crashed';
      run.endedAt = at;
      run.endReason = `heartbeat stale for ${heartbeatAge}ms`;
      worker.currentRunId = null;
      worker.status = 'blocked';
      worker.health = 'crashed';
      worker.crashedAt = at;
      worker.consecutiveFailures += 1;
      if (worker.consecutiveFailures >= policy.maxConsecutiveFailures) {
        worker.circuitOpenUntil = new Date(atMs + policy.circuitBreakerMs).toISOString();
        worker.health = 'circuit_open';
      }
    } else if (progressAge >= policy.stallAfterMs) {
      run.stalledAt ||= at;
      worker.health = 'stalled';
      worker.stalledAt ||= at;
    } else {
      run.stalledAt = null;
      worker.stalledAt = null;
      worker.health = 'healthy';
    }
  }

  return {
    changed: before !== JSON.stringify(worker),
    worker,
    health: worker.health || null,
    circuitOpenUntil: worker.circuitOpenUntil || null,
  };
}

function recoverWorker(worker, input = {}, safety = {}, at = nowIso()) {
  const atMs = timestampMs(at) ?? Date.now();
  if (circuitIsOpen(worker, atMs) && !booleanOr(input.force, false)) {
    throw new Error(`Worker circuit breaker is open until ${worker.circuitOpenUntil}.`);
  }
  if (booleanOr(input.force, false)) worker.circuitOpenUntil = null;
  worker.recoveryCount = positiveInteger(worker.recoveryCount, 0, 0, 1000000) + 1;
  worker.health = 'recovering';
  return updateWorkerLifecycle(worker, {
    ...input,
    status: 'running',
    forceNewRun: true,
    progressMade: false,
    endReason: null,
  }, safety, at);
}

module.exports = {
  GOAL_RESULTS,
  workerPolicy,
  normalizeGoalContract,
  setGoalContract,
  judgeGoal,
  assertGoalAllowsCompletion,
  updateWorkerLifecycle,
  reconcileWorker,
  recoverWorker,
  activeRun,
};
