# Motion Prompt Vocabulary DB / Kimodo Capability Set

Purpose: build a reusable Japanese↔canonical-English motion vocabulary for VR Avatar Studio's AI motion pipeline, and separate **language understanding** from **motion-model capability**.

## Current contents

Large prompt collection v1: **1,000 prompts** (`prompt_collections_v1/catalog.py`)

- `glamour_editorial`: 200
- `idol_cute`: 200
- `runway_fashion`: 200
- `dynamic_cute_dance`: 200
- `bold_sensual`: 200 adult-only, intensity 4/5, non-explicit

Vocabulary seed: **234 entries total**

- **214 body-motion entries** are candidates for Kimodo / Pose Library / Hand Layer processing, with the AI motion feature always producing one VAC.
- **20 camera entries** live in `camera_video.tsv` and must not enter the Kimodo motion embedding.
- `poses_general.tsv` — standing / seated / floor / weight-shift / torso / arm pose vocabulary
- `idol_gestures.tsv` — peace sign / heart / finger heart / cheek / cat / wave / salute / curtsy etc.
- `glamour_editorial.tsv` — non-explicit **adult-only** glamour/editorial pose vocabulary
- `runway_fashion.tsv` — runway walk / pivot / model pose / garment-reveal motion vocabulary
- `idol_motion.tsv` — cute/idol step, bounce, turn, wave, clap, pose-change vocabulary
- `head_locomotion_style.tsv` — head motion, basic locomotion, motion-style modifiers
- `body_primitives.tsv` — empirically promoted torso / arm / transition primitives that passed Kimodo capability review
- `camera_video.tsv` — camera vocabulary from video-prompt practice; not Kimodo motion targets

Kimodo capability set: **100 prompts**

- `capability_glamour_25.tsv`
- `capability_idol_25.tsv`
- `capability_runway_25.tsv`
- `capability_dynamic_25.tsv`

Capability DB foundation:

- `capability_manifest.json` — tracked counts and file map for the capability DB.
- `capability_taxonomy.json` — model-claimed training domains, style modifiers, routing labels, support labels, and risk flags.
- `capability_observations.tsv` — VR Avatar Studio use-case-specific human review results. Model claims and local tested support are intentionally separate.
- `semantic_gap_candidates.tsv` — concepts missing from the current body-motion seed. These are **candidates**, not training vocabulary yet.
- `validate_capability_db.py` — validates IDs, routes, support labels, risk flags, capability references, current counts, promoted-anchor paraphrases, and the runtime motion-category index.
- `../adapter/motion_category_index.json` — reviewed/current vocabulary concepts exposed to the Desktop category-hint UI. Motion-style-only vocabulary is excluded from nearest-concept search.

Current gap queue: **61 concepts** (`high=0`, `medium=52`, `low=9`). The initial high-priority queue is fully resolved: useful concepts were promoted or merged into existing vocabulary, while reviewed model-capability gaps were retained at medium priority. The body-motion vocabulary grew from 194 to **214** semantic anchors. Canonical wording changes materially improved ambiguous cases such as `stand -> kneel` and `step -> 180-degree turn`, demonstrating that prompt semantics must be tuned separately from model capability. Promotion is driven by measured semantic gaps rather than a target vocabulary count.

## Intended pipeline

```text
AI image/video prompt corpora and photography/fashion terminology
        ↓ normalize
Motion Prompt DB
        ↓
canonical physical action / pose semantics
        ├── Japanese paraphrase generation → Qwen distillation data
        ├── English canonical phrase → LLM2Vec teacher embedding
        └── Kimodo capability benchmark
```

This is **not** intended to become a dictionary in which every possible Japanese sentence is memorized. The DB provides semantic anchors and diverse paraphrase targets so the Qwen→Adapter mapping learns a robust translation into Kimodo's LLM2Vec space.

Do not grow the 1,000-prompt collection merely to reach a larger count. First measure capability, identify uncovered physical-action concepts, promote only useful gap candidates into the base vocabulary, and then regenerate paraphrases/compositions around the expanded semantic anchors.

The Desktop AI-motion UI exposes only coarse category hints (`locomotion`, `gesture`, `dance`, `posture_transition`, `everyday_activity`, `object_interaction`, `stunt_athletic`) instead of hundreds of concept buttons. An explicit hint restricts nearest-concept lookup; it does not replace the free-form Japanese prompt. Auto mode performs no category blend and preserves the normal routing path.

## Row design

Each vocabulary partition contains some subset of:

- `id` — stable internal identifier
- `ja` — normalized Japanese motion phrase
- `canonical_en` — compact English physical-motion phrase
- `temporal` — `static`, `short_action`, `continuous`, `sequence`, or `modifier`
- `sources` — source-family identifiers documented in `SOURCES.md`
- `adult_subject_only` — true for glamour/editorial rows
- `notes` — hand-fidelity, ordered-sequence difficulty, or scope notes

Capability rows add:

- `expected` — semantic behavior being tested
- `difficulty` — basic / medium / hard
- `policy` — `direct` (all capability prompts are evaluated as one VAC)
- `vocab_ids` — vocabulary concepts used by the test

## Architectural rules

### Direct Kimodo candidate

One continuous scene/action or one pose transition:

- walk while waving
- runway cross-step walk
- shift weight and place hand on hip
- small stage bow
- turn and look back

### Pose-library / hand-layer candidate

Precise finger geometry or exact still pose may be more reliable as a reusable pose asset layered over the body motion:

- finger heart
- double peace
- exact heart hands
- flower pose under chin

### Ordered sequence inside one VAC

Temporal sequences remain a single VAC request. The DB keeps `temporal=sequence` and `ordered_sequence` risk information because exact action ordering can be less reliable than a continuous action:

```text
walk → stop → model pose
bow → heart pose
hands-behind pose → double peace
walk → 180° turn → walk back
```

The AI motion feature never splits these into multiple clips. If Kimodo cannot reproduce the ordering reliably, the capability result stays `partial` or `poor` rather than routing to another timeline format.

## Benchmark strategy

Do not immediately render all 100 prompts at expensive final settings. Recommended staged test:

1. English teacher prompt → Kimodo, 120 frames / 25 denoising steps for all 100.
2. Record root displacement, path length, joint movement, generation time, and output validity.
3. Produce preview videos for representative / suspicious rows.
4. Human-label each row as `good`, `partial`, `wrong`, `static_only`, `hand_layer`, or `pose_library`, and record `ordered_sequence` as a risk when applicable.
5. Re-run promising/failing rows at 100 steps before deciding whether Kimodo itself needs extra motion training.

## Safety / scope

All records in `prompt_collections_v1` are explicitly scoped to adult subjects. The database includes bold/high-intensity glamour poses because broad pose diversity is useful for this motion project, but it remains pose/choreography-focused and non-explicit. `bold_sensual` is separated from ordinary glamour and tagged intensity 4/5 so it can be enabled, excluded, sampled, or benchmarked independently.

The catalog deliberately excludes minor/ambiguous-age descriptors and explicit sexual-contact/genital-focused terminology. A validation check rejects known ambiguous-age and out-of-scope terms. The vocabulary is primarily body mechanics, pose composition and choreography terminology rather than character-age or sexual-content metadata.

## Source provenance

See `SOURCES.md`. Source material is used to discover terminology and taxonomy; long third-party prompts are not copied into this database.
