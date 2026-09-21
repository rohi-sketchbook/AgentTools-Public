import argparse
import json
import statistics
import time
from pathlib import Path

import torch
from llm2vec import LLM2Vec
from transformers import AutoTokenizer, PreTrainedTokenizerFast


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--model-dir", type=Path, required=True)
    p.add_argument("--prompts", type=Path, required=True)
    p.add_argument("--limit", type=int, default=0)
    args = p.parse_args()

    prompts = []
    with args.prompts.open(encoding="utf-8") as f:
        for line in f:
            if line.strip():
                item = json.loads(line)
                prompts.append(item)
    if args.limit:
        prompts = prompts[: args.limit]

    if not torch.cuda.is_available():
        raise SystemExit("CUDA unavailable")

    base = args.model_dir.resolve()
    adapter = (args.model_dir / "supervised_adapter").resolve()
    torch.cuda.empty_cache()
    torch.cuda.reset_peak_memory_stats()

    # The export uses the newer TokenizersBackend class name. McGill llm2vec
    # currently pins transformers 4.44.2, so adapt only tokenizer construction
    # in-memory without modifying the downloaded model files.
    original_from_pretrained = AutoTokenizer.from_pretrained
    base_resolved = str(base)

    def compat_tokenizer(name_or_path, *tok_args, **tok_kwargs):
        if str(Path(name_or_path).resolve()) == base_resolved:
            tok = PreTrainedTokenizerFast(
                tokenizer_file=str(base / "tokenizer.json"),
                bos_token="<|begin_of_text|>",
                eos_token="<|eot_id|>",
                pad_token="<|eot_id|>",
            )
            tok.padding_side = "left"
            return tok
        return original_from_pretrained(name_or_path, *tok_args, **tok_kwargs)

    AutoTokenizer.from_pretrained = compat_tokenizer
    t0 = time.perf_counter()
    model = LLM2Vec.from_pretrained(
        base_model_name_or_path=str(base),
        peft_model_name_or_path=str(adapter),
        torch_dtype=torch.bfloat16,
        device_map="cuda",
    )
    torch.cuda.synchronize()
    load_s = time.perf_counter() - t0

    durations = []
    records = []
    for item in prompts:
        torch.cuda.synchronize()
        started = time.perf_counter()
        emb = model.encode([item["text"]], batch_size=1, show_progress_bar=False, convert_to_tensor=True)
        torch.cuda.synchronize()
        elapsed = time.perf_counter() - started
        durations.append(elapsed)
        records.append({
            "id": item["id"],
            "shape": list(emb.shape),
            "norm": float(torch.linalg.vector_norm(emb[0]).item()),
            "elapsed_ms": round(elapsed * 1000, 3),
        })

    result = {
        "gpu": torch.cuda.get_device_name(0),
        "load_seconds": round(load_s, 3),
        "samples": len(records),
        "mean_ms": round(statistics.mean(durations) * 1000, 3) if durations else None,
        "peak_vram_mib": round(torch.cuda.max_memory_allocated() / 1024 / 1024, 1),
        "records": records,
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
