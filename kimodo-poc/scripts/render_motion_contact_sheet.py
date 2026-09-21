import argparse
import json
import math
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
from kimodo.skeleton import SOMASkeleton77


def project(points: np.ndarray, center: np.ndarray, scale: float, yaw=-0.45, pitch=0.08):
    p = points - center[None, :]
    cy, sy = math.cos(yaw), math.sin(yaw)
    cp, sp = math.cos(pitch), math.sin(pitch)
    ry = np.array([[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]], dtype=np.float32)
    rx = np.array([[1, 0, 0], [0, cp, -sp], [0, sp, cp]], dtype=np.float32)
    q = p @ ry.T @ rx.T
    return np.stack([q[:, 0] * scale, -q[:, 1] * scale], axis=-1)


def load_summary(path: Path):
    return {r["id"]: r for r in (json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip())}


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--sweep-dir", type=Path, required=True)
    p.add_argument("--output-dir", type=Path, required=True)
    p.add_argument("--ids", nargs="+", required=True)
    args = p.parse_args()

    summary = load_summary(args.sweep_dir / "summary.jsonl")
    skeleton = SOMASkeleton77()
    parents = skeleton.joint_parents.cpu().numpy().astype(int)
    root_idx = int(skeleton.root_idx)
    args.output_dir.mkdir(parents=True, exist_ok=True)

    for motion_id in args.ids:
        row = summary[motion_id]
        joints_all = np.load(args.sweep_dir / "motions" / f"{motion_id}.npz")["posed_joints"]
        indices = [0, len(joints_all)//3, 2*len(joints_all)//3, len(joints_all)-1]
        cell_w, cell_h = 360, 430
        img = Image.new("RGB", (cell_w*4, cell_h), (247, 247, 247))
        body_height = float(np.percentile(joints_all[:, :, 1], 99) - np.percentile(joints_all[:, :, 1], 1))
        scale = min(190.0, 285.0 / max(body_height, 1.4))

        for ci, fi in enumerate(indices):
            joints = joints_all[fi]
            root = joints[root_idx]
            center = np.array([root[0], root[1] + 0.55, root[2]], dtype=np.float32)
            p2 = project(joints, center, scale)
            p2[:, 0] += ci*cell_w + cell_w*0.5
            p2[:, 1] += cell_h*0.60
            d = ImageDraw.Draw(img)
            d.line((ci*cell_w+30, int(cell_h*0.86), (ci+1)*cell_w-30, int(cell_h*0.86)), fill=(205,205,205), width=2)
            for j, parent in enumerate(parents):
                if parent >= 0:
                    a, b = p2[parent], p2[j]
                    d.line((float(a[0]), float(a[1]), float(b[0]), float(b[1])), fill=(30,30,30), width=3)
            for x, y in p2:
                d.ellipse((x-2.2, y-2.2, x+2.2, y+2.2), fill=(20,20,20))
            d.text((ci*cell_w+10, 10), f"{motion_id} frame {fi}", fill=(20,20,20))
        d = ImageDraw.Draw(img)
        label = row.get("canonical_en") or row.get("expected") or ""
        d.text((10, cell_h-24), label[:180], fill=(50,50,50))
        path = args.output_dir / f"{motion_id}.png"
        img.save(path)
        print(path)


if __name__ == "__main__":
    main()
