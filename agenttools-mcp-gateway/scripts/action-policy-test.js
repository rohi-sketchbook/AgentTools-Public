#!/usr/bin/env node
const assert = require('node:assert/strict');
const {
  createConfirmation,
  verifyConfirmation,
  loadSafety,
  policyDecision,
} = require('../src/core/confirmations');
const discord = require('../src/tools/discord');
const taskRunner = require('../src/core/taskRunner');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function main() {
  const safety = loadSafety();
  assert.equal(safety.actionPolicy?.enabled, true);

  assert.deepEqual(policyDecision(safety, 'discord.post', 'external', true), {
    ok: true,
    reason: 'action allowlist permits execution',
  });
  assert.equal(policyDecision(safety, 'discord.post', 'external', false).ok, false);
  assert.match(policyDecision(safety, 'discord.post', 'external', false).reason, /explicit user request/i);

  assert.equal(policyDecision(safety, 'git.commit', 'write', true).ok, true);
  assert.equal(policyDecision(safety, 'git.push', 'external', true).ok, true);
  assert.equal(policyDecision(safety, 'discord.restart', 'external', true).ok, false);
  assert.equal(policyDecision(safety, 'fs.deleteRecursive', 'destructive', true).ok, false);
  assert.equal(policyDecision(safety, 'task.run', 'longRunning', true).ok, true);
  assert.equal(policyDecision(safety, 'task.run', 'longRunning', false).ok, false);
  assert.equal(policyDecision(safety, 'process.start', 'write', true).ok, false);
  assert.equal(policyDecision(safety, 'unknown.action', 'external', true).ok, false);
  assert.equal(policyDecision(safety, 'git.commit', 'unsupported-impact', true).ok, false);

  const legacyBooleansTrue = clone(safety);
  legacyBooleansTrue.writeActionsEnabled = true;
  legacyBooleansTrue.externalActionsEnabled = true;
  legacyBooleansTrue.destructiveActionsEnabled = true;
  legacyBooleansTrue.longRunningActionsEnabled = true;
  assert.equal(policyDecision(legacyBooleansTrue, 'discord.restart', 'external', true).ok, false);
  assert.equal(policyDecision(legacyBooleansTrue, 'process.start', 'write', true).ok, false);
  assert.equal(policyDecision(legacyBooleansTrue, 'fs.deleteRecursive', 'destructive', true).ok, false);
  assert.equal(policyDecision(legacyBooleansTrue, 'task.run', 'longRunning', true).ok, true);

  const missingPolicy = clone(safety);
  delete missingPolicy.actionPolicy;
  missingPolicy.externalActionsEnabled = true;
  assert.equal(policyDecision(missingPolicy, 'discord.post', 'external', true).ok, false);
  assert.match(policyDecision(missingPolicy, 'discord.post', 'external', true).reason, /missing.*disabled/i);

  const disabledPolicy = clone(safety);
  disabledPolicy.actionPolicy.enabled = false;
  disabledPolicy.externalActionsEnabled = true;
  assert.equal(policyDecision(disabledPolicy, 'discord.post', 'external', true).ok, false);

  const payload = { message: 'policy test', attachments: [] };
  const confirmation = createConfirmation({
    action: 'discord.post',
    impact: 'external',
    summary: 'policy test',
    payload,
    userExplicitlyRequested: true,
  });
  assert.equal(confirmation.policyDecision.ok, true);

  const mismatch = verifyConfirmation({
    action: 'discord.post',
    token: confirmation.confirmToken,
    payload,
    impact: 'external',
    consume: false,
    userExplicitlyRequested: false,
  });
  assert.equal(mismatch.ok, false);
  assert.match(mismatch.reason, /explicit-user-request assertion mismatch/i);

  const verified = verifyConfirmation({
    action: 'discord.post',
    token: confirmation.confirmToken,
    payload,
    impact: 'external',
    consume: true,
    userExplicitlyRequested: true,
  });
  assert.equal(verified.ok, true);

  const reused = verifyConfirmation({
    action: 'discord.post',
    token: confirmation.confirmToken,
    payload,
    impact: 'external',
    consume: true,
    userExplicitlyRequested: true,
  });
  assert.equal(reused.ok, false);
  assert.match(reused.reason, /not found|expired/i);

  assert.equal(taskRunner._internal.executionBlockedReason(safety, { metadata: { adapter: 'unity', requiresNetwork: false } }, true), null);
  assert.match(taskRunner._internal.executionBlockedReason(safety, { metadata: { adapter: 'arbitrary-shell', requiresNetwork: false } }, true), /not allowlisted/i);
  assert.match(taskRunner._internal.executionBlockedReason(safety, { metadata: { adapter: 'hyperframes', requiresNetwork: true } }, true), /network-requiring task adapter is not allowlisted/i);
  assert.match(taskRunner._internal.executionBlockedReason(safety, { metadata: { adapter: 'unity', requiresNetwork: false } }, false), /explicit user request/i);

  const preview = discord._internal.buildSendPreview({
    message: 'explicit request test',
    userExplicitlyRequested: true,
  });
  assert.equal(preview.userExplicitlyRequested, true);
  assert.deepEqual(preview.attachments, []);

  assert.throws(() => discord._internal.buildSendPreview({
    message: 'outside path test',
    attachment: 'C:/Windows/System32/notepad.exe',
    userExplicitlyRequested: true,
  }), /not allowed|denied|outside|path/i);

  process.stdout.write(JSON.stringify({
    ok: true,
    allowed: {
      write: safety.actionPolicy.allowedWriteActions,
      external: safety.actionPolicy.allowedExternalActions,
    },
    blockedCategories: ['destructive', 'arbitrary external/write', 'unsupported/network longRunning'],
    allowedLongRunningAdapters: safety.actionPolicy.allowedLongRunningAdapters,
  }, null, 2) + '\n');
}

try {
  main();
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, error: error.stack || error.message }, null, 2) + '\n');
  process.exitCode = 1;
}
