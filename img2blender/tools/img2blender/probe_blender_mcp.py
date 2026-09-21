# -*- coding: shift_jis -*-
from __future__ import annotations

import argparse
import socket


def main() -> int:
    parser = argparse.ArgumentParser(description="Probe BlenderMCP TCP availability")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=9876)
    parser.add_argument("--timeout", type=float, default=2.0)
    args = parser.parse_args()

    try:
        with socket.create_connection((args.host, args.port), timeout=args.timeout):
            pass
    except OSError as exc:
        print(f"BlenderMCP unavailable at {args.host}:{args.port}: {exc}")
        return 2

    print(f"BlenderMCP TCP port is reachable at {args.host}:{args.port}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
