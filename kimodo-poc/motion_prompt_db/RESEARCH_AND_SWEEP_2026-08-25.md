# Motion prompt research + Kimodo capability sweep — 2026-08-25

## What was built

- 214 normalized vocabulary rows across pose, idol gesture, adult non-explicit glamour/editorial, runway, cute/idol motion, head/locomotion/style, and camera partitions.
- 100 canonical Kimodo capability prompts:
  - 25 glamour/editorial
  - 25 idol/cute gesture
  - 25 runway/fashion
  - 25 dynamic/cute motion
- Provenance notes in `SOURCES.md` based on official video-prompt guidance plus image-generation pose/fashion prompt references.

## Why image/video prompting data is useful

Image-generation prompt corpora contain a large practical vocabulary of **static body configurations and hand/face-adjacent gestures** that ordinary motion datasets often describe poorly: contrapposto, over-shoulder look, hands behind back, hand on cheek, hair touch, peace sign, finger heart, heart hands, curtsy, etc.

Video-generation prompting guidance adds a useful normalization rule: prefer **direct physical actions** over abstract mood descriptions, and keep subject motion separate from camera/scene motion. This maps naturally to the Kimodo → single-VAC generation pipeline.

Camera vocabulary is therefore stored in the DB but marked as non-Kimodo motion data.

## First 100-prompt Kimodo screening

Settings:

- model: Kimodo-SOMA-RP-v1.1
- conditioning: NF4 LLM2Vec teacher, canonical English prompt
- frames: 120 (4 seconds at 30 fps)
- denoising steps: 25
- same diffusion seed for all prompts: 20260825

Result:

- 100 / 100 generated successfully
- all outputs finite; no NaN/Inf
- total motion-generation time: 100.108 s
- mean: 0.9785 s / clip

### Automatic motion statistics by group

| Group | Mean root displacement | Median root displacement | Max root displacement | Mean root-relative joint motion/frame |
| --- | ---: | ---: | ---: | ---: |
| glamour/editorial | 0.313 m | 0.148 m | 2.213 m | 0.00870 m |
| idol/cute gesture | 0.050 m | 0.042 m | 0.131 m | 0.01206 m |
| runway/fashion | 2.727 m | 1.247 m | 10.703 m | 0.01828 m |
| dynamic/cute | 1.198 m | 0.092 m | 7.470 m | 0.02159 m |

Interpretation: this is encouraging as a *screening signal*. Runway prompts tend to produce locomotion, idol/cute gesture prompts tend to keep the root nearly fixed while moving limbs, and glamour/editorial prompts are generally pose-oriented. This does not by itself prove semantic correctness.

### Metric outliers worth visual review

- `cap_011` floor seated lean: root displacement ~1.03 m; suspicious for a nominally static pose.
- `cap_016` step + look back: root displacement ~2.21 m; may be reasonable but needs quality review.
- `cap_057` fast controlled runway: root displacement ~10.70 m over 4 s; likely too fast for a fashion runway unless the model interprets it as fast locomotion.
- `cap_055` power walk: root displacement ~9.47 m / 4 s; needs review.
- `cap_096` walk + wave: root displacement ~7.47 m / 4 s; movement exists, but style may be too fast.

## Preview set

Twenty representative/suspicious clips were rendered with a body-tracking camera:

`results/capability-previews-20/`

Combined montage:

`results/capability-previews-20/montage_20.mp4`

The montage covers five glamour/editorial, five idol/cute gesture, five runway, and five dynamic/cute cases.

## Design conclusions so far

1. The vocabulary DB should be expanded from AI image/video prompt practice, but normalized to physical motion semantics rather than copying full generation prompts.
2. Exact finger shapes (peace sign, finger heart, hand heart) should be tracked separately because a body-motion model may need a dedicated hand-pose layer even when the arm/hand placement is correct.
3. Static glamour/editorial poses are likely good candidates for a reusable pose library plus Kimodo-generated transitions.
4. Runway walk/turn actions are appropriate Kimodo candidates, but style/speed needs explicit capability testing.
5. Multi-stage actions remain one VAC request. Treat exact temporal ordering as a capability risk rather than introducing a multi-clip generation path.
6. The next benchmark stage should rerun representative/failing rows at 100 denoising steps and attach human labels (`good`, `partial`, `wrong`, `pose_library`, `hand_layer`) plus risk flags such as `ordered_sequence`.

## Safety/scope rule

The glamour/editorial DB is intentionally adult-only and non-explicit. Explicit sexual-contact/genital-focused pose terms are not included. This DB describes body mechanics/choreography and must not be combined with minor or ambiguous-age sexualized subject descriptors.
