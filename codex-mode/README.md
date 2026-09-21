# Codex Mode Agent Tool

Canonical root: `<AgentToolsRoot>\codex-mode`

Switches the local Codex App between the user's ChatGPT-backed profile and LM Studio without replacing the entire Codex-generated `config.toml`.

The tool edits only these controlled top-level keys:

- `model`
- `model_provider`
- `model_context_window`
- `model_verbosity`
- `model_reasoning_effort`

It also owns only the `[model_providers.local_lmstudio]` table. Other Codex App settings are preserved.

Before switching to LM Studio, the current ChatGPT controlled settings are saved under `%USERPROFILE%\.codex\mode-switch-state\chatgpt-profile.json`. Switching back restores that saved profile, avoiding stale hard-coded Codex runtime/browser paths.

Every actual switch backs up `config.toml` under `%USERPROFILE%\.codex\mode-switch-backups\` and writes the new config atomically.

Commands:

- `Switch-To-LMStudio.bat`
- `Switch-To-ChatGPT.bat`

Use `-DryRun` to preview without changing config, starting LM Studio, or restarting Codex. Use `-NoRestart` to change the config without restarting Codex App.
