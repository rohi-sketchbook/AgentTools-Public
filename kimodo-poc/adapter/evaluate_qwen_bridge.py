import argparse
import json
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F


class QwenInstructionBridge(torch.nn.Module):
    def __init__(self, hidden: int, dropout: float = 0.0) -> None:
        super().__init__()
        self.net = torch.nn.Sequential(
            torch.nn.Linear(1024, hidden),
            torch.nn.GELU(),
            torch.nn.Dropout(dropout),
            torch.nn.Linear(hidden, 1024),
        )
        self.scale = torch.nn.Parameter(torch.tensor(0.1, dtype=torch.float32))

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return F.normalize(x + self.scale * self.net(x), p=2, dim=1)


class MotionAdapter(torch.nn.Module):
    def __init__(self, hidden: int, dropout: float = 0.0) -> None:
        super().__init__()
        self.net = torch.nn.Sequential(
            torch.nn.Linear(1024, hidden),
            torch.nn.GELU(),
            torch.nn.Dropout(dropout),
            torch.nn.Linear(hidden, 4096),
        ) if hidden > 0 else torch.nn.Linear(1024, 4096)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.net(x)


def stats(cos: torch.Tensor) -> dict:
    return {
        "mean": float(cos.mean().item()),
        "median": float(cos.median().item()),
        "min": float(cos.min().item()),
        "max": float(cos.max().item()),
    }


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--source", type=Path, required=True)
    p.add_argument("--target-qwen", type=Path, required=True)
    p.add_argument("--bridge", type=Path, required=True)
    p.add_argument("--base-adapter", type=Path, required=True)
    p.add_argument("--teacher", type=Path, required=True)
    args = p.parse_args()

    src = np.load(args.source)
    tgt = np.load(args.target_qwen)
    tea = np.load(args.teacher)
    if not np.array_equal(src["ids"], tgt["ids"]) or not np.array_equal(src["ids"], tea["ids"]):
        raise SystemExit("ID mismatch")

    x = F.normalize(torch.from_numpy(src["embeddings"].astype(np.float32)), p=2, dim=1)
    q_target = F.normalize(torch.from_numpy(tgt["embeddings"].astype(np.float32)), p=2, dim=1)
    y = torch.from_numpy(tea["embeddings"].astype(np.float32))

    bck = torch.load(args.bridge, map_location="cpu", weights_only=False)
    bridge = QwenInstructionBridge(int(bck["hidden"]), float(bck.get("dropout", 0.0))).eval()
    bridge.load_state_dict(bck["state_dict"])

    ack = torch.load(args.base_adapter, map_location="cpu", weights_only=False)
    adapter = MotionAdapter(int(ack["hidden"]), float(ack.get("dropout", 0.0))).eval()
    adapter.load_state_dict(ack["state_dict"])
    mean = torch.as_tensor(ack["teacher_mean"], dtype=torch.float32)
    std = torch.as_tensor(ack["teacher_std"], dtype=torch.float32)

    with torch.inference_mode():
        xb = bridge(x)
        direct_qwen_cos = F.cosine_similarity(x, q_target, dim=1)
        bridge_qwen_cos = F.cosine_similarity(xb, q_target, dim=1)
        direct_teacher = adapter(x) * std + mean
        bridge_teacher = adapter(xb) * std + mean
        target_teacher = adapter(q_target) * std + mean
        direct_teacher_cos = F.cosine_similarity(direct_teacher, y, dim=1)
        bridge_teacher_cos = F.cosine_similarity(bridge_teacher, y, dim=1)
        saved_v3_teacher_cos = F.cosine_similarity(target_teacher, y, dim=1)

    print(json.dumps({
        "count": len(x),
        "qwen_source_to_saved_v3": stats(direct_qwen_cos),
        "qwen_bridge_to_saved_v3": stats(bridge_qwen_cos),
        "teacher_cos_source_direct_v3_adapter": stats(direct_teacher_cos),
        "teacher_cos_bridge_v3_adapter": stats(bridge_teacher_cos),
        "teacher_cos_saved_v3_qwen_v3_adapter": stats(saved_v3_teacher_cos),
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
