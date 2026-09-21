const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { projectRoot } = require('./config');

const STATE_DIR = path.resolve(process.env.AGENTTOOLS_STATE_ROOT || path.join(projectRoot, 'state'));
const LOCK_PATH = path.join(STATE_DIR, '.state.lock');

function statePath(fileName) {
  if (!/^[A-Za-z0-9_.-]+\.json$/.test(fileName)) {
    throw new Error(`Invalid state file name: ${fileName}`);
  }
  return path.join(STATE_DIR, fileName);
}

function ensureStateDir() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function acquireStateLock({ timeoutMs = 3000, staleMs = 15000 } = {}) {
  ensureStateDir();
  const deadline = Date.now() + timeoutMs;
  const token = `${process.pid}-${crypto.randomBytes(8).toString('hex')}`;
  while (true) {
    try {
      const fd = fs.openSync(LOCK_PATH, 'wx');
      fs.writeFileSync(fd, `${token}\n${new Date().toISOString()}\n`, 'utf8');
      return { fd, token };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const stat = fs.statSync(LOCK_PATH);
        if (Date.now() - stat.mtimeMs > staleMs) {
          fs.unlinkSync(LOCK_PATH);
          continue;
        }
      } catch (statError) {
        if (statError.code === 'ENOENT') continue;
        throw statError;
      }
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for state lock: ${LOCK_PATH}`);
      sleepSync(15);
    }
  }
}

function releaseStateLock(lock) {
  try { fs.closeSync(lock.fd); } catch { /* best effort */ }
  try {
    const owner = fs.readFileSync(LOCK_PATH, 'utf8').split(/\r?\n/, 1)[0];
    if (owner === lock.token) fs.unlinkSync(LOCK_PATH);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function withStateLock(fn, options = {}) {
  const lock = acquireStateLock(options);
  try {
    return fn();
  } finally {
    releaseStateLock(lock);
  }
}

function readState(fileName, fallback) {
  const fullPath = statePath(fileName);
  try {
    return JSON.parse(fs.readFileSync(fullPath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

function writeStateUnlocked(fileName, value) {
  ensureStateDir();
  const fullPath = statePath(fileName);
  const nonce = crypto.randomBytes(6).toString('hex');
  const tempPath = `${fullPath}.${process.pid}.${nonce}.tmp`;
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.renameSync(tempPath, fullPath);
  } finally {
    try { fs.unlinkSync(tempPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function writeState(fileName, value) {
  return withStateLock(() => writeStateUnlocked(fileName, value));
}

function mutateState(fileName, fallback, mutator) {
  return withStateLock(() => {
    const state = readState(fileName, fallback);
    const result = mutator(state);
    writeStateUnlocked(fileName, state);
    return result;
  });
}

module.exports = {
  statePath,
  readState,
  writeState,
  mutateState,
  withStateLock,
};
