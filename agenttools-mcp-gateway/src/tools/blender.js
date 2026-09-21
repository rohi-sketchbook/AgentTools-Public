const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { readJson } = require('../core/config');
const { findProcesses } = require('../core/processes');
const { createPlannedTask } = require('../core/taskPlans');
const { assertPathAllowed } = require('../core/paths');
const { resolveBlenderExecutable, windowsPowerShellExecutable } = require('../core/executables');
const { encodePowerShellCommand } = require('../core/runner');

function checkTcp(host, port, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;

    function finish(ok, error = null) {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ ok, host, port, error });
    }

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false, 'timeout'));
    socket.once('error', (error) => finish(false, error.message));
    socket.connect(port, host);
  });
}

async function status() {
  const config = readJson('config/components.json');
  const root = config.components.blenderMcp;
  const port = config.ports.blenderMcp;
  const scripts = ['Start-BlenderMCP.bat', 'Stop-BlenderMCP.bat', 'Restart-BlenderMCP.bat', 'Status-BlenderMCP.bat'];
  const [tcp, processes] = await Promise.all([
    checkTcp('127.0.0.1', port),
    findProcesses('blender.exe|BlenderMCP'),
  ]);

  return {
    ok: fs.existsSync(root),
    root,
    port,
    tcp,
    scripts: scripts.map((name) => ({ name, path: path.join(root, name), exists: fs.existsSync(path.join(root, name)) })),
    processes: processes.processes.map((p) => ({ pid: p.ProcessId, name: p.Name, commandLine: p.CommandLine })),
    error: processes.error,
  };
}

async function render(options = {}) {
  const blend = options.blend || options.file || options.input;
  if (!blend) return { ok: false, error: 'blend path is required. Use --blend <scene.blend>.' };
  const blendPath = assertPathAllowed(blend).canonicalPath;
  if (!fs.existsSync(blendPath) || !fs.statSync(blendPath).isFile() || path.extname(blendPath).toLowerCase() !== '.blend') {
    return { ok: false, error: `Blend file not found or invalid: ${blendPath}` };
  }
  const outputPath = options.output ? assertPathAllowed(path.resolve(options.output)).canonicalPath : null;
  const frame = options.frame == null || options.frame === '' ? null : Number(options.frame);
  if (frame != null && (!Number.isInteger(frame) || frame < 0)) {
    return { ok: false, error: `frame must be a non-negative integer: ${options.frame}` };
  }
  const blenderExe = resolveBlenderExecutable(options.blenderExe || null);

  const args = ['-b', blendPath];
  if (outputPath) args.push('-o', outputPath);
  if (frame != null) args.push('-f', String(frame));
  else args.push('-a');

  return createPlannedTask({
    type: 'blender.render',
    title: options.title || `Blender render: ${path.basename(blendPath)}`,
    summary: `Plan Blender render for ${blendPath}`,
    command: {
      command: blenderExe,
      args,
    },
    cwd: options.cwd || path.dirname(blendPath),
    inputPath: blendPath,
    outputPath,
    metadata: {
      adapter: 'blender',
      blenderExe,
      frame,
    },
  });
}

async function startMcp() {
  const config = readJson('config/components.json');
  const script = path.join(config.components.blenderMcp, 'Start-BlenderMCP.bat');
  assertPathAllowed(script);
  return createPlannedTask({
    type: 'blender.mcp.start',
    title: 'Start BlenderMCP',
    summary: 'Plan BlenderMCP start through existing Start-BlenderMCP.bat',
    command: {
      command: windowsPowerShellExecutable(),
      args: [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-EncodedCommand',
        encodePowerShellCommand(`& '${script.replace(/'/g, "''")}'`),
      ],
    },
    cwd: config.components.blenderMcp,
    inputPath: script,
    metadata: {
      adapter: 'blender-mcp',
    },
  });
}

module.exports = {
  status,
  render,
  startMcp,
};
