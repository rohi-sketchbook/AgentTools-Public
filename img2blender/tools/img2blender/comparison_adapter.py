# -*- coding: shift_jis -*-
from __future__ import annotations

import subprocess
import sys
from pathlib import Path


def upstream_comparison_script() -> Path:
    root = Path(__file__).resolve().parents[2]
    script = root / "tools" / "img2threejs" / "forge" / "stage4_review" / "make_comparison_sheet.py"
    if not script.is_file():
        raise FileNotFoundError(
            "img2threejs comparison utility is missing; run bootstrap_img2threejs.cmd first"
        )
    return script


def make_comparison_sheet(reference: str | Path, render: str | Path, output: str | Path) -> None:
    command = [
        sys.executable,
        "-B",
        str(upstream_comparison_script()),
        "--reference",
        str(Path(reference)),
        "--render",
        str(Path(render)),
        "--out",
        str(Path(output)),
    ]
    result = subprocess.run(command, capture_output=True, text=True, check=False)
    if result.returncode != 0:
        details = (result.stderr or result.stdout or "comparison utility failed").strip()
        raise RuntimeError(details)
