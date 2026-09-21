const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..', '..');
const publicIgnorePath = path.join(repoRoot, '.agenttools-publicignore');

function git(args) {
  const result = spawnSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || ('git ' + args.join(' ') + ' failed'));
  }
  return result.stdout;
}

function publicIgnoreEntries() {
  if (!fs.existsSync(publicIgnorePath)) return [];
  return fs.readFileSync(publicIgnorePath, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/\\/g, '/'))
    .filter((line) => line && !line.startsWith('#'));
}

function isPublicExcluded(relative, entries = publicIgnoreEntries()) {
  const portable = relative.replace(/\\/g, '/');
  return entries.some((entry) => entry.endsWith('/')
    ? portable.startsWith(entry)
    : portable === entry);
}

function candidateFiles() {
  return git(['ls-files', '-z', '--cached', '--others', '--exclude-standard'])
    .split('\0')
    .filter(Boolean)
    .filter((relative) => fs.existsSync(path.join(repoRoot, relative)));
}

function isTextFile(file) {
  const binaryExtensions = new Set([
    '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.mp4', '.mov', '.webm',
    '.wav', '.mp3', '.zip', '.7z', '.dll', '.exe', '.pdb', '.fbx', '.blend',
    '.ttf', '.otf', '.woff', '.woff2',
  ]);
  return !binaryExtensions.has(path.extname(file).toLowerCase());
}

function readText(relative) {
  if (!isTextFile(relative)) return null;
  try {
    const buffer = fs.readFileSync(path.join(repoRoot, relative));
    if (buffer.includes(0)) return null;
    return buffer.toString('utf8');
  } catch {
    return null;
  }
}

const errors = [];
const warnings = [];
const publicIgnore = publicIgnoreEntries();
const candidates = candidateFiles();
const excludedFiles = candidates.filter((file) => isPublicExcluded(file, publicIgnore));
const files = candidates.filter((file) => !isPublicExcluded(file, publicIgnore));

const forbiddenTrackedPath = [
  /(^|\/)\.connect(\/|$)/i,
  /(^|\/)[^/]+\.local\.(?!example\.)[^/]+$/i,
  /(^|\/)state(\/|$)/i,
  /(^|\/)temp(\/|$)/i,
  /(^|\/)logs?(\/|$)/i,
  /\.sqlite3?$/i,
  /\.db$/i,
  /\.(?:pem|key|pfx|p12|jks|keystore)$/i,
  /(^|\/)\.(?:npmrc|pypirc|netrc)$/i,
];

const secretPatterns = [
  { name: 'OpenAI-style secret', regex: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { name: 'GitHub token', regex: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { name: 'AWS access key', regex: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'Slack token', regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: 'private key', regex: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g },
  { name: 'Discord token-like value', regex: /\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}\b/g },
];

const localPathPatterns = [
  /\b[A-Za-z]:[\\/]+Users[\\/]+(?!<user>|%USERNAME%|\$\{USERPROFILE\})[^\\/\s"']+/g,
  /\b[A-Za-z]:[\\/]+(?:codexapp|StabilityMatrix)(?=[\\/\s"']|$)/gi,
  /\/(?:home|Users)\/(?!<user>|\$\{USER\})[^/\s"']+/g,
];

for (const file of files) {
  const envFile = path.basename(file).toLowerCase();
  const sensitiveConfigName = /(?:^|[-_.])(secret|token|credential|credentials)(?:[-_.]|$)/i.test(envFile)
    && /\.(?:json|ya?ml|txt|env)$/i.test(envFile);
  if (forbiddenTrackedPath.some((pattern) => pattern.test(file))
      || (envFile.startsWith('.env') && envFile !== '.env.example')
      || sensitiveConfigName) {
    errors.push({ file, kind: 'forbidden-tracked-runtime-file' });
  }

  const text = readText(file);
  if (text == null) continue;

  for (const entry of secretPatterns) {
    entry.regex.lastIndex = 0;
    if (entry.regex.test(text)) errors.push({ file, kind: entry.name });
  }

  if (/\.local\.example\.|\.config\.example\./i.test(file)) continue;
  for (const regex of localPathPatterns) {
    regex.lastIndex = 0;
    const matches = Array.from(text.matchAll(regex))
      .map((match) => match[0])
      .filter((value) => !/(?:<user>|<userprofile>|example-user|[\\/]+Users[\\/]+(?:me|you)(?:[\\/]|$)|[\\/]home[\\/](?:me|you)(?:[\\/]|$))/i.test(value))
      .slice(0, 3);
    if (matches.length > 0) errors.push({ file, kind: 'local-absolute-path', matches });
  }
}

const result = {
  ok: errors.length === 0,
  distributableFiles: files.length,
  excludedFiles: excludedFiles.length,
  errors,
  warnings,
};

process.stdout.write(JSON.stringify(result, null, 2) + '\n');
if (!result.ok) process.exitCode = 1;
