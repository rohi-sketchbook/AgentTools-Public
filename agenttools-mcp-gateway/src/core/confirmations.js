const crypto = require('node:crypto');
const { readJson } = require('./config');
const { readState, mutateState } = require('./stateFile');

const STORE_FILE = 'confirmations.json';

function nowIso() {
  return new Date().toISOString();
}

function stableStringify(value) {
  if (value === undefined) return '"[undefined]"';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function payloadHash(payload) {
  return crypto.createHash('sha256').update(stableStringify(payload ?? {})).digest('hex');
}

function loadSafety() {
  try {
    return readJson('config/safety.json');
  } catch {
    return {
      writeActionsEnabled: false,
      externalActionsEnabled: false,
      destructiveActionsEnabled: false,
      longRunningActionsEnabled: false,
      actionPolicy: {
        enabled: true,
        allowedWriteActions: [],
        allowedExternalActions: [],
        allowedDestructiveActions: [],
        allowedLongRunningActions: [],
        allowedLongRunningAdapters: [],
        allowedNetworkTaskAdapters: [],
        explicitUserRequestRequired: [],
      },
      confirmationTtlMs: 900000,
      maxPreviewChars: 12000,
    };
  }
}

function loadStore() {
  return readState(STORE_FILE, { confirmations: [] });
}

function prune(confirmations, now = Date.now()) {
  return confirmations.filter((entry) => Date.parse(entry.expiresAt) > now && !entry.consumedAt);
}

function actionPolicyList(safety, impact) {
  const policy = safety?.actionPolicy;
  if (!policy || policy.enabled !== true) return null;
  if (impact === 'external') return Array.isArray(policy.allowedExternalActions) ? policy.allowedExternalActions : [];
  if (impact === 'destructive') return Array.isArray(policy.allowedDestructiveActions) ? policy.allowedDestructiveActions : [];
  if (impact === 'longRunning') return Array.isArray(policy.allowedLongRunningActions) ? policy.allowedLongRunningActions : [];
  if (impact === 'write') return Array.isArray(policy.allowedWriteActions) ? policy.allowedWriteActions : [];
  return null;
}

function policyDecision(safety, action, impact, userExplicitlyRequested = false) {
  const allowlist = actionPolicyList(safety, impact);
  if (!allowlist) {
    return { ok: false, reason: 'action-scoped safety policy is missing, disabled, or the impact is unsupported' };
  }
  if (!allowlist.includes(action)) {
    return { ok: false, reason: `${action} is not allowlisted for ${impact} actions` };
  }
  const explicitRequired = Array.isArray(safety.actionPolicy?.explicitUserRequestRequired)
    && safety.actionPolicy.explicitUserRequestRequired.includes(action);
  if (explicitRequired && !userExplicitlyRequested) {
    return { ok: false, reason: `${action} requires an explicit user request` };
  }
  return { ok: true, reason: 'action allowlist permits execution' };
}

function safetyPolicySummary(safety) {
  const policy = safety?.actionPolicy;
  return {
    writeActionsEnabled: Boolean(safety.writeActionsEnabled),
    externalActionsEnabled: Boolean(safety.externalActionsEnabled),
    destructiveActionsEnabled: Boolean(safety.destructiveActionsEnabled),
    longRunningActionsEnabled: Boolean(safety.longRunningActionsEnabled),
    actionPolicy: policy && policy.enabled === true ? {
      enabled: true,
      allowedWriteActions: Array.isArray(policy.allowedWriteActions) ? policy.allowedWriteActions : [],
      allowedExternalActions: Array.isArray(policy.allowedExternalActions) ? policy.allowedExternalActions : [],
      allowedDestructiveActions: Array.isArray(policy.allowedDestructiveActions) ? policy.allowedDestructiveActions : [],
      allowedLongRunningActions: Array.isArray(policy.allowedLongRunningActions) ? policy.allowedLongRunningActions : [],
      allowedLongRunningAdapters: Array.isArray(policy.allowedLongRunningAdapters) ? policy.allowedLongRunningAdapters : [],
      allowedNetworkTaskAdapters: Array.isArray(policy.allowedNetworkTaskAdapters) ? policy.allowedNetworkTaskAdapters : [],
      explicitUserRequestRequired: Array.isArray(policy.explicitUserRequestRequired) ? policy.explicitUserRequestRequired : [],
    } : { enabled: false },
  };
}

function createConfirmation({ action, payload = {}, summary, impact = 'write', preview = null, ttlMs = null, userExplicitlyRequested = false }) {
  const safety = loadSafety();
  const ttl = Number(ttlMs || safety.confirmationTtlMs || 900000);
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + ttl);
  const token = `ct_${crypto.randomBytes(18).toString('base64url')}`;
  const entry = {
    token,
    action,
    impact,
    summary,
    payloadHash: payloadHash(payload),
    userExplicitlyRequested: Boolean(userExplicitlyRequested),
    createdAt: createdAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };

  mutateState(STORE_FILE, { confirmations: [] }, (store) => {
    store.confirmations = prune(store.confirmations || []);
    store.confirmations.push(entry);
    return null;
  });

  return {
    ok: true,
    dryRun: true,
    requiresConfirmation: true,
    action,
    impact,
    summary,
    preview,
    confirmToken: token,
    expiresAt: entry.expiresAt,
    userExplicitlyRequested: Boolean(userExplicitlyRequested),
    policy: safetyPolicySummary(safety),
    policyDecision: policyDecision(safety, action, impact, userExplicitlyRequested),
  };
}

function verifyConfirmation({ action, token, payload = {}, impact = 'write', consume = false, userExplicitlyRequested = false }) {
  if (!token) return { ok: false, confirmed: false, reason: 'confirmToken is required' };

  const actualHash = payloadHash(payload);
  const safety = loadSafety();
  let response;

  mutateState(STORE_FILE, { confirmations: [] }, (store) => {
    const live = prune(store.confirmations || []);
    store.confirmations = live;
    const entry = live.find((candidate) => candidate.token === token);
    if (!entry) {
      response = { ok: false, confirmed: false, reason: 'confirmToken not found or expired' };
      return;
    }
    if (entry.action !== action) {
      response = { ok: false, confirmed: false, reason: `confirmToken action mismatch: expected ${entry.action}, got ${action}` };
      return;
    }
    if (entry.impact !== impact) {
      response = { ok: false, confirmed: false, reason: `confirmToken impact mismatch: expected ${entry.impact}, got ${impact}` };
      return;
    }
    if (entry.payloadHash !== actualHash) {
      response = { ok: false, confirmed: false, reason: 'confirmToken payload mismatch' };
      return;
    }
    if (Boolean(entry.userExplicitlyRequested) !== Boolean(userExplicitlyRequested)) {
      response = { ok: false, confirmed: false, reason: 'confirmToken explicit-user-request assertion mismatch' };
      return;
    }

    const decision = policyDecision(safety, action, impact, userExplicitlyRequested);
    if (!decision.ok) {
      if (consume) entry.consumedAt = nowIso();
      response = {
        ok: false,
        confirmed: true,
        blockedByPolicy: true,
        reason: decision.reason,
        policy: safetyPolicySummary(safety),
        confirmation: {
          action: entry.action,
          impact: entry.impact,
          summary: entry.summary,
          expiresAt: entry.expiresAt,
        },
      };
      return;
    }

    if (consume) entry.consumedAt = nowIso();
    response = {
      ok: true,
      confirmed: true,
      blockedByPolicy: false,
      policyDecision: decision,
      confirmation: {
        action: entry.action,
        impact: entry.impact,
        summary: entry.summary,
        expiresAt: entry.expiresAt,
      },
    };
  });

  return response;
}

function listConfirmations() {
  let result = [];
  mutateState(STORE_FILE, { confirmations: [] }, (store) => {
    const live = prune(store.confirmations || []);
    store.confirmations = live;
    result = live.map((entry) => ({
      action: entry.action,
      impact: entry.impact,
      summary: entry.summary,
      createdAt: entry.createdAt,
      expiresAt: entry.expiresAt,
    }));
  });
  return result;
}

module.exports = {
  createConfirmation,
  verifyConfirmation,
  listConfirmations,
  loadSafety,
  payloadHash,
  policyDecision,
  safetyPolicySummary,
};
