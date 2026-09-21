from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F
from transformers import AutoModel, AutoTokenizer

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str((ROOT / "adapter").resolve()))
from train_qwen_instruction_bridge import QwenInstructionBridge
from train_specialist_residual import MotionAdapter, SpecialistResidual

DEFAULT_INSTRUCTION = "Map Japanese human motion descriptions into a semantic space for full-body motion generation."
CATEGORY_LABELS = {
    "locomotion": "移動",
    "gesture": "ジェスチャー",
    "dance": "ダンス",
    "posture_transition": "姿勢・遷移",
    "everyday_activity": "日常動作",
    "object_interaction": "物体操作",
    "stunt_athletic": "アクロバット",
}


def category_for(anchor_id: str) -> str:
    if anchor_id.startswith("locomotion_"):
        return "locomotion"
    if anchor_id.startswith("dance_"):
        return "dance"
    if anchor_id.startswith("transition_"):
        return "posture_transition"
    return "gesture"


def load_rows(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--pairs", type=Path, default=Path("adapter/data/promoted_anchor_pairs.jsonl"))
    p.add_argument("--teacher", type=Path, default=Path("adapter/data/promoted_anchor_teacher.npz"))
    p.add_argument("--qwen-dir", type=Path, default=Path("models/qwen3-embedding-0.6b"))
    p.add_argument("--bridge", type=Path, default=Path("adapter/checkpoints/qwen_bridge_h256.pt"))
    p.add_argument("--base-adapter", type=Path, default=Path("adapter/checkpoints/adapter_v3_instruct_h512.pt"))
    p.add_argument("--anchor-residual", type=Path, default=Path("adapter/checkpoints/promoted_anchor_residual_h128.pt"))
    p.add_argument("--batch-size", type=int, default=32)
    args = p.parse_args()

    if not torch.cuda.is_available():
        raise SystemExit("CUDA unavailable")

    rows = load_rows(args.pairs)
    teacher_npz = np.load(args.teacher)
    if teacher_npz["ids"].astype(str).tolist() != [r["id"] for r in rows]:
        raise SystemExit("teacher alignment mismatch")

    device = torch.device("cuda")
    tokenizer = AutoTokenizer.from_pretrained(str(args.qwen_dir.resolve()), local_files_only=True, trust_remote_code=False, padding_side="left")
    qwen = AutoModel.from_pretrained(str(args.qwen_dir.resolve()), local_files_only=True, trust_remote_code=False, use_safetensors=True).to(device).eval()

    bck = torch.load(args.bridge, map_location="cpu", weights_only=False)
    bridge = QwenInstructionBridge(int(bck["hidden"]), float(bck.get("dropout", 0.0))).to(device).eval()
    bridge.load_state_dict(bck["state_dict"])
    ack = torch.load(args.base_adapter, map_location="cpu", weights_only=False)
    base = MotionAdapter(int(ack["hidden"]), float(ack.get("dropout", 0.0))).to(device).eval()
    base.load_state_dict(ack["state_dict"])
    mean = torch.as_tensor(ack["teacher_mean"], dtype=torch.float32, device=device)
    std = torch.as_tensor(ack["teacher_std"], dtype=torch.float32, device=device)
    rck = torch.load(args.anchor_residual, map_location="cpu", weights_only=False)
    residual = SpecialistResidual(int(rck["hidden"]), float(rck.get("dropout", 0.0))).to(device).eval()
    residual.load_state_dict(rck["state_dict"])

    def encode(texts: list[str]) -> torch.Tensor:
        wrapped = [f"Instruct: {DEFAULT_INSTRUCTION}\nQuery:{text}" for text in texts]
        tokens = tokenizer(wrapped, return_tensors="pt", padding=True, truncation=True, max_length=256).to(device)
        with torch.inference_mode():
            hidden = qwen(**tokens).last_hidden_state
            return F.normalize(hidden[:, -1], p=2, dim=1).float()

    base_sources = []
    hint_sources = []
    for start in range(0, len(rows), args.batch_size):
        batch = rows[start:start + args.batch_size]
        texts = [r["ja"] for r in batch]
        hinted = [f"動作カテゴリ: {CATEGORY_LABELS[category_for(r['anchor_id'])]}。\n動作指示: {r['ja']}" for r in batch]
        base_sources.append(encode(texts))
        hint_sources.append(encode(hinted))
    source = torch.cat(base_sources, dim=0)
    hinted = torch.cat(hint_sources, dim=0)
    teacher = torch.from_numpy(teacher_npz["embeddings"].astype(np.float32)).to(device)
    val_idx = torch.as_tensor([i for i, r in enumerate(rows) if r["split"] == "val"], device=device, dtype=torch.long)

    result = {"category_text_blend": {}, "nearest_concept_blend": {}}
    with torch.inference_mode():
        for alpha in (0.0, 0.05, 0.10, 0.15, 0.20, 0.30):
            mixed = F.normalize((1.0 - alpha) * source + alpha * hinted, p=2, dim=1)
            v3 = bridge(mixed)
            z = base(v3) + residual(v3)
            pred = z * std + mean
            cos = F.cosine_similarity(pred, teacher, dim=1)
            values = cos[val_idx]
            by_category = defaultdict(list)
            for i in val_idx.detach().cpu().numpy().tolist():
                by_category[category_for(rows[i]["anchor_id"])].append(float(cos[i].item()))
            result["category_text_blend"][f"{alpha:.2f}"] = {
                "val_mean": round(float(values.mean().item()), 6),
                "val_min": round(float(values.min().item()), 6),
                "by_category": {k: round(float(np.mean(v)), 6) for k, v in sorted(by_category.items())},
            }

        prototype_indices = [i for i, row in enumerate(rows) if row["id"].endswith("_v0")]
        proto_source = source[prototype_indices]
        proto_categories = [category_for(rows[i]["anchor_id"]) for i in prototype_indices]
        proto_anchor_ids = [rows[i]["anchor_id"] for i in prototype_indices]
        nearest = source.clone()
        retrieval_correct = 0
        retrieval_total = 0
        retrieval_similarity = []
        for i in val_idx.detach().cpu().numpy().tolist():
            category = category_for(rows[i]["anchor_id"])
            candidates = [j for j, value in enumerate(proto_categories) if value == category]
            sims = F.cosine_similarity(source[i:i + 1], proto_source[candidates], dim=1)
            best_local = int(sims.argmax().item())
            best = candidates[best_local]
            nearest[i] = proto_source[best]
            retrieval_total += 1
            retrieval_correct += int(proto_anchor_ids[best] == rows[i]["anchor_id"])
            retrieval_similarity.append(float(sims[best_local].item()))

        for alpha in (0.05, 0.10, 0.15, 0.20, 0.30, 0.40):
            mixed = F.normalize((1.0 - alpha) * source + alpha * nearest, p=2, dim=1)
            v3 = bridge(mixed)
            z = base(v3) + residual(v3)
            pred = z * std + mean
            cos = F.cosine_similarity(pred, teacher, dim=1)
            values = cos[val_idx]
            result["nearest_concept_blend"][f"{alpha:.2f}"] = {
                "val_mean": round(float(values.mean().item()), 6),
                "val_min": round(float(values.min().item()), 6),
                "retrieval_accuracy": round(retrieval_correct / retrieval_total, 6),
                "retrieval_similarity_mean": round(float(np.mean(retrieval_similarity)), 6),
                "retrieval_similarity_min": round(float(np.min(retrieval_similarity)), 6),
            }
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
