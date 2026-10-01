const fs = require('node:fs');
const path = require('node:path');
const { projectRoot, readJson } = require('../core/config');
const { versionOf, powershell } = require('../core/runner');
const { findProcesses } = require('../core/processes');
const { loadSafety, listConfirmations, safetyPolicySummary } = require('../core/confirmations');
const { resolveGitExecutable } = require('../core/executables');

async function summary() {
  const config = readJson('config/components.json');
  const components = Object.entries(config.components).map(([name, componentPath]) => ({
    name,
    path: componentPath,
    exists: fs.existsSync(componentPath),
  }));

  const [node, git, powershellResult] = await Promise.all([
    versionOf(process.execPath, ['--version']),
    versionOf(resolveGitExecutable(), ['--version']),
    powershell('$PSVersionTable.PSVersion.ToString()', { timeoutMs: 10000 }),
  ]);
  const powershellInfo = {
    command: 'powershell.exe',
    ok: powershellResult.ok,
    version: powershellResult.ok ? powershellResult.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) : null,
    error: powershellResult.ok ? null : powershellResult.error || powershellResult.stderr,
  };

  const [discordProcesses, blenderProcesses] = await Promise.all([
    findProcesses('codex-discord-connector|discord-chatgpt-bridge|discord-codex-bridge|cdc\\.js'),
    findProcesses('blender.exe|BlenderMCP'),
  ]);

  const safety = loadSafety();

  return {
    ok: true,
    mode: 'guarded gateway + autonomous watchdog + Work Task orchestration',
    projectRoot,
    safety: {
      ...safetyPolicySummary(safety),
      confirmationTtlMs: Number(safety.confirmationTtlMs || 900000),
      pendingConfirmations: listConfirmations().length,
    },
    components,
    commands: {
      node,
      git,
      powershell: powershellInfo,
    },
    processes: {
      discordCandidates: discordProcesses.processes.map((p) => ({ pid: p.pid, name: p.name })),
      blenderCandidates: blenderProcesses.processes.map((p) => ({ pid: p.pid, name: p.name })),
    },
    next: [
      'Keep AgentTools-DevSpaceWatchdog as an independent per-user Scheduled Task.',
      'Use action-scoped allowlists plus explicit user-request assertions and confirmTokens for approved side effects; registered trusted long-running adapters are allowed while destructive/arbitrary external/network/command execution remains blocked.'
    ],
  };
}

async function paths() {
  const config = readJson('config/components.json');
  return {
    ok: true,
    projectRoot: path.normalize(projectRoot),
    components: Object.fromEntries(Object.entries(config.components).map(([name, componentPath]) => [name, {
      path: componentPath,
      exists: fs.existsSync(componentPath),
    }])),
  };
}

module.exports = {
  summary,
  paths,
};
