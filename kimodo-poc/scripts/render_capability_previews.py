import argparse
import csv
import json
import math
import shutil
import subprocess
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
from kimodo.skeleton import SOMASkeleton77


DEFAULT_IDS = [
    "cap_001", "cap_004", "cap_009", "cap_011", "cap_016",
    "cap_026", "cap_028", "cap_035", "cap_040", "cap_049",
    "cap_051", "cap_053", "cap_058", "cap_061", "cap_072",
    "cap_076", "cap_083", "cap_086", "cap_096", "cap_100",
]


def load_summary(path: Path):
    return {row["id"]: row for row in (json.loads(x) for x in path.read_text(encoding="utf-8").splitlines() if x.strip())}


def project(points: np.ndarray, center: np.ndarray, scale: float, yaw=-0.45, pitch=0.08):
    p = points - center[None, :]
    cy, sy = math.cos(yaw), math.sin(yaw)
    cp, sp = math.cos(pitch), math.sin(pitch)
    ry = np.array([[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]], dtype=np.float32)
    rx = np.array([[1, 0, 0], [0, cp, -sp], [0, sp, cp]], dtype=np.float32)
    q = p @ ry.T @ rx.T
    return np.stack([q[:, 0] * scale, -q[:, 1] * scale], axis=-1)


def render_one(npz_path: Path, output: Path, label: str, expected: str, fps: int, ffmpeg: str):
    data = np.load(npz_path)
    joints_all = data["posed_joints"]
    skeleton = SOMASkeleton77()
    parents = skeleton.joint_parents.cpu().numpy().astype(int)
    root_idx = int(skeleton.root_idx)

    W, H = 640, 480
    # Tracking view: center on the root each frame so locomotion does not shrink the body.
    body_height = float(np.percentile(joints_all[:, :, 1], 99) - np.percentile(joints_all[:, :, 1], 1))
    scale = min(220.0, 330.0 / max(body_height, 1.4))

    cmd = [
        ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
        "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}",
        "-r", str(fps), "-i", "-", "-an", "-c:v", "libx264",
        "-pix_fmt", "yuv420p", "-crf", "21", str(output),
    ]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    try:
        for fi, joints in enumerate(joints_all):
            root = joints[root_idx]
            center = np.array([root[0], root[1] + 0.55, root[2]], dtype=np.float32)
            p2 = project(joints, center, scale)
            p2[:, 0] += W * 0.5
            p2[:, 1] += H * 0.58

            img = Image.new("RGB", (W, H), (247, 247, 247))
            d = ImageDraw.Draw(img)
            # Stable reference cross/ground near the tracked root.
            d.line((60, int(H * 0.86), W - 60, int(H * 0.86)), fill=(205, 205, 205), width=2)
            for j, parent in enumerate(parents):
                if parent >= 0:
                    a = p2[parent]
                    b = p2[j]
                    d.line((float(a[0]), float(a[1]), float(b[0]), float(b[1])), fill=(30, 30, 30), width=3)
            for x, y in p2:
                r = 2.4
                d.ellipse((x-r, y-r, x+r, y+r), fill=(20, 20, 20))
            d.text((12, 10), f"{label}  frame {fi:03d}/{len(joints_all)-1:03d}", fill=(15, 15, 15))
            d.text((12, 30), expected[:72], fill=(60, 60, 60))
            proc.stdin.write(img.tobytes())
    finally:
        if proc.stdin:
            proc.stdin.close()
        rc = proc.wait()
        if rc != 0:
            raise RuntimeError(f"ffmpeg failed with exit code {rc}")


def build_montage(videos: list[Path], output: Path, ffmpeg: str):
    # 5 columns x 4 rows, each 320x240. All source clips are the same duration/fps.
    cmd = [ffmpeg, "-y", "-hide_banner", "-loglevel", "error"]
    for v in videos:
        cmd += ["-i", str(v)]
    filters = []
    for i in range(len(videos)):
        filters.append(f"[{i}:v]scale=320:240[v{i}]")
    layout = "|".join(f"{(i%5)*320}_{(i//5)*240}" for i in range(len(videos)))
    ins = "".join(f"[v{i}]" for i in range(len(videos)))
    filters.append(f"{ins}xstack=inputs={len(videos)}:layout={layout}:fill=white[outv]")
    cmd += ["-filter_complex", ";".join(filters), "-map", "[outv]", "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "23", str(output)]
    subprocess.run(cmd, check=True)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--sweep-dir", type=Path, default=Path("results/capability-sweep-100"))
    p.add_argument("--output-dir", type=Path, default=Path("results/capability-previews-20"))
    p.add_argument("--fps", type=int, default=30)
    p.add_argument("--ids", nargs="*", default=DEFAULT_IDS)
    args = p.parse_args()

    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise SystemExit("ffmpeg not found in PATH")
    summary = load_summary(args.sweep_dir / "summary.jsonl")
    out = args.output_dir.resolve()
    out.mkdir(parents=True, exist_ok=True)

    videos = []
    for cid in args.ids:
        if cid not in summary:
            raise SystemExit(f"Unknown capability id: {cid}")
        row = summary[cid]
        target = out / f"{cid}.mp4"
        render_one(
            args.sweep_dir / "motions" / f"{cid}.npz",
            target,
            cid,
            row.get("expected") or row.get("canonical_en") or "",
            args.fps,
            ffmpeg,
        )
        videos.append(target)
        print(target, flush=True)

    montage = out / f"montage_{len(videos)}.mp4"
    build_montage(videos, montage, ffmpeg)
    print(montage)


if __name__ == "__main__":
    main()
