#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { loadConfig } = require('../config');
const { postJson, getHistory, request } = require('../adapters/comfyui');
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
  const values = payload.values || {};
  const workflow = applyBindings(registered.workflow, registered.manifest, values);
  const outputDir = path.resolve(payload.outputDir || path.join(config.outputRoot, `${payload.workflow}-${Date.now()}`));
  const outputRoot = path.resolve(config.outputRoot);
  const relative = path.relative(outputRoot, outputDir);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('outputDir must remain under local-ai outputRoot');
  fs.mkdirSync(outputDir, { recursive: true });

  const clientId = `agenttools-${process.pid}-${Date.now()}`;
  const submit = await postJson('/prompt', { prompt: workflow, client_id: clientId }, 15000);
  if (!submit.ok) {
    const details = submit.data && typeof submit.data === 'object' ? JSON.stringify(submit.data) : submit.error;
    throw new Error(`ComfyUI rejected workflow: ${details}`);
  }
  const promptId = submit.data?.prompt_id;
  if (!promptId) throw new Error('ComfyUI did not return prompt_id');

  const startedAt = new Date().toISOString();
  const jobBase = {
    promptId,
    clientId,
    workflow: payload.workflow,
    outputDir,
    ownedBy: 'AgentTools',
    startedAt,
  };
  const jobPath = writeJob(config, promptId, { ...jobBase, status: 'running', updatedAt: startedAt });
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
    const error = status.messages ? JSON.stringify(status.messages) : `status=${status.status_str}`;
    writeJob(config, promptId, { ...jobBase, status: 'failed', error, updatedAt: new Date().toISOString() });
    throw new Error(`ComfyUI generation failed: ${error}`);
  }

  const outputFiles = collectOutputFiles(historyEntry);
  const downloaded = [];
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
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ event: 'error', error: error.message })}\n`);
  process.exitCode = 1;
});
