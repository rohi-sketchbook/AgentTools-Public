const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { projectRoot } = require('./config');
const { resolveCodexRole } = require('./codexModelPolicy');

const REVIEW_MODES = new Set(['codex', 'chatgpt']);
const CONTINUATION_MODES = new Set(['codex', 'chatgpt', 'off']);
const STATE_ROOT = path.resolve(process.env.AGENTTOOLS_STATE_ROOT || path.join(projectRoot, 'state'));
const SETTINGS_FILE = path.join(STATE_ROOT, 'workflow-settings.json');
const DEFAULT_SETTINGS = Object.freeze({
  schema: 'agenttools-workflow-settings/v1',
  codexReviewMode: 'chatgpt',
  autoContinuationMode: 'chatgpt',
  autoContinuationChangedAt: null,
});

function readSettings() {
  try {
    if (!fs.existsSync(SETTINGS_FILE)) return { ...DEFAULT_SETTINGS };
    const stored = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    const mode = REVIEW_MODES.has(stored.codexReviewMode) ? stored.codexReviewMode : DEFAULT_SETTINGS.codexReviewMode;
    const continuationMode = CONTINUATION_MODES.has(stored.autoContinuationMode)
      ? stored.autoContinuationMode
      : DEFAULT_SETTINGS.autoContinuationMode;
    return {
      schema: DEFAULT_SETTINGS.schema,
      codexReviewMode: mode,
      autoContinuationMode: continuationMode,
      autoContinuationChangedAt: typeof stored.autoContinuationChangedAt === 'string' && stored.autoContinuationChangedAt.trim()
        ? stored.autoContinuationChangedAt.trim()
        : null,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function writeSettings(settings) {
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  const temporary = `${SETTINGS_FILE}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
    fs.renameSync(temporary, SETTINGS_FILE);
  } finally {
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function reviewPolicy() {
  const settings = readSettings();
  const codexReviewEnabled = settings.codexReviewMode === 'codex';
  const reviewerRole = resolveCodexRole('review');
  return {
    ok: true,
    codexReviewMode: settings.codexReviewMode,
    codexReviewEnabled,
    requiresIndependentCodex: codexReviewEnabled,
    reviewer: codexReviewEnabled
      ? { actor: 'codex-reviewer', label: 'Codex Reviewer', provider: 'codex', model: reviewerRole.model, thinking: reviewerRole.thinking, role: reviewerRole.role, writeMode: 'read_only' }
      : { actor: 'chatgpt', label: 'ChatGPT', provider: 'host', model: null, thinking: null, role: null, writeMode: 'host_review' },
    fallbackReviewer: 'chatgpt',
    settingsFile: SETTINGS_FILE,
  };
}

function setReviewMode(mode) {
  const normalized = String(mode || '').trim().toLowerCase();
  if (!REVIEW_MODES.has(normalized)) {
    throw new Error(`mode must be one of: ${[...REVIEW_MODES].join(', ')}.`);
  }
  const settings = {
    ...readSettings(),
    codexReviewMode: normalized,
  };
  writeSettings(settings);
  return reviewPolicy();
}

function continuationPolicy() {
  const settings = readSettings();
  const mode = settings.autoContinuationMode;
  const continuationRole = resolveCodexRole('continuation');
  return {
    ok: true,
    mode,
    enabled: mode !== 'off',
    executor: mode === 'codex'
      ? { actor: 'codex', label: 'Codex', provider: 'codex', model: continuationRole.model, thinking: continuationRole.thinking, role: continuationRole.role }
      : mode === 'chatgpt'
        ? { actor: 'chatgpt', label: 'ChatGPT', provider: 'host', model: null }
        : null,
    description: mode === 'codex'
      ? 'ChatGPT executionが途切れた安全なローカル作業をCodexへ自動引き継ぎ'
      : mode === 'chatgpt'
        ? 'checkpointのみ保存し、次のChatGPT executionで再開'
        : '自動継続しない',
    changedAt: settings.autoContinuationChangedAt || null,
    settingsFile: SETTINGS_FILE,
  };
}

function setContinuationMode(mode) {
  const normalized = String(mode || '').trim().toLowerCase();
  if (!CONTINUATION_MODES.has(normalized)) {
    throw new Error(`mode must be one of: ${[...CONTINUATION_MODES].join(', ')}.`);
  }
  const settings = {
    ...readSettings(),
    autoContinuationMode: normalized,
    autoContinuationChangedAt: new Date().toISOString(),
  };
  writeSettings(settings);
  return continuationPolicy();
}

module.exports = {
  REVIEW_MODES,
  CONTINUATION_MODES,
  SETTINGS_FILE,
  DEFAULT_SETTINGS,
  readSettings,
  reviewPolicy,
  setReviewMode,
  continuationPolicy,
  setContinuationMode,
};
