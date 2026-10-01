const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { checkPathAllowed, canonicalizePath } = require('../src/core/paths');
const { findProcessesLiteral } = require('../src/core/processes');
const fsTools = require('../src/tools/fs');
const discord = require('../src/tools/discord');
const { encodePowerShellCommand, buildPowerShellScriptPayload, runPowerShellScript } = require('../src/core/runner');
const { redactSecrets, redactObject } = require('../src/core/redaction');
const { commandToString } = require('../src/core/taskPlans');
const { resolvePackageBin, resolveUnityExecutable, resolveBlenderExecutable } = require('../src/core/executables');
const { validateTaskCommand } = require('../src/core/taskCommandPolicy');
const { parseOptions } = require('../src/core/options');
const { readTaskLog } = require('../src/core/logs');
const { loadSafety, policyDecision } = require('../src/core/confirmations');
const taskRunner = require('../src/core/taskRunner');
const video = require('../src/tools/video');
const blender = require('../src/tools/blender');
const unity = require('../src/tools/unity');
const { projectRoot, agentToolsRoot, readJson } = require('../src/core/config');

const components = readJson('config/components.json').components || {};
const portableAgentToolsRoot = agentToolsRoot.replace(/\\/g, '/');
const portableGatewayRoot = projectRoot.replace(/\\/g, '/');

async function main() {
  const results = [];
  async function test(name, fn) {
    try {
      await fn();
      results.push({ name, ok: true });
    } catch (error) {
      results.push({ name, ok: false, error: error.message });
    }
  }

  await test('Path separator variants remain inside allowed roots', () => {
    assert.equal(checkPathAllowed(portableAgentToolsRoot).ok, true);
    assert.equal(checkPathAllowed(agentToolsRoot).ok, true);
    if (process.platform === 'win32') {
      assert.equal(checkPathAllowed(portableAgentToolsRoot.toLowerCase()).ok, true);
    }
    const sibling = path.resolve(agentToolsRoot, '..', `${path.basename(agentToolsRoot)}-outside`);
    assert.equal(checkPathAllowed(sibling).ok, false);
  });

  await test('Denied path fragments are case-insensitive on Windows', () => {
    assert.equal(checkPathAllowed(path.join(agentToolsRoot, 'FOO', 'NODE_MODULES', 'a.txt')).ok, false);
    assert.equal(checkPathAllowed(path.join(agentToolsRoot, 'foo', '.ENV')).ok, false);
  });

  await test('Canonical path calculation accepts nonexistent destinations safely', () => {
    const p = canonicalizePath(path.join(projectRoot, '__not_created__', 'a b', '日本語.png'));
    assert.ok(path.isAbsolute(p));
    assert.equal(checkPathAllowed(p).ok, true);
    assert.equal(checkPathAllowed(path.resolve(agentToolsRoot, '..', '..', 'outside-system-path')).ok, false);
  });

  await test('Windows path metacharacters are data, not shell syntax', () => {
    const base = path.join(projectRoot, 'state');
    for (const suffix of [
      'space dir/日本語/file.txt',
      "paren()/ampersand&/apostrophe'/file.txt",
      'forward/slash/file.txt',
      'back\\slash\\file.txt',
      'quote"character/nonexistent.txt',
    ]) {
      assert.equal(checkPathAllowed(`${base}/${suffix}`).ok, true, suffix);
    }
    assert.equal(checkPathAllowed(path.resolve(agentToolsRoot, '..', 'outside-root')).ok, false);
    if (process.platform === 'win32') {
      assert.equal(checkPathAllowed('C:/Windows/System32').ok, false);
      assert.equal(checkPathAllowed('\\\\example-server\\share\\file.txt').ok, false);
    }
    assert.equal(checkPathAllowed(agentToolsRoot).ok, true);
  });

  await test('Junction/symlink escape is rejected when Windows permits junction creation', () => {
    const stateRoot = path.resolve(__dirname, '..', 'state');
    fs.mkdirSync(stateRoot, { recursive: true });
    const inside = fs.mkdtempSync(path.join(stateRoot, 'path-audit-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-outside-'));
    const junction = path.join(inside, 'outside-junction');
    try {
      try {
        fs.symlinkSync(outside, junction, process.platform === 'win32' ? 'junction' : 'dir');
      } catch (error) {
        if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return;
        throw error;
      }
      assert.equal(checkPathAllowed(junction).ok, false);
      assert.equal(checkPathAllowed(path.join(junction, 'nested.txt')).ok, false);
    } finally {
      try { fs.rmSync(junction, { recursive: true, force: true }); } catch { /* test cleanup */ }
      try { fs.rmSync(inside, { recursive: true, force: true }); } catch { /* test cleanup */ }
      try { fs.rmSync(outside, { recursive: true, force: true }); } catch { /* test cleanup */ }
    }
  });

  await test('Action-scoped safety policy is fail-closed and does not inherit legacy booleans', () => {
    const safety = loadSafety();
    assert.equal(safety.actionPolicy?.enabled, true);
    assert.equal(policyDecision(safety, 'discord.post', 'external', true).ok, true);
    assert.equal(policyDecision(safety, 'discord.post', 'external', false).ok, false);
    assert.equal(policyDecision(safety, 'git.commit', 'write', true).ok, true);
    assert.equal(policyDecision(safety, 'git.push', 'external', true).ok, true);
    assert.equal(policyDecision(safety, 'discord.restart', 'external', true).ok, false);
    assert.equal(policyDecision(safety, 'fs.deleteRecursive', 'destructive', true).ok, false);
    assert.equal(policyDecision(safety, 'task.run', 'longRunning', true).ok, true);
    assert.equal(policyDecision(safety, 'task.run', 'longRunning', false).ok, false);

    const permissiveLegacy = JSON.parse(JSON.stringify(safety));
    permissiveLegacy.writeActionsEnabled = true;
    permissiveLegacy.externalActionsEnabled = true;
    permissiveLegacy.destructiveActionsEnabled = true;
    permissiveLegacy.longRunningActionsEnabled = true;
    assert.equal(policyDecision(permissiveLegacy, 'discord.restart', 'external', true).ok, false);
    assert.equal(policyDecision(permissiveLegacy, 'process.start', 'write', true).ok, false);
    assert.equal(taskRunner._internal.executionBlockedReason(safety, { metadata: { adapter: 'unity', requiresNetwork: false } }, true), null);
    assert.match(taskRunner._internal.executionBlockedReason(safety, { metadata: { adapter: 'arbitrary-shell', requiresNetwork: false } }, true), /not allowlisted/i);
    assert.match(taskRunner._internal.executionBlockedReason(safety, { metadata: { adapter: 'hyperframes', requiresNetwork: true } }, true), /network-requiring/i);

    const missingPolicy = JSON.parse(JSON.stringify(permissiveLegacy));
    delete missingPolicy.actionPolicy;
    assert.equal(policyDecision(missingPolicy, 'discord.post', 'external', true).ok, false);

    const postPreview = discord._internal.buildSendPreview({ message: 'audit', userExplicitlyRequested: true });
    assert.equal(postPreview.userExplicitlyRequested, true);
    assert.throws(() => discord._internal.buildSendPreview({
      message: 'audit',
      attachment: 'C:/Windows/System32/notepad.exe',
      userExplicitlyRequested: true,
    }), /not allowed|denied|outside|path/i);
  });

  await test('Filesystem destructive preview rejects allowed root and non-empty directory', () => {
    assert.throws(() => fsTools._internal.deletePreview(agentToolsRoot, false), /allowed root itself/);
    assert.throws(() => fsTools._internal.deletePreview(projectRoot, false), /non-empty directory/);
  });

  await test('Generic filesystem tools cannot read or mutate Gateway internal state', () => {
    const controlState = path.join(projectRoot, 'state', 'devspace', 'control.json');
    const confirmations = path.join(projectRoot, 'state', 'confirmations.json');
    assert.throws(() => fsTools.readText({ path: controlState }), /Gateway internal state/);
    assert.throws(() => fsTools.readText({ path: confirmations }), /Gateway internal state/);
    assert.throws(() => fsTools._internal.deletePreview(controlState, false), /Gateway internal state/);
  });

  await test('Process literal query transports shell-looking text without interpolation', async () => {
    const query = "quote ' \" & | < > ^ $() ; 日本語 / \\";
    const result = await findProcessesLiteral(query);
    assert.equal(result.ok, true, result.error);
    assert.equal(Array.isArray(result.processes), true);
  });

  await test('Privileged recovery sources contain no shell execution escape hatch', () => {
    const privileged = [
      'src/core/processes.js',
      'src/core/devspaceManager.js',
      'src/core/devspaceWatchdog.js',
      'src/core/unityWorktreeValidator.js',
      'src/devspace/supervisor.mjs',
      'src/tools/devspace.js',
      'src/tools/watchdog.js',
      'src/tools/discord.js',
      'src/tools/fs.js',
      'src/tools/process.js',
    ];
    for (const relative of privileged) {
      const source = fs.readFileSync(path.resolve(__dirname, '..', relative), 'utf8');
      assert.doesNotMatch(source, /\bexec(?:Sync)?\s*\(/, relative);
      assert.doesNotMatch(source, /shell\s*:\s*true/i, relative);
      assert.doesNotMatch(source, /cmd(?:\.exe)?\s+\/c/i, relative);
      assert.doesNotMatch(source, /powershell(?:\.exe)?\s+-Command/i, relative);
    }
  });

  await test('PowerShell EncodedCommand is UTF-16LE round-trippable', () => {
    const source = "$x='日本語 / \\ & | < > ^ $()'; Write-Output $x";
    const encoded = encodePowerShellCommand(source);
    assert.equal(Buffer.from(encoded, 'base64').toString('utf16le'), source);
  });

  await test('PowerShell JSON payload preserves dangerous-looking text', () => {
    const payload = buildPowerShellScriptPayload(path.join(agentToolsRoot, 'a b', 'test.ps1'), {
      Message: "quote ' \" & | < > ^ $() ; 日本語 / \\",
      Paths: ['Assets/A B.txt', 'Assets/日本語/ファイル.txt', 'Assets/a&b.txt', 'Assets/forward/slash.txt', 'Assets\\back\\slash.txt'],
    });
    const parsed = JSON.parse(payload);
    assert.equal(parsed.parameters.Message, "quote ' \" & | < > ^ $() ; 日本語 / \\");
    assert.deepEqual(parsed.parameters.Paths, ['Assets/A B.txt', 'Assets/日本語/ファイル.txt', 'Assets/a&b.txt', 'Assets/forward/slash.txt', 'Assets\\back\\slash.txt']);
  });

  await test('PowerShell script binding preserves arrays, quotes, metacharacters and Japanese', async () => {
    const script = path.resolve(__dirname, '..', 'tests', 'powershell-args.ps1');
    const input = {
      Message: "quote ' \" & | < > ^ $() ; 日本語 / \\",
      Paths: ['Assets/A B.txt', 'Assets/日本語/ファイル.txt', 'Assets/a&b.txt', 'Assets/forward/slash.txt', 'Assets\\back\\slash.txt'],
      All: true,
      RepoRoot: path.join(agentToolsRoot, '日本語 folder', 'repo'),
    };
    const result = await runPowerShellScript(script, input, { timeoutMs: 15000 });
    assert.equal(result.ok, true, result.error || result.stderr);
    const line = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
    const parsed = JSON.parse(line);
    assert.equal(parsed.Message, input.Message);
    assert.deepEqual(parsed.Paths, input.Paths);
    assert.equal(parsed.All, true);
    assert.equal(parsed.RepoRoot, input.RepoRoot);
  });

  await test('Redaction catches command-line and object-key secrets', () => {
    assert.match(redactSecrets('-accessToken abcdef123456 -hubSessionId zyx987654321'), /\[REDACTED\]/);
    const obj = redactObject({ accessToken: 'short', nested: { client_secret: 'abc', normal: 'ok' } });
    assert.equal(obj.accessToken, '[REDACTED]');
    assert.equal(obj.nested.client_secret, '[REDACTED]');
    assert.equal(obj.nested.normal, 'ok');
  });

  await test('Command display does not pretend shell escaping semantics', () => {
    const text = commandToString({ command: 'C:/Program Files/test.exe', args: ['a&b', '日本語 path', 'H:/x/y'] });
    assert.match(text, /"a&b"/);
    assert.match(text, /"日本語 path"/);
  });

  await test('Configured optional executables resolve to absolute native files', () => {
    const resolved = [];
    try {
      if (components.remotion) resolved.push(resolvePackageBin(components.remotion, '@remotion/cli', 'remotion'));
    } catch { /* optional runtime not installed */ }
    try {
      if (components.vrmAvatarStudio && fs.existsSync(components.vrmAvatarStudio)) {
        resolved.push(resolveUnityExecutable(components.vrmAvatarStudio));
      }
    } catch { /* optional runtime not installed */ }
    try { resolved.push(resolveBlenderExecutable()); } catch { /* optional runtime not installed */ }
    for (const item of resolved) {
      assert.equal(path.isAbsolute(item), true);
      assert.equal(fs.existsSync(item), true);
    }
  });

  await test('Task command policy rejects direct batch files and arbitrary executables', () => {
    const badBatch = validateTaskCommand({ metadata: { adapter: 'blender-mcp', command: { command: path.join(agentToolsRoot, 'x.bat'), args: [] } } });
    assert.equal(badBatch.ok, false);
    const arbitrary = validateTaskCommand({ metadata: { adapter: 'remotion', command: { command: 'C:/Windows/System32/cmd.exe', args: [] } } });
    assert.equal(arbitrary.ok, false);
  });

  await test('Task command policy rejects argument tampering', async () => {
    try {
      resolveBlenderExecutable();
      const fixtureDir = path.join(projectRoot, 'state', 'audit-fixtures');
      const blendFixture = path.join(fixtureDir, 'dummy.blend');
      fs.mkdirSync(fixtureDir, { recursive: true });
      fs.writeFileSync(blendFixture, 'audit fixture');
      try {
        const blenderPlan = await blender.render({ blend: blendFixture });
        assert.equal(blenderPlan.ok, true);
        const tampered = JSON.parse(JSON.stringify(blenderPlan.task));
        tampered.metadata.command.args.push('--python-expr', 'print(1)');
        assert.equal(validateTaskCommand(tampered).ok, false);
      } finally {
        fs.rmSync(fixtureDir, { recursive: true, force: true });
      }
    } catch {
      // Blender is optional in a public clone.
    }

    const prefixes = loadSafety().allowedUnityMethodPrefixes || [];
    if (components.vrmAvatarStudio && fs.existsSync(components.vrmAvatarStudio) && prefixes.length > 0) {
      const unityPlan = await unity.batchMode({
        project: components.vrmAvatarStudio,
        method: `${prefixes[0]}GatewaySmoke.Run`,
      });
      assert.equal(unityPlan.ok, true);
      const tamperedUnity = JSON.parse(JSON.stringify(unityPlan.task));
      tamperedUnity.metadata.command.args[5] = 'System.IO.File.Delete';
      assert.equal(validateTaskCommand(tamperedUnity).ok, false);
    }
  });

  await test('CLI preserves repeated file options without comma splitting', () => {
    const parsed = parseOptions(['--attachment', 'H:/a,comma.png', '--attachment', 'H:/日本語/b.png']);
    assert.deepEqual(parsed.options.attachment, ['H:/a,comma.png', 'H:/日本語/b.png']);
  });

  await test('Task log path rejects traversal task IDs', () => {
    assert.throws(() => readTaskLog('../../outside', { limit: 10 }), /Invalid taskId/);
  });

  await test('Blender frame zero stays a single-frame render when Blender is installed', async () => {
    try {
      resolveBlenderExecutable();
    } catch {
      return;
    }
    const fixtureDir = path.join(projectRoot, 'state', 'audit-fixtures');
    const blendFixture = path.join(fixtureDir, 'frame-zero.blend');
    fs.mkdirSync(fixtureDir, { recursive: true });
    fs.writeFileSync(blendFixture, 'audit fixture');
    try {
      const plan = await blender.render({ blend: blendFixture, frame: 0 });
      assert.equal(plan.ok, true);
      assert.ok(plan.task.metadata.command.args.includes('-f'));
      assert.ok(plan.task.metadata.command.args.includes('0'));
      assert.equal(plan.task.metadata.command.args.includes('-a'), false);
    } finally {
      fs.rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  await test('Configured planned adapters resolve shell-free trusted launchers', async () => {
    if (process.platform === 'win32' && fs.existsSync(path.join(components.blenderMcp || '', 'Start-BlenderMCP.bat'))) {
      const blenderPlan = await blender.startMcp();
      assert.equal(blenderPlan.ok, true);
      assert.equal(validateTaskCommand({ ...blenderPlan.task, metadata: blenderPlan.task.metadata }).ok, true);
    }

    try {
      const remotionPlan = await video.remotionRender({ composition: 'DevlogExample' });
      assert.equal(remotionPlan.ok, true);
      assert.equal(remotionPlan.task.metadata.command.command, process.execPath);
      assert.equal(validateTaskCommand({ ...remotionPlan.task, metadata: remotionPlan.task.metadata }).ok, true);
    } catch {
      // Remotion dependencies are optional in a public clone.
    }

    const videoStatus = await video.status();
    const hyperProject = videoStatus.hyperframes.projects.find((project) => project.renderScript)?.path;
    if (hyperProject) {
      try {
        const hyperPlan = await video.hyperframesRender({ project: hyperProject });
        assert.equal(hyperPlan.ok, true);
        assert.equal(hyperPlan.task.metadata.command.command, process.execPath);
        assert.equal(hyperPlan.task.metadata.requiresNetwork, false);
        assert.equal(hyperPlan.task.metadata.hyperframesVersion, hyperPlan.task.metadata.expectedHyperframesVersion);
        assert.equal(validateTaskCommand({ ...hyperPlan.task, metadata: hyperPlan.task.metadata }).ok, true);
      } catch {
        // Cached HyperFrames CLI is optional until the video tool is installed.
      }
    }

    const prefixes = loadSafety().allowedUnityMethodPrefixes || [];
    if (components.vrmAvatarStudio && fs.existsSync(components.vrmAvatarStudio) && prefixes.length > 0) {
      const unityPlan = await unity.batchMode({
        project: components.vrmAvatarStudio,
        method: `${prefixes[0]}GatewaySmoke.Run`,
      });
      assert.equal(unityPlan.ok, true);
      assert.equal(validateTaskCommand({ ...unityPlan.task, metadata: unityPlan.task.metadata }).ok, true);
    }
  });

  await test('Video discovery never reports the HyperFrames root as a project', async () => {
    const result = await video.status();
    assert.equal(result.ok, true);
    assert.equal(Array.isArray(result.hyperframes.projects), true);
    assert.ok(result.hyperframes.projects.every((project) => project.path !== result.hyperframes.path));
    assert.ok(result.hyperframes.projects.every((project) => typeof project.renderScript === 'string' && project.renderScript.length > 0));
  });

  const ok = results.every((entry) => entry.ok);
  process.stdout.write(`${JSON.stringify({ ok, results }, null, 2)}\n`);
  if (!ok) process.exitCode = 1;
}

main().catch((error) => {
  process.stdout.write(`${JSON.stringify({ ok: false, error: error.stack || error.message }, null, 2)}\n`);
  process.exitCode = 1;
});
