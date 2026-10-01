const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  agentToolsRoot,
  projectRoot,
  deepMerge,
  expandConfigValue,
  localOverridePath,
  readJson,
  localOverridesEnabled,
} = require('../src/core/config');
const { loadConfig: loadLocalAiConfig } = require('../../local-ai/config');

const merged = deepMerge(
  { nested: { keep: true, replace: ['base'] }, untouched: 1 },
  { nested: { replace: ['local'], added: 2 } },
);
assert.deepEqual(merged, {
  nested: { keep: true, replace: ['local'], added: 2 },
  untouched: 1,
});

assert.equal(localOverridePath('config/components.json'), path.join('config', 'components.local.json'));

const expanded = expandConfigValue(
  {
    root: '${AGENTTOOLS_ROOT}/tool',
    home: '${USERPROFILE}/data',
    nested: ['${CUSTOM_VALUE}'],
  },
  {
    AGENTTOOLS_ROOT: 'D:/portable/AgentTools',
    USERPROFILE: 'D:/profiles/example',
    CUSTOM_VALUE: 'ok',
  },
);
assert.deepEqual(expanded, {
  root: 'D:/portable/AgentTools/tool',
  home: 'D:/profiles/example/data',
  nested: ['ok'],
});

const components = readJson('config/components.json');
assert.equal(path.resolve(components.components.agentToolsRoot), path.resolve(agentToolsRoot));

const previousDisableLocal = process.env.AGENTTOOLS_DISABLE_LOCAL_CONFIG;
process.env.AGENTTOOLS_DISABLE_LOCAL_CONFIG = '1';
try {
  assert.equal(localOverridesEnabled(), false);
  const publicComponents = readJson('config/components.json');
  assert.equal(path.resolve(publicComponents.components.agentToolsRoot), path.resolve(agentToolsRoot));
  assert.equal(publicComponents.components.devspace, null);
  assert.equal(publicComponents.components.vrmAvatarStudio, null);
  assert.equal(publicComponents.components.vrAvatarViewerSite, null);
  assert.equal(publicComponents.components.backgrounds, null);

  const publicAllowedPaths = readJson('config/allowed-paths.json');
  assert.ok(publicAllowedPaths.allowedRoots.some((entry) => path.resolve(entry) === path.resolve(agentToolsRoot)));

  const publicLocalAi = loadLocalAiConfig();
  assert.deepEqual(publicLocalAi.detectedWorkflowSources, []);
  assert.equal(path.resolve(publicLocalAi.stabilityMatrixRoot), path.resolve(os.homedir(), 'StabilityMatrix'));
} finally {
  if (previousDisableLocal === undefined) delete process.env.AGENTTOOLS_DISABLE_LOCAL_CONFIG;
  else process.env.AGENTTOOLS_DISABLE_LOCAL_CONFIG = previousDisableLocal;
}

const publicConfigFiles = [
  'allowed-paths.json',
  'components.json',
  'devspace.json',
  'discord.json',
  'safety.json',
  'unity-worktree-validator.json',
];
for (const name of publicConfigFiles) {
  const text = fs.readFileSync(path.join(projectRoot, 'config', name), 'utf8');
  assert.doesNotMatch(text, /\b[A-Za-z]:[\\/](?:codexapp|StabilityMatrix)(?:[\\/]|$)/i, name);
  assert.doesNotMatch(text, /\b[A-Za-z]:[\\/]Users[\\/][^<]/i, name);
  assert.doesNotMatch(text, /\brohi\b/i, name);
}

const localAiPublic = fs.readFileSync(path.join(agentToolsRoot, 'local-ai', 'config', 'local-ai.json'), 'utf8');
assert.doesNotMatch(localAiPublic, /\b[A-Za-z]:[\\/](?:codexapp|StabilityMatrix)(?:[\\/]|$)/i);
assert.doesNotMatch(localAiPublic, /\brohi\b/i);

console.log('config-portability-test: PASS');
