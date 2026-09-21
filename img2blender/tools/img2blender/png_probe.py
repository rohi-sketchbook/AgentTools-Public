# -*- coding: shift_jis -*-
from __future__ import annotations

import struct
from pathlib import Path
from typing import Any

PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


def probe_png(path: str | Path) -> dict[str, Any]:
    image_path = Path(path)
    with image_path.open("rb") as stream:
        header = stream.read(33)

    if len(header) < 33:
        raise ValueError(f"PNG is too small: {image_path}")
    if header[:8] != PNG_SIGNATURE:
        raise ValueError(f"Not a PNG file: {image_path}")

    chunk_length = struct.unpack(">I", header[8:12])[0]
    chunk_type = header[12:16]
    if chunk_length != 13 or chunk_type != b"IHDR":
        raise ValueError(f"Invalid PNG IHDR: {image_path}")

    width, height, bit_depth, color_type, compression, filtering, interlace = struct.unpack(
        ">IIBBBBB", header[16:29]
    )

    if width <= 0 or height <= 0:
        raise ValueError("PNG dimensions must be positive")
    if bit_depth != 8:
        raise ValueError(f"Expected 8-bit PNG, got bit depth {bit_depth}")
    if interlace != 0:
        raise ValueError("Interlaced PNG is not supported by the lab baseline")
    if compression != 0 or filtering != 0:
        raise ValueError("Unsupported PNG compression/filter method")

    return {
        "path": str(image_path),
        "width": width,
        "height": height,
        "bitDepth": bit_depth,
        "colorType": color_type,
        "interlace": interlace,
        "safeBaseline": True,
    }
