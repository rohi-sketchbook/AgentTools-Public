# Kimodo Japanese Routed Pipeline PoC — 2026-08-25

## Current production candidate

Pipeline:

`Japanese -> Qwen3-Embedding-0.6B -> domain router -> Qwen instruction bridge -> preserved v3 base adapter -> optional specialist residual -> Kimodo-SOMA-RP-v1.1`

Manifest: `adapter/routed_pipeline_v1.json`

## Why the routed design exists

A single adapter trained on the generic 743-pair corpus plus the 6,000 specialist paraphrases improved in-domain validation but degraded fully unseen generic Japanese. The generic v3 adapter is therefore frozen and preserved. Specialist residual adapters are only applied after domain routing.

When routing selects `generic`, no residual is evaluated or added. Generic output is therefore exactly the preserved base path.

## Reproducible v3 bridge

The original exact Qwen instruction used to create the v3 embeddings was not preserved. A learned 1024->1024 Qwen instruction bridge maps the reproducible current Qwen query space into the saved v3 Qwen space.

Selected bridge: `adapter/checkpoints/qwen_bridge_h256.pt`

Held-out 18 natural generic prompts:

- current Qwen -> saved v3 Qwen cosine: mean 0.8662
- bridge -> saved v3 Qwen cosine: mean 0.9750
- current Qwen + v3 adapter -> teacher cosine: mean 0.9170
- bridge + v3 adapter -> teacher cosine: mean 0.9506
- original saved v3 Qwen + v3 adapter -> teacher cosine: mean 0.9503

Thus the bridge reproduces the v3 generic behavior closely enough to use as the stable base path.

## Specialist residuals

Each residual is a small 1024 -> 128 -> 4096 correction network in the base teacher-standardized z-space. Parameter count per expert: 659,584.

Validation split is semantic hold-out by catalog `base_id`:

- train: 180 base motions per genre x 6 Japanese paraphrases = 1,080 rows
- val: 20 unseen base motions per genre x 6 Japanese paraphrases = 120 rows
- train/val base_id overlap = 0

Held-out results:

| Genre | Base cosine | Specialist cosine | Mean delta | Improved rows |
|---|---:|---:|---:|---:|
| glamour_editorial | 0.6989 | 0.9860 | +0.2870 | 120/120 |
| idol_cute | 0.7135 | 0.9904 | +0.2769 | 120/120 |
| runway_fashion | 0.7119 | 0.9874 | +0.2755 | 120/120 |
| dynamic_cute_dance | 0.8000 | 0.9901 | +0.1901 | 120/120 |
| bold_sensual | 0.6537 | 0.9895 | +0.3358 | 120/120 |

Even when an expert is forcibly applied to generic validation prompts, mean cosine changes only around -0.0005 to -0.0010 because generic anchor regularization is used during residual training. Normal runtime never applies an expert to generic prompts.

## Domain router

Selected router: `adapter/checkpoints/domain_router_h128.pt`

Classes:

- generic
- glamour_editorial
- idol_cute
- runway_fashion
- dynamic_cute_dance
- bold_sensual

Validation accuracy: 100% on the held-out catalog split. At confidence threshold 0.80:

- generic false-specialist route rate: 0%
- specialist correct route rate: 99.17%
- specialist coverage: 99.17%

Fully external generic natural-language set (18 prompts): 18/18 routed to generic; false specialist routes = 0.

A six-prompt natural-language smoke test outside the exact catalog wording produced the expected top class for all six prompts. A glamour prompt scored 0.8275, so threshold 0.80 is selected instead of the more conservative 0.85.

## End-to-end Kimodo held-out comparison

Five held-out prompts were generated with the same seed using base, specialist, and teacher embeddings at 120 frames / 100 denoising steps.

| Genre | Base emb cosine | Expert emb cosine | Base pose RMS to teacher | Expert pose RMS to teacher |
|---|---:|---:|---:|---:|
| glamour_editorial | 0.7213 | 0.9828 | 0.3748 m | 0.0134 m |
| idol_cute | 0.6650 | 0.9902 | 0.3008 m | 0.0357 m |
| runway_fashion | 0.7582 | 0.9857 | 0.1854 m | 0.0196 m |
| dynamic_cute_dance | 0.8142 | 0.9881 | 0.4250 m | 0.3395 m |
| bold_sensual | 0.7019 | 0.9905 | 0.3511 m | 0.1785 m |

The first three domains closely track the teacher motion. Dynamic sequences and some bold poses remain more sensitive to diffusion trajectory despite high embedding cosine. This reinforces the existing routing policy:

- static glamour/editorial: Pose Library is still preferred when exact photographic pose fidelity matters
- idol/cute: Kimodo body/arm motion + Hand Layer for exact finger shapes
- runway: direct Kimodo into a single VAC; walk/stop/turn sequences remain `ordered_sequence` risk cases
- dynamic cute dance: direct single-VAC generation; exact temporal multi-action ordering remains a known limitation
- bold poses involving chair/floor/kneeling contact: Pose Library + IK/contact constraints preferred where exact contact matters

Comparison video:

`results/specialist-heldout-comparison/all_genres_base_expert_teacher.mp4`

Column order in each row: Base / Specialist / Teacher.

## Live routed generation

Natural Japanese prompt tested outside the exact catalog sentence:

`片脚に体重を乗せ、片手を腰に置いて、肩越しに振り返る。`

Router:

- predicted: glamour_editorial
- confidence: 0.8275
- threshold: 0.80
- selected: glamour_editorial

120 frames / 100 steps:

- Qwen load: 2.27 s
- Qwen embedding: 0.41 s
- router: 0.010 s
- bridge + base + residual: 0.019 s
- Kimodo load: 1.20 s
- Kimodo generation: 3.61 s
- conditioning peak VRAM: about 1.16 GiB

Output:

`results/routed-natural-glamour/preview.mp4`

## 2026-08-26 promoted-anchor update

The capability review expanded the body-motion vocabulary from 194 to 214 semantic anchors without inflating the 1,000-prompt collection. Twenty newly promoted concepts received five Japanese surface forms each (80 train / 20 validation).

Before additional adaptation, the existing routed pipeline reached only about **0.689 validation cosine** on these new Japanese forms. A small promoted-anchor residual (659,584 parameters) raised the held-out validation cosine to about **0.965** while a dedicated 65,665-parameter gate prevents the residual from touching already-supported language.

The gate is evaluated in preserved v3 Qwen space before specialist routing. At the production threshold `0.80`:

- promoted-anchor examples detected: **100/100**
- existing routed dataset false positives: **0/6743**
- existing validation false positives: **0/648**
- existing specialist validation false positives: **0/600**

This is important because adding the anchor residual globally reduced existing specialist validation quality by roughly 0.006-0.018 cosine depending on domain. The gate therefore acts as a strict compatibility boundary: when it fires, `base + promoted-anchor residual` is used and the specialist residual is bypassed; otherwise the original generic/specialist path remains unchanged.

A live 100-step `soft stop` generation through the gated path produced a four-second motion that started near 1.98 m/s horizontal speed and ended near 0.064 m/s, confirming that the improved Japanese embedding still maps to the intended Kimodo motion behavior.

The learned gate/residual weights live under `adapter/checkpoints/` like the existing bridge/router/specialist weights and remain Git-ignored. Their tracked source-of-truth is the vocabulary/paraphrase data plus `train_promoted_anchor_residual.py` and `train_promoted_anchor_gate.py`.

## Remaining technical work

1. Keep temporal multi-action prompts as one VAC and improve canonical wording/capability evaluation for ordered sequences.
2. Add exact Hand Layer resolution for peace signs, finger hearts, cat paws, etc., baked into the same VAC.
3. Build SOMA -> Unity Humanoid / VRM retargeting and VAC export.
4. Test routed live generation on a larger hand-written external specialist prompt set, not only catalog-derived hold-outs.
5. Keep the generic base path frozen while growing specialist databases and gated residuals.
