# Kimodo lightweight text-encoder PoC

This directory is an isolated proof-of-concept environment for measuring whether the large Kimodo LLM2Vec text encoder can be replaced by a lightweight multilingual encoder plus a learned adapter.

## Target pipeline

Baseline:

`prompt -> Llama 3 8B + LLM2Vec -> 4096-d -> kimodo.cpp -> motion`

Candidate:

`Japanese/English prompt -> Qwen3-Embedding-0.6B -> 1024-d -> adapter -> 4096-d -> kimodo.cpp -> motion`

The first goal is measurement, not product integration.

## Local machine assumptions

- Windows
- NVIDIA RTX 3080 10 GB
- Python 3.12
- Visual Studio Build Tools 2022 C++ toolchain
- Vulkan runtime

`check_env.ps1` detects the actual paths instead of relying on PATH. It reports a missing Vulkan SDK safely; none of these scripts invokes `winget`, an installer, login, or a licence-acceptance flow.

## Licensing / gated files

This repository does not download gated Kimodo, SMPL-X, or Llama weights automatically.

The upstream kimodo.cpp README currently requires accepting the relevant Hugging Face licences and authenticating before obtaining the original SMPL-X and Llama-based weights. Do not automate account login or licence acceptance in this PoC.

Qwen3-Embedding-0.6B is public and Apache-2.0, but its model files are also kept outside Git under `models/` or the Hugging Face cache.

## Setup order

1. Run `powershell -ExecutionPolicy Bypass -File .\scripts\check_env.ps1`.
2. If `glslc` is reported missing, manually install the Vulkan SDK after reviewing its licence and installer. kimodo.cpp's GGML Vulkan backend requires SDK headers and `glslc`, not only the Vulkan runtime. The PoC will stop before build and will not install it itself.
3. Run `powershell -ExecutionPolicy Bypass -File .\scripts\setup_python.ps1`. If Python is not on `PATH`, pass its exact executable path, for example `-Python 'C:\Python312\python.exe'`.
4. Run `powershell -ExecutionPolicy Bypass -File .\scripts\fetch_upstream.ps1` to clone public kimodo.cpp sources.
5. Run `powershell -ExecutionPolicy Bypass -File .\scripts\build_kimodo.ps1` after Vulkan SDK is available. This uses upstream's `KIMODO_ENABLE_VULKAN` CMake switch and disables tests because weights/fixtures are intentionally absent.
6. Run `.\.venv\Scripts\python.exe .\scripts\benchmark_qwen.py --prompts .\config\benchmark_prompts.jsonl`. It is local-cache-only by default: it exits with an explanation when Qwen is absent and does not download anything. A later, deliberate download requires `--allow-model-download`.

## Benchmark outputs

Benchmarks are written under `results/` as JSONL. Records are intended to contain:

- backend / model name
- prompt identifier
- elapsed seconds
- process RSS before/after/peak when available
- GPU memory used before/after/peak when available
- embedding dimension

This makes it possible to compare the original LLM2Vec baseline, Qwen embedding generation, adapter inference, and finally kimodo.cpp motion generation with the same prompt set.

The Python setup intentionally installs the pinned CUDA PyTorch wheel from the configured PyTorch index. It downloads Python packages but never model weights; review/change `TorchVersion` and `TorchIndexUrl` before running if your driver or corporate mirror requires a different wheel.

## Layout and adapter plan

`upstream/` holds the cloned source (including its GGML submodule); `.venv/` holds the isolated Python runtime; `models/` is the local model location; `config/` holds versioned prompt fixtures; `results/` holds generated measurements; and `adapter/data/` plus `adapter/checkpoints/` are reserved for the learned projection experiment. Generated/model directories are ignored by Git.

Do not fine-tune Qwen in the first experiment. Precompute two datasets:

- teacher: original Kimodo LLM2Vec 4096-d embeddings
- student input: Qwen3-Embedding-0.6B 1024-d embeddings

Train only a small adapter such as `1024 -> 2048 -> 4096`. This keeps the experiment small enough for an RTX 3080 10 GB and lets the expensive teacher pass be cached once.

## Measured on the local RTX 3080 (2026-08-24)

Qwen3-Embedding-0.6B was loaded from the pinned Hugging Face revision `97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3` with `trust_remote_code=False` and safetensors only.

- cached model size: about 1.2 GB
- warm model load: about 1.93 s
- 300 short Japanese/English motion-prompt embeddings: mean 57.8 ms, median 56.3 ms per prompt
- model GPU allocation: about 1.15 GB peak
- process RSS after load/benchmark: about 1.52 GB

A synthetic compute-only benchmark of the proposed `1024 -> 2048 -> 4096` FP16 adapter measured:

- 10,491,904 trainable parameters
- 10,000 samples x 5 epochs: about 1.0 s total
- about 0.2 s per synthetic epoch
- peak adapter-training VRAM allocation: about 136 MiB

The adapter benchmark uses random embeddings and therefore measures compute/memory cost only, not semantic or motion quality. Real quality evaluation still requires teacher LLM2Vec embeddings and the Kimodo motion weights.

The upstream Kimodo source also builds successfully on this machine in CPU-only Release mode with MSVC/Ninja. Vulkan remains pending because the existing Unity Android NDK provides `glslc` and Vulkan headers but not the Windows `vulkan-1.lib`; the full Windows Vulkan SDK is still required.

## Current blockers / not done yet

- actual Kimodo motion generation is not yet benchmarked
- the LocalAI converted SMPL-X motion repository returns HTTP 401 for unauthenticated Hugging Face API access; no Hugging Face login or token use has been attempted
- gated Kimodo/SMPL-X/Llama teacher weights are not downloaded
- Vulkan SDK installation is not complete; the attempted winget invocation failed through the DevSpace connector before installation
- no model licence is accepted automatically
- no product/Unity integration is performed
- no commit or push is performed by the setup scripts
