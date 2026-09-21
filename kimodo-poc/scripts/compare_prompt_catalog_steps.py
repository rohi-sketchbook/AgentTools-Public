import argparse
import importlib.util
import json
from pathlib import Path

import numpy as np
from kimodo.skeleton import SOMASkeleton77


def load_catalog(path: Path):
    spec = importlib.util.spec_from_file_location("prompt_catalog", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Cannot load catalog: {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return {row["id"]: row for row in module.PROMPTS}


def metrics(path: Path, skeleton: SOMASkeleton77):
    data = np.load(path)
    joints = data["posed_joints"].astype(np.float32)
    root = data["root_positions"].astype(np.float32)
    root_idx = int(skeleton.root_idx)
    rel = joints - root[:, None, :]
    return {
        "root_displacement_m": float(np.linalg.norm(root[-1] - root[0])),
        "root_path_m": float(np.linalg.norm(np.diff(root, axis=0), axis=-1).sum()),
        "mean_joint_motion_m_per_frame": float(np.linalg.norm(np.diff(rel, axis=0), axis=-1).mean()),
    }


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--catalog", type=Path, default=Path("motion_prompt_db/prompt_collections_v1/catalog.py"))
    p.add_argument("--ids", type=Path, required=True)
    p.add_argument("--low-step-motion-dirs", type=Path, nargs="+", required=True)
    p.add_argument("--high-step-motion-dir", type=Path, required=True)
    p.add_argument("--output", type=Path, required=True)
    args = p.parse_args()

    catalog = load_catalog(args.catalog)
    ids = [x.strip() for x in args.ids.read_text(encoding="utf-8").splitlines() if x.strip()]
    low_paths = {}
    for d in args.low_step_motion_dirs:
        low_paths.update({p.stem: p for p in d.glob("*.npz")})
    high_paths = {p.stem: p for p in args.high_step_motion_dir.glob("*.npz")}
    skeleton = SOMASkeleton77()

    rows = []
    for pid in ids:
        low = metrics(low_paths[pid], skeleton)
        high = metrics(high_paths[pid], skeleton)
        item = {
            **catalog[pid],
            "step25": low,
            "step100": high,
            "root_delta_100_minus_25_m": high["root_displacement_m"] - low["root_displacement_m"],
            "persistent_flags": [],
        }
        if item["motion_type"] == "static_pose" and high["root_displacement_m"] > 0.75:
            item["persistent_flags"].append("static_pose_large_root_motion")
        if item["genre"] == "runway_fashion" and high["root_displacement_m"] > 7.0:
            item["persistent_flags"].append("runway_very_fast_translation")
        if item["genre"] == "runway_fashion" and high["root_displacement_m"] < 1.5:
            item["persistent_flags"].append("runway_low_translation")
        if item["genre"] == "dynamic_cute_dance" and high["root_displacement_m"] > 6.0:
            item["persistent_flags"].append("dynamic_large_translation")
        rows.append(item)

    flagged = [r for r in rows if r["persistent_flags"]]
    report = {
        "count": len(rows),
        "flagged_count": len(flagged),
        "flagged": flagged,
        "all": rows,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({
        "count": len(rows),
        "flagged_count": len(flagged),
        "flagged": [
            {
                "id": r["id"],
                "genre": r["genre"],
                "root25": round(r["step25"]["root_displacement_m"], 3),
                "root100": round(r["step100"]["root_displacement_m"], 3),
                "flags": r["persistent_flags"],
            }
            for r in flagged
        ],
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
