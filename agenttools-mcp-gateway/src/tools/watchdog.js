const watchdog = require('../core/devspaceWatchdog');

async function status() {
  return watchdog.statusSnapshot();
}

async function history(options = {}) {
  return watchdog.readHistory(options);
}

module.exports = { status, history };
