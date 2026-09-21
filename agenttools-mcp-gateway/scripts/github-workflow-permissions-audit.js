#!/usr/bin/env node
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..');
const workflowsRoot = path.join(repoRoot, '.github', 'workflows');

function validateTopLevelPermissions(source) {
  const lines = String(source || '').replace(/\r\n/g, '\n').split('\n');
  const index = lines.findIndex((line) => /^permissions\s*:/u.test(line));
  if (index < 0) {
    return { ok: false, error: 'top-level permissions is missing' };
  }

  const line = lines[index];
  const inlineValue = line.slice(line.indexOf(':') + 1).replace(/#.*$/u, '').trim();
  if (inlineValue) {
    if (inlineValue === '{}') return { ok: true };
    if (/^(?:read-all|write-all)$/u.test(inlineValue)) {
      return { ok: false, error: `broad top-level permissions is not allowed: ${inlineValue}` };
    }
    return { ok: false, error: 'top-level permissions must use an explicit mapping or {}' };
  }

  const entries = [];
  for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
    const candidate = lines[cursor];
    if (!candidate.trim() || /^\s*#/u.test(candidate)) continue;
    if (/^[^\s]/u.test(candidate)) break;
    const match = candidate.match(/^\s+([a-z-]+)\s*:\s*([^#\s]+)\s*(?:#.*)?$/u);
    if (!match) continue;
    entries.push({ scope: match[1], access: match[2] });
  }

  if (entries.length === 0) {
    return { ok: false, error: 'top-level permissions mapping is empty; use permissions: {}' };
  }

  const broad = entries.find((entry) => entry.access !== 'read' && entry.access !== 'none');
  if (broad) {
    return {
      ok: false,
      error: `top-level permission ${broad.scope}: ${broad.access} is too broad; grant write access only at job level`,
    };
  }

  return { ok: true };
}

function validatePinnedActions(source) {
  const failures = [];
  const lines = String(source || '').replace(/\r\n/g, '\n').split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^\s*-?\s*uses\s*:\s*([^#\s]+)\s*(?:#.*)?$/u);
    if (!match) continue;
    const value = match[1];
    if (value.startsWith('./')) continue;
    if (value.startsWith('docker://')) {
      if (!/@sha256:[0-9a-f]{64}$/iu.test(value)) {
        failures.push({ line: index + 1, value, error: 'docker action must be pinned by sha256 digest' });
      }
      continue;
    }
    const at = value.lastIndexOf('@');
    const ref = at >= 0 ? value.slice(at + 1) : '';
    if (!/^[0-9a-f]{40}$/iu.test(ref)) {
      failures.push({ line: index + 1, value, error: 'external action must be pinned to a full 40-character commit SHA' });
    }
  }
  return failures;
}

function workflowFiles(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.ya?ml$/iu.test(entry.name))
    .map((entry) => path.join(root, entry.name))
    .sort();
}

function runSelfTests() {
  assert.equal(validateTopLevelPermissions('permissions: {}\njobs: {}\n').ok, true);
  assert.equal(validateTopLevelPermissions('permissions:\n  contents: read\njobs: {}\n').ok, true);
  assert.equal(validateTopLevelPermissions('jobs: {}\n').ok, false);
  assert.equal(validateTopLevelPermissions('permissions: write-all\njobs: {}\n').ok, false);
  assert.equal(validateTopLevelPermissions('permissions:\n  contents: write\njobs: {}\n').ok, false);
  assert.deepEqual(validatePinnedActions('steps:\n  - uses: ./local-action\n'), []);
  assert.equal(validatePinnedActions('steps:\n  - uses: actions/checkout@v7\n').length, 1);
  assert.equal(validatePinnedActions('steps:\n  - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1\n').length, 0);
  assert.equal(validatePinnedActions('steps:\n  - uses: docker://alpine:latest\n').length, 1);
}

function main() {
  runSelfTests();
  const failures = [];
  const files = workflowFiles(workflowsRoot);

  for (const file of files) {
    const relative = path.relative(repoRoot, file);
    const source = fs.readFileSync(file, 'utf8');
    const result = validateTopLevelPermissions(source);
    if (!result.ok) {
      failures.push({ file: relative, error: result.error });
    }
    for (const pinFailure of validatePinnedActions(source)) {
      failures.push({ file: relative, ...pinFailure });
    }
  }

  const output = {
    ok: failures.length === 0,
    workflowCount: files.length,
    policy: 'Workflows need restrictive top-level permissions and external actions must be pinned to immutable commits/digests.',
    failures,
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  if (failures.length > 0) process.exitCode = 1;
}

main();

module.exports = { validateTopLevelPermissions, validatePinnedActions };
