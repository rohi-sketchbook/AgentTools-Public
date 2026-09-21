---
name: git-helper
description: Use the shared guarded Git helper for explicit commit preparation, commits, or user-authorized pushes across local repositories. Use when the user asks to commit selected paths, commit all current changes, inspect a commit dry-run, or push a committed branch. Push remains an external action and requires explicit user authorization.
---

# Git Helper

Canonical root: `<AgentToolsRoot>\git-helper`.

Use `scripts\git_commit_push.ps1` or `Git-CommitPush.bat`.

Always identify the target repository explicitly through `-RepoRoot` or `AGENTTOOLS_WORKSPACE_ROOT` when there is any ambiguity.

The helper supports `-All` or `-Paths`, optional `-DryRun`, and optional `-Push`.

For commits in the canonical AgentTools repository, the helper automatically synchronizes only shared Skill source files that are part of the new commit into the user's global `.agents\skills` directory. Do not ask the user to run `install-agenttools-skills.ps1` after an ordinary committed Skill update unless the helper reports that auto-sync failed. Initial setup and full repair remain manual installer cases.

Do not use `-Push` unless the user explicitly requested a push in the current request. Never force-push. Do not silently include pre-existing staged changes; the helper rejects them unless `-IncludeExistingStaged` is explicitly supplied.
