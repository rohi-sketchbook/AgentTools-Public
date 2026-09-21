import argparse
import subprocess
from pathlib import Path

import numpy as np
import torch
from PIL import Image, ImageDraw
from kimodo.skeleton import SOMASkeleton77


def project(points, center, scale, yaw=np.deg2rad(-28.0), pitch=np.deg2rad(8.0)):
    p = points - center[None, :]
    cy, sy = np.cos(yaw), np.sin(yaw)
    cp, sp = np.cos(pitch), np.sin(pitch)
    ry = np.array([[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]], dtype=np.float32)
    rx = np.array([[1, 0, 0], [0, cp, -sp], [0, sp, cp]], dtype=np.float32)
    q = p @ ry.T @ rx.T
    return np.stack([q[:, 0] * scale, -q[:, 1] * scale], axis=-1)


def draw_skeleton(draw, joints, parents, root_idx, box, label, frame_idx, total):
    x0, y0, x1, y1 = box
    root = joints[root_idx]
    center = np.array([root[0], root[1] + 0.65, root[2]], dtype=np.float32)
    scale = min((x1 - x0) * 0.32 / 0.65, (y1 - y0) * 0.55 / 1.8)
    p2 = project(joints, center, scale)
    p2[:, 0] += (x0 + x1) * 0.5
    p2[:, 1] += (y0 + y1) * 0.53
    ground_y = int((y0 + y1) * 0.5 + 0.35 * (y1 - y0))
    draw.line((x0 + 25, ground_y, x1 - 25, ground_y), fill=(195, 195, 195), width=2)
    for j, parent in enumerate(parents):
        if parent >= 0:
            a = p2[parent]
            b = p2[j]
            draw.line((float(a[0]), float(a[1]), float(b[0]), float(b[1])), fill=(35, 35, 35), width=3)
    for px, py in p2:
        r = 3
        draw.ellipse((px-r, py-r, px+r, py+r), fill=(20, 20, 20))
    draw.text((x0 + 20, y0 + 18), label, fill=(20, 20, 20))
    draw.text((x0 + 20, y0 + 42), f"frame {frame_idx:03d}/{total-1:03d}", fill=(70, 70, 70))


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--teacher", type=Path, required=True)
    p.add_argument("--student", type=Path, required=True)
    p.add_argument("--output-dir", type=Path, required=True)
    p.add_argument("--ffmpeg", required=True)
    p.add_argument("--fps", type=int, default=30)
    args = p.parse_args()

    a = np.load(args.teacher)["posed_joints"]
    b = np.load(args.student)["posed_joints"]
    n = min(len(a), len(b))
    a, b = a[:n], b[:n]

    skeleton = SOMASkeleton77().to(torch.device("cpu"))
    parents = skeleton.joint_parents.cpu().numpy().astype(int)
    root_idx = int(skeleton.root_idx)

    out = args.output_dir.resolve()
    frames = out / "frames"
    frames.mkdir(parents=True, exist_ok=True)
    w, h = 1280, 720
    for i in range(n):
        img = Image.new("RGB", (w, h), (245, 245, 245))
        d = ImageDraw.Draw(img)
        d.line((w // 2, 0, w // 2, h), fill=(215, 215, 215), width=2)
        draw_skeleton(d, a[i], parents, root_idx, (0, 0, w // 2, h), "Teacher: English LLM2Vec", i, n)
        draw_skeleton(d, b[i], parents, root_idx, (w // 2, 0, w, h), "Student: Japanese Qwen + Adapter", i, n)
        img.save(frames / f"{i:04d}.png")

    mp4 = out / "comparison_tracking.mp4"
    subprocess.run([
        args.ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
        "-framerate", str(args.fps), "-i", str(frames / "%04d.png"),
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", str(mp4)
    ], check=True)
    print(mp4)


if __name__ == "__main__":
    main()
