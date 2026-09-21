const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const devspace = require('../src/tools/devspace');
const { processInfo, stopPid } = require('../src/core/processes');
const { requestProbe, readUserConfig, workspaceState, workspaceLookup, managerConfig, readLogs, installationChecksStartable } = require('../src/core/devspaceManager');

function statusOf(state) {
  if (state === 'healthy') return { ok: true, status: 'healthy', processRunning: true, portOccupied: true, listenerPids: [111], healthResponsive: true, mcpResponsive: true, pids: [111], pid: 111 };
  if (state === 'unresponsive') return { ok: true, status: 'unresponsive', processRunning: true, portOccupied: false, listenerPids: [], healthResponsive: false, mcpResponsive: false, pids: [111], pid: 111 };
  if (state === 'degraded') return { ok: true, status: 'degraded', processRunning: true, portOccupied: true, listenerPids: [111], healthResponsive: true, mcpResponsive: false, pids: [111], pid: 111 };
  if (state === 'occupied') return { ok: true, status: 'degraded', processRunning: false, portOccupied: true, listenerPids: [999], healthResponsive: false, mcpResponsive: false, pids: [], pid: null };
  return { ok: true, status: 'stopped', processRunning: false, portOccupied: false, listenerPids: [], healthResponsive: false, mcpResponsive: false, pids: [], pid: null };
}

function createRuntime(initialState, options = {}) {
  let state = initialState;
  let startCalls = 0;
  let stopCalls = [];
  let diagnoseCalls = 0;
  const runtime = {
    readStatus: async () => statusOf(state),
    installationState: async () => ({ startable: options.startable !== false }),
    startProcess: () => {
      startCalls += 1;
      if (options.startFails) return { ok: false, pid: null, error: 'fake start failed' };
      state = options.startBecomesUnresponsive ? 'unresponsive' : 'healthy';
      return { ok: true, pid: 222 };
    },
    waitFor: async (predicate) => {
      if (options.forceWaitTimeout) return { ok: false, value: null, error: 'fake timeout' };
      const value = await predicate();
      return value ? { ok: true, value } : { ok: false, value: null, error: 'fake timeout' };
    },
    devspaceProcesses: async () => ({
      ok: true,
      ownershipVerified: state !== 'stopped',
      processes: state === 'stopped' ? [] : [{
        pid: 111,
        name: 'node.exe',
        commandLine: 'node "dist\\cli.js" serve',
        ownership: { verified: true, gracefulStopAvailable: options.gracefulAvailable !== false },
      }],
    }),
    managerConfig: () => ({ startupTimeoutMs: 50, stopTimeoutMs: 50 }),
    requestGracefulShutdown: () => {
      stopCalls.push({ force: false, tree: false });
      if (options.gracefulStopFails) return { ok: false, pid: 111, method: 'supervisor-file-request', error: 'fake graceful stop failed' };
      if (!options.gracefulStopHangs) state = 'stopped';
      return { ok: true, pid: 111, method: 'supervisor-file-request' };
    },
    stopPid: async (_pid, stopOptions) => {
      stopCalls.push({ force: Boolean(stopOptions.force), tree: Boolean(stopOptions.tree) });
      state = 'stopped';
      return { ok: true, pid: 111, force: Boolean(stopOptions.force) };
    },
    clearControlState: () => true,
    runDiagnose: async () => {
      diagnoseCalls += 1;
      const restartPossible = options.restartPossible !== false;
      return {
        ok: true,
        overall: state === 'healthy' ? 'healthy' : 'unhealthy',
        status: state,
        restartPossible,
        recommendedAction: state === 'stopped' ? 'start' : state === 'healthy' ? 'none' : 'restart',
      };
    },
  };
  return {
    runtime,
    snapshot: () => ({ state, startCalls, stopCalls: [...stopCalls], diagnoseCalls }),
  };
}

async function test(name, fn, results) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, error: error.stack || error.message });
  }
}

async function removeDirectoryWithRetry(directory, attempts = 10) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      fs.rmSync(directory, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!['EPERM', 'EBUSY'].includes(error.code) || attempt === attempts - 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

async function main() {
  const results = [];
  const { startInternal, stopInternal, restartInternal, recoverInternal } = devspace._internal;

  await test('runtime startability ignores Git commit drift but requires runtime files and dependencies', async () => {
    const checks = {
      rootExists: true,
      entryExists: true,
      serverEntryExists: true,
      configEntryExists: true,
      shutdownEntryExists: true,
      supervisorExists: true,
      packageExists: true,
      packageVersionReadable: true,
      expectedVersionMatches: true,
      nodeModulesExists: true,
      commitReadable: false,
      pinnedCommitMatches: false,
    };
    assert.equal(installationChecksStartable(checks), true);
    assert.equal(installationChecksStartable({ ...checks, entryExists: false }), false);
    assert.equal(installationChecksStartable({ ...checks, expectedVersionMatches: false }), false);
    assert.equal(installationChecksStartable({ ...checks, nodeModulesExists: false }), false);
  }, results);

  await test('healthy start is a no-op and prevents duplicate start', async () => {
    const fake = createRuntime('healthy');
    const result = await startInternal(fake.runtime);
    assert.equal(result.ok, true);
    assert.equal(result.changed, false);
    assert.equal(fake.snapshot().startCalls, 0);
  }, results);

  await test('stopped DevSpace starts and becomes healthy', async () => {
    const fake = createRuntime('stopped');
    const result = await startInternal(fake.runtime);
    assert.equal(result.ok, true);
    assert.equal(result.after.status, 'healthy');
    assert.equal(fake.snapshot().startCalls, 1);
  }, results);

  await test('start failure is reported without pretending success', async () => {
    const fake = createRuntime('stopped', { startFails: true });
    const result = await startInternal(fake.runtime);
    assert.equal(result.ok, false);
    assert.match(result.error, /fake start failed/);
  }, results);

  await test('existing unresponsive process blocks duplicate start', async () => {
    const fake = createRuntime('unresponsive');
    const result = await startInternal(fake.runtime);
    assert.equal(result.ok, false);
    assert.match(result.error, /restart or devspace\.recover/);
    assert.equal(fake.snapshot().startCalls, 0);
  }, results);

  await test('occupied configured port blocks duplicate start even without trusted process', async () => {
    const fake = createRuntime('occupied');
    const result = await startInternal(fake.runtime);
    assert.equal(result.ok, false);
    assert.match(result.error, /already in use/);
    assert.equal(fake.snapshot().startCalls, 0);
  }, results);

  await test('missing/broken installation blocks automatic start', async () => {
    const fake = createRuntime('stopped', { startable: false });
    const result = await startInternal(fake.runtime);
    assert.equal(result.ok, false);
    assert.match(result.error, /automatic reinstall\/update is disabled/);
    assert.equal(fake.snapshot().startCalls, 0);
  }, results);

  await test('supervisor graceful stop succeeds without force', async () => {
    const fake = createRuntime('healthy');
    const result = await stopInternal({ force: false }, fake.runtime);
    assert.equal(result.ok, true);
    assert.equal(result.after.status, 'stopped');
    assert.deepEqual(fake.snapshot().stopCalls, [{ force: false, tree: false }]);
  }, results);

  await test('stop timeout is surfaced', async () => {
    const fake = createRuntime('healthy', { gracefulStopHangs: true, forceWaitTimeout: true });
    const result = await stopInternal({ force: false }, fake.runtime);
    assert.equal(result.ok, false);
    assert.match(result.error, /did not stop/);
  }, results);

  await test('restart performs stop then start', async () => {
    const fake = createRuntime('healthy');
    const result = await restartInternal({ force: false }, fake.runtime);
    assert.equal(result.ok, true);
    assert.equal(fake.snapshot().state, 'healthy');
    assert.equal(fake.snapshot().startCalls, 1);
    assert.equal(fake.snapshot().stopCalls.length, 1);
  }, results);

  await test('restart reports failure when restarted process never becomes healthy', async () => {
    const fake = createRuntime('healthy', { startBecomesUnresponsive: true });
    const result = await restartInternal({ force: false }, fake.runtime);
    assert.equal(result.ok, false);
    assert.equal(result.started.after.status, 'unresponsive');
    assert.match(result.error, /did not become healthy/);
  }, results);

  await test('recover healthy does nothing', async () => {
    const fake = createRuntime('healthy');
    const result = await recoverInternal({ allowForce: false }, fake.runtime);
    assert.equal(result.ok, true);
    assert.equal(result.changed, false);
    assert.equal(fake.snapshot().startCalls, 0);
    assert.equal(fake.snapshot().stopCalls.length, 0);
  }, results);

  await test('recover stopped starts DevSpace', async () => {
    const fake = createRuntime('stopped');
    const result = await recoverInternal({ allowForce: false }, fake.runtime);
    assert.equal(result.ok, true);
    assert.equal(result.action, 'start');
    assert.equal(fake.snapshot().state, 'healthy');
  }, results);

  await test('externally-started DevSpace refuses non-force stop when graceful control is unavailable', async () => {
    const fake = createRuntime('unresponsive', { gracefulAvailable: false });
    const result = await stopInternal({ force: false }, fake.runtime);
    assert.equal(result.ok, false);
    assert.equal(result.requiresForce, true);
    assert.equal(fake.snapshot().stopCalls.length, 0);
  }, results);

  await test('recover unresponsive performs supervisor graceful restart', async () => {
    const fake = createRuntime('unresponsive');
    const result = await recoverInternal({ allowForce: false }, fake.runtime);
    assert.equal(result.ok, true);
    assert.equal(result.action, 'restart');
    assert.equal(fake.snapshot().stopCalls[0].force, false);
    assert.equal(fake.snapshot().state, 'healthy');
  }, results);

  await test('recover does not escalate to force without permission', async () => {
    const fake = createRuntime('unresponsive', { gracefulStopFails: true, forceWaitTimeout: true });
    const result = await recoverInternal({ allowForce: false }, fake.runtime);
    assert.equal(result.ok, false);
    assert.equal(result.action, 'graceful-restart-failed');
    assert.equal(fake.snapshot().stopCalls.some((call) => call.force), false);
  }, results);

  await test('recover can force-stop only when explicitly allowed', async () => {
    const fake = createRuntime('unresponsive', { gracefulStopFails: true });
    const result = await recoverInternal({ allowForce: true }, fake.runtime);
    assert.equal(result.ok, true);
    assert.equal(result.action, 'force-restart');
    assert.deepEqual(fake.snapshot().stopCalls.map((call) => call.force), [false, true]);
    assert.equal(fake.snapshot().state, 'healthy');
  }, results);

  await test('recover refuses reinstall/update when restart is not safe', async () => {
    const fake = createRuntime('stopped', { restartPossible: false });
    const result = await recoverInternal({ allowForce: true }, fake.runtime);
    assert.equal(result.ok, false);
    assert.equal(result.action, 'manual-repair-required');
    assert.equal(fake.snapshot().startCalls, 0);
  }, results);

  await test('nested DevSpace config.jsonc is parsed with comments and trailing commas', async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-devspace-config-jsonc-'));
    const configPath = path.join(temp, 'config.jsonc');
    const allowedRoot = path.join(temp, 'workspace');
    try {
      fs.writeFileSync(configPath, `{
        // latest upstream nested schema
        "server": {
          "host": "0.0.0.0",
          "port": 8765,
          "publicBaseUrl": "https://example.invalid",
        },
        "workspaces": {
          "allowedRoots": [${JSON.stringify(allowedRoot)}],
        },
        "storage": {
          "stateDir": "~/state/devspace",
        },
      }`, 'utf8');
      const result = readUserConfig(configPath);
      assert.equal(result.exists, true);
      assert.equal(result.valid, true);
      assert.equal(result.config.host, '0.0.0.0');
      assert.equal(result.config.port, 8765);
      assert.deepEqual(result.config.allowedRoots, [allowedRoot]);
      assert.equal(result.config.stateDir, '~/state/devspace');
      assert.equal(result.config.publicBaseUrlConfigured, true);
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  }, results);

  await test('legacy flat DevSpace config remains readable', async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-devspace-config-legacy-'));
    const configPath = path.join(temp, 'config.json');
    const allowedRoot = path.join(temp, 'workspace');
    try {
      fs.writeFileSync(configPath, JSON.stringify({
        host: '127.0.0.1',
        port: 7676,
        allowedRoots: [allowedRoot],
        stateDir: '~/legacy-devspace',
        publicBaseUrl: 'https://legacy.example.invalid',
      }), 'utf8');
      const result = readUserConfig(configPath);
      assert.equal(result.exists, true);
      assert.equal(result.valid, true);
      assert.equal(result.config.host, '127.0.0.1');
      assert.equal(result.config.port, 7676);
      assert.deepEqual(result.config.allowedRoots, [allowedRoot]);
      assert.equal(result.config.stateDir, '~/legacy-devspace');
      assert.equal(result.config.publicBaseUrlConfigured, true);
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  }, results);

  await test('invalid DevSpace config is diagnosed without touching the real config', async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-devspace-config-'));
    const configPath = path.join(temp, 'config.json');
    try {
      fs.writeFileSync(configPath, '{ invalid json', 'utf8');
      const result = readUserConfig(configPath);
      assert.equal(result.exists, true);
      assert.equal(result.valid, false);
      assert.match(result.error, /JSON|position|property|Unexpected/i);
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  }, results);

  await test('missing workspace database is reported cleanly', async () => {
    const temp = path.join(os.tmpdir(), `gateway-workspace-missing-${process.pid}-${Date.now()}`);
    const result = workspaceState({ valid: true, config: { stateDir: temp } });
    assert.equal(result.databaseExists, false);
    assert.equal(result.activeWorkspaceCount, null);
    assert.deepEqual(result.recentWorkspaces, []);
  }, results);

  await test('workspace lookup prefers the active checkout for the same Project path', async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-workspace-lookup-'));
    const stateDir = path.join(temp, 'state');
    const project = path.join(temp, 'project');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(project, { recursive: true });
    const modulePath = path.join(managerConfig().root, 'node_modules', 'better-sqlite3');
    // eslint-disable-next-line import/no-dynamic-require, global-require
    const Database = require(modulePath);
    const databasePath = path.join(stateDir, 'devspace.sqlite');
    const db = new Database(databasePath);
    try {
      db.exec(`
        create table workspace_sessions (
          id text primary key,
          root text not null,
          status text not null,
          mode text not null,
          created_at text not null,
          last_used_at text not null
        );
      `);
      const insert = db.prepare('insert into workspace_sessions (id, root, status, mode, created_at, last_used_at) values (?, ?, ?, ?, ?, ?)');
      insert.run('ws_inactive_old', project, 'inactive', 'checkout', '2026-09-05T00:00:00.000Z', '2026-09-05T12:00:00.000Z');
      insert.run('ws_active_reuse', project, 'active', 'checkout', '2026-09-05T00:01:00.000Z', '2026-09-05T11:00:00.000Z');
      insert.run('ws_other_mode', project, 'active', 'worktree', '2026-09-05T00:02:00.000Z', '2026-09-05T13:00:00.000Z');
    } finally {
      db.close();
    }

    try {
      const result = workspaceLookup(project, { mode: 'checkout' }, { valid: true, config: { stateDir, allowedRoots: [temp] } });
      assert.equal(result.ok, true);
      assert.equal(result.found, true);
      assert.equal(result.reusable, true);
      assert.equal(result.workspace.id, 'ws_active_reuse');
      assert.equal(result.workspace.mode, 'checkout');
      assert.equal(result.recommendedAction, 'reuse-workspaceId');
      assert.equal(result.candidates.some((entry) => entry.id === 'ws_other_mode'), false);
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  }, results);

  await test('workspace lookup refuses a Project path outside DevSpace allowed roots', async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-workspace-lookup-boundary-'));
    try {
      const result = workspaceLookup(path.join(temp, 'outside'), { mode: 'checkout' }, {
        valid: true,
        config: { stateDir: path.join(temp, 'state'), allowedRoots: [path.join(temp, 'allowed')] },
      });
      assert.equal(result.ok, false);
      assert.equal(result.found, false);
      assert.match(result.error, /outside DevSpace allowed roots/i);
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  }, results);

  await test('log reader supports tail error-only and secret redaction', async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-devspace-log-'));
    const logPath = path.join(temp, 'devspace.log');
    try {
      fs.writeFileSync(logPath, [
        JSON.stringify({ ts: '2026-07-28T00:00:00.000Z', level: 'info', msg: 'ready' }),
        JSON.stringify({ ts: '2026-07-28T00:01:00.000Z', level: 'error', msg: 'failed token=super-secret-value' }),
        JSON.stringify({ ts: '2026-07-28T00:02:00.000Z', level: 'info', msg: 'still alive' }),
      ].join('\n'), 'utf8');
      const result = readLogs({ lines: 10, since: '2026-07-28T00:00:30.000Z', errorOnly: true }, logPath);
      assert.equal(result.ok, true);
      assert.equal(result.available, true);
      assert.equal(result.lines.length, 1);
      assert.match(result.lines[0], /\[REDACTED\]/);
      assert.doesNotMatch(result.lines[0], /super-secret-value/);
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  }, results);

  await test('rotating DevSpace log caps the active file and retains bounded backups', async () => {
    const { createRotatingAppender } = await import('../src/devspace/rotating-log.mjs');
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-rotating-log-'));
    const logPath = path.join(temp, 'devspace.log');
    try {
      const appender = createRotatingAppender({ file: logPath, maxBytes: 96, backupCount: 2 });
      for (let index = 0; index < 8; index += 1) {
        appender.append(`${index}:${'x'.repeat(38)}\n`);
      }
      assert.ok(fs.existsSync(logPath));
      assert.ok(fs.existsSync(`${logPath}.1`));
      assert.ok(fs.existsSync(`${logPath}.2`));
      assert.equal(fs.existsSync(`${logPath}.3`), false);
      assert.ok(fs.statSync(logPath).size <= 96);
      assert.ok(fs.statSync(`${logPath}.1`).size <= 96);
      assert.ok(fs.statSync(`${logPath}.2`).size <= 96);
      assert.match(fs.readFileSync(logPath, 'utf8'), /7:/);
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  }, results);

  await test('rotating process logger captures stdout and stderr in a child process', async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-process-log-'));
    const logPath = path.join(temp, 'devspace.log');
    const moduleUrl = pathToFileURL(path.resolve(__dirname, '..', 'src', 'devspace', 'rotating-log.mjs')).href;
    const source = [
      `import { installRotatingProcessLog } from ${JSON.stringify(moduleUrl)};`,
      `installRotatingProcessLog({ file: ${JSON.stringify(logPath)}, maxBytes: 1024, backupCount: 2 });`,
      "console.log('stdout-captured');",
      "console.error('stderr-captured');",
    ].join('\n');
    try {
      const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
        stdio: 'ignore',
        windowsHide: true,
      });
      const exitCode = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', resolve);
      });
      assert.equal(exitCode, 0);
      const text = fs.readFileSync(logPath, 'utf8');
      assert.match(text, /stdout-captured/);
      assert.match(text, /stderr-captured/);
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  }, results);

  await test('force stop revalidates process creation time before taskkill', async () => {
    if (process.platform !== 'win32') return;
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
    try {
      await new Promise((resolve) => setTimeout(resolve, 300));
      const info = await processInfo(child.pid);
      assert.equal(info.ok, true, info.error);
      assert.ok(info.process?.creationDate);
      const refused = await stopPid(child.pid, { force: true, tree: true, expectedCreationDate: '2000-01-01T00:00:00.000Z', timeoutMs: 5000 });
      assert.equal(refused.ok, false);
      assert.match(refused.error, /creation time changed/);
      const stillThere = await processInfo(child.pid);
      assert.ok(stillThere.process, 'test child should survive mismatched creation-time guard');
      const stopped = await stopPid(child.pid, { force: true, tree: true, expectedCreationDate: info.process.creationDate, timeoutMs: 5000 });
      assert.equal(stopped.ok, true, stopped.error);
    } finally {
      const current = await processInfo(child.pid);
      if (current.ok && current.process) await stopPid(child.pid, { force: true, tree: true, timeoutMs: 5000 });
    }
  }, results);

  await test('Gateway supervisor performs graceful fake DevSpace shutdown through control request', async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-supervisor-'));
    const dist = path.join(temp, 'dist');
    const requestFile = path.join(temp, 'shutdown-request.json');
    const closeMarker = path.join(temp, 'closed.txt');
    const token = 'test-control-token';
    const supervisorPath = path.resolve(__dirname, '..', 'src', 'devspace', 'supervisor.mjs');
    fs.mkdirSync(dist, { recursive: true });
    fs.writeFileSync(path.join(temp, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8');
    fs.writeFileSync(path.join(dist, 'config.js'), [
      "export function loadConfig() { return { host: '127.0.0.1', port: 0 }; }",
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(dist, 'server.js'), [
      "import fs from 'node:fs';",
      "import http from 'node:http';",
      "export function createServer() {",
      "  const app = { listen(port, host, callback) {",
      "    const server = http.createServer((_req, res) => res.end('ok'));",
      "    return server.listen(port, host, callback);",
      "  } };",
      "  const close = async () => { fs.writeFileSync(process.env.SUPERVISOR_CLOSE_MARKER, 'closed', 'utf8'); };",
      "  return { app, close };",
      "}",
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(dist, 'server-shutdown.js'), [
      "export async function shutdownHttpServer(httpServer, closeApplication) {",
      "  const httpClosed = new Promise((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve()));",
      "  await closeApplication();",
      "  await httpClosed;",
      "}",
    ].join('\n'), 'utf8');

    const child = spawn(process.execPath, [supervisorPath], {
      cwd: temp,
      env: {
        ...process.env,
        AGENTTOOLS_DEVSPACE_ROOT: temp,
        AGENTTOOLS_DEVSPACE_CONTROL_REQUEST_FILE: requestFile,
        AGENTTOOLS_DEVSPACE_CONTROL_TOKEN: token,
        AGENTTOOLS_DEVSPACE_LOG_FILE: '',
        AGENTTOOLS_DEVSPACE_LOG_MAX_BYTES: '',
        AGENTTOOLS_DEVSPACE_LOG_BACKUP_COUNT: '',
        SUPERVISOR_CLOSE_MARKER: closeMarker,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { output += chunk.toString('utf8'); });

    try {
      const readyDeadline = Date.now() + 15000;
      while (!output.includes('graceful shutdown control enabled') && child.exitCode == null && Date.now() < readyDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.equal(child.exitCode, null, output);
      assert.match(output, /graceful shutdown control enabled/);

      fs.writeFileSync(requestFile, JSON.stringify({ action: 'shutdown', token, requestedAt: new Date().toISOString() }), 'utf8');
      const exit = await Promise.race([
        new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal }))),
        new Promise((resolve) => setTimeout(() => resolve(null), 5000)),
      ]);
      assert.ok(exit, `supervisor did not exit; output=${output}`);
      assert.equal(exit.code, 0, output);
      assert.equal(fs.readFileSync(closeMarker, 'utf8'), 'closed');
      assert.equal(fs.existsSync(requestFile), false);
    } finally {
      if (child.exitCode == null) child.kill();
      await removeDirectoryWithRetry(temp);
    }
  }, results);

  await test('Gateway supervisor treats ERR_SERVER_NOT_RUNNING as completed shutdown', async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-supervisor-already-stopped-'));
    const dist = path.join(temp, 'dist');
    const requestFile = path.join(temp, 'shutdown-request.json');
    const token = 'test-control-token';
    const supervisorPath = path.resolve(__dirname, '..', 'src', 'devspace', 'supervisor.mjs');
    fs.mkdirSync(dist, { recursive: true });
    fs.writeFileSync(path.join(temp, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8');
    fs.writeFileSync(path.join(dist, 'config.js'), "export function loadConfig() { return { host: '127.0.0.1', port: 0 }; }\n", 'utf8');
    fs.writeFileSync(path.join(dist, 'server.js'), [
      "import http from 'node:http';",
      "export function createServer() {",
      "  const app = { listen(port, host, callback) {",
      "    const server = http.createServer((_req, res) => res.end('ok'));",
      "    return server.listen(port, host, callback);",
      "  } };",
      "  return { app, close: async () => {} };",
      "}",
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(dist, 'server-shutdown.js'), [
      "export async function shutdownHttpServer() {",
      "  const error = new Error('Server is not running.');",
      "  error.code = 'ERR_SERVER_NOT_RUNNING';",
      "  throw error;",
      "}",
    ].join('\n'), 'utf8');

    const child = spawn(process.execPath, [supervisorPath], {
      cwd: temp,
      env: {
        ...process.env,
        AGENTTOOLS_DEVSPACE_ROOT: temp,
        AGENTTOOLS_DEVSPACE_CONTROL_REQUEST_FILE: requestFile,
        AGENTTOOLS_DEVSPACE_CONTROL_TOKEN: token,
        AGENTTOOLS_DEVSPACE_LOG_FILE: '',
        AGENTTOOLS_DEVSPACE_LOG_MAX_BYTES: '',
        AGENTTOOLS_DEVSPACE_LOG_BACKUP_COUNT: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { output += chunk.toString('utf8'); });

    try {
      const readyDeadline = Date.now() + 15000;
      while (!output.includes('graceful shutdown control enabled') && child.exitCode == null && Date.now() < readyDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.equal(child.exitCode, null, output);
      fs.writeFileSync(requestFile, JSON.stringify({ action: 'shutdown', token, requestedAt: new Date().toISOString() }), 'utf8');
      const exit = await Promise.race([
        new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal }))),
        new Promise((resolve) => setTimeout(() => resolve(null), 5000)),
      ]);
      assert.ok(exit, `supervisor did not exit; output=${output}`);
      assert.equal(exit.code, 0, output);
      assert.match(output, /already stopped; treating shutdown as complete/);
    } finally {
      if (child.exitCode == null) child.kill();
      await removeDirectoryWithRetry(temp);
    }
  }, results);

  await test('HTTP probe distinguishes reachable fake server', async () => {
    const server = http.createServer((req, res) => {
      if (req.url === '/healthz') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ ok: true, name: 'devspace' }));
      } else {
        res.statusCode = 401;
        res.end('unauthorized');
      }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      const probe = await requestProbe({ host: '127.0.0.1', port: address.port, pathName: '/healthz', timeoutMs: 1000 });
      assert.equal(probe.reachable, true);
      assert.equal(probe.statusCode, 200);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }, results);

  const ok = results.every((entry) => entry.ok);
  process.stdout.write(`${JSON.stringify({ ok, productionDevSpaceTouched: false, results }, null, 2)}\n`);
  if (!ok) process.exitCode = 1;
}

main().catch((error) => {
  process.stdout.write(`${JSON.stringify({ ok: false, productionDevSpaceTouched: false, error: error.stack || error.message }, null, 2)}\n`);
  process.exitCode = 1;
});
