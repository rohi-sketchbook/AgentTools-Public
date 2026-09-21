const devspace = require('../src/tools/devspace');
const manager = require('../src/core/devspaceManager');
const watchdog = require('../src/core/devspaceWatchdog');

function boolArg(name) {
  return process.argv.slice(2).includes(name);
}

function endpointText(status) {
  const endpoint = status?.endpoint;
  if (!endpoint) return '<unknown>';
  return `http://${endpoint.host}:${endpoint.port}${endpoint.healthPath || '/healthz'}`;
}

function gracefulAvailable(status) {
  return Boolean(status?.processes?.some((entry) => entry?.ownership?.gracefulStopAvailable));
}

function printStatus(status) {
  process.stdout.write('=== DevSpace Manual Control ===\n');
  process.stdout.write(`Status       : ${status.status}\n`);
  process.stdout.write(`Runtime      : ${status.installation?.root || '<unknown>'}\n`);
  process.stdout.write(`Version      : ${status.version || '<unknown>'}\n`);
  process.stdout.write(`Endpoint     : ${endpointText(status)}\n`);
  process.stdout.write(`PID          : ${status.pid || '<none>'}\n`);
  process.stdout.write(`Supervisor   : ${gracefulAvailable(status) ? 'CONTROLLED / graceful stop available' : status.processRunning ? 'UNCONTROLLED / graceful stop unavailable' : 'not running'}\n`);
}

function printResult(result) {
  if (result?.before) printStatus(result.before);
  const action = result?.action || 'unknown';
  process.stdout.write(`Action       : ${action}\n`);
  if (result?.changed != null) process.stdout.write(`Changed      : ${result.changed ? 'yes' : 'no'}\n`);
  if (result?.message) process.stdout.write(`Message      : ${result.message}\n`);
  if (result?.error) process.stderr.write(`ERROR        : ${result.error}\n`);
  if (result?.after) {
    process.stdout.write(`After        : ${result.after.status}\n`);
    process.stdout.write(`After PID    : ${result.after.pid || '<none>'}\n`);
  }
  if (result?.started?.after) {
    process.stdout.write(`After        : ${result.started.after.status}\n`);
    process.stdout.write(`After PID    : ${result.started.after.pid || '<none>'}\n`);
  }
}

async function dryRun(action) {
  const status = await manager.status();
  printStatus(status);
  if (action === 'start') {
    process.stdout.write(`Plan         : ${status.status === 'healthy' ? 'no-op; already healthy' : 'start via Gateway supervisor after installation/port checks'}\n`);
    return status.status === 'healthy' || (!status.processRunning && !status.portOccupied && status.installation?.startable) ? 0 : 2;
  }
  if (action === 'stop') {
    if (!status.processRunning) {
      process.stdout.write('Plan         : no-op; already stopped\n');
      return 0;
    }
    const graceful = gracefulAvailable(status);
    process.stdout.write(`Plan         : ${graceful ? 'revalidate ownership -> supervisor shutdown request -> wait for stopped' : 'REFUSE; supervisor graceful control is unavailable'}\n`);
    return graceful ? 0 : 2;
  }
  if (action === 'restart') {
    if (!status.processRunning) {
      process.stdout.write('Plan         : start via Gateway supervisor\n');
      return status.installation?.startable ? 0 : 2;
    }
    const graceful = gracefulAvailable(status);
    process.stdout.write(`Plan         : ${graceful ? 'revalidate ownership -> graceful stop -> wait -> supervisor start -> health check' : 'REFUSE; supervisor graceful control is unavailable'}\n`);
    return graceful ? 0 : 2;
  }
  return 2;
}

async function main() {
  const action = String(process.argv[2] || 'status').toLowerCase();
  const dry = boolArg('--dry-run');

  if (!['start', 'stop', 'restart', 'status', 'doctor'].includes(action)) {
    process.stderr.write(`Unknown action: ${action}\n`);
    process.exitCode = 2;
    return;
  }

  if (action === 'status') {
    const status = await manager.status();
    printStatus(status);
    process.exitCode = status.status === 'healthy' ? 0 : 1;
    return;
  }

  if (action === 'doctor') {
    const diagnosis = await manager.diagnose();
    process.stdout.write('=== DevSpace Doctor ===\n');
    process.stdout.write(`Overall      : ${diagnosis.overall}\n`);
    process.stdout.write(`Status       : ${diagnosis.status}\n`);
    process.stdout.write(`Recommended  : ${diagnosis.recommendedAction}\n`);
    for (const finding of diagnosis.findings || []) {
      process.stdout.write(`[${String(finding.status).toUpperCase()}] ${finding.component}: ${finding.message}\n`);
    }
    process.exitCode = diagnosis.status === 'healthy' ? 0 : 1;
    return;
  }

  if (dry) {
    process.exitCode = await dryRun(action);
    return;
  }

  let result;
  if (action === 'start') result = await devspace._internal.startInternal();
  else if (action === 'stop') result = await devspace._internal.stopInternal({ force: false });
  else {
    const maintenance = watchdog.beginMaintenance({
      reason: 'manual-restart',
      requestedBy: 'devspace-manual-control',
      ttlMs: 120000,
    });
    process.stdout.write(`Maintenance  : active until ${maintenance.expiresAt}\n`);
    try {
      result = await devspace._internal.restartInternal({ force: false });
    } finally {
      watchdog.endMaintenance();
    }
  }

  printResult(result);
  process.exitCode = result.ok ? 0 : 1;
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
