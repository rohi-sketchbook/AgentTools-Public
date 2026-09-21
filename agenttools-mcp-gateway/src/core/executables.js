const fs = require('node:fs');
const path = require('node:path');

function requireExistingFile(filePath, label = 'file') {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    throw new Error(`${label} not found: ${resolved}`);
  }
  return fs.realpathSync.native ? fs.realpathSync.native(resolved) : fs.realpathSync(resolved);
}

function isInsideInstallRoot(candidate, root) {
  const resolvedCandidate = requireExistingFile(candidate, 'executable');
  const resolvedRoot = fs.realpathSync.native ? fs.realpathSync.native(root) : fs.realpathSync(root);
  const candidateCmp = process.platform === 'win32' ? resolvedCandidate.toLowerCase() : resolvedCandidate;
  const rootCmp = process.platform === 'win32' ? resolvedRoot.toLowerCase() : resolvedRoot;
  return candidateCmp === rootCmp || candidateCmp.startsWith(`${rootCmp}${path.sep}`);
}

function requireTrustedExecutable(candidate, root, expectedBaseName, label) {
  const resolved = requireExistingFile(candidate, label);
  if (path.basename(resolved).toLowerCase() !== expectedBaseName.toLowerCase()) {
    throw new Error(`${label} must be named ${expectedBaseName}: ${resolved}`);
  }
  if (!isInsideInstallRoot(resolved, root)) {
    throw new Error(`${label} is outside trusted install root ${root}: ${resolved}`);
  }
  return resolved;
}

function resolveNpmCli() {
  const candidate = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  return requireExistingFile(candidate, 'npm-cli.js');
}

function resolveNpxCachedPackageBin(packageName, version, binName) {
  if (!version) throw new Error(`Exact npm package version is required: ${packageName}/${binName}`);

  const cacheBases = [
    process.env.npm_config_cache || null,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'npm-cache') : null,
    process.env.HOME ? path.join(process.env.HOME, '.npm') : null,
  ].filter(Boolean);
  const roots = [...new Set(cacheBases.map((base) => path.resolve(base, '_npx')))];
  const matches = [];

  for (const root of roots) {
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) continue;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const packageRoot = path.join(root, entry.name, 'node_modules', packageName);
      const packageJsonPath = path.join(packageRoot, 'package.json');
      if (!fs.existsSync(packageJsonPath)) continue;
      try {
        const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
        if (packageJson.name !== packageName || packageJson.version !== version) continue;
        const bin = typeof packageJson.bin === 'string' ? packageJson.bin : packageJson.bin?.[binName];
        if (!bin) continue;
        const script = requireExistingFile(path.resolve(packageRoot, bin), `${packageName} ${binName}`);
        if (!isInsideInstallRoot(script, packageRoot)) {
          throw new Error(`${packageName} ${binName} escapes cached package root: ${script}`);
        }
        matches.push({ script, version: packageJson.version, packageRoot });
      } catch {
        // Ignore malformed or incomplete cache entries and continue searching.
      }
    }
  }

  if (matches.length === 0) {
    throw new Error(`Cached npm package bin not found: ${packageName}@${version}/${binName}. Prime the exact version through the shared launcher first.`);
  }
  matches.sort((a, b) => a.packageRoot.localeCompare(b.packageRoot));
  return matches[0];
}

function resolvePackageBin(projectRoot, packageName, binName) {
  const packageJsonPath = require.resolve(`${packageName}/package.json`, { paths: [projectRoot] });
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  const bin = typeof packageJson.bin === 'string'
    ? packageJson.bin
    : packageJson.bin?.[binName];
  if (!bin) throw new Error(`Package ${packageName} does not define bin ${binName}`);
  return requireExistingFile(path.resolve(path.dirname(packageJsonPath), bin), `${packageName} ${binName}`);
}

function nodeScriptCommand(scriptPath, args = []) {
  return {
    command: requireExistingFile(process.execPath, 'node executable'),
    args: [requireExistingFile(scriptPath, 'Node script'), ...args.map(String)],
  };
}

function npmScriptCommand(projectRoot, scriptName, args = []) {
  const packageJsonPath = requireExistingFile(path.join(projectRoot, 'package.json'), 'package.json');
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  if (!packageJson.scripts?.[scriptName]) {
    throw new Error(`npm script '${scriptName}' is not defined in ${packageJsonPath}`);
  }
  return nodeScriptCommand(resolveNpmCli(), ['run', scriptName, '--', ...args.map(String)]);
}

function resolveUnityExecutable(projectRoot, explicitPath = null) {
  const projectVersionPath = requireExistingFile(
    path.join(projectRoot, 'ProjectSettings', 'ProjectVersion.txt'),
    'Unity ProjectVersion.txt',
  );
  const text = fs.readFileSync(projectVersionPath, 'utf8');
  const match = text.match(/^m_EditorVersion:\s*(.+)$/m);
  if (!match) throw new Error(`Unity version not found in ${projectVersionPath}`);
  const version = match[1].trim();

  // Unity Hub installs editors below Unity/Hub/Editor/<version>, while the
  // standalone editor installer defaults to Program Files/Unity <version>.
  // Both are trusted only when the directory name exactly matches the version
  // declared by ProjectVersion.txt; never fall forward to another installed version.
  const installRoots = [
    path.join('C:/Program Files/Unity/Hub/Editor', version),
    path.join('C:/Program Files', `Unity ${version}`),
  ];
  const candidates = installRoots.map((root) => path.join(root, 'Editor', 'Unity.exe'));

  if (explicitPath) {
    const resolved = requireExistingFile(explicitPath, 'Unity executable');
    if (path.basename(resolved).toLowerCase() !== 'unity.exe') {
      throw new Error(`Unity executable must be named Unity.exe: ${resolved}`);
    }
    const matchingIndex = candidates.findIndex((candidate) => {
      if (!fs.existsSync(candidate)) return false;
      const expected = requireExistingFile(candidate, `Unity ${version} executable`);
      return process.platform === 'win32'
        ? expected.toLowerCase() === resolved.toLowerCase()
        : expected === resolved;
    });
    if (matchingIndex < 0) {
      throw new Error(
        `Unity executable does not match ProjectVersion.txt (${version}). Expected one of: ${candidates.join(', ')}`,
      );
    }
    return requireTrustedExecutable(resolved, installRoots[matchingIndex], 'Unity.exe', `Unity ${version} executable`);
  }

  for (let i = 0; i < candidates.length; i += 1) {
    if (!fs.existsSync(candidates[i])) continue;
    return requireTrustedExecutable(candidates[i], installRoots[i], 'Unity.exe', `Unity ${version} executable`);
  }

  throw new Error(`Unity ${version} executable not found. Expected one of: ${candidates.join(', ')}`);
}

function resolveBlenderExecutable(explicitPath = null) {
  const blenderRoot = 'C:/Program Files/Blender Foundation';
  if (explicitPath) return requireTrustedExecutable(explicitPath, blenderRoot, 'blender.exe', 'Blender executable');
  const candidates = [
    'C:/Program Files/Blender Foundation/Blender 5.2/blender.exe',
    'C:/Program Files/Blender Foundation/Blender 4.5/blender.exe',
    'C:/Program Files/Blender Foundation/Blender 4.3/blender.exe',
  ];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) throw new Error('Blender executable was not found. Pass --blenderExe with an absolute path.');
  return requireTrustedExecutable(found, blenderRoot, 'blender.exe', 'Blender executable');
}

function resolveGitExecutable() {
  const candidates = [
    'C:/Program Files/Git/cmd/git.exe',
    'C:/Program Files/Git/bin/git.exe',
  ];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) throw new Error('Trusted Git executable was not found under C:/Program Files/Git.');
  return requireTrustedExecutable(found, 'C:/Program Files/Git', 'git.exe', 'Git executable');
}

function systemExecutable(name) {
  const systemRoot = process.env.SystemRoot || process.env.windir || 'C:/Windows';
  const candidate = path.join(systemRoot, 'System32', name);
  return requireExistingFile(candidate, name);
}

function windowsPowerShellExecutable() {
  const systemRoot = process.env.SystemRoot || 'C:/Windows';
  return requireExistingFile(
    path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    'Windows PowerShell executable',
  );
}

module.exports = {
  requireExistingFile,
  requireTrustedExecutable,
  isInsideInstallRoot,
  resolveNpmCli,
  resolveNpxCachedPackageBin,
  resolvePackageBin,
  nodeScriptCommand,
  npmScriptCommand,
  resolveUnityExecutable,
  resolveBlenderExecutable,
  resolveGitExecutable,
  systemExecutable,
  windowsPowerShellExecutable,
};
