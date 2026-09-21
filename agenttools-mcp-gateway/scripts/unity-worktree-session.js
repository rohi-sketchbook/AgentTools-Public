#!/usr/bin/env node

const path = require('node:path');
const { spawn } = require('node:child_process');
const validator = require('../src/core/unityWorktreeValidator');
const { resolveUnityExecutable } = require('../src/core/executables');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--worktree') out.worktree = argv[++i];
    else if (arg === '--source-project') out.sourceProject = argv[++i];
    else if (arg === '--unity') out.unityExe = argv[++i];
    else if (arg === '--help' || arg === '-h') out.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return out;
}

function usage() {
  console.log('Usage: node scripts/unity-worktree-session.js --worktree <path> [--source-project <path>] [--unity <path>]');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }
  if (!options.worktree) throw new Error('--worktree is required');

  const config = validator.validationConfig();
  const inspected = await validator.inspectWorktree(options.worktree, options.sourceProject, config);
  const usageState = await validator.usageStatus({
    ...config,
    relevantProjectPaths: [inspected.sourceProject, inspected.worktree],
  });
  if (config.deferWhenBusy && usageState.busy) {
    console.error(JSON.stringify({
      ok: false,
      reason: usageState.ok ? 'unity-or-viewer-in-use' : 'process-state-unavailable',
      usage: usageState,
    }, null, 2));
    process.exitCode = 2;
    return;
  }

  const snapshots = [];
  const links = [];
  let child = null;
  let childStartedAt = null;
  let guardian = null;
  let snapshotCacheLock = null;
  let dependencyCacheCleanup = null;
  let linksCleaned = false;
  let cleanupPromise = null;
  let shutdownPromise = null;

  const cleanupLinks = () => {
    if (linksCleaned) return { ok: true, errors: [] };
    linksCleaned = true;
    const errors = [];
    for (const link of links.slice().reverse()) {
      try {
        validator.removeDependencyJunction(link);
      } catch (error) {
        errors.push(`${link.path}: ${error.message}`);
      }
    }
    return { ok: errors.length === 0, errors };
  };

  const cleanupSession = () => {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
      const processCleanup = child?.pid
        ? await validator._internal.cleanupOwnedUnityProcessTree({
          pid: child.pid,
          worktree: inspected.worktree,
          startedAt: childStartedAt,
        })
        : { ok: true, skipped: true };
      const guardianCleanup = await validator._internal.stopUnityOwnerGuardian(guardian);
      const junctionCleanup = cleanupLinks();
      return {
        ok: processCleanup.ok && guardianCleanup.ok && junctionCleanup.ok,
        processCleanup,
        guardianCleanup,
        junctionCleanup,
      };
    })();
    return cleanupPromise;
  };

  const requestShutdown = (exitCode, reason) => {
    if (shutdownPromise) return;
    shutdownPromise = (async () => {
      const cleanup = await cleanupSession();
      if (!cleanup.ok) {
        console.error(JSON.stringify({ ok: false, state: 'shutdown-cleanup-failed', reason, cleanup }, null, 2));
      }
      process.exit(cleanup.ok ? exitCode : 1);
    })();
  };

  process.once('SIGINT', () => requestShutdown(130, 'SIGINT'));
  process.once('SIGTERM', () => requestShutdown(143, 'SIGTERM'));

  try {
    snapshotCacheLock = validator._internal.acquireSnapshotCacheLock(config, Date.now(), 'editor-session-attach');
    if (!snapshotCacheLock) throw new Error('Dependency snapshot cache is currently in use; retry this Unity worktree session shortly.');
    for (const dependency of config.dependencies) {
      const snapshot = validator.snapshotDependency(inspected.sourceProject, dependency, config);
      snapshots.push(snapshot);
      links.push(validator.createDependencyJunction(inspected.worktree, snapshot));
    }
    snapshotCacheLock.release();
    snapshotCacheLock = null;
    try {
      dependencyCacheCleanup = validator.cleanupDependencySnapshots(config, {
        createdNewSnapshot: snapshots.some((entry) => !entry.skipped && !entry.reused),
        protectedSnapshots: links.filter((entry) => entry.attached).map((entry) => entry.snapshot),
      });
    } catch (error) {
      dependencyCacheCleanup = { ok: false, skipped: false, deleted: [], errors: [{ error: error.message }] };
    }

    const unity = resolveUnityExecutable(inspected.worktree, options.unityExe || null);
    childStartedAt = new Date().toISOString();
    child = spawn(unity, ['-projectPath', inspected.worktree], {
      cwd: inspected.worktree,
      windowsHide: false,
      env: { ...process.env, NO_COLOR: '1' },
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    guardian = validator._internal.startUnityOwnerGuardian({
      ownerPid: process.pid,
      unityPid: child.pid,
      worktree: inspected.worktree,
    });
    if (!guardian.ok) throw new Error(guardian.error || 'Unity owner guardian failed to start');

    console.log(JSON.stringify({
      ok: true,
      state: 'started',
      worktree: inspected.worktree,
      sourceProject: inspected.sourceProject,
      unity,
      unityPid: child.pid,
      guardianPid: guardian.pid || null,
      dependencyCacheCleanup: dependencyCacheCleanup ? {
        ok: dependencyCacheCleanup.ok,
        skipped: Boolean(dependencyCacheCleanup.skipped),
        deletedSnapshots: dependencyCacheCleanup.deleted?.length || 0,
      } : null,
      dependencies: links.map((link) => ({
        path: link.path,
        attached: Boolean(link.attached),
        skipped: Boolean(link.skipped),
        reused: Boolean(link.reused),
      })),
    }));

    const exit = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (exitCode, signal) => resolve({ exitCode, signal }));
    });

    const cleanup = await cleanupSession();
    console.log(JSON.stringify({
      ok: exit.exitCode === 0 && cleanup.ok,
      state: 'exited',
      worktree: inspected.worktree,
      unityPid: child.pid,
      cleanup,
      ...exit,
    }));
    if (exit.exitCode !== 0 || !cleanup.ok) process.exitCode = exit.exitCode || 1;
  } finally {
    snapshotCacheLock?.release();
    snapshotCacheLock = null;
    if (!shutdownPromise) await cleanupSession();
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error.message, stack: error.stack }, null, 2));
  process.exitCode = 1;
});
