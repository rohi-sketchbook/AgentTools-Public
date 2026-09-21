# Source vocabulary summary

This note summarizes the short physical vocabulary families used to construct Prompt Collection v1. It is not a copy of full third-party prompts.

## Glamour / editorial

Observed/reinforced vocabulary includes:

- contrapposto / weight on one leg
- legs crossed / one leg forward / knee bent
- hand on hip / hand on thigh / hand near neck
- arms behind back / hands behind head
- arched back / leaning forward / torso twist
- hair touch / hair sweep
- looking back / over-the-shoulder look / sideways gaze
- kneeling / one-knee kneeling / seated / reclining
- wall lean / chair pose / floor pose
- elongated pose / angular pose / S-curve / negative-space posing

Primary source families: `mitsune_pose`, `atelab_pose`, `ururu_gravure`, `jcasablancas_editorial`, `pixeledit_apparel`.

## Idol / cute

Observed/reinforced vocabulary includes:

- finger heart
- cheek heart
- heart hands / overhead heart
- peace sign / double peace
- cat-paw / cat-ear-like hand pose
- hand on cheek / hands under cheeks / flower-cup family
- thumbs-up / cheek pointing
- small wave / fan-service wave
- head tilt / heel lift / toes-in stance

Primary source families: `edgehub_pose`, `korea_gestures`, `idol_fusion`, `noa_kpop_heart`, `reddit_idol_pose`.

## Runway / fashion

Observed/reinforced vocabulary includes:

- straight-line runway walk / catwalk
- slightly crossing steps / one foot in front of the other
- controlled pace / poise / posture
- power walk / gentle walking stride
- end-of-runway pose
- half turn / full turn / 180-degree pivot
- over-the-shoulder finish
- hand on hip at stop
- natural restrained arm swing
- garment/fabric presentation

Primary source families: `runway_model_academy`, `ngm_catwalk`, `jobwork_catwalk`, `pixeledit_apparel`.

## Dynamic motion / AI-video structure

Motion prompts are normalized around:

- subject action
- direction
- speed / timing / motion style
- temporal progression
- optional camera motion kept in a separate camera vocabulary

This follows the separation recommended in Runway Image-to-Video / Gen-4 prompting and Google's Veo prompting guidance. Camera language is not mixed into Kimodo body-motion semantics.

## Bold adult glamour

The high-intensity set reuses body-mechanics vocabulary rather than explicit sexual scenarios:

- deep back arch
- strong hip twist / emphasized S-curve
- bold forward lean
- shoulders drawn back / open upper torso
- one-knee / both-knees pose
- chair-straddle pose
- sideways floor-seated pose
- deep seated chair pose
- hand(s) on thigh / hair / hip / behind head
- strong over-the-shoulder or sideways gaze

All rows are `subject_age_scope=adult`, `adult_glamour=true`, and intensity 4 or 5.
