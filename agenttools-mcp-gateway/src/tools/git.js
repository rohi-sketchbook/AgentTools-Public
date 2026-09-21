const path = require('node:path');
const { run, runPowerShellScript } = require('../core/runner');
const { assertPathAllowed } = require('../core/paths');
const { readJson } = require('../core/config');
const { createConfirmation, verifyConfirmation } = require('../core/confirmations');
const { resolveGitExecutable } = require('../core/executables');

function runGit(repo, args, options = {}) {
  return run(resolveGitExecutable(), ['-C', repo, ...args], options);
}

function repoFrom(options = {}) {
  const repo = options.repo || options.r || process.cwd();
  return assertPathAllowed(repo).canonicalPath;
}

function truthy(value) {
  return value === true || value === 'true' || value === '1' || value === 'yes';
}

function splitPaths(value, singleValue = null) {
  if (Array.isArray(singleValue)) return singleValue.map(String).filter(Boolean);
  if (singleValue != null && singleValue !== '') return [String(singleValue)];
  if (!value) return [];
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  return String(value).split(',').map((entry) => entry.trim()).filter(Boolean);
}

function validateRemoteName(value) {
  const remote = String(value || 'origin');
  if (!/^[A-Za-z0-9][A-Za-z0-9._\/-]*$/.test(remote)) {
    throw new Error(`Invalid Git remote name: ${remote}`);
  }
  return remote;
}

function trimPreview(value, max = 12000) {
  const text = String(value || '');
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n... <truncated ${text.length - max} chars>`;
}

async function status(options = {}) {
  const repo = repoFrom(options);
  const result = await runGit(repo, ['status', '--short', '--branch'], { timeoutMs: 15000 });
  return {
    ok: result.ok,
    repo,
    command: 'git status --short --branch',
    output: result.stdout.trim(),
    error: result.ok ? null : result.error || result.stderr,
  };
}

async function log(options = {}) {
  const repo = repoFrom(options);
  const requested = Number(options.limit ?? 20);
  const limit = Math.max(1, Math.min(Number.isFinite(requested) ? Math.floor(requested) : 20, 200));
  const result = await runGit(repo, [
    'log',
    `-n${limit}`,
    '--date=iso-strict',
    '--pretty=format:%H%x09%ad%x09%an%x09%s',
  ], { timeoutMs: 15000, maxBuffer: 1024 * 1024 * 4 });
  return {
    ok: result.ok,
    repo,
    limit,
    entries: result.ok ? result.stdout.split(/\r?\n/).filter(Boolean).map((line) => {
      const [hash, date, author, ...subjectParts] = line.split('\t');
      return { hash, date, author, subject: subjectParts.join('\t') };
    }) : [],
    error: result.ok ? null : result.error || result.stderr,
  };
}

async function diff(options = {}) {
  const repo = repoFrom(options);
  const staged = truthy(options.staged || options.cached);
  const args = ['diff', '--no-ext-diff', '--no-textconv'];
  if (staged) args.push('--cached');
  if (options.path) args.push('--', String(options.path));
  const result = await runGit(repo, args, { timeoutMs: 20000, maxBuffer: 1024 * 1024 * 8 });
  return {
    ok: result.ok,
    repo,
    staged,
    path: options.path ? String(options.path) : null,
    output: trimPreview(result.stdout, 12000),
    truncated: result.stdout.length > 12000,
    error: result.ok ? null : result.error || result.stderr,
  };
}

async function diffSummary(options = {}) {
  const repo = repoFrom(options);
  const [stat, names, cachedStat, cachedNames] = await Promise.all([
    runGit(repo, ['diff', '--stat'], { timeoutMs: 15000 }),
    runGit(repo, ['diff', '--name-status'], { timeoutMs: 15000 }),
    runGit(repo, ['diff', '--cached', '--stat'], { timeoutMs: 15000 }),
    runGit(repo, ['diff', '--cached', '--name-status'], { timeoutMs: 15000 }),
  ]);

  return {
    ok: stat.ok && names.ok && cachedStat.ok && cachedNames.ok,
    repo,
    unstaged: {
      stat: stat.stdout.trim(),
      changedFiles: names.stdout.trim().split(/\r?\n/).filter(Boolean),
    },
    staged: {
      stat: cachedStat.stdout.trim(),
      changedFiles: cachedNames.stdout.trim().split(/\r?\n/).filter(Boolean),
    },
    error: stat.ok && names.ok && cachedStat.ok && cachedNames.ok
      ? null
      : [stat.error || stat.stderr, names.error || names.stderr, cachedStat.error || cachedStat.stderr, cachedNames.error || cachedNames.stderr].filter(Boolean).join('\n'),
  };
}

function buildGitHelperInvocation({ repo, message, all, paths, push, remote, includeExistingStaged, dryRun }) {
  const config = readJson('config/components.json');
  const script = path.join(config.components.gitHelper, 'scripts', 'git_commit_push.ps1');
  assertPathAllowed(script);
  return {
    script,
    parameters: {
      Message: message,
      RepoRoot: repo,
      Paths: all ? null : paths,
      All: Boolean(all),
      Push: Boolean(push),
      Remote: remote || 'origin',
      IncludeExistingStaged: Boolean(includeExistingStaged),
      DryRun: Boolean(dryRun),
    },
  };
}

async function helperPreview({ repo, message, all, paths, push, remote, includeExistingStaged }) {
  const invocation = buildGitHelperInvocation({
    repo,
    message,
    all,
    paths,
    push,
    remote,
    includeExistingStaged,
    dryRun: true,
  });
  const gitDir = path.dirname(resolveGitExecutable());
  const result = await runPowerShellScript(invocation.script, invocation.parameters, {
    timeoutMs: 30000,
    maxBuffer: 1024 * 1024 * 8,
    env: { PATH: `${gitDir}${path.delimiter}${process.env.PATH || ''}` },
  });
  return {
    ok: result.ok,
    command: 'git-helper scripts/git_commit_push.ps1 -DryRun',
    stdout: trimPreview(result.stdout),
    stderr: trimPreview(result.stderr),
    error: result.ok ? null : result.error || result.stderr,
  };
}

async function helperExecute({ repo, message, all, paths, push, remote, includeExistingStaged }) {
  const currentRepo = assertPathAllowed(repo).canonicalPath;
  if (currentRepo !== repo && !(process.platform === 'win32' && currentRepo.toLowerCase() === repo.toLowerCase())) {
    return { ok: false, command: 'git-helper scripts/git_commit_push.ps1', stdout: '', stderr: '', error: 'Repository canonical path changed after confirmation; request a new dry-run.' };
  }
  const invocation = buildGitHelperInvocation({
    repo,
    message,
    all,
    paths,
    push,
    remote,
    includeExistingStaged,
    dryRun: false,
  });
  const gitDir = path.dirname(resolveGitExecutable());
  const result = await runPowerShellScript(invocation.script, invocation.parameters, {
    timeoutMs: 120000,
    maxBuffer: 1024 * 1024 * 8,
    env: { PATH: `${gitDir}${path.delimiter}${process.env.PATH || ''}` },
  });
  return {
    ok: result.ok,
    command: 'git-helper scripts/git_commit_push.ps1',
    stdout: trimPreview(result.stdout),
    stderr: trimPreview(result.stderr),
    error: result.ok ? null : result.error || result.stderr,
  };
}

function commitPayload(options) {
  const repo = repoFrom(options);
  const message = String(options.message || options.m || '').trim();
  const all = truthy(options.all || options.a);
  const paths = splitPaths(options.paths, options.path ?? options.p ?? null);
  const includeExistingStaged = truthy(options.includeExistingStaged);

  if (!message) throw new Error('Commit message is required. Use --message "...".');
  if (!all && paths.length === 0) throw new Error('Commit target is required. Use --all or --paths file1,file2.');
  if (all && paths.length > 0) throw new Error('Use either --all or --paths, not both.');

  return {
    repo,
    message,
    all,
    paths,
    push: false,
    remote: 'origin',
    includeExistingStaged,
    userExplicitlyRequested: truthy(options.userExplicitlyRequested),
  };
}

async function guardedCommitAction(options = {}) {
  const payload = commitPayload(options);
  const preview = await helperPreview(payload);

  if (!options.confirmToken) {
    return createConfirmation({
      action: 'git.commit',
      impact: 'write',
      summary: `commit ${payload.repo}`,
      payload,
      preview,
      userExplicitlyRequested: payload.userExplicitlyRequested,
    });
  }

  const confirmation = verifyConfirmation({
    action: 'git.commit',
    token: options.confirmToken,
    payload,
    impact: 'write',
    consume: true,
    userExplicitlyRequested: payload.userExplicitlyRequested,
  });
  if (!confirmation.ok) return { ...confirmation, preview };

  const executed = await helperExecute(payload);
  return {
    ok: executed.ok,
    confirmed: true,
    action: 'git.commit',
    repo: payload.repo,
    result: executed,
  };
}

async function push(options = {}) {
  const repo = repoFrom(options);
  const remote = validateRemoteName(options.remote || 'origin');
  const branchResult = await runGit(repo, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { timeoutMs: 15000 });
  const branch = branchResult.stdout.trim();
  if (!branchResult.ok || !branch) {
    return { ok: false, repo, error: branchResult.error || branchResult.stderr || 'Detached HEAD is not supported.' };
  }

  const preview = await Promise.all([
    runGit(repo, ['status', '--short', '--branch'], { timeoutMs: 15000 }),
    runGit(repo, ['remote', 'get-url', remote], { timeoutMs: 15000 }),
  ]).then(([statusResult, remoteResult]) => ({
    ok: statusResult.ok && remoteResult.ok,
    command: `git push ${remote} ${branch}`,
    branch,
    remote,
    remoteUrlAvailable: remoteResult.ok,
    status: trimPreview(statusResult.stdout || statusResult.stderr),
    error: statusResult.ok && remoteResult.ok ? null : [statusResult.error || statusResult.stderr, remoteResult.error || remoteResult.stderr].filter(Boolean).join('\n'),
  }));

  const payload = { repo, remote, branch, userExplicitlyRequested: truthy(options.userExplicitlyRequested) };
  if (!options.confirmToken) {
    return createConfirmation({
      action: 'git.push',
      impact: 'external',
      summary: `Push ${repo} ${branch} to ${remote}`,
      payload,
      preview,
      userExplicitlyRequested: payload.userExplicitlyRequested,
    });
  }

  const confirmation = verifyConfirmation({
    action: 'git.push',
    token: options.confirmToken,
    payload,
    impact: 'external',
    consume: true,
    userExplicitlyRequested: payload.userExplicitlyRequested,
  });
  if (!confirmation.ok) return { ...confirmation, preview };

  const currentRepo = assertPathAllowed(repo).canonicalPath;
  if (currentRepo !== repo && !(process.platform === 'win32' && currentRepo.toLowerCase() === repo.toLowerCase())) {
    return { ok: false, confirmed: true, action: 'git.push', repo, branch, remote, error: 'Repository canonical path changed after confirmation; request a new dry-run.' };
  }
  const result = await runGit(currentRepo, ['push', remote, branch], { timeoutMs: 120000, maxBuffer: 1024 * 1024 * 8 });
  return {
    ok: result.ok,
    confirmed: true,
    action: 'git.push',
    repo,
    branch,
    remote,
    result: {
      stdout: trimPreview(result.stdout),
      stderr: trimPreview(result.stderr),
      error: result.ok ? null : result.error || result.stderr,
    },
  };
}

module.exports = {
  status,
  log,
  diff,
  diffSummary,
  commit: (options) => guardedCommitAction(options),
  push,
};
