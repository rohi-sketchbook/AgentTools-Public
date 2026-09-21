---
name: xr-automation
description: 'Operate and diagnose shared XR automation for Meta Quest/OpenXR development. Use when the user asks DevSpace to operate a Quest device, capture XR output, use Meta VR CLI, inspect Unity MCPBridge connectivity, or check the XR automation toolchain. Canonical root: <AgentToolsRoot>\xr-automation.'
---

# XR Automation

Use this shared tool for project-independent XR automation. Keep application code and Unity packages in each production project; keep host-side wrappers, diagnostics, and reusable QA workflows here.

## Shared root

`<AgentToolsRoot>\xr-automation`

## Start with status

Before XR automation work, run:

```text
<AgentToolsRoot>\xr-automation\Status-XRAutomation.bat
```

This status command is local/read-only and does not download packages or start a background service.

## Meta VR CLI

Canonical wrapper:

```text
<AgentToolsRoot>\xr-automation\MetaVR.bat <args>
```

Examples:

```text
MetaVR.bat --version
MetaVR.bat device list
MetaVR.bat app list
MetaVR.bat capture screenshot -o <path>
```

The wrapper uses Meta's recommended on-demand `npx -y metavr` flow. First use may populate the npm cache. Do not log into a Meta account, change Developer Mode, authorize USB debugging, create tokens, or change external account settings without explicit user approval.

Meta VR CLI is for Quest device management, app lifecycle, capture, logs, documentation search, and performance tooling.

## Unity MCPBridge

`XRAutomation.bat` exposes narrow Unity MCPBridge helpers independent from the retired Meta-specific project integration:

```text
XRAutomation.bat mcpbridge-status -ProjectRoot <project-root>
XRAutomation.bat mcpbridge-tools -ProjectRoot <project-root>
XRAutomation.bat mcpbridge-menu -ProjectRoot <project-root> -MenuPath <menu-path>
XRAutomation.bat mcpbridge-call -ProjectRoot <project-root> -ToolName <tool> -MethodName <method> -ArgumentsJson <json>
```

Do not expose MCPBridge discovery bearer tokens in chat or logs. Prefer the narrow helper actions instead of an unrestricted proxy.

## VR Avatar Studio policy

VR Avatar Studio's PCVR baseline is Unity OpenXR + XR Interaction Toolkit.

Meta XR Core SDK is not adopted and must not be automatically installed, required, or recommended for VR Avatar Studio. Meta XR Operator was retired on 2026-09-04 after a severe Windows Process handle leak was reproduced with Meta XR Core SDK 205.0.0 / `OVRPlugin.dll` in both the Unity Editor process and AssetImportWorker.

Do not reintroduce the retired stack merely because an old PoC succeeded. Any future reconsideration must be a separate task that first verifies an upstream fix and includes at least 60 seconds of Process handle monitoring plus Editor idle CPU, AssetImportWorker, and RAM checks.

Meta XR Simulator 2 was part of that historical PoC and is not a current VR Avatar Studio automation requirement.

## DevSpace integration boundary

Prefer explicit XR operations over a generic unrestricted external-MCP proxy. Keep Meta VR CLI and Unity MCPBridge connections on-demand and scoped to the active task.

Do not add a polling daemon, watchdog, or always-on MCP process for this tool.

## Safety

- Device app uninstall, data clear, file delete, device configuration changes, and other destructive actions require explicit user authorization.
- Installing/launching a user-requested test build is allowed only when the requested workflow clearly requires it; do not silently replace production/device data.
- Do not expose tokens, cookies, Meta credentials, or developer secrets in source, logs, README files, or chat.
- Do not push commits or publish builds unless the user explicitly asks.
