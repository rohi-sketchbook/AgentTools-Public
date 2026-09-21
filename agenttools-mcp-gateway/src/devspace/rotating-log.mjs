import fs from 'node:fs';
import path from 'node:path';

function boundedInteger(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.floor(number)));
}

function removeIfPresent(file) {
  try {
    fs.unlinkSync(file);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

function renameIfPresent(source, destination) {
  if (!fs.existsSync(source)) return;
  removeIfPresent(destination);
  fs.renameSync(source, destination);
}

function fileSize(file) {
  try {
    return fs.statSync(file).size;
  } catch (error) {
    if (error?.code === 'ENOENT') return 0;
    throw error;
  }
}

export function createRotatingAppender(options = {}) {
  const file = path.resolve(String(options.file || 'devspace.log'));
  const maxBytes = boundedInteger(options.maxBytes, 5 * 1024 * 1024, 64, 1024 * 1024 * 1024);
  const backupCount = boundedInteger(options.backupCount, 3, 1, 20);
  fs.mkdirSync(path.dirname(file), { recursive: true });

  let descriptor = null;
  let sizeBytes = fileSize(file);

  function close() {
    if (descriptor == null) return;
    try {
      fs.closeSync(descriptor);
    } finally {
      descriptor = null;
    }
  }

  function ensureOpen() {
    if (descriptor == null) descriptor = fs.openSync(file, 'a');
    return descriptor;
  }

  function rotate() {
    close();
    removeIfPresent(`${file}.${backupCount}`);
    for (let index = backupCount - 1; index >= 1; index -= 1) {
      renameIfPresent(`${file}.${index}`, `${file}.${index + 1}`);
    }
    renameIfPresent(file, `${file}.1`);
    sizeBytes = 0;
  }

  function append(chunk, encoding = 'utf8') {
    const buffer = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(String(chunk), typeof encoding === 'string' ? encoding : 'utf8');
    if (sizeBytes > 0 && sizeBytes + buffer.length > maxBytes) rotate();
    fs.writeSync(ensureOpen(), buffer);
    sizeBytes += buffer.length;
    return buffer.length;
  }

  return {
    file,
    maxBytes,
    backupCount,
    append,
    rotate,
    close,
    currentSize: () => sizeBytes,
  };
}

export function installRotatingProcessLog(options = {}) {
  const appender = createRotatingAppender(options);

  const write = (chunk, encoding, callback) => {
    const actualEncoding = typeof encoding === 'string' ? encoding : 'utf8';
    const actualCallback = typeof encoding === 'function'
      ? encoding
      : typeof callback === 'function'
        ? callback
        : null;
    try {
      appender.append(chunk, actualEncoding);
      if (actualCallback) queueMicrotask(() => actualCallback());
      return true;
    } catch (error) {
      if (actualCallback) queueMicrotask(() => actualCallback(error));
      return false;
    }
  };

  process.stdout.write = write;
  process.stderr.write = write;
  process.once('exit', () => appender.close());
  return appender;
}
