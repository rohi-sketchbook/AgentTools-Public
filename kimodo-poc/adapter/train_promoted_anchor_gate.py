# -*- coding: shift_jis -*-
from __future__ import annotations

import argparse
import json
import random
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F

from train_qwen_instruction_bridge import QwenInstructionBridge


class PromotedAnchorGate(torch.nn.Module):
    def __init__(self, hidden: int = 64, dropout: float = 0.05) -> None:
        super().__init__()
        self.net = torch.nn.Sequential(
            torch.nn.Linear(1024, hidden),
            torch.nn.GELU(),
            torch.nn.Dropout(dropout),
            torch.nn.Linear(hidden, 1),
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.net(x).squeeze(-1)


def load_rows(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def load_bridge(path: Path) -> QwenInstructionBridge:
    ck = torch.load(path, map_location="cpu", weights_only=False)
    model = QwenInstructionBridge(int(ck["hidden"]), float(ck.get("dropout", 0.0))).eval()
    model.load_state_dict(ck["state_dict"])
    return model


def choose_threshold(pos: np.ndarray, neg: np.ndarray) -> dict:
    candidates = np.unique(np.concatenate([np.linspace(0.01, 0.99, 197), pos, neg]))
    best = None
    for threshold in candidates:
        recall = float((pos >= threshold).mean())
        fp = int((neg >= threshold).sum())
        fp_rate = float(fp / max(len(neg), 1))
        # Hard priority: zero validation false positives, then recall, then margin.
        rank = (1 if fp == 0 else 0, recall, -fp_rate, float(threshold))
        if best is None or rank > best[0]:
            best = (rank, threshold, recall, fp, fp_rate)
    assert best is not None
    return {
        "threshold": float(best[1]),
        "anchor_val_recall": float(best[2]),
        "existing_val_false_positive_count": int(best[3]),
        "existing_val_false_positive_rate": float(best[4]),
    }


def summary(values: np.ndarray) -> dict:
    return {
        "count": int(len(values)),
        "mean": float(values.mean()) if len(values) else None,
        "median": float(np.median(values)) if len(values) else None,
        "min": float(values.min()) if len(values) else None,
        "max": float(values.max()) if len(values) else None,
        "p95": float(np.quantile(values, 0.95)) if len(values) else None,
        "p99": float(np.quantile(values, 0.99)) if len(values) else None,
    }


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--anchor-pairs", type=Path, default=Path("adapter/data/promoted_anchor_pairs.jsonl"))
    p.add_argument("--anchor-v3", type=Path, default=Path("adapter/data/promoted_anchor_qwen_v3.npz"))
    p.add_argument("--existing-pairs", type=Path, default=Path("adapter/data/distill_pairs_v5.jsonl"))
    p.add_argument("--existing-qwen", type=Path, default=Path("adapter/data/qwen_embeddings_v5.npz"))
    p.add_argument("--bridge", type=Path, default=Path("adapter/checkpoints/qwen_bridge_h256.pt"))
    p.add_argument("--output", type=Path, default=Path("adapter/checkpoints/promoted_anchor_gate_h64.pt"))
    p.add_argument("--hidden", type=int, default=64)
    p.add_argument("--dropout", type=float, default=0.05)
    p.add_argument("--epochs", type=int, default=1500)
    p.add_argument("--lr", type=float, default=1e-3)
    p.add_argument("--weight-decay", type=float, default=1e-4)
    p.add_argument("--hard-negatives", type=int, default=1400)
    p.add_argument("--random-negatives", type=int, default=600)
    p.add_argument("--patience", type=int, default=250)
    p.add_argument("--seed", type=int, default=20260826)
    args = p.parse_args()

    anchor_rows = load_rows(args.anchor_pairs)
    anchor_npz = np.load(args.anchor_v3)
    existing_rows = load_rows(args.existing_pairs)
    existing_npz = np.load(args.existing_qwen)
    if [r["id"] for r in anchor_rows] != anchor_npz["ids"].astype(str).tolist():
        raise SystemExit("anchor alignment mismatch")
    if [r["id"] for r in existing_rows] != existing_npz["ids"].astype(str).tolist():
        raise SystemExit("existing alignment mismatch")

    bridge = load_bridge(args.bridge)
    with torch.inference_mode():
        existing_source = F.normalize(torch.from_numpy(existing_npz["embeddings"].astype(np.float32)), p=2, dim=1)
        existing_v3 = bridge(existing_source).cpu().numpy().astype(np.float32)
    anchor_v3 = anchor_npz["embeddings"].astype(np.float32)
    anchor_v3 /= np.linalg.norm(anchor_v3, axis=1, keepdims=True).clip(min=1e-8)
    existing_v3 /= np.linalg.norm(existing_v3, axis=1, keepdims=True).clip(min=1e-8)

    anchor_train = np.asarray([i for i, r in enumerate(anchor_rows) if r["split"] == "train"], dtype=np.int64)
    anchor_val = np.asarray([i for i, r in enumerate(anchor_rows) if r["split"] == "val"], dtype=np.int64)
    existing_train = np.asarray([i for i, r in enumerate(existing_rows) if r["split"] == "train"], dtype=np.int64)
    existing_val = np.asarray([i for i, r in enumerate(existing_rows) if r["split"] == "val"], dtype=np.int64)

    prototypes = anchor_v3[anchor_train]
    max_sim = np.empty(len(existing_train), dtype=np.float32)
    for start in range(0, len(existing_train), 512):
        idx = existing_train[start:start + 512]
        max_sim[start:start + len(idx)] = (existing_v3[idx] @ prototypes.T).max(axis=1)
    hard_order = np.argsort(max_sim)[::-1]
    hard_count = min(args.hard_negatives, len(hard_order))
    hard_neg = existing_train[hard_order[:hard_count]]
    hard_set = set(int(i) for i in hard_neg)
    remaining = [int(i) for i in existing_train if int(i) not in hard_set]
    rng = random.Random(args.seed)
    rng.shuffle(remaining)
    random_neg = np.asarray(remaining[: min(args.random_negatives, len(remaining))], dtype=np.int64)
    negative_train = np.unique(np.concatenate([hard_neg, random_neg]))

    x_train = np.concatenate([anchor_v3[anchor_train], existing_v3[negative_train]], axis=0)
    y_train = np.concatenate([
        np.ones(len(anchor_train), dtype=np.float32),
        np.zeros(len(negative_train), dtype=np.float32),
    ])
    x_val = np.concatenate([anchor_v3[anchor_val], existing_v3[existing_val]], axis=0)
    y_val = np.concatenate([
        np.ones(len(anchor_val), dtype=np.float32),
        np.zeros(len(existing_val), dtype=np.float32),
    ])

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    xtr = torch.from_numpy(x_train).to(device)
    ytr = torch.from_numpy(y_train).to(device)
    xva = torch.from_numpy(x_val).to(device)
    yva = torch.from_numpy(y_val).to(device)

    torch.manual_seed(args.seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(args.seed)
    model = PromotedAnchorGate(args.hidden, args.dropout).to(device)
    opt = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=args.weight_decay)
    pos_weight = torch.tensor([len(negative_train) / max(len(anchor_train), 1)], dtype=torch.float32, device=device)

    best_state = None
    best_score = -1e9
    best_epoch = 0
    stale = 0
    for epoch in range(1, args.epochs + 1):
        model.train()
        logits = model(xtr)
        loss = F.binary_cross_entropy_with_logits(logits, ytr, pos_weight=pos_weight)
        opt.zero_grad(set_to_none=True)
        loss.backward()
        opt.step()

        model.eval()
        with torch.inference_mode():
            probs = torch.sigmoid(model(xva)).cpu().numpy()
        pos = probs[: len(anchor_val)]
        neg = probs[len(anchor_val):]
        # Reward high positive floor and low negative ceiling.
        score = float(np.quantile(pos, 0.10) - np.quantile(neg, 0.999))
        if score > best_score + 1e-6:
            best_score = score
            best_epoch = epoch
            best_state = {k: v.detach().cpu().clone() for k, v in model.state_dict().items()}
            stale = 0
        else:
            stale += 1
        if epoch % 100 == 0:
            print(
                f"epoch={epoch} loss={loss.item():.6f} pos_min={pos.min():.4f} "
                f"neg_max={neg.max():.4f} score={score:.4f} best={best_score:.4f}@{best_epoch}",
                flush=True,
            )
        if stale >= args.patience:
            break

    if best_state is None:
        raise SystemExit("no gate checkpoint")
    model.load_state_dict(best_state)
    model.eval()
    with torch.inference_mode():
        train_probs = torch.sigmoid(model(xtr)).cpu().numpy()
        val_probs = torch.sigmoid(model(xva)).cpu().numpy()
    pos_val = val_probs[: len(anchor_val)]
    neg_val = val_probs[len(anchor_val):]
    threshold_info = choose_threshold(pos_val, neg_val)

    args.output.parent.mkdir(parents=True, exist_ok=True)
    torch.save(
        {
            "state_dict": best_state,
            "hidden": args.hidden,
            "dropout": args.dropout,
            "threshold": threshold_info["threshold"],
            "seed": args.seed,
            "anchor_count": len(anchor_train),
            "negative_train_count": len(negative_train),
        },
        args.output,
    )

    result = {
        "output": str(args.output),
        "parameters": sum(p.numel() for p in model.parameters()),
        "epochs_ran": epoch,
        "best_epoch": best_epoch,
        "best_score": best_score,
        "counts": {
            "anchor_train": len(anchor_train),
            "anchor_val": len(anchor_val),
            "negative_train": len(negative_train),
            "negative_val": len(existing_val),
            "hard_negative_train": len(hard_neg),
            "random_negative_train": len(random_neg),
        },
        "train_positive_probability": summary(train_probs[: len(anchor_train)]),
        "train_negative_probability": summary(train_probs[len(anchor_train):]),
        "val_positive_probability": summary(pos_val),
        "val_negative_probability": summary(neg_val),
        "selection": threshold_info,
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
