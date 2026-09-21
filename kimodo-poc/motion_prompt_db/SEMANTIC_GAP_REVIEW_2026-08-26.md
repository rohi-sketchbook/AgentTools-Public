# Semantic gap capability review — 2026-08-26

Model: `Kimodo-SOMA-RP-v1.1`

## Why this review exists

The prompt collection should not grow merely to hit a larger row count. The useful unit is a distinct physical-action concept that either improves language coverage or exposes a motion-capability boundary.

The review began with 214 total vocabulary rows, but 20 of those were camera/presentation terms. The starting body-motion vocabulary was therefore **194 entries**.

`semantic_gap_candidates.tsv` initially contained **83 unpromoted candidates** identified from missing body mechanics and underrepresented Kimodo training domains:

- high priority: 34
- medium priority: 40
- low priority: 9

High-priority candidates contain 30 `direct` Kimodo candidates, 2 Pose Library candidates, and 2 prop/contact candidates.

## Stage 1 — 30 direct high-priority candidates at 25 steps

Command path: `scripts/run_capability_sweep.py` using `semantic_gap_candidates.tsv` as a custom input.

Settings:

- frames: 120
- denoising steps: 25
- seed: 20260826
- candidates: 30

Result:

- finite outputs: **30/30**
- mean generation time: **1.1519 s**
- total generation time: **35.367 s**

This stage only establishes generation validity and useful motion statistics. It does not prove semantic correctness.

## Stage 2 — selected 100-step visual review

Six representative/suspicious candidates were rerun at 100 steps using the same seed.

- finite outputs: **6/6**
- mean generation time: **4.5432 s**

### body_hip_sway

Result: **good**.

The side-to-side hip/body sway is visually apparent while final root displacement remains about 0.04 m. This is a strong candidate for multi-seed confirmation and eventual vocabulary promotion.

### locomotion_quick_stop

Result: **good body semantics / partial full request**.

Walk-to-stop behavior is plausible, but the four-second result travels about 5.53 m. Keep the concept, but route it through root-distance/speed normalization.

### transition_stand_to_kneel

Result: **good body semantics / partial full request**.

The character clearly lowers from standing into a kneeling configuration. Floor contact and final-pose quality still require runtime review before promotion.

### body_chest_pop

Result: **poor**.

A brief chest isolation becomes a much larger whole-body action with about 1.58 m final root displacement. Adding more Japanese paraphrases would not fix this motion-model capability issue. Hold this candidate rather than promoting it.

### body_wave_forward

Result: **partial body / poor full request**.

The generated motion is dominated by arm/shoulder movement; a clear chest-to-hips body wave is not evident in the four-frame review. Hold pending better prompting, constraints, or motion-model improvement.

### dance_grapevine_left

Result: **partial**.

Lateral rhythmic motion is present, but the four-frame review does not establish the characteristic foot-crossing pattern reliably. Keep as a capability candidate; do not promote yet.

## Stage 3 — multi-seed confirmation and first promotion batch

The 30 high-priority direct candidates were additionally screened at 25 steps with seeds `20260827` and `20260828`. All **60/60** additional outputs were finite. Three-seed statistics were used to separate stable root behavior from prompts that produce semantically suspicious travel.

Fifteen promising concepts were then reviewed at 100 steps with seed `20260827`, and ten promotion candidates received a second 100-step review with seed `20260828`.

The following ten concepts were promoted into the base motion vocabulary:

- `body_hip_sway`
- `arm_reach_forward`
- `arm_reach_up`
- `locomotion_hop_forward`
- `locomotion_soft_stop`
- `locomotion_start_walk`
- `locomotion_turn_around`
- `dance_sway_step`
- `transition_kneel_to_stand`
- `transition_stand_to_kneel`

Evidence highlights:

- `locomotion_hop_forward`: both reviewed 100-step seeds produced about 0.14-0.15 m simultaneous foot clearance and about 1.2-1.3 m forward displacement.
- `locomotion_soft_stop`: reviewed runs began near walking speed and ended near zero horizontal speed.
- `locomotion_turn_around`: body heading changed by about 175-179 degrees in both reviewed runs.
- `arm_reach_forward` / `arm_reach_up`: repeated runs produced the intended one-arm reach with negligible root travel.
- `body_hip_sway` / `dance_sway_step`: repeated runs preserved the intended lateral sway while keeping unwanted root drift low.
- `transition_kneel_to_stand`: both reviewed runs began kneeling and finished standing.
- `transition_stand_to_kneel`: the original generic wording was seed-unstable, but changing the canonical prompt to `lower from standing into a kneeling position and remain kneeling` produced a held kneeling end state in two 100-step seeds. This was a language-specification gap rather than evidence that the motion itself was absent from Kimodo.
- `locomotion_quick_stop`: two 100-step seeds decelerated from high walking speed to near-zero ending speed; direct generation is usable with authored root-distance/speed normalization.
- `dance_cross_step`: left/right foot ordering changed four times in each of two 100-step seeds, providing stronger evidence of real cross-step semantics than visual silhouette alone.
- `dance_bounce_step`: lateral stepping plus vertical bounce remained visible across both reviewed seeds.
- `dance_step_turn`: the vague `step into a turn` wording produced almost no heading change, while an explicit `180-degree half turn, ending facing the opposite direction` produced about 172.9 and 178.4 degrees across two seeds. This is another canonical-language issue rather than a missing Kimodo motion.
- `transition_crouch_to_stand` / `transition_stand_to_crouch`: two later 100-step seeds consistently reached the requested end configurations; keep floor-contact cleanup as a post-process concern.
- refined chest/shoulder/hip isolation prompts still recruited arm or whole-body motion. These remain capability gaps even after root travel was reduced, so they were deliberately not promoted.

After final High-queue resolution, the tracked vocabulary contains **234 total entries / 214 body-motion entries**, and the gap queue contains **61 candidates** (`high=0`, `medium=52`, `low=9`). The remaining candidates are reviewed lower-priority model gaps or future coverage opportunities rather than unresolved launch-blocking vocabulary holes.

## Promotion policy established by this review

1. `finite=true` is only a validity gate, never a semantic success label.
2. A high-priority gap should receive a 25-step screen before expensive review.
3. Promising or suspicious concepts should be rerun at 100 steps.
4. Exact finger shapes, exact photo poses, ordered choreography, and prop/contact semantics remain separate routing concerns.
5. A concept should enter the base motion vocabulary only after use-case-specific capability review shows that it is useful as a semantic anchor.
6. Concepts that reveal a Kimodo capability gap remain in `semantic_gap_candidates.tsv`; they are evidence for routing, constraints, asset authoring, or future fine-tuning rather than reasons to inflate the language corpus.

## Next evaluation batch

Keep unresolved high-priority concepts in capability review rather than promoting them on vocabulary demand alone. The next useful clusters are:

- torso isolation: chest circle / shoulder roll / shoulder shimmy / hip roll / forward/reverse body wave remain unresolved after stronger isolation wording
- dance steps: two-step remains redundant with the existing step-touch concept; grapevine still needs stronger foot-order verification
- compound dance: arm-wave-step needs a clearer distinction between body/arm wave and exact wrist/finger behavior
- exact/static routes: hands-behind-head and step-into-pose should be evaluated through Pose Library rather than direct Kimodo
- prop/contact transitions: stand-to-sit and sit-to-stand should stay in the prop-constraint track

The 1,000-prompt collection should now be regenerated or expanded only around promoted semantic anchors and confirmed coverage gaps, not by multiplying paraphrases of the original 194 body concepts.
