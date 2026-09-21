import argparse
import json
import time
from pathlib import Path

import numpy as np
import torch
from transformers import AutoModel, AutoTokenizer


def load_rows(path: Path):
    rows = []
    with path.open(encoding="utf-8") as f:
        for line in f:
            if line.strip():
                rows.append(json.loads(line))
    return rows


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--pairs", type=Path, required=True)
    p.add_argument("--model-dir", type=Path, required=True)
    p.add_argument("--output", type=Path, required=True)
    p.add_argument("--instruction", default="")
    p.add_argument("--batch-size", type=int, default=32)
    args = p.parse_args()

    if not torch.cuda.is_available():
        raise SystemExit("CUDA unavailable")

    rows = load_rows(args.pairs)
    model_dir = args.model_dir.resolve()

    load_start = time.perf_counter()
    tokenizer = AutoTokenizer.from_pretrained(
        str(model_dir), local_files_only=True, trust_remote_code=False, padding_side="left"
    )
    model = AutoModel.from_pretrained(
        str(model_dir), local_files_only=True, trust_remote_code=False, use_safetensors=True
    ).to("cuda").eval()
    torch.cuda.synchronize()
    load_s = time.perf_counter() - load_start

    if args.batch_size < 1:
        raise SystemExit("--batch-size must be >= 1")
    torch.cuda.reset_peak_memory_stats()
    embeddings = np.empty((len(rows), 1024), dtype=np.float32)
    started = time.perf_counter()

    with torch.inference_mode():
        for start in range(0, len(rows), args.batch_size):
            end = min(start + args.batch_size, len(rows))
            texts = [row["ja"] for row in rows[start:end]]
            if args.instruction:
                texts = [f"Instruct: {args.instruction}\nQuery:{text}" for text in texts]
            tokens = tokenizer(
                texts, return_tensors="pt", padding=True, truncation=True, max_length=256
            ).to("cuda")
            hidden = model(**tokens).last_hidden_state
            # Padding is on the left, therefore the final token is valid for every sequence.
            emb = torch.nn.functional.normalize(hidden[:, -1], p=2, dim=1)
            embeddings[start:end] = emb.float().cpu().numpy()
            if end % 100 < args.batch_size or end == len(rows):
                torch.cuda.synchronize()
                elapsed = time.perf_counter() - started
                print(f"qwen {end}/{len(rows)} elapsed={elapsed:.1f}s", flush=True)

    torch.cuda.synchronize()
    total_s = time.perf_counter() - started
    args.output.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(
        args.output,
        embeddings=embeddings,
        ids=np.asarray([r["id"] for r in rows]),
        splits=np.asarray([r["split"] for r in rows]),
    )
    summary = {
        "rows": len(rows),
        "shape": list(embeddings.shape),
        "load_seconds": round(load_s, 3),
        "encode_seconds": round(total_s, 3),
        "mean_ms": round(total_s * 1000 / len(rows), 3),
        "peak_vram_mib": round(torch.cuda.max_memory_allocated() / 1024 / 1024, 1),
        "output": str(args.output),
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
