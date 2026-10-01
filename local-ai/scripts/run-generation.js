#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { loadConfig } = require('../config');
const { postJson, getHistory, request } = require('../adapters/comfyui');
const { inspectStabilityMatrix } = require('../adapters/stability-matrix');
const { loadRegisteredWorkflow, applyBindings } = require('../adapters/workflows');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    out[key] = value;
  }
  return out;
}

function decodePayload(value) {
  if (!value) throw new Error('--payload is required');
  const text = Buffer.from(String(value), 'base64url').toString('utf8');
  return JSON.parse(text);
}

function sanitizeFilename(value) {
  const base = path.basename(String(value || 'output.bin'));
  return base.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_') || 'output.bin';
}

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function cleanupStagedInputs(stagingDir) {
  if (!stagingDir) return;
  try {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup only. A completed generation must not be turned into a failure
    // because Windows still has a transient handle on an input image.
  }
}

function applyMissingInputActions(workflow, spec) {
  const actions = Array.isArray(spec?.omitWhenMissing) ? spec.omitWhenMissing : [];
  for (const action of actions) {
    const nodeId = String(action?.node || '');
    if (!nodeId) continue;
    if (!action.input) {
      delete workflow[nodeId];
      continue;
    }
    const node = workflow[nodeId];
    if (!node?.inputs || typeof node.inputs !== 'object') continue;
    if (action.key) {
      const container = node.inputs[action.input];
      if (container && typeof container === 'object' && !Array.isArray(container)) {
        delete container[action.key];
      }
    } else {
      delete node.inputs[action.input];
    }
  }
}

function prepareWorkflow(config, registered, payloadValues = {}) {
  const values = { ...payloadValues };
  const workflow = structuredClone(registered.workflow);
  const inputFiles = registered.manifest?.inputFiles || {};
  const entries = Object.entries(inputFiles);
  if (entries.length === 0) {
    return { workflow: applyBindings(workflow, registered.manifest, values), stagingDir: null };
  }

  for (const [key, spec] of entries) {
    const value = values[key];
    const present = value !== undefined && value !== null && String(value).trim() !== '';
    if (!present && spec?.required) throw new Error(`workflow input image is required: ${key}`);
  }

  fs.mkdirSync(config.inputRoot, { recursive: true });
  const inputRoot = fs.realpathSync(config.inputRoot);
  const matrix = inspectStabilityMatrix();
  if (!matrix.comfyUi.installed || !matrix.comfyUi.libraryPath) {
    throw new Error('ComfyUI package path is unavailable for staging workflow input images');
  }

  const comfyInputRoot = path.join(matrix.comfyUi.libraryPath, 'input');
  fs.mkdirSync(comfyInputRoot, { recursive: true });
  const stagingDir = path.join(comfyInputRoot, 'AgentTools', `job-${Date.now()}-${process.pid}`);
  fs.mkdirSync(stagingDir, { recursive: true });

  try {
    let index = 0;
    for (const [key, spec] of entries) {
      const value = values[key];
      const present = value !== undefined && value !== null && String(value).trim() !== '';
      if (!present) {
        applyMissingInputActions(workflow, spec);
        delete values[key];
        continue;
      }

      const candidate = path.isAbsolute(String(value))
        ? path.resolve(String(value))
        : path.resolve(config.inputRoot, String(value));
      if (!fs.existsSync(candidate)) throw new Error(`local-ai input image not found for ${key}: ${value}`);
      const source = fs.realpathSync(candidate);
      if (!isInside(inputRoot, source)) {
        throw new Error(`workflow input ${key} must remain under local-ai inputRoot`);
      }
      if (!fs.statSync(source).isFile()) throw new Error(`workflow input ${key} must be a regular file`);

      index += 1;
      const stagedName = `${String(index).padStart(2, '0')}-${sanitizeFilename(source)}`;
      const destination = path.join(stagingDir, stagedName);
      fs.copyFileSync(source, destination);
      values[key] = path.relative(comfyInputRoot, destination).split(path.sep).join('/');
    }

    return {
      workflow: applyBindings(workflow, registered.manifest, values),
      stagingDir,
    };
  } catch (error) {
    cleanupStagedInputs(stagingDir);
    throw error;
  }
}

function collectOutputFiles(historyEntry) {
  const files = [];
  const outputs = historyEntry?.outputs || {};
  for (const [nodeId, output] of Object.entries(outputs)) {
    for (const key of ['images', 'gifs', 'videos', 'audio']) {
      const items = Array.isArray(output?.[key]) ? output[key] : [];
      for (const item of items) {
        if (!item?.filename) continue;
        files.push({
          nodeId,
          kind: key,
          filename: item.filename,
          subfolder: item.subfolder || '',
          type: item.type || 'output',
        });
      }
    }
  }
  return files;
}

async function downloadOutput(item, outputDir, index) {
  const params = new URLSearchParams({
    filename: item.filename,
    subfolder: item.subfolder || '',
    type: item.type || 'output',
  });
  const response = await request(`/view?${params.toString()}`, { timeoutMs: 30000 });
  if (!response.ok || !(response.data instanceof ArrayBuffer)) {
    throw new Error(`failed to fetch output ${item.filename}: ${response.error || 'invalid response'}`);
  }
  const prefix = String(index + 1).padStart(2, '0');
  const destination = path.join(outputDir, `${prefix}-${sanitizeFilename(item.filename)}`);
  fs.writeFileSync(destination, Buffer.from(response.data));
  return destination;
}

function writeJob(config, promptId, data) {
  const jobsRoot = path.join(config.stateRoot, 'jobs');
  fs.mkdirSync(jobsRoot, { recursive: true });
  const jobPath = path.join(jobsRoot, `${promptId}.json`);
  fs.writeFileSync(jobPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  return jobPath;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const payload = decodePayload(args.payload);
  const config = loadConfig();
  const registered = loadRegisteredWorkflow(payload.workflow);
  const prepared = prepareWorkflow(config, registered, payload.values || {});
  const workflow = prepared.workflow;
  const stagingDir = prepared.stagingDir;
  const outputDir = path.resolve(payload.outputDir || path.join(config.outputRoot, `${payload.workflow}-${Date.now()}`));
  const outputRoot = path.resolve(config.outputRoot);
  const relative = path.relative(outputRoot, outputDir);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    cleanupStagedInputs(stagingDir);
    throw new Error('outputDir must remain under local-ai outputRoot');
  }
  fs.mkdirSync(outputDir, { recursive: true });

  const clientId = `agenttools-${process.pid}-${Date.now()}`;
  const submit = await postJson('/prompt', { prompt: workflow, client_id: clientId }, 15000);
  if (!submit.ok) {
    cleanupStagedInputs(stagingDir);
    const details = submit.data && typeof submit.data === 'object' ? JSON.stringify(submit.data) : submit.error;
    throw new Error(`ComfyUI rejected workflow: ${details}`);
  }
  const promptId = submit.data?.prompt_id;
  if (!promptId) {
    cleanupStagedInputs(stagingDir);
    throw new Error('ComfyUI did not return prompt_id');
  }

  const startedAt = new Date().toISOString();
  const jobBase = {
    promptId,
    clientId,
    workflow: payload.workflow,
    outputDir,
    ownedBy: 'AgentTools',
    startedAt,
  };
  writeJob(config, promptId, { ...jobBase, status: 'running', updatedAt: startedAt });
  process.stdout.write(`${JSON.stringify({ event: 'submitted', promptId, clientId, workflow: payload.workflow })}\n`);

  const timeoutMs = Number(payload.timeoutMs || config.generationTimeoutMs || 1800000);
  const pollMs = Math.max(250, Number(config.generationPollIntervalMs || 750));
  const deadline = Date.now() + timeoutMs;
  let lastProgressLog = 0;
  let historyEntry = null;

  while (Date.now() < deadline) {
    const history = await getHistory(promptId, 10000);
    if (history.ok && history.data && history.data[promptId]) {
      historyEntry = history.data[promptId];
      break;
    }
    if (Date.now() - lastProgressLog >= 5000) {
      lastProgressLog = Date.now();
      process.stdout.write(`${JSON.stringify({ event: 'waiting', promptId, elapsedMs: timeoutMs - (deadline - Date.now()) })}\n`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  if (!historyEntry) {
    writeJob(config, promptId, { ...jobBase, status: 'failed', error: 'generation timed out', updatedAt: new Date().toISOString() });
    throw new Error(`generation timed out after ${timeoutMs} ms`);
  }

  const status = historyEntry?.status || {};
  if (status.status_str && status.status_str !== 'success') {
    cleanupStagedInputs(stagingDir);
    const error = status.messages ? JSON.stringify(status.messages) : `status=${status.status_str}`;
    writeJob(config, promptId, { ...jobBase, status: 'failed', error, updatedAt: new Date().toISOString() });
    throw new Error(`ComfyUI generation failed: ${error}`);
  }

  let downloaded;
  try {
    const outputFiles = collectOutputFiles(historyEntry);
    downloaded = [];
    for (let i = 0; i < outputFiles.length; i += 1) {
      downloaded.push(await downloadOutput(outputFiles[i], outputDir, i));
    }

    const result = {
      ok: true,
      promptId,
      clientId,
      workflow: payload.workflow,
      outputDir,
      outputs: downloaded,
      outputMetadata: outputFiles,
      completedAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(outputDir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    writeJob(config, promptId, { ...jobBase, status: 'completed', outputs: downloaded, updatedAt: result.completedAt });
    process.stdout.write(`${JSON.stringify({ event: 'completed', ...result })}\n`);
  } finally {
    cleanupStagedInputs(stagingDir);
  }
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ event: 'error', error: error.message })}\n`);
  process.exitCode = 1;
});
