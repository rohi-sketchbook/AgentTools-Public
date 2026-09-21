# -*- coding: shift_jis -*-
from __future__ import annotations

import json
import socket
from pathlib import Path
from typing import Any

LOOPBACK_HOST = "127.0.0.1"
DEFAULT_PORT = 9876


def request(
    request_type: str,
    params: dict[str, Any] | None = None,
    *,
    port: int = DEFAULT_PORT,
    timeout: float = 10.0,
) -> dict[str, Any]:
    if not 1024 <= int(port) <= 65535:
        raise ValueError("BlenderMCP port must be between 1024 and 65535")
    if timeout <= 0:
        raise ValueError("timeout must be positive")

    payload = json.dumps(
        {"type": request_type, "params": params or {}},
        ensure_ascii=True,
        separators=(",", ":"),
    ).encode("utf-8")

    with socket.create_connection((LOOPBACK_HOST, int(port)), timeout=timeout) as client:
        client.settimeout(timeout)
        client.sendall(payload)
        buffer = bytearray()
        while True:
            chunk = client.recv(8192)
            if not chunk:
                break
            buffer.extend(chunk)
            try:
                decoded = json.loads(buffer.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                continue
            if not isinstance(decoded, dict):
                raise RuntimeError("BlenderMCP returned a non-object JSON response")
            return decoded

    if not buffer:
        raise RuntimeError("BlenderMCP closed the connection without a response")
    raise RuntimeError("BlenderMCP returned incomplete or invalid JSON")


def get_scene_info(*, port: int = DEFAULT_PORT, timeout: float = 3.0) -> dict[str, Any]:
    response = request("get_scene_info", port=port, timeout=timeout)
    if response.get("status") != "success":
        raise RuntimeError(str(response.get("message") or "get_scene_info failed"))
    return response


def execute_code(code: str, *, port: int = DEFAULT_PORT, timeout: float = 30.0) -> dict[str, Any]:
    if not code.strip():
        raise ValueError("Blender code must not be empty")
    response = request("execute_code", {"code": code}, port=port, timeout=timeout)
    if response.get("status") != "success":
        raise RuntimeError(str(response.get("message") or "execute_code failed"))
    return response


def execute_script_file(path: str | Path, *, port: int = DEFAULT_PORT, timeout: float = 30.0) -> dict[str, Any]:
    script_path = Path(path)
    code = script_path.read_text(encoding="ascii")
    return execute_code(code, port=port, timeout=timeout)
