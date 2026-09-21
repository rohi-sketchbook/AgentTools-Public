#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { loadConfig } = require('../config');
const { inspectComfyUi } = require('../adapters/comfyui');
const { inspectStabilityMatrix } = require('../adapters/stability-matrix');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    out[key] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  return out;
}

function decodePayload(value) {
  if (!value) return {};
  return JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8'));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const payload = decodePayload(args.payload);
  const config = loadConfig();
  const matrix = inspectStabilityMatrix();
  if (!matrix.installed) throw new Error(`Stability Matrix executable not found: ${config.stabilityMatrixExecutable}`);
  if (!matrix.comfyUi.installed) throw new Error(`Stability Matrix package is not installed: ${config.comfyUiPackageName}`);

  const current = await inspectComfyUi();
  if (current.online) {
    process.stdout.write(`${JSON.stringify({ event: 'already-online', endpoint: current.endpoint })}\n`);
    return;
  }

  const profile = String(payload.profile || 'standard').trim().toLowerCase();
  let child;
  let launchMode = 'stability-matrix';
  if (profile === 'h3-fast') {
    const comfyRoot = matrix.comfyUi.libraryPath;
    const pythonExe = path.join(comfyRoot, 'venv', 'Scripts', 'python.exe');
    const mainPy = path.join(comfyRoot, 'main.py');
    if (!fs.existsSync(pythonExe)) throw new Error(`ComfyUI Python not found: ${pythonExe}`);
    if (!fs.existsSync(mainPy)) throw new Error(`ComfyUI main.py not found: ${mainPy}`);
    const endpoint = new URL(config.comfyUiEndpoint);
    const port = endpoint.port || '8188';
    fs.mkdirSync(config.stateRoot, { recursive: true });
    const extraPathsConfig = path.join(config.stateRoot, 'comfy-agenttools-extra-paths.yaml');
    const customNodesRoot = path.resolve(__dirname, '..', 'comfy-custom-nodes').replace(/\\/g, '/');
    fs.writeFileSync(
      extraPathsConfig,
      `agenttools_local_ai:\n  custom_nodes: |-\n    ${customNodesRoot}\n`,
      'utf8',
    );
    child = spawn(pythonExe, [
      '-u', mainPy,
      '--port', port,
      '--extra-model-paths-config', extraPathsConfig,
      '--disable-all-custom-nodes',
      '--whitelist-custom-nodes', 'minimax-h3-turbo-compat',
      '--disable-dynamic-vram',
      '--lowvram',
      '--reserve-vram', '2',
      '--preview-method', 'auto',
      '--use-sage-attention',
    ], {
      cwd: comfyRoot,
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
    });
    launchMode = 'h3-fast';
  } else if (profile === 'standard') {
    child = spawn(config.stabilityMatrixExecutable, ['--launch-package', config.comfyUiPackageName], {
      cwd: config.stabilityMatrixRoot,
      detached: true,
      windowsHide: false,
      stdio: 'ignore',
    });
  } else {
    throw new Error(`Unknown ComfyUI startup profile: ${profile}`);
  }
  child.unref();

  fs.mkdirSync(config.stateRoot, { recursive: true });
  const ownershipPath = path.join(config.stateRoot, 'runtime.json');
  const ownership = {
    schema: 'agenttools-local-ai-runtime/v1',
    stabilityMatrixPid: launchMode === 'stability-matrix' ? (child.pid || null) : null,
    comfyUiPid: launchMode === 'h3-fast' ? (child.pid || null) : null,
    launchMode,
    profile,
    startedByAgentTools: true,
    package: config.comfyUiPackageName,
    endpoint: config.comfyUiEndpoint,
    startedAt: new Date().toISOString(),
  };
  fs.writeFileSync(ownershipPath, `${JSON.stringify(ownership, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify({ event: 'launch-requested', pid: child.pid || null, package: config.comfyUiPackageName })}\n`);

  const timeoutMs = Math.max(5000, Number(payload.startupTimeoutMs || 90000));
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const status = await inspectComfyUi();
    if (status.online) {
      fs.writeFileSync(ownershipPath, `${JSON.stringify({ ...ownership, comfyUiOnlineAt: new Date().toISOString() }, null, 2)}\n`, 'utf8');
      process.stdout.write(`${JSON.stringify({ event: 'online', endpoint: status.endpoint, responseMs: status.responseMs })}\n`);
      return;
    }
  }

  throw new Error(`ComfyUI did not become ready within ${timeoutMs} ms`);
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ event: 'error', error: error.message })}\n`);
  process.exitCode = 1;
});
