# -*- coding: shift_jis -*-
from __future__ import annotations

import argparse
import json
from collections import Counter
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F

from train_qwen_instruction_bridge import QwenInstructionBridge


def load_rows(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def stats(values: np.ndarray) -> dict:
    if len(values) == 0:
        return {"count": 0}
    return {
        "count": int(len(values)),
        "mean": round(float(values.mean()), 6),
        "median": round(float(np.median(values)), 6),
        "min": round(float(values.min()), 6),
        "max": round(float(values.max()), 6),
        "p95": round(float(np.quantile(values, 0.95)), 6),
        "p99": round(float(np.quantile(values, 0.99)), 6),
    }


def bridge_embeddings(source: np.ndarray, checkpoint: Path) -> np.ndarray:
    ck = torch.load(checkpoint, map_location="cpu", weights_only=False)
    model = QwenInstructionBridge(int(ck["hidden"]), float(ck.get("dropout", 0.0))).eval()
    model.load_state_dict(ck["state_dict"])
    with torch.inference_mode():
        x = F.normalize(torch.from_numpy(source.astype(np.float32)), p=2, dim=1)
        return model(x).cpu().numpy().astype(np.float32)


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--anchor-pairs", type=Path, default=Path("adapter/data/promoted_anchor_pairs.jsonl"))
    p.add_argument("--anchor-v3", type=Path, default=Path("adapter/data/promoted_anchor_qwen_v3.npz"))
    p.add_argument("--existing-pairs", type=Path, default=Path("adapter/data/distill_pairs_v5.jsonl"))
    p.add_argument("--existing-qwen", type=Path, default=Path("adapter/data/qwen_embeddings_v5.npz"))
    p.add_argument("--bridge", type=Path, default=Path("adapter/checkpoints/qwen_bridge_h256.pt"))
    p.add_argument("--thresholds", default="0.75,0.80,0.82,0.84,0.86,0.88,0.90,0.92,0.94")
    p.add_argument("--output", type=Path)
    args = p.parse_args()

    anchor_rows = load_rows(args.anchor_pairs)
    anchor_npz = np.load(args.anchor_v3)
    existing_rows = load_rows(args.existing_pairs)
    existing_npz = np.load(args.existing_qwen)
    if [r["id"] for r in anchor_rows] != anchor_npz["ids"].astype(str).tolist():
        raise SystemExit("anchor alignment mismatch")
    if [r["id"] for r in existing_rows] != existing_npz["ids"].astype(str).tolist():
        raise SystemExit("existing alignment mismatch")

    anchor_x = anchor_npz["embeddings"].astype(np.float32)
    train_idx = np.asarray([i for i, r in enumerate(anchor_rows) if r["split"] == "train"], dtype=np.int64)
    val_idx = np.asarray([i for i, r in enumerate(anchor_rows) if r["split"] == "val"], dtype=np.int64)
    prototypes = anchor_x[train_idx]
    prototype_ids = [anchor_rows[i]["anchor_id"] for i in train_idx]
    prototypes /= np.linalg.norm(prototypes, axis=1, keepdims=True).clip(min=1e-8)

    val_x = anchor_x[val_idx]
    val_x /= np.linalg.norm(val_x, axis=1, keepdims=True).clip(min=1e-8)
    val_sim_matrix = val_x @ prototypes.T
    val_max = val_sim_matrix.max(axis=1)
    val_pred = [prototype_ids[i] for i in val_sim_matrix.argmax(axis=1)]
    val_true = [anchor_rows[i]["anchor_id"] for i in val_idx]
    val_class_correct = np.asarray([a == b for a, b in zip(val_pred, val_true)], dtype=bool)

    existing_x = bridge_embeddings(existing_npz["embeddings"], args.bridge)
    existing_x /= np.linalg.norm(existing_x, axis=1, keepdims=True).clip(min=1e-8)
    chunk = 512
    existing_max_parts = []
    existing_argmax_parts = []
    for start in range(0, len(existing_x), chunk):
        sims = existing_x[start:start + chunk] @ prototypes.T
        existing_max_parts.append(sims.max(axis=1))
        existing_argmax_parts.append(sims.argmax(axis=1))
    existing_max = np.concatenate(existing_max_parts)
    existing_argmax = np.concatenate(existing_argmax_parts)

    splits = np.asarray([r["split"] for r in existing_rows], dtype=str)
    genres = np.asarray([r.get("genre", "") or "" for r in existing_rows], dtype=str)
    sources = np.asarray([r.get("source_dataset", "") or "" for r in existing_rows], dtype=str)
    generic_val = (splits == "val") & (sources == "base_v2")
    specialist_val = (splits == "val") & np.isin(genres, ["glamour_editorial", "idol_cute", "runway_fashion", "dynamic_cute_dance", "bold_sensual"])

    result = {
        "anchor_train_prototypes": int(len(prototypes)),
        "anchor_val": stats(val_max),
        "anchor_val_class_accuracy": round(float(val_class_correct.mean()), 6),
        "existing_all": stats(existing_max),
        "existing_generic_val": stats(existing_max[generic_val]),
        "existing_specialist_val": stats(existing_max[specialist_val]),
        "thresholds": {},
    }
    thresholds = [float(v) for v in args.thresholds.split(",") if v.strip()]
    for threshold in thresholds:
        pos = val_max >= threshold
        row = {
            "anchor_val_recall": round(float(pos.mean()), 6),
            "anchor_val_correct_recall": round(float((pos & val_class_correct).mean()), 6),
            "existing_all_match_rate": round(float((existing_max >= threshold).mean()), 6),
            "generic_val_match_rate": round(float((existing_max[generic_val] >= threshold).mean()), 6),
            "specialist_val_match_rate": round(float((existing_max[specialist_val] >= threshold).mean()), 6),
            "specialist_val_matches_by_genre": {},
        }
        for genre in sorted(set(genres[specialist_val])):
            mask = specialist_val & (genres == genre)
            row["specialist_val_matches_by_genre"][genre] = {
                "count": int(mask.sum()),
                "matched": int((existing_max[mask] >= threshold).sum()),
            }
        result["thresholds"][f"{threshold:.2f}"] = row

    top_negative = np.argsort(existing_max)[-20:][::-1]
    result["top_existing_matches"] = [
        {
            "id": existing_rows[int(i)]["id"],
            "split": existing_rows[int(i)]["split"],
            "genre": existing_rows[int(i)].get("genre"),
            "source_dataset": existing_rows[int(i)].get("source_dataset"),
            "similarity": round(float(existing_max[int(i)]), 6),
            "matched_anchor": prototype_ids[int(existing_argmax[int(i)])],
            "ja": existing_rows[int(i)]["ja"],
        }
        for i in top_negative
    ]

    rendered = json.dumps(result, ensure_ascii=False, indent=2)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered + "\n", encoding="utf-8")
    print(rendered)


if __name__ == "__main__":
    main()
