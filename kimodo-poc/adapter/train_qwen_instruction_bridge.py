import argparse
import json
import time
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F


class QwenInstructionBridge(torch.nn.Module):
    def __init__(self, hidden: int, dropout: float = 0.02) -> None:
        super().__init__()
        self.net = torch.nn.Sequential(
            torch.nn.Linear(1024, hidden),
            torch.nn.GELU(),
            torch.nn.Dropout(dropout),
            torch.nn.Linear(hidden, 1024),
        )
        self.scale = torch.nn.Parameter(torch.tensor(0.1, dtype=torch.float32))

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        y = x + self.scale * self.net(x)
        return F.normalize(y, p=2, dim=1)


def summarize(pred: torch.Tensor, target: torch.Tensor) -> dict:
    cos = F.cosine_similarity(pred, target, dim=1)
    return {
        "cos_mean": float(cos.mean().item()),
        "cos_median": float(cos.median().item()),
        "cos_min": float(cos.min().item()),
        "cos_max": float(cos.max().item()),
    }


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--source", type=Path, required=True, help="Current reproducible Qwen embedding NPZ")
    p.add_argument("--target", type=Path, required=True, help="Saved v3 Qwen embedding NPZ")
    p.add_argument("--output", type=Path, required=True)
    p.add_argument("--hidden", type=int, default=256)
    p.add_argument("--dropout", type=float, default=0.02)
    p.add_argument("--epochs", type=int, default=1200)
    p.add_argument("--batch-size", type=int, default=128)
    p.add_argument("--lr", type=float, default=2e-3)
    p.add_argument("--weight-decay", type=float, default=1e-4)
    p.add_argument("--patience", type=int, default=150)
    p.add_argument("--seed", type=int, default=20260825)
    args = p.parse_args()

    if not torch.cuda.is_available():
        raise SystemExit("CUDA unavailable")

    src = np.load(args.source)
    tgt = np.load(args.target)
    n = len(tgt["ids"])
    if len(src["ids"]) < n:
        raise SystemExit("Source has fewer rows than target")
    if not np.array_equal(src["ids"][:n], tgt["ids"]):
        raise SystemExit("ID alignment mismatch")
    if not np.array_equal(src["splits"][:n], tgt["splits"]):
        raise SystemExit("Split alignment mismatch")

    x_np = src["embeddings"][:n].astype(np.float32)
    y_np = tgt["embeddings"].astype(np.float32)
    splits = tgt["splits"].astype(str)

    device = torch.device("cuda")
    x = F.normalize(torch.from_numpy(x_np).to(device), p=2, dim=1)
    y = F.normalize(torch.from_numpy(y_np).to(device), p=2, dim=1)
    train_idx = torch.as_tensor(np.where(splits == "train")[0], device=device, dtype=torch.long)
    val_idx = torch.as_tensor(np.where(splits == "val")[0], device=device, dtype=torch.long)
    test_idx = torch.as_tensor(np.where(splits == "test")[0], device=device, dtype=torch.long)

    torch.manual_seed(args.seed)
    torch.cuda.manual_seed_all(args.seed)
    model = QwenInstructionBridge(args.hidden, args.dropout).to(device)
    opt = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=args.weight_decay)

    best_state = None
    best_val = -1.0
    best_epoch = 0
    stale = 0
    started = time.perf_counter()
    torch.cuda.reset_peak_memory_stats()

    for epoch in range(1, args.epochs + 1):
        model.train()
        perm = train_idx[torch.randperm(len(train_idx), device=device)]
        for start in range(0, len(perm), args.batch_size):
            idx = perm[start:start + args.batch_size]
            pred = model(x[idx])
            loss_cos = 1.0 - F.cosine_similarity(pred, y[idx], dim=1).mean()
            loss_mse = F.mse_loss(pred, y[idx])
            loss = loss_cos + 0.1 * loss_mse
            opt.zero_grad(set_to_none=True)
            loss.backward()
            opt.step()

        model.eval()
        with torch.inference_mode():
            val_pred = model(x[val_idx])
            val_cos = float(F.cosine_similarity(val_pred, y[val_idx], dim=1).mean().item())
        if val_cos > best_val + 1e-6:
            best_val = val_cos
            best_epoch = epoch
            best_state = {k: v.detach().cpu().clone() for k, v in model.state_dict().items()}
            stale = 0
        else:
            stale += 1
        if epoch % 100 == 0:
            print(f"epoch={epoch} val_cos={val_cos:.6f} best={best_val:.6f}@{best_epoch}", flush=True)
        if stale >= args.patience:
            break

    if best_state is None:
        raise SystemExit("No checkpoint produced")
    model.load_state_dict(best_state)
    model.eval()
    torch.cuda.synchronize()
    elapsed = time.perf_counter() - started

    with torch.inference_mode():
        train_pred = model(x[train_idx])
        val_pred = model(x[val_idx])
        test_pred = model(x[test_idx]) if len(test_idx) else None

    args.output.parent.mkdir(parents=True, exist_ok=True)
    torch.save({
        "state_dict": best_state,
        "hidden": args.hidden,
        "dropout": args.dropout,
        "source_dim": 1024,
        "target_dim": 1024,
        "seed": args.seed,
    }, args.output)

    result = {
        "parameters": sum(p.numel() for p in model.parameters()),
        "hidden": args.hidden,
        "epochs_ran": epoch,
        "best_epoch": best_epoch,
        "elapsed_seconds": round(elapsed, 3),
        "peak_vram_mib": round(torch.cuda.max_memory_allocated() / 1024 / 1024, 1),
        "input_baseline": summarize(x[val_idx], y[val_idx]),
        "train": summarize(train_pred, y[train_idx]),
        "val": summarize(val_pred, y[val_idx]),
        "test": summarize(test_pred, y[test_idx]) if test_pred is not None else None,
        "output": str(args.output),
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
