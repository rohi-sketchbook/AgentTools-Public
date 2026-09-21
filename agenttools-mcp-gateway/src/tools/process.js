const { readJson } = require('../core/config');
const { queryProcesses, findProcessesLiteral, processInfo } = require('../core/processes');
const { createConfirmation, verifyConfirmation } = require('../core/confirmations');
const devspaceTool = require('./devspace');

function registry() {
  return readJson('config/processes.json').registeredProcesses || {};
}

function truthy(value) {
  return value === true || value === 'true' || value === '1' || value === 'yes';
}

async function list(options = {}) {
  const result = await queryProcesses('', 'literal');
  if (!result.ok) return result;
  const requested = Number(options.limit ?? 100);
  const limit = Math.max(1, Math.min(Number.isFinite(requested) ? Math.floor(requested) : 100, 500));
  return {
    ok: true,
    processes: result.processes.slice(0, limit),
    count: result.processes.length,
    truncated: result.processes.length > limit,
    registeredProcessIds: Object.keys(registry()),
  };
}

async function find(options = {}) {
  const needle = String(options.query ?? options.pattern ?? options.name ?? '').trim();
  if (!needle) return { ok: false, error: 'query is required' };
  const result = await findProcessesLiteral(needle);
  if (!result.ok) return result;
  const requested = Number(options.limit ?? 100);
  const limit = Math.max(1, Math.min(Number.isFinite(requested) ? Math.floor(requested) : 100, 500));
  return { ok: true, query: needle, processes: result.processes.slice(0, limit), count: result.processes.length, truncated: result.processes.length > limit };
}

async function info(options = {}) {
  return processInfo(options.pid);
}

function registered(id) {
  const key = String(id || '').trim();
  const entry = registry()[key];
  if (!entry) {
    const error = new Error(`Unknown registered process: ${key || '<empty>'}`);
    error.details = { registeredProcessIds: Object.keys(registry()) };
    throw error;
  }
  return { id: key, entry };
}

async function registeredStatus(id) {
  const target = registered(id);
  if (target.entry.manager === 'devspace') return devspaceTool.health();
  return { ok: false, error: `Unsupported registered process manager: ${target.entry.manager}` };
}

async function status(options = {}) {
  const id = String(options.id || '').trim();
  if (!id) {
    const entries = [];
    for (const processId of Object.keys(registry())) {
      entries.push({ id: processId, description: registry()[processId].description || null, status: await registeredStatus(processId) });
    }
    return { ok: entries.every((entry) => entry.status.ok), registered: entries };
  }
  const target = registered(id);
  return { ok: true, id: target.id, description: target.entry.description || null, status: await registeredStatus(target.id) };
}

async function start(options = {}) {
  const target = registered(options.id);
  const current = await registeredStatus(target.id);
  if (target.entry.manager === 'devspace' && current.status === 'healthy') {
    return { ok: true, changed: false, id: target.id, message: 'registered process is already healthy', status: current };
  }
  const payload = { id: target.id, manager: target.entry.manager };
  const preview = { id: target.id, description: target.entry.description || null, currentStatus: current.status || null };
  if (!options.confirmToken) {
    return createConfirmation({ action: 'process.start', impact: 'write', summary: `Start registered process ${target.id}`, payload, preview });
  }
  const confirmation = verifyConfirmation({ action: 'process.start', token: options.confirmToken, payload, impact: 'write', consume: true });
  if (!confirmation.ok) return confirmation;
  if (target.entry.manager === 'devspace') return { ...(await devspaceTool._internal.startInternal()), registeredProcessId: target.id };
  return { ok: false, id: target.id, error: `Unsupported registered process manager: ${target.entry.manager}` };
}

async function stop(options = {}) {
  const target = registered(options.id);
  const force = truthy(options.force);
  const current = await registeredStatus(target.id);
  if (target.entry.manager === 'devspace' && !current.processRunning) {
    return { ok: true, changed: false, id: target.id, message: 'registered process is already stopped', status: current };
  }
  const payload = { id: target.id, manager: target.entry.manager, force };
  const impact = force ? 'destructive' : 'write';
  const preview = { id: target.id, description: target.entry.description || null, currentStatus: current.status || null, pids: current.pids || [], force };
  if (!options.confirmToken) {
    return createConfirmation({ action: 'process.stop', impact, summary: `Stop registered process ${target.id}${force ? ' forcefully' : ''}`, payload, preview });
  }
  const confirmation = verifyConfirmation({ action: 'process.stop', token: options.confirmToken, payload, impact, consume: true });
  if (!confirmation.ok) return confirmation;
  if (target.entry.manager === 'devspace') return { ...(await devspaceTool._internal.stopInternal({ force })), registeredProcessId: target.id };
  return { ok: false, id: target.id, error: `Unsupported registered process manager: ${target.entry.manager}` };
}

module.exports = { list, find, info, status, start, stop };
