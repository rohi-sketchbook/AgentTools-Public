import argparse
import json
import time
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F

CLASSES = ["generic", "glamour_editorial", "idol_cute", "runway_fashion", "dynamic_cute_dance", "bold_sensual"]
CLASS_TO_ID = {name: i for i, name in enumerate(CLASSES)}


class DomainRouter(torch.nn.Module):
    def __init__(self, hidden: int, dropout: float = 0.05) -> None:
        super().__init__()
        self.net = torch.nn.Sequential(
            torch.nn.Linear(1024, hidden),
            torch.nn.GELU(),
            torch.nn.Dropout(dropout),
            torch.nn.Linear(hidden, len(CLASSES)),
        )

    def forward(self, x):
        return self.net(x)


def load_rows(path: Path):
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def label_for(row: dict) -> str:
    return row.get("genre") or "generic"


def evaluate(logits, labels):
    probs = torch.softmax(logits, dim=1)
    pred = probs.argmax(dim=1)
    acc = float((pred == labels).float().mean().item())
    per = {}
    for cid, name in enumerate(CLASSES):
        mask = labels == cid
        if mask.any():
            per[name] = {
                "count": int(mask.sum().item()),
                "accuracy": float((pred[mask] == labels[mask]).float().mean().item()),
                "mean_top_probability": float(probs[mask].max(dim=1).values.mean().item()),
            }
    return acc, per, probs, pred


def threshold_report(probs, labels, thresholds):
    top_prob, top_id = probs.max(dim=1)
    out = {}
    for th in thresholds:
        routed = torch.where(top_prob >= th, top_id, torch.zeros_like(top_id))
        generic_mask = labels == 0
        specialist_mask = labels != 0
        false_specialist = float((routed[generic_mask] != 0).float().mean().item()) if generic_mask.any() else 0.0
        specialist_correct = float((routed[specialist_mask] == labels[specialist_mask]).float().mean().item()) if specialist_mask.any() else 0.0
        specialist_coverage = float((routed[specialist_mask] != 0).float().mean().item()) if specialist_mask.any() else 0.0
        out[str(th)] = {
            "generic_false_specialist_rate": false_specialist,
            "specialist_correct_route_rate": specialist_correct,
            "specialist_coverage": specialist_coverage,
        }
    return out


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--pairs", type=Path, required=True)
    p.add_argument("--qwen", type=Path, required=True)
    p.add_argument("--output", type=Path, required=True)
    p.add_argument("--hidden", type=int, default=128)
    p.add_argument("--dropout", type=float, default=0.05)
    p.add_argument("--epochs", type=int, default=800)
    p.add_argument("--batch-size", type=int, default=256)
    p.add_argument("--lr", type=float, default=1e-3)
    p.add_argument("--weight-decay", type=float, default=1e-4)
    p.add_argument("--patience", type=int, default=100)
    p.add_argument("--seed", type=int, default=20260825)
    args = p.parse_args()

    if not torch.cuda.is_available():
        raise SystemExit("CUDA unavailable")
    rows = load_rows(args.pairs)
    q = np.load(args.qwen)
    ids = q["ids"].astype(str)
    splits = q["splits"].astype(str)
    if len(rows) != len(ids):
        raise SystemExit("row mismatch")
    labels_np = np.asarray([CLASS_TO_ID[label_for(row)] for row in rows], dtype=np.int64)
    x_np = q["embeddings"].astype(np.float32)

    device = torch.device("cuda")
    x = F.normalize(torch.from_numpy(x_np).to(device), p=2, dim=1)
    labels = torch.from_numpy(labels_np).to(device)
    train_idx = torch.as_tensor(np.where(splits == "train")[0], device=device, dtype=torch.long)
    val_idx = torch.as_tensor(np.where(splits == "val")[0], device=device, dtype=torch.long)

    counts = np.bincount(labels_np[np.where(splits == "train")[0]], minlength=len(CLASSES)).astype(np.float32)
    weights = counts.sum() / np.maximum(counts, 1.0)
    weights = weights / weights.mean()
    class_weights = torch.from_numpy(weights).to(device)

    torch.manual_seed(args.seed)
    torch.cuda.manual_seed_all(args.seed)
    model = DomainRouter(args.hidden, args.dropout).to(device)
    opt = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=args.weight_decay)
    best_state = None
    best_val = -1.0
    best_epoch = 0
    stale = 0
    started = time.perf_counter()

    for epoch in range(1, args.epochs + 1):
        model.train()
        perm = train_idx[torch.randperm(len(train_idx), device=device)]
        for start in range(0, len(perm), args.batch_size):
            idx = perm[start:start + args.batch_size]
            logits = model(x[idx])
            loss = F.cross_entropy(logits, labels[idx], weight=class_weights)
            opt.zero_grad(set_to_none=True)
            loss.backward()
            opt.step()
        model.eval()
        with torch.inference_mode():
            val_logits = model(x[val_idx])
            val_acc = float((val_logits.argmax(dim=1) == labels[val_idx]).float().mean().item())
        if val_acc > best_val + 1e-6:
            best_val = val_acc
            best_epoch = epoch
            best_state = {k: v.detach().cpu().clone() for k, v in model.state_dict().items()}
            stale = 0
        else:
            stale += 1
        if epoch % 100 == 0:
            print(f"epoch={epoch} val_acc={val_acc:.6f} best={best_val:.6f}@{best_epoch}", flush=True)
        if stale >= args.patience:
            break

    model.load_state_dict(best_state)
    model.eval()
    with torch.inference_mode():
        train_logits = model(x[train_idx])
        val_logits = model(x[val_idx])
    train_acc, train_per, _, _ = evaluate(train_logits, labels[train_idx])
    val_acc, val_per, val_probs, _ = evaluate(val_logits, labels[val_idx])

    args.output.parent.mkdir(parents=True, exist_ok=True)
    torch.save({
        "state_dict": best_state,
        "hidden": args.hidden,
        "dropout": args.dropout,
        "classes": CLASSES,
        "recommended_threshold": 0.85,
        "seed": args.seed,
    }, args.output)
    result = {
        "parameters": sum(p.numel() for p in model.parameters()),
        "epochs_ran": epoch,
        "best_epoch": best_epoch,
        "elapsed_seconds": round(time.perf_counter() - started, 3),
        "train_accuracy": train_acc,
        "val_accuracy": val_acc,
        "train_per_class": train_per,
        "val_per_class": val_per,
        "thresholds": threshold_report(val_probs, labels[val_idx], [0.6, 0.7, 0.8, 0.85, 0.9, 0.95]),
        "output": str(args.output),
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
