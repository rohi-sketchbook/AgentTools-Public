import argparse
import importlib.util
import json
from collections import Counter, defaultdict
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


def path_length(points: np.ndarray) -> float:
    if len(points) < 2:
        return 0.0
    return float(np.linalg.norm(np.diff(points, axis=0), axis=-1).sum())


def mean_root_relative_frame_motion(joints: np.ndarray, root_idx: int) -> float:
    root = joints[:, root_idx : root_idx + 1]
    rel = joints - root
    if len(rel) < 2:
        return 0.0
    return float(np.linalg.norm(np.diff(rel, axis=0), axis=-1).mean())


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--catalog", type=Path, default=Path("motion_prompt_db/prompt_collections_v1/catalog.py"))
    p.add_argument("--selection", type=Path, required=True)
    p.add_argument("--motion-dirs", type=Path, nargs="+", required=True)
    p.add_argument("--output", type=Path, required=True)
    p.add_argument("--selected-output", type=Path, required=True)
    args = p.parse_args()

    catalog = load_catalog(args.catalog)
    selection = json.loads(args.selection.read_text(encoding="utf-8"))
    selected_ids = selection["ids"]

    motion_paths = {}
    for directory in args.motion_dirs:
        for path in directory.glob("*.npz"):
            motion_paths[path.stem] = path

    missing = [pid for pid in selected_ids if pid not in motion_paths]
    if missing:
        raise SystemExit(f"Missing {len(missing)} motions: {missing}")

    skeleton = SOMASkeleton77()
    root_idx = int(skeleton.root_idx)
    left_hand_idx = skeleton.bone_order_names.index("LeftHand")
    right_hand_idx = skeleton.bone_order_names.index("RightHand")
    head_idx = skeleton.bone_order_names.index("Head")

    records = []
    for pid in selected_ids:
        row = catalog[pid]
        data = np.load(motion_paths[pid])
        joints = data["posed_joints"].astype(np.float32)
        root = data["root_positions"].astype(np.float32)
        rec = {
            **row,
            "root_displacement_m": float(np.linalg.norm(root[-1] - root[0])),
            "root_path_m": path_length(root),
            "left_hand_path_m": path_length(joints[:, left_hand_idx] - root),
            "right_hand_path_m": path_length(joints[:, right_hand_idx] - root),
            "head_path_m": path_length(joints[:, head_idx] - root),
            "mean_joint_motion_m_per_frame": mean_root_relative_frame_motion(joints, root_idx),
        }
        records.append(rec)

    groups = defaultdict(list)
    for rec in records:
        groups[(rec["genre"], rec["route_hint"])].append(rec)

    group_stats = {}
    review_ids = []
    review_reasons = defaultdict(list)

    for (genre, route), group in sorted(groups.items()):
        root = np.asarray([r["root_displacement_m"] for r in group], dtype=np.float32)
        joint = np.asarray([r["mean_joint_motion_m_per_frame"] for r in group], dtype=np.float32)
        hand = np.asarray([max(r["left_hand_path_m"], r["right_hand_path_m"]) for r in group], dtype=np.float32)
        key = f"{genre}/{route}"
        group_stats[key] = {
            "count": len(group),
            "root_mean": float(root.mean()),
            "root_median": float(np.median(root)),
            "root_min": float(root.min()),
            "root_max": float(root.max()),
            "joint_motion_mean": float(joint.mean()),
            "joint_motion_min": float(joint.min()),
            "joint_motion_max": float(joint.max()),
            "max_hand_path_mean": float(hand.mean()),
            "max_hand_path_max": float(hand.max()),
        }

        # Review extremes rather than trusting a single hand-written threshold.
        ordered_root = sorted(group, key=lambda r: r["root_displacement_m"])
        ordered_joint = sorted(group, key=lambda r: r["mean_joint_motion_m_per_frame"])
        for r in ordered_root[:2]:
            review_reasons[r["id"]].append(f"{key}:low_root")
        for r in ordered_root[-2:]:
            review_reasons[r["id"]].append(f"{key}:high_root")
        for r in ordered_joint[:1]:
            review_reasons[r["id"]].append(f"{key}:low_joint_motion")
        for r in ordered_joint[-1:]:
            review_reasons[r["id"]].append(f"{key}:high_joint_motion")

        # Static-pose prompts should not translate the character several meters.
        if all(r["motion_type"] == "static_pose" for r in group):
            for r in group:
                if r["root_displacement_m"] > 0.75:
                    review_reasons[r["id"]].append("static_pose_root_over_0.75m")

    # Keep review set bounded and deterministic. Prioritize multiple reasons, then ID.
    scored = []
    by_id = {r["id"]: r for r in records}
    for pid, reasons in review_reasons.items():
        scored.append((len(reasons), pid, reasons))
    scored.sort(key=lambda x: (-x[0], x[1]))
    for _, pid, _ in scored[:36]:
        review_ids.append(pid)

    report = {
        "count": len(records),
        "genres": dict(Counter(r["genre"] for r in records)),
        "routes": dict(Counter(r["route_hint"] for r in records)),
        "group_stats": group_stats,
        "review_count": len(review_ids),
        "review": [
            {
                "id": pid,
                "genre": by_id[pid]["genre"],
                "route_hint": by_id[pid]["route_hint"],
                "intensity": by_id[pid]["intensity"],
                "ja_prompt": by_id[pid]["ja_prompt"],
                "canonical_en": by_id[pid]["canonical_en"],
                "root_displacement_m": by_id[pid]["root_displacement_m"],
                "mean_joint_motion_m_per_frame": by_id[pid]["mean_joint_motion_m_per_frame"],
                "reasons": review_reasons[pid],
            }
            for pid in review_ids
        ],
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    args.selected_output.write_text("\n".join(review_ids) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
