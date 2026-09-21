const fs = require('node:fs');
const path = require('node:path');
const packageJson = require('../../package.json');
const { projectRoot, readJson } = require('../core/config');
const { loadSafety, listConfirmations, safetyPolicySummary } = require('../core/confirmations');

async function health() {
  const safety = loadSafety();
  const requiredFiles = [
    'src/cli.js',
    'src/mcp/stdio-prototype.js',
    'src/devspace/supervisor.mjs',
    'src/devspace/rotating-log.mjs',
    'src/core/devspaceWatchdog.js',
    'scripts/devspace-watchdog.js',
    'scripts/devspace-manual-control.js',
    'config/watchdog.json',
    'src/core/idleUiQa.js',
    'src/tools/uiqa.js',
    'scripts/idle-ui-qa.js',
    'scripts/idle-ui-qa-test.js',
    'config/idle-ui-qa.json',
    'src/core/unityWorktreeValidator.js',
    'scripts/unity-worktree-validator-test.js',
    'scripts/unity-worktree-session.js',
    'scripts/unity-worktree-session-cleanup.js',
    'config/unity-worktree-validator.json',
    'scripts/local-ai-test.js',
    'src/tools/localAi.js',
    'config/safety.json',
    'config/allowed-paths.json',
    'config/components.json',
    'config/devspace.json',
    'config/processes.json',
  ];
  const files = requiredFiles.map((relativePath) => ({
    path: relativePath,
    exists: fs.existsSync(path.join(projectRoot, relativePath)),
  }));
  const healthy = files.every((entry) => entry.exists);
  return {
    ok: healthy,
    status: healthy ? 'healthy' : 'degraded',
    name: packageJson.name,
    version: packageJson.version,
    pid: process.pid,
    uptimeSeconds: Math.floor(process.uptime()),
    checkedAt: new Date().toISOString(),
    transport: 'stdio-prototype',
    files,
    safety: safetyPolicySummary(safety),
  };
}

async function info() {
  const safety = loadSafety();
  const components = readJson('config/components.json');
  return {
    ok: true,
    name: packageJson.name,
    version: packageJson.version,
    projectRoot,
    pid: process.pid,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    transport: 'stdio-prototype',
    pendingConfirmations: listConfirmations().length,
    safety: safetyPolicySummary(safety),
    componentNames: Object.keys(components.components || {}),
    note: 'The current Gateway transport is stdio and is normally lifecycle-managed by its MCP host. Standalone daemon stop/restart is intentionally not emulated with unsafe process killing.',
  };
}

module.exports = { health, info };
