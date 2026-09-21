const fs = require('node:fs');
const path = require('node:path');
const { readJson } = require('../core/config');
const { createPlannedTask } = require('../core/taskPlans');
const { assertPathAllowed } = require('../core/paths');
const { findProcesses } = require('../core/processes');
const { resolveUnityExecutable } = require('../core/executables');
const { loadSafety } = require('../core/confirmations');

function defaultProject() {
  const config = readJson('config/components.json');
  const configured = config.components.vrmAvatarStudio;
  if (!configured) {
    throw new Error('No default Unity project is configured. Pass --project or set components.vrmAvatarStudio in config/components.local.json.');
  }
  return configured;
}

async function status(options = {}) {
  const checked = assertPathAllowed(path.resolve(options.project || defaultProject()));
  const project = checked.canonicalPath;
  const processes = await findProcesses('Unity\\.exe|Unity Hub\\.exe');
  const logCandidates = [
    path.join(project, 'Logs'),
    path.join(project, 'UserData', 'Logs'),
  ];

  return {
    ok: fs.existsSync(project),
    project,
    isUnityProject: fs.existsSync(path.join(project, 'Assets')) && fs.existsSync(path.join(project, 'Packages')),
    folders: {
      assets: fs.existsSync(path.join(project, 'Assets')),
      packages: fs.existsSync(path.join(project, 'Packages')),
      projectSettings: fs.existsSync(path.join(project, 'ProjectSettings')),
    },
    logs: logCandidates.map((candidate) => ({ path: candidate, exists: fs.existsSync(candidate) })),
    processes: processes.processes.map((p) => ({ pid: p.ProcessId, name: p.Name, commandLine: p.CommandLine })),
    error: processes.error,
  };
}

function makeUnityBatchPlan(options = {}, { buildOutputPath = null } = {}) {
  const checked = assertPathAllowed(path.resolve(options.project || defaultProject()));
  const project = checked.canonicalPath;
  const method = options.method || options.executeMethod;
  if (!method) return { ok: false, error: 'execute method is required. Use --method Namespace.Type.Method.' };
  if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(method)) return { ok: false, error: `Invalid Unity execute method: ${method}` };
  const prefixes = loadSafety().allowedUnityMethodPrefixes || [];
  if (prefixes.length === 0) {
    return { ok: false, error: 'No Unity execute-method prefixes are configured. Set allowedUnityMethodPrefixes in config/safety.local.json.' };
  }
  if (!prefixes.some((prefix) => method.startsWith(prefix))) {
    return { ok: false, error: `Unity execute method is outside allowed prefixes: ${method}`, allowedPrefixes: prefixes };
  }
  const unityExe = resolveUnityExecutable(project, options.unityExe || null);
  const logInput = options.log ? path.resolve(options.log) : path.join(project, 'Logs', 'agenttools-unity-batchmode.log');
  const logPath = assertPathAllowed(logInput).canonicalPath;
  const outputPath = buildOutputPath ? assertPathAllowed(buildOutputPath).canonicalPath : null;

  return createPlannedTask({
    type: buildOutputPath ? 'unity.build' : 'unity.batchMode',
    title: options.title || (buildOutputPath ? 'Unity build' : `Unity batchMode: ${method}`),
    summary: buildOutputPath
      ? `Plan Unity build through ${method}`
      : `Plan Unity batchMode execution for ${method}`,
    command: {
      command: unityExe,
      args: ['-batchmode', '-quit', '-projectPath', project, '-executeMethod', method, '-logFile', logPath],
    },
    cwd: project,
    inputPath: project,
    outputPath,
    logPath,
    metadata: {
      adapter: 'unity',
      projectRoot: project,
      unityExe,
      method,
      buildOutputPath: outputPath,
      shellFreeLauncher: true,
    },
  });
}

async function batchMode(options = {}) {
  return makeUnityBatchPlan(options);
}

async function build(options = {}) {
  const method = options.method || options.executeMethod || 'VrmAvatarStudio.Editor.BuildCommand.PerformBuild';
  const output = options.output ? path.resolve(options.output) : null;
  return makeUnityBatchPlan({
    ...options,
    method,
    title: options.title || 'Unity build',
  }, { buildOutputPath: output });
}

module.exports = {
  status,
  batchMode,
  build,
};
