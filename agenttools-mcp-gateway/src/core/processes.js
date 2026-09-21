const path = require('node:path');
const { powershell, run } = require('./runner');
const { sanitizeLogText } = require('./redaction');

function processQueryCommand() {
  return [
    "$ErrorActionPreference = 'Stop'",
    "$payload = $env:AGENTTOOLS_GATEWAY_PROCESS_QUERY | ConvertFrom-Json",
    "$pattern = [string]$payload.pattern",
    "$mode = [string]$payload.mode",
    "$items = Get-CimInstance Win32_Process",
    "if (-not [string]::IsNullOrWhiteSpace($pattern)) {",
    "  if ($mode -eq 'literal') {",
    "    $items = $items | Where-Object {",
    "      ([string]$_.Name).IndexOf($pattern, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 -or",
    "      ([string]$_.CommandLine).IndexOf($pattern, [System.StringComparison]::OrdinalIgnoreCase) -ge 0",
    "    }",
    "  } else {",
    "    $items = $items | Where-Object { ($_.Name -match $pattern) -or ($_.CommandLine -match $pattern) }",
    "  }",
    "}",
    "$items | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CreationDate,CommandLine,KernelModeTime,UserModeTime,ReadTransferCount,WriteTransferCount,WorkingSetSize | ConvertTo-Json -Compress",
  ].join('\n');
}

function normalizeCreationDate(value) {
  if (!value) return null;
  const text = String(value);
  const wmi = text.match(/^\/Date\((\d+)(?:[+-]\d+)?\)\/$/);
  if (wmi) {
    const timestamp = Number(wmi[1]);
    if (Number.isFinite(timestamp)) return new Date(timestamp).toISOString();
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : text;
}

function normalizeProcessInfo(processInfo) {
  const numberOrNull = (value) => {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  };
  return {
    pid: Number(processInfo.ProcessId),
    parentPid: Number(processInfo.ParentProcessId),
    name: processInfo.Name || null,
    executablePath: processInfo.ExecutablePath ? sanitizeLogText(processInfo.ExecutablePath, 2000) : null,
    creationDate: normalizeCreationDate(processInfo.CreationDate),
    commandLine: sanitizeLogText(processInfo.CommandLine || '', 4000),
    kernelTime100ns: numberOrNull(processInfo.KernelModeTime),
    userTime100ns: numberOrNull(processInfo.UserModeTime),
    readBytes: numberOrNull(processInfo.ReadTransferCount),
    writeBytes: numberOrNull(processInfo.WriteTransferCount),
    workingSetBytes: numberOrNull(processInfo.WorkingSetSize),
  };
}

async function queryProcesses(pattern = '', mode = 'regex') {
  const payload = JSON.stringify({ pattern: String(pattern || ''), mode: mode === 'literal' ? 'literal' : 'regex' });
  const result = await powershell(processQueryCommand(), {
    timeoutMs: 15000,
    env: { AGENTTOOLS_GATEWAY_PROCESS_QUERY: payload },
  });

  if (!result.ok || !result.stdout.trim()) {
    return {
      ok: result.ok,
      pattern,
      mode,
      processes: [],
      error: result.ok ? null : result.error || result.stderr,
    };
  }

  try {
    const parsed = JSON.parse(result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1));
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return {
      ok: true,
      pattern,
      mode,
      processes: list.filter(Boolean).map(normalizeProcessInfo),
      error: null,
    };
  } catch (error) {
    return {
      ok: false,
      pattern,
      mode,
      processes: [],
      error: `failed to parse process list: ${error.message}`,
      raw: sanitizeLogText(result.stdout, 4000),
    };
  }
}

async function findProcesses(pattern) {
  return queryProcesses(pattern, 'regex');
}

async function findProcessesLiteral(pattern) {
  return queryProcesses(pattern, 'literal');
}

async function processInfo(pid) {
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) {
    return { ok: false, pid, process: null, error: 'pid must be a positive integer' };
  }
  const result = await queryProcesses('', 'literal');
  if (!result.ok) return { ok: false, pid: numericPid, process: null, error: result.error };
  return {
    ok: true,
    pid: numericPid,
    process: result.processes.find((item) => item.pid === numericPid) || null,
    error: null,
  };
}

async function listeningPids(port) {
  const numericPort = Number(port);
  if (!Number.isInteger(numericPort) || numericPort < 1 || numericPort > 65535) {
    return { ok: false, port, pids: [], error: 'port must be an integer between 1 and 65535' };
  }
  const command = [
    "$ErrorActionPreference = 'Stop'",
    "$port = [int]$env:AGENTTOOLS_GATEWAY_PORT_QUERY",
    "$items = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction Stop | Select-Object -ExpandProperty OwningProcess -Unique",
    "$items | ConvertTo-Json -Compress",
  ].join('\n');
  const result = await powershell(command, {
    timeoutMs: 10000,
    env: { AGENTTOOLS_GATEWAY_PORT_QUERY: String(numericPort) },
  });
  if (!result.ok) return { ok: false, port: numericPort, pids: [], error: result.error || result.stderr };
  const text = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) || '';
  if (!text) return { ok: true, port: numericPort, pids: [], error: null };
  try {
    const parsed = JSON.parse(text);
    const values = (Array.isArray(parsed) ? parsed : [parsed]).map(Number).filter((pid) => Number.isInteger(pid) && pid > 0);
    return { ok: true, port: numericPort, pids: [...new Set(values)], error: null };
  } catch (error) {
    return { ok: false, port: numericPort, pids: [], error: `failed to parse listening PID list: ${error.message}` };
  }
}

function taskkillPath() {
  const systemRoot = process.env.SystemRoot || process.env.windir || 'C:/Windows';
  return path.join(systemRoot, 'System32', 'taskkill.exe');
}

async function stopPid(pid, { force = false, tree = false, timeoutMs = 15000, expectedCreationDate = null } = {}) {
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) {
    return { ok: false, pid, error: 'pid must be a positive integer' };
  }

  if (expectedCreationDate) {
    const current = await processInfo(numericPid);
    if (!current.ok) return { ok: false, pid: numericPid, error: `failed to revalidate PID before stop: ${current.error}` };
    if (!current.process) {
      return { ok: true, pid: numericPid, alreadyStopped: true, force: Boolean(force), tree: Boolean(tree), error: null };
    }
    if (String(current.process.creationDate || '') !== String(expectedCreationDate)) {
      return {
        ok: false,
        pid: numericPid,
        force: Boolean(force),
        tree: Boolean(tree),
        error: `PID ${numericPid} creation time changed before stop; refusing to target a potentially reused PID.`,
      };
    }
  }

  const args = ['/PID', String(numericPid)];
  if (tree) args.push('/T');
  if (force) args.push('/F');
  const result = await run(taskkillPath(), args, { timeoutMs });
  return {
    ok: result.ok,
    pid: numericPid,
    force: Boolean(force),
    tree: Boolean(tree),
    stdout: sanitizeLogText(result.stdout, 4000),
    stderr: sanitizeLogText(result.stderr, 4000),
    error: result.ok ? null : result.error || result.stderr,
  };
}

module.exports = {
  queryProcesses,
  findProcesses,
  findProcessesLiteral,
  processInfo,
  listeningPids,
  stopPid,
  taskkillPath,
};
