# BlenderMCP Agent Tool

Canonical root: <AgentToolsRoot>\blender-mcp

Default endpoint: 127.0.0.1:9876

Management entry points:
- Start-BlenderMCP.bat
- Stop-BlenderMCP.bat
- Restart-BlenderMCP.bat
- Status-BlenderMCP.bat
- scripts\Manage-BlenderMCP.ps1
- Import-BlenderTexture.bat
- scripts\Import-BlenderTexture.ps1

`Import-BlenderTexture` imports an image from the selected project workspace into Blender through BlenderMCP and applies an appropriate sRGB/Non-Color setting based on `TextureKind`.

This is the shared BlenderMCP management root for ChatGPT, DevSpace, and Agents across projects.
Stop/restart refuses unsaved Blender changes by default. Use -Force only when discarding unsaved changes was explicitly requested.

## Scene production rules

The `blender-mcp` shared Skill routes scene creation/modification work to the Blender runbooks under `<AgentToolsRoot>\docs\agent-guides\`:

- `blender_agent_general.md`
- `blender_validation_views.md`
- `blender_sol_supervision.md`（Sol専用。Astraへ全文投入しない）
- `blender_unity_vbg_export.md`
- `blender_crystal_runway_studio.md`

`install-agenttools-skills.ps1 -OnlySkill blender-mcp` deploys these runbooks as Skill references without duplicating them into each project profile. `blender_sol_supervision.md` is reserved for the ChatGPT/Sol host; Astra should receive only the compressed repair tickets produced from it.
