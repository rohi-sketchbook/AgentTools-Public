const { spawnSync } = require('node:child_process');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..');
const patterns = [
  { name: 'OpenAI-style secret', regex: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { name: 'GitHub token', regex: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { name: 'AWS access key', regex: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'Slack token', regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: 'Discord token-like value', regex: /\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}\b/ },
  { name: 'private key', regex: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
];

const result = spawnSync('git', [
  'log',
  '--all',
  '--no-color',
  '--no-ext-diff',
  '--format=commit:%H',
  '-p',
  '--',
  '.',
], {
  cwd: repoRoot,
  encoding: 'utf8',
  windowsHide: true,
  maxBuffer: 256 * 1024 * 1024,
});

if (result.error) {
  process.stdout.write(JSON.stringify({ ok: false, error: result.error.message }, null, 2) + '\n');
  process.exit(1);
}
if (result.status !== 0) {
  process.stdout.write(JSON.stringify({ ok: false, error: result.stderr || 'git log failed' }, null, 2) + '\n');
  process.exit(1);
}

let commit = null;
let file = null;
const findings = [];
for (const line of result.stdout.split(/\r?\n/)) {
  if (line.startsWith('commit:')) {
    commit = line.slice('commit:'.length).trim();
    file = null;
    continue;
  }
  if (line.startsWith('+++ b/')) {
    file = line.slice('+++ b/'.length);
    continue;
  }
  if (!line.startsWith('+') || line.startsWith('+++')) continue;

  const content = line.slice(1);
  for (const pattern of patterns) {
    if (pattern.regex.test(content)) {
      findings.push({
        kind: pattern.name,
        commit: commit ? commit.slice(0, 12) : null,
        file,
      });
    }
  }
}

const unique = Array.from(
  new Map(findings.map((entry) => [JSON.stringify(entry), entry])).values(),
);
const output = {
  ok: unique.length === 0,
  commitsScanned: (result.stdout.match(/^commit:/gm) || []).length,
  findings: unique,
};
process.stdout.write(JSON.stringify(output, null, 2) + '\n');
if (!output.ok) process.exitCode = 1;
