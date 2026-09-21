# -*- coding: shift_jis -*-
from __future__ import annotations

import argparse
import json
from collections import defaultdict
from pathlib import Path

import numpy as np


METRICS = (
    "root_displacement_m",
    "root_path_m",
    "left_hand_root_relative_path_m",
    "right_hand_root_relative_path_m",
    "head_root_relative_path_m",
    "mean_root_relative_joint_motion_m_per_frame",
)


def load_summary(path: Path) -> list[dict]:
    rows = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip():
            rows.append(json.loads(line))
    return rows


def coefficient_of_variation(values: list[float]) -> float:
    arr = np.asarray(values, dtype=np.float64)
    mean = float(np.mean(arr))
    if abs(mean) < 1e-9:
        return 0.0
    return float(np.std(arr) / abs(mean))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("sweep_dirs", type=Path, nargs="+")
    parser.add_argument("--stationary-root-max", type=float, default=0.35)
    parser.add_argument("--cv-max", type=float, default=0.60)
    args = parser.parse_args()

    grouped: dict[str, list[dict]] = defaultdict(list)
    for sweep_dir in args.sweep_dirs:
        summary_path = sweep_dir / "summary.jsonl"
        if not summary_path.is_file():
            raise SystemExit(f"Missing summary: {summary_path}")
        for row in load_summary(summary_path):
            grouped[row["id"]].append(row)

    if not grouped:
        raise SystemExit("No records")

    expected_runs = len(args.sweep_dirs)
    output = []
    for motion_id, rows in sorted(grouped.items()):
        if len(rows) != expected_runs:
            raise SystemExit(f"{motion_id}: expected {expected_runs} runs, got {len(rows)}")
        record = {
            "id": motion_id,
            "domain": rows[0].get("domain", ""),
            "route_hint": rows[0].get("route_hint", ""),
            "prompt": rows[0].get("canonical_en") or rows[0].get("en") or "",
            "all_finite": all(bool(row.get("finite")) for row in rows),
        }
        for metric in METRICS:
            values = [float(row[metric]) for row in rows]
            record[metric + "_mean"] = float(np.mean(values))
            record[metric + "_std"] = float(np.std(values))
            record[metric + "_cv"] = coefficient_of_variation(values)
        domain = record["domain"]
        stationary_domain = domain in {"gesture", "dance", "static_pose"}
        root_mean = record["root_displacement_m_mean"]
        root_cv = record["root_displacement_m_cv"]
        record["root_behavior"] = (
            "stationary_ok"
            if stationary_domain and root_mean <= args.stationary_root_max
            else "unexpected_travel"
            if stationary_domain
            else "moving"
        )
        record["numeric_stability"] = (
            "stable"
            if record["all_finite"] and root_cv <= args.cv_max
            else "variable"
        )
        output.append(record)

    print("id\tdomain\troot_mean\troot_cv\tjoint_motion_mean\troot_behavior\tnumeric_stability")
    for row in output:
        print(
            f"{row['id']}\t{row['domain']}\t"
            f"{row['root_displacement_m_mean']:.3f}\t{row['root_displacement_m_cv']:.3f}\t"
            f"{row['mean_root_relative_joint_motion_m_per_frame_mean']:.5f}\t"
            f"{row['root_behavior']}\t{row['numeric_stability']}"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
