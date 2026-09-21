const fs = require('node:fs');
const path = require('node:path');
const { readJson } = require('../core/config');
const { assertPathAllowed } = require('../core/paths');
const { createConfirmation, verifyConfirmation } = require('../core/confirmations');

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);

function walkImages(root, limit = 200) {
  const found = [];
  const stack = [root];

  while (stack.length && found.length < limit) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && entry.name !== '.git') stack.push(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;

      let stat;
      try {
        stat = fs.statSync(fullPath);
      } catch {
        continue;
      }
      found.push({ path: fullPath, size: stat.size, mtime: stat.mtime.toISOString() });
    }
  }

  return found.sort((a, b) => b.mtime.localeCompare(a.mtime));
}

async function list(options = {}) {
  const config = readJson('config/components.json');
  const root = options.root || path.join(config.components.imageBridge, 'UserData');
  assertPathAllowed(root);
  const requestedLimit = Number(options.limit || 20);
  const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(Math.trunc(requestedLimit), 200)) : 20;

  return {
    ok: fs.existsSync(root),
    root,
    images: fs.existsSync(root) ? walkImages(root, Math.max(limit * 10, 100)).slice(0, limit) : [],
  };
}

function latestImage(root) {
  return walkImages(root, 500)[0] || null;
}

function buildSavePayload(options = {}) {
  const config = readJson('config/components.json');
  const defaultSourceRoot = path.join(config.components.imageBridge, 'UserData');
  const source = options.source || options.src || 'latest';
  const dest = options.dest || options.destination;

  if (!dest) throw new Error('Destination is required. Use --dest <allowed-root>/image.png.');

  let sourcePath;
  if (source === 'latest') {
    sourcePath = latestImage(defaultSourceRoot)?.path || null;
    if (!sourcePath) throw new Error(`No source image found under ${defaultSourceRoot}`);
  } else {
    sourcePath = source;
  }

  const sourceCheck = assertPathAllowed(sourcePath);
  const destCheck = assertPathAllowed(dest);
  if (!IMAGE_EXTENSIONS.has(path.extname(sourcePath).toLowerCase())
      || !IMAGE_EXTENSIONS.has(path.extname(sourceCheck.canonicalPath).toLowerCase())) {
    throw new Error(`Source is not a supported image: ${sourcePath}`);
  }
  if (!IMAGE_EXTENSIONS.has(path.extname(dest).toLowerCase())
      || !IMAGE_EXTENSIONS.has(path.extname(destCheck.canonicalPath).toLowerCase())) {
    throw new Error(`Destination extension is not a supported image type: ${dest}`);
  }

  const stat = fs.statSync(sourceCheck.canonicalPath);
  if (!stat.isFile()) throw new Error(`Source image is not a file: ${sourcePath}`);
  return {
    sourcePath: sourceCheck.canonicalPath,
    destPath: destCheck.canonicalPath,
    overwrite: options.overwrite === true || options.overwrite === 'true' || options.overwrite === '1',
    size: stat.size,
    mtime: stat.mtime.toISOString(),
  };
}

async function saveGenerated(options = {}) {
  const payload = buildSavePayload(options);
  const preview = {
    sourcePath: payload.sourcePath,
    destPath: payload.destPath,
    overwrite: payload.overwrite,
    size: payload.size,
    mtime: payload.mtime,
    wouldCreateDirectory: !fs.existsSync(path.dirname(payload.destPath)),
    destinationExists: fs.existsSync(payload.destPath),
  };

  if (preview.destinationExists && !payload.overwrite) {
    return {
      ok: false,
      action: 'image.saveGenerated',
      error: 'Destination already exists. Pass --overwrite true to replace it.',
      preview,
    };
  }

  if (!options.confirmToken) {
    return createConfirmation({
      action: 'image.saveGenerated',
      impact: 'write',
      summary: `Copy image to ${payload.destPath}`,
      payload,
      preview,
    });
  }

  const confirmation = verifyConfirmation({
    action: 'image.saveGenerated',
    token: options.confirmToken,
    payload,
    impact: 'write',
    consume: true,
  });
  if (!confirmation.ok) return { ...confirmation, preview };

  const sourceCheck = assertPathAllowed(payload.sourcePath);
  const destCheckBefore = assertPathAllowed(payload.destPath);
  const latestStat = fs.statSync(sourceCheck.canonicalPath);
  if (latestStat.size !== payload.size || latestStat.mtime.toISOString() !== payload.mtime) {
    return { ok: false, action: 'image.saveGenerated', error: 'Source image changed after confirmation; request a new dry-run.' };
  }
  fs.mkdirSync(path.dirname(destCheckBefore.canonicalPath), { recursive: true });
  const destCheckAfter = assertPathAllowed(payload.destPath);
  if (fs.existsSync(destCheckAfter.canonicalPath) && !payload.overwrite) {
    return { ok: false, action: 'image.saveGenerated', error: 'Destination appeared after confirmation; refusing to overwrite.' };
  }
  fs.copyFileSync(sourceCheck.canonicalPath, destCheckAfter.canonicalPath);
  return {
    ok: true,
    confirmed: true,
    action: 'image.saveGenerated',
    sourcePath: payload.sourcePath,
    destPath: payload.destPath,
  };
}

module.exports = {
  list,
  saveGenerated,
};
