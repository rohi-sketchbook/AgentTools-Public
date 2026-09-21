---
name: blender-mcp
description: "Operate Blender through BlenderMCP for scene inspection/editing, rendering, asset work, and BlenderMCP start/stop/restart. Shared root: <AgentToolsRoot>\\blender-mcp; endpoint: 127.0.0.1:9876."
---

# BlenderMCP

Use this as the shared Blender automation tool across projects.

## Shared root

<AgentToolsRoot>\blender-mcp

Default endpoint: 127.0.0.1:9876.

## Management

Check status before Blender operations:
<AgentToolsRoot>\blender-mcp\Status-BlenderMCP.bat

Start: <AgentToolsRoot>\blender-mcp\Start-BlenderMCP.bat
Restart: <AgentToolsRoot>\blender-mcp\Restart-BlenderMCP.bat
Stop: <AgentToolsRoot>\blender-mcp\Stop-BlenderMCP.bat

Texture import:
<AgentToolsRoot>\blender-mcp\Import-BlenderTexture.bat

Select the project containing the texture with AGENTTOOLS_WORKSPACE_ROOT or the PowerShell -WorkspaceRoot parameter. Texture imports must stay inside that workspace.

Never use -Force for stop/restart unless the user explicitly accepts discarding unsaved Blender changes.
The Blender executable is discovered automatically. Prefer BLENDER_EXE or explicit -BlenderPath when a specific Blender installation is required.

## Project separation

BlenderMCP is a shared Agent Tool. Production assets remain in the calling project's own directory; do not move them into the shared AgentTools checkout.

## Scene authoring / modification contract

When the task creates, modifies, validates, or exports Blender scene content, read the relevant shared runbooks before claiming completion. Keep Astra/project profiles small; do not copy these documents into `.devspace/agents/astra.md`.

Always read for scene creation or modification:
- `references/blender_agent_general.md`

Read before final validation / delivery of a created or materially modified scene:
- `references/blender_validation_views.md`

Read when the intended target includes Unity, VR Avatar Studio, VBG, FBX/GLB export, or collision/lightmap migration:
- `references/blender_unity_vbg_export.md`

Read only for Crystal Runway Studio tasks:
- `references/blender_crystal_runway_studio.md`

The canonical editable sources are under `<AgentToolsRoot>\docs\agent-guides\` and sync via `install-agenttools-skills.ps1`.

GPT-5.6 Sol host only: for substantial modeling supervision read `references/blender_sol_supervision.md`; Astra must not read it.

The required production loop is `build -> preview render -> inspect the actual render -> self-critique -> fix major issues -> re-render -> export/report`. Beauty-only validation is insufficient for substantial modeling work.

When DevSpace image inspection is available, use rendered review images as evidence instead of merely checking that files exist. A generated `.blend` or FBX is not by itself proof of completion.
