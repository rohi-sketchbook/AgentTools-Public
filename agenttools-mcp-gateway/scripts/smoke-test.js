#!/usr/bin/env node
const assert = require('node:assert/strict');
const path = require('node:path');
const { invoke, listTools } = require('../src/tools');
const { checkPathAllowed } = require('../src/core/paths');
const { createConfirmation, verifyConfirmation, loadSafety } = require('../src/core/confirmations');
const { redactSecrets, sanitizeLogText } = require('../src/core/redaction');
const { inputSchemaFor } = require('../src/mcp/toolSchemas');
const { agentToolsRoot, projectRoot } = require('../src/core/config');

async function main() {
  const results = [];
  function pass(name) { results.push({ name, ok: true }); }

  for (const name of [
    'task.start',
    'task.update',
    'task.skillCandidate',
    'task.complete',
    'task.fail',
    'task.run',
    'task.tailLog',
    'gateway.health',
    'devspace.health',
    'devspace.workspaceLookup',
    'devspace.recover',
    'watchdog.status',
    'watchdog.history',
    'activity.start',
    'activity.update',
    'activity.complete',
    'activity.list',
    'skill.list',
    'skill.get',
    'skill.propose',
    'skill.approve',
    'skill.reject',
    'skill.apply',
    'uiqa.status',
    'uiqa.issues',
    'uiqa.runOnce',
    'uiqa.resolve',
    'fs.readText',
    'fs.deleteRecursive',
    'process.find',
    'process.start',
    'git.log',
    'git.diff',
    'windowsUi.windows',
    'windowsUi.tree',
    'windowsUi.find',
    'windowsUi.invoke',
    'localAi.status',
    'localAi.workflows',
    'localAi.models',
    'localAi.start',
    'localAi.generate',
    'localAi.interrupt',
    'localAi.free',
  ]) {
    assert.ok(listTools().some((tool) => tool.name === name), `missing tool: ${name}`);
  }
  assert.ok(!listTools().some((tool) => tool.name.endsWith('._internal')), 'internal helpers must not be MCP tools');
  assert.equal(checkPathAllowed(agentToolsRoot).ok, true);
  assert.equal(checkPathAllowed('C:/Windows').ok, false);
  pass('tool registry and path policy');

  const confirmation = createConfirmation({
    action: 'smoke.test',
    impact: 'write',
    summary: 'smoke confirmation',
    payload: { a: 1 },
    preview: { ok: true },
  });
  assert.equal(confirmation.ok, true);
  const blocked = verifyConfirmation({ action: 'smoke.test', token: confirmation.confirmToken, payload: { a: 1 }, impact: 'write', consume: true });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.blockedByPolicy, true);
  const retry = verifyConfirmation({ action: 'smoke.test', token: confirmation.confirmToken, payload: { a: 1 }, impact: 'write', consume: true });
  assert.equal(retry.ok, false);
  assert.match(retry.reason, /not found|expired/i);
  pass('blocked confirmation is consumed while writeActionsEnabled=false');

  assert.match(redactSecrets('-accessToken abcdefghijklmnop'), /\[REDACTED\]/);
  assert.ok(sanitizeLogText('x'.repeat(2000), 100).includes('[TRUNCATED'));
  pass('redaction and truncation');

  const schema = inputSchemaFor('unity.batchMode');
  assert.equal(schema.additionalProperties, false);
  assert.ok(schema.required.includes('method'));
  const deleteSchema = inputSchemaFor('fs.deleteRecursive');
  assert.deepEqual(deleteSchema.required, ['path']);
  const processStartSchema = inputSchemaFor('process.start');
  assert.deepEqual(processStartSchema.required, ['id']);
  const workspaceLookupSchema = inputSchemaFor('devspace.workspaceLookup');
  assert.deepEqual(workspaceLookupSchema.required, ['path']);
  assert.deepEqual(workspaceLookupSchema.properties.mode.enum, ['checkout', 'worktree']);
  const recoverSchema = inputSchemaFor('devspace.recover');
  assert.equal(recoverSchema.additionalProperties, false);
  const watchdogHistorySchema = inputSchemaFor('watchdog.history');
  assert.equal(watchdogHistorySchema.additionalProperties, false);
  const skillProposeSchema = inputSchemaFor('skill.propose');
  assert.deepEqual(skillProposeSchema.required, ['skillPath', 'reason']);
  const skillApplySchema = inputSchemaFor('skill.apply');
  assert.equal(skillApplySchema.additionalProperties, false);
  assert.ok(Object.hasOwn(skillApplySchema.properties, 'confirmToken'));
  assert.ok(Object.hasOwn(skillApplySchema.properties, 'userExplicitlyRequested'));
  const taskUpdateSchema = inputSchemaFor('task.update');
  assert.deepEqual(taskUpdateSchema.required, ['actor']);
  assert.deepEqual(taskUpdateSchema.properties.workerStatus.enum, ['running', 'blocked', 'done']);
  const taskSkillCandidateSchema = inputSchemaFor('task.skillCandidate');
  assert.deepEqual(taskSkillCandidateSchema.required, ['actor', 'skillPath', 'reason']);
  assert.ok(Object.hasOwn(taskSkillCandidateSchema.properties, 'proposedContent'));
  assert.ok(Object.hasOwn(taskSkillCandidateSchema.properties, 'proposedContentFile'));
  const activityUpdateSchema = inputSchemaFor('activity.update');
  assert.deepEqual(activityUpdateSchema.required, ['id', 'actor']);
  assert.deepEqual(activityUpdateSchema.properties.workerStatus.enum, ['running', 'blocked', 'done']);
  const uiQaRunSchema = inputSchemaFor('uiqa.runOnce');
  assert.equal(uiQaRunSchema.additionalProperties, false);
  assert.ok(Object.hasOwn(uiQaRunSchema.properties, 'force'));
  const uiQaResolveSchema = inputSchemaFor('uiqa.resolve');
  assert.deepEqual(uiQaResolveSchema.required, ['key']);
  const windowsUiInvokeSchema = inputSchemaFor('windowsUi.invoke');
  assert.deepEqual(windowsUiInvokeSchema.required, ['process', 'window']);
  assert.equal(windowsUiInvokeSchema.additionalProperties, false);
  const localAiGenerateSchema = inputSchemaFor('localAi.generate');
  assert.deepEqual(localAiGenerateSchema.required, ['workflow']);
  assert.equal(localAiGenerateSchema.additionalProperties, false);
  const localAiModelsSchema = inputSchemaFor('localAi.models');
  assert.equal(localAiModelsSchema.additionalProperties, false);
  pass('mcp tool schemas');

  const status = await invoke('status', 'summary', {});
  assert.equal(status.ok, true);
  assert.ok(status.processes.discordCandidates.every((entry) => Object.hasOwn(entry, 'pid')));
  const gatewayHealth = await invoke('gateway', 'health', {});
  assert.equal(gatewayHealth.status, 'healthy');
  const devspaceHealth = await invoke('devspace', 'health', {});
  assert.ok(['healthy', 'degraded', 'stopped', 'unresponsive', 'unknown'].includes(devspaceHealth.status));
  const watchdogStatus = await invoke('watchdog', 'status', {});
  assert.equal(watchdogStatus.ok, true);
  assert.equal(typeof watchdogStatus.running, 'boolean');
  const uiQaStatus = await invoke('uiqa', 'status', {});
  assert.equal(uiQaStatus.ok, true);
  assert.equal(typeof uiQaStatus.developmentActive, 'boolean');
  assert.equal(typeof uiQaStatus.issues.open, 'number');
  const localAiStatus = await invoke('localAi', 'status', {});
  assert.equal(localAiStatus.ok, true);
  assert.ok(['ready', 'installed', 'degraded', 'missing'].includes(localAiStatus.status));
  assert.equal(typeof localAiStatus.comfyUi.online, 'boolean');
  const localAiWorkflows = await invoke('localAi', 'workflows', {});
  assert.equal(localAiWorkflows.ok, true);
  assert.equal(Array.isArray(localAiWorkflows.registered), true);
  assert.equal(Array.isArray(localAiWorkflows.detected), true);
  const fsExists = await invoke('fs', 'exists', { path: path.join(projectRoot, 'package.json') });
  assert.equal(fsExists.exists, true);
  const registered = await invoke('process', 'status', {});
  assert.equal(registered.ok, true);
  assert.ok(registered.registered.some((entry) => entry.id === 'devspace'));
  const safety = loadSafety();
  assert.equal(Boolean(safety.writeActionsEnabled), false);
  assert.equal(Boolean(safety.externalActionsEnabled), false);
  assert.equal(Boolean(safety.longRunningActionsEnabled), false);
  pass('status and safety flags');

  const taskCreate = await invoke('task', 'create', { type: 'smoke', title: 'Smoke task', status: 'planned', summary: 'smoke' });
  assert.equal(taskCreate.ok, true);
  const taskId = taskCreate.task.id;
  const taskRunPreview = await invoke('task', 'run', { taskId });
  assert.equal(taskRunPreview.ok, false);
  assert.match(taskRunPreview.error, /no runnable command/i);
  const tail = await invoke('task', 'tailLog', { taskId, limit: 5 });
  assert.equal(tail.ok, true);
  pass('task create and tailLog fallback');

  process.stdout.write(JSON.stringify({ ok: true, results }, null, 2) + '\n');
}

main().catch((error) => {
  process.stdout.write(JSON.stringify({ ok: false, error: error.message, stack: error.stack }, null, 2) + '\n');
  process.exitCode = 1;
});
