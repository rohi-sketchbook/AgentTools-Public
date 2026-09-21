const fs = require('node:fs');
const path = require('node:path');
const { readJson } = require('./config');
const { canonicalizePath, checkPathAllowed } = require('./paths');
const { resolvePackageBin, resolveNpxCachedPackageBin, resolveUnityExecutable, resolveBlenderExecutable, windowsPowerShellExecutable } = require('./executables');
const { encodePowerShellCommand } = require('./runner');

function samePath(a, b) {
  const aa = canonicalizePath(a);
  const bb = canonicalizePath(b);
  return process.platform === 'win32'
    ? aa.toLowerCase() === bb.toLowerCase()
    : aa === bb;
}

function insidePath(child, parent) {
  const c = canonicalizePath(child);
  const p = canonicalizePath(parent);
  const cc = process.platform === 'win32' ? c.toLowerCase() : c;
  const pp = process.platform === 'win32' ? p.toLowerCase() : p;
  return cc === pp || cc.startsWith(`${pp}${path.sep}`);
}

function sameArgs(actual, expected) {
  if (!Array.isArray(actual) || actual.length !== expected.length) return false;
  return actual.every((value, index) => String(value) === String(expected[index]));
}

function validateTaskCommand(task) {
  const command = task?.metadata?.command;
  const adapter = task?.metadata?.adapter;
  if (!command?.command || !Array.isArray(command.args)) {
    return { ok: false, reason: 'metadata.command is missing or malformed' };
  }

  const executable = String(command.command);
  if (!path.isAbsolute(executable)) {
    return { ok: false, reason: `task executable must be an absolute path: ${executable}` };
  }
  if (!fs.existsSync(executable) || !fs.statSync(executable).isFile()) {
    return { ok: false, reason: `task executable does not exist: ${executable}` };
  }
  const ext = path.extname(executable).toLowerCase();
  if (ext === '.bat' || ext === '.cmd') {
    return { ok: false, reason: 'Direct .bat/.cmd execution is forbidden.' };
  }

  try {
    const config = readJson('config/components.json');

    if (adapter === 'blender') {
      const expected = resolveBlenderExecutable(task?.metadata?.blenderExe || null);
      if (!samePath(executable, expected)) return { ok: false, reason: 'Blender executable does not match trusted installation.' };
      const inputPath = String(task?.metadata?.inputPath || '');
      if (!inputPath || !checkPathAllowed(inputPath).ok) return { ok: false, reason: 'Blender input must remain under an allowed root.' };
      const expectedArgs = ['-b', canonicalizePath(inputPath)];
      if (task.outputPath) expectedArgs.push('-o', canonicalizePath(task.outputPath));
      if (task?.metadata?.frame != null) expectedArgs.push('-f', String(task.metadata.frame));
      else expectedArgs.push('-a');
      if (!sameArgs(command.args, expectedArgs)) return { ok: false, reason: 'Blender arguments do not match the planned render operation.' };
      return { ok: true, executable, adapter };
    }

    if (adapter === 'blender-mcp') {
      const expectedPowerShell = windowsPowerShellExecutable();
      const inputPath = String(task?.metadata?.inputPath || '');
      const expectedScript = path.join(config.components.blenderMcp, 'Start-BlenderMCP.bat');
      if (!samePath(executable, expectedPowerShell)) return { ok: false, reason: 'BlenderMCP launcher must use trusted Windows PowerShell.' };
      if (!samePath(inputPath, expectedScript)) return { ok: false, reason: 'BlenderMCP task may only invoke the configured Start-BlenderMCP.bat.' };
      const expectedArgs = [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand',
        encodePowerShellCommand(`& '${expectedScript.replace(/'/g, "''")}'`),
      ];
      if (!sameArgs(command.args, expectedArgs)) return { ok: false, reason: 'BlenderMCP launcher arguments do not match the fixed encoded command.' };
      return { ok: true, executable, adapter };
    }

    if (adapter === 'local-ai-start' || adapter === 'local-ai-generate') {
      const localAiRoot = config.components.localAi;
      if (!localAiRoot || !insidePath(localAiRoot, config.components.agentToolsRoot)) {
        return { ok: false, reason: 'Local AI root is missing or outside AgentTools.' };
      }
      if (!samePath(executable, process.execPath)) return { ok: false, reason: 'Local AI tasks must launch through the current Node executable.' };
      const expectedScript = path.join(localAiRoot, 'scripts', adapter === 'local-ai-start' ? 'start-comfyui.js' : 'run-generation.js');
      if (!samePath(task?.metadata?.runnerScript || '', expectedScript)) return { ok: false, reason: 'Local AI runner script does not match the fixed adapter script.' };
      const payload = task?.metadata?.payload;
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { ok: false, reason: 'Local AI task payload is missing or invalid.' };
      const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
      const expectedArgs = [expectedScript, '--payload', encodedPayload];
      if (!sameArgs(command.args, expectedArgs)) return { ok: false, reason: 'Local AI task arguments do not match the planned payload.' };
      if (adapter === 'local-ai-generate') {
        const outputRoot = path.join(localAiRoot, 'output');
        if (!task.outputPath || !insidePath(task.outputPath, outputRoot)) return { ok: false, reason: 'Local AI generation output must remain under local-ai/output.' };
      }
      return { ok: true, executable, adapter };
    }

    if (adapter === 'unity') {
      const projectRoot = task?.metadata?.projectRoot || task?.metadata?.cwd;
      const method = task?.metadata?.method;
      if (!projectRoot || !method) return { ok: false, reason: 'Unity task is missing projectRoot or method.' };
      if (!checkPathAllowed(projectRoot).ok) return { ok: false, reason: 'Unity project root is outside allowed roots.' };
      const expected = resolveUnityExecutable(projectRoot, task?.metadata?.unityExe || null);
      if (!samePath(executable, expected)) return { ok: false, reason: 'Unity executable does not match project version/trusted installation.' };
      const expectedArgs = ['-batchmode', '-quit', '-projectPath', canonicalizePath(projectRoot), '-executeMethod', String(method), '-logFile', canonicalizePath(task.logPath)];
      if (!sameArgs(command.args, expectedArgs)) return { ok: false, reason: 'Unity arguments do not match the planned batch operation.' };
      return { ok: true, executable, adapter };
    }

    if (adapter === 'remotion') {
      const projectRoot = task?.metadata?.projectRoot;
      const composition = task?.metadata?.composition;
      if (!projectRoot || !composition || !insidePath(projectRoot, config.components.remotion)) {
        return { ok: false, reason: 'Remotion project/composition is invalid or outside the configured root.' };
      }
      if (!samePath(executable, process.execPath)) return { ok: false, reason: 'Remotion must launch through the current Node executable.' };
      const expectedScript = resolvePackageBin(projectRoot, '@remotion/cli', 'remotion');
      const expectedArgs = [expectedScript, 'render', String(composition)];
      if (task.outputPath) expectedArgs.push(canonicalizePath(task.outputPath));
      if (task?.metadata?.codec) expectedArgs.push('--codec', String(task.metadata.codec));
      if (!sameArgs(command.args, expectedArgs)) return { ok: false, reason: 'Remotion arguments do not match the planned render operation.' };
      return { ok: true, executable, adapter };
    }

    if (adapter === 'hyperframes') {
      const projectRoot = task?.metadata?.projectRoot;
      if (!projectRoot || !insidePath(projectRoot, config.components.hyperframes)) {
        return { ok: false, reason: 'HyperFrames project must be under the configured HyperFrames root.' };
      }
      if (!samePath(executable, process.execPath)) return { ok: false, reason: 'HyperFrames must launch through the current Node executable.' };
      const expectedVersion = task?.metadata?.expectedHyperframesVersion;
      if (!expectedVersion) return { ok: false, reason: 'HyperFrames task is missing its pinned project version.' };
      const expected = resolveNpxCachedPackageBin('hyperframes', expectedVersion, 'hyperframes');
      const expectedArgs = [expected.script, 'render'];
      if (task?.metadata?.composition) expectedArgs.push(String(task.metadata.composition));
      if (task.outputPath) expectedArgs.push('--output', canonicalizePath(task.outputPath));
      if (!sameArgs(command.args, expectedArgs)) return { ok: false, reason: 'HyperFrames arguments do not match the planned render operation.' };
      return { ok: true, executable, adapter };
    }

    return { ok: false, reason: `unsupported task adapter: ${adapter || '<none>'}` };
  } catch (error) {
    return { ok: false, reason: error.message };
  }
}

module.exports = {
  validateTaskCommand,
};
