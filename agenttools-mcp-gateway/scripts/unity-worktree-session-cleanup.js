#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const validator = require('../src/core/unityWorktreeValidator');
const { processInfo, stopPid } = require('../src/core/processes');
const { run } = require('../src/core/runner');
const { resolveGitExecutable } = require('../src/core/executables');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--pid') out.pid = Number(argv[++i]);
    else if (arg === '--worktree') out.worktree = argv[++i];
    else if (arg === '--remove-worktree') out.removeWorktree = true;
    else if (arg === '--help' || arg === '-h') out.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return out;
}

function usage() {
  console.log('Usage: node scripts/unity-worktree-session-cleanup.js --pid <Unity PID> --worktree <path> [--remove-worktree]');
}

function removeManagedDependencyJunctions(worktree, config) {
  const removed = [];
  const skipped = [];
  const errors = [];

  for (const dependency of config.dependencies) {
    const target = path.join(worktree, dependency.path);
    try {
      if (!fs.existsSync(target)) {
        skipped.push({ path: dependency.path, reason: 'missing' });
        continue;
      }
      const stat = fs.lstatSync(target);
      if (!stat.isSymbolicLink()) {
        skipped.push({ path: dependency.path, reason: 'not-junction' });
        continue;
      }
      const resolved = fs.realpathSync.native ? fs.realpathSync.native(target) : fs.realpathSync(target);
      if (!validator._internal.insidePath(resolved, config.cacheRoot)) {
        skipped.push({ path: dependency.path, reason: 'outside-managed-cache' });
        continue;
      }
      fs.unlinkSync(target);
      removed.push({ path: dependency.path, target: resolved });
    } catch (error) {
      errors.push({ path: dependency.path, error: error.message });
    }
  }

  return { ok: errors.length === 0, removed, skipped, errors };
}

async function stopOwnedSessionRunner(rootProcess, worktree) {
  const parentPid = Number(rootProcess?.parentPid);
  if (!Number.isInteger(parentPid) || parentPid <= 0) return { ok: true, skipped: true, reason: 'no-parent-pid' };

  const parent = await processInfo(parentPid);
  if (!parent.ok) return { ok: false, pid: parentPid, error: parent.error };
  if (!parent.process) return { ok: true, pid: parentPid, alreadyStopped: true };

  const name = String(parent.process.name || '').toLowerCase();
  const commandLine = validator._internal.normalizedProcessText(parent.process.commandLine);
  const owned = name === 'node.exe'
    && commandLine.includes('unity-worktree-session.js')
    && validator._internal.processReferencesProject(parent.process, worktree);
  if (!owned) {
    return { ok: false, pid: parentPid, error: 'refused-to-stop-unowned-session-runner' };
  }

  return stopPid(parentPid, {
    force: true,
    tree: false,
    timeoutMs: 15000,
    expectedCreationDate: parent.process.creationDate,
  });
}

async function removeManagedWorktree(worktree, sourceProject) {
  const git = resolveGitExecutable();
  const result = await run(git, ['-C', sourceProject, 'worktree', 'remove', '--force', worktree], { timeoutMs: 30000 });
  if (result.ok) {
    return { ok: true, fallback: false, stdout: result.stdout, stderr: result.stderr, error: null };
  }

  const listed = await run(git, ['-C', sourceProject, 'worktree', 'list', '--porcelain'], { timeoutMs: 15000 });
  const normalized = path.resolve(worktree);
  const blocks = listed.ok ? listed.stdout.split(/\r?\n\r?\n/).filter(Boolean) : [];
  const block = blocks.find((entry) => {
    const first = entry.split(/\r?\n/).find((line) => line.startsWith('worktree '));
    return first && validator._internal.samePath(first.slice('worktree '.length).trim(), normalized);
  });
  const prunable = Boolean(block && /(?:^|\r?\n)prunable(?:\s|$)/.test(block));
  const gitMarker = path.join(normalized, '.git');
  if (!prunable || fs.existsSync(gitMarker)) {
    return {
      ok: false,
      fallback: false,
      stdout: result.stdout,
      stderr: result.stderr,
      error: result.error || result.stderr || 'git worktree remove failed before reaching a safe prunable state',
    };
  }

  if (fs.existsSync(normalized)) {
    fs.rmSync(normalized, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 });
  }
  const prune = await run(git, ['-C', sourceProject, 'worktree', 'prune'], { timeoutMs: 15000 });
  const finalList = await run(git, ['-C', sourceProject, 'worktree', 'list', '--porcelain'], { timeoutMs: 15000 });
  const stillRegistered = finalList.ok && finalList.stdout.split(/\r?\n/)
    .filter((line) => line.startsWith('worktree '))
    .some((line) => validator._internal.samePath(line.slice('worktree '.length).trim(), normalized));
  const ok = !fs.existsSync(normalized) && prune.ok && !stillRegistered;
  return {
    ok,
    fallback: true,
    initialError: result.error || result.stderr || null,
    pruneOk: prune.ok,
    stillRegistered,
    error: ok ? null : prune.error || prune.stderr || 'managed worktree residue remains after fallback cleanup',
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }
  if (!Number.isInteger(options.pid) || options.pid <= 0) throw new Error('--pid must be a positive integer');
  if (!options.worktree) throw new Error('--worktree is required');

  const worktree = path.resolve(options.worktree);
  const config = validator.validationConfig();
  try {
    await validator.inspectWorktree(worktree, config.sourceProject, config);
  } catch (error) {
    if (!options.removeWorktree || !config.managedWorktreeRoots.some((root) => validator._internal.insidePath(worktree, root))) {
      throw error;
    }
    const git = resolveGitExecutable();
    const listed = await run(git, ['-C', config.sourceProject, 'worktree', 'list', '--porcelain'], { timeoutMs: 15000 });
    if (!listed.ok) throw error;
    const blocks = listed.stdout.split(/\r?\n\r?\n/).filter(Boolean);
    const block = blocks.find((entry) => {
      const first = entry.split(/\r?\n/).find((line) => line.startsWith('worktree '));
      return first && validator._internal.samePath(first.slice('worktree '.length).trim(), worktree);
    });
    if (!block || !/(?:^|\r?\n)prunable(?:\s|$)/.test(block)) throw error;
  }

  const root = await processInfo(options.pid);
  if (!root.ok) throw new Error(`Failed to inspect PID ${options.pid}: ${root.error}`);
  if (!root.process) {
    const junctionCleanup = removeManagedDependencyJunctions(worktree, config);
    const worktreeCleanup = options.removeWorktree && junctionCleanup.ok
      ? await removeManagedWorktree(worktree, config.sourceProject)
      : { ok: true, skipped: true };
    const ok = junctionCleanup.ok && worktreeCleanup.ok;
    console.log(JSON.stringify({
      ok,
      pid: options.pid,
      alreadyStopped: true,
      junctionCleanup,
      worktreeCleanup,
    }, null, 2));
    if (!ok) process.exitCode = 1;
    return;
  }

  const processCleanup = await validator._internal.cleanupOwnedUnityProcessTree({
    pid: options.pid,
    worktree,
    startedAt: root.process.creationDate,
  });

  // A Unity process can finish its native shutdown while the owning Node child-process
  // handle still keeps the Windows process object visible. Clean only validator-managed
  // junctions, then stop the exact session runner after revalidating its command line.
  const junctionCleanup = removeManagedDependencyJunctions(worktree, config);
  const runnerCleanup = await stopOwnedSessionRunner(root.process, worktree);

  await new Promise((resolve) => setTimeout(resolve, 750));
  const finalRoot = await processInfo(options.pid);
  const rootGone = finalRoot.ok && !finalRoot.process;
  const worktreeCleanup = options.removeWorktree && rootGone && junctionCleanup.ok && runnerCleanup.ok
    ? await removeManagedWorktree(worktree, config.sourceProject)
    : { ok: true, skipped: true };
  const ok = rootGone && junctionCleanup.ok && runnerCleanup.ok && worktreeCleanup.ok;

  console.log(JSON.stringify({
    ok,
    pid: options.pid,
    rootGone,
    processCleanup,
    junctionCleanup,
    runnerCleanup,
    worktreeCleanup,
  }, null, 2));
  if (!ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
  process.exitCode = 1;
});
