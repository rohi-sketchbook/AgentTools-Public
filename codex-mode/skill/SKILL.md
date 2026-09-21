---
name: codex-mode
description: Manage the user's explicit local Codex App mode switch between their ChatGPT-backed configuration and LM Studio local-model configuration. Use only when the user asks to switch Codex to LM Studio/local LLM or back to ChatGPT, or asks to inspect that switch with a dry-run. This changes local Codex configuration and may restart Codex App.
---

# Codex Mode

Canonical root: `<AgentToolsRoot>\codex-mode`.

Commands:

- `Switch-To-LMStudio.bat`
- `Switch-To-ChatGPT.bat`

Use this tool only for an explicit mode-switch request. An actual switch changes `%USERPROFILE%\.codex\config.toml` and normally restarts Codex App.

The implementation preserves unrelated Codex settings and changes only the owned model keys plus the `model_providers.local_lmstudio` table. It backs up the current config before writing and restores the previously saved ChatGPT model profile when switching back from LM Studio.

Prefer `-DryRun` when inspecting behavior. Do not use an actual switch merely to test the tool. `-NoRestart` is available when the user explicitly wants the configuration changed without restarting Codex.
