const path = require('node:path');
const { readJson } = require('../core/config');
const { run } = require('../core/runner');
const { requireExistingFile } = require('../core/executables');
const { createConfirmation, verifyConfirmation } = require('../core/confirmations');

function helperPaths() {
  const config = readJson('config/components.json');
  const root = config.components.windowsUi;
  if (!root) throw new Error('components.windowsUi is not configured.');
  const dotnet = requireExistingFile('C:/Program Files/dotnet/dotnet.exe', 'dotnet executable');
  let dll;
  try {
    dll = requireExistingFile(path.join(root, 'bin', 'Release', 'net10.0-windows', 'AgentTools.WindowsUi.dll'), 'Windows UI helper');
  } catch (error) {
    error.message = `${error.message}. Run ${path.join(root, 'Build-WindowsUi.bat')} first.`;
    throw error;
  }
  return { root, dotnet, dll };
}

function pushOption(args, name, value) {
  if (value === undefined || value === null || value === '') return;
  args.push(`--${name}`, String(value));
}

function buildArgs(command, options = {}, extra = {}) {
  const args = [command];
  pushOption(args, 'process', options.process);
  if (command === 'windows') pushOption(args, 'title', options.title || options.window);
  else pushOption(args, 'window', options.window || options.title);
  pushOption(args, 'controlType', options.controlType);
  pushOption(args, 'name', options.name);
  pushOption(args, 'automationId', options.automationId);
  pushOption(args, 'depth', options.depth);
  pushOption(args, 'limit', options.limit);
  pushOption(args, 'expectedProcessId', extra.expectedProcessId);
  pushOption(args, 'expectedWindowHandle', extra.expectedWindowHandle);
  pushOption(args, 'expectedControlHandle', extra.expectedControlHandle);
  if (extra.execute) args.push('--execute');
  return args;
}

function parseHelperOutput(result, action) {
  let parsed = null;
  try {
    parsed = JSON.parse(result.stdout || '{}');
  } catch (error) {
    return {
      ok: false,
      action,
      error: `Windows UI helper returned invalid JSON: ${error.message}`,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    };
  }
  if (!result.ok || parsed.ok === false) {
    return {
      ...parsed,
      ok: false,
      action,
      helperExitCode: result.exitCode,
      helperError: result.error || null,
      helperStderr: result.stderr || '',
    };
  }
  return { ...parsed, action };
}

async function runHelper(command, options = {}, extra = {}) {
  const { root, dotnet, dll } = helperPaths();
  const result = await run(dotnet, [dll, ...buildArgs(command, options, extra)], {
    cwd: root,
    timeoutMs: 15000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return parseHelperOutput(result, `windowsUi.${command}`);
}

async function windows(options = {}) {
  return runHelper('windows', options);
}

async function tree(options = {}) {
  return runHelper('tree', options);
}

async function find(options = {}) {
  return runHelper('find', options);
}

function invokeIdentity(preview) {
  const target = preview?.wouldInvoke;
  if (!target?.window || !target?.control) throw new Error('Windows UI invoke preview did not contain a concrete target.');
  return {
    processId: target.control.processId,
    windowHandle: target.window.nativeWindowHandle,
    controlHandle: target.control.nativeWindowHandle,
    windowName: target.window.name,
    controlName: target.control.name,
    controlType: target.control.controlType,
    automationId: target.control.automationId,
  };
}

function invokePayload(options, identity) {
  return {
    process: String(options.process || ''),
    window: String(options.window || options.title || ''),
    controlType: String(options.controlType || ''),
    name: String(options.name || ''),
    automationId: String(options.automationId || ''),
    identity,
  };
}

async function invoke(options = {}) {
  const preview = await runHelper('invoke', options);
  if (!preview.ok) return preview;

  const identity = invokeIdentity(preview);
  const payload = invokePayload(options, identity);

  if (!options.confirmToken) {
    return createConfirmation({
      action: 'windowsUi.invoke',
      impact: 'write',
      summary: `Invoke ${identity.controlType || 'control'} '${identity.controlName || identity.automationId}' in '${identity.windowName}' (${options.process})`,
      payload,
      preview: preview.wouldInvoke,
    });
  }

  const confirmation = verifyConfirmation({
    action: 'windowsUi.invoke',
    token: options.confirmToken,
    payload,
    impact: 'write',
    consume: true,
  });
  if (!confirmation.ok) return { ...confirmation, preview: preview.wouldInvoke };

  const executed = await runHelper('invoke', options, {
    execute: true,
    expectedProcessId: identity.processId,
    expectedWindowHandle: identity.windowHandle,
    expectedControlHandle: identity.controlHandle,
  });
  return {
    ...executed,
    confirmed: true,
    confirmation: confirmation.confirmation,
  };
}

module.exports = {
  windows,
  tree,
  find,
  invoke,
  _internal: {
    buildArgs,
    invokeIdentity,
    invokePayload,
    parseHelperOutput,
  },
};
