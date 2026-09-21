import argparse
import json
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F


class MotionAdapter(torch.nn.Module):
    def __init__(self, hidden: int, dropout: float = 0.0) -> None:
        super().__init__()
        if hidden <= 0:
            self.net = torch.nn.Linear(1024, 4096)
        else:
            self.net = torch.nn.Sequential(
                torch.nn.Linear(1024, hidden),
                torch.nn.GELU(),
                torch.nn.Dropout(dropout),
                torch.nn.Linear(hidden, 4096),
            )

    def forward(self, x):
        return self.net(x)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--pairs", type=Path, required=True)
    p.add_argument("--qwen", type=Path, required=True)
    p.add_argument("--teacher", type=Path, required=True)
    p.add_argument("--adapter", type=Path, required=True)
    p.add_argument("--split", default="val")
    p.add_argument("--worst", type=int, default=12)
    args = p.parse_args()

    rows = [json.loads(line) for line in args.pairs.read_text(encoding="utf-8").splitlines() if line.strip()]
    q = np.load(args.qwen)
    t = np.load(args.teacher)
    ckpt = torch.load(args.adapter, map_location="cpu", weights_only=False)
    model = MotionAdapter(int(ckpt["hidden"]), float(ckpt.get("dropout", 0.0))).eval()
    model.load_state_dict(ckpt["state_dict"])
    mean = torch.as_tensor(ckpt["teacher_mean"], dtype=torch.float32)
    std = torch.as_tensor(ckpt["teacher_std"], dtype=torch.float32)
    x = torch.from_numpy(q["embeddings"].astype(np.float32))
    y = torch.from_numpy(t["embeddings"].astype(np.float32))
    splits = q["splits"].astype(str)

    with torch.inference_mode():
        pred = model(x) * std + mean
        cos = F.cosine_similarity(pred, y, dim=1).numpy()

    idxs = np.where(splits == args.split)[0]
    idxs = idxs[np.argsort(cos[idxs])]
    out = []
    for idx in idxs[: args.worst]:
        row = rows[int(idx)]
        out.append({
            "id": row["id"],
            "kind": row["kind"],
            "cosine": round(float(cos[idx]), 6),
            "ja": row["ja"],
            "en": row["en"],
        })
    selected = cos[np.where(splits == args.split)[0]]
    print(json.dumps({
        "split": args.split,
        "count": len(idxs),
        "cos_mean": round(float(selected.mean()), 6) if len(selected) else None,
        "cos_median": round(float(np.median(selected)), 6) if len(selected) else None,
        "cos_min": round(float(selected.min()), 6) if len(selected) else None,
        "cos_max": round(float(selected.max()), 6) if len(selected) else None,
        "worst": out,
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
