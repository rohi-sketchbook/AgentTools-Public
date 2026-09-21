const {
  startActivity,
  updateActivity,
  completeActivity,
  listActivities,
  getActivity,
  activityPaths,
} = require('../core/activityStore');

async function start(options = {}) {
  return { ok: true, activity: startActivity(options), paths: activityPaths() };
}

async function update(options = {}) {
  return { ok: true, activity: updateActivity(options) };
}

async function complete(options = {}) {
  return { ok: true, activity: completeActivity(options) };
}

async function fail(options = {}) {
  return { ok: true, activity: completeActivity({ ...options, status: 'failed' }) };
}

async function cancel(options = {}) {
  return { ok: true, activity: completeActivity({ ...options, status: 'cancelled' }) };
}

async function list(options = {}) {
  return { ok: true, activities: listActivities(options), paths: activityPaths() };
}

async function get(options = {}) {
  const id = options.id || options.activityId;
  if (!id) return { ok: false, error: 'id is required' };
  const activity = getActivity(String(id));
  if (!activity) return { ok: false, error: `Activity not found: ${id}` };
  return { ok: true, activity };
}

async function paths() {
  return { ok: true, paths: activityPaths() };
}

module.exports = {
  start,
  update,
  complete,
  fail,
  cancel,
  list,
  get,
  paths,
};
