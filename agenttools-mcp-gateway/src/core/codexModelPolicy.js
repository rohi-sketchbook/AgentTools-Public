const { readJson } = require('./config');

const EXPLICIT_ONLY_MODELS = new Set(['gpt-6-astra']);

const DEFAULT_ROLES = Object.freeze({
  complex: Object.freeze({ model: 'gpt-5.6-terra', thinking: 'high' }),
  implementation: Object.freeze({ model: 'gpt-5.6-terra', thinking: 'medium' }),
  review: Object.freeze({ model: 'gpt-5.6-terra', thinking: 'medium' }),
  lightweight: Object.freeze({ model: 'gpt-5.6-luna', thinking: 'low' }),
  idleQa: Object.freeze({ model: 'gpt-5.6-luna', thinking: 'low' }),
  continuation: Object.freeze({ model: 'gpt-5.6-terra', thinking: 'medium' }),
});

function stringOrNull(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text || null;
}

function normalizeRole(value, fallback) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const requestedModel = stringOrNull(input.model) || fallback.model;
  return {
    model: EXPLICIT_ONLY_MODELS.has(requestedModel.toLowerCase()) ? fallback.model : requestedModel,
    thinking: stringOrNull(input.thinking) || fallback.thinking,
  };
}

function loadCodexModelPolicy() {
  let raw = {};
  try {
    raw = readJson('config/codex-models.json');
  } catch {
    raw = {};
  }
  const roles = {};
  for (const [name, fallback] of Object.entries(DEFAULT_ROLES)) {
    roles[name] = normalizeRole(raw.roles?.[name], fallback);
  }
  return {
    schema: 'agenttools-codex-model-policy/v1',
    roles,
  };
}

function resolveCodexRole(role) {
  const name = String(role || '').trim();
  const policy = loadCodexModelPolicy();
  const resolved = policy.roles[name];
  if (!resolved) throw new Error(`Unknown Codex model role: ${name || '(empty)'}`);
  return { role: name, ...resolved };
}

module.exports = {
  DEFAULT_ROLES,
  loadCodexModelPolicy,
  resolveCodexRole,
};
