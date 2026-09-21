#!/usr/bin/env node
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const validator = require('../src/core/unityWorktreeValidator');

function git(repo, ...args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true }).trim();
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenttools-unity-validator-'));
  try {
    const sourceProject = path.join(root, 'source');
    const worktree = path.join(root, 'worktree');
    const cacheRoot = path.join(root, 'cache');
    const dependencyPath = 'Packages/example.local';
    const sourceDependency = path.join(sourceProject, dependencyPath);
    fs.mkdirSync(sourceDependency, { recursive: true });
    fs.mkdirSync(path.join(worktree, 'Packages'), { recursive: true });
    fs.writeFileSync(path.join(sourceDependency, 'package.json'), '{"name":"example.local"}\n', 'utf8');
    fs.writeFileSync(path.join(sourceDependency, 'Runtime.cs'), 'public class Runtime {}\n', 'utf8');

    const normalized = validator.normalizeDependency({ path: dependencyPath, required: true });
    assert.deepEqual(normalized, { path: dependencyPath, required: true });
    assert.throws(() => validator.normalizeDependency('../escape'), /Invalid local dependency path/);

    const first = validator.snapshotDependency(sourceProject, normalized, { cacheRoot });
    assert.equal(first.reused, false);
    assert.ok(fs.existsSync(first.snapshot));
    assert.ok(fs.existsSync(`${first.snapshot}.manifest.json`));
    assert.equal(fs.existsSync(path.join(first.snapshot, '.agenttools-snapshot.json')), false);

    const second = validator.snapshotDependency(sourceProject, normalized, { cacheRoot });
    assert.equal(second.reused, true);
    assert.equal(second.snapshot, first.snapshot);

    const link = validator.createDependencyJunction(worktree, second);
    assert.equal(link.attached, true);
    assert.ok(fs.lstatSync(link.target).isSymbolicLink());
    assert.equal(fs.readFileSync(path.join(link.target, 'package.json'), 'utf8'), '{"name":"example.local"}\n');
    validator.removeDependencyJunction(link);
    assert.equal(fs.existsSync(link.target), false);
    assert.ok(fs.existsSync(first.snapshot));

    fs.mkdirSync(path.join(worktree, dependencyPath), { recursive: true });
    const recoveredEmptyDirectory = validator.createDependencyJunction(worktree, second);
    assert.equal(recoveredEmptyDirectory.attached, true);
    assert.equal(recoveredEmptyDirectory.preexisting, true);
    assert.equal(recoveredEmptyDirectory.recoveredEmptyDirectory, true);
    assert.ok(fs.lstatSync(recoveredEmptyDirectory.target).isSymbolicLink());
    validator.removeDependencyJunction(recoveredEmptyDirectory);
    assert.equal(fs.existsSync(recoveredEmptyDirectory.target), false);

    fs.symlinkSync(sourceDependency, path.join(worktree, dependencyPath), process.platform === 'win32' ? 'junction' : 'dir');
    const replaced = validator.createDependencyJunction(worktree, second);
    assert.equal(replaced.attached, true);
    assert.equal(replaced.preexisting, true);
    assert.equal(replaced.replacedSourceJunction, true);
    assert.equal(fs.readFileSync(path.join(replaced.target, 'package.json'), 'utf8'), '{"name":"example.local"}\n');

    const recovered = validator.createDependencyJunction(worktree, second);
    assert.equal(recovered.attached, true);
    assert.equal(recovered.preexisting, true);
    assert.equal(recovered.replacedSourceJunction, true);
    assert.equal(recovered.recoveredStaleSnapshot, true);
    validator.removeDependencyJunction(recovered);
    const restoredTarget = fs.realpathSync.native ? fs.realpathSync.native(recovered.target) : fs.realpathSync(recovered.target);
    assert.equal(validator._internal.samePath(restoredTarget, sourceDependency), true);

    fs.writeFileSync(path.join(sourceDependency, 'Runtime.cs'), 'public class Runtime { public int Version => 2; }\n', 'utf8');
    const third = validator.snapshotDependency(sourceProject, normalized, { cacheRoot });
    assert.notEqual(third.snapshot, second.snapshot);
    fs.unlinkSync(path.join(worktree, dependencyPath));
    fs.symlinkSync(second.snapshot, path.join(worktree, dependencyPath), process.platform === 'win32' ? 'junction' : 'dir');
    const upgraded = validator.createDependencyJunction(worktree, third);
    assert.equal(upgraded.recoveredStaleSnapshot, true);
    const upgradedTarget = fs.realpathSync.native ? fs.realpathSync.native(upgraded.target) : fs.realpathSync(upgraded.target);
    assert.equal(validator._internal.samePath(upgradedTarget, third.snapshot), true);
    validator.removeDependencyJunction(upgraded);
    const upgradedRestoredTarget = fs.realpathSync.native ? fs.realpathSync.native(upgraded.target) : fs.realpathSync(upgraded.target);
    assert.equal(validator._internal.samePath(upgradedRestoredTarget, sourceDependency), true);

    const busy = validator.busyMatches([
      { pid: 1, name: 'Unity Hub.exe' },
      { pid: 2, name: 'Unity.exe' },
      { pid: 3, name: 'vr-avatar-viewer.exe' },
      { pid: 4, name: 'vrserver.exe' },
    ], {
      busyProcessNames: ['unity.exe', 'vr-avatar-viewer.exe'],
      blockOnVrRuntime: false,
      vrRuntimeProcessNames: ['vrserver.exe'],
    });
    assert.deepEqual(busy.map((item) => item.pid), [2, 3]);

    const classifiedUnity = validator.classifyBusyProcesses([
      { pid: 10, parentPid: 1, name: 'Unity.exe', commandLine: 'Unity.exe -projectPath H:/project' },
      { pid: 11, parentPid: 10, name: 'Unity.exe', commandLine: 'Unity.exe -batchMode -name AssetImportWorkerHW0 -parentPid 10' },
      { pid: 12, parentPid: 999, name: 'Unity.exe', commandLine: 'Unity.exe -batchMode -name AssetImportWorkerHW1 -parentPid 999' },
    ], {
      busyProcessNames: ['unity.exe'],
      blockOnVrRuntime: false,
      vrRuntimeProcessNames: [],
    });
    assert.deepEqual(classifiedUnity.blockers.map((item) => item.pid), [10, 12]);
    assert.deepEqual(classifiedUnity.auxiliary.map((item) => item.pid), [11, 12]);
    assert.equal(classifiedUnity.blockers[0].role, 'unity-editor');
    assert.equal(classifiedUnity.auxiliary[0].role, 'asset-import-worker');
    assert.equal(classifiedUnity.auxiliary[1].role, 'orphan-asset-import-worker');

    const classifiedOwnedValidation = validator.classifyBusyProcesses([
      {
        pid: 15,
        parentPid: 1,
        name: 'Unity.exe',
        commandLine: 'Unity.exe -batchmode -quit -nographics -projectPath "C:/Users/example-user/.devspace/worktrees/vrm-avatar-studio-test" -logFile "D:/projects/AgentTools/agenttools-mcp-gateway/state/auto-dev/validation-logs/test.log"',
      },
      {
        pid: 16,
        parentPid: 1,
        name: 'Unity.exe',
        commandLine: 'Unity.exe -batchmode -quit -nographics -projectPath "C:/Users/example-user/manual-project" -logFile "C:/temp/manual.log"',
      },
    ], {
      busyProcessNames: ['unity.exe'],
      blockOnVrRuntime: false,
      vrRuntimeProcessNames: [],
      managedWorktreeRoots: ['C:/Users/example-user/.devspace/worktrees'],
      logRoot: 'D:/projects/AgentTools/agenttools-mcp-gateway/state/auto-dev/validation-logs',
    });
    assert.deepEqual(classifiedOwnedValidation.blockers.map((item) => item.pid), [16]);
    assert.deepEqual(classifiedOwnedValidation.auxiliary.map((item) => item.pid), [15]);
    assert.equal(classifiedOwnedValidation.auxiliary[0].role, 'validation-runner');

    const classifiedRelevantValidation = validator.classifyBusyProcesses([
      {
        pid: 20,
        parentPid: 1,
        name: 'Unity.exe',
        commandLine: 'Unity.exe -batchmode -quit -nographics -projectPath "C:/Users/example-user/.devspace/worktrees/vrm-avatar-studio-current" -logFile "D:/projects/AgentTools/agenttools-mcp-gateway/state/auto-dev/validation-logs/current.log"',
      },
      {
        pid: 21,
        parentPid: 1,
        name: 'Unity.exe',
        commandLine: 'Unity.exe -batchmode -quit -nographics -projectPath "C:/Users/example-user/.devspace/worktrees/vrm-avatar-studio-old" -logFile "D:/projects/AgentTools/agenttools-mcp-gateway/state/auto-dev/validation-logs/old.log"',
      },
    ], {
      busyProcessNames: ['unity.exe'],
      blockOnVrRuntime: false,
      vrRuntimeProcessNames: [],
      managedWorktreeRoots: ['C:/Users/example-user/.devspace/worktrees'],
      logRoot: 'D:/projects/AgentTools/agenttools-mcp-gateway/state/auto-dev/validation-logs',
      relevantProjectPaths: ['C:/Users/example-user/.devspace/worktrees/vrm-avatar-studio-current'],
    });
    assert.deepEqual(classifiedRelevantValidation.blockers.map((item) => item.pid), []);
    assert.deepEqual(classifiedRelevantValidation.auxiliary.map((item) => item.pid), [20, 21]);
    assert.equal(classifiedRelevantValidation.auxiliary[0].role, 'validation-runner');
    assert.equal(classifiedRelevantValidation.auxiliary[1].role, 'unrelated-unity-editor');

    const classifiedRelevantProject = validator.classifyBusyProcesses([
      {
        pid: 17,
        parentPid: 1,
        name: 'Unity.exe',
        commandLine: 'Unity.exe -projectPath "D:/projects/vrm-avatar-studio"',
      },
      {
        pid: 18,
        parentPid: 1,
        name: 'Unity.exe',
        commandLine: 'Unity.exe -projectPath "C:/Users/example-user/AppData/Local/VRChatProjects/example_VRC_Avatar"',
      },
      {
        pid: 19,
        parentPid: 18,
        name: 'Unity.exe',
        commandLine: 'Unity.exe -batchMode -name AssetImportWorkerHW0 -projectPath "C:/Users/example-user/AppData/Local/VRChatProjects/example_VRC_Avatar" -parentPid 18',
      },
    ], {
      busyProcessNames: ['unity.exe'],
      blockOnVrRuntime: false,
      vrRuntimeProcessNames: [],
      relevantProjectPaths: [
        'D:/projects/vrm-avatar-studio',
        'C:/Users/example-user/.devspace/worktrees/vrm-avatar-studio-test',
      ],
    });
    assert.deepEqual(classifiedRelevantProject.blockers.map((item) => item.pid), [17]);
    assert.deepEqual(classifiedRelevantProject.auxiliary.map((item) => item.pid), [18, 19]);
    assert.equal(classifiedRelevantProject.auxiliary[0].role, 'unrelated-unity-editor');
    assert.equal(classifiedRelevantProject.auxiliary[1].role, 'unrelated-asset-import-worker');

    const ownedWorkers = validator._internal.ownedUnityAuxiliaryProcesses([
      {
        pid: 21,
        parentPid: 20,
        name: 'Unity.exe',
        creationDate: '2026-07-31T07:00:05.000Z',
        commandLine: 'Unity.exe -batchMode -name AssetImportWorkerHW0 -projectPath "C:/Users/example-user/.devspace/worktrees/vrm-avatar-studio-test" -parentPid 20',
      },
      {
        pid: 22,
        parentPid: 20,
        name: 'Unity.exe',
        creationDate: '2026-07-31T07:00:05.000Z',
        commandLine: 'Unity.exe -batchMode -name AssetImportWorkerHW1 -projectPath "C:/Users/example-user/.devspace/worktrees/other" -parentPid 20',
      },
      {
        pid: 23,
        parentPid: 20,
        name: 'Unity.exe',
        creationDate: '2026-07-31T06:00:00.000Z',
        commandLine: 'Unity.exe -batchMode -name AssetImportWorkerHW2 -projectPath "C:/Users/example-user/.devspace/worktrees/vrm-avatar-studio-test" -parentPid 20',
      },
    ], {
      rootPid: 20,
      worktree: 'C:/Users/example-user/.devspace/worktrees/vrm-avatar-studio-test',
      startedAt: '2026-07-31T07:00:00.000Z',
    });
    assert.deepEqual(ownedWorkers.map((item) => item.pid), [21]);

    const ownedProcessTree = validator._internal.ownedUnityAuxiliaryProcesses([
      {
        pid: 31,
        parentPid: 30,
        name: 'UnityPackageManager.exe',
        creationDate: '2026-07-31T07:00:06.000Z',
        commandLine: 'UnityPackageManager.exe',
      },
      {
        pid: 32,
        parentPid: 31,
        name: 'UnityShaderCompiler.exe',
        creationDate: '2026-07-31T07:00:07.000Z',
        commandLine: 'UnityShaderCompiler.exe',
      },
      {
        pid: 33,
        parentPid: 30,
        name: 'UnityAutoQuitter.exe',
        creationDate: '2026-07-31T07:00:08.000Z',
        commandLine: 'UnityAutoQuitter.exe',
      },
      {
        pid: 34,
        parentPid: 999,
        name: 'UnityShaderCompiler.exe',
        creationDate: '2026-07-31T07:00:09.000Z',
        commandLine: 'UnityShaderCompiler.exe',
      },
    ], {
      rootPid: 30,
      worktree: 'C:/Users/example-user/.devspace/worktrees/vrm-avatar-studio-test',
      startedAt: '2026-07-31T07:00:00.000Z',
    });
    assert.deepEqual(ownedProcessTree.map((item) => item.pid), [31, 32, 33]);

    const retentionRoot = path.join(root, 'retention-cache');
    const retentionConfig = {
      cacheRoot: retentionRoot,
      managedWorktreeRoots: [path.join(root, 'managed-worktrees')],
      dependencies: [{ path: dependencyPath, required: true }],
      snapshotRetention: {
        keepPerDependency: 2,
        maxBytes: 1024 * 1024 * 1024,
        cleanupIntervalMs: 24 * 60 * 60 * 1000,
        lastUsedTouchMs: 60 * 60 * 1000,
      },
    };
    const retentionSnapshots = [];
    for (let version = 1; version <= 4; version += 1) {
      fs.writeFileSync(path.join(sourceDependency, 'Runtime.cs'), `public class Runtime { public int Version => ${version}; }\n`, 'utf8');
      const snapshot = validator.snapshotDependency(sourceProject, normalized, retentionConfig);
      retentionSnapshots.push(snapshot);
    }
    const protectedSnapshot = retentionSnapshots[0];
    const activeCacheLock = validator._internal.acquireSnapshotCacheLock(retentionConfig, Date.now(), 'test-active-validation');
    assert.ok(activeCacheLock);
    const blockedRetention = validator.cleanupDependencySnapshots(retentionConfig, { force: true, dryRun: true });
    assert.equal(blockedRetention.skipped, true);
    assert.equal(blockedRetention.reason, 'snapshot-cache-busy');
    activeCacheLock.release();
    const retention = validator.cleanupDependencySnapshots(retentionConfig, {
      force: true,
      protectedSnapshots: [protectedSnapshot.snapshot],
    });
    assert.equal(retention.ok, true);
    assert.equal(fs.existsSync(protectedSnapshot.snapshot), true);
    assert.equal(fs.existsSync(retentionSnapshots[3].snapshot), true);
    assert.equal(fs.existsSync(retentionSnapshots[2].snapshot), true);
    assert.equal(fs.existsSync(retentionSnapshots[1].snapshot), false);
    assert.equal(retention.deleted.length, 1);

    const busyWithVr = validator.busyMatches([
      { pid: 4, name: 'vrserver.exe' },
    ], {
      busyProcessNames: [],
      blockOnVrRuntime: true,
      vrRuntimeProcessNames: ['vrserver.exe'],
    });
    assert.deepEqual(busyWithVr.map((item) => item.pid), [4]);

    const errors = validator.compileErrorsFromLog([
      'Assets/A.cs(1,2): error CS1002: ; expected',
      'normal line',
      'Scripts have compiler errors.',
    ].join('\n'));
    assert.equal(errors.length, 2);

    const statusRepo = path.join(root, 'status-repo');
    fs.mkdirSync(statusRepo, { recursive: true });
    execFileSync('git', ['init', '-b', 'main', statusRepo], { windowsHide: true });
    git(statusRepo, 'config', 'user.name', 'AgentTools Test');
    git(statusRepo, 'config', 'user.email', 'agenttools-test@example.invalid');
    const trackedFile = path.join(statusRepo, 'tracked.txt');
    const orphanMetaFile = path.join(statusRepo, 'Assets', 'MissingPlugin.pdb.meta');
    fs.mkdirSync(path.dirname(orphanMetaFile), { recursive: true });
    fs.writeFileSync(trackedFile, 'unchanged\n', 'utf8');
    fs.writeFileSync(orphanMetaFile, 'fileFormatVersion: 2\n', 'utf8');
    git(statusRepo, 'add', 'tracked.txt', 'Assets/MissingPlugin.pdb.meta');
    git(statusRepo, 'commit', '-m', 'initial');
    const orphanMetaStates = await validator.trackedOrphanMetaStates(statusRepo);
    assert.deepEqual(orphanMetaStates.map((entry) => entry.relativePath), ['Assets/MissingPlugin.pdb.meta']);
    fs.rmSync(orphanMetaFile);
    validator.restoreTrackedOrphanMetaStates(orphanMetaStates);
    assert.equal(fs.readFileSync(orphanMetaFile, 'utf8'), 'fileFormatVersion: 2\n');
    const touchedAt = new Date(Date.now() + 2000);
    fs.utimesSync(trackedFile, touchedAt, touchedAt);
    assert.deepEqual(await validator.gitStatusEntries(statusRepo), []);
    fs.writeFileSync(trackedFile, 'changed\n', 'utf8');
    fs.writeFileSync(path.join(statusRepo, 'new.txt'), 'new\n', 'utf8');
    assert.deepEqual(await validator.gitStatusEntries(statusRepo), [
      'unstaged:M:["tracked.txt"]',
      'untracked:"new.txt"',
    ]);

    process.stdout.write(`${JSON.stringify({
      ok: true,
      results: [
        'dependency path validation',
        'immutable snapshot creation and reuse',
        'temporary junction attachment, empty-directory recovery, stale snapshot recovery and source-junction restoration',
        'Unity/viewer busy guard',
        'owned validation runner busy exclusion',
        'unrelated Unity project busy exclusion',
        'owned Unity process-tree selection including Unity auxiliary descendants',
        'dependency snapshot retention with active snapshot protection and cache locking',
        'compile error extraction',
        'content-based worktree status without timestamp-only false positives',
        'tracked orphan Unity meta preservation',
      ],
    }, null, 2)}\n`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stdout.write(`${JSON.stringify({ ok: false, error: error.message, stack: error.stack }, null, 2)}\n`);
  process.exitCode = 1;
});
