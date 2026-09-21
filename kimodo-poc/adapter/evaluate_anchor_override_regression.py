# -*- coding: shift_jis -*-
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F

from train_domain_router import CLASSES, DomainRouter
from train_qwen_instruction_bridge import QwenInstructionBridge
from train_specialist_residual import MotionAdapter, SpecialistResidual

SPECIALIST_GENRES = {"glamour_editorial", "idol_cute", "runway_fashion", "dynamic_cute_dance", "bold_sensual"}


def load_rows(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def cos_stats(values: torch.Tensor) -> dict:
    return {
        "count": int(values.numel()),
        "mean": float(values.mean().item()) if values.numel() else None,
        "median": float(values.median().item()) if values.numel() else None,
        "min": float(values.min().item()) if values.numel() else None,
        "max": float(values.max().item()) if values.numel() else None,
    }


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--pairs", type=Path, default=Path("adapter/data/distill_pairs_v5.jsonl"))
    p.add_argument("--qwen", type=Path, default=Path("adapter/data/qwen_embeddings_v5.npz"))
    p.add_argument("--teacher", type=Path, default=Path("adapter/data/teacher_embeddings_v5.npz"))
    p.add_argument("--bridge", type=Path, default=Path("adapter/checkpoints/qwen_bridge_h256.pt"))
    p.add_argument("--base-adapter", type=Path, default=Path("adapter/checkpoints/adapter_v3_instruct_h512.pt"))
    p.add_argument("--router", type=Path, default=Path("adapter/checkpoints/domain_router_h128.pt"))
    p.add_argument("--expert-dir", type=Path, default=Path("adapter/checkpoints"))
    p.add_argument("--anchor-residual", type=Path, default=Path("adapter/checkpoints/promoted_anchor_residual_h128.pt"))
    p.add_argument("--anchor-v3", type=Path, default=Path("adapter/data/promoted_anchor_qwen_v3.npz"))
    p.add_argument("--anchor-pairs", type=Path, default=Path("adapter/data/promoted_anchor_pairs.jsonl"))
    p.add_argument("--anchor-threshold", type=float, default=0.90)
    p.add_argument("--router-threshold", type=float, default=0.80)
    p.add_argument("--output", type=Path)
    args = p.parse_args()

    rows = load_rows(args.pairs)
    q = np.load(args.qwen)
    t = np.load(args.teacher)
    if [r["id"] for r in rows] != q["ids"].astype(str).tolist() or not np.array_equal(q["ids"].astype(str), t["ids"].astype(str)):
        raise SystemExit("existing alignment mismatch")

    anchor_rows = load_rows(args.anchor_pairs)
    anchor_npz = np.load(args.anchor_v3)
    if [r["id"] for r in anchor_rows] != anchor_npz["ids"].astype(str).tolist():
        raise SystemExit("anchor alignment mismatch")
    anchor_train_idx = [i for i, r in enumerate(anchor_rows) if r["split"] == "train"]
    prototypes = torch.from_numpy(anchor_npz["embeddings"][anchor_train_idx].astype(np.float32))
    prototypes = F.normalize(prototypes, p=2, dim=1)
    prototype_anchor_ids = [anchor_rows[i]["anchor_id"] for i in anchor_train_idx]

    source_x = F.normalize(torch.from_numpy(q["embeddings"].astype(np.float32)), p=2, dim=1)
    y = torch.from_numpy(t["embeddings"].astype(np.float32))

    bck = torch.load(args.bridge, map_location="cpu", weights_only=False)
    bridge = QwenInstructionBridge(int(bck["hidden"]), float(bck.get("dropout", 0.0))).eval()
    bridge.load_state_dict(bck["state_dict"])
    ack = torch.load(args.base_adapter, map_location="cpu", weights_only=False)
    base = MotionAdapter(int(ack["hidden"]), float(ack.get("dropout", 0.0))).eval()
    base.load_state_dict(ack["state_dict"])
    mean = torch.as_tensor(ack["teacher_mean"], dtype=torch.float32)
    std = torch.as_tensor(ack["teacher_std"], dtype=torch.float32)
    rck = torch.load(args.router, map_location="cpu", weights_only=False)
    router = DomainRouter(int(rck["hidden"]), float(rck.get("dropout", 0.0))).eval()
    router.load_state_dict(rck["state_dict"])
    arck = torch.load(args.anchor_residual, map_location="cpu", weights_only=False)
    anchor = SpecialistResidual(int(arck["hidden"]), float(arck.get("dropout", 0.0))).eval()
    anchor.load_state_dict(arck["state_dict"])

    experts: dict[str, SpecialistResidual] = {}
    for genre in SPECIALIST_GENRES:
        eck = torch.load(args.expert_dir / f"residual_{genre}_h128.pt", map_location="cpu", weights_only=False)
        expert = SpecialistResidual(int(eck["hidden"]), float(eck.get("dropout", 0.0))).eval()
        expert.load_state_dict(eck["state_dict"])
        experts[genre] = expert

    with torch.inference_mode():
        v3_x = bridge(source_x)
        base_z = base(v3_x)
        probs = torch.softmax(router(source_x), dim=1)
        top_prob, top_id = probs.max(dim=1)
        baseline_z = base_z.clone()
        selected_domains = []
        for i in range(len(rows)):
            predicted = CLASSES[int(top_id[i].item())]
            probability = float(top_prob[i].item())
            if predicted != "generic" and probability >= args.router_threshold:
                selected = predicted
                baseline_z[i:i+1] += experts[selected](v3_x[i:i+1])
            else:
                selected = "generic"
            selected_domains.append(selected)

        similarity = v3_x @ prototypes.T
        max_similarity, max_index = similarity.max(dim=1)
        matched = max_similarity >= args.anchor_threshold
        override_z = baseline_z.clone()
        if matched.any():
            idx = torch.where(matched)[0]
            override_z[idx] = base_z[idx] + anchor(v3_x[idx])

        baseline_y = baseline_z * std + mean
        override_y = override_z * std + mean
        baseline_cos = F.cosine_similarity(baseline_y, y, dim=1)
        override_cos = F.cosine_similarity(override_y, y, dim=1)
        delta = override_cos - baseline_cos

    splits = np.asarray([r["split"] for r in rows], dtype=str)
    sources = np.asarray([r.get("source_dataset", "") or "" for r in rows], dtype=str)
    genres = np.asarray([r.get("genre", "") or "" for r in rows], dtype=str)
    selected_np = np.asarray(selected_domains, dtype=str)
    matched_np = matched.numpy()

    def subset(mask: np.ndarray) -> dict:
        idx = torch.as_tensor(np.where(mask)[0], dtype=torch.long)
        if len(idx) == 0:
            return {"count": 0}
        d = delta[idx]
        return {
            "count": int(len(idx)),
            "baseline": cos_stats(baseline_cos[idx]),
            "override": cos_stats(override_cos[idx]),
            "delta_mean": float(d.mean().item()),
            "delta_min": float(d.min().item()),
            "improved_fraction": float((d > 0).float().mean().item()),
        }

    result = {
        "anchor_threshold": args.anchor_threshold,
        "router_threshold": args.router_threshold,
        "matched_count": int(matched.sum().item()),
        "matched_rate": float(matched.float().mean().item()),
        "all": subset(np.ones(len(rows), dtype=bool)),
        "validation": subset(splits == "val"),
        "generic_validation": subset((splits == "val") & (sources == "base_v2")),
        "specialist_validation": subset((splits == "val") & np.isin(genres, list(SPECIALIST_GENRES))),
        "runtime_selected_specialist_validation": subset((splits == "val") & (selected_np != "generic")),
        "matched": subset(matched_np),
        "matched_rows": [],
    }
    matched_indices = np.where(matched_np)[0]
    for i in matched_indices:
        result["matched_rows"].append({
            "id": rows[int(i)]["id"],
            "split": rows[int(i)]["split"],
            "genre": rows[int(i)].get("genre"),
            "source_dataset": rows[int(i)].get("source_dataset"),
            "selected_domain": selected_domains[int(i)],
            "similarity": float(max_similarity[int(i)].item()),
            "matched_anchor": prototype_anchor_ids[int(max_index[int(i)].item())],
            "baseline_cos": float(baseline_cos[int(i)].item()),
            "override_cos": float(override_cos[int(i)].item()),
            "delta": float(delta[int(i)].item()),
            "ja": rows[int(i)]["ja"],
        })
    result["matched_rows"].sort(key=lambda r: r["delta"])

    rendered = json.dumps(result, ensure_ascii=False, indent=2)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered + "\n", encoding="utf-8")
    print(rendered)


if __name__ == "__main__":
    main()
