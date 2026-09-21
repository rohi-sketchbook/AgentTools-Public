const fs = require('node:fs');
const path = require('node:path');
const { readJson } = require('./config');

function normalizeForComparison(value) {
  const portable = path.resolve(value).replace(/\\/g, '/');
  return process.platform === 'win32' ? portable.toLowerCase() : portable;
}

function toPortablePath(value) {
  return path.resolve(value).replace(/\\/g, '/');
}

function canonicalizePath(targetPath) {
  const absolute = path.resolve(targetPath);
  let current = absolute;
  const tail = [];

  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    tail.unshift(path.basename(current));
    current = parent;
  }

  let base = current;
  if (fs.existsSync(current)) {
    try {
      base = fs.realpathSync.native(current);
    } catch {
      base = fs.realpathSync(current);
    }
  }

  return path.resolve(base, ...tail);
}

function isInside(child, parent) {
  const canonicalChild = canonicalizePath(child);
  const canonicalParent = canonicalizePath(parent);
  const childCmp = normalizeForComparison(canonicalChild);
  const parentCmp = normalizeForComparison(canonicalParent);
  if (childCmp === parentCmp) return true;
  return childCmp.startsWith(`${parentCmp}/`);
}

function getPolicy() {
  return readJson('config/allowed-paths.json');
}

function checkPathAllowed(targetPath) {
  if (!targetPath || typeof targetPath !== 'string') {
    return { ok: false, reason: 'path is required' };
  }

  const policy = getPolicy();
  const absolutePath = path.resolve(targetPath);
  const canonicalPath = canonicalizePath(absolutePath);
  const portablePath = normalizeForComparison(canonicalPath);

  const denied = (policy.deniedPathFragments || []).find((fragment) => {
    const normalizedFragment = process.platform === 'win32' ? String(fragment).toLowerCase() : String(fragment);
    return portablePath.includes(normalizedFragment);
  });
  if (denied) {
    return {
      ok: false,
      path: absolutePath,
      canonicalPath,
      reason: `path contains denied fragment: ${denied}`,
    };
  }

  const matchedRoot = (policy.allowedRoots || []).find((root) => isInside(canonicalPath, root));
  if (!matchedRoot) {
    return {
      ok: false,
      path: absolutePath,
      canonicalPath,
      reason: 'path is outside allowed roots',
      allowedRoots: policy.allowedRoots,
    };
  }

  return {
    ok: true,
    path: absolutePath,
    canonicalPath,
    matchedRoot: canonicalizePath(matchedRoot),
  };
}

function assertPathAllowed(targetPath) {
  const result = checkPathAllowed(targetPath);
  if (!result.ok) {
    const error = new Error(result.reason);
    error.details = result;
    throw error;
  }
  return result;
}

module.exports = {
  toPortablePath,
  canonicalizePath,
  checkPathAllowed,
  assertPathAllowed,
};
