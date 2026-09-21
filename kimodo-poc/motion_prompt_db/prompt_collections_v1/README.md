# Prompt Collections v1 — 5 genres × 200 prompts

This directory contains the first large prompt collection for VR Avatar Studio's Japanese→Qwen→Adapter→Kimodo motion pipeline.

## Size

`catalog.py` exposes exactly **1,000 normalized prompt records** through `PROMPTS` and `BY_GENRE`.

| Genre | Count | Main use |
|---|---:|---|
| `glamour_editorial` | 200 | adult glamour/editorial still poses; mostly Pose Library candidates |
| `idol_cute` | 200 | adult idol/photo/fan-service gestures; exact fingers may need Hand Layer |
| `runway_fashion` | 200 | catwalk, controlled stride, turn, stop, garment-presenting motion |
| `dynamic_cute_dance` | 200 | short cute choreography, bounce, step, wave, turn, pose changes |
| `bold_sensual` | 200 | adult-only high-intensity, non-explicit glamour/editorial poses |

All records use `subject_age_scope="adult"`.

## Why this is programmatic instead of a 1,000-line hand-maintained TSV

The source vocabulary is factored into physical components and combined deterministically. This makes it possible to:

- expand one semantic axis without manually rewriting hundreds of rows;
- keep stable IDs (`GE001`, `IC001`, `RF001`, `DC001`, `BS001`, ...);
- guarantee exactly 200 prompts per genre;
- track intensity and routing policy consistently;
- regenerate distillation/capability data from the same source of truth;
- distinguish source-discovered vocabulary from independently composed prompts.

`composition="derived"` means the final sentence was composed locally from normalized short vocabulary. It is **not** a copied third-party prompt.

## Record fields

- `id`
- `genre`
- `ja_prompt`
- `canonical_en`
- `intensity` — 1..5
- `motion_type`
- `route_hint` — `direct`, `pose_library`, or `hand_layer`
- `source_group`
- `source_ids`
- `composition`
- `subject_age_scope`
- `adult_glamour`
- `hand_pose_critical`

## Intensity

- `1`: subtle / low-energy
- `2`: normal
- `3`: strong / stylized
- `4`: bold
- `5`: very bold / high-intensity adult glamour

The catalog deliberately contains substantial intensity-4/5 coverage. `bold_sensual` is always intensity 4 or 5 and adult-only, while remaining non-explicit and pose-focused.

## Routing policy

The AI motion feature always produces a **single VAC**. Routing only chooses how that VAC is constructed.

- `direct`: Kimodo generates the body motion directly. Ordered multi-stage prompts remain one VAC and may have lower temporal precision.
- `pose_library`: exact still-photo pose is better represented as a reusable pose asset and baked into the resulting VAC where applicable.
- `hand_layer`: body/arm placement can come from Kimodo/Pose Library, while exact finger geometry is supplied by the dedicated hand-pose layer and baked into the VAC.

`motion_type="sequence"` remains only as a difficulty signal. The AI motion feature still creates exactly one VAC.

## Source provenance

See `../SOURCES.md`. Image-generation sources are used primarily to discover photogenic body-placement vocabulary; Runway/Veo and runway-modeling sources are used to structure motion, direction, speed, timing and sequence semantics.

## Validation

Run:

```powershell
.venv-kimodo\Scripts\python.exe motion_prompt_db\prompt_collections_v1\catalog.py
```

Validation checks:

- total = 1000
- every genre = 200
- stable IDs unique
- all subjects explicitly scoped to adults
- intensity range is valid
- `bold_sensual` is only intensity 4/5
- ambiguous/minor-age or explicit-content scope terms are absent from prompt text
