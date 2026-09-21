const fs = require('node:fs');
const path = require('node:path');
const { readJson } = require('../core/config');
const { createPlannedTask } = require('../core/taskPlans');
const { assertPathAllowed } = require('../core/paths');
const { resolvePackageBin, resolveNpxCachedPackageBin, nodeScriptCommand } = require('../core/executables');

function componentRoot(name) {
  const config = readJson('config/components.json');
  return config.components[name];
}

function folderInfo(root) {
  return {
    path: root,
    exists: fs.existsSync(root),
    packageJson: fs.existsSync(path.join(root, 'package.json')),
    nodeModules: fs.existsSync(path.join(root, 'node_modules')),
  };
}

function findHyperframesProjects(root) {
  if (!fs.existsSync(root)) return [];
  const projects = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const project = path.join(root, entry.name);
    const packageJsonPath = path.join(project, 'package.json');
    if (!fs.existsSync(packageJsonPath)) continue;
    try {
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
      if (packageJson.scripts?.render) {
        projects.push({
          path: project,
          renderScript: packageJson.scripts.render,
        });
      }
    } catch {
      // Ignore malformed unrelated package.json files in discovery.
    }
  }
  return projects;
}

async function status() {
  const remotion = componentRoot('remotion');
  const hyperframes = componentRoot('hyperframes');
  return {
    ok: true,
    remotion: folderInfo(remotion),
    hyperframes: {
      ...folderInfo(hyperframes),
      projects: findHyperframesProjects(hyperframes),
    },
  };
}

async function remotionRender(options = {}) {
  const configuredRoot = assertPathAllowed(componentRoot('remotion')).canonicalPath;
  const root = assertPathAllowed(path.resolve(options.root || configuredRoot)).canonicalPath;
  const rootCmp = process.platform === 'win32' ? root.toLowerCase() : root;
  const configuredCmp = process.platform === 'win32' ? configuredRoot.toLowerCase() : configuredRoot;
  if (!(rootCmp === configuredCmp || rootCmp.startsWith(`${configuredCmp}${path.sep}`))) {
    return { ok: false, error: `Remotion project root must stay under ${configuredRoot}` };
  }
  const composition = String(options.composition || options.comp || '');
  if (!composition) return { ok: false, error: 'composition is required. Use --composition <CompositionName>.' };
  if (composition.startsWith('-') || /[\r\n\0]/.test(composition)) return { ok: false, error: `Invalid Remotion composition: ${composition}` };
  const output = options.output ? assertPathAllowed(path.resolve(options.output)).canonicalPath : null;

  const remotionCli = resolvePackageBin(root, '@remotion/cli', 'remotion');
  const args = ['render', composition];
  if (output) args.push(output);
  if (options.codec) args.push('--codec', String(options.codec));
  const command = nodeScriptCommand(remotionCli, args);

  return createPlannedTask({
    type: 'video.remotion.render',
    title: options.title || `Remotion render: ${composition}`,
    summary: `Plan Remotion render for composition ${composition}`,
    command,
    cwd: root,
    outputPath: output,
    metadata: {
      adapter: 'remotion',
      projectRoot: root,
      launcherScript: remotionCli,
      composition,
      codec: options.codec || null,
      shellFreeLauncher: true,
    },
  });
}

function resolveHyperframesProject(options = {}) {
  const root = path.resolve(options.root || componentRoot('hyperframes'));
  assertPathAllowed(root);
  if (options.project) {
    const project = path.resolve(options.project);
    assertPathAllowed(project);
    const match = findHyperframesProjects(path.dirname(project)).find((entry) => path.resolve(entry.path) === project);
    if (!match) throw new Error(`HyperFrames project does not define an npm render script: ${project}`);
    return match;
  }
  const projects = findHyperframesProjects(root);
  if (projects.length === 1) return projects[0];
  if (projects.length === 0) {
    throw new Error(`No HyperFrames project with an npm render script was found under ${root}`);
  }
  throw new Error(`Multiple HyperFrames projects found under ${root}; pass --project explicitly.`);
}

async function hyperframesRender(options = {}) {
  const projectInfo = resolveHyperframesProject(options);
  const project = projectInfo.path;
  const composition = options.composition || options.comp || null;
  if (composition != null && (String(composition).startsWith('-') || /[\r\n\0]/.test(String(composition)))) {
    return { ok: false, error: `Invalid HyperFrames composition: ${composition}` };
  }
  const output = options.output ? assertPathAllowed(path.resolve(options.output)).canonicalPath : null;

  const expectedVersion = projectInfo.renderScript.match(/hyperframes@([0-9]+(?:\.[0-9]+)*)/i)?.[1] || null;
  if (!expectedVersion) {
    throw new Error(`HyperFrames project render script must pin an exact hyperframes@<version>: ${project}`);
  }
  const hyperframes = resolveNpxCachedPackageBin('hyperframes', expectedVersion, 'hyperframes');
  const scriptArgs = ['render'];
  if (composition) scriptArgs.push(composition);
  if (output) scriptArgs.push('--output', output);
  const command = nodeScriptCommand(hyperframes.script, scriptArgs);

  return createPlannedTask({
    type: 'video.hyperframes.render',
    title: options.title || `HyperFrames render${composition ? `: ${composition}` : ''}`,
    summary: `Plan HyperFrames render in ${project}`,
    command,
    cwd: project,
    outputPath: output,
    metadata: {
      adapter: 'hyperframes',
      projectRoot: project,
      launcherScript: hyperframes.script,
      composition,
      hyperframesVersion: hyperframes.version,
      expectedHyperframesVersion: expectedVersion,
      hyperframesPackageRoot: hyperframes.packageRoot,
      shellFreeLauncher: true,
      requiresNetwork: false,
    },
  });
}

module.exports = {
  status,
  remotionRender,
  hyperframesRender,
};
