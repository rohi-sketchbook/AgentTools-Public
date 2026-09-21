const fs = require('node:fs');
const path = require('node:path');
const { readJson } = require('../core/config');
const { findProcesses } = require('../core/processes');
const { createPlannedTask } = require('../core/taskPlans');
const { assertPathAllowed } = require('../core/paths');
const { createConfirmation, verifyConfirmation } = require('../core/confirmations');

function root() {
  const config = readJson('config/components.json');
  const value = config.components.localAi;
  if (!value) throw new Error('components.localAi is not configured');
  return value;
}

function localModule(relativePath) {
  return require(path.join(root(), relativePath));
}

function localConfig() {
  return localModule('config.js').loadConfig();
}

function encodePayload(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function numberOption(value, name, { integer = false, minimum = null, maximum = null } = {}) {
  if (value === undefined || value === null || value === '') return undefined;
  const number = Number(value);
  if (!Number.isFinite(number) || (integer && !Number.isInteger(number))) throw new Error(`${name} must be ${integer ? 'an integer' : 'a number'}`);
  if (minimum != null && number < minimum) throw new Error(`${name} must be >= ${minimum}`);
  if (maximum != null && number > maximum) throw new Error(`${name} must be <= ${maximum}`);
  return number;
}

async function status() {
  const { inspectStabilityMatrix } = localModule('adapters/stability-matrix.js');
  const { inspectComfyUi } = localModule('adapters/comfyui.js');
  const matrix = inspectStabilityMatrix();
  const [comfy, processResult] = await Promise.all([
    inspectComfyUi(),
    findProcesses('StabilityMatrix\\.exe|[\\/]ComfyUI[\\/]|ComfyUI\\\\main\\.py|ComfyUI/main\\.py'),
  ]);
  const processes = processResult.ok ? processResult.processes : [];
  const matrixProcesses = processes.filter((entry) => String(entry.name || '').toLowerCase() === 'stabilitymatrix.exe');
  const comfyProcesses = processes.filter((entry) => /comfyui/i.test(entry.commandLine || '') && String(entry.name || '').toLowerCase() !== 'stabilitymatrix.exe');

  let state = 'missing';
  if (matrix.installed && matrix.comfyUi.installed) state = comfy.online ? 'ready' : 'installed';
  if (comfy.online && comfy.error) state = 'degraded';

  return {
    ok: true,
    status: state,
    stabilityMatrix: {
      ...matrix,
      running: matrixProcesses.length > 0,
      pids: matrixProcesses.map((entry) => entry.pid),
    },
    comfyUi: {
      ...comfy,
      processDetected: comfyProcesses.length > 0,
      pids: comfyProcesses.map((entry) => entry.pid),
    },
    processProbeError: processResult.ok ? null : processResult.error,
  };
}

async function workflows() {
  const { listDetectedWorkflows, listRegisteredWorkflows } = localModule('adapters/workflows.js');
  const registered = listRegisteredWorkflows();
  const detected = listDetectedWorkflows();
  return {
    ok: true,
    registered,
    detected,
    counts: {
      registered: registered.length,
      executableRegistered: registered.filter((entry) => entry.executable).length,
      detected: detected.length,
      detectedApi: detected.filter((entry) => entry.format === 'api').length,
      detectedUi: detected.filter((entry) => entry.format === 'ui').length,
    },
  };
}

async function models(options = {}) {
  const { listModels } = localModule('adapters/comfyui.js');
  return listModels(options.folder || options.type);
}

async function start(options = {}) {
  const current = await status();
  if (current.comfyUi.online) {
    return { ok: true, changed: false, status: current, message: 'ComfyUI is already online.' };
  }
  if (!current.stabilityMatrix.installed) return { ok: false, error: 'Stability Matrix is not installed at the configured path.', status: current };
  if (!current.stabilityMatrix.comfyUi.installed) return { ok: false, error: 'ComfyUI package is not installed in Stability Matrix.', status: current };

  const config = localConfig();
  const runner = path.join(root(), 'scripts', 'start-comfyui.js');
  assertPathAllowed(runner);
  const profile = String(options.profile || 'standard').trim().toLowerCase();
  if (!['standard', 'h3-fast'].includes(profile)) return { ok: false, error: `unknown startup profile: ${profile}` };
  const payload = {
    startupTimeoutMs: numberOption(options.startupTimeoutMs, 'startupTimeoutMs', { integer: true, minimum: 5000, maximum: 300000 }) || 90000,
    profile,
  };
  return createPlannedTask({
    type: 'local-ai.start',
    title: options.title || 'Start ComfyUI via Stability Matrix',
    summary: `Plan Stability Matrix ${config.comfyUiPackageName} startup and wait for ${config.comfyUiEndpoint}`,
    command: {
      command: process.execPath,
      args: [runner, '--payload', encodePayload(payload)],
    },
    cwd: root(),
    metadata: {
      adapter: 'local-ai-start',
      runnerScript: runner,
      payload,
      timeoutMs: payload.startupTimeoutMs + 30000,
    },
  });
}

async function generate(options = {}) {
  const workflow = String(options.workflow || '').trim();
  if (!workflow) return { ok: false, error: 'workflow is required' };
  const { loadRegisteredWorkflow } = localModule('adapters/workflows.js');
  let registered;
  try {
    registered = loadRegisteredWorkflow(workflow);
  } catch (error) {
    return { ok: false, error: error.message };
  }

  const config = localConfig();
  const values = {
    prompt: options.prompt === undefined ? undefined : String(options.prompt),
    negativePrompt: options.negativePrompt === undefined ? undefined : String(options.negativePrompt),
    seed: numberOption(options.seed, 'seed', { integer: true, minimum: 0 }),
    steps: numberOption(options.steps, 'steps', { integer: true, minimum: 1, maximum: 1000 }),
    width: numberOption(options.width, 'width', { integer: true, minimum: 64, maximum: 16384 }),
    height: numberOption(options.height, 'height', { integer: true, minimum: 64, maximum: 16384 }),
    cfg: numberOption(options.cfg, 'cfg', { minimum: 0, maximum: 100 }),
    sampler: options.sampler === undefined ? undefined : String(options.sampler),
    scheduler: options.scheduler === undefined ? undefined : String(options.scheduler),
  };
  if (options.paramsJson) {
    let extra;
    try {
      extra = JSON.parse(String(options.paramsJson));
    } catch (error) {
      return { ok: false, error: `paramsJson must be valid JSON: ${error.message}` };
    }
    if (!extra || typeof extra !== 'object' || Array.isArray(extra)) return { ok: false, error: 'paramsJson must decode to an object' };
    Object.assign(values, extra);
  }

  const missingBindings = Object.entries(values)
    .filter(([, value]) => value !== undefined)
    .filter(([key]) => !Object.hasOwn(registered.manifest.bindings || {}, key))
    .map(([key]) => key);
  if (missingBindings.length > 0) {
    return { ok: false, error: `workflow ${workflow} does not define bindings for: ${missingBindings.join(', ')}` };
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outputInput = options.output || path.join(config.outputRoot, `${workflow}-${timestamp}`);
  const outputDir = assertPathAllowed(path.resolve(outputInput)).canonicalPath;
  const allowedOutputRoot = assertPathAllowed(config.outputRoot).canonicalPath;
  const relative = path.relative(allowedOutputRoot, outputDir);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return { ok: false, error: 'output must remain under local-ai outputRoot' };

  const runner = path.join(root(), 'scripts', 'run-generation.js');
  assertPathAllowed(runner);
  const payload = {
    workflow,
    values,
    outputDir,
    timeoutMs: numberOption(options.timeoutMs, 'timeoutMs', { integer: true, minimum: 10000, maximum: 86400000 }) || Number(config.generationTimeoutMs || 1800000),
  };
  return createPlannedTask({
    type: 'local-ai.generate',
    title: options.title || `Local AI: ${registered.manifest.name || workflow}`,
    summary: `Plan ComfyUI workflow ${workflow}`,
    command: {
      command: process.execPath,
      args: [runner, '--payload', encodePayload(payload)],
    },
    cwd: root(),
    outputPath: outputDir,
    metadata: {
      adapter: 'local-ai-generate',
      runnerScript: runner,
      payload,
      workflow,
      timeoutMs: payload.timeoutMs + 30000,
    },
  });
}

function readOwnedJob(promptId) {
  const config = localConfig();
  const safe = String(promptId || '').trim();
  if (!safe || !/^[A-Za-z0-9-]+$/.test(safe)) return null;
  const jobPath = path.join(config.stateRoot, 'jobs', `${safe}.json`);
  if (!fs.existsSync(jobPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(jobPath, 'utf8'));
  } catch {
    return null;
  }
}

async function interrupt(options = {}) {
  const { request, interrupt: interruptComfy } = localModule('adapters/comfyui.js');
  const queueResult = await request('/queue', { timeoutMs: 5000 });
  if (!queueResult.ok) return { ok: false, error: `ComfyUI queue unavailable: ${queueResult.error}` };
  const running = Array.isArray(queueResult.data?.queue_running) ? queueResult.data.queue_running : [];
  const promptId = running.length > 0 && Array.isArray(running[0]) ? running[0][1] : null;
  if (!promptId) return { ok: true, changed: false, message: 'No ComfyUI job is currently running.' };
  const owned = readOwnedJob(promptId);
  if (!owned || owned.ownedBy !== 'AgentTools' || owned.status !== 'running') {
    return { ok: false, error: 'Current ComfyUI job is not owned by AgentTools; refusing to interrupt it.', promptId };
  }

  const payload = { promptId };
  if (!options.confirmToken) {
    return createConfirmation({ action: 'localAi.interrupt', impact: 'destructive', summary: `Interrupt AgentTools ComfyUI job ${promptId}`, payload, preview: owned });
  }
  const confirmed = verifyConfirmation({ action: 'localAi.interrupt', token: options.confirmToken, payload, impact: 'destructive', consume: true });
  if (!confirmed.ok) return confirmed;
  const result = await interruptComfy();
  return { ok: result.ok, changed: result.ok, promptId, error: result.ok ? null : result.error };
}

async function free(options = {}) {
  const { request, freeMemory } = localModule('adapters/comfyui.js');
  const queueResult = await request('/queue', { timeoutMs: 5000 });
  if (!queueResult.ok) return { ok: false, error: `ComfyUI queue unavailable: ${queueResult.error}` };
  const running = Array.isArray(queueResult.data?.queue_running) ? queueResult.data.queue_running.length : 0;
  const pending = Array.isArray(queueResult.data?.queue_pending) ? queueResult.data.queue_pending.length : 0;
  if (running > 0 || pending > 0) return { ok: false, error: 'ComfyUI has active or pending jobs; refusing to free models.', queue: { running, pending } };
  const unloadModels = options.unloadModels !== false && options.unloadModels !== 'false';
  const freeMemoryFlag = options.freeMemory !== false && options.freeMemory !== 'false';
  const payload = { unloadModels, freeMemory: freeMemoryFlag };
  if (!options.confirmToken) {
    return createConfirmation({ action: 'localAi.free', impact: 'write', summary: 'Free ComfyUI VRAM/models', payload, preview: { queue: { running, pending }, ...payload } });
  }
  const confirmed = verifyConfirmation({ action: 'localAi.free', token: options.confirmToken, payload, impact: 'write', consume: true });
  if (!confirmed.ok) return confirmed;
  const result = await freeMemory(payload);
  return { ok: result.ok, changed: result.ok, error: result.ok ? null : result.error };
}

module.exports = {
  status,
  workflows,
  models,
  start,
  generate,
  interrupt,
  free,
};
