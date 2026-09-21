import argparse
import json
import time
from pathlib import Path

import numpy as np
import torch
import transformers.modeling_utils as modeling_utils
from kimodo.model.llm2vec import LLM2Vec


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
    p.add_argument("--batch-size", type=int, default=1)
    p.add_argument("--start", type=int, default=0)
    p.add_argument("--limit", type=int, default=0)
    args = p.parse_args()

    if not torch.cuda.is_available():
        raise SystemExit("CUDA unavailable")
    all_rows = load_rows(args.pairs)
    if args.start < 0 or args.start > len(all_rows):
        raise SystemExit("--start is out of range")
    stop = len(all_rows) if args.limit <= 0 else min(len(all_rows), args.start + args.limit)
    rows = all_rows[args.start:stop]
    base = args.model_dir.resolve()
    adapter = (args.model_dir / "supervised_adapter").resolve()

    # Known incompatibility of transformers 5.x allocator prewarm with
    # pre-quantized bitsandbytes NF4 buffers. This only skips cache preallocation.
    modeling_utils.caching_allocator_warmup = lambda *a, **kw: None

    torch.cuda.empty_cache()
    torch.cuda.reset_peak_memory_stats()
    load_start = time.perf_counter()
    model = LLM2Vec.from_pretrained(
        base_model_name_or_path=str(base),
        peft_model_name_or_path=str(adapter),
        torch_dtype=torch.bfloat16,
        device_map="cuda",
    )
    torch.cuda.synchronize()
    load_s = time.perf_counter() - load_start

    if args.batch_size < 1:
        raise SystemExit("--batch-size must be >= 1")
    embeddings = np.empty((len(rows), 4096), dtype=np.float32)
    started = time.perf_counter()
    for start in range(0, len(rows), args.batch_size):
        end = min(start + args.batch_size, len(rows))
        texts = [row["en"] for row in rows[start:end]]
        with torch.inference_mode():
            emb = model.encode(
                texts,
                batch_size=args.batch_size,
                show_progress_bar=False,
                convert_to_tensor=True,
                device="cuda",
            )
        embeddings[start:end] = emb.float().cpu().numpy()
        if end % 50 < args.batch_size or end == len(rows):
            elapsed = time.perf_counter() - started
            print(f"teacher {end}/{len(rows)} elapsed={elapsed:.1f}s", flush=True)

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
