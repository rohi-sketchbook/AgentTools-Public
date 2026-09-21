const path = require('node:path');
const { createTask } = require('./taskStore');
const { assertPathAllowed } = require('./paths');

function formatArgForDisplay(value) {
  const text = String(value ?? '');
  if (/^[A-Za-z0-9_./:\\-]+$/.test(text)) return text;
  return JSON.stringify(text);
}

function normalizeOptionalPath(value) {
  if (!value) return null;
  const checked = assertPathAllowed(value);
  return checked.canonicalPath || path.resolve(value);
}

function commandToString(command = {}) {
  const args = command.args || [];
  return [command.command, ...args].filter((value) => value != null).map(formatArgForDisplay).join(' ');
}

function createPlannedTask({ type, title, summary, command, cwd = null, inputPath = null, outputPath = null, logPath = null, metadata = {} }) {
  const normalizedCwd = normalizeOptionalPath(cwd);
  const normalizedInput = normalizeOptionalPath(inputPath);
  const normalizedOutput = normalizeOptionalPath(outputPath);
  const normalizedLog = normalizeOptionalPath(logPath);

  if (!command?.command || !Array.isArray(command.args || [])) {
    throw new Error('Planned task command must contain command and an args array.');
  }

  const task = createTask({
    type,
    title,
    summary,
    status: 'planned',
    outputPath: normalizedOutput,
    logPath: normalizedLog,
    metadata: {
      dryRun: true,
      executionEnabled: false,
      command: {
        command: String(command.command),
        args: (command.args || []).map(String),
      },
      commandLine: commandToString(command),
      cwd: normalizedCwd,
      inputPath: normalizedInput,
      ...metadata,
    },
  });

  return {
    ok: true,
    dryRun: true,
    task,
    execution: {
      enabled: false,
      reason: 'Long-running execution is not enabled yet. This adapter only registers a planned task in taskStore.',
      command: task.metadata.command,
      commandLine: task.metadata.commandLine,
      cwd: normalizedCwd,
    },
  };
}

module.exports = {
  formatArgForDisplay,
  commandToString,
  createPlannedTask,
};
