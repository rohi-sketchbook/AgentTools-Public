#!/usr/bin/env python
import argparse
import json
import os
import subprocess
import time
from pathlib import Path

import pynvml


def process_gpu_mib(handle, pid: int) -> float:
    seen = {}
    for getter_name in ("nvmlDeviceGetComputeRunningProcesses", "nvmlDeviceGetGraphicsRunningProcesses"):
        getter = getattr(pynvml, getter_name, None)
        if getter is None:
            continue
        try:
            for item in getter(handle):
                if int(item.pid) == pid:
                    raw = item.usedGpuMemory
                    if raw is None:
                        continue
                    value = int(raw)
                    if value >= 0 and value < (1 << 60):
                        seen[getter_name] = value
        except pynvml.NVMLError:
            pass
    return max(seen.values(), default=0) / (1024 * 1024)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--frames", type=int, default=300)
    parser.add_argument("--steps", type=int, default=100)
    parser.add_argument("--repeats", type=int, default=1)
    parser.add_argument("--interval", type=float, default=0.05)
    args = parser.parse_args()

    root = Path(__file__).resolve().parents[1]
    exe = root / "results" / "tools" / "benchmark_kimodo_embedding_vulkan.exe"
    model = root / "models" / "kimodo-smplx-rp-v1-ggml" / "models" / "kimodo-smplx-rp-v1-f32.gguf"
    build = root / "results" / "build-vk-vs-official"
    for required in (exe, model):
        if not required.is_file():
            raise SystemExit(f"missing: {required}")

    env = os.environ.copy()
    env.pop("KIMODO_BACKEND", None)
    env["PATH"] = str(build / "Release") + os.pathsep + str(build / "bin" / "Release") + os.pathsep + env.get("PATH", "")

    pynvml.nvmlInit()
    try:
        handle = pynvml.nvmlDeviceGetHandleByIndex(0)
        baseline_total_mib = pynvml.nvmlDeviceGetMemoryInfo(handle).used / (1024 * 1024)
        proc = subprocess.Popen(
            [str(exe), str(model), str(args.frames), str(args.steps), str(args.repeats)],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            env=env,
        )
        peak_process_mib = 0.0
        peak_total_mib = baseline_total_mib
        samples = 0
        started = time.perf_counter()
        try:
            while proc.poll() is None:
                peak_process_mib = max(peak_process_mib, process_gpu_mib(handle, proc.pid))
                peak_total_mib = max(peak_total_mib, pynvml.nvmlDeviceGetMemoryInfo(handle).used / (1024 * 1024))
                samples += 1
                time.sleep(args.interval)
            stdout, stderr = proc.communicate()
        except BaseException:
            if proc.poll() is None:
                proc.terminate()
                try:
                    proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait(timeout=5)
            raise
        elapsed = time.perf_counter() - started
        # Final sample can catch allocations that outlive the last polling interval.
        peak_process_mib = max(peak_process_mib, process_gpu_mib(handle, proc.pid))
        peak_total_mib = max(peak_total_mib, pynvml.nvmlDeviceGetMemoryInfo(handle).used / (1024 * 1024))

        print(stdout, end="")
        if stderr:
            print(stderr, end="", file=__import__("sys").stderr)
        summary = {
            "exit_code": proc.returncode,
            "frames": args.frames,
            "steps": args.steps,
            "wall_seconds": round(elapsed, 3),
            "samples": samples,
            "baseline_total_gpu_mib": round(baseline_total_mib, 1),
            "peak_process_gpu_mib": round(peak_process_mib, 1),
            "peak_total_gpu_mib": round(peak_total_mib, 1),
            "peak_total_delta_mib": round(peak_total_mib - baseline_total_mib, 1),
        }
        print(json.dumps(summary, ensure_ascii=False, indent=2))
        return proc.returncode
    finally:
        pynvml.nvmlShutdown()


if __name__ == "__main__":
    raise SystemExit(main())
