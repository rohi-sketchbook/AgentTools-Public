# Adapter experiment workspace

Store aligned teacher (`4096` float values) and Qwen student (`1024` float values) pairs in `data/`; keep learned weights in `checkpoints/`. Both folders are ignored except for their `.gitkeep` markers. Generated datasets and learned checkpoints are local artifacts; tracked scripts and vocabulary files are the reproducible source of truth.

The routed runtime is defined by `routed_pipeline_v1.json`. It preserves the original Qwen bridge/base path, adds a specialist residual only when the domain router is confident, and can apply the promoted-anchor residual only when `promoted_anchor_gate_h64.pt` reports that a newly promoted Japanese semantic anchor needs correction. The production gate threshold is `0.80`; the 2026-08-26 regression set detected 100/100 promoted-anchor examples and 0/6743 existing routed examples at that threshold.

Promoted-anchor rebuild flow:

1. Build `adapter/data/promoted_anchor_pairs.jsonl` from `motion_prompt_db/promoted_anchor_paraphrases.tsv` with `build_promoted_anchor_pairs.py`.
2. Extract teacher embeddings for the canonical English targets and bridged Qwen embeddings for the Japanese forms.
3. Train `promoted_anchor_residual_h128.pt` with `train_promoted_anchor_residual.py` while anchoring the old base dataset.
4. Train `promoted_anchor_gate_h64.pt` with `train_promoted_anchor_gate.py`; existing routed data is used as the negative set.
5. Verify the gate with `evaluate_promoted_anchor_gate.py` and the full routed Japanese path with `evaluate_promoted_anchor_routing.py` before enabling the new weights.

Motion-category hint flow:

1. `build_motion_category_index.py` derives `motion_category_index.json` from the reviewed/current motion vocabulary.
2. The worker encodes those concept anchors once when the AI-motion feature loads.
3. `categoryHint` restricts nearest-concept lookup to the selected coarse category. At similarity >= `0.82`, the nearest concept contributes a `0.20` blend in preserved v3 Qwen space.
4. `auto`/empty category performs no concept blend. `evaluate_category_hint_blend.py` is the regression tool for blend strength and concept retrieval.

The AI motion feature remains a **single-VAC generator**. Adapter routing does not create VSPs or split one request into multiple clips.
