const fs = require('node:fs');
const path = require('node:path');
const { assertPathAllowed } = require('../core/paths');
const { projectRoot } = require('../core/config');
const { createConfirmation, verifyConfirmation } = require('../core/confirmations');
const { sanitizeLogText } = require('../core/redaction');

function samePath(a, b) {
  const left = path.resolve(a);
  const right = path.resolve(b);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function isWithin(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function safePath(targetPath, { mutation = false, readContent = false } = {}) {
  const checked = assertPathAllowed(targetPath);
  if (mutation && samePath(checked.canonicalPath, checked.matchedRoot)) {
    const error = new Error('Refusing to mutate an allowed root itself.');
    error.details = checked;
    throw error;
  }

  const internalStateRoot = path.join(projectRoot, 'state');
  if ((mutation || readContent) && isWithin(internalStateRoot, checked.canonicalPath)) {
    const error = new Error('Refusing generic content access or mutation of the Gateway internal state directory; use dedicated status/log/control tools.');
    error.details = { ...checked, protectedRoot: internalStateRoot };
    throw error;
  }
  return checked;
}

function fingerprint(targetPath) {
  const stat = fs.lstatSync(targetPath);
  return {
    type: stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other',
    size: stat.size,
    mtimeMs: Math.trunc(stat.mtimeMs),
    dev: Number(stat.dev),
    ino: Number(stat.ino),
  };
}

function exists(options = {}) {
  const checked = safePath(options.path);
  return {
    ok: true,
    path: checked.path,
    canonicalPath: checked.canonicalPath,
    exists: fs.existsSync(checked.path),
    matchedRoot: checked.matchedRoot,
  };
}

function stat(options = {}) {
  const checked = safePath(options.path);
  if (!fs.existsSync(checked.path)) {
    return { ok: true, path: checked.path, canonicalPath: checked.canonicalPath, exists: false, matchedRoot: checked.matchedRoot };
  }
  const lst = fs.lstatSync(checked.path);
  const result = {
    ok: true,
    path: checked.path,
    canonicalPath: checked.canonicalPath,
    matchedRoot: checked.matchedRoot,
    exists: true,
    type: lst.isSymbolicLink() ? 'symlink' : lst.isDirectory() ? 'directory' : lst.isFile() ? 'file' : 'other',
    size: lst.size,
    createdAt: lst.birthtime.toISOString(),
    modifiedAt: lst.mtime.toISOString(),
    readOnlyHint: (lst.mode & 0o200) === 0,
  };
  if (lst.isSymbolicLink()) {
    try { result.linkTarget = fs.readlinkSync(checked.path); } catch { result.linkTarget = null; }
  }
  return result;
}

function list(options = {}) {
  const checked = safePath(options.path);
  if (!fs.existsSync(checked.path)) return { ok: false, path: checked.path, error: 'path does not exist' };
  const st = fs.statSync(checked.path);
  if (!st.isDirectory()) return { ok: false, path: checked.path, error: 'path is not a directory' };
  const requested = Number(options.limit ?? 200);
  const limit = Math.max(1, Math.min(Number.isFinite(requested) ? Math.floor(requested) : 200, 1000));
  const entries = fs.readdirSync(checked.path, { withFileTypes: true }).slice(0, limit).map((entry) => ({
    name: entry.name,
    type: entry.isSymbolicLink() ? 'symlink' : entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other',
  }));
  return { ok: true, path: checked.path, canonicalPath: checked.canonicalPath, matchedRoot: checked.matchedRoot, entries, truncated: fs.readdirSync(checked.path).length > limit };
}

function readText(options = {}) {
  const checked = safePath(options.path, { readContent: true });
  if (!fs.existsSync(checked.path)) return { ok: false, path: checked.path, error: 'path does not exist' };
  const st = fs.statSync(checked.path);
  if (!st.isFile()) return { ok: false, path: checked.path, error: 'path is not a regular file' };
  const requested = Number(options.maxBytes ?? 1024 * 1024);
  const maxBytes = Math.max(1, Math.min(Number.isFinite(requested) ? Math.floor(requested) : 1024 * 1024, 4 * 1024 * 1024));
  const fd = fs.openSync(checked.path, 'r');
  try {
    const bytes = Math.min(st.size, maxBytes);
    const buffer = Buffer.alloc(bytes);
    fs.readSync(fd, buffer, 0, bytes, 0);
    const content = buffer.toString('utf8');
    return {
      ok: true,
      path: checked.path,
      canonicalPath: checked.canonicalPath,
      sizeBytes: st.size,
      truncated: st.size > maxBytes,
      content: sanitizeLogText(content, maxBytes),
    };
  } finally {
    fs.closeSync(fd);
  }
}

function collectRecursive(targetPath, maxEntries = 10000) {
  const items = [];
  function visit(current) {
    if (items.length >= maxEntries) throw new Error(`recursive delete preview exceeds ${maxEntries} entries`);
    const lst = fs.lstatSync(current);
    items.push({ path: current, type: lst.isSymbolicLink() ? 'symlink' : lst.isDirectory() ? 'directory' : lst.isFile() ? 'file' : 'other', size: lst.size });
    if (!lst.isDirectory() || lst.isSymbolicLink()) return;
    for (const entry of fs.readdirSync(current)) visit(path.join(current, entry));
  }
  visit(targetPath);
  return items;
}

function deletePreview(targetPath, recursive) {
  const checked = safePath(targetPath, { mutation: true });
  if (!fs.existsSync(checked.path)) {
    return { checked, exists: false, fingerprint: null, items: [], recursive };
  }
  const fp = fingerprint(checked.path);
  if (!recursive && fp.type === 'directory' && fs.readdirSync(checked.path).length > 0) {
    throw new Error('Refusing to delete a non-empty directory with fs.delete; use fs.deleteRecursive explicitly.');
  }
  const items = recursive ? collectRecursive(checked.path) : [{ path: checked.path, type: fp.type, size: fp.size }];
  return {
    checked,
    exists: true,
    fingerprint: fp,
    itemCount: items.length,
    items: items.slice(0, 200),
    itemsTruncated: items.length > 200,
    recursive,
  };
}

async function guardedDelete(options = {}, recursive = false) {
  const preview = deletePreview(options.path, recursive);
  if (!preview.exists) {
    return { ok: true, changed: false, path: preview.checked.path, message: 'path does not exist' };
  }
  const payload = {
    path: preview.checked.path,
    canonicalPath: preview.checked.canonicalPath,
    matchedRoot: preview.checked.matchedRoot,
    recursive,
    fingerprint: preview.fingerprint,
  };
  const action = recursive ? 'fs.deleteRecursive' : 'fs.delete';
  if (!options.confirmToken) {
    return createConfirmation({
      action,
      impact: 'destructive',
      summary: `${recursive ? 'Recursively delete' : 'Delete'} ${preview.checked.path}`,
      payload,
      preview: {
        path: preview.checked.path,
        canonicalPath: preview.checked.canonicalPath,
        matchedRoot: preview.checked.matchedRoot,
        itemCount: preview.itemCount || 1,
        items: preview.items,
        itemsTruncated: preview.itemsTruncated || false,
        recursive,
      },
    });
  }

  const confirmation = verifyConfirmation({ action, token: options.confirmToken, payload, impact: 'destructive', consume: true });
  if (!confirmation.ok) return confirmation;

  const fresh = deletePreview(preview.checked.path, recursive);
  if (!fresh.exists) return { ok: true, confirmed: true, changed: false, path: preview.checked.path, message: 'path disappeared after confirmation' };
  if (JSON.stringify(fresh.fingerprint) !== JSON.stringify(preview.fingerprint) || !samePath(fresh.checked.canonicalPath, preview.checked.canonicalPath)) {
    return { ok: false, confirmed: true, changed: false, path: preview.checked.path, error: 'Target changed after confirmation; request a new dry-run.' };
  }

  try {
    if (recursive) fs.rmSync(fresh.checked.path, { recursive: true, force: false });
    else if (fresh.fingerprint.type === 'directory') fs.rmdirSync(fresh.checked.path);
    else fs.unlinkSync(fresh.checked.path);
    return { ok: true, confirmed: true, changed: true, action, path: fresh.checked.path, recursive };
  } catch (error) {
    return { ok: false, confirmed: true, changed: false, action, path: fresh.checked.path, recursive, error: error.message };
  }
}

module.exports = {
  exists,
  stat,
  list,
  readText,
  delete: (options) => guardedDelete(options, false),
  deleteRecursive: (options) => guardedDelete(options, true),
  _internal: { safePath, isWithin, fingerprint, collectRecursive, deletePreview },
};
