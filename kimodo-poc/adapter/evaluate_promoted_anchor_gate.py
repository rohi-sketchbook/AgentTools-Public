# -*- coding: shift_jis -*-
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F

from train_promoted_anchor_gate import PromotedAnchorGate
from train_qwen_instruction_bridge import QwenInstructionBridge


def load_rows(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--anchor-pairs", type=Path, default=Path("adapter/data/promoted_anchor_pairs.jsonl"))
    p.add_argument("--anchor-v3", type=Path, default=Path("adapter/data/promoted_anchor_qwen_v3.npz"))
    p.add_argument("--existing-pairs", type=Path, default=Path("adapter/data/distill_pairs_v5.jsonl"))
    p.add_argument("--existing-qwen", type=Path, default=Path("adapter/data/qwen_embeddings_v5.npz"))
    p.add_argument("--bridge", type=Path, default=Path("adapter/checkpoints/qwen_bridge_h256.pt"))
    p.add_argument("--gate", type=Path, default=Path("adapter/checkpoints/promoted_anchor_gate_h64.pt"))
    p.add_argument("--thresholds", default="0.70,0.75,0.80,0.85,0.90")
    p.add_argument("--output", type=Path)
    args = p.parse_args()

    anchor_rows = load_rows(args.anchor_pairs)
    anchor_npz = np.load(args.anchor_v3)
    existing_rows = load_rows(args.existing_pairs)
    existing_npz = np.load(args.existing_qwen)

    bck = torch.load(args.bridge, map_location="cpu", weights_only=False)
    bridge = QwenInstructionBridge(int(bck["hidden"]), float(bck.get("dropout", 0.0))).eval()
    bridge.load_state_dict(bck["state_dict"])
    gck = torch.load(args.gate, map_location="cpu", weights_only=False)
    gate = PromotedAnchorGate(int(gck["hidden"]), float(gck.get("dropout", 0.0))).eval()
    gate.load_state_dict(gck["state_dict"])

    with torch.inference_mode():
        anchor_x = torch.from_numpy(anchor_npz["embeddings"].astype(np.float32))
        anchor_prob = torch.sigmoid(gate(anchor_x)).numpy()
        source = F.normalize(torch.from_numpy(existing_npz["embeddings"].astype(np.float32)), p=2, dim=1)
        existing_v3 = bridge(source)
        existing_prob = torch.sigmoid(gate(existing_v3)).numpy()

    anchor_splits = np.asarray([r["split"] for r in anchor_rows], dtype=str)
    existing_splits = np.asarray([r["split"] for r in existing_rows], dtype=str)
    genres = np.asarray([r.get("genre", "") or "" for r in existing_rows], dtype=str)

    result = {
        "checkpoint_threshold": float(gck.get("threshold", 0.0)),
        "anchor_probability": {
            "min": float(anchor_prob.min()),
            "mean": float(anchor_prob.mean()),
            "val_min": float(anchor_prob[anchor_splits == "val"].min()),
        },
        "existing_probability": {
            "max": float(existing_prob.max()),
            "mean": float(existing_prob.mean()),
            "val_max": float(existing_prob[existing_splits == "val"].max()),
        },
        "thresholds": {},
    }
    for threshold in [float(x) for x in args.thresholds.split(",") if x.strip()]:
        matched = existing_prob >= threshold
        result["thresholds"][f"{threshold:.2f}"] = {
            "anchor_all_recall": float((anchor_prob >= threshold).mean()),
            "anchor_val_recall": float((anchor_prob[anchor_splits == "val"] >= threshold).mean()),
            "existing_all_false_positive_count": int(matched.sum()),
            "existing_val_false_positive_count": int((matched & (existing_splits == "val")).sum()),
            "existing_specialist_val_false_positive_count": int((matched & (existing_splits == "val") & (genres != "")).sum()),
        }

    top = np.argsort(existing_prob)[-20:][::-1]
    result["top_existing"] = [
        {
            "id": existing_rows[int(i)]["id"],
            "split": existing_rows[int(i)]["split"],
            "genre": existing_rows[int(i)].get("genre"),
            "probability": float(existing_prob[int(i)]),
            "ja": existing_rows[int(i)]["ja"],
        }
        for i in top
    ]
    rendered = json.dumps(result, ensure_ascii=False, indent=2)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered + "\n", encoding="utf-8")
    print(rendered)


if __name__ == "__main__":
    main()
