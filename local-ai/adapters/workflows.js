const fs = require('node:fs');
const path = require('node:path');
const { loadConfig } = require('../config');

function safeWorkflowId(value) {
  const id = String(value || '').trim();
  if (!id || !/^[A-Za-z0-9._-]+$/.test(id)) {
    throw new Error('workflow id must contain only letters, numbers, dot, underscore, or hyphen');
  }
  return id;
}

function detectWorkflowFormat(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'unknown';
  if (Array.isArray(value.nodes) && Array.isArray(value.links)) return 'ui';
  const entries = Object.values(value);
  if (entries.length > 0 && entries.every((node) => node && typeof node === 'object' && typeof node.class_type === 'string' && node.inputs && typeof node.inputs === 'object')) {
    return 'api';
  }
  return 'unknown';
}

function readJsonIfPossible(filePath) {
  try {
    return { ok: true, value: JSON.parse(fs.readFileSync(filePath, 'utf8')) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function listJsonFiles(root, limit = 200) {
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && path.extname(entry.name).toLowerCase() === '.json')
    .slice(0, limit)
    .map((entry) => path.join(root, entry.name));
}

function listDetectedWorkflows() {
  const config = loadConfig();
  const workflows = [];
  for (const source of config.detectedWorkflowSources || []) {
    const files = listJsonFiles(source.path, 200);
    for (const filePath of files) {
      const parsed = readJsonIfPossible(filePath);
      workflows.push({
        id: `${source.id}:${path.basename(filePath, path.extname(filePath))}`,
        name: path.basename(filePath, path.extname(filePath)),
        sourceId: source.id,
        sourceName: source.displayName || source.id,
        path: filePath,
        format: parsed.ok ? detectWorkflowFormat(parsed.value) : 'invalid',
        readable: parsed.ok,
        error: parsed.ok ? null : parsed.error,
        executable: parsed.ok && detectWorkflowFormat(parsed.value) === 'api',
      });
    }
  }
  return workflows;
}

function listRegisteredWorkflows() {
  const config = loadConfig();
  if (!fs.existsSync(config.registeredWorkflowRoot)) return [];
  return fs.readdirSync(config.registeredWorkflowRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^[A-Za-z0-9._-]+$/.test(entry.name))
    .map((entry) => {
      const root = path.join(config.registeredWorkflowRoot, entry.name);
      const manifestPath = path.join(root, 'manifest.json');
      const manifestResult = fs.existsSync(manifestPath) ? readJsonIfPossible(manifestPath) : { ok: false, error: 'manifest.json is missing' };
      const manifest = manifestResult.ok ? manifestResult.value : null;
      const workflowFile = manifest?.workflowFile || 'workflow-api.json';
      const workflowPath = path.join(root, workflowFile);
      const workflowResult = fs.existsSync(workflowPath) ? readJsonIfPossible(workflowPath) : { ok: false, error: `${workflowFile} is missing` };
      const format = workflowResult.ok ? detectWorkflowFormat(workflowResult.value) : 'invalid';
      return {
        id: entry.name,
        name: manifest?.name || entry.name,
        description: manifest?.description || null,
        type: manifest?.type || 'unknown',
        path: root,
        workflowPath,
        format,
        bindings: manifest?.bindings || {},
        executable: manifestResult.ok && workflowResult.ok && format === 'api',
        error: !manifestResult.ok ? manifestResult.error : !workflowResult.ok ? workflowResult.error : format !== 'api' ? 'workflow must be ComfyUI API format' : null,
      };
    });
}

function loadRegisteredWorkflow(id) {
  const config = loadConfig();
  const safeId = safeWorkflowId(id);
  const root = path.join(config.registeredWorkflowRoot, safeId);
  const manifestPath = path.join(root, 'manifest.json');
  if (!fs.existsSync(manifestPath)) throw new Error(`registered workflow not found: ${safeId}`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const workflowFile = manifest.workflowFile || 'workflow-api.json';
  if (path.basename(workflowFile) !== workflowFile) throw new Error('workflowFile must be a file name within the workflow directory');
  const workflowPath = path.join(root, workflowFile);
  if (!fs.existsSync(workflowPath)) throw new Error(`workflow file not found: ${workflowPath}`);
  const workflow = JSON.parse(fs.readFileSync(workflowPath, 'utf8'));
  if (detectWorkflowFormat(workflow) !== 'api') throw new Error('registered workflow must be ComfyUI API format');
  return { id: safeId, root, manifest, workflowPath, workflow };
}

function setBinding(workflow, binding, value, key) {
  if (value === undefined || value === null || value === '') return;
  if (!binding || typeof binding !== 'object') return;
  const nodeId = String(binding.node || '');
  const inputName = String(binding.input || '');
  if (!nodeId || !inputName) throw new Error(`invalid binding for ${key}`);
  const node = workflow[nodeId];
  if (!node || !node.inputs || typeof node.inputs !== 'object') throw new Error(`binding for ${key} points to missing node ${nodeId}`);
  node.inputs[inputName] = value;
}

function applyBindings(workflowInput, manifest, values = {}) {
  const workflow = structuredClone(workflowInput);
  const bindings = manifest?.bindings || {};
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) continue;
    if (!Object.hasOwn(bindings, key)) continue;
    setBinding(workflow, bindings[key], value, key);
  }
  return workflow;
}

module.exports = {
  safeWorkflowId,
  detectWorkflowFormat,
  listDetectedWorkflows,
  listRegisteredWorkflows,
  loadRegisteredWorkflow,
  applyBindings,
};
