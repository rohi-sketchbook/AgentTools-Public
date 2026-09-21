import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { installRotatingProcessLog } from './rotating-log.mjs';

const logFile = process.env.AGENTTOOLS_DEVSPACE_LOG_FILE;
if (logFile) {
  installRotatingProcessLog({
    file: logFile,
    maxBytes: process.env.AGENTTOOLS_DEVSPACE_LOG_MAX_BYTES,
    backupCount: process.env.AGENTTOOLS_DEVSPACE_LOG_BACKUP_COUNT,
  });
}

const devspaceRoot = process.env.AGENTTOOLS_DEVSPACE_ROOT;
const controlRequestFile = process.env.AGENTTOOLS_DEVSPACE_CONTROL_REQUEST_FILE;
const controlToken = process.env.AGENTTOOLS_DEVSPACE_CONTROL_TOKEN;

if (!devspaceRoot || !controlRequestFile || !controlToken) {
  throw new Error('AgentTools DevSpace supervisor requires root, control request file, and control token environment variables.');
}

const moduleUrl = (relativePath) => pathToFileURL(path.join(devspaceRoot, relativePath)).href;
const [{ loadConfig }, { createServer }, { shutdownHttpServer }] = await Promise.all([
  import(moduleUrl('dist/config.js')),
  import(moduleUrl('dist/server.js')),
  import(moduleUrl('dist/server-shutdown.js')),
]);

const config = loadConfig();
const { app, close } = createServer(config);
const httpServer = app.listen(config.port, config.host, () => {
  console.log(`devspace listening on http://${config.host}:${config.port}/mcp`);
  console.log('agenttools supervisor: graceful shutdown control enabled');
});

let shuttingDown = false;
let pollTimer = null;

async function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (pollTimer) clearInterval(pollTimer);
  console.log(`agenttools supervisor: shutdown requested (${reason})`);
  try {
    await shutdownHttpServer(httpServer, close);
  } catch (error) {
    if (error?.code !== 'ERR_SERVER_NOT_RUNNING') throw error;
    console.log('agenttools supervisor: HTTP server was already stopped; treating shutdown as complete');
  }
  process.exit(0);
}

function handleShutdown(reason) {
  void shutdown(reason).catch((error) => {
    console.error('agenttools supervisor: devspace shutdown failed', error);
    process.exit(1);
  });
}

function readControlRequest() {
  let raw;
  try {
    raw = fs.readFileSync(controlRequestFile, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }

  let request;
  try {
    request = JSON.parse(raw);
  } catch {
    return null;
  }
  if (request?.token !== controlToken || request?.action !== 'shutdown') return null;
  return request;
}

function checkControlRequest() {
  try {
    const request = readControlRequest();
    if (!request) return;
    try { fs.unlinkSync(controlRequestFile); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    handleShutdown('gateway-control-request');
  } catch (error) {
    console.error('agenttools supervisor: control request check failed', error);
  }
}

// performance-audit: allow-bounded-poll — O(1) check of one fixed-size control file only.
// This is deliberately not a directory/session scan; keep the callback bounded if this code changes.
pollTimer = setInterval(checkControlRequest, 1_000);
pollTimer.unref?.();
checkControlRequest();

process.once('SIGINT', () => handleShutdown('SIGINT'));
process.once('SIGTERM', () => handleShutdown('SIGTERM'));
process.once('uncaughtException', (error) => {
  console.error('agenttools supervisor: uncaught exception', error);
  process.exit(1);
});
process.once('unhandledRejection', (error) => {
  console.error('agenttools supervisor: unhandled rejection', error);
  process.exit(1);
});
