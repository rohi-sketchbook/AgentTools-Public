const assert = require('node:assert/strict');
const { loadCodexModelPolicy, resolveCodexRole } = require('../src/core/codexModelPolicy');

const policy = loadCodexModelPolicy();
assert.equal(policy.schema, 'agenttools-codex-model-policy/v1');
assert.deepEqual(resolveCodexRole('complex'), { role: 'complex', model: 'gpt-5.6-terra', thinking: 'high' });
assert.deepEqual(resolveCodexRole('continuation'), { role: 'continuation', model: 'gpt-5.6-terra', thinking: 'medium' });
assert.deepEqual(resolveCodexRole('implementation'), { role: 'implementation', model: 'gpt-5.6-terra', thinking: 'medium' });
assert.deepEqual(resolveCodexRole('review'), { role: 'review', model: 'gpt-5.6-terra', thinking: 'medium' });
assert.deepEqual(resolveCodexRole('lightweight'), { role: 'lightweight', model: 'gpt-5.6-luna', thinking: 'low' });
assert.deepEqual(resolveCodexRole('idleQa'), { role: 'idleQa', model: 'gpt-5.6-luna', thinking: 'low' });
assert.throws(() => resolveCodexRole('unknown'), /Unknown Codex model role/);
console.log('codex model policy tests passed');
