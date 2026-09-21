const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { readJson, projectRoot } = require('./config');
const { run, spawnDetached } = require('./runner');
const { findProcesses, processInfo, listeningPids } = require('./processes');
const { resolveGitExecutable } = require('./executables');
const { sanitizeLogText } = require('./redaction');

function managerConfig() {
  return readJson('config/devspace.json');
}

function installationChecksStartable(checks = {}) {
  return Boolean(
    checks.rootExists
    && checks.entryExists
    && checks.serverEntryExists
    && checks.configEntryExists
    && checks.shutdownEntryExists
    && checks.supervisorExists
    && checks.packageExists
    && checks.packageVersionReadable
    && checks.expectedVersionMatches
    && checks.nodeModulesExists
  );
}

function controlStatePath() {
  return path.join(projectRoot, 'state', 'devspace', 'control.json');
}

function controlRequestPath() {
  return path.join(projectRoot, 'state', 'devspace', 'shutdown-request.json');
}

function readControlState() {
  const file = controlStatePath();
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const pid = Number(parsed.pid);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    return { ...parsed, pid };
  } catch {
    return null;
  }
}

function writeControlState(control) {
  const file = controlStatePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(control, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, file);
  return file;
}

function clearControlState(pids = []) {
  const expected = new Set((Array.isArray(pids) ? pids : [pids]).map(Number).filter((pid) => Number.isInteger(pid) && pid > 0));
  if (expected.size > 0) {
    const control = readControlState();
    if (!control || !expected.has(control.pid)) return false;
  }

  let removed = false;
  for (const file of [controlStatePath(), controlRequestPath()]) {
    try {
      fs.unlinkSync(file);
      removed = true;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return removed;
}

function controlMatchesProcess(control, processInfo) {
  if (!control || !processInfo || control.pid !== processInfo.pid || control.controlMode !== 'supervisor-file-request') return false;
  const recorded = Date.parse(String(control.startedAt || ''));
  const observed = Date.parse(String(processInfo.creationDate || ''));
  if (!Number.isFinite(recorded) || !Number.isFinite(observed)) return false;
  return Math.abs(recorded - observed) <= 5000;
}

function requestGracefulShutdown(pid) {
  const numericPid = Number(pid);
  const control = readControlState();
  if (!Number.isInteger(numericPid) || numericPid <= 0 || !control || control.pid !== numericPid || control.controlMode !== 'supervisor-file-request' || !control.token) {
    return { ok: false, pid, method: 'supervisor-file-request', error: 'No verified Gateway supervisor control is available for this PID.' };
  }
  const file = controlRequestPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const request = { action: 'shutdown', token: control.token, requestedAt: new Date().toISOString(), pid: numericPid };
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(request)}\n`, 'utf8');
  fs.renameSync(temp, file);
  return { ok: true, pid: numericPid, method: 'supervisor-file-request', requestedAt: request.requestedAt };
}

function resolveConfiguredPath(value, base = projectRoot) {
  const text = String(value || '');
  if (!text) return null;
  if (text.startsWith('~/') || text.startsWith('~\\')) return path.resolve(os.homedir(), text.slice(2));
  return path.isAbsolute(text) ? path.resolve(text) : path.resolve(base, text);
}

function parseJsoncConfigFile(configPath) {
  const parserPath = path.join(managerConfig().root, 'node_modules', 'jsonc-parser');
  // eslint-disable-next-line import/no-dynamic-require, global-require
  const { parse, printParseErrorCode } = require(parserPath);
  const errors = [];
  const parsed = parse(fs.readFileSync(configPath, 'utf8'), errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  if (errors.length > 0) {
    const first = errors[0];
    const code = printParseErrorCode(first.error);
    throw new Error(`JSONC parse error ${code} at offset ${first.offset}`);
  }
  return parsed;
}

function readUserConfig(configPath = null) {
  const configDir = path.join(os.homedir(), '.devspace');
  const jsoncPath = configPath || path.join(configDir, 'config.jsonc');
  const legacyPath = configPath || path.join(configDir, 'config.json');
  const selectedPath = fs.existsSync(jsoncPath)
    ? jsoncPath
    : (!configPath && fs.existsSync(legacyPath) ? legacyPath : jsoncPath);

  if (!fs.existsSync(selectedPath)) {
    return { exists: false, valid: false, path: selectedPath, config: null, error: `${path.basename(selectedPath)} does not exist` };
  }

  try {
    const parsed = parseJsoncConfigFile(selectedPath);
    const server = parsed?.server && typeof parsed.server === 'object' ? parsed.server : parsed;
    const workspaces = parsed?.workspaces && typeof parsed.workspaces === 'object' ? parsed.workspaces : parsed;
    const storage = parsed?.storage && typeof parsed.storage === 'object' ? parsed.storage : parsed;
    return {
      exists: true,
      valid: true,
      path: selectedPath,
      config: {
        host: server?.host,
        port: server?.port,
        allowedRoots: Array.isArray(workspaces?.allowedRoots) ? workspaces.allowedRoots : undefined,
        stateDir: storage?.stateDir,
        publicBaseUrlConfigured: Boolean(server?.publicBaseUrl),
      },
      error: null,
    };
  } catch (error) {
    return { exists: true, valid: false, path: selectedPath, config: null, error: error.message };
  }
}

function endpointConfig() {
  const cfg = managerConfig();
  const user = readUserConfig();
  const hostValue = user.valid && user.config.host ? String(user.config.host) : String(cfg.defaultHost || '127.0.0.1');
  const host = hostValue === '0.0.0.0' || hostValue === '::' ? '127.0.0.1' : hostValue;
  const portValue = user.valid && user.config.port != null ? Number(user.config.port) : Number(cfg.defaultPort || 7676);
  const port = Number.isInteger(portValue) && portValue >= 1 && portValue <= 65535 ? portValue : Number(cfg.defaultPort || 7676);
  return { host, port, userConfig: user };
}

function requestProbe({ host, port, pathName, method = 'GET', timeoutMs = 2500, headers = {} }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const req = http.request({ host, port, path: pathName, method, headers }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        if (size >= 65536) return;
        const buffer = Buffer.from(chunk);
        size += buffer.length;
        chunks.push(buffer);
      });
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8').slice(0, 65536);
        resolve({
          ok: true,
          reachable: true,
          statusCode: res.statusCode || null,
          elapsedMs: Date.now() - started,
          body: sanitizeLogText(body, 2000),
          error: null,
        });
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`probe timeout after ${timeoutMs}ms`)));
    req.on('error', (error) => resolve({
      ok: false,
      reachable: false,
      statusCode: null,
      elapsedMs: Date.now() - started,
      body: '',
      error: error.message,
    }));
    req.end();
  });
}

async function probeEndpoints() {
  const cfg = managerConfig();
  const endpoint = endpointConfig();
  const timeoutMs = Number(cfg.healthTimeoutMs || 2500);
  const [healthz, mcp] = await Promise.all([
    requestProbe({ host: endpoint.host, port: endpoint.port, pathName: cfg.healthPath || '/healthz', timeoutMs }),
    requestProbe({
      host: endpoint.host,
      port: endpoint.port,
      pathName: '/mcp',
      timeoutMs,
      headers: { Accept: 'application/json, text/event-stream' },
    }),
  ]);

  let healthBody = null;
  try { healthBody = healthz.body ? JSON.parse(healthz.body) : null; } catch { healthBody = null; }
  const healthResponsive = healthz.reachable && healthz.statusCode === 200 && healthBody?.ok === true && healthBody?.name === 'devspace';
  const mcpResponsive = mcp.reachable && [200, 400, 401, 403, 405, 406].includes(Number(mcp.statusCode));

  return {
    host: endpoint.host,
    port: endpoint.port,
    healthz: { ...healthz, parsed: healthBody },
    mcp: { ...mcp, responsive: mcpResponsive },
    healthResponsive,
    mcpResponsive,
    userConfig: endpoint.userConfig,
  };
}

function pidAlive(pid) {
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) return false;
  try {
    process.kill(numericPid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function watchdogStatus() {
  const probes = await probeEndpoints();
  const control = readControlState();
  const controlledPid = Number(control?.pid);
  const controlledProcessRunning = pidAlive(controlledPid);
  const endpointResponsive = probes.healthResponsive && probes.mcpResponsive;
  const endpointReachable = Boolean(probes.healthz?.reachable || probes.mcp?.reachable);

  let state = 'unknown';
  if (endpointResponsive) state = 'healthy';
  else if (controlledProcessRunning) state = 'unresponsive';
  else if (endpointReachable) state = 'degraded';
  else state = 'stopped';

  return {
    ok: true,
    status: state,
    processRunning: controlledProcessRunning || endpointResponsive,
    portOccupied: endpointReachable,
    listenerPids: controlledProcessRunning ? [controlledPid] : [],
    mcpResponsive: probes.mcpResponsive,
    healthResponsive: probes.healthResponsive,
    pid: controlledProcessRunning ? controlledPid : null,
    pids: controlledProcessRunning ? [controlledPid] : [],
    checkedAt: new Date().toISOString(),
    endpoint: { host: probes.host, port: probes.port, healthPath: managerConfig().healthPath || '/healthz' },
    probes: { healthz: probes.healthz, mcp: probes.mcp },
    error: null,
  };
}

async function devspaceProcesses() {
  const cfg = managerConfig();
  const endpoint = endpointConfig();
  const pattern = cfg.processPattern || 'dist[\\/]cli\\.js["\']?\\s+serve';
  const [matched, listeners] = await Promise.all([
    findProcesses(pattern),
    listeningPids(endpoint.port),
  ]);
  if (!matched.ok && !listeners.ok) {
    return { ok: false, pattern, port: endpoint.port, processes: [], listenerPids: [], error: [matched.error, listeners.error].filter(Boolean).join('; ') };
  }

  const control = readControlState();
  const byPid = new Map();
  for (const entry of matched.processes || []) byPid.set(entry.pid, entry);
  for (const pid of listeners.pids || []) {
    if (byPid.has(pid)) continue;
    const info = await processInfo(pid);
    if (info.ok && info.process) byPid.set(pid, info.process);
  }
  if (control?.pid && !byPid.has(control.pid)) {
    const info = await processInfo(control.pid);
    if (info.ok && info.process) byPid.set(control.pid, info.process);
  }

  const serverRegex = /dist[\\/]cli\.js["']?\s+serve/i;
  const launcherPath = path.join(path.resolve(cfg.root), cfg.launcherBat || 'Start-DevSpace-PR103.bat');
  const launcherPortable = launcherPath.replace(/\\/g, '/').toLowerCase();
  const supervisorPath = path.join(projectRoot, cfg.supervisorEntry || 'src/devspace/supervisor.mjs');
  const supervisorPortable = supervisorPath.replace(/\\/g, '/').toLowerCase();
  const candidates = [];
  for (const entry of byPid.values()) {
    const exe = String(entry.executablePath || '').replace(/\\/g, '/');
    const commandPortable = String(entry.commandLine || '').replace(/\\/g, '/').toLowerCase();
    const isNode = /(^|\/)node\.exe$/i.test(exe) || /^node\.exe$/i.test(entry.name || '');
    const looksLikeServer = serverRegex.test(entry.commandLine || '') || commandPortable.includes(supervisorPortable);
    if (!isNode || !looksLikeServer) continue;

    const ownsPort = (listeners.pids || []).includes(entry.pid);
    let parent = null;
    let launchedByConfiguredLauncher = false;
    if (entry.parentPid) {
      const parentResult = await processInfo(entry.parentPid);
      parent = parentResult.ok ? parentResult.process : null;
      const parentCommand = String(parent?.commandLine || '').replace(/\\/g, '/').toLowerCase();
      launchedByConfiguredLauncher = parentCommand.includes(launcherPortable);
    }

    const gatewayManagedControlVerified = controlMatchesProcess(control, entry);
    candidates.push({
      ...entry,
      ownership: {
        verified: ownsPort || launchedByConfiguredLauncher || gatewayManagedControlVerified,
        ownsConfiguredPort: ownsPort,
        launchedByConfiguredLauncher,
        gatewayManagedControlVerified,
        gracefulStopAvailable: gatewayManagedControlVerified,
        parent: parent ? { pid: parent.pid, name: parent.name, commandLine: parent.commandLine } : null,
      },
    });
  }

  const processes = candidates.filter((entry) => entry.ownership.verified);
  return {
    ok: Boolean(matched.ok || listeners.ok),
    pattern,
    port: endpoint.port,
    processes,
    candidates,
    listenerPids: listeners.pids || [],
    ownershipVerified: processes.length > 0,
    error: [matched.ok ? null : matched.error, listeners.ok ? null : listeners.error].filter(Boolean).join('; ') || null,
  };
}

function stateDirectory(userConfig = readUserConfig()) {
  const configured = userConfig.valid && userConfig.config.stateDir ? resolveConfiguredPath(userConfig.config.stateDir, os.homedir()) : null;
  return configured || path.join(os.homedir(), '.local', 'share', 'devspace');
}

function canonicalWorkspaceRoot(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  let resolved = path.resolve(text);
  try {
    if (fs.existsSync(resolved)) resolved = fs.realpathSync.native(resolved);
  } catch {
    // Path canonicalization is best-effort; persisted DevSpace state remains the source of truth.
  }
  return path.normalize(resolved);
}

function sameWorkspaceRoot(left, right) {
  const a = canonicalWorkspaceRoot(left);
  const b = canonicalWorkspaceRoot(right);
  if (!a || !b) return false;
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function workspaceRootAllowed(targetRoot, allowedRoots = []) {
  const target = canonicalWorkspaceRoot(targetRoot);
  if (!target || !Array.isArray(allowedRoots) || allowedRoots.length === 0) return false;
  const targetCmp = process.platform === 'win32' ? target.toLowerCase() : target;
  return allowedRoots.some((allowedRoot) => {
    const root = canonicalWorkspaceRoot(allowedRoot);
    if (!root) return false;
    const rootCmp = process.platform === 'win32' ? root.toLowerCase() : root;
    return targetCmp === rootCmp || targetCmp.startsWith(`${rootCmp}${path.sep}`);
  });
}

function workspaceLookup(projectPath, options = {}, userConfig = readUserConfig()) {
  const requestedRoot = canonicalWorkspaceRoot(projectPath);
  const mode = String(options.mode || 'checkout').toLowerCase() === 'worktree' ? 'worktree' : 'checkout';
  const stateDir = stateDirectory(userConfig);
  const databasePath = path.join(stateDir, 'devspace.sqlite');

  if (!requestedRoot) {
    return {
      ok: false,
      found: false,
      reusable: false,
      requestedRoot: null,
      mode,
      stateDir,
      databasePath,
      workspace: null,
      candidates: [],
      recommendedAction: 'open_workspace',
      error: 'Project path is required.',
    };
  }

  const allowedRoots = userConfig?.valid && Array.isArray(userConfig.config?.allowedRoots)
    ? userConfig.config.allowedRoots
    : [];
  if (!workspaceRootAllowed(requestedRoot, allowedRoots)) {
    return {
      ok: false,
      found: false,
      reusable: false,
      requestedRoot,
      mode,
      stateDir,
      databasePath,
      workspace: null,
      candidates: [],
      recommendedAction: 'open_workspace',
      error: allowedRoots.length > 0
        ? 'Project path is outside DevSpace allowed roots.'
        : 'DevSpace allowed roots are unavailable; refusing workspace lookup.',
    };
  }

  if (!fs.existsSync(databasePath)) {
    return {
      ok: true,
      found: false,
      reusable: false,
      requestedRoot,
      mode,
      stateDir,
      databasePath,
      workspace: null,
      candidates: [],
      recommendedAction: 'open_workspace',
      error: null,
      note: 'DevSpace workspace database is not present; open_workspace is required.',
    };
  }

  const cfg = managerConfig();
  const modulePath = path.join(cfg.root, 'node_modules', 'better-sqlite3');
  try {
    // Resolve DevSpace's pinned SQLite dependency and inspect its session DB read-only.
    // eslint-disable-next-line import/no-dynamic-require, global-require
    const Database = require(modulePath);
    const db = new Database(databasePath, { readonly: true, fileMustExist: true });
    try {
      const collation = process.platform === 'win32' ? ' COLLATE NOCASE' : '';
      let rows = db.prepare(`select id, root, status, mode, created_at as createdAt, last_used_at as lastUsedAt from workspace_sessions where mode = ? and root = ?${collation} order by case when status = 'active' then 0 else 1 end, last_used_at desc limit 20`).all(mode, requestedRoot);

      if (rows.length === 0) {
        const recent = db.prepare("select id, root, status, mode, created_at as createdAt, last_used_at as lastUsedAt from workspace_sessions where mode = ? order by case when status = 'active' then 0 else 1 end, last_used_at desc limit 200").all(mode);
        rows = recent.filter((row) => sameWorkspaceRoot(row.root, requestedRoot)).slice(0, 20);
      }

      const candidates = rows.map((row) => ({
        ...row,
        id: sanitizeLogText(row.id, 200),
        root: canonicalWorkspaceRoot(row.root) || row.root,
      }));
      const workspace = candidates.find((row) => row.status === 'active') || candidates[0] || null;
      const reusable = workspace?.status === 'active';

      return {
        ok: true,
        found: Boolean(workspace),
        reusable,
        requestedRoot,
        mode,
        stateDir,
        databasePath,
        workspace,
        candidates,
        recommendedAction: reusable ? 'reuse-workspaceId' : 'open_workspace',
        error: null,
        note: reusable
          ? 'Active DevSpace workspace found for this Project path. Reuse its workspaceId when continuing the same development context.'
          : workspace
            ? 'Only an inactive/recent workspace was found. Use open_workspace; do not force an inactive workspaceId.'
            : 'No matching workspace session was found. Use open_workspace.',
      };
    } finally {
      db.close();
    }
  } catch (error) {
    return {
      ok: false,
      found: false,
      reusable: false,
      requestedRoot,
      mode,
      stateDir,
      databasePath,
      workspace: null,
      candidates: [],
      recommendedAction: 'open_workspace',
      error: error.message,
    };
  }
}

function workspaceState(userConfig = readUserConfig()) {
  const stateDir = stateDirectory(userConfig);
  const databasePath = path.join(stateDir, 'devspace.sqlite');
  if (!fs.existsSync(databasePath)) {
    return { stateDir, databasePath, databaseExists: false, activeWorkspaceCount: null, recentWorkspaces: [], error: null };
  }

  const cfg = managerConfig();
  const modulePath = path.join(cfg.root, 'node_modules', 'better-sqlite3');
  try {
    // Resolve DevSpace's own pinned native dependency without adding it to the Gateway.
    // eslint-disable-next-line import/no-dynamic-require, global-require
    const Database = require(modulePath);
    const db = new Database(databasePath, { readonly: true, fileMustExist: true });
    try {
      const countRow = db.prepare("select count(*) as count from workspace_sessions where status = 'active'").get();
      const rows = db.prepare('select id, root, status, mode, created_at as createdAt, last_used_at as lastUsedAt from workspace_sessions order by last_used_at desc limit 20').all();
      return {
        stateDir,
        databasePath,
        databaseExists: true,
        activeWorkspaceCount: Number(countRow?.count ?? 0),
        recentWorkspaces: rows.map((row) => ({ ...row, id: sanitizeLogText(row.id, 200) })),
        error: null,
      };
    } finally {
      db.close();
    }
  } catch (error) {
    return { stateDir, databasePath, databaseExists: true, activeWorkspaceCount: null, recentWorkspaces: [], error: error.message };
  }
}

async function installationState() {
  const cfg = managerConfig();
  const root = path.resolve(cfg.root);
  const entryPath = path.join(root, cfg.entry || 'dist/cli.js');
  const serverEntryPath = path.join(root, cfg.serverEntry || 'dist/server.js');
  const configEntryPath = path.join(root, cfg.configEntry || 'dist/config.js');
  const shutdownEntryPath = path.join(root, cfg.shutdownEntry || 'dist/server-shutdown.js');
  const supervisorPath = path.join(projectRoot, cfg.supervisorEntry || 'src/devspace/supervisor.mjs');
  const packagePath = path.join(root, cfg.packageFile || 'package.json');
  const launcherPath = path.join(root, cfg.launcherBat || 'Start-DevSpace-PR103.bat');
  const doctorPath = path.join(root, cfg.doctorBat || 'Doctor-DevSpace-PR103.bat');
  let packageVersion = null;
  let packageError = null;
  try {
    packageVersion = JSON.parse(fs.readFileSync(packagePath, 'utf8')).version || null;
  } catch (error) {
    packageError = error.message;
  }

  let currentCommit = null;
  let gitError = null;
  let workingTreeDirty = null;
  let workingTreeSummary = [];
  if (fs.existsSync(root)) {
    const gitExe = resolveGitExecutable();
    const [head, worktree] = await Promise.all([
      run(gitExe, ['-C', root, 'rev-parse', 'HEAD'], { timeoutMs: 10000 }),
      run(gitExe, ['-C', root, 'status', '--short'], { timeoutMs: 10000, maxBuffer: 1024 * 1024 }),
    ]);
    if (head.ok) currentCommit = head.stdout.trim();
    else gitError = head.error || head.stderr;
    if (worktree.ok) {
      workingTreeSummary = worktree.stdout.split(/\r?\n/).filter(Boolean).slice(0, 50).map((line) => sanitizeLogText(line, 1000));
      workingTreeDirty = workingTreeSummary.length > 0;
    } else if (!gitError) {
      gitError = worktree.error || worktree.stderr;
    }
  }

  const expectedVersion = cfg.expectedVersion || null;
  const pinnedCommit = String(cfg.pinnedCommit || '').trim().toLowerCase();
  const normalizedCurrentCommit = String(currentCommit || '').trim().toLowerCase();
  const checks = {
    rootExists: fs.existsSync(root),
    entryExists: fs.existsSync(entryPath),
    serverEntryExists: fs.existsSync(serverEntryPath),
    configEntryExists: fs.existsSync(configEntryPath),
    shutdownEntryExists: fs.existsSync(shutdownEntryPath),
    supervisorExists: fs.existsSync(supervisorPath),
    packageExists: fs.existsSync(packagePath),
    packageVersionReadable: Boolean(packageVersion),
    expectedVersionMatches: Boolean(packageVersion && (!expectedVersion || packageVersion === expectedVersion)),
    nodeModulesExists: fs.existsSync(path.join(root, 'node_modules')),
    launcherExists: fs.existsSync(launcherPath),
    doctorExists: fs.existsSync(doctorPath),
    commitReadable: Boolean(currentCommit),
    pinnedCommitMatches: Boolean(normalizedCurrentCommit && pinnedCommit && normalizedCurrentCommit === pinnedCommit),
  };

  return {
    root,
    entryPath,
    serverEntryPath,
    configEntryPath,
    shutdownEntryPath,
    supervisorPath,
    packagePath,
    launcherPath,
    doctorPath,
    packageVersion,
    expectedVersion,
    packageError,
    currentCommit,
    pinnedCommit: cfg.pinnedCommit || null,
    workingTreeDirty,
    workingTreeSummary,
    gitError: gitError ? sanitizeLogText(gitError, 2000) : null,
    checks,
    startable: installationChecksStartable(checks),
  };
}

function classifyStatus({ processRunning, portOccupied, healthResponsive, mcpResponsive, installation }) {
  if (!processRunning && !portOccupied && !healthResponsive && !mcpResponsive) return 'stopped';
  if (processRunning && (!healthResponsive || !mcpResponsive)) return 'unresponsive';
  if (healthResponsive && mcpResponsive && processRunning && installation.startable) return 'healthy';
  if (healthResponsive || mcpResponsive || processRunning || portOccupied) return 'degraded';
  return 'unknown';
}

async function status() {
  const [processResult, probes, installation] = await Promise.all([
    devspaceProcesses(),
    probeEndpoints(),
    installationState(),
  ]);
  const processes = processResult.ok ? processResult.processes : [];
  const processRunning = processes.length > 0;
  const listenerPids = processResult.ok ? processResult.listenerPids || [] : [];
  const portOccupied = listenerPids.length > 0;
  const workspace = workspaceState(probes.userConfig);
  const state = classifyStatus({
    processRunning,
    portOccupied,
    healthResponsive: probes.healthResponsive,
    mcpResponsive: probes.mcpResponsive,
    installation,
  });

  return {
    ok: processResult.ok,
    status: state,
    processRunning,
    portOccupied,
    listenerPids,
    mcpResponsive: probes.mcpResponsive,
    healthResponsive: probes.healthResponsive,
    pid: processes[0]?.pid || null,
    pids: processes.map((entry) => entry.pid),
    processes,
    startedAt: processes.map((entry) => entry.creationDate).filter(Boolean).sort()[0] || null,
    version: installation.packageVersion,
    checkedAt: new Date().toISOString(),
    endpoint: { host: probes.host, port: probes.port, healthPath: managerConfig().healthPath || '/healthz' },
    probes: { healthz: probes.healthz, mcp: probes.mcp },
    installation,
    userConfig: probes.userConfig,
    workspace,
    error: processResult.ok ? null : processResult.error,
  };
}

function logFilePath() {
  const cfg = managerConfig();
  return resolveConfiguredPath(cfg.logFile || 'state/devspace/devspace.log', projectRoot);
}

function parseLineTimestamp(line) {
  const text = String(line || '').trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (parsed && parsed.ts) return Date.parse(parsed.ts);
  } catch { /* pretty/plain log */ }
  const prefix = text.match(/^(\d{4}-\d{2}-\d{2}T[^\s]+)/)?.[1];
  return prefix ? Date.parse(prefix) : null;
}

function readLogs(options = {}, fileOverride = null) {
  const cfg = managerConfig();
  const file = fileOverride ? path.resolve(fileOverride) : logFilePath();
  const requestedLines = Number(options.lines ?? options.tail ?? 100);
  const limit = Math.max(1, Math.min(Number.isFinite(requestedLines) ? Math.floor(requestedLines) : 100, Number(cfg.maxLogLines || 500)));
  const errorOnly = options.errorOnly === true || options['error-only'] === true || options.errorOnly === 'true' || options['error-only'] === 'true';
  const sinceMs = options.since ? Date.parse(String(options.since)) : null;

  if (!fs.existsSync(file)) {
    return {
      ok: true,
      available: false,
      file,
      lines: [],
      note: 'No Gateway-managed DevSpace log exists yet. Existing externally-started DevSpace stdout cannot be retroactively captured.',
    };
  }

  const stat = fs.statSync(file);
  const maxReadBytes = 1024 * 1024 * 4;
  const start = Math.max(0, stat.size - maxReadBytes);
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    let lines = buffer.toString('utf8').split(/\r?\n/).filter(Boolean);
    if (start > 0 && lines.length > 0) lines = lines.slice(1);
    if (Number.isFinite(sinceMs)) lines = lines.filter((line) => {
      const timestamp = parseLineTimestamp(line);
      return timestamp == null || timestamp >= sinceMs;
    });
    if (errorOnly) lines = lines.filter((line) => /\b(error|failed|failure|exception|fatal|unhandled)\b/i.test(line));
    lines = lines.slice(-limit).map((line) => sanitizeLogText(line, 4000));
    return { ok: true, available: true, file, sizeBytes: stat.size, truncatedRead: start > 0, lines, errorOnly, since: options.since || null };
  } finally {
    fs.closeSync(fd);
  }
}

async function diagnose() {
  const current = await status();
  const findings = [];
  const add = (component, statusValue, message, details = undefined) => findings.push({ component, status: statusValue, message, details });

  add('process', current.processRunning ? 'ok' : 'failed', current.processRunning ? `DevSpace process detected (${current.pids.join(', ')})` : 'Trusted DevSpace server process was not detected.');
  add('port', current.portOccupied ? (current.processRunning ? 'ok' : 'warning') : (current.processRunning ? 'warning' : 'ok'), current.portOccupied ? `Configured port ${current.endpoint.port} is listening (PID ${current.listenerPids.join(', ')}).` : `Configured port ${current.endpoint.port} has no listener.`);
  add('healthz', current.healthResponsive ? 'ok' : 'failed', current.healthResponsive ? 'GET /healthz returned the expected DevSpace response.' : `Health probe failed: ${current.probes.healthz.error || current.probes.healthz.statusCode || 'no response'}`);
  add('mcp', current.mcpResponsive ? 'ok' : 'failed', current.mcpResponsive ? `MCP route responded with HTTP ${current.probes.mcp.statusCode}.` : `MCP route probe failed: ${current.probes.mcp.error || current.probes.mcp.statusCode || 'no response'}`);
  add('executable', current.installation.checks.entryExists ? 'ok' : 'failed', current.installation.checks.entryExists ? current.installation.entryPath : `Missing ${current.installation.entryPath}`);
  add('package', current.installation.checks.packageExists && current.installation.checks.packageVersionReadable && current.installation.checks.nodeModulesExists ? 'ok' : 'failed', current.installation.checks.nodeModulesExists ? `DevSpace package/dependencies are present; version=${current.version || 'unreadable'}.` : 'node_modules is missing; automatic reinstall is intentionally disabled.');
  add('version', current.installation.checks.expectedVersionMatches ? 'ok' : 'failed', current.installation.checks.expectedVersionMatches ? `DevSpace version ${current.installation.packageVersion} matches expected version.` : `Version mismatch or unreadable. expected=${current.installation.expectedVersion || 'not configured'} actual=${current.installation.packageVersion || 'unknown'}`);
  const sourceMessage = current.installation.checks.pinnedCommitMatches
    ? `Pinned upstream commit ${current.installation.currentCommit} matches.`
    : current.installation.checks.commitReadable
      ? `Runtime checkout is at ${current.installation.currentCommit}; expected reference is ${current.installation.pinnedCommit || 'not configured'}. Commit drift is diagnostic only and does not block restart.`
      : 'Runtime Git commit is unreadable. Commit state is diagnostic only and does not block restart.';
  add('source', current.installation.checks.pinnedCommitMatches ? 'ok' : 'warning', sourceMessage, { pinnedCommit: current.installation.pinnedCommit, currentCommit: current.installation.currentCommit });
  const gracefulStopAvailable = current.processes.some((processInfo) => processInfo.ownership?.gracefulStopAvailable);
  add('control', current.processRunning ? (gracefulStopAvailable ? 'ok' : 'warning') : 'ok', current.processRunning ? (gracefulStopAvailable ? 'Gateway supervisor control is available; graceful stop will call DevSpace shutdownHttpServer(..., close).' : 'This DevSpace was started outside the Gateway supervisor; non-force stop will be refused rather than emulated with taskkill.') : 'No running DevSpace requires shutdown control.');
  add('worktree', current.installation.workingTreeDirty ? 'warning' : 'ok', current.installation.workingTreeDirty ? 'Pinned checkout has local working-tree changes. They are reported but not automatically modified or treated as corruption.' : 'Pinned checkout working tree is clean.', current.installation.workingTreeDirty ? { changes: current.installation.workingTreeSummary } : undefined);
  add('config', current.userConfig.exists && current.userConfig.valid ? 'ok' : 'failed', current.userConfig.valid ? `Config readable at ${current.userConfig.path}.` : `Config unavailable or invalid: ${current.userConfig.error}`);
  add('workspace', current.workspace.error ? 'warning' : 'ok', current.workspace.error ? `Workspace state could not be read: ${current.workspace.error}` : `Workspace database ${current.workspace.databaseExists ? 'available' : 'not yet present'}; active=${current.workspace.activeWorkspaceCount ?? 'unknown'}.`);
  add('logs', fs.existsSync(logFilePath()) ? 'ok' : 'warning', fs.existsSync(logFilePath()) ? `Gateway-managed log available at ${logFilePath()}.` : 'No Gateway-managed DevSpace log yet; this is expected for an instance started outside the Gateway.');

  let recommendedAction = 'inspect';
  let restartPossible = current.installation.startable;
  if (current.status === 'healthy') recommendedAction = 'none';
  else if (current.status === 'stopped' && restartPossible) recommendedAction = 'start';
  else if (current.status === 'unresponsive' && restartPossible) recommendedAction = 'restart';
  else if (!current.installation.startable) recommendedAction = 'repair-installation-manually';

  return {
    ok: true,
    overall: current.status === 'healthy' ? 'healthy' : 'unhealthy',
    status: current.status,
    findings,
    recommendedAction,
    restartPossible,
    checkedAt: current.checkedAt,
    snapshot: current,
    note: 'No reinstall, update, config rewrite, service change, or Scheduled Task change is performed by diagnose.',
  };
}

function startProcess() {
  const cfg = managerConfig();
  const root = path.resolve(cfg.root);
  const supervisorPath = path.join(projectRoot, cfg.supervisorEntry || 'src/devspace/supervisor.mjs');
  const requestFile = controlRequestPath();
  const logFile = logFilePath();
  const token = crypto.randomBytes(32).toString('hex');
  const startedAt = new Date().toISOString();

  clearControlState([]);
  fs.mkdirSync(path.dirname(requestFile), { recursive: true });
  const spawned = spawnDetached(process.execPath, [supervisorPath], {
    cwd: root,
    env: {
      ...(cfg.environment || {}),
      AGENTTOOLS_DEVSPACE_ROOT: root,
      AGENTTOOLS_DEVSPACE_CONTROL_REQUEST_FILE: requestFile,
      AGENTTOOLS_DEVSPACE_CONTROL_TOKEN: token,
      AGENTTOOLS_DEVSPACE_LOG_FILE: logFile,
      AGENTTOOLS_DEVSPACE_LOG_MAX_BYTES: String(cfg.logMaxBytes || 5 * 1024 * 1024),
      AGENTTOOLS_DEVSPACE_LOG_BACKUP_COUNT: String(cfg.logBackupCount || 3),
    },
  });
  if (!spawned.ok) return spawned;
  const control = {
    pid: spawned.pid,
    startedAt,
    root,
    supervisorPath,
    requestFile,
    token,
    controlMode: 'supervisor-file-request',
  };
  writeControlState(control);
  return {
    ...spawned,
    logFile,
    control: {
      pid: control.pid,
      startedAt: control.startedAt,
      supervisorPath: control.supervisorPath,
      requestFile: control.requestFile,
      controlMode: control.controlMode,
    },
  };
}

async function waitFor(predicate, timeoutMs, intervalMs = 300) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await predicate();
    if (last) return { ok: true, value: last };
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return { ok: false, value: last, error: `timeout after ${timeoutMs}ms` };
}

module.exports = {
  managerConfig,
  installationChecksStartable,
  controlStatePath,
  controlRequestPath,
  readControlState,
  writeControlState,
  clearControlState,
  controlMatchesProcess,
  requestGracefulShutdown,
  readUserConfig,
  endpointConfig,
  requestProbe,
  probeEndpoints,
  watchdogStatus,
  devspaceProcesses,
  installationState,
  canonicalWorkspaceRoot,
  sameWorkspaceRoot,
  workspaceRootAllowed,
  workspaceLookup,
  workspaceState,
  status,
  readLogs,
  diagnose,
  logFilePath,
  startProcess,
  waitFor,
};
