# AgentTools Windows UI Automation

`<AgentToolsRoot>\windows-ui` is a small Windows-only UI Automation helper for inspecting windows and invoking UIA controls without coordinate-based mouse clicks.

It uses the built-in Windows UI Automation API (`System.Windows.Automation`) and has no third-party package dependency.

## Build

```bat
Build-WindowsUi.bat
```

Requires the .NET 10 SDK/runtime already installed on this workstation.

## Commands

```bat
WindowsUi.bat windows --process Unity.exe
WindowsUi.bat windows --process Unity.exe --title "Scene(s) Have Been Modified"
WindowsUi.bat tree --process Unity.exe --window "Scene(s) Have Been Modified" --depth 6
WindowsUi.bat find --process Unity.exe --window "Scene(s) Have Been Modified" --controlType Button --name Save
WindowsUi.bat invoke --process Unity.exe --window "Scene(s) Have Been Modified" --controlType Button --name Save
```

`invoke` is **dry-run by default**. It only performs the UI action when `--execute` is explicitly supplied:

```bat
WindowsUi.bat invoke --process Unity.exe --window "Scene(s) Have Been Modified" --controlType Button --name Save --execute
```

For an actual invoke, both `--process` and `--window` are mandatory, and either `--name` or `--automationId` must identify the control. The helper refuses to invoke if the window or control selector matches more than one element, if the control is disabled, or if it does not expose `InvokePattern`.

Wildcard matching with `*` and `?` is supported for window titles, names, and automation IDs.

## Test

The regression test launches a temporary WinForms window, verifies dry-run does not click it, then performs a real UIA `InvokePattern.Invoke` against the harmless `Test Invoke` button and checks a temporary marker file:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tests\Test-WindowsUi.ps1
```

## Safety model

- `windows`, `tree`, and `find` are read-only.
- `invoke` defaults to dry-run.
- No arbitrary command execution, mouse coordinates, keystrokes, or fallback `SendInput` are included.
- Actual UI mutation requires `--execute` in the standalone helper.
- The AgentTools MCP Gateway adapter additionally uses its existing confirmation-token and mutation-policy flow.
- The helper does not elevate privileges. Windows integrity/UIPI boundaries still apply.

## Unity note

Unity native modal dialogs such as `Scene(s) Have Been Modified` appear as child `ControlType.Window` elements beneath the Unity editor window. When a process filter is supplied, this helper searches those child windows as well, so the modal title itself can be used in `--window`.
