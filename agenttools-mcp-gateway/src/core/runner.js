const { execFile, spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function mergeEnv(extraEnv = {}) {
  return {
    ...process.env,
    NO_COLOR: '1',
    ...extraEnv,
  };
}

function run(command, args = [], options = {}) {
  const timeout = options.timeoutMs ?? 15000;
  const cwd = options.cwd;

  return new Promise((resolve) => {
    execFile(command, args, {
      cwd,
      timeout,
      windowsHide: true,
      maxBuffer: options.maxBuffer ?? 1024 * 1024 * 4,
      encoding: 'utf8',
      env: mergeEnv(options.env),
    }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        command,
        args,
        cwd,
        exitCode: error?.code ?? 0,
        signal: error?.signal ?? null,
        stdout: stdout ?? '',
        stderr: stderr ?? '',
        error: error ? error.message : null,
      });
    });
  });
}

function encodePowerShellCommand(command) {
  return Buffer.from(String(command), 'utf16le').toString('base64');
}

function powerShellPreamble() {
  return [
    "$utf8 = New-Object System.Text.UTF8Encoding($false)",
    "[Console]::OutputEncoding = $utf8",
    "$OutputEncoding = $utf8",
  ].join('\n');
}

function windowsPowerShellPath() {
  const systemRoot = process.env.SystemRoot || process.env.windir || 'C:/Windows';
  const candidate = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  if (!fs.existsSync(candidate)) throw new Error(`Windows PowerShell not found: ${candidate}`);
  return fs.realpathSync.native ? fs.realpathSync.native(candidate) : fs.realpathSync(candidate);
}

async function powershell(command, options = {}) {
  const encoded = encodePowerShellCommand(`${powerShellPreamble()}\n${String(command)}`);
  return run(windowsPowerShellPath(), [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-EncodedCommand',
    encoded,
  ], options);
}

function buildPowerShellScriptPayload(scriptPath, parameters = {}) {
  const payload = JSON.stringify({
    scriptPath: String(scriptPath),
    parameters,
  });
  if (payload.length > 24000) {
    throw new Error(`PowerShell payload is too large for a reliable Windows environment variable transfer (${payload.length} chars).`);
  }
  return payload;
}

function powerShellScriptInvoker() {
  return [
    "$ErrorActionPreference = 'Stop'",
    "$payload = $env:AGENTTOOLS_GATEWAY_PS_PAYLOAD | ConvertFrom-Json",
    "$invoke = @{}",
    "foreach ($prop in $payload.parameters.PSObject.Properties) {",
    "  $value = $prop.Value",
    "  if ($null -eq $value) { continue }",
    "  if ($value -is [bool]) { if ($value) { $invoke[$prop.Name] = $true }; continue }",
    "  if ($value -is [System.Array]) { $invoke[$prop.Name] = @($value | ForEach-Object { [string]$_ }); continue }",
    "  $invoke[$prop.Name] = [string]$value",
    "}",
    "& ([string]$payload.scriptPath) @invoke",
    "if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }",
  ].join('\n');
}

async function runPowerShellScript(scriptPath, parameters = {}, options = {}) {
  const payload = buildPowerShellScriptPayload(scriptPath, parameters);
  return powershell(powerShellScriptInvoker(), {
    ...options,
    env: {
      ...(options.env || {}),
      AGENTTOOLS_GATEWAY_PS_PAYLOAD: payload,
    },
  });
}

function spawnDetached(command, args = [], options = {}) {
  const stdoutPath = options.stdoutPath || null;
  let stdoutFd = null;
  try {
    if (stdoutPath) {
      fs.mkdirSync(path.dirname(stdoutPath), { recursive: true });
      stdoutFd = fs.openSync(stdoutPath, 'a');
    }
    const child = spawn(command, args, {
      cwd: options.cwd,
      detached: true,
      windowsHide: true,
      env: mergeEnv(options.env),
      stdio: stdoutFd == null ? ['ignore', 'ignore', 'ignore'] : ['ignore', stdoutFd, stdoutFd],
    });
    child.unref();
    return { ok: true, pid: child.pid, command, args, cwd: options.cwd, stdoutPath };
  } catch (error) {
    return { ok: false, pid: null, command, args, cwd: options.cwd, stdoutPath, error: error.message };
  } finally {
    if (stdoutFd != null) {
      try { fs.closeSync(stdoutFd); } catch { /* child owns duplicated handle */ }
    }
  }
}

async function versionOf(command, args = ['--version']) {
  const result = await run(command, args, { timeoutMs: 10000 });
  return {
    command,
    ok: result.ok,
    version: result.ok ? (result.stdout || result.stderr).trim().split(/\r?\n/)[0] : null,
    error: result.ok ? null : result.error || result.stderr,
  };
}

module.exports = {
  run,
  spawnDetached,
  powershell,
  runPowerShellScript,
  encodePowerShellCommand,
  buildPowerShellScriptPayload,
  powerShellScriptInvoker,
  windowsPowerShellPath,
  versionOf,
};
