const status = require('./status');
const gateway = require('./gateway');
const devspace = require('./devspace');
const watchdog = require('./watchdog');
const uiqa = require('./uiqa');
const activity = require('./activity');
const fsTools = require('./fs');
const processTools = require('./process');
const git = require('./git');
const discord = require('./discord');
const blender = require('./blender');
const localAi = require('./localAi');
const image = require('./image');
const windowsUi = require('./windowsUi');
const paths = require('./paths');
const task = require('./task');
const video = require('./video');
const unity = require('./unity');
const workflow = require('./workflow');
const skill = require('./skill');
const history = require('./history');
const hostRequest = require('./hostRequest');

const registry = {
  status,
  gateway,
  devspace,
  watchdog,
  uiqa,
  activity,
  fs: fsTools,
  process: processTools,
  git,
  discord,
  blender,
  localAi,
  image,
  windowsUi,
  paths,
  task,
  video,
  unity,
  workflow,
  skill,
  history,
  hostRequest,
};

function listTools() {
  return Object.entries(registry).flatMap(([domain, actions]) => Object.keys(actions)
    .filter((action) => !action.startsWith('_'))
    .map((action) => ({
      name: `${domain}.${action}`,
      domain,
      action,
    })));
}

async function invoke(domain, action, options = {}) {
  const targetDomain = registry[domain];
  if (!targetDomain) {
    return { ok: false, error: `Unknown domain: ${domain}`, availableDomains: Object.keys(registry) };
  }

  const targetAction = targetDomain[action];
  if (!targetAction) {
    return { ok: false, error: `Unknown action: ${domain}.${action}`, availableActions: Object.keys(targetDomain) };
  }

  try {
    return await targetAction(options);
  } catch (error) {
    return {
      ok: false,
      error: error.message,
      details: error.details || null,
      stack: process.env.AGENTTOOLS_GATEWAY_DEBUG === '1' ? error.stack : undefined,
    };
  }
}

module.exports = {
  registry,
  listTools,
  invoke,
};
