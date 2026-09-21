import argparse
import json
from pathlib import Path

import numpy as np


def find_motion(root_a: Path, root_b: Path, motion_id: str) -> Path:
    a = root_a / f"{motion_id}.npz"
    if a.exists():
        return a
    b = root_b / f"{motion_id}.npz"
    if b.exists():
        return b
    raise FileNotFoundError(motion_id)


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--ids", type=Path, required=True)
    p.add_argument("--step25-a", type=Path, required=True)
    p.add_argument("--step25-b", type=Path, required=True)
    p.add_argument("--step100", type=Path, required=True)
    args = p.parse_args()

    ids = [x.strip() for x in args.ids.read_text(encoding="utf-8").splitlines() if x.strip()]
    rows = []
    for motion_id in ids:
        p25 = find_motion(args.step25_a, args.step25_b, motion_id)
        p100 = args.step100 / f"{motion_id}.npz"
        a = np.load(p25)
        b = np.load(p100)
        r25, r100 = a["root_positions"], b["root_positions"]
        j25, j100 = a["posed_joints"], b["posed_joints"]
        root25 = float(np.linalg.norm(r25[-1] - r25[0]))
        root100 = float(np.linalg.norm(r100[-1] - r100[0]))
        rel25 = j25 - r25[:, None, :]
        rel100 = j100 - r100[:, None, :]
        jm25 = float(np.linalg.norm(np.diff(rel25, axis=0), axis=-1).mean())
        jm100 = float(np.linalg.norm(np.diff(rel100, axis=0), axis=-1).mean())
        bodydiff = float(np.linalg.norm(rel100 - rel25, axis=-1).mean())
        rows.append({
            "id": motion_id,
            "root25": root25,
            "root100": root100,
            "root_delta": root100 - root25,
            "joint_motion25": jm25,
            "joint_motion100": jm100,
            "mean_root_relative_pose_diff": bodydiff,
        })

    print(json.dumps({
        "count": len(rows),
        "mean_abs_root_delta": float(np.mean([abs(r["root_delta"]) for r in rows])),
        "mean_root_relative_pose_diff": float(np.mean([r["mean_root_relative_pose_diff"] for r in rows])),
        "rows": rows,
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
