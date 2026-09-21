# Upstream adaptation notes

Upstream repository: https://github.com/img2threejs/img2threejs
Observed checkout on 2026-09-03: `d6673386f89673a58736f8d398dd16ece67874f5`
Declared local product version (`SKILL.md` / README badge): `1.4.4`
Git revision identifier: `v1.4.3-4-gd667338`
HEAD subject: `v1.5 beta — character track, material pipeline, and a release path that actually runs (#75)`

AgentTools treats the explicit `SKILL.md` version as the installed/version-inventory value. Do not infer an installed release from a Git commit subject; `v1.5 beta` is only a commit description here because this checkout has no corresponding v1.5 tag/version declaration.

## Current upstream workflow changes

- Upstream work is now explicitly resumable and state-driven through `.img2threejs/state.json`.
- At fresh start/resume and before every correction loop, run `forge/next.py --state .img2threejs/state.json [<spec>]`; the reported next action and hard-stop state are authoritative.
- Initialize state with `forge/state.py init --reference <image> --profile <generic|character|cs2> [--spec <spec>]`.
- `generic`, `character`, and `cs2` profiles now insert profile-specific intake/evidence gates.
- Upstream review is increasingly multi-pass and evidence-based: render profile, region comparisons, material evidence, camera fit, silhouette/geometry integrity, and turntable/multi-angle checks are separate concerns.
- Character work now includes humanoid proportion checks, rig payload generation/validation, morph-target support, and geodesic skinning concepts.
- New reconstruction concepts worth evaluating for Blender adaptation include camera fitting, visual hull, subdivision, UV unwrap/decimation, self-intersection, pairwise penetration, mesh-reference comparison, and material-region analysis.

These upstream workflow rules are reference guidance only. They do not replace img2blender's current `pipeline.py` commands, `SceneSpec`, pass state, or review-action vocabulary unless explicitly ported into the Blender backend.

## Concepts to preserve

- Deterministic scripts enforce pipeline state; agent vision judges visual fidelity.
- Persist workflow/checklist state outside conversation memory and make the next action machine-readable.
- Start from a reference suitability/intake step.
- Build a structured spec before geometry generation.
- Lock build passes in order.
- Require real render evidence before `continue`.
- Keep one explicit next action after each review.
- Preserve transparent evidence, confidence, and unresolved differences.
- Avoid pretending that a single view reveals hidden geometry.

## Blender adaptation

Upstream `ObjectSculptSpec` and `generate_threejs_factory.py` are reference designs, not runtime dependencies for the Blender backend.

Initial Blender action mapping:

- `box` -> cube
- `sphere`, `ellipsoid` -> UV sphere + scale
- `cylinder` -> cylinder
- `cone` -> cone
- `tube`, `curve-sweep` -> curve + bevel
- `lathe` -> screw/spin/profile revolution
- `extrude` -> mesh/curve extrusion
- `plane-card` -> plane
- `instanced-cluster` -> linked mesh, collection instance, or Geometry Nodes

The first implementation only supports cube, plane, sphere/ellipsoid, cylinder, and cone. Unsupported primitives must fail explicitly rather than silently falling back.

## SceneSpec direction

The initial schema is background-oriented and keeps these explicit sections:

- camera
- world
- road
- sidewalk
- buildings
- facade_modules
- windows
- signs
- street_lights
- traffic_lights
- poles
- guardrails
- road_markings
- puddles
- props
- vegetation
- materials
- emissive_sources
- reflection_targets
- atmosphere

Every generated element should eventually carry transform, material, confidence, reference region, and build pass provenance.

## Review action vocabulary

For img2blender use:

`continue | refine-spec | refine-blender | request-input | stop`

`refine-blender` is the Blender-backend equivalent of upstream `refine-code`.
