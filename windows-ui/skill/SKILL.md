---
name: windows-ui
description: "Inspect and operate Windows desktop UI controls through AgentTools Windows UI Automation. Use when the user asks to inspect a local app window/dialog, list UI controls, find a button by name/AutomationId, or explicitly press a Windows UI button without coordinate clicking. Canonical root: <AgentToolsRoot>\\windows-ui."
---

# Windows UI Automation

Canonical root: `<AgentToolsRoot>\windows-ui`.

Use this skill for local Windows UI Automation tasks such as inspecting a modal dialog, discovering accessible controls, or explicitly invoking a named button.

## Preferred workflow

1. Build once if `bin\Release\net10.0-windows\AgentTools.WindowsUi.dll` is absent:
   `<AgentToolsRoot>\windows-ui\Build-WindowsUi.bat`
2. Inspect matching windows first:
   `WindowsUi.bat windows --process <Process.exe> [--title <pattern>]`
3. Inspect the relevant UIA tree or use `find`:
   `WindowsUi.bat tree --process <Process.exe> --window <title-pattern>`
   `WindowsUi.bat find --process <Process.exe> --window <title-pattern> --controlType Button --name <button>`
4. For a requested button action, run `invoke` without `--execute` first and inspect the dry-run target.
5. Only when the user explicitly authorized that concrete UI action, repeat the exact selector with `--execute`.

## Safety rules

- Prefer UI Automation `InvokePattern` over coordinate clicking.
- Do not use `--execute` merely to test whether a selector works; dry-run is sufficient.
- Actual invoke requires an explicit target process and window title, plus a control name or AutomationId.
- If more than one window/control matches, narrow the selector rather than guessing.
- Never substitute destructive-looking buttons (`Delete`, `Don't Save`, overwrite confirmations, uninstall, reset, etc.) unless the user's request clearly authorizes that exact effect.
- The helper does not provide arbitrary keyboard/mouse input or privilege elevation.

## Unity dialogs

Unity modal dialogs can be exposed as child `ControlType.Window` nodes beneath the main editor window. The helper searches child windows when `--process` is supplied, so use the dialog title directly, for example:

`WindowsUi.bat find --process Unity.exe --window "Scene(s) Have Been Modified" --controlType Button --name Save`

Then dry-run:

`WindowsUi.bat invoke --process Unity.exe --window "Scene(s) Have Been Modified" --controlType Button --name Save`

Only add `--execute` when the user has explicitly asked to press that button.
