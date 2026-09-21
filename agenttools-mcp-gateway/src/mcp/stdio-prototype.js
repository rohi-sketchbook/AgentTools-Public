#!/usr/bin/env node
const readline = require('node:readline');
const { invoke, listTools } = require('../tools');
const { loadSafety, safetyPolicySummary } = require('../core/confirmations');
const { inputSchemaFor } = require('./toolSchemas');
const packageJson = require('../../package.json');

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

function error(id, code, message, data = undefined) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message, data } })}\n`);
}

function toolDefinitions() {
  return listTools().map((tool) => ({
    name: tool.name,
    description: `AgentTools Gateway guarded action: ${tool.name}`,
    inputSchema: inputSchemaFor(tool.name),
  }));
}

async function handle(request) {
  const { id, method, params = {} } = request;

  if (method === 'server/discover') {
    const safety = loadSafety();
    respond(id, {
      name: 'agenttools-mcp-gateway',
      version: packageJson.version,
      mode: 'stdio prototype',
      capabilities: {
        tools: true,
        guardedWrites: true,
        taskStore: true,
        taskRunner: true,
        taskLogTail: true,
        longRunningTaskPlanning: true,
        commandLineRedaction: true,
        concreteToolSchemas: true,
        devspaceIndependentHealth: true,
        devspaceRecoveryControls: true,
        devspaceWatchdogStatus: true,
        autonomousDevspaceWatchdog: true,
        guardedFilesystem: true,
        registeredProcessControl: true,
        gitReadOnlyDiagnostics: true,
        writeActionsEnabled: Boolean(safety.writeActionsEnabled),
        externalActionsEnabled: Boolean(safety.externalActionsEnabled),
        destructiveActionsEnabled: Boolean(safety.destructiveActionsEnabled),
        longRunningActionsEnabled: Boolean(safety.longRunningActionsEnabled),
        actionScopedSafetyPolicy: safetyPolicySummary(safety),
      },
    });
    return;
  }

  if (method === 'tools/list') {
    respond(id, { tools: toolDefinitions() });
    return;
  }

  if (method === 'tools/call') {
    const name = params.name;
    const args = params.arguments || {};
    if (!name || !name.includes('.')) {
      error(id, -32602, 'tools/call requires a dotted tool name such as status.summary');
      return;
    }
    const [domain, action] = name.split('.', 2);
    respond(id, await invoke(domain, action, args));
    return;
  }

  error(id, -32601, `Unsupported method: ${method}`);
}

const rl = readline.createInterface({
  input: process.stdin,
  terminal: false,
});

rl.on('line', async (line) => {
  if (!line.trim()) return;
  let request;
  try {
    request = JSON.parse(line);
  } catch (parseError) {
    error(null, -32700, `Parse error: ${parseError.message}`);
    return;
  }

  try {
    await handle(request);
  } catch (handleError) {
    error(request.id ?? null, -32603, handleError.message);
  }
});
