# Motion Prompt DB — source notes

This database is a normalized vocabulary/benchmark corpus for Kimodo / Qwen adapter experiments. It does **not** copy long prompt examples from source sites. Only short pose/action terms, taxonomy ideas, and independently rewritten canonical motion descriptions are retained.

## Official image/video prompting references

- `runway_video` — Runway Gen-4 Video Prompting Guide
  - https://help.runwayml.com/hc/en-us/articles/39789879462419-Gen-4-Video-Prompting-Guide
  - Used for the principle that motion prompts should be direct physical actions and separated into subject motion, camera motion, scene motion, and style descriptors.
- `runway_image` — Runway Gen-4 Image Prompting Guide
  - https://help.runwayml.com/hc/en-us/articles/35694045317139-Gen-4-Image-Prompting-Guide
  - Used for general pose/composition vocabulary such as relaxed pose and in-motion descriptions.
- `runway_camera` — Runway Camera Terms, Prompts, & Examples
  - https://help.runwayml.com/hc/en-us/articles/46749315925395-Camera-Terms-Prompts-Examples
  - Used only for camera vocabulary; camera rows are marked `kimodo_candidate=false`.
- `veo_guide` — Google Cloud Veo prompt guide / Veo 3.1 prompting guide
  - https://cloud.google.com/resources/content/intl/ja-jp/veo-prompt-guide?hl=ja
  - https://cloud.google.com/blog/ja/products/ai-machine-learning/ultimate-prompting-guide-for-veo-3-1?hl=ja
  - Used for the structured separation of cinematography, subject, action, context, style/ambiance.

## Pose / glamour / idol / fashion prompt references

- `pixel_ai_gravure` — Pixel AI Lab, Stable Diffusion gravure pose prompt collection
  - https://pixelgnarly.com/stable-diffusion-promptsample-i01/
  - Used for category coverage: standing, seated/relaxed, sports/action, walking/dancing, story-like poses.
- `ururu_gravure` — Ururu AI Lab, AI gravure pose prompt article
  - https://ururuailab.com/sd-prompt-aigravure-pose/
  - Used for short terms such as standing, contrapposto, leaning against a wall, back view, looking back.
- `weel_gravure` — WEEL, Stable Diffusion gravure prompt examples
  - https://weel.co.jp/media/ai-gravure-stablediffusion/
  - Used for non-explicit body-pose vocabulary such as arching the back and looking back.
- `aiaicreate_posture` — aiaicreate pose/posture catalog
  - https://aiaicreate.com/sd-prompt-pose/
  - Used as a posture-tag coverage reference.
- `ai_nante_pose` — AI pose prompt guide
  - https://ai-nante.com/pose-prompts/
  - Used for standing/seated/basic action coverage.
- `nano_pose72` — Japanese pose prompt list covering hand gestures and idol-like poses
  - https://note.com/midori_biz/n/n2dbaa94b8848
  - Used for short gesture terms such as peace sign, heart hands, finger heart, pointing, hand on cheek, waving, cat pose, head tilt, curtsy, arms behind back.
- `jikuchiyo_hands` — Stable Diffusion hand/arm pose prompt article
  - https://jikuchiyo.com/female_anime_hand_stable-diffusion/
  - Used for hand/arm vocabulary such as hand over mouth, hands clasped, hand on knee, heart hands, arms raised, arms behind back.
- `aicuty` — AiCuty open AI idol project
  - https://github.com/aicuai/AiCuty
  - Used as an example of idol-oriented prompt construction, including a heart-hands pose near the chest.
- `clipstudio_fingerheart` — Clip Studio official finger-heart hand pose material
  - https://assets.clip-studio.com/en-us/detail?id=2251588
  - Used as evidence that finger-heart is established idol/photo-shoot gesture vocabulary.
- `fashion_show_prompt` — Japanese fashion-show AI prompt guide
  - https://ai-nante.com/fashion-show-prompt-guide/
  - Used for runway/model-pose terms such as contrapposto, swayback, crossed legs, hands on hips.
- `fabricant_fashion` — The Fabricant fashion prompt guide
  - https://www.thefabricant.com/post/prompt-guide
  - Used for editorial/fashion concepts such as elongated pose, dynamic mid-motion, sophisticated seated pose, architectural pose, power walk, balletic pose.
- `promptmake_fashion` — PromptMake fashion/lookbook/runway prompt guide
  - https://promptmake.net/blog/fashion-ai-prompts-lookbook
  - Used for runway still/action vocabulary such as mid-stride, natural arm swing, weight on the back foot, sculptural pose.

## Additional sources used for the 1,000-prompt v1 collection

- `mitsune_pose` — Mitsune Stable Diffusion pose prompt list
  - https://mitsune-ai.com/stable-diffusion-pose-prompts/
  - Short body-placement terms such as contrapposto, hand on hip, arms behind back, arched back, leaning forward, twisted torso, hand on thigh, head tilt, hair touch, looking back.
- `atelab_pose` — AteLab standing/sitting pose prompt examples
  - https://note.com/atelab_ai/n/n3e14e450385d
  - https://note.com/atelab_ai/n/n5e563ce76ecb
  - Used for kneeling/on-one-knee, arched-back, hand-in-hair, hand-on-thigh, contrapposto and side-view pose combinations.
- `edgehub_pose` — EdgeHUB pose-prompt reference
  - https://highreso.jp/edgehub/stablediffusion/pose.html
  - Used for peace sign, double peace, heart hands, paw pose, hair touch, crouching and lying vocabulary.
- `korea_gestures` — Korean photo gesture guide
  - https://koreaquicktips.com/korea-culture-finger-hearts-photo-gestures-guide/
  - Used for finger heart, cheek heart, overhead/head heart and V-sign terminology.
- `idol_fusion` — Fan-meet/idol pose guide
  - https://www.idolfusion.com/blogs/all-blogs/most-popular-fan-meet-photo-poses-with-k-pop-idols-t-pop-artists-bl-actors
  - Used for under-chin, cheek-pointing and heart-pose taxonomy.
- `noa_kpop_heart` — NOA K-POP heart-pose overview
  - https://www.noadance.jp/k-pop/knowledge/45633.html
  - Used as additional provenance for K-pop finger-heart/heart-pose vocabulary.
- `reddit_idol_pose` — community fan-photo discussion
  - https://www.reddit.com/r/XLOV/comments/1usbpyh/photo_opportunity_poses/
  - Community evidence for finger heart, cheek heart, thumbs-up, claw/cat-ear and hand-on-cheek pose usage. Treated as community inspiration, not authoritative fact.
- `pixeledit_apparel` — apparel/model photography pose guide
  - https://thepixeledit.com/professional-apparel-photography-with-model/
  - Used for 3/4 turn, weight on back leg, walking stride, over-shoulder glance, hands on hips, hair touch, crossed-leg stance, stool/floor pose, fabric toss and wall lean vocabulary.
- `jcasablancas_editorial` — editorial fashion posing guide
  - https://www.jcasablancas.com/how-to-master-posing-for-high-fashion-editorials/
  - Used for S-curve/contrapposto, weight shift, bent elbow/knee, negative space, elongated/angular pose, exaggerated lean and hunched/graphic editorial positioning.
- `runway_model_academy` — runway/catwalk training notes
  - https://www.runwaymodelacademy.co.uk/tips/
  - Used for posture, poise, pose and pace as distinct runway-control concepts.
- `ngm_catwalk` — catwalk walk/pose/turn guidance
  - https://www.ngmmodeling.com/catwalk-course-how-to-pose-pass-and-walk-the-runway/
  - Used for controlled pace, end-of-runway pose, half turn/full turn and accessory/garment presentation concepts.
- `jobwork_catwalk` — catwalk glossary
  - https://www.jobwork.com/en/glossary/catwalk
  - Used for the straight-line, one-foot-in-front-of-the-other characterization of catwalk gait.

## Curation rules

1. Long source prompts are never copied into the DB. Canonical English/Japanese descriptions are rewritten for motion semantics.
2. Clothing, lighting, lens, environment, and rendering-quality boilerplate are excluded from Kimodo motion vocabulary.
3. Explicit sexual-contact/genital-focused pose terms are excluded. The `glamour_editorial` partition is intentionally limited to non-explicit adult glamour/editorial poses and every row is marked `adult_subject_only=true`.
4. Terms that depend on exact finger articulation (peace sign, finger heart, hand heart) remain in the vocabulary but are tagged in notes because body-motion models may require a separate hand-pose layer.
5. Multi-stage temporal instructions remain `sequence` records and are evaluated as a single VAC. Exact ordering may be less reliable, but the AI motion feature does not split them into multiple clips.
6. Camera terms are retained for future preview/video-prompt generation but are not Kimodo training targets.
