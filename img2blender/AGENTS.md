# img2blender shared Agent Tool

Canonical root: `<AgentToolsRoot>\img2blender`

Use this shared tool for image-reference-driven Blender reconstruction experiments and for adapting img2threejs pipeline concepts to Blender.

## Ownership boundaries

- Shared implementation code: this AgentTool root.
- img2threejs upstream checkout: `tools\img2threejs`.
- Blender-specific backend: `tools\img2blender`.
- Project reference images, generated specs, renders, comparison sheets, logs, and `.blend` files: keep in the calling project/workspace.

Do not copy reusable backend implementation back into individual background projects.
Do not patch img2threejs upstream unless the task explicitly requires an upstream experiment.
Unsupported geometry should fail explicitly rather than silently falling back.

Default BlenderMCP endpoint: `127.0.0.1:9876`.
Use the shared `<AgentToolsRoot>\blender-mcp` AgentTool for BlenderMCP lifecycle management.

Primary review actions:

`continue | refine-spec | refine-blender | request-input | stop`
