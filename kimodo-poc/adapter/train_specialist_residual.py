import argparse
import json
import time
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


class SpecialistResidual(torch.nn.Module):
    def __init__(self, hidden: int, dropout: float = 0.03) -> None:
        super().__init__()
        self.fc1 = torch.nn.Linear(1024, hidden)
        self.fc2 = torch.nn.Linear(hidden, 4096)
        self.dropout = torch.nn.Dropout(dropout)
        torch.nn.init.zeros_(self.fc2.weight)
        torch.nn.init.zeros_(self.fc2.bias)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        h = F.gelu(self.fc1(x))
        h = self.dropout(h)
        return self.fc2(h)


def load_rows(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def cos_stats(pred: torch.Tensor, target: torch.Tensor) -> dict:
    cos = F.cosine_similarity(pred, target, dim=1)
    return {
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
    p.add_argument("--genre", required=True)
    p.add_argument("--output", type=Path, required=True)
    p.add_argument("--hidden", type=int, default=256)
    p.add_argument("--dropout", type=float, default=0.03)
    p.add_argument("--epochs", type=int, default=1200)
    p.add_argument("--batch-size", type=int, default=128)
    p.add_argument("--lr", type=float, default=1e-3)
    p.add_argument("--weight-decay", type=float, default=1e-4)
    p.add_argument("--patience", type=int, default=160)
    p.add_argument("--generic-anchor-weight", type=float, default=0.25)
    p.add_argument("--seed", type=int, default=20260825)
    args = p.parse_args()

    if not torch.cuda.is_available():
        raise SystemExit("CUDA unavailable")

    rows = load_rows(args.pairs)
    q = np.load(args.qwen)
    t = np.load(args.teacher)
    if len(rows) != len(q["ids"]) or len(rows) != len(t["ids"]):
        raise SystemExit("Row count mismatch")
    ids = q["ids"].astype(str)
    if not np.array_equal(ids, t["ids"].astype(str)):
        raise SystemExit("Qwen/teacher ID mismatch")
    splits = q["splits"].astype(str)

    genres = np.asarray([row.get("genre", "") or "" for row in rows], dtype=str)
    sources = np.asarray([row.get("source_dataset", "") or "" for row in rows], dtype=str)
    spec_train_np = np.where((splits == "train") & (genres == args.genre))[0]
    spec_val_np = np.where((splits == "val") & (genres == args.genre))[0]
    generic_train_np = np.where((splits == "train") & (sources == "base_v2"))[0]
    generic_val_np = np.where((splits == "val") & (sources == "base_v2"))[0]
    generic_test_np = np.where(splits == "test")[0]
    if len(spec_train_np) == 0 or len(spec_val_np) == 0:
        raise SystemExit(f"No specialist rows for genre={args.genre}")

    device = torch.device("cuda")
    x_source = F.normalize(torch.from_numpy(q["embeddings"].astype(np.float32)).to(device), p=2, dim=1)
    y = torch.from_numpy(t["embeddings"].astype(np.float32)).to(device)

    bck = torch.load(args.bridge, map_location="cpu", weights_only=False)
    bridge = QwenInstructionBridge(int(bck["hidden"]), float(bck.get("dropout", 0.0))).to(device).eval()
    bridge.load_state_dict(bck["state_dict"])
    for param in bridge.parameters():
        param.requires_grad_(False)

    ack = torch.load(args.base_adapter, map_location="cpu", weights_only=False)
    base = MotionAdapter(int(ack["hidden"]), float(ack.get("dropout", 0.0))).to(device).eval()
    base.load_state_dict(ack["state_dict"])
    for param in base.parameters():
        param.requires_grad_(False)
    mean = torch.as_tensor(ack["teacher_mean"], dtype=torch.float32, device=device)
    std = torch.as_tensor(ack["teacher_std"], dtype=torch.float32, device=device)

    with torch.inference_mode():
        x = bridge(x_source)
        base_z = base(x)
        base_y = base_z * std + mean
        target_z = (y - mean) / std
        target_residual_z = target_z - base_z

    torch.manual_seed(args.seed)
    torch.cuda.manual_seed_all(args.seed)
    model = SpecialistResidual(args.hidden, args.dropout).to(device)
    opt = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=args.weight_decay)

    spec_train = torch.as_tensor(spec_train_np, device=device, dtype=torch.long)
    spec_val = torch.as_tensor(spec_val_np, device=device, dtype=torch.long)
    gen_train = torch.as_tensor(generic_train_np, device=device, dtype=torch.long)
    gen_val = torch.as_tensor(generic_val_np, device=device, dtype=torch.long)
    gen_test = torch.as_tensor(generic_test_np, device=device, dtype=torch.long)

    best_state = None
    best_score = -1e9
    best_epoch = 0
    stale = 0
    started = time.perf_counter()
    torch.cuda.reset_peak_memory_stats()

    for epoch in range(1, args.epochs + 1):
        model.train()
        perm = spec_train[torch.randperm(len(spec_train), device=device)]
        for start in range(0, len(perm), args.batch_size):
            idx = perm[start:start + args.batch_size]
            residual_z = model(x[idx])
            pred_z = base_z[idx] + residual_z
            pred_y = pred_z * std + mean
            loss_fit = F.mse_loss(residual_z, target_residual_z[idx])
            loss_cos = 1.0 - F.cosine_similarity(pred_y, y[idx], dim=1).mean()
            loss = loss_fit + 0.25 * loss_cos

            if args.generic_anchor_weight > 0 and len(gen_train):
                take = min(len(idx), len(gen_train))
                anchor_idx = gen_train[torch.randint(0, len(gen_train), (take,), device=device)]
                anchor_residual = model(x[anchor_idx])
                loss_anchor = torch.mean(anchor_residual.square())
                loss = loss + args.generic_anchor_weight * loss_anchor

            opt.zero_grad(set_to_none=True)
            loss.backward()
            opt.step()

        model.eval()
        with torch.inference_mode():
            rv = model(x[spec_val])
            predv = (base_z[spec_val] + rv) * std + mean
            spec_cos = float(F.cosine_similarity(predv, y[spec_val], dim=1).mean().item())
            if len(gen_val):
                rg = model(x[gen_val])
                predg = (base_z[gen_val] + rg) * std + mean
                baseg = base_y[gen_val]
                base_gen_cos = float(F.cosine_similarity(baseg, y[gen_val], dim=1).mean().item())
                forced_gen_cos = float(F.cosine_similarity(predg, y[gen_val], dim=1).mean().item())
                drift_penalty = max(0.0, base_gen_cos - forced_gen_cos)
            else:
                drift_penalty = 0.0
            score = spec_cos - 0.2 * drift_penalty

        if score > best_score + 1e-6:
            best_score = score
            best_epoch = epoch
            best_state = {k: v.detach().cpu().clone() for k, v in model.state_dict().items()}
            stale = 0
        else:
            stale += 1
        if epoch % 100 == 0:
            print(f"genre={args.genre} epoch={epoch} spec_val={spec_cos:.6f} score={score:.6f} best={best_score:.6f}@{best_epoch}", flush=True)
        if stale >= args.patience:
            break

    if best_state is None:
        raise SystemExit("No checkpoint produced")
    model.load_state_dict(best_state)
    model.eval()
    torch.cuda.synchronize()
    elapsed = time.perf_counter() - started

    with torch.inference_mode():
        rs = model(x[spec_val])
        spec_base = base_y[spec_val]
        spec_expert = (base_z[spec_val] + rs) * std + mean
        if len(gen_val):
            rg = model(x[gen_val])
            gen_base = base_y[gen_val]
            gen_forced = (base_z[gen_val] + rg) * std + mean
        else:
            gen_base = gen_forced = None
        if len(gen_test):
            rt = model(x[gen_test])
            test_base = base_y[gen_test]
            test_forced = (base_z[gen_test] + rt) * std + mean
        else:
            test_base = test_forced = None

    args.output.parent.mkdir(parents=True, exist_ok=True)
    torch.save({
        "state_dict": best_state,
        "hidden": args.hidden,
        "dropout": args.dropout,
        "genre": args.genre,
        "bridge_checkpoint": str(args.bridge),
        "base_adapter_checkpoint": str(args.base_adapter),
        "teacher_mean": ack["teacher_mean"],
        "teacher_std": ack["teacher_std"],
        "seed": args.seed,
    }, args.output)

    result = {
        "genre": args.genre,
        "parameters": sum(p.numel() for p in model.parameters()),
        "hidden": args.hidden,
        "epochs_ran": epoch,
        "best_epoch": best_epoch,
        "elapsed_seconds": round(elapsed, 3),
        "peak_vram_mib": round(torch.cuda.max_memory_allocated() / 1024 / 1024, 1),
        "counts": {
            "specialist_train": len(spec_train_np),
            "specialist_val": len(spec_val_np),
            "generic_train_anchors": len(generic_train_np),
            "generic_val": len(generic_val_np),
            "generic_test": len(generic_test_np),
        },
        "specialist_val_base": cos_stats(spec_base, y[spec_val]),
        "specialist_val_with_residual": cos_stats(spec_expert, y[spec_val]),
        "generic_val_base": cos_stats(gen_base, y[gen_val]) if gen_base is not None else None,
        "generic_val_forced_residual": cos_stats(gen_forced, y[gen_val]) if gen_forced is not None else None,
        "generic_test_base": cos_stats(test_base, y[gen_test]) if test_base is not None else None,
        "generic_test_forced_residual": cos_stats(test_forced, y[gen_test]) if test_forced is not None else None,
        "output": str(args.output),
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
