const { syncHistoryIndex, searchHistory, historyStatus } = require('../core/historySearch');

async function search(options = {}) {
  return searchHistory(options);
}

async function sync() {
  return syncHistoryIndex();
}

async function status() {
  return historyStatus();
}

module.exports = {
  search,
  sync,
  status,
};
