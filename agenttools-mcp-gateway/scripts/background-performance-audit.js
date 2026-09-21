#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const SOURCE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.ps1']);
const SKIP_DIRECTORIES = new Set([
  '.git', 'node_modules', 'dist', 'build', 'Library', 'Temp', 'Logs', 'state', '.connect',
  'processed', 'public-workspace', 'generated_images', '.venv', 'venv',
]);

function shouldSkipDirectory(name) {
  return SKIP_DIRECTORIES.has(name) || name.startsWith('.venv-');
}
const IO_PATTERN = /\b(readFile|readFileSync|readdir|readdirSync|statSync|Get-ChildItem|Get-Content|Directory\.GetFiles|File\.ReadAllText)\b/i;
const ALLOW_MARKER = 'performance-audit: allow-bounded-poll';

function parseLiteralNumber(text) {
  const normalized = String(text || '').replace(/_/g, '');
  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

function lineNumber(source, index) {
  return source.slice(0, index).split(/\r?\n/).length;
}

function allowedNear(source, index) {
  const before = source.slice(Math.max(0, index - 600), index);
  return before.includes(ALLOW_MARKER);
}

function findSetIntervalCalls(source) {
  const calls = [];
  let searchIndex = 0;
  while (searchIndex < source.length) {
    const index = source.indexOf('setInterval', searchIndex);
    if (index < 0) break;
    const before = source[index - 1] || '';
    const afterName = source[index + 'setInterval'.length] || '';
    if (/[A-Za-z0-9_$]/.test(before) || /[A-Za-z0-9_$]/.test(afterName)) {
      searchIndex = index + 'setInterval'.length;
      continue;
    }

    let cursor = index + 'setInterval'.length;
    while (/\s/.test(source[cursor] || '')) cursor += 1;
    if (source[cursor] !== '(') {
      searchIndex = cursor + 1;
      continue;
    }

    const openParen = cursor;
    let depth = 1;
    let commaIndex = -1;
    let quote = null;
    let escaped = false;
    let lineComment = false;
    let blockComment = false;
    cursor += 1;
    for (; cursor < source.length; cursor += 1) {
      const ch = source[cursor];
      const next = source[cursor + 1] || '';
      if (lineComment) {
        if (ch === '\n') lineComment = false;
        continue;
      }
      if (blockComment) {
        if (ch === '*' && next === '/') {
          blockComment = false;
          cursor += 1;
        }
        continue;
      }
      if (quote) {
        if (escaped) {
          escaped = false;
          continue;
        }
        if (ch === '\\') {
          escaped = true;
          continue;
        }
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === '/' && next === '/') {
        lineComment = true;
        cursor += 1;
        continue;
      }
      if (ch === '/' && next === '*') {
        blockComment = true;
        cursor += 1;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') {
        quote = ch;
        continue;
      }
      if (ch === '(') {
        depth += 1;
        continue;
      }
      if (ch === ')') {
        depth -= 1;
        if (depth === 0) break;
        continue;
      }
      if (ch === ',' && depth === 1 && commaIndex < 0) commaIndex = cursor;
    }

    if (depth === 0 && commaIndex >= 0) {
      calls.push({
        index,
        body: source.slice(openParen + 1, commaIndex),
        intervalToken: source.slice(commaIndex + 1, cursor).trim(),
      });
      searchIndex = cursor + 1;
    } else {
      searchIndex = openParen + 1;
    }
  }
  return calls;
}

function analyzeSource(source, filePath = '<memory>') {
  const violations = [];
  for (const call of findSetIntervalCalls(source)) {
    const intervalToken = call.intervalToken;
    const intervalMs = /^\d[\d_]*$/.test(intervalToken) ? parseLiteralNumber(intervalToken) : null;
    const index = call.index;
    if (allowedNear(source, index)) continue;
    const body = call.body || '';
    if (intervalMs === null) {
      violations.push({
        filePath,
        line: lineNumber(source, index),
        rule: 'dynamic-interval-requires-review',
        message: `setInterval uses dynamic delay ${intervalToken}; review bounded work and add ${ALLOW_MARKER} with justification`,
      });
      continue;
    }
    if (intervalMs < 1_000) {
      violations.push({
        filePath,
        line: lineNumber(source, index),
        rule: 'high-frequency-interval',
        message: `setInterval ${intervalMs}ms is below the 1s hard floor`,
      });
      continue;
    }
    if (intervalMs <= 5_000 && IO_PATTERN.test(body)) {
      violations.push({
        filePath,
        line: lineNumber(source, index),
        rule: 'polling-io-scan',
        message: `setInterval ${intervalMs}ms performs filesystem I/O; use events/delta checks with a slow fallback`,
      });
    }
  }

  const powerShellLoopRegex = /while\s*\([^)]*\)|while\s*\(\s*\$true\s*\)/gi;
  for (const match of source.matchAll(powerShellLoopRegex)) {
    const index = match.index ?? 0;
    if (allowedNear(source, index)) continue;
    const window = source.slice(index, index + 3000);
    const sleep = window.match(/Start-Sleep\s+-Milliseconds\s+(\d+)/i);
    if (!sleep || !IO_PATTERN.test(window)) continue;
    const intervalMs = Number(sleep[1]);
    if (intervalMs <= 1_000) {
      violations.push({
        filePath,
        line: lineNumber(source, index),
        rule: 'powershell-polling-io-scan',
        message: `PowerShell loop performs filesystem I/O every ${intervalMs}ms`,
      });
    }
  }

  return violations;
}

function shouldSkipFile(filePath) {
  const normalized = filePath.replace(/\\/g, '/');
  const name = path.basename(filePath).toLowerCase();
  if (normalized.split('/').some((part) => shouldSkipDirectory(part))) return true;
  if (normalized.includes('/tests/') || name.includes('.test.') || name.endsWith('-test.js') || name.endsWith('-test.ts')) return true;
  if (name === 'jp-hooks.mjs') return true;
  return false;
}

function walk(root, files = []) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (!shouldSkipDirectory(entry.name)) walk(fullPath, files);
      continue;
    }
    if (!entry.isFile() || !SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
    if (!shouldSkipFile(fullPath)) files.push(fullPath);
  }
  return files;
}

function runRepositoryAudit(root) {
  const violations = [];
  for (const filePath of walk(root)) {
    const source = fs.readFileSync(filePath, 'utf8');
    violations.push(...analyzeSource(source, path.relative(root, filePath)));
  }
  return violations;
}

function main() {
  const root = path.resolve(__dirname, '..', '..');
  const violations = runRepositoryAudit(root);
  if (violations.length > 0) {
    for (const item of violations) {
      process.stderr.write(`[background-performance-audit] ${item.filePath}:${item.line} ${item.rule}: ${item.message}\n`);
    }
    process.stderr.write(`background-performance-audit: FAIL (${violations.length})\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write('background-performance-audit: PASS\n');
}

if (require.main === module) main();

module.exports = { analyzeSource, runRepositoryAudit };
