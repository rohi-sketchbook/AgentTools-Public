const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..', '..');
const agentToolsRoot = path.resolve(projectRoot, '..');

function localOverridePath(relativePath) {
  const parsed = path.parse(relativePath);
  return path.join(parsed.dir, `${parsed.name}.local${parsed.ext}`);
}

function deepMerge(base, override) {
  if (Array.isArray(override)) return override.map((value) => cloneValue(value));
  if (!override || typeof override !== 'object') return cloneValue(override);

  const result = base && typeof base === 'object' && !Array.isArray(base)
    ? { ...base }
    : {};
  for (const [key, value] of Object.entries(override)) {
    if (Array.isArray(value)) {
      result[key] = value.map((entry) => cloneValue(entry));
    } else if (value && typeof value === 'object') {
      result[key] = deepMerge(result[key], value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function cloneValue(value) {
  if (Array.isArray(value)) return value.map((entry) => cloneValue(entry));
  if (value && typeof value === 'object') return deepMerge({}, value);
  return value;
}

function configVariables(extra = {}) {
  return {
    AGENTTOOLS_ROOT: agentToolsRoot,
    AGENTTOOLS_GATEWAY_ROOT: projectRoot,
    USERPROFILE: os.homedir(),
    HOME: os.homedir(),
    ...process.env,
    ...extra,
  };
}

function expandConfigString(value, variables = configVariables()) {
  return String(value).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name) => {
    const resolved = variables[name];
    if (resolved == null || String(resolved).length === 0) {
      throw new Error(`Configuration variable is not defined: ${name}`);
    }
    return String(resolved);
  });
}

function expandConfigValue(value, variables = configVariables()) {
  if (typeof value === 'string') return expandConfigString(value, variables);
  if (Array.isArray(value)) return value.map((entry) => expandConfigValue(entry, variables));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, expandConfigValue(entry, variables)]),
    );
  }
  return value;
}

function localOverridesEnabled() {
  return process.env.AGENTTOOLS_DISABLE_LOCAL_CONFIG !== '1';
}

function readJson(relativePath) {
  const fullPath = path.join(projectRoot, relativePath);
  const base = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
  const overrideRelative = localOverridePath(relativePath);
  const overridePath = path.join(projectRoot, overrideRelative);
  const merged = localOverridesEnabled() && fs.existsSync(overridePath)
    ? deepMerge(base, JSON.parse(fs.readFileSync(overridePath, 'utf8')))
    : base;
  return expandConfigValue(merged);
}

function exists(fullPath) {
  try {
    return fs.existsSync(fullPath);
  } catch {
    return false;
  }
}

module.exports = {
  projectRoot,
  agentToolsRoot,
  readJson,
  exists,
  localOverridePath,
  deepMerge,
  expandConfigValue,
  localOverridesEnabled,
};
