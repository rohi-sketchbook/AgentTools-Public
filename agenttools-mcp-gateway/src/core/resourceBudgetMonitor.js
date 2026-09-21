const path = require('node:path');
const { queryProcesses } = require('./processes');

const MB = 1024 * 1024;
const DEFAULT_BUDGET = Object.freeze({
  cpuOneCorePercent: 5,
  readMbPerSec: 5,
  writeMbPerSec: 1,
  workingSetMb: 1024,
  sustainSamples: 5,
});

function processKey(item) {
  return `${item.pid}:${item.creationDate || ''}`;
}

function isAgentToolsProcess(item, root = path.resolve(__dirname, '..', '..', '..')) {
  const needle = String(root || '').replace(/\\/g, '/').toLowerCase();
  const haystack = `${item.executablePath || ''}\n${item.commandLine || ''}`.replace(/\\/g, '/').toLowerCase();
  return haystack.includes(needle);
}

function rate(current, previous, field, elapsedSeconds) {
  const now = Number(current?.[field]);
  const before = Number(previous?.[field]);
  if (!Number.isFinite(now) || !Number.isFinite(before) || elapsedSeconds <= 0 || now < before) return 0;
  return (now - before) / elapsedSeconds;
}

function evaluateResourceDelta(previous, current, elapsedMs, budget = DEFAULT_BUDGET) {
  const elapsedSeconds = elapsedMs / 1000;
  if (!(elapsedSeconds > 0)) return null;
  const cpu100nsPerSec = rate(current, previous, 'kernelTime100ns', elapsedSeconds) +
    rate(current, previous, 'userTime100ns', elapsedSeconds);
  const cpuOneCorePercent = (cpu100nsPerSec / 10_000_000) * 100;
  const readMbPerSec = rate(current, previous, 'readBytes', elapsedSeconds) / MB;
  const writeMbPerSec = rate(current, previous, 'writeBytes', elapsedSeconds) / MB;
  const workingSetMb = Number.isFinite(Number(current.workingSetBytes)) ? Number(current.workingSetBytes) / MB : 0;
  const violations = [];
  if (cpuOneCorePercent >= budget.cpuOneCorePercent) violations.push('cpu');
  if (readMbPerSec >= budget.readMbPerSec) violations.push('read');
  if (writeMbPerSec >= budget.writeMbPerSec) violations.push('write');
  if (workingSetMb >= budget.workingSetMb) violations.push('memory');
  return {
    pid: current.pid,
    name: current.name,
    commandLine: current.commandLine,
    creationDate: current.creationDate,
    cpuOneCorePercent,
    readMbPerSec,
    writeMbPerSec,
    workingSetMb,
    violations,
  };
}

function createResourceBudgetMonitor(options = {}) {
  const budget = { ...DEFAULT_BUDGET, ...(options.budget || {}) };
  const root = options.root || path.resolve(__dirname, '..', '..', '..');
  let previousAt = null;
  let previous = new Map();
  const sustained = new Map();

  async function sample(now = Date.now()) {
    const result = await queryProcesses('', 'literal');
    if (!result.ok) return { ok: false, error: result.error, incidents: [], samples: [] };
    const items = result.processes.filter((item) => isAgentToolsProcess(item, root));
    const current = new Map(items.map((item) => [processKey(item), item]));
    if (previousAt === null) {
      previousAt = now;
      previous = current;
      return { ok: true, baseline: true, incidents: [], samples: [] };
    }

    const elapsedMs = Math.max(1, now - previousAt);
    const samples = [];
    const incidents = [];
    for (const [key, item] of current) {
      const before = previous.get(key);
      if (!before) continue;
      const metric = evaluateResourceDelta(before, item, elapsedMs, budget);
      if (!metric) continue;
      samples.push(metric);
      if (metric.violations.length === 0) {
        sustained.delete(key);
        continue;
      }
      const count = (sustained.get(key) || 0) + 1;
      sustained.set(key, count);
      if (count === budget.sustainSamples || count % budget.sustainSamples === 0) {
        incidents.push({ ...metric, sustainedSamples: count });
      }
    }

    for (const key of sustained.keys()) {
      if (!current.has(key)) sustained.delete(key);
    }
    previousAt = now;
    previous = current;
    return { ok: true, baseline: false, elapsedMs, incidents, samples };
  }

  return { sample, budget };
}

module.exports = {
  DEFAULT_BUDGET,
  createResourceBudgetMonitor,
  evaluateResourceDelta,
  isAgentToolsProcess,
};
