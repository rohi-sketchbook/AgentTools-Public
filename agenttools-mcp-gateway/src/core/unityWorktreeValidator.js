const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { projectRoot, readJson } = require('./config');
const { canonicalizePath } = require('./paths');
const { resolveGitExecutable, resolveUnityExecutable } = require('./executables');
const {
  run,
  spawnDetached,
  encodePowerShellCommand,
  windowsPowerShellPath,
} = require('./runner');
const { queryProcesses, processInfo, stopPid } = require('./processes');
const { sanitizeLogText } = require('./redaction');

const DEFAULT_SNAPSHOT_RETENTION = {
  keepPerDependency: 5,
  maxBytes: 2 * 1024 * 1024 * 1024,
  cleanupIntervalMs: 24 * 60 * 60 * 1000,
  lastUsedTouchMs: 60 * 60 * 1000,
};

const DEFAULT_DEPENDENCIES = [
  { path: 'Packages/jp.lilxyzw.liltoon', required: true },
  { path: 'Packages/com.heath.lattice', required: true },
  { path: 'Assets/DynamicBone', required: true },
  { path: 'Assets/Plugins/RootMotion', required: true },
  { path: 'Assets/FluidFlow', required: true },
  { path: 'Assets/Beautify', required: false },
  { path: 'Assets/TextMesh Pro', required: false },
  { path: 'Assets/XR', required: false },
  { path: 'Assets/XRI', required: false },
];

function bool(value, fallback = false) {
  if (value == null) return fallback;
  return value === true || String(value).toLowerCase() === 'true';
}

function clampInteger(value, fallback, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(numeric)));
}

function samePath(a, b) {
  const aa = canonicalizePath(a);
  const bb = canonicalizePath(b);
  return process.platform === 'win32' ? aa.toLowerCase() === bb.toLowerCase() : aa === bb;
}

function insidePath(child, parent) {
  const cc = canonicalizePath(child);
  const pp = canonicalizePath(parent);
  const c = process.platform === 'win32' ? cc.toLowerCase() : cc;
  const p = process.platform === 'win32' ? pp.toLowerCase() : pp;
  return c === p || c.startsWith(`${p}${path.sep}`);
}

function insideLexicalPath(child, parent) {
  const cc = path.resolve(child);
  const pp = path.resolve(parent);
  const c = process.platform === 'win32' ? cc.toLowerCase() : cc;
  const p = process.platform === 'win32' ? pp.toLowerCase() : pp;
  return c === p || c.startsWith(`${p}${path.sep}`);
}

function expandPath(value) {
  return path.resolve(String(value || '')
    .replace(/%USERPROFILE%/gi, os.homedir())
    .replace(/^~(?=$|[\\/])/, os.homedir()));
}

function normalizeDependency(entry) {
  const relativePath = String(typeof entry === 'string' ? entry : entry?.path || '').replace(/\\/g, '/');
  if (!relativePath || path.isAbsolute(relativePath) || relativePath.split('/').includes('..')) {
    throw new Error(`Invalid local dependency path: ${relativePath}`);
  }
  return {
    path: relativePath,
    required: typeof entry === 'string' ? true : entry.required !== false,
  };
}

function validationConfig() {
  const validation = readJson('config/unity-worktree-validator.json');
  const internalRoot = path.resolve(projectRoot, 'state', 'unity-worktree-validator');
  const managedRoots = Array.isArray(validation.managedWorktreeRoots)
    ? validation.managedWorktreeRoots.map(expandPath)
    : [path.join(os.homedir(), '.devspace', 'worktrees')];
  const cacheRoot = path.resolve(projectRoot, String(validation.cacheDirectory || 'state/unity-worktree-validator/dependency-cache'));
  const logRoot = path.resolve(projectRoot, String(validation.logDirectory || 'state/unity-worktree-validator/validation-logs'));
  if (!insidePath(cacheRoot, internalRoot) || !insidePath(logRoot, internalRoot)) {
    throw new Error(`Validation cache and logs must stay under ${internalRoot}`);
  }
  return {
    enabled: validation.enabled !== false,
    sourceProject: path.resolve(String(validation.projectRoot || projectRoot)),
    cacheRoot,
    logRoot,
    timeoutMs: clampInteger(validation.unityTimeoutMs, 1800000, 60000, 7200000),
    deferWhenBusy: validation.deferWhenBusy !== false,
    blockOnVrRuntime: bool(validation.blockOnVrRuntime, false),
    snapshotRetention: {
      keepPerDependency: clampInteger(
        validation.dependencySnapshotRetention?.keepPerDependency,
        DEFAULT_SNAPSHOT_RETENTION.keepPerDependency,
        1,
        20,
      ),
      maxBytes: clampInteger(
        validation.dependencySnapshotRetention?.maxBytes,
        DEFAULT_SNAPSHOT_RETENTION.maxBytes,
        256 * 1024 * 1024,
        20 * 1024 * 1024 * 1024,
      ),
      cleanupIntervalMs: clampInteger(
        Number(validation.dependencySnapshotRetention?.cleanupIntervalHours) * 60 * 60 * 1000,
        DEFAULT_SNAPSHOT_RETENTION.cleanupIntervalMs,
        60 * 60 * 1000,
        7 * 24 * 60 * 60 * 1000,
      ),
      lastUsedTouchMs: clampInteger(
        Number(validation.dependencySnapshotRetention?.lastUsedTouchHours) * 60 * 60 * 1000,
        DEFAULT_SNAPSHOT_RETENTION.lastUsedTouchMs,
        5 * 60 * 1000,
        24 * 60 * 60 * 1000,
      ),
    },
    managedWorktreeRoots: managedRoots,
    busyProcessNames: Array.isArray(validation.busyProcessNames)
      ? validation.busyProcessNames.map((value) => String(value).toLowerCase())
      : ['unity.exe', 'vr-avatar-viewer.exe', 'vravatarviewer.exe'],
    vrRuntimeProcessNames: Array.isArray(validation.vrRuntimeProcessNames)
      ? validation.vrRuntimeProcessNames.map((value) => String(value).toLowerCase())
      : ['vrmonitor.exe', 'vrserver.exe', 'vrcompositor.exe', 'ovrserver_x64.exe'],
    dependencies: (Array.isArray(validation.localDependencies) ? validation.localDependencies : DEFAULT_DEPENDENCIES)
      .map(normalizeDependency),
  };
}

function ensureInternalPath(target, root, label) {
  const resolved = path.resolve(target);
  if (!insidePath(resolved, root)) throw new Error(`${label} must stay under ${root}`);
  return resolved;
}

function snapshotKey(relativePath) {
  return relativePath.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'dependency';
}

function fingerprintDirectory(root) {
  const hash = crypto.createHash('sha256');
  let files = 0;
  let directories = 0;
  let bytes = 0;
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name, 'en'));
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      const relative = path.relative(root, full).replace(/\\/g, '/');
      const stat = fs.lstatSync(full);
      if (entry.isDirectory()) {
        directories += 1;
        hash.update(`d\0${relative}\0${Math.trunc(stat.mtimeMs)}\n`);
        stack.push(full);
      } else if (entry.isSymbolicLink()) {
        hash.update(`l\0${relative}\0${fs.readlinkSync(full)}\n`);
      } else {
        files += 1;
        bytes += stat.size;
        hash.update(`f\0${relative}\0${stat.size}\0${Math.trunc(stat.mtimeMs)}\n`);
      }
    }
  }
  return { fingerprint: hash.digest('hex'), files, directories, bytes };
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, file);
}

function snapshotRetentionConfig(config) {
  return {
    ...DEFAULT_SNAPSHOT_RETENTION,
    ...(config?.snapshotRetention || {}),
  };
}

function touchSnapshotManifest(manifest, existing, config, now = Date.now()) {
  const retention = snapshotRetentionConfig(config);
  const lastUsedAt = Date.parse(String(existing.lastUsedAt || existing.createdAt || ''));
  if (Number.isFinite(lastUsedAt) && now - lastUsedAt < retention.lastUsedTouchMs) return existing;
  const updated = {
    ...existing,
    version: 2,
    lastUsedAt: new Date(now).toISOString(),
  };
  writeJsonAtomic(manifest, updated);
  return updated;
}

function readSnapshotManifestEntries(config) {
  const snapshotsRoot = path.join(config.cacheRoot, 'snapshots');
  if (!fs.existsSync(snapshotsRoot)) return { snapshotsRoot, entries: [], invalid: [] };
  const entries = [];
  const invalid = [];
  for (const dirent of fs.readdirSync(snapshotsRoot, { withFileTypes: true })) {
    if (!dirent.isFile() || !dirent.name.endsWith('.manifest.json')) continue;
    const manifest = path.join(snapshotsRoot, dirent.name);
    const snapshot = manifest.slice(0, -'.manifest.json'.length);
    try {
      const value = JSON.parse(fs.readFileSync(manifest, 'utf8'));
      if (!value.relativePath || !fs.existsSync(snapshot) || !fs.statSync(snapshot).isDirectory()) {
        invalid.push({ manifest, snapshot, reason: 'missing-or-invalid-snapshot' });
        continue;
      }
      entries.push({
        manifest,
        snapshot: canonicalizePath(snapshot),
        relativePath: String(value.relativePath).replace(/\\/g, '/'),
        fingerprint: String(value.fingerprint || ''),
        createdAt: String(value.createdAt || ''),
        lastUsedAt: String(value.lastUsedAt || value.createdAt || ''),
        bytes: Math.max(0, Number(value.bytes) || 0),
      });
    } catch (error) {
      invalid.push({ manifest, snapshot, reason: error.message });
    }
  }
  return { snapshotsRoot, entries, invalid };
}

function collectManagedSnapshotReferences(config) {
  const references = new Set();
  const snapshotsRoot = path.join(config.cacheRoot, 'snapshots');
  for (const managedRoot of config.managedWorktreeRoots || []) {
    if (!fs.existsSync(managedRoot)) continue;
    let worktrees;
    try {
      worktrees = fs.readdirSync(managedRoot, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of worktrees) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const worktree = path.join(managedRoot, entry.name);
      for (const dependency of config.dependencies || []) {
        const target = path.join(worktree, dependency.path);
        try {
          if (!fs.existsSync(target) || !fs.lstatSync(target).isSymbolicLink()) continue;
          const resolved = fs.realpathSync.native ? fs.realpathSync.native(target) : fs.realpathSync(target);
          if (insidePath(resolved, snapshotsRoot)) references.add(canonicalizePath(resolved));
        } catch {
          // A worktree can disappear concurrently. A failed lookup is not proof that a snapshot is safe,
          // so cleanup will also re-scan references immediately before deletion.
        }
      }
    }
  }
  return references;
}

function acquireSnapshotCacheLock(config, now = Date.now(), purpose = 'snapshot-operation') {
  fs.mkdirSync(config.cacheRoot, { recursive: true });
  const lockPath = ensureInternalPath(path.join(config.cacheRoot, 'cache.lock'), config.cacheRoot, 'Snapshot cache lock');
  const token = `${process.pid}-${crypto.randomUUID()}`;
  const tryAcquire = () => {
    const fd = fs.openSync(lockPath, 'wx');
    fs.writeFileSync(fd, `${JSON.stringify({ token, pid: process.pid, purpose, createdAt: new Date(now).toISOString() })}\n`, 'utf8');
    fs.closeSync(fd);
  };
  try {
    tryAcquire();
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    try {
      const stat = fs.statSync(lockPath);
      if (now - stat.mtimeMs < 60 * 60 * 1000) return null;
      fs.unlinkSync(lockPath);
      tryAcquire();
    } catch (retryError) {
      if (retryError.code === 'EEXIST' || retryError.code === 'ENOENT') return null;
      throw retryError;
    }
  }
  return {
    path: lockPath,
    release() {
      try {
        const current = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
        if (current.token === token) fs.unlinkSync(lockPath);
      } catch {
        // Best-effort unlock. A stale lock older than one hour is recoverable on the next cache operation.
      }
    },
  };
}

function cleanupDependencySnapshots(config, options = {}) {
  const retention = snapshotRetentionConfig(config);
  const now = Number(options.now) || Date.now();
  const statePath = ensureInternalPath(path.join(config.cacheRoot, 'retention-state.json'), config.cacheRoot, 'Snapshot retention state');
  if (!options.force && !options.createdNewSnapshot && fs.existsSync(statePath)) {
    try {
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      const lastCleanupAt = Date.parse(String(state.lastCleanupAt || ''));
      if (Number.isFinite(lastCleanupAt) && now - lastCleanupAt < retention.cleanupIntervalMs) {
        return { ok: true, skipped: true, reason: 'interval-not-due', deleted: [], errors: [] };
      }
    } catch {
      // Invalid state should cause one bounded cleanup rather than disabling retention.
    }
  }

  const lock = acquireSnapshotCacheLock(config, now, 'retention');
  if (!lock) return { ok: true, skipped: true, reason: 'snapshot-cache-busy', deleted: [], errors: [] };

  try {
    const { entries, invalid } = readSnapshotManifestEntries(config);
    const referenced = collectManagedSnapshotReferences(config);
    const protectedSnapshots = new Set(
      (options.protectedSnapshots || []).filter(Boolean).map((entry) => canonicalizePath(entry)),
    );
    for (const entry of referenced) protectedSnapshots.add(entry);

    const groups = new Map();
    for (const entry of entries) {
      if (!groups.has(entry.relativePath)) groups.set(entry.relativePath, []);
      groups.get(entry.relativePath).push(entry);
    }

    const keep = new Set(protectedSnapshots);
    const deleteReasons = new Map();
    for (const group of groups.values()) {
      group.sort((a, b) => {
        const aUsed = Date.parse(a.lastUsedAt) || Date.parse(a.createdAt) || 0;
        const bUsed = Date.parse(b.lastUsedAt) || Date.parse(b.createdAt) || 0;
        return bUsed - aUsed;
      });
      for (const entry of group.slice(0, retention.keepPerDependency)) keep.add(entry.snapshot);
      for (const entry of group.slice(retention.keepPerDependency)) {
        if (!keep.has(entry.snapshot)) deleteReasons.set(entry.snapshot, 'per-dependency-retention');
      }
    }

    let retainedBytes = entries
      .filter((entry) => !deleteReasons.has(entry.snapshot))
      .reduce((total, entry) => total + entry.bytes, 0);
    if (retainedBytes > retention.maxBytes) {
      const retainedCounts = new Map();
      for (const entry of entries) {
        if (deleteReasons.has(entry.snapshot)) continue;
        retainedCounts.set(entry.relativePath, (retainedCounts.get(entry.relativePath) || 0) + 1);
      }
      const globalCandidates = entries
        .filter((entry) => !deleteReasons.has(entry.snapshot) && !protectedSnapshots.has(entry.snapshot))
        .sort((a, b) => {
          const aUsed = Date.parse(a.lastUsedAt) || Date.parse(a.createdAt) || 0;
          const bUsed = Date.parse(b.lastUsedAt) || Date.parse(b.createdAt) || 0;
          return aUsed - bUsed;
        });
      for (const entry of globalCandidates) {
        if (retainedBytes <= retention.maxBytes) break;
        const count = retainedCounts.get(entry.relativePath) || 0;
        if (count <= 1) continue;
        deleteReasons.set(entry.snapshot, 'global-size-cap');
        retainedCounts.set(entry.relativePath, count - 1);
        retainedBytes -= entry.bytes;
      }
    }

    const beforeBytes = entries.reduce((total, entry) => total + entry.bytes, 0);
    const candidates = entries.filter((entry) => deleteReasons.has(entry.snapshot));
    const deleted = [];
    const errors = [];
    const skippedProtected = [];
    const liveReferences = collectManagedSnapshotReferences(config);
    for (const entry of candidates) {
      if (protectedSnapshots.has(entry.snapshot) || liveReferences.has(entry.snapshot)) {
        skippedProtected.push({ snapshot: entry.snapshot, relativePath: entry.relativePath });
        continue;
      }
      if (options.dryRun) {
        deleted.push({ ...entry, reason: deleteReasons.get(entry.snapshot), dryRun: true });
        continue;
      }
      try {
        fs.rmSync(entry.snapshot, { recursive: true, force: false, maxRetries: 4, retryDelay: 100 });
        if (fs.existsSync(entry.manifest)) fs.unlinkSync(entry.manifest);
        deleted.push({ ...entry, reason: deleteReasons.get(entry.snapshot) });
      } catch (error) {
        errors.push({ snapshot: entry.snapshot, relativePath: entry.relativePath, error: error.message });
      }
    }

    const deletedBytes = deleted.reduce((total, entry) => total + entry.bytes, 0);
    const result = {
      ok: errors.length === 0,
      skipped: false,
      keepPerDependency: retention.keepPerDependency,
      maxBytes: retention.maxBytes,
      scannedManifests: entries.length,
      invalidManifests: invalid.length,
      referencedSnapshots: referenced.size,
      protectedSnapshots: protectedSnapshots.size,
      beforeBytes,
      afterBytes: Math.max(0, beforeBytes - deletedBytes),
      deletedBytes,
      deleted,
      skippedProtected,
      errors,
    };
    if (!options.dryRun) {
      writeJsonAtomic(statePath, {
        version: 1,
        lastCleanupAt: new Date(now).toISOString(),
        keepPerDependency: retention.keepPerDependency,
        maxBytes: retention.maxBytes,
        scannedManifests: entries.length,
        deletedSnapshots: deleted.length,
        deletedBytes,
        errors: errors.length,
      });
    }
    return result;
  } finally {
    lock.release();
  }
}

function snapshotDependency(sourceProject, dependency, config) {
  const source = path.resolve(sourceProject, dependency.path);
  if (!insidePath(source, sourceProject)) throw new Error(`Dependency escapes source project: ${dependency.path}`);
  if (!fs.existsSync(source)) {
    if (dependency.required) throw new Error(`Required local dependency is missing: ${source}`);
    return { path: dependency.path, required: false, skipped: true, reason: 'source-missing' };
  }
  if (!fs.statSync(source).isDirectory()) throw new Error(`Local dependency is not a directory: ${source}`);

  const fingerprint = fingerprintDirectory(source);
  const key = snapshotKey(dependency.path);
  const snapshot = ensureInternalPath(
    path.join(config.cacheRoot, 'snapshots', `${key}-${fingerprint.fingerprint.slice(0, 16)}`),
    config.cacheRoot,
    'Dependency snapshot',
  );
  const manifest = `${snapshot}.manifest.json`;
  if (fs.existsSync(snapshot) && fs.existsSync(manifest)) {
    const existing = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    if (existing.fingerprint === fingerprint.fingerprint && existing.relativePath === dependency.path) {
      touchSnapshotManifest(manifest, existing, config);
      return { path: dependency.path, required: dependency.required, source, snapshot, reused: true, ...fingerprint };
    }
  }

  if (fs.existsSync(snapshot) && !fs.existsSync(manifest)) {
    throw new Error(`Dependency snapshot exists without manifest: ${snapshot}`);
  }

  fs.mkdirSync(path.dirname(snapshot), { recursive: true });
  const temporary = ensureInternalPath(`${snapshot}.building-${process.pid}-${crypto.randomUUID()}`, config.cacheRoot, 'Temporary snapshot');
  try {
    fs.cpSync(source, temporary, { recursive: true, preserveTimestamps: true, errorOnExist: true, force: false });
    fs.renameSync(temporary, snapshot);
    const createdAt = new Date().toISOString();
    writeJsonAtomic(manifest, {
      version: 2,
      createdAt,
      lastUsedAt: createdAt,
      source,
      relativePath: dependency.path,
      ...fingerprint,
    });
  } catch (error) {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { recursive: true, force: true });
    if (fs.existsSync(snapshot) && fs.existsSync(manifest)) {
      const existing = JSON.parse(fs.readFileSync(manifest, 'utf8'));
      if (existing.fingerprint === fingerprint.fingerprint) {
        touchSnapshotManifest(manifest, existing, config);
        return { path: dependency.path, required: dependency.required, source, snapshot, reused: true, ...fingerprint };
      }
    }
    throw error;
  }
  return { path: dependency.path, required: dependency.required, source, snapshot, reused: false, ...fingerprint };
}

function createDependencyJunction(worktree, snapshotInfo) {
  if (snapshotInfo.skipped) return { ...snapshotInfo, attached: false };
  const target = path.resolve(worktree, snapshotInfo.path);
  if (!insideLexicalPath(target, worktree)) throw new Error(`Dependency target escapes worktree: ${snapshotInfo.path}`);
  if (fs.existsSync(target)) {
    const stat = fs.lstatSync(target);
    if (!stat.isSymbolicLink()) {
      if (stat.isDirectory() && fs.readdirSync(target).length === 0) {
        fs.rmdirSync(target);
        fs.symlinkSync(snapshotInfo.snapshot, target, process.platform === 'win32' ? 'junction' : 'dir');
        return {
          ...snapshotInfo,
          target,
          attached: true,
          preexisting: true,
          replacedSourceJunction: false,
          recoveredEmptyDirectory: true,
        };
      }
      return { ...snapshotInfo, target, attached: false, preexisting: true };
    }

    const resolved = fs.realpathSync.native ? fs.realpathSync.native(target) : fs.realpathSync(target);
    if (samePath(resolved, snapshotInfo.snapshot)) {
      return {
        ...snapshotInfo,
        target,
        attached: true,
        preexisting: true,
        replacedSourceJunction: true,
        recoveredStaleSnapshot: true,
        originalLinkTarget: snapshotInfo.source,
      };
    }
    if (!samePath(resolved, snapshotInfo.source)) {
      const snapshotRoot = path.dirname(snapshotInfo.snapshot);
      const staleManifest = `${resolved}.manifest.json`;
      let managedStaleSnapshot = false;
      if (insidePath(resolved, snapshotRoot) && fs.existsSync(staleManifest)) {
        try {
          const manifest = JSON.parse(fs.readFileSync(staleManifest, 'utf8'));
          managedStaleSnapshot = manifest.relativePath === snapshotInfo.path;
        } catch {
          managedStaleSnapshot = false;
        }
      }
      if (!managedStaleSnapshot) {
        throw new Error(`Existing dependency junction does not point to the configured source or snapshot: ${target}`);
      }
      fs.unlinkSync(target);
      fs.symlinkSync(snapshotInfo.snapshot, target, process.platform === 'win32' ? 'junction' : 'dir');
      return {
        ...snapshotInfo,
        target,
        attached: true,
        preexisting: true,
        replacedSourceJunction: true,
        recoveredStaleSnapshot: true,
        originalLinkTarget: snapshotInfo.source,
      };
    }
    const originalLinkTarget = fs.readlinkSync(target);
    fs.unlinkSync(target);
    fs.symlinkSync(snapshotInfo.snapshot, target, process.platform === 'win32' ? 'junction' : 'dir');
    return {
      ...snapshotInfo,
      target,
      attached: true,
      preexisting: true,
      replacedSourceJunction: true,
      originalLinkTarget,
    };
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.symlinkSync(snapshotInfo.snapshot, target, process.platform === 'win32' ? 'junction' : 'dir');
  return { ...snapshotInfo, target, attached: true, preexisting: false, replacedSourceJunction: false };
}

function removeDependencyJunction(link) {
  if (!link?.attached || !link.target || !fs.existsSync(link.target)) return;
  const stat = fs.lstatSync(link.target);
  if (!stat.isSymbolicLink()) throw new Error(`Refusing to remove non-junction dependency target: ${link.target}`);
  const resolved = fs.realpathSync.native ? fs.realpathSync.native(link.target) : fs.realpathSync(link.target);
  if (!samePath(resolved, link.snapshot)) throw new Error(`Dependency junction target changed: ${link.target}`);
  fs.unlinkSync(link.target);
  if (link.replacedSourceJunction) {
    fs.symlinkSync(link.originalLinkTarget, link.target, process.platform === 'win32' ? 'junction' : 'dir');
  }
}

async function registeredWorktree(sourceProject, worktree) {
  const git = resolveGitExecutable();
  const result = await run(git, ['-C', sourceProject, 'worktree', 'list', '--porcelain'], { timeoutMs: 15000 });
  if (!result.ok) throw new Error(`Could not inspect Git worktrees: ${result.error || result.stderr}`);
  const registered = result.stdout.split(/\r?\n/)
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length).trim());
  return registered.some((candidate) => samePath(candidate, worktree));
}

async function inspectWorktree(worktreeInput, sourceProjectInput, config = validationConfig()) {
  const sourceProject = path.resolve(sourceProjectInput || config.sourceProject);
  if (!samePath(sourceProject, config.sourceProject)) {
    throw new Error(`Validation source project must match configured projectRoot: ${config.sourceProject}`);
  }
  const worktree = path.resolve(String(worktreeInput || ''));
  if (!worktreeInput || !fs.existsSync(worktree)) throw new Error(`Worktree does not exist: ${worktree}`);
  if (!config.managedWorktreeRoots.some((root) => insidePath(worktree, root))) {
    throw new Error(`Worktree is outside managed roots: ${worktree}`);
  }
  if (!(await registeredWorktree(sourceProject, worktree))) {
    throw new Error(`Path is not a registered worktree of ${sourceProject}: ${worktree}`);
  }
  for (const required of ['Assets', 'Packages', 'ProjectSettings']) {
    if (!fs.existsSync(path.join(worktree, required))) throw new Error(`Unity worktree is missing ${required}: ${worktree}`);
  }
  return { sourceProject, worktree };
}

function isUnityAssetImportWorker(entry) {
  if (String(entry?.name || '').toLowerCase() !== 'unity.exe') return false;
  const commandLine = String(entry?.commandLine || '').toLowerCase();
  return commandLine.includes('assetimportworker') || commandLine.includes('-name\" \"assetimport');
}

function isOwnedValidationUnityRoot(entry, config) {
  if (String(entry?.name || '').toLowerCase() !== 'unity.exe') return false;
  const commandLine = normalizedProcessText(entry.commandLine);
  if (!commandLine.includes('-batchmode') || !commandLine.includes('-quit') || !commandLine.includes('-nographics')) return false;

  const logRoot = normalizedProcessText(config.logRoot);
  if (!logRoot || !commandLine.includes(logRoot)) return false;
  if (!referencesRelevantUnityProject(entry, config)) return false;

  return (config.managedWorktreeRoots || [])
    .map((root) => normalizedProcessText(root))
    .filter(Boolean)
    .some((root) => commandLine.includes(root));
}

function referencesRelevantUnityProject(entry, config) {
  const relevantProjectPaths = Array.isArray(config.relevantProjectPaths)
    ? config.relevantProjectPaths.filter(Boolean)
    : [];
  if (relevantProjectPaths.length === 0) return true;
  return relevantProjectPaths.some((projectPath) => processReferencesProject(entry, projectPath));
}

function classifyBusyProcesses(processes, config) {
  const names = new Set(config.busyProcessNames);
  if (config.blockOnVrRuntime) config.vrRuntimeProcessNames.forEach((name) => names.add(name));
  const candidates = processes.filter((entry) => names.has(String(entry.name || '').toLowerCase()));
  const byPid = new Map(processes.map((entry) => [Number(entry.pid), entry]));
  const blockers = [];
  const auxiliary = [];

  for (const entry of candidates) {
    const isUnity = String(entry.name || '').toLowerCase() === 'unity.exe';
    if (isOwnedValidationUnityRoot(entry, config)) {
      auxiliary.push({ ...entry, role: 'validation-runner' });
      continue;
    }
    if (isUnity && !referencesRelevantUnityProject(entry, config)) {
      auxiliary.push({
        ...entry,
        role: isUnityAssetImportWorker(entry) ? 'unrelated-asset-import-worker' : 'unrelated-unity-editor',
      });
      continue;
    }
    if (!isUnityAssetImportWorker(entry)) {
      blockers.push({ ...entry, role: isUnity ? 'unity-editor' : 'runtime' });
      continue;
    }

    const parent = byPid.get(Number(entry.parentPid));
    const parentIsUnity = String(parent?.name || '').toLowerCase() === 'unity.exe';
    const worker = { ...entry, role: parentIsUnity ? 'asset-import-worker' : 'orphan-asset-import-worker' };
    auxiliary.push(worker);
    if (!parentIsUnity) blockers.push(worker);
  }

  return { blockers, auxiliary };
}

function busyMatches(processes, config) {
  return classifyBusyProcesses(processes, config).blockers;
}

function summarizeProcess(entry) {
  return {
    pid: entry.pid,
    parentPid: entry.parentPid,
    name: entry.name,
    role: entry.role || null,
    executablePath: entry.executablePath,
    creationDate: entry.creationDate || null,
    commandLine: entry.commandLine || '',
  };
}

async function usageStatus(config = validationConfig()) {
  const query = await queryProcesses('', 'literal');
  if (!query.ok) return { ok: false, busy: true, processes: [], auxiliaryProcesses: [], error: query.error };
  const classified = classifyBusyProcesses(query.processes, config);
  return {
    ok: true,
    busy: classified.blockers.length > 0,
    processes: classified.blockers.map(summarizeProcess),
    auxiliaryProcesses: classified.auxiliary.map(summarizeProcess),
    summary: {
      blockingProcesses: classified.blockers.length,
      unityEditors: classified.blockers.filter((entry) => entry.role === 'unity-editor').length,
      runtimeProcesses: classified.blockers.filter((entry) => entry.role === 'runtime').length,
      validationRunners: classified.auxiliary.filter((entry) => entry.role === 'validation-runner').length,
      assetImportWorkers: classified.auxiliary.filter((entry) => entry.role === 'asset-import-worker').length,
      orphanAssetImportWorkers: classified.auxiliary.filter((entry) => entry.role === 'orphan-asset-import-worker').length,
    },
    error: null,
  };
}

function normalizedProcessText(value) {
  return String(value || '')
    .replace(/["']/g, ' ')
    .replace(/\\/g, '/')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function processReferencesProject(entry, projectPath) {
  const target = normalizedProcessText(canonicalizePath(projectPath));
  return Boolean(target) && normalizedProcessText(entry?.commandLine).includes(target);
}

function processStartedAfter(entry, startedAt, toleranceMs = 10000) {
  const processStartedAt = Date.parse(String(entry?.creationDate || ''));
  const expectedStartedAt = Date.parse(String(startedAt || ''));
  if (!Number.isFinite(processStartedAt) || !Number.isFinite(expectedStartedAt)) return false;
  return processStartedAt >= expectedStartedAt - toleranceMs;
}

const UNITY_OWNED_AUXILIARY_NAMES = new Set([
  'unitypackagemanager.exe',
  'unityshadercompiler.exe',
  'unityautoquitter.exe',
  'unitycrashhandler64.exe',
]);

function ownedUnityAuxiliaryProcesses(processes, { rootPid, worktree, startedAt }) {
  const numericRootPid = Number(rootPid);
  const parentMarker = `-parentpid ${numericRootPid}`;
  const descendants = new Set([numericRootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of processes) {
      if (descendants.has(Number(entry.pid))) continue;
      if (!descendants.has(Number(entry.parentPid))) continue;
      descendants.add(Number(entry.pid));
      changed = true;
    }
  }

  return processes.filter((entry) => {
    if (!processStartedAfter(entry, startedAt)) return false;
    const pid = Number(entry.pid);
    const name = String(entry.name || '').toLowerCase();
    const commandLine = normalizedProcessText(entry.commandLine);
    const linkedToRoot = descendants.has(pid)
      || Number(entry.parentPid) === numericRootPid
      || commandLine.includes(parentMarker);
    if (!linkedToRoot) return false;

    if (name === 'unity.exe') {
      return isUnityAssetImportWorker(entry)
        && processReferencesProject(entry, worktree);
    }
    return UNITY_OWNED_AUXILIARY_NAMES.has(name);
  });
}

async function cleanupOwnedUnityProcessTree({ pid, worktree, startedAt }) {
  const result = {
    ok: true,
    rootPid: Number(pid) || null,
    rootStop: null,
    workerStops: [],
    remaining: [],
    errors: [],
  };

  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return result;

  const root = await processInfo(Number(pid));
  if (!root.ok) {
    result.errors.push(`root-process-query-failed: ${root.error}`);
  } else if (root.process) {
    const isOwnedRoot = String(root.process.name || '').toLowerCase() === 'unity.exe'
      && processReferencesProject(root.process, worktree)
      && processStartedAfter(root.process, startedAt);
    if (!isOwnedRoot) {
      result.errors.push(`refused-to-stop-unowned-root-pid:${pid}`);
    } else {
      result.rootStop = await stopPid(Number(pid), {
        force: true,
        tree: true,
        timeoutMs: 20000,
        expectedCreationDate: root.process.creationDate,
      });
      if (!result.rootStop.ok) result.errors.push(`root-stop-failed: ${result.rootStop.error}`);
    }
  }

  const firstQuery = await queryProcesses('', 'literal');
  if (!firstQuery.ok) {
    result.errors.push(`worker-process-query-failed: ${firstQuery.error}`);
  } else {
    const workers = ownedUnityAuxiliaryProcesses(firstQuery.processes, { rootPid: pid, worktree, startedAt });
    for (const worker of workers) {
      const stopped = await stopPid(worker.pid, {
        force: true,
        tree: true,
        timeoutMs: 15000,
        expectedCreationDate: worker.creationDate,
      });
      result.workerStops.push({ pid: worker.pid, ...stopped });
      if (!stopped.ok) result.errors.push(`worker-stop-failed:${worker.pid}: ${stopped.error}`);
    }
  }

  const finalQuery = await queryProcesses('', 'literal');
  if (!finalQuery.ok) {
    result.errors.push(`final-process-query-failed: ${finalQuery.error}`);
  } else {
    result.remaining = ownedUnityAuxiliaryProcesses(finalQuery.processes, { rootPid: pid, worktree, startedAt })
      .map(summarizeProcess);
    if (result.remaining.length > 0) {
      result.errors.push(`owned-unity-workers-remain:${result.remaining.map((entry) => entry.pid).join(',')}`);
    }
  }

  result.ok = result.errors.length === 0;
  return result;
}

function startUnityOwnerGuardian({ ownerPid = process.pid, unityPid, worktree }) {
  if (process.platform !== 'win32') {
    return { ok: true, skipped: true, reason: 'windows-only', pid: null };
  }
  if (!Number.isInteger(Number(ownerPid)) || Number(ownerPid) <= 0) {
    return { ok: false, skipped: false, pid: null, error: 'guardian owner PID must be a positive integer' };
  }
  if (!Number.isInteger(Number(unityPid)) || Number(unityPid) <= 0) {
    return { ok: false, skipped: false, pid: null, error: 'guardian Unity PID must be a positive integer' };
  }

  const cleanupScript = path.join(projectRoot, 'scripts', 'unity-worktree-session-cleanup.js');
  const guardianStartedAt = new Date().toISOString();
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    '$ownerPid = [int]$env:AGENTTOOLS_UNITY_GUARDIAN_OWNER_PID',
    'Wait-Process -Id $ownerPid -ErrorAction SilentlyContinue',
    '$node = [string]$env:AGENTTOOLS_UNITY_GUARDIAN_NODE',
    '$cleanup = [string]$env:AGENTTOOLS_UNITY_GUARDIAN_CLEANUP',
    '$unityPid = [string]$env:AGENTTOOLS_UNITY_GUARDIAN_UNITY_PID',
    '$worktree = [string]$env:AGENTTOOLS_UNITY_GUARDIAN_WORKTREE',
    "& $node $cleanup '--pid' $unityPid '--worktree' $worktree",
    'exit 0',
  ].join('\n');
  const encoded = encodePowerShellCommand(script);
  const spawned = spawnDetached(windowsPowerShellPath(), [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-EncodedCommand',
    encoded,
  ], {
    env: {
      AGENTTOOLS_UNITY_GUARDIAN_OWNER_PID: String(ownerPid),
      AGENTTOOLS_UNITY_GUARDIAN_NODE: process.execPath,
      AGENTTOOLS_UNITY_GUARDIAN_CLEANUP: cleanupScript,
      AGENTTOOLS_UNITY_GUARDIAN_UNITY_PID: String(unityPid),
      AGENTTOOLS_UNITY_GUARDIAN_WORKTREE: canonicalizePath(worktree),
    },
  });
  return {
    ...spawned,
    ownerPid: Number(ownerPid),
    unityPid: Number(unityPid),
    startedAt: guardianStartedAt,
  };
}

async function stopUnityOwnerGuardian(guardian) {
  if (!guardian || guardian.skipped || !guardian.pid) {
    return { ok: true, skipped: true, reason: guardian?.reason || 'not-started' };
  }
  const info = await processInfo(guardian.pid);
  if (!info.ok) return { ok: false, pid: guardian.pid, error: info.error };
  if (!info.process) return { ok: true, pid: guardian.pid, alreadyStopped: true };
  const owned = String(info.process.name || '').toLowerCase() === 'powershell.exe'
    && Number(info.process.parentPid) === Number(guardian.ownerPid)
    && processStartedAfter(info.process, guardian.startedAt, 5000);
  if (!owned) {
    return { ok: false, pid: guardian.pid, error: 'refused-to-stop-unowned-unity-guardian' };
  }
  return stopPid(guardian.pid, {
    force: true,
    tree: true,
    timeoutMs: 10000,
    expectedCreationDate: info.process.creationDate,
  });
}

function appendLimited(current, chunk, maxBuffer) {
  if (!chunk) return current;
  const combined = `${current}${chunk}`;
  if (combined.length <= maxBuffer) return combined;
  return combined.slice(combined.length - maxBuffer);
}

function runOwnedUnityBatchMode(command, args, options = {}) {
  const timeoutMs = Number(options.timeoutMs) || 1800000;
  const maxBuffer = Number(options.maxBuffer) || 8 * 1024 * 1024;
  const worktree = canonicalizePath(options.worktree || options.cwd || '');
  const startedAt = new Date().toISOString();
  const cleanupProcessTree = options.cleanupProcessTree || cleanupOwnedUnityProcessTree;
  const startGuardian = options.startGuardian || startUnityOwnerGuardian;
  const stopGuardian = options.stopGuardian || stopUnityOwnerGuardian;

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let cleanupPromise = null;
    let timeoutHandle = null;
    let fallbackHandle = null;
    let guardian = null;
    const child = spawn(command, args, {
      cwd: options.cwd,
      windowsHide: true,
      env: { ...process.env, NO_COLOR: '1', ...(options.env || {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const pid = child.pid;

    const ensureCleanup = () => {
      if (!cleanupPromise) cleanupPromise = cleanupProcessTree({ pid, worktree, startedAt });
      return cleanupPromise;
    };

    const finish = async ({ exitCode = null, signal = null, error = null } = {}) => {
      if (settled) return;
      settled = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (fallbackHandle) clearTimeout(fallbackHandle);
      const processCleanup = await ensureCleanup();
      const guardianCleanup = await stopGuardian(guardian);
      const guardianError = guardian && guardian.ok === false
        ? guardian.error || 'Unity owner guardian failed to start'
        : !guardianCleanup.ok ? guardianCleanup.error || 'Unity owner guardian cleanup failed' : null;
      const finalError = error
        || (timedOut ? `Unity batchmode timed out after ${timeoutMs}ms` : null)
        || guardianError;
      resolve({
        ok: !finalError && exitCode === 0 && processCleanup.ok && guardianCleanup.ok,
        command,
        args,
        cwd: options.cwd,
        pid,
        startedAt,
        timedOut,
        exitCode,
        signal,
        stdout,
        stderr,
        error: finalError,
        processCleanup,
        guardian: guardian ? {
          ok: guardian.ok,
          pid: guardian.pid || null,
          skipped: Boolean(guardian.skipped),
          error: guardian.error || null,
          cleanup: guardianCleanup,
        } : null,
      });
    };

    try {
      guardian = startGuardian({ ownerPid: process.pid, unityPid: pid, worktree });
    } catch (error) {
      guardian = { ok: false, pid: null, skipped: false, error: error.message };
    }

    child.stdout?.on('data', (chunk) => {
      stdout = appendLimited(stdout, chunk.toString('utf8'), maxBuffer);
    });
    child.stderr?.on('data', (chunk) => {
      stderr = appendLimited(stderr, chunk.toString('utf8'), maxBuffer);
    });
    child.once('error', (error) => {
      void finish({ error: error.message });
    });
    child.once('close', (exitCode, signal) => {
      void finish({ exitCode, signal });
    });

    if (!guardian?.ok) {
      setImmediate(() => {
        void finish({ error: guardian?.error || 'Unity owner guardian failed to start' });
      });
      return;
    }

    timeoutHandle = setTimeout(() => {
      timedOut = true;
      void ensureCleanup().finally(() => {
        fallbackHandle = setTimeout(() => {
          void finish({ signal: 'SIGKILL' });
        }, 5000);
      });
    }, timeoutMs);
  });
}

function readFileState(file) {
  if (!fs.existsSync(file)) return { exists: false, data: null };
  return { exists: true, data: fs.readFileSync(file) };
}

function restoreFileState(file, state) {
  if (state.exists) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, state.data);
  } else if (fs.existsSync(file)) {
    fs.rmSync(file, { force: true });
  }
}

async function trackedOrphanMetaStates(worktree) {
  const git = resolveGitExecutable();
  const result = await run(git, ['-C', worktree, 'ls-files', '-z', '--', '*.meta'], { timeoutMs: 30000 });
  if (!result.ok) throw new Error(`Could not inspect tracked Unity meta files: ${result.error || result.stderr}`);
  const states = [];
  for (const relativePath of result.stdout.split('\0').filter(Boolean)) {
    const normalized = relativePath.replace(/\\/g, '/');
    if (!normalized.startsWith('Assets/') && !normalized.startsWith('Packages/')) continue;
    const metaFile = path.resolve(worktree, relativePath);
    if (!insideLexicalPath(metaFile, worktree) || !fs.existsSync(metaFile)) continue;
    const assetPath = metaFile.slice(0, -'.meta'.length);
    if (fs.existsSync(assetPath)) continue;
    states.push({
      relativePath: normalized,
      file: metaFile,
      state: readFileState(metaFile),
    });
  }
  return states;
}

function restoreTrackedOrphanMetaStates(states) {
  for (const entry of states || []) restoreFileState(entry.file, entry.state);
}

function compileErrorsFromLog(logText) {
  return String(logText || '').split(/\r?\n/)
    .filter((line) => /\berror CS\d+\b|Scripts have compiler errors|Compilation failed/i.test(line))
    .slice(0, 50)
    .map((line) => sanitizeLogText(line, 1200));
}

async function gitDiffCheck(worktree) {
  const git = resolveGitExecutable();
  const result = await run(git, ['-C', worktree, 'diff', '--check'], { timeoutMs: 30000 });
  return {
    ok: result.ok,
    output: sanitizeLogText(result.stdout || result.stderr || result.error || '', 4000),
  };
}

function parseNameStatusEntries(text, scope) {
  const tokens = String(text || '').split('\0').filter(Boolean);
  const entries = [];
  for (let index = 0; index < tokens.length;) {
    const status = tokens[index++];
    const pathCount = /^[RC]/.test(status) ? 2 : 1;
    const paths = tokens.slice(index, index + pathCount);
    if (paths.length !== pathCount) throw new Error(`Malformed git name-status output for ${scope}.`);
    index += pathCount;
    entries.push(`${scope}:${status}:${JSON.stringify(paths)}`);
  }
  return entries;
}

async function gitStatusEntries(worktree) {
  const git = resolveGitExecutable();
  const common = { timeoutMs: 30000 };
  const [unstaged, staged, untracked] = await Promise.all([
    run(git, ['-C', worktree, 'diff', '--name-status', '-z'], common),
    run(git, ['-C', worktree, 'diff', '--cached', '--name-status', '-z'], common),
    run(git, ['-C', worktree, 'ls-files', '--others', '--exclude-standard', '-z'], common),
  ]);
  for (const [label, result] of [['unstaged', unstaged], ['staged', staged], ['untracked', untracked]]) {
    if (!result.ok) throw new Error(`Could not inspect ${label} worktree state: ${result.error || result.stderr}`);
  }
  return [
    ...parseNameStatusEntries(unstaged.stdout, 'unstaged'),
    ...parseNameStatusEntries(staged.stdout, 'staged'),
    ...untracked.stdout.split('\0').filter(Boolean).map((entry) => `untracked:${JSON.stringify(entry)}`),
  ].sort();
}

function validationLogPath(config, worktree) {
  fs.mkdirSync(config.logRoot, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return ensureInternalPath(path.join(config.logRoot, `${timestamp}-${path.basename(worktree)}.log`), config.logRoot, 'Validation log');
}

async function validateWorktree(options = {}) {
  const config = validationConfig();
  if (!config.enabled) return { ok: false, disabled: true, error: 'Unity Worktree validation is disabled.' };
  const inspected = await inspectWorktree(options.worktree, options.sourceProject, config);
  const statusBefore = await gitStatusEntries(inspected.worktree);
  const staticCheck = await gitDiffCheck(inspected.worktree);
  const usage = await usageStatus({
    ...config,
    relevantProjectPaths: [inspected.sourceProject, inspected.worktree],
  });
  if (config.deferWhenBusy && usage.busy) {
    return {
      ok: staticCheck.ok,
      deferred: staticCheck.ok,
      fixPrepared: staticCheck.ok,
      reason: staticCheck.ok
        ? usage.ok ? 'unity-or-viewer-in-use' : 'process-state-unavailable'
        : 'static-validation-failed-before-unity',
      sourceProject: inspected.sourceProject,
      worktree: inspected.worktree,
      usage,
      staticCheck,
      statusBefore,
      editModeTests: { status: 'not-run', reason: 'UnityBusy' },
      playModeTests: { status: 'not-run', reason: 'UnityBusy' },
      manualVerification: { status: 'not-required' },
      tests: [`git diff --check: ${staticCheck.ok ? 'passed' : 'failed'}`, staticCheck.ok ? 'Unity batchmode: deferred while application is in use' : 'Unity batchmode: not run because static validation failed'],
    };
  }

  if (bool(options.dryRun, false)) {
    return {
      ok: true,
      dryRun: true,
      sourceProject: inspected.sourceProject,
      worktree: inspected.worktree,
      usage,
      staticCheck,
      statusBefore,
      dependencies: config.dependencies.map((entry) => ({ ...entry, sourceExists: fs.existsSync(path.join(inspected.sourceProject, entry.path)), targetExists: fs.existsSync(path.join(inspected.worktree, entry.path)) })),
    };
  }

  const snapshots = [];
  const links = [];
  let dependencyCacheCleanup = null;
  let snapshotCacheLock = acquireSnapshotCacheLock(config, Date.now(), 'validation-attach');
  if (!snapshotCacheLock) {
    return {
      ok: staticCheck.ok,
      deferred: staticCheck.ok,
      fixPrepared: staticCheck.ok,
      reason: 'dependency-snapshot-cache-busy',
      sourceProject: inspected.sourceProject,
      worktree: inspected.worktree,
      usage,
      staticCheck,
      statusBefore,
      editModeTests: { status: 'not-run', reason: 'DependencySnapshotCacheBusy' },
      playModeTests: { status: 'not-run', reason: 'DependencySnapshotCacheBusy' },
      manualVerification: { status: 'not-required' },
      tests: [
        `git diff --check: ${staticCheck.ok ? 'passed' : 'failed'}`,
        'Unity batchmode: deferred while dependency snapshot cache is in use',
      ],
    };
  }
  const packagesLock = path.join(inspected.worktree, 'Packages', 'packages-lock.json');
  const packagesLockState = readFileState(packagesLock);
  const generatedProjectFiles = [
    path.join(inspected.worktree, 'Assets', 'UniversalRenderPipelineGlobalSettings.asset'),
  ].map((file) => ({ file, state: readFileState(file) }));
  const orphanMetaStates = await trackedOrphanMetaStates(inspected.worktree);
  const logPath = validationLogPath(config, inspected.worktree);
  let unityResult = null;
  let cleanupError = null;
  try {
    for (const dependency of config.dependencies) {
      const snapshot = snapshotDependency(inspected.sourceProject, dependency, config);
      snapshots.push(snapshot);
      links.push(createDependencyJunction(inspected.worktree, snapshot));
    }
    snapshotCacheLock.release();
    snapshotCacheLock = null;
    try {
      dependencyCacheCleanup = cleanupDependencySnapshots(config, {
        createdNewSnapshot: snapshots.some((entry) => !entry.skipped && !entry.reused),
        protectedSnapshots: links.filter((entry) => entry.attached).map((entry) => entry.snapshot),
      });
    } catch (error) {
      dependencyCacheCleanup = { ok: false, skipped: false, deleted: [], errors: [{ error: error.message }] };
    }
    const unity = resolveUnityExecutable(inspected.worktree, options.unityExe || null);
    unityResult = await runOwnedUnityBatchMode(unity, [
      '-batchmode',
      '-quit',
      '-nographics',
      '-projectPath',
      inspected.worktree,
      '-logFile',
      logPath,
    ], {
      cwd: inspected.worktree,
      worktree: inspected.worktree,
      timeoutMs: config.timeoutMs,
      maxBuffer: 1024 * 1024 * 8,
    });
  } finally {
    snapshotCacheLock?.release();
    snapshotCacheLock = null;
    try {
      restoreFileState(packagesLock, packagesLockState);
      for (const entry of generatedProjectFiles) restoreFileState(entry.file, entry.state);
      for (const link of links.slice().reverse()) removeDependencyJunction(link);
      restoreTrackedOrphanMetaStates(orphanMetaStates);
    } catch (error) {
      cleanupError = error.message;
    }
  }

  const logText = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
  const compileErrors = compileErrorsFromLog(logText);
  const afterStaticCheck = await gitDiffCheck(inspected.worktree);
  const statusAfter = await gitStatusEntries(inspected.worktree);
  const beforeSet = new Set(statusBefore);
  const introducedChanges = statusAfter.filter((entry) => !beforeSet.has(entry));
  const unityPassed = Boolean(unityResult?.ok) && compileErrors.length === 0;
  const ok = unityPassed && afterStaticCheck.ok && introducedChanges.length === 0 && !cleanupError;
  return {
    ok,
    deferred: false,
    sourceProject: inspected.sourceProject,
    worktree: inspected.worktree,
    usage,
    preservedOrphanMetas: orphanMetaStates.map((entry) => entry.relativePath),
    preservedGeneratedProjectFiles: generatedProjectFiles.map((entry) => path.relative(inspected.worktree, entry.file).replace(/\\/g, '/')),
    dependencies: links.map((link) => ({
      path: link.path,
      required: link.required,
      snapshot: link.snapshot || null,
      reused: Boolean(link.reused),
      attached: Boolean(link.attached),
      preexisting: Boolean(link.preexisting),
      skipped: Boolean(link.skipped),
      files: link.files || 0,
      bytes: link.bytes || 0,
    })),
    dependencyCacheCleanup,
    staticCheckBefore: staticCheck,
    staticCheckAfter: afterStaticCheck,
    statusBefore,
    statusAfter,
    introducedChanges,
    unity: {
      ok: unityPassed,
      pid: unityResult?.pid ?? null,
      startedAt: unityResult?.startedAt ?? null,
      timedOut: Boolean(unityResult?.timedOut),
      exitCode: unityResult?.exitCode ?? null,
      signal: unityResult?.signal ?? null,
      error: unityResult?.error || null,
      processCleanup: unityResult?.processCleanup || null,
      compileErrors,
      logPath,
    },
    cleanupError,
    editModeTests: { status: 'not-run' },
    playModeTests: { status: 'not-run' },
    manualVerification: { status: 'not-required' },
    tests: [
      `git diff --check before: ${staticCheck.ok ? 'passed' : 'failed'}`,
      `Unity batchmode compile: ${unityPassed ? 'passed' : 'failed'}`,
      `Unity process tree cleanup: ${unityResult?.processCleanup?.ok ? 'passed' : 'failed'}`,
      `git diff --check after: ${afterStaticCheck.ok ? 'passed' : 'failed'}`,
      `no new tracked/untracked changes: ${introducedChanges.length === 0 ? 'passed' : 'failed'}`,
      `dependency junction cleanup: ${cleanupError ? 'failed' : 'passed'}`,
      `dependency snapshot retention: ${dependencyCacheCleanup?.ok === false ? 'warning' : dependencyCacheCleanup?.skipped ? 'skipped' : 'passed'}`,
    ],
  };
}

module.exports = {
  validationConfig,
  normalizeDependency,
  fingerprintDirectory,
  snapshotDependency,
  cleanupDependencySnapshots,
  createDependencyJunction,
  removeDependencyJunction,
  isUnityAssetImportWorker,
  classifyBusyProcesses,
  busyMatches,
  usageStatus,
  inspectWorktree,
  validateWorktree,
  compileErrorsFromLog,
  gitDiffCheck,
  gitStatusEntries,
  trackedOrphanMetaStates,
  restoreTrackedOrphanMetaStates,
  _internal: {
    samePath,
    insidePath,
    insideLexicalPath,
    expandPath,
    restoreFileState,
    normalizedProcessText,
    processReferencesProject,
    processStartedAfter,
    ownedUnityAuxiliaryProcesses,
    cleanupOwnedUnityProcessTree,
    acquireSnapshotCacheLock,
    startUnityOwnerGuardian,
    stopUnityOwnerGuardian,
    runOwnedUnityBatchMode,
  },
};
