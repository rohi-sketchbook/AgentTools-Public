const qa = require('../core/idleUiQa');

async function status() {
  return qa.statusSnapshot();
}

async function issues(options = {}) {
  return qa.listIssues(options);
}

async function runOnce(options = {}) {
  return qa.runOnce({ force: options.force === true || options.force === 'true' });
}

async function resolve(options = {}) {
  return qa.resolveIssue(options);
}

module.exports = {
  status,
  issues,
  runOnce,
  resolve,
};
