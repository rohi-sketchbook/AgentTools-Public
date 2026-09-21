#!/usr/bin/env python
# -*- coding: shift_jis -*-
"""Local-only Qwen embedding benchmark.  It never downloads a model unless opted in."""
import argparse, json, statistics, time
from pathlib import Path

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--prompts', type=Path, required=True)
    parser.add_argument('--model', default='Qwen/Qwen3-Embedding-0.6B')
    parser.add_argument('--revision', default='97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3')
    parser.add_argument('--model-dir', type=Path)
    parser.add_argument('--allow-model-download', action='store_true')
    parser.add_argument('--device', choices=('auto', 'cuda', 'cpu'), default='auto')
    parser.add_argument('--repeat', type=int, default=1)
    args = parser.parse_args()
    if not args.prompts.is_file(): parser.error(f'Prompt file not found: {args.prompts}')
    try:
        import psutil
        import torch
        from transformers import AutoModel, AutoTokenizer
    except ImportError as exc: parser.error(f'Missing Python package: {exc}. Run setup_python.ps1.')
    model_id = str(args.model_dir) if args.model_dir else args.model
    local_only = not args.allow_model_download
    load_started = time.perf_counter()
    try:
        load_args = {'local_files_only': local_only, 'trust_remote_code': False}
        if not args.model_dir:
            load_args['revision'] = args.revision
        tokenizer = AutoTokenizer.from_pretrained(model_id, **load_args)
        model = AutoModel.from_pretrained(model_id, use_safetensors=True, **load_args)
    except OSError as exc:
        parser.error(f'Model is not available locally: {exc}\nNo download was attempted. Place it under models/ or rerun with --allow-model-download after review.')
    device = 'cuda' if args.device == 'auto' and torch.cuda.is_available() else args.device
    model = model.to(device).eval()
    load_seconds = time.perf_counter() - load_started
    if device == 'cuda':
        torch.cuda.synchronize()
        torch.cuda.reset_peak_memory_stats()
    process = psutil.Process()
    output = Path(__file__).resolve().parents[1] / 'results' / f'qwen-{time.strftime("%Y%m%d-%H%M%S")}.jsonl'
    output.parent.mkdir(exist_ok=True)
    with args.prompts.open(encoding='utf-8') as source:
        prompts = [json.loads(line) for line in source if line.strip()]
    if args.repeat < 1:
        parser.error('--repeat must be >= 1')
    if prompts:
        warmup = tokenizer(prompts[0]['text'], return_tensors='pt', truncation=True).to(device)
        with torch.inference_mode():
            model(**warmup)
        if device == 'cuda':
            torch.cuda.synchronize()
            torch.cuda.reset_peak_memory_stats()
    elapsed = []
    with output.open('w', encoding='utf-8') as sink:
        for repeat_index in range(args.repeat):
            for item in prompts:
                tokens = tokenizer(item['text'], return_tensors='pt', truncation=True).to(device)
                if device == 'cuda':
                    torch.cuda.synchronize()
                started = time.perf_counter()
                with torch.inference_mode():
                    hidden = model(**tokens).last_hidden_state
                    embedding = torch.nn.functional.normalize(hidden[:, -1], p=2, dim=1)
                if device == 'cuda':
                    torch.cuda.synchronize()
                duration = time.perf_counter() - started
                elapsed.append(duration)
                record = {'id': item['id'], 'repeat': repeat_index, 'model': model_id, 'device': device, 'elapsed_seconds': round(duration, 6), 'embedding_dimension': int(embedding.shape[-1])}
                sink.write(json.dumps(record, ensure_ascii=False) + '\n')
    gpu_allocated = int(torch.cuda.memory_allocated()) if device == 'cuda' else 0
    gpu_reserved = int(torch.cuda.memory_reserved()) if device == 'cuda' else 0
    gpu_peak = int(torch.cuda.max_memory_allocated()) if device == 'cuda' else 0
    summary = {
        'load_seconds': round(load_seconds, 4),
        'samples': len(elapsed),
        'mean_ms': round(statistics.mean(elapsed) * 1000, 3) if elapsed else None,
        'median_ms': round(statistics.median(elapsed) * 1000, 3) if elapsed else None,
        'min_ms': round(min(elapsed) * 1000, 3) if elapsed else None,
        'max_ms': round(max(elapsed) * 1000, 3) if elapsed else None,
        'rss_mib': round(process.memory_info().rss / 1024 / 1024, 1),
        'gpu_allocated_mib': round(gpu_allocated / 1024 / 1024, 1),
        'gpu_reserved_mib': round(gpu_reserved / 1024 / 1024, 1),
        'gpu_peak_allocated_mib': round(gpu_peak / 1024 / 1024, 1),
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    print(f'Wrote {output}')
if __name__ == '__main__': main()
