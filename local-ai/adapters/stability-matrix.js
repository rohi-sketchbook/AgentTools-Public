const fs = require('node:fs');
const path = require('node:path');
const { loadConfig } = require('../config');

function normalizeVersion(version) {
  if (!version || typeof version !== 'object') return null;
  return {
    branch: version.InstalledBranch || null,
    commit: version.InstalledCommitSha || null,
    prerelease: Boolean(version.IsPrerelease),
  };
}

function inspectStabilityMatrix() {
  const config = loadConfig();
  const rootExists = fs.existsSync(config.stabilityMatrixRoot);
  const executableExists = fs.existsSync(config.stabilityMatrixExecutable);
  const settingsExists = fs.existsSync(config.stabilityMatrixSettings);
  let settings = null;
  let settingsError = null;

  if (settingsExists) {
    try {
      settings = JSON.parse(fs.readFileSync(config.stabilityMatrixSettings, 'utf8'));
    } catch (error) {
      settingsError = error.message;
    }
  }

  const installedPackages = Array.isArray(settings?.InstalledPackages) ? settings.InstalledPackages : [];
  const comfyPackage = installedPackages.find((entry) =>
    String(entry?.PackageName || entry?.DisplayName || '').toLowerCase() === String(config.comfyUiPackageName).toLowerCase());

  const launchArgs = Array.isArray(comfyPackage?.LaunchArgs)
    ? comfyPackage.LaunchArgs.map((entry) => ({
      name: entry?.Name || null,
      type: entry?.Type || null,
      value: entry?.OptionValue ?? null,
    }))
    : [];

  return {
    root: config.stabilityMatrixRoot,
    executable: config.stabilityMatrixExecutable,
    settings: config.stabilityMatrixSettings,
    installed: rootExists && executableExists,
    rootExists,
    executableExists,
    settingsExists,
    settingsError,
    applicationVersion: settings?.Version || null,
    packageCount: installedPackages.length,
    comfyUi: {
      installed: Boolean(comfyPackage),
      id: comfyPackage?.Id || null,
      displayName: comfyPackage?.DisplayName || config.comfyUiPackageName,
      packageName: comfyPackage?.PackageName || config.comfyUiPackageName,
      version: normalizeVersion(comfyPackage?.Version),
      libraryPath: comfyPackage?.LibraryPath
        ? path.resolve(config.stabilityMatrixRoot, 'Data', comfyPackage.LibraryPath)
        : path.resolve(config.stabilityMatrixRoot, 'Data', 'Packages', config.comfyUiPackageName),
      launchCommand: comfyPackage?.LaunchCommand || null,
      launchArgs,
    },
  };
}

module.exports = {
  inspectStabilityMatrix,
};
