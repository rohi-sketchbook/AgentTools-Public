#!/usr/bin/env node
const assert = require('node:assert/strict');
const path = require('node:path');
const { detectWorkflowFormat, applyBindings, safeWorkflowId } = require('../../local-ai/adapters/workflows');
const { loadConfig } = require('../../local-ai/config');

function main() {
  const apiWorkflow = {
    '1': { class_type: 'CLIPTextEncode', inputs: { text: 'before' } },
    '2': { class_type: 'KSampler', inputs: { seed: 1, steps: 10 } },
  };
  const uiWorkflow = { nodes: [], links: [], version: 0.4 };
  assert.equal(detectWorkflowFormat(apiWorkflow), 'api');
  assert.equal(detectWorkflowFormat(uiWorkflow), 'ui');
  assert.equal(detectWorkflowFormat({}), 'unknown');

  const manifest = {
    bindings: {
      prompt: { node: '1', input: 'text' },
      seed: { node: '2', input: 'seed' },
      steps: { node: '2', input: 'steps' },
    },
  };
  const bound = applyBindings(apiWorkflow, manifest, { prompt: 'after', seed: 42, steps: 20 });
  assert.equal(bound['1'].inputs.text, 'after');
  assert.equal(bound['2'].inputs.seed, 42);
  assert.equal(bound['2'].inputs.steps, 20);
  assert.equal(apiWorkflow['1'].inputs.text, 'before', 'binding must not mutate source workflow');
  assert.equal(safeWorkflowId('image-basic'), 'image-basic');
  assert.throws(() => safeWorkflowId('../escape'));

  const config = loadConfig();
  assert.ok(path.isAbsolute(config.registeredWorkflowRoot));
  assert.ok(path.isAbsolute(config.inputRoot));
  assert.ok(path.isAbsolute(config.outputRoot));
  assert.ok(path.isAbsolute(config.stateRoot));

  process.stdout.write(JSON.stringify({ ok: true, tests: ['workflow-format', 'manifest-bindings', 'workflow-id-guard', 'config-paths'] }, null, 2) + '\n');
}

try {
  main();
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, error: error.message, stack: error.stack }, null, 2) + '\n');
  process.exitCode = 1;
}
