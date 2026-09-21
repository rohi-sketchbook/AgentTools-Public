# Git Helper Agent Tool

Canonical root: `<AgentToolsRoot>\git-helper`

`Git-CommitPush.bat` and `scripts\git_commit_push.ps1` provide guarded commit/push operations for any local Git repository.

Repository root resolution order:

1. `-RepoRoot`
2. `AGENTTOOLS_WORKSPACE_ROOT`
3. Current working directory

The helper refuses detached HEAD, merge/rebase/cherry-pick/revert in-progress states, and pre-existing staged changes unless `-IncludeExistingStaged` is explicitly supplied. It pushes only when `-Push` is explicitly supplied and never force-pushes.

When the target repository is the canonical AgentTools checkout, a successful commit is passed to `install-agenttools-skills.ps1 -AutoSyncCommit <commit>`. The installer uses its own Skill registry as the source of truth and synchronizes only registered Skill files included in that commit to the user's global `.agents\skills` directory. Unrelated or uncommitted Skill sources are not synchronized. Auto-sync failure is reported as a warning and does not rewrite Git history or cancel an already-created commit.

Use `-DryRun` to inspect the planned add/commit/push commands without changing Git state.
