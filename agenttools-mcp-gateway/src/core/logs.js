const fs = require('node:fs');
const path = require('node:path');
const { projectRoot } = require('./config');
const { loadSafety } = require('./confirmations');
const { sanitizeLogText, redactObject } = require('./redaction');
const { assertTaskId, normalizeLimit } = require('./taskStore');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function taskLogPath(taskId) {
  const safeTaskId = assertTaskId(taskId);
  return path.join(projectRoot, 'logs', 'tasks', `${safeTaskId}.jsonl`);
}

function appendTaskLog(taskId, entry = {}) {
  const safety = loadSafety();
  const logPath = taskLogPath(taskId);
  ensureDir(path.dirname(logPath));
  const record = redactObject({
    at: new Date().toISOString(),
    taskId,
    ...entry,
  });
  if (typeof record.message === 'string') record.message = sanitizeLogText(record.message, Number(safety.maxLogLineChars || 4000));
  if (typeof record.data === 'string') record.data = sanitizeLogText(record.data, Number(safety.maxLogLineChars || 4000));
  const serialized = `${JSON.stringify(record)}\n`;
  const maxBytes = Number(safety.maxTaskLogBytes || 8388608);
  const currentBytes = fs.existsSync(logPath) ? fs.statSync(logPath).size : 0;
  if (currentBytes + Buffer.byteLength(serialized, 'utf8') > maxBytes) return logPath;
  fs.appendFileSync(logPath, serialized, 'utf8');
  return logPath;
}

function readTaskLog(taskId, { limit = 100 } = {}) {
  const logPath = taskLogPath(taskId);
  if (!fs.existsSync(logPath)) {
    return { ok: true, taskId, logPath, lines: [], exists: false };
  }
  const maxLines = normalizeLimit(limit, 100, Number(loadSafety().maxTaskLogLines || 2000));
  const lines = fs.readFileSync(logPath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-maxLines)
    .map((line) => {
      try {
        return redactObject(JSON.parse(line));
      } catch {
        return { raw: sanitizeLogText(line) };
      }
    });
  return { ok: true, taskId, logPath, exists: true, lines };
}

module.exports = {
  taskLogPath,
  appendTaskLog,
  readTaskLog,
};
