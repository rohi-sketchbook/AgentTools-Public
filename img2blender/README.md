# img2blender Agent Tool

Canonical root: `<AgentToolsRoot>\img2blender`

Shared experimental Agent Tool for adapting the staged, quality-gated workflow of img2threejs to Blender.

## Layout

- `tools/img2threejs/`: upstream checkout. Keep upstream changes isolated.
- `tools/img2blender/`: Blender-specific backend/adapter.

Project-specific assets do **not** live here. Reference images, generated specs, renders, comparisons, logs, and `.blend` files remain in the calling project, e.g. `<WorkspaceRoot>\backgrounds\img2blender-lab`.

## Upstream

Repository: `https://github.com/img2threejs/img2threejs.git`

### Version interpretation

Observed upstream checkout on 2026-09-03:

- HEAD: `d6673386f89673a58736f8d398dd16ece67874f5`
- `SKILL.md` declared version: `1.4.4`
- README badge version: `1.4.4`
- nearest Git tag / describe: `v1.4.3-4-gd667338`
- HEAD commit subject: `v1.5 beta — character track, material pipeline, and a release path that actually runs (#75)`

For AgentTools inventory and update checks, the canonical local product version is the explicit `SKILL.md` version (`1.4.4`). Git tags/`git describe` are revision identifiers, and a commit subject such as `v1.5 beta` must not be treated as a released or installed version unless the upstream project also declares that version in its version metadata/release/tag.

Run `bootstrap_img2threejs.cmd` to create the upstream checkout under `tools\img2threejs`.

For direct upstream img2threejs work, the current workflow is state-driven and resumable. Initialize `.img2threejs/state.json` with `forge/state.py`, then run `forge/next.py --state .img2threejs/state.json` at every start/resume and before correction iterations. The upstream state/checklist is authoritative; do not continue from conversational memory. Profiles are `generic`, `character`, and `cs2`, and each profile inserts its own required intake/evidence gates.

This does **not** change the current img2blender CLI. img2blender keeps its own Blender-oriented `SceneSpec`, pass order, and review action vocabulary while selectively adapting useful upstream concepts.

## Current backend

The shared backend currently provides:

- baseline PNG validation,
- background-oriented `SceneSpec`,
- locked sequential build passes,
- pass-gated Blender Python generation,
- reference/render comparison-sheet generation,
- review actions: `continue | refine-spec | refine-blender | request-input | stop`,
- evidence gating before `continue` (render + comparison + agent vision score),
- BlenderMCP availability probing.

## Lab example

From `<WorkspaceRoot>\backgrounds\img2blender-lab`:

```text
python -B <AgentToolsRoot>\img2blender\tools\img2blender\pipeline.py probe references\reference.png
python -B <AgentToolsRoot>\img2blender\tools\img2blender\pipeline.py init-spec references\reference.png output\specs\blockout.scene.json
python -B <AgentToolsRoot>\img2blender\tools\img2blender\pipeline.py status output\specs\blockout.scene.json
python -B <AgentToolsRoot>\img2blender\tools\img2blender\pipeline.py generate output\specs\blockout.scene.json output\specs\blockout.blender.py
python -B <AgentToolsRoot>\img2blender\tools\img2blender\pipeline.py compare references\reference.png output\renders\blockout.png output\comparisons\blockout.png
python -B <AgentToolsRoot>\img2blender\tools\img2blender\probe_blender_mcp.py
```

After agent vision review, record exactly one decision with the `review` subcommand. A visual pass cannot be credited with `continue` without render evidence, a comparison image, and a score at or above the configured threshold.

Run backend tests with:

```text
python -B -m unittest discover -s tools\img2blender\tests -v
```

Run the upstream suite in Windows UTF-8 mode with `run_upstream_tests.cmd`. The current upstream test analysis is recorded in `UPSTREAM_TEST_STATUS_2026-08-21.md`; security-review findings are in `SECURITY_REVIEW_2026-07-26.md`.

The upstream project remains a reference implementation for pipeline concepts. Blender-specific changes belong in `tools\img2blender`, not the upstream checkout.
