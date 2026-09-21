# Kimodo capability review — prompt collection v1

Date: 2026-08-25
Model: Kimodo-SOMA-RP-v1.1
GPU: RTX 3080

## Screening

- Catalog size: 1000 prompts, 200 per genre.
- Stratified screen: 200 prompts (40 per genre), 120 frames / 25 denoising steps.
- Valid motion outputs: 200/200; no NaN/Inf.
- Review candidates: 36 prompts selected from distribution tails and route-sensitive cases.
- High-quality rerun: 36/36 at 120 frames / 100 steps; no NaN/Inf.
- 100-step mean generation time: 3.8627 seconds for a 4-second clip.

## 25-step vs 100-step

Across the 36 reviewed prompts:

- mean absolute change in final root displacement: 0.217 m
- mean root-relative pose difference: 0.099 m

Largest root-displacement changes:

- DC032: 8.95 m → 6.21 m (skip/point/jump sequence)
- RF054: 8.67 m → 7.17 m (brisk runway walk)
- RF039: 6.29 m → 5.03 m (runway walk → garment presentation → stop pose)

Increasing denoising steps reduces some extreme locomotion, but does not fix semantic/structural limitations by itself.

## Visual review — representative 12

### Glamour / editorial

- **GE106 — partial / pose_library**
  - Requested: wide stance + forward torso lean + hair touch + over-shoulder look.
  - Result: base standing posture is plausible, but exact hair-touch and over-shoulder composition are weak.
  - Route: use Pose Library for exact photo composition; Kimodo may provide entry/exit transition.

- **GE155 — good base / pose_library**
  - Requested: one knee bent + dropped shoulder + arms behind back + chin down.
  - Result: stable, photo-pose-like silhouette with very low unwanted root motion.
  - Route: Pose Library remains preferred for exact still; Kimodo transition is usable.

### Idol / cute

- **IC009 — good/partial / direct**
  - Requested: tiny crouch + both hands under cheeks + right head tilt.
  - Result: crouch and both hands near face are clearly represented. Head detail is less exact.
  - Route: direct body motion is viable; optional pose cleanup.

- **IC115 — body good / hand_layer**
  - Requested: one foot forward + double peace signs beside face + head tilt.
  - Result: both arms/hands move to the face area correctly, but finger-V geometry is outside reliable body-motion evaluation.
  - Route: Kimodo for body/arm placement + Hand Layer for exact peace signs.

### Dynamic cute / dance

- **DC062 — partial / direct / ordered_sequence**
  - Requested: side steps → open arms → lift one foot into final pose.
  - Result: open-arm component is clear; the ordered side-step/final-foot sequence is not reliably represented as an exact three-stage choreography inside one VAC.
  - Route: direct single-VAC generation; keep `ordered_sequence` as a capability risk.

- **DC032 — partial / direct / ordered_sequence**
  - Requested: skip forward → point → small jump/landing.
  - Result: dynamic arm/leg motion is produced, but 100-step root displacement is still 6.21 m in four seconds and sequence timing is not exact.
  - Route: direct single-VAC generation with root-distance control; ordering remains a known limitation.

### Runway / fashion

- **RF039 — partial / direct / ordered_sequence**
  - Requested: brisk runway walk → present garment hem → stop with hand on hip.
  - Result: runway-like body motion is present, but exact three-stage ordering is only partially reliable inside one VAC.
  - Route: direct single-VAC generation; retain `ordered_sequence` and root-distance risks.

- **RF054 — direct_with_speed_control**
  - Requested: brisk runway walk + natural arm swing + finish with one-leg weight shift.
  - Result: coherent walking/arm motion, but 7.17 m in four seconds is too fast for many runway use cases.
  - Route: direct Kimodo motion with locomotion-distance/speed normalization and optional final pose clip.

- **RF165 — good/partial / direct**
  - Requested: power walk + one hand on hip + over-shoulder finish.
  - Result: hand-on-hip/fashion silhouette and walking behavior are represented reasonably.
  - Route: direct for base walk, optionally snap/blend into a curated finish pose.

### Bold glamour

- **BS020 — weak / pose_library**
  - Requested: deep chair sit + deep back arch + hand on thigh + chin-up.
  - Result: the skeleton produces a seated-like configuration but cannot understand or constrain the missing chair geometry; exact composition is unreliable.
  - Route: Pose Library + prop/contact constraints.

- **BS160 — weak/partial / pose_library**
  - Requested: deep chair sit + bold forward lean + thigh hand + over-shoulder look.
  - Result: large posture/root transition (1.23 m) and chair-dependent semantics make free generation unreliable.
  - Route: Pose Library/IK with chair contact; Kimodo only for approach/transition if desired.

- **BS166 — partial / pose_library**
  - Requested: kneel on both knees + shoulders back + both hands behind head + chin up.
  - Result: low/kneeling body configuration emerges, but exact arm/head composition is not consistently matched.
  - Route: Pose Library for exact photography pose.

## Routing conclusion

The initial routing policy is supported by actual generation:

1. **Direct Kimodo** works best for continuous locomotion and broad body gestures.
2. **Pose Library** is the preferred source of exact glamour/editorial stills, kneeling/seated compositions, prop/contact-dependent poses, and precise silhouette work.
3. **Hand Layer** should supply peace signs, finger hearts, exact heart hands, cat paws, and other finger-critical shapes after Kimodo places the arms/hands.
4. **Ordered multi-stage choreography** is harder to reproduce exactly inside one VAC. Keep these prompts as direct generation with an `ordered_sequence` risk rather than introducing a multi-clip path.
5. Runway generation needs a separate **distance/speed normalization** control because semantically correct walking can still over-travel.

## Implication for training

The 1000-prompt language corpus can be used to strengthen Japanese → LLM2Vec semantic mapping, but that does **not** teach Kimodo new motions. Missing pose/motion capability must come from one of:

- curated Pose Library assets,
- hand-pose assets,
- actual motion-model fine-tuning with suitable motion data.

Therefore language distillation and motion-capability training must remain separate evaluation tracks.
