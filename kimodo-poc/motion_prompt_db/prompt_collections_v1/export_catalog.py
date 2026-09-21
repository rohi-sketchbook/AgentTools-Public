from __future__ import annotations

import argparse
import csv
import json
import sys
from pathlib import Path

from catalog import BY_GENRE, PROMPTS


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--genre", choices=["all", *BY_GENRE.keys()], default="all")
    p.add_argument("--format", choices=("jsonl", "tsv"), default="jsonl")
    p.add_argument("--output", type=Path)
    args = p.parse_args()

    rows = PROMPTS if args.genre == "all" else BY_GENRE[args.genre]
    stream = args.output.open("w", encoding="utf-8", newline="") if args.output else sys.stdout
    try:
        if args.format == "jsonl":
            for row in rows:
                stream.write(json.dumps(row, ensure_ascii=False) + "\n")
        else:
            fields = [
                "id", "genre", "ja_prompt", "canonical_en", "intensity",
                "motion_type", "route_hint", "source_group", "composition",
                "subject_age_scope", "adult_glamour", "hand_pose_critical",
            ]
            writer = csv.DictWriter(stream, fieldnames=fields, delimiter="\t", extrasaction="ignore")
            writer.writeheader()
            writer.writerows(rows)
    finally:
        if args.output:
            stream.close()


if __name__ == "__main__":
    main()
