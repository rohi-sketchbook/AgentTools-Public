# -*- coding: shift_jis -*-
from __future__ import annotations

import csv
import importlib.util
import json
from collections import Counter
from pathlib import Path


ROOT = Path(__file__).resolve().parent
MOTION_VOCAB_PARTITIONS = [
    "poses_general.tsv",
    "idol_gestures.tsv",
    "glamour_editorial.tsv",
    "runway_fashion.tsv",
    "idol_motion.tsv",
    "head_locomotion_style.tsv",
    "body_primitives.tsv",
]
VOCAB_PARTITIONS = [*MOTION_VOCAB_PARTITIONS, "camera_video.tsv"]
CAPABILITY_PARTITIONS = [
    "capability_glamour_25.tsv",
    "capability_idol_25.tsv",
    "capability_runway_25.tsv",
    "capability_dynamic_25.tsv",
]


def read_tsv(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8", newline="") as stream:
        return list(csv.DictReader(stream, delimiter="\t"))


def load_catalog() -> list[dict]:
    path = ROOT / "prompt_collections_v1" / "catalog.py"
    spec = importlib.util.spec_from_file_location("motion_prompt_catalog_v1", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Could not load catalog module: {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return list(module.PROMPTS)


def require(condition: bool, message: str, errors: list[str]) -> None:
    if not condition:
        errors.append(message)


def main() -> int:
    errors: list[str] = []

    with (ROOT / "capability_taxonomy.json").open("r", encoding="utf-8") as stream:
        taxonomy = json.load(stream)

    routing_labels = set(taxonomy["routing_labels"])
    support_labels = set(taxonomy["tested_support_labels"])
    risk_flags = set(taxonomy["risk_flags"])
    domain_ids = {row["id"] for row in taxonomy["claimed_training_domains"]}

    motion_vocab_rows: list[dict[str, str]] = []
    for filename in MOTION_VOCAB_PARTITIONS:
        motion_vocab_rows.extend(read_tsv(ROOT / filename))
    vocab_rows = list(motion_vocab_rows)
    vocab_rows.extend(read_tsv(ROOT / "camera_video.tsv"))
    vocab_ids = [row["id"] for row in vocab_rows]
    require(len(vocab_ids) == len(set(vocab_ids)), "Duplicate IDs exist in vocabulary partitions.", errors)

    with (ROOT / "capability_manifest.json").open("r", encoding="utf-8") as stream:
        manifest = json.load(stream)
    require(
        manifest.get("vocabulary_entries") == len(vocab_rows),
        f"capability_manifest.json says {manifest.get('vocabulary_entries')} entries but partitions contain {len(vocab_rows)}.",
        errors,
    )

    capability_rows: list[dict[str, str]] = []
    for filename in CAPABILITY_PARTITIONS:
        capability_rows.extend(read_tsv(ROOT / filename))
    capability_ids = [row["id"] for row in capability_rows]
    require(len(capability_ids) == len(set(capability_ids)), "Duplicate IDs exist in capability partitions.", errors)
    require(
        manifest.get("capability_prompts") == len(capability_rows),
        f"capability_manifest.json says {manifest.get('capability_prompts')} capability prompts but partitions contain {len(capability_rows)}.",
        errors,
    )

    vocab_id_set = set(vocab_ids)
    for row in capability_rows:
        for vocab_id in filter(None, row.get("vocab_ids", "").split(";")):
            require(
                vocab_id in vocab_id_set,
                f"Capability {row['id']} references unknown vocabulary ID {vocab_id}.",
                errors,
            )

    catalog = load_catalog()
    catalog_ids = {row["id"] for row in catalog}
    require(len(catalog_ids) == len(catalog), "Duplicate prompt IDs exist in prompt collection v1.", errors)

    gap_id_preview = {row["id"] for row in read_tsv(ROOT / "semantic_gap_candidates.tsv")}
    known_observation_ids = catalog_ids | gap_id_preview | vocab_id_set | set(capability_ids)

    observations = read_tsv(ROOT / "capability_observations.tsv")
    require(
        manifest.get("capability_observations") == len(observations),
        f"capability_manifest.json says {manifest.get('capability_observations')} observations but file contains {len(observations)}.",
        errors,
    )
    observation_ids = [row["id"] for row in observations]
    require(len(observation_ids) == len(set(observation_ids)), "Duplicate IDs exist in capability observations.", errors)
    for row in observations:
        require(row["id"] in known_observation_ids, f"Observation references unknown catalog/gap ID {row['id']}.", errors)
        require(row["body_support"] in support_labels, f"Unknown body_support in {row['id']}: {row['body_support']}", errors)
        require(
            row["full_request_support"] in support_labels,
            f"Unknown full_request_support in {row['id']}: {row['full_request_support']}",
            errors,
        )
        require(
            row["recommended_route"] in routing_labels,
            f"Unknown recommended_route in {row['id']}: {row['recommended_route']}",
            errors,
        )
        for flag in filter(None, row.get("risk_flags", "").split(";")):
            require(flag in risk_flags, f"Unknown risk flag in {row['id']}: {flag}", errors)

    gaps = read_tsv(ROOT / "semantic_gap_candidates.tsv")
    require(
        manifest.get("semantic_gap_candidates") == len(gaps),
        f"capability_manifest.json says {manifest.get('semantic_gap_candidates')} gaps but file contains {len(gaps)}.",
        errors,
    )
    gap_ids = [row["id"] for row in gaps]
    require(len(gap_ids) == len(set(gap_ids)), "Duplicate IDs exist in semantic gap candidates.", errors)
    overlap = sorted(set(gap_ids) & vocab_id_set)
    require(not overlap, f"Gap candidates already exist in vocabulary: {', '.join(overlap)}", errors)
    for row in gaps:
        require(row["domain"] in domain_ids, f"Unknown gap domain in {row['id']}: {row['domain']}", errors)
        require(row["route_hint"] in routing_labels, f"Unknown gap route in {row['id']}: {row['route_hint']}", errors)
        require(row["priority"] in {"high", "medium", "low"}, f"Unknown priority in {row['id']}: {row['priority']}", errors)
        for flag in filter(None, row.get("risk_flags", "").split(";")):
            require(flag in risk_flags, f"Unknown risk flag in {row['id']}: {flag}", errors)

    paraphrase_file = manifest.get("promoted_anchor_paraphrases_file", "promoted_anchor_paraphrases.tsv")
    paraphrases = read_tsv(ROOT / paraphrase_file)
    paraphrase_ids = [row["id"] for row in paraphrases]
    require(len(paraphrase_ids) == len(set(paraphrase_ids)), "Duplicate IDs exist in promoted anchor paraphrases.", errors)
    require(
        manifest.get("promoted_anchor_paraphrases") == len(paraphrases),
        f"capability_manifest.json says {manifest.get('promoted_anchor_paraphrases')} promoted-anchor paraphrases but file contains {len(paraphrases)}.",
        errors,
    )
    anchor_counts = Counter(row["anchor_id"] for row in paraphrases)
    require(
        manifest.get("promoted_anchor_concepts") == len(anchor_counts),
        f"capability_manifest.json says {manifest.get('promoted_anchor_concepts')} promoted anchors but paraphrases contain {len(anchor_counts)}.",
        errors,
    )
    vocab_by_id = {row["id"]: row for row in motion_vocab_rows}
    for anchor_id, count in anchor_counts.items():
        require(anchor_id in vocab_by_id, f"Promoted anchor paraphrases reference unknown motion vocabulary ID {anchor_id}.", errors)
        require(count == 5, f"Promoted anchor {anchor_id} must have exactly 5 paraphrases, found {count}.", errors)
        rows = [row for row in paraphrases if row["anchor_id"] == anchor_id]
        split_counts = Counter(row["split"] for row in rows)
        require(
            split_counts == Counter({"train": 4, "val": 1}),
            f"Promoted anchor {anchor_id} must have train=4/val=1, found {dict(split_counts)}.",
            errors,
        )
        if anchor_id in vocab_by_id:
            expected_en = vocab_by_id[anchor_id].get("canonical_en", "")
            require(
                all(row["canonical_en"] == expected_en for row in rows),
                f"Promoted anchor {anchor_id} paraphrases do not all match vocabulary canonical_en.",
                errors,
            )
        require(
            len({row["ja"] for row in rows}) == len(rows),
            f"Promoted anchor {anchor_id} contains duplicate Japanese paraphrases.",
            errors,
        )

    category_index_path = (ROOT / manifest.get("motion_category_index", "../adapter/motion_category_index.json")).resolve()
    with category_index_path.open("r", encoding="utf-8") as stream:
        category_index = json.load(stream)
    require(
        category_index.get("schema") == "kimodo-motion-category-index/v1",
        "Motion category index schema is invalid.",
        errors,
    )
    category_ids = {row["id"] for row in category_index.get("categories", [])}
    expected_category_ids = {
        "locomotion", "gesture", "dance", "posture_transition",
        "everyday_activity", "object_interaction", "stunt_athletic",
    }
    require(category_ids == expected_category_ids, "Motion category index categories do not match the UI/runtime contract.", errors)
    category_concepts = list(category_index.get("concepts", []))
    category_concept_ids = [row.get("id", "") for row in category_concepts]
    require(
        manifest.get("motion_category_index_entries") == len(category_concepts),
        f"capability_manifest.json says {manifest.get('motion_category_index_entries')} category-index entries but index contains {len(category_concepts)}.",
        errors,
    )
    require(
        len(category_concept_ids) == len(set(category_concept_ids)),
        "Duplicate IDs exist in motion category index.",
        errors,
    )
    for row in category_concepts:
        require(row.get("id") in vocab_by_id, f"Motion category index references unknown vocabulary ID {row.get('id')}.", errors)
        require(row.get("category") in expected_category_ids, f"Motion category index has unknown category for {row.get('id')}.", errors)
        if row.get("id") in vocab_by_id:
            require(row.get("ja") == vocab_by_id[row["id"]].get("ja"), f"Motion category index Japanese anchor differs for {row['id']}.", errors)
            require(row.get("canonical_en") == vocab_by_id[row["id"]].get("canonical_en"), f"Motion category index canonical_en differs for {row['id']}.", errors)

    print(f"vocabulary_entries={len(vocab_rows)}")
    print(f"motion_vocabulary_entries={len(motion_vocab_rows)}")
    print(f"camera_vocabulary_entries={len(vocab_rows) - len(motion_vocab_rows)}")
    print(f"prompt_collection_v1={len(catalog)}")
    print(f"capability_prompts={len(capability_rows)}")
    print(f"reviewed_observations={len(observations)}")
    print(f"semantic_gap_candidates={len(gaps)}")
    print(f"promoted_anchor_concepts={len(anchor_counts)}")
    print(f"promoted_anchor_paraphrases={len(paraphrases)}")
    print(f"motion_category_index_entries={len(category_concepts)}")
    print("gap_priority=" + json.dumps(Counter(row["priority"] for row in gaps), sort_keys=True))
    print("gap_domains=" + json.dumps(Counter(row["domain"] for row in gaps), sort_keys=True))

    if errors:
        for error in errors:
            print(f"ERROR: {error}")
        return 1
    print("status=ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
