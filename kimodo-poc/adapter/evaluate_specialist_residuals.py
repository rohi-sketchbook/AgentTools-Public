import argparse
import json
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F


GENRES = [
    "glamour_editorial",
    "idol_cute",
    "runway_fashion",
    "dynamic_cute_dance",
    "bold_sensual",
]


class QwenInstructionBridge(torch.nn.Module):
    def __init__(self, hidden: int, dropout: float = 0.0) -> None:
        super().__init__()
        self.net = torch.nn.Sequential(
            torch.nn.Linear(1024, hidden), torch.nn.GELU(), torch.nn.Dropout(dropout), torch.nn.Linear(hidden, 1024)
        )
        self.scale = torch.nn.Parameter(torch.tensor(0.1, dtype=torch.float32))

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return F.normalize(x + self.scale * self.net(x), p=2, dim=1)


class MotionAdapter(torch.nn.Module):
    def __init__(self, hidden: int, dropout: float = 0.0) -> None:
        super().__init__()
        self.net = torch.nn.Sequential(
            torch.nn.Linear(1024, hidden), torch.nn.GELU(), torch.nn.Dropout(dropout), torch.nn.Linear(hidden, 4096)
        ) if hidden > 0 else torch.nn.Linear(1024, 4096)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.net(x)


class SpecialistResidual(torch.nn.Module):
    def __init__(self, hidden: int, dropout: float = 0.0) -> None:
        super().__init__()
        self.fc1 = torch.nn.Linear(1024, hidden)
        self.fc2 = torch.nn.Linear(hidden, 4096)
        self.dropout = torch.nn.Dropout(dropout)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.fc2(self.dropout(F.gelu(self.fc1(x))))


def summary(cos: torch.Tensor) -> dict:
    return {
        "count": int(len(cos)),
        "mean": float(cos.mean().item()),
        "median": float(cos.median().item()),
        "min": float(cos.min().item()),
        "max": float(cos.max().item()),
    }


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--pairs", type=Path, required=True)
    p.add_argument("--qwen", type=Path, required=True)
    p.add_argument("--teacher", type=Path, required=True)
    p.add_argument("--bridge", type=Path, required=True)
    p.add_argument("--base-adapter", type=Path, required=True)
    p.add_argument("--checkpoint-dir", type=Path, required=True)
    p.add_argument("--suffix", default="h128")
    args = p.parse_args()

    rows = [json.loads(line) for line in args.pairs.read_text(encoding="utf-8").splitlines() if line.strip()]
    q = np.load(args.qwen)
    t = np.load(args.teacher)
    ids = q["ids"].astype(str)
    splits = q["splits"].astype(str)
    if len(rows) != len(ids) or not np.array_equal(ids, t["ids"].astype(str)):
        raise SystemExit("alignment mismatch")
    genres = np.asarray([row.get("genre", "") or "" for row in rows], dtype=str)
    sources = np.asarray([row.get("source_dataset", "") or "" for row in rows], dtype=str)

    x0 = F.normalize(torch.from_numpy(q["embeddings"].astype(np.float32)), p=2, dim=1)
    y = torch.from_numpy(t["embeddings"].astype(np.float32))

    bck = torch.load(args.bridge, map_location="cpu", weights_only=False)
    bridge = QwenInstructionBridge(int(bck["hidden"]), float(bck.get("dropout", 0.0))).eval()
    bridge.load_state_dict(bck["state_dict"])

    ack = torch.load(args.base_adapter, map_location="cpu", weights_only=False)
    base = MotionAdapter(int(ack["hidden"]), float(ack.get("dropout", 0.0))).eval()
    base.load_state_dict(ack["state_dict"])
    mean = torch.as_tensor(ack["teacher_mean"], dtype=torch.float32)
    std = torch.as_tensor(ack["teacher_std"], dtype=torch.float32)

    with torch.inference_mode():
        x = bridge(x0)
        base_z = base(x)
        base_y = base_z * std + mean
        base_cos_all = F.cosine_similarity(base_y, y, dim=1)

    generic_val_idx = np.where((splits == "val") & (sources == "base_v2"))[0]
    generic_test_idx = np.where(splits == "test")[0]
    result = {
        "router_off_generic_is_exact_base": True,
        "generic_val_base": summary(base_cos_all[generic_val_idx]) if len(generic_val_idx) else None,
        "generic_test_base": summary(base_cos_all[generic_test_idx]) if len(generic_test_idx) else None,
        "experts": {},
    }

    for genre in GENRES:
        path = args.checkpoint_dir / f"residual_{genre}_{args.suffix}.pt"
        ck = torch.load(path, map_location="cpu", weights_only=False)
        expert = SpecialistResidual(int(ck["hidden"]), float(ck.get("dropout", 0.0))).eval()
        expert.load_state_dict(ck["state_dict"])
        val_idx_np = np.where((splits == "val") & (genres == genre))[0]
        val_idx = torch.as_tensor(val_idx_np, dtype=torch.long)
        generic_val = torch.as_tensor(generic_val_idx, dtype=torch.long)
        with torch.inference_mode():
            residual_val_z = expert(x[val_idx])
            expert_y = (base_z[val_idx] + residual_val_z) * std + mean
            expert_cos = F.cosine_similarity(expert_y, y[val_idx], dim=1)
            base_cos = base_cos_all[val_idx]
            if len(generic_val):
                forced_z = expert(x[generic_val])
                forced_y = (base_z[generic_val] + forced_z) * std + mean
                forced_cos = F.cosine_similarity(forced_y, y[generic_val], dim=1)
                forced_delta = forced_cos - base_cos_all[generic_val]
            else:
                forced_cos = forced_delta = torch.empty(0)
            residual_norm = torch.linalg.vector_norm(residual_val_z * std, dim=1)
            base_norm = torch.linalg.vector_norm(base_y[val_idx], dim=1)
        result["experts"][genre] = {
            "checkpoint": str(path),
            "parameters": sum(p.numel() for p in expert.parameters()),
            "specialist_val_base": summary(base_cos),
            "specialist_val_expert": summary(expert_cos),
            "specialist_delta_mean": float((expert_cos - base_cos).mean().item()),
            "specialist_improved_fraction": float((expert_cos > base_cos).float().mean().item()),
            "forced_on_generic_val": summary(forced_cos) if len(forced_cos) else None,
            "forced_on_generic_delta_mean": float(forced_delta.mean().item()) if len(forced_delta) else None,
            "residual_to_base_norm_ratio_mean": float((residual_norm / base_norm).mean().item()),
        }

    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
