# -*- coding: shift_jis -*-
from __future__ import annotations

import argparse
import json
import sys
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str((ROOT / "adapter").resolve()))
from routed_text_encoder import RoutedQwenTextEncoder


def load_rows(path: Path) -> list[dict]:
    return [
        json.loads(line)
        for line in path.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pairs", type=Path, default=Path("adapter/data/promoted_anchor_pairs.jsonl"))
    parser.add_argument("--teacher", type=Path, default=Path("adapter/data/promoted_anchor_teacher.npz"))
    parser.add_argument("--qwen-dir", type=Path, default=Path("models/qwen3-embedding-0.6b"))
    parser.add_argument("--bridge", type=Path, default=Path("adapter/checkpoints/qwen_bridge_h256.pt"))
    parser.add_argument("--base-adapter", type=Path, default=Path("adapter/checkpoints/adapter_v3_instruct_h512.pt"))
    parser.add_argument("--router", type=Path, default=Path("adapter/checkpoints/domain_router_h128.pt"))
    parser.add_argument("--expert-dir", type=Path, default=Path("adapter/checkpoints"))
    parser.add_argument("--anchor-residual", type=Path)
    parser.add_argument("--anchor-gate", type=Path)
    parser.add_argument("--anchor-gate-threshold", type=float, default=0.80)
    parser.add_argument("--threshold", type=float, default=0.80)
    parser.add_argument("--batch-size", type=int, default=20)
    parser.add_argument("--worst", type=int, default=12)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()

    if not torch.cuda.is_available():
        raise SystemExit("CUDA unavailable")

    rows = load_rows(args.pairs)
    teacher_npz = np.load(args.teacher)
    teacher_ids = teacher_npz["ids"].astype(str).tolist()
    row_ids = [row["id"] for row in rows]
    if teacher_ids != row_ids:
        raise SystemExit("Teacher IDs do not match pair order")
    teacher = torch.from_numpy(teacher_npz["embeddings"].astype(np.float32)).to("cuda")

    encoder = RoutedQwenTextEncoder(
        qwen_dir=args.qwen_dir,
        bridge_path=args.bridge,
        base_adapter_path=args.base_adapter,
        router_path=args.router,
        expert_dir=args.expert_dir,
        anchor_residual_path=args.anchor_residual,
        anchor_gate_path=args.anchor_gate,
        anchor_gate_threshold=args.anchor_gate_threshold,
        device="cuda",
        threshold=args.threshold,
    )
    encoder.clear_route_history()

    predicted = []
    with torch.inference_mode():
        for start in range(0, len(rows), args.batch_size):
            batch = rows[start : start + args.batch_size]
            emb, _ = encoder([row["ja"] for row in batch])
            predicted.append(emb[:, 0, :].float())
    pred = torch.cat(predicted, dim=0)
    cosine = F.cosine_similarity(pred, teacher, dim=1).detach().cpu().numpy()

    split_metrics = {}
    for split in ("train", "val"):
        idx = [i for i, row in enumerate(rows) if row["split"] == split]
        values = cosine[idx]
        split_metrics[split] = {
            "count": len(idx),
            "mean": round(float(values.mean()), 6),
            "median": round(float(np.median(values)), 6),
            "min": round(float(values.min()), 6),
        }

    by_anchor = defaultdict(list)
    for index, row in enumerate(rows):
        by_anchor[row["anchor_id"]].append(float(cosine[index]))
    anchor_metrics = {
        anchor: {
            "mean": round(float(np.mean(values)), 6),
            "min": round(float(np.min(values)), 6),
        }
        for anchor, values in sorted(by_anchor.items())
    }

    worst_indices = np.argsort(cosine)[: args.worst]
    worst = [
        {
            "id": rows[int(i)]["id"],
            "anchor_id": rows[int(i)]["anchor_id"],
            "split": rows[int(i)]["split"],
            "cosine": round(float(cosine[int(i)]), 6),
            "ja": rows[int(i)]["ja"],
            "en": rows[int(i)]["en"],
            "route": encoder.route_history[int(i)]["selected_domain"],
            "route_probability": round(float(encoder.route_history[int(i)]["probability"]), 6),
        }
        for i in worst_indices
    ]

    route_counts = Counter(route["selected_domain"] for route in encoder.route_history)
    report = {
        "rows": len(rows),
        "anchors": len(by_anchor),
        "threshold": args.threshold,
        "anchor_residual": str(args.anchor_residual) if args.anchor_residual else None,
        "anchor_gate": str(args.anchor_gate) if args.anchor_gate else None,
        "anchor_gate_threshold": args.anchor_gate_threshold,
        "overall": {
            "mean": round(float(cosine.mean()), 6),
            "median": round(float(np.median(cosine)), 6),
            "min": round(float(cosine.min()), 6),
            "max": round(float(cosine.max()), 6),
        },
        "splits": split_metrics,
        "route_counts": dict(route_counts),
        "anchors_by_mean": dict(sorted(anchor_metrics.items(), key=lambda item: item[1]["mean"])),
        "worst": worst,
    }

    rendered = json.dumps(report, ensure_ascii=False, indent=2)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered + "\n", encoding="utf-8")
    print(rendered)


if __name__ == "__main__":
    main()
