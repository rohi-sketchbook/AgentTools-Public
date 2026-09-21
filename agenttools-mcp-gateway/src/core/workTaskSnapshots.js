const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { getTask } = require('./taskStore');
const { statePath } = require('./stateFile');
const { canonicalizePath, assertPathAllowed } = require('./paths');

const SNAPSHOT_SCHEMA = 'agenttools-work-snapshot/v1';
const SNAPSHOT_ROOT = path.join(path.dirname(statePath('tasks.json')), 'work-snapshots');
const SNAPSHOT_ID_PATTERN = /^snap_\d{14}_[a-f0-9]{8}$/;
const MAX_FILES = 100;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;

function nowIso() {
  return new Date().toISOString();
}

function createId() {
  return `snap_${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}_${crypto.randomBytes(4).toString('hex')}`;
}

function sha256Buffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function assertSnapshotId(value) {
  const id = String(value || '').trim();
  if (!SNAPSHOT_ID_PATTERN.test(id)) throw new Error(`Invalid snapshot id: ${id}`);
  return id;
}

function taskWorkspace(task) {
  if (!task || task.type !== 'work') throw new Error('A user-visible Work Task is required.');
  const root = task.work?.resumeContext?.worktreePath
    || task.work?.resumeContext?.workspacePath
    || task.work?.workspaceRoot;
  if (!root) throw new Error('Work Task has no workspaceRoot/checkpoint path.');
  return canonicalizePath(root);
}

function normalizeInputPaths(input) {
  const values = input.paths || input.path || input.files;
  const raw = Array.isArray(values) ? values : values ? [values] : [];
  const paths = raw.flatMap((entry) => String(entry).split(',')).map((entry) => entry.trim()).filter(Boolean);
  if (paths.length === 0) throw new Error('At least one snapshot path is required.');
  if (paths.length > MAX_FILES) throw new Error(`Snapshot path count exceeds ${MAX_FILES}.`);
  return [...new Set(paths)];
}

function isInside(child, parent) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolveWorkspaceFile(workspaceRoot, inputPath) {
  const candidate = path.isAbsolute(inputPath) ? inputPath : path.join(workspaceRoot, inputPath);
  if (!fs.existsSync(candidate)) throw new Error(`Snapshot source does not exist: ${candidate}`);
  const canonical = assertPathAllowed(candidate).canonicalPath;
  if (!isInside(canonical, workspaceRoot)) throw new Error(`Snapshot source escapes workspace: ${inputPath}`);
  const stat = fs.statSync(canonical);
  if (!stat.isFile()) throw new Error(`Snapshots support files only: ${inputPath}`);
  if (stat.size > MAX_FILE_BYTES) throw new Error(`Snapshot file exceeds ${MAX_FILE_BYTES} bytes: ${inputPath}`);
  const relativePath = path.relative(workspaceRoot, canonical);
  if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw new Error(`Invalid snapshot relative path: ${inputPath}`);
  }
  return { fullPath: canonical, relativePath, stat };
}

function manifestPath(taskId, snapshotId) {
  return path.join(SNAPSHOT_ROOT, taskId, snapshotId, 'manifest.json');
}

function snapshotDir(taskId, snapshotId) {
  return path.join(SNAPSHOT_ROOT, taskId, snapshotId);
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.renameSync(temp, filePath);
  } finally {
    try { fs.unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function createWorkSnapshot(input = {}) {
  const taskId = String(input.id || input.taskId || '').trim();
  if (!taskId) throw new Error('taskId is required.');
  const task = getTask(taskId);
  if (!task || task.type !== 'work') throw new Error(`Work task not found: ${taskId}`);
  const workspaceRoot = taskWorkspace(task);
  const requestedPaths = normalizeInputPaths(input);
  const sources = requestedPaths.map((entry) => resolveWorkspaceFile(workspaceRoot, entry));
  const totalBytes = sources.reduce((sum, source) => sum + source.stat.size, 0);
  if (totalBytes > MAX_TOTAL_BYTES) throw new Error(`Snapshot total exceeds ${MAX_TOTAL_BYTES} bytes.`);

  const snapshotId = createId();
  const root = snapshotDir(taskId, snapshotId);
  const fileRoot = path.join(root, 'files');
  const files = [];
  try {
    for (const source of sources) {
      const content = fs.readFileSync(source.fullPath);
      const destination = path.join(fileRoot, source.relativePath);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, content, { flag: 'wx' });
      files.push({
        relativePath: source.relativePath.replace(/\\/g, '/'),
        size: content.length,
        sha256: sha256Buffer(content),
        sourceMtimeMs: source.stat.mtimeMs,
      });
    }
    const manifest = {
      schema: SNAPSHOT_SCHEMA,
      id: snapshotId,
      taskId,
      label: input.label ? String(input.label).trim().slice(0, 500) : null,
      createdAt: nowIso(),
      workspaceRoot,
      totalBytes,
      files,
    };
    writeJsonAtomic(path.join(root, 'manifest.json'), manifest);
    return manifest;
  } catch (error) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
    throw error;
  }
}

function readManifest(taskId, snapshotId) {
  const id = assertSnapshotId(snapshotId);
  const file = manifestPath(taskId, id);
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (manifest.schema !== SNAPSHOT_SCHEMA || manifest.taskId !== taskId || manifest.id !== id) {
    throw new Error(`Invalid snapshot manifest: ${id}`);
  }
  return manifest;
}

function listWorkSnapshots(input = {}) {
  const taskId = String(input.id || input.taskId || '').trim();
  if (!taskId) throw new Error('taskId is required.');
  const taskRoot = path.join(SNAPSHOT_ROOT, taskId);
  if (!fs.existsSync(taskRoot)) return [];
  const manifests = [];
  for (const entry of fs.readdirSync(taskRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !SNAPSHOT_ID_PATTERN.test(entry.name)) continue;
    try { manifests.push(readManifest(taskId, entry.name)); } catch { /* skip malformed */ }
  }
  return manifests.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

function currentRestoreState(taskId, snapshotId) {
  const task = getTask(taskId);
  if (!task || task.type !== 'work') throw new Error(`Work task not found: ${taskId}`);
  const manifest = readManifest(taskId, snapshotId);
  const currentWorkspace = taskWorkspace(task);
  if (canonicalizePath(manifest.workspaceRoot) !== currentWorkspace) {
    throw new Error('Snapshot workspace does not match the Task current workspace.');
  }
  const entries = manifest.files.map((file) => {
    const destination = canonicalizePath(path.join(currentWorkspace, file.relativePath));
    if (!isInside(destination, currentWorkspace)) throw new Error(`Snapshot destination escapes workspace: ${file.relativePath}`);
    let currentHash = null;
    let exists = false;
    if (fs.existsSync(destination)) {
      const stat = fs.statSync(destination);
      if (!stat.isFile()) throw new Error(`Snapshot restore destination is not a file: ${file.relativePath}`);
      if (stat.size > MAX_FILE_BYTES) throw new Error(`Current restore target exceeds safe file size: ${file.relativePath}`);
      exists = true;
      currentHash = sha256Buffer(fs.readFileSync(destination));
    }
    return {
      relativePath: file.relativePath,
      destination,
      snapshotHash: file.sha256,
      currentHash,
      exists,
      changed: currentHash !== file.sha256,
    };
  });
  return { task, manifest, workspaceRoot: currentWorkspace, entries };
}

function restorePayload(taskId, snapshotId) {
  const state = currentRestoreState(taskId, snapshotId);
  return {
    taskId,
    snapshotId: state.manifest.id,
    workspaceRoot: state.workspaceRoot,
    files: state.entries.map((entry) => ({
      relativePath: entry.relativePath,
      currentHash: entry.currentHash,
      snapshotHash: entry.snapshotHash,
      exists: entry.exists,
    })),
  };
}

function restoreWorkSnapshot(input = {}) {
  const taskId = String(input.id || input.taskId || '').trim();
  const snapshotId = assertSnapshotId(input.snapshotId || input.snapshot);
  const state = currentRestoreState(taskId, snapshotId);
  const restored = [];
  for (const entry of state.entries) {
    const source = path.join(snapshotDir(taskId, snapshotId), 'files', entry.relativePath);
    const content = fs.readFileSync(source);
    if (sha256Buffer(content) !== entry.snapshotHash) throw new Error(`Snapshot content hash mismatch: ${entry.relativePath}`);
    fs.mkdirSync(path.dirname(entry.destination), { recursive: true });
    const temp = `${entry.destination}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.restore-tmp`;
    try {
      fs.writeFileSync(temp, content, { flag: 'wx' });
      fs.renameSync(temp, entry.destination);
    } finally {
      try { fs.unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    restored.push(entry.relativePath);
  }
  return { snapshot: state.manifest, restored };
}

module.exports = {
  SNAPSHOT_ROOT,
  SNAPSHOT_SCHEMA,
  MAX_FILES,
  MAX_FILE_BYTES,
  MAX_TOTAL_BYTES,
  createWorkSnapshot,
  listWorkSnapshots,
  readManifest,
  restorePayload,
  restoreWorkSnapshot,
};
