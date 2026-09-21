# Motion routing rules

The prompt vocabulary DB is not only training data. It decides how a requested motion should be constructed **inside one VAC**.

## Product boundary

The VR Avatar Studio AI motion feature creates exactly **one VAC per request**. It does not create timelines, split a request into multiple clips, or construct another scene/sequence format.

Ordered multi-stage prompts are still accepted, but they are generated as one VAC. Their ordering quality is recorded as capability evidence (`ordered_sequence`) instead of being routed to a multi-clip workflow.

## 1. Kimodo direct

Use Kimodo directly for continuous body motion, transitions, and simultaneous coarse gestures:

- walk / jog / run / march / skip
- runway walk / power walk / cross-step walk
- pivot / turn / bow / curtsy
- side step / step-touch / bounce
- walk while waving
- jog while pointing
- sway while moving the arms
- walk → stop → turn sequences when the user explicitly requests them

Kimodo owns root motion, hips, torso, limbs, timing, and the internal ordering of the resulting VAC.

If an ordered request is only partially reproduced, keep it as a `partial` capability result. Do not split the request into multiple generated clips.

## 2. Pose Library assistance

Prefer a reusable pose asset when the target is primarily a visually designed static configuration:

- contrapposto
- S-curve pose
- weight on one leg + hand on hip
- over-shoulder glamour/editorial pose
- elegant seated pose
- floor side-sit
- kneeling editorial pose
- elongated/sculptural fashion pose

When this route is used, the pose assistance is baked into the same final VAC. The AI motion feature still returns one VAC.

## 3. Hand Layer assistance

Exact finger geometry is separate from arm/hand placement. Use the hand-pose layer for:

- peace sign / double peace
- finger heart
- two-hand heart
- flower pose under chin
- cat-ear/cat-paw hand shapes
- shushing finger
- thumbs-up when exact thumb/finger articulation matters

Kimodo may control shoulder/elbow/wrist placement. The hand layer replaces or blends finger bones, and the result is baked into the same VAC.

## 4. Root distance / speed control

Some semantically correct locomotion travels too far or too fast. `direct_with_speed_control` means:

- generate the motion with Kimodo;
- normalize authored root distance/speed as needed;
- keep the motion as one VAC.

This applies especially to runway motion, start/stop transitions, and longer walking requests.

## 5. Prop/contact-dependent motion

Requests such as sitting on a specific chair can be generated only approximately without scene geometry. Keep `prop_constraint` as capability information for body-motion/contact limitations. The AI motion feature itself remains a VAC generator and must not grow into a scene-authoring system.

## 6. Camera / presentation only

Camera terms live in `camera_video.tsv` but never enter the character-motion embedding or AI VAC generation:

- tracking shot
- dolly in/out
- pan
- arc
- crane / pedestal
- handheld
- low angle
- full-body / medium / close-up
- shallow depth of field
- slow motion

They are retained only as separate prompt/reference vocabulary for other tooling.

## Screening evidence

Capability evaluation records validity and motion statistics separately from semantic correctness. Relevant measurements include:

- root displacement and path length;
- start/end/peak horizontal speed;
- root vertical range;
- body heading change;
- hand/head root-relative motion;
- floor/contact behavior where relevant.

Do not treat motion magnitude or `finite=true` as semantic success. Final capability labels require visual review at 100 steps for representative seeds, especially for exact poses, ordered sequences, floor/contact motion, and finger-dependent gestures.
