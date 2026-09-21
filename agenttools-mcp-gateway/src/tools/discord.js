const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { readJson } = require('../core/config');
const { findProcesses } = require('../core/processes');
const { run, runPowerShellScript } = require('../core/runner');
const { createConfirmation, verifyConfirmation } = require('../core/confirmations');
const { assertPathAllowed, canonicalizePath } = require('../core/paths');

function truthy(value) {
  return value === true || value === 'true' || value === '1' || value === 'yes';
}

function scheduledTaskName() {
  const config = readJson('config/discord.json');
  const value = String(config.scheduledTaskName || '').trim();
  return value || 'AgentTools-DiscordBot';
}

function trimPreview(value, max = 12000) {
  const text = String(value || '');
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n... <truncated ${text.length - max} chars>`;
}

async function status() {
  const config = readJson('config/components.json');
  const root = config.components.discordBot;
  const candidates = [
    path.join(root, 'codex-discord-connector'),
    path.join(root, 'discord-chatgpt-bridge'),
    path.join(root, 'discord-codex-bridge'),
  ];
  const processes = await findProcesses('codex-discord-connector|discord-chatgpt-bridge|discord-codex-bridge|cdc\\.js');

  return {
    ok: fs.existsSync(root),
    root,
    scheduledTask: scheduledTaskName(),
    folders: candidates.map((folder) => ({ path: folder, exists: fs.existsSync(folder) })),
    processes: processes.processes.map((p) => ({
      pid: p.ProcessId,
      name: p.Name,
      commandLine: p.CommandLine,
    })),
    error: processes.error,
  };
}

function discordBridgeRoot() {
  const config = readJson('config/components.json');
  return path.join(config.components.discordBot, 'discord-codex-bridge');
}

function buildSendPreview(options = {}) {
  const message = String(options.message || options.content || '').trim();
  const contentFile = options.contentFile || null;
  const components = Array.isArray(options.components) ? options.components : [];
  const attachments = Array.isArray(options.attachment)
    ? options.attachment.map(String).filter(Boolean)
    : options.attachment != null
      ? [String(options.attachment)]
      : Array.isArray(options.attachments)
      ? options.attachments.map(String).filter(Boolean)
      : String(options.attachments || '').split(',').map((entry) => entry.trim()).filter(Boolean);

  if (!message && !contentFile) {
    throw new Error('Discord post requires --message or --contentFile.');
  }
  const checkedContentFile = contentFile ? assertPathAllowed(contentFile).canonicalPath : null;
  if (checkedContentFile && (!fs.existsSync(checkedContentFile) || !fs.statSync(checkedContentFile).isFile())) {
    throw new Error(`Discord content file not found or not a file: ${checkedContentFile}`);
  }
  const checkedAttachments = attachments.map((attachment) => {
    const checked = assertPathAllowed(attachment).canonicalPath;
    if (!fs.existsSync(checked) || !fs.statSync(checked).isFile()) {
      throw new Error(`Discord attachment not found or not a file: ${checked}`);
    }
    return checked;
  });

  return {
    message,
    contentFile: checkedContentFile,
    attachments: checkedAttachments,
    components,
    channel: 'configured Discord agent channel',
    userExplicitlyRequested: truthy(options.userExplicitlyRequested),
  };
}

async function queuePostPayload(payload) {
  const root = discordBridgeRoot();
  const config = readJson('config/components.json');
  const loaderPath = path.join(config.components.discordBot, 'codex-discord-connector', 'node_modules', 'tsx', 'dist', 'loader.mjs');
  if (!fs.existsSync(loaderPath)) return { ok: false, error: `Discord TSX loader not found: ${loaderPath}` };
  const canonicalLoader = canonicalizePath(loaderPath);
  const canonicalBotRoot = canonicalizePath(config.components.discordBot);
  const loaderCmp = process.platform === 'win32' ? canonicalLoader.toLowerCase() : canonicalLoader;
  const rootCmp = process.platform === 'win32' ? canonicalBotRoot.toLowerCase() : canonicalBotRoot;
  if (!(loaderCmp === rootCmp || loaderCmp.startsWith(`${rootCmp}${path.sep}`))) {
    return { ok: false, error: `Discord TSX loader escaped configured bot root: ${canonicalLoader}` };
  }
  const loader = pathToFileURL(canonicalLoader).href;
  const args = ['--import', loader, 'scripts/discord-agent.ts', 'send'];
  if (payload.message) args.push('--content', payload.message);
  if (payload.contentFile) args.push('--content-file', payload.contentFile);
  if (Array.isArray(payload.components) && payload.components.length > 0) {
    args.push('--components-json', JSON.stringify(payload.components));
  }
  for (const attachment of payload.attachments) args.push('--attachment', attachment);

  const result = await run(process.execPath, args, { cwd: root, timeoutMs: 60000, maxBuffer: 1024 * 1024 * 8 });
  const requestId = String(result.stdout || '').match(/QUEUED requestId=([^\s]+)/)?.[1] || null;
  return {
    ok: result.ok,
    action: 'discord.post',
    requestId,
    result: {
      stdout: trimPreview(result.stdout),
      stderr: trimPreview(result.stderr),
      error: result.ok ? null : result.error || result.stderr,
    },
  };
}

async function post(options = {}) {
  const payload = buildSendPreview(options);
  const preview = {
    channel: payload.channel,
    messagePreview: payload.message ? trimPreview(payload.message, 800) : null,
    contentFile: payload.contentFile,
    attachments: payload.attachments,
    components: payload.components,
    userExplicitlyRequested: payload.userExplicitlyRequested,
    note: 'The Discord helper queues to the configured channel; QUEUED is not delivery proof. Execution requires an explicit user request assertion and a matching confirmToken.',
  };

  if (!options.confirmToken) {
    return createConfirmation({
      action: 'discord.post',
      impact: 'external',
      summary: 'Queue Discord message through discord-agent helper',
      payload,
      preview,
      userExplicitlyRequested: payload.userExplicitlyRequested,
    });
  }

  const confirmation = verifyConfirmation({
    action: 'discord.post',
    token: options.confirmToken,
    payload,
    impact: 'external',
    consume: true,
    userExplicitlyRequested: payload.userExplicitlyRequested,
  });
  if (!confirmation.ok) return { ...confirmation, preview };

  const queued = await queuePostPayload(payload);
  return { ...queued, confirmed: true };
}

async function restart(options = {}) {
  const config = readJson('config/components.json');
  const script = path.join(config.components.discordBot, 'discord-codex-bridge', 'restart-localized-bot.ps1');
  const taskName = scheduledTaskName();
  const payload = { script, taskName };
  const preview = {
    script,
    scheduledTask: taskName,
    note: 'Restart is an operational side effect and is not allowlisted by the action-scoped safety policy.',
  };

  if (!options.confirmToken) {
    return createConfirmation({
      action: 'discord.restart',
      impact: 'external',
      summary: 'Restart Discord Bot through the registered local restart script',
      payload,
      preview,
    });
  }

  const confirmation = verifyConfirmation({
    action: 'discord.restart',
    token: options.confirmToken,
    payload,
    impact: 'external',
    consume: true,
  });
  if (!confirmation.ok) return { ...confirmation, preview };

  assertPathAllowed(script);
  const result = await runPowerShellScript(script, { TaskName: taskName }, {
    timeoutMs: 120000,
    maxBuffer: 1024 * 1024 * 8,
  });
  return {
    ok: result.ok,
    confirmed: true,
    action: 'discord.restart',
    result: {
      stdout: trimPreview(result.stdout),
      stderr: trimPreview(result.stderr),
      error: result.ok ? null : result.error || result.stderr,
    },
  };
}

module.exports = {
  status,
  post,
  restart,
  _internal: {
    buildSendPreview,
    queuePostPayload,
  },
};
