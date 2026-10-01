const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const LOCAL_AI_ROOT = __dirname;
const AGENTTOOLS_ROOT = path.resolve(LOCAL_AI_ROOT, '..');
const CONFIG_PATH = path.join(LOCAL_AI_ROOT, 'config', 'local-ai.json');
const LOCAL_CONFIG_PATH = path.join(LOCAL_AI_ROOT, 'config', 'local-ai.local.json');

function deepMerge(base, override) {
  if (Array.isArray(override)) return override.map(cloneValue);
  if (!override || typeof override !== 'object') return cloneValue(override);
  const result = base && typeof base === 'object' && !Array.isArray(base) ? { ...base } : {};
  for (const [key, value] of Object.entries(override)) {
    if (Array.isArray(value)) result[key] = value.map(cloneValue);
    else if (value && typeof value === 'object') result[key] = deepMerge(result[key], value);
    else result[key] = value;
  }
  return result;
}

function cloneValue(value) {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (value && typeof value === 'object') return deepMerge({}, value);
  return value;
}

function variables() {
  return {
    AGENTTOOLS_ROOT,
    LOCAL_AI_ROOT,
    USERPROFILE: os.homedir(),
    HOME: os.homedir(),
    ...process.env,
  };
}

function expand(value, vars = variables()) {
  if (typeof value === 'string') {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name) => {
      const resolved = vars[name];
      if (resolved == null || String(resolved).length === 0) {
        throw new Error(`Configuration variable is not defined: ${name}`);
      }
      return String(resolved);
    });
  }
  if (Array.isArray(value)) return value.map((entry) => expand(entry, vars));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, expand(entry, vars)]));
  }
  return value;
}

function localOverridesEnabled() {
  return process.env.AGENTTOOLS_DISABLE_LOCAL_CONFIG !== '1';
}

function loadConfig() {
  const base = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const local = localOverridesEnabled() && fs.existsSync(LOCAL_CONFIG_PATH)
    ? JSON.parse(fs.readFileSync(LOCAL_CONFIG_PATH, 'utf8'))
    : {};
  const config = expand(deepMerge(base, local));

  return {
    ...config,
    stabilityMatrixRoot: path.resolve(config.stabilityMatrixRoot),
    stabilityMatrixExecutable: path.resolve(config.stabilityMatrixExecutable),
    stabilityMatrixSettings: path.resolve(config.stabilityMatrixSettings),
    registeredWorkflowRoot: path.resolve(config.registeredWorkflowRoot),
    inputRoot: path.resolve(config.inputRoot || path.join(LOCAL_AI_ROOT, 'input')),
    outputRoot: path.resolve(config.outputRoot),
    stateRoot: path.resolve(config.stateRoot),
    detectedWorkflowSources: (config.detectedWorkflowSources || []).map((source) => ({
      ...source,
      path: path.resolve(source.path),
    })),
  };
}

module.exports = {
  CONFIG_PATH,
  LOCAL_CONFIG_PATH,
  loadConfig,
  localOverridesEnabled,
};
