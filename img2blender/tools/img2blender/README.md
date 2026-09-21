# img2blender backend prototype

Canonical location: `<AgentToolsRoot>\img2blender\tools\img2blender`

This directory contains Blender-specific experimental code. It does not modify img2threejs upstream.

## Current support

- PNG baseline probe: 8-bit, non-interlaced PNG.
- Background-oriented `SceneSpec` 0.1 template.
- Ordered build-pass metadata.
- Blender Python generation for:
  - cube
  - plane
  - sphere / ellipsoid
  - cylinder
  - cone
- Basic Principled BSDF materials.
- World background configuration.
- Perspective camera creation and target tracking.
- Source provenance custom properties on generated Blender objects.
- BlenderMCP TCP availability probe.

Unsupported primitives fail explicitly. There is no silent geometry fallback.

## Commands

From a project/lab root, pass project-relative input/output paths to the shared tool:

```text
python -B <AgentToolsRoot>\img2blender\tools\img2blender\pipeline.py probe references\reference.png
python -B <AgentToolsRoot>\img2blender\tools\img2blender\pipeline.py init-spec references\reference.png output\specs\blockout.scene.json
python -B <AgentToolsRoot>\img2blender\tools\img2blender\pipeline.py validate output\specs\blockout.scene.json
python -B <AgentToolsRoot>\img2blender\tools\img2blender\pipeline.py generate output\specs\blockout.scene.json output\specs\blockout.blender.py
python -B <AgentToolsRoot>\img2blender\tools\img2blender\probe_blender_mcp.py
```

Unit tests from the AgentTools root:

```text
python -B -m unittest discover -s img2blender\tools\img2blender\tests -v
```

The generated Blender script can be executed with Blender 5.2 LTS using `--background --python <script>` or sent through a future BlenderMCP execution adapter.

## Important limitation

`init-spec` only creates a deterministic starter template from image metadata. It does not perform semantic scene analysis. Agent vision must replace the placeholder camera, road, building mass, dimensions, materials, and inventory with reference-grounded values before a blockout can be approved.
