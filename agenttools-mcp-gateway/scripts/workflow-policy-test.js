const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenttools-workflow-policy-test-'));
process.env.AGENTTOOLS_STATE_ROOT = root;

const policy = require('../src/core/workflowPolicy');

try {
  const initial = policy.reviewPolicy();
  assert.equal(initial.ok, true);
  assert.equal(initial.codexReviewMode, 'chatgpt');
  assert.equal(initial.codexReviewEnabled, false);
  assert.equal(initial.requiresIndependentCodex, false);
  assert.equal(initial.reviewer.actor, 'chatgpt');
  assert.equal(initial.reviewer.writeMode, 'host_review');

  const chatgpt = policy.setReviewMode('chatgpt');
  assert.equal(chatgpt.codexReviewMode, 'chatgpt');
  assert.equal(chatgpt.codexReviewEnabled, false);
  assert.equal(chatgpt.requiresIndependentCodex, false);
  assert.equal(chatgpt.reviewer.actor, 'chatgpt');
  assert.equal(chatgpt.reviewer.writeMode, 'host_review');
  assert.equal(policy.reviewPolicy().codexReviewMode, 'chatgpt');

  const codex = policy.setReviewMode('codex');
  assert.equal(codex.codexReviewMode, 'codex');
  assert.equal(codex.codexReviewEnabled, true);

  const continuationInitial = policy.continuationPolicy();
  assert.equal(continuationInitial.mode, 'chatgpt');
  assert.equal(continuationInitial.enabled, true);
  assert.equal(continuationInitial.executor.provider, 'host');

  const continuationHost = policy.setContinuationMode('chatgpt');
  assert.equal(continuationHost.mode, 'chatgpt');
  assert.equal(continuationHost.enabled, true);
  assert.equal(continuationHost.executor.provider, 'host');

  const continuationOff = policy.setContinuationMode('off');
  assert.equal(continuationOff.mode, 'off');
  assert.equal(continuationOff.enabled, false);
  assert.equal(continuationOff.executor, null);

  const continuationCodex = policy.setContinuationMode('codex');
  assert.equal(continuationCodex.executor.model, 'gpt-6.1-sol');
  assert.equal(continuationCodex.executor.thinking, 'medium');
  assert.equal(continuationCodex.executor.role, 'continuation');
  assert.equal(policy.reviewPolicy().codexReviewMode, 'codex', 'continuation setting must not reset review mode');
  assert.throws(() => policy.setContinuationMode('invalid'), /mode must be one of/);
  assert.throws(() => policy.setReviewMode('invalid'), /mode must be one of/);
  console.log('workflow policy tests passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
