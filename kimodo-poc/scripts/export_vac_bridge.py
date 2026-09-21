import argparse
import json
import math
import re
from pathlib import Path

import numpy as np
import torch
from kimodo.geometry import matrix_to_quaternion


SCHEMA_VERSION = 1
SOURCE_MODEL = "Kimodo-SOMA-RP-v1.1"
REFLECT_X = np.diag([-1.0, 1.0, 1.0]).astype(np.float32)

# SOMA77 local-rotation chain -> Unity HumanBodyBones role.
# Tuple values are multiplied in hierarchy order when Kimodo has more joints
# than Unity Humanoid for the same anatomical segment. This is used for Neck1+Neck2
# and for non-thumb fingers where SOMA77 has a metacarpal-like *1 joint followed by
# three phalanx joints while Unity Humanoid exposes only Proximal/Intermediate/Distal.
HUMANOID_ROTATION_MAP = {
    "Hips": ("Hips",),
    "Spine": ("Spine1",),
    "Chest": ("Spine2",),
    "UpperChest": ("Chest",),
    "Neck": ("Neck1", "Neck2"),
    "Head": ("Head",),
    "LeftShoulder": ("LeftShoulder",),
    "LeftUpperArm": ("LeftArm",),
    "LeftLowerArm": ("LeftForeArm",),
    "LeftHand": ("LeftHand",),
    "LeftThumbProximal": ("LeftHandThumb1",),
    "LeftThumbIntermediate": ("LeftHandThumb2",),
    "LeftThumbDistal": ("LeftHandThumb3",),
    "LeftIndexProximal": ("LeftHandIndex1", "LeftHandIndex2"),
    "LeftIndexIntermediate": ("LeftHandIndex3",),
    "LeftIndexDistal": ("LeftHandIndex4",),
    "LeftMiddleProximal": ("LeftHandMiddle1", "LeftHandMiddle2"),
    "LeftMiddleIntermediate": ("LeftHandMiddle3",),
    "LeftMiddleDistal": ("LeftHandMiddle4",),
    "LeftRingProximal": ("LeftHandRing1", "LeftHandRing2"),
    "LeftRingIntermediate": ("LeftHandRing3",),
    "LeftRingDistal": ("LeftHandRing4",),
    "LeftLittleProximal": ("LeftHandPinky1", "LeftHandPinky2"),
    "LeftLittleIntermediate": ("LeftHandPinky3",),
    "LeftLittleDistal": ("LeftHandPinky4",),
    "RightShoulder": ("RightShoulder",),
    "RightUpperArm": ("RightArm",),
    "RightLowerArm": ("RightForeArm",),
    "RightHand": ("RightHand",),
    "RightThumbProximal": ("RightHandThumb1",),
    "RightThumbIntermediate": ("RightHandThumb2",),
    "RightThumbDistal": ("RightHandThumb3",),
    "RightIndexProximal": ("RightHandIndex1", "RightHandIndex2"),
    "RightIndexIntermediate": ("RightHandIndex3",),
    "RightIndexDistal": ("RightHandIndex4",),
    "RightMiddleProximal": ("RightHandMiddle1", "RightHandMiddle2"),
    "RightMiddleIntermediate": ("RightHandMiddle3",),
    "RightMiddleDistal": ("RightHandMiddle4",),
    "RightRingProximal": ("RightHandRing1", "RightHandRing2"),
    "RightRingIntermediate": ("RightHandRing3",),
    "RightRingDistal": ("RightHandRing4",),
    "RightLittleProximal": ("RightHandPinky1", "RightHandPinky2"),
    "RightLittleIntermediate": ("RightHandPinky3",),
    "RightLittleDistal": ("RightHandPinky4",),
    "LeftUpperLeg": ("LeftLeg",),
    "LeftLowerLeg": ("LeftShin",),
    "LeftFoot": ("LeftFoot",),
    "LeftToes": ("LeftToeBase",),
    "RightUpperLeg": ("RightLeg",),
    "RightLowerLeg": ("RightShin",),
    "RightFoot": ("RightFoot",),
    "RightToes": ("RightToeBase",),
}

SOMA77_NAMES = [
    "Hips", "Spine1", "Spine2", "Chest", "Neck1", "Neck2", "Head", "HeadEnd", "Jaw",
    "LeftEye", "RightEye", "LeftShoulder", "LeftArm", "LeftForeArm", "LeftHand",
    "LeftHandThumb1", "LeftHandThumb2", "LeftHandThumb3", "LeftHandThumbEnd",
    "LeftHandIndex1", "LeftHandIndex2", "LeftHandIndex3", "LeftHandIndex4", "LeftHandIndexEnd",
    "LeftHandMiddle1", "LeftHandMiddle2", "LeftHandMiddle3", "LeftHandMiddle4", "LeftHandMiddleEnd",
    "LeftHandRing1", "LeftHandRing2", "LeftHandRing3", "LeftHandRing4", "LeftHandRingEnd",
    "LeftHandPinky1", "LeftHandPinky2", "LeftHandPinky3", "LeftHandPinky4", "LeftHandPinkyEnd",
    "RightShoulder", "RightArm", "RightForeArm", "RightHand",
    "RightHandThumb1", "RightHandThumb2", "RightHandThumb3", "RightHandThumbEnd",
    "RightHandIndex1", "RightHandIndex2", "RightHandIndex3", "RightHandIndex4", "RightHandIndexEnd",
    "RightHandMiddle1", "RightHandMiddle2", "RightHandMiddle3", "RightHandMiddle4", "RightHandMiddleEnd",
    "RightHandRing1", "RightHandRing2", "RightHandRing3", "RightHandRing4", "RightHandRingEnd",
    "RightHandPinky1", "RightHandPinky2", "RightHandPinky3", "RightHandPinky4", "RightHandPinkyEnd",
    "LeftLeg", "LeftShin", "LeftFoot", "LeftToeBase", "LeftToeEnd",
    "RightLeg", "RightShin", "RightFoot", "RightToeBase", "RightToeEnd",
]
SOMA77_INDEX = {name: i for i, name in enumerate(SOMA77_NAMES)}


def _require_finite(name: str, value: np.ndarray) -> None:
    if not np.isfinite(value).all():
        raise ValueError(f"{name} contains NaN or Inf")


def _sanitize_clip_id(value: str) -> str:
    value = re.sub(r"[^A-Za-z0-9_-]+", "_", value or "").strip("_")
    return value[:96] or "kimodo_motion"


def _reflect_position(v: np.ndarray) -> np.ndarray:
    return v @ REFLECT_X.T


def _reflect_rotation(r: np.ndarray) -> np.ndarray:
    return REFLECT_X @ r @ REFLECT_X


def _rotation_y(angle: np.ndarray) -> np.ndarray:
    c = np.cos(angle)
    s = np.sin(angle)
    out = np.zeros((len(angle), 3, 3), dtype=np.float32)
    out[:, 0, 0] = c
    out[:, 0, 2] = s
    out[:, 1, 1] = 1.0
    out[:, 2, 0] = -s
    out[:, 2, 2] = c
    return out


def _matrix_to_xyzw(mats: np.ndarray) -> np.ndarray:
    # Kimodo geometry returns quaternions as WXYZ.
    with torch.inference_mode():
        q = matrix_to_quaternion(torch.from_numpy(mats.astype(np.float32))).cpu().numpy()
    q = q[..., [1, 2, 3, 0]].astype(np.float32)
    q /= np.maximum(np.linalg.norm(q, axis=-1, keepdims=True), 1e-8)
    flat = q.reshape((-1, 4))
    for i in range(1, len(flat)):
        if float(np.dot(flat[i - 1], flat[i])) < 0.0:
            flat[i] *= -1.0
    return flat.reshape(q.shape)


def _combine_local_rotations(local_rot_mats: np.ndarray, chain: tuple[str, ...]) -> np.ndarray:
    result = np.broadcast_to(np.eye(3, dtype=np.float32), (local_rot_mats.shape[0], 3, 3)).copy()
    for name in chain:
        result = result @ local_rot_mats[:, SOMA77_INDEX[name]]
    return result


def _key_list(times: np.ndarray, values: np.ndarray) -> list[dict]:
    return [
        {"time": round(float(t), 6), "value": [round(float(x), 7) for x in v]}
        for t, v in zip(times, values)
    ]


def export_bridge(
    npz_path: Path,
    output_path: Path,
    *,
    fps: float,
    clip_id: str,
    name: str,
    prompt: str,
    selected_specialist: str,
    loop: bool,
    root_motion_threshold_m: float,
    root_yaw_threshold_deg: float,
    articulated_fingers: bool = True,
) -> dict:
    if not npz_path.exists():
        raise FileNotFoundError(npz_path)
    data = np.load(npz_path)
    required = ("local_rot_mats", "root_positions", "smooth_root_pos", "global_root_heading")
    missing = [key for key in required if key not in data]
    if missing:
        raise ValueError(f"Motion NPZ is missing fields: {', '.join(missing)}")

    local_soma = data["local_rot_mats"].astype(np.float32)
    root_soma = data["root_positions"].astype(np.float32)
    smooth_soma = data["smooth_root_pos"].astype(np.float32)
    heading = data["global_root_heading"].astype(np.float32)
    if local_soma.ndim != 4 or local_soma.shape[1:] != (77, 3, 3):
        raise ValueError(f"local_rot_mats must be [T,77,3,3], got {local_soma.shape}")
    frame_count = int(local_soma.shape[0])
    if frame_count < 2:
        raise ValueError("At least two motion frames are required")
    if root_soma.shape != (frame_count, 3) or smooth_soma.shape != (frame_count, 3):
        raise ValueError("Root position arrays do not match frame count")
    if heading.shape != (frame_count, 2):
        raise ValueError("global_root_heading must be [T,2]")
    if not math.isfinite(fps) or fps <= 0.0 or fps > 240.0:
        raise ValueError("fps must be in (0,240]")
    for key, value in (("local_rot_mats", local_soma), ("root_positions", root_soma),
                       ("smooth_root_pos", smooth_soma), ("global_root_heading", heading)):
        _require_finite(key, value)

    # Convert the SOMA standard-T-pose basis to Unity's canonical left/right basis.
    local_unity = np.empty_like(local_soma)
    for joint in range(local_soma.shape[1]):
        local_unity[:, joint] = _reflect_rotation(local_soma[:, joint])
    root_unity = _reflect_position(root_soma)
    smooth_unity = _reflect_position(smooth_soma)

    # Kimodo heading [cos,sin] is +Z-forward. Reflecting X changes yaw sign.
    heading_soma = np.unwrap(np.arctan2(heading[:, 1], heading[:, 0]))
    heading_unity = -heading_soma
    heading_delta = np.unwrap(heading_unity - heading_unity[0])
    heading_mats = _rotation_y(heading_unity)
    heading0_inv = _rotation_y(np.asarray([-heading_unity[0]], dtype=np.float32))[0]

    root_planar_displacement = np.linalg.norm((smooth_unity[-1] - smooth_unity[0])[[0, 2]])
    root_planar_path = float(np.linalg.norm(np.diff(smooth_unity[:, [0, 2]], axis=0), axis=1).sum())
    use_root_position = max(float(root_planar_displacement), root_planar_path * 0.25) >= root_motion_threshold_m
    max_yaw_delta_deg = float(np.degrees(np.max(np.abs(heading_delta))))
    use_root_rotation = max_yaw_delta_deg >= root_yaw_threshold_deg

    # Align the generated motion to the target avatar's start facing.
    q = (root_unity - root_unity[0]) @ heading0_inv.T
    root_position = (smooth_unity - smooth_unity[0]) @ heading0_inv.T
    root_position[:, 1] = 0.0
    if not use_root_position:
        root_position[:] = 0.0

    if use_root_rotation:
        root_rotation_mats = _rotation_y(heading_delta.astype(np.float32))
    else:
        root_rotation_mats = np.broadcast_to(
            np.eye(3, dtype=np.float32), (frame_count, 3, 3)
        ).copy()

    # Hips local translation retains pelvic bob/sway after global trajectory extraction.
    residual_world = q - root_position
    hips_position = np.einsum("tji,tj->ti", root_rotation_mats, residual_world)

    # Hips canonical rotation retains pitch/roll and any yaw not assigned to avatar root.
    hips_world_aligned = np.einsum("ij,tjk->tik", heading0_inv, local_unity[:, SOMA77_INDEX["Hips"]])
    hips_rotation = np.einsum("tji,tjk->tik", root_rotation_mats, hips_world_aligned)

    times = np.arange(frame_count, dtype=np.float32) / float(fps)
    duration = frame_count / float(fps)

    bone_tracks = []
    finger_tokens = ("Thumb", "Index", "Middle", "Ring", "Little")
    for humanoid_bone, chain in HUMANOID_ROTATION_MAP.items():
        is_finger = any(token in humanoid_bone for token in finger_tokens)
        if is_finger and not articulated_fingers:
            continue
        if humanoid_bone == "Hips":
            mats = hips_rotation
        else:
            mats_soma = _combine_local_rotations(local_soma, chain)
            mats = np.empty_like(mats_soma)
            for frame in range(frame_count):
                mats[frame] = _reflect_rotation(mats_soma[frame])
        quats = _matrix_to_xyzw(mats)
        bone_tracks.append({
            "bone": humanoid_bone,
            "keys": _key_list(times, quats),
        })

    root_rotation_keys = _key_list(times, _matrix_to_xyzw(root_rotation_mats)) if use_root_rotation else []
    root_position_keys = _key_list(times, root_position) if use_root_position else []
    hips_position_keys = _key_list(times, hips_position)

    document = {
        "schemaVersion": SCHEMA_VERSION,
        "source": SOURCE_MODEL,
        "fps": float(fps),
        "frameCount": frame_count,
        "duration": round(duration, 6),
        "clipId": _sanitize_clip_id(clip_id),
        "name": name or clip_id or "Kimodo Motion",
        "loop": bool(loop),
        "rootMotion": bool(use_root_position or use_root_rotation),
        "rootMotionSpace": "avatarStartLocal",
        "sourcePrompt": prompt or "",
        "selectedSpecialist": selected_specialist or "",
        "coordinateSystem": "UnityCanonical",
        "articulatedFingerMotion": bool(articulated_fingers),
        "boneRotations": bone_tracks,
        "hipsPositionKeys": hips_position_keys,
        "rootPositionKeys": root_position_keys,
        "rootRotationKeys": root_rotation_keys,
        "diagnostics": {
            "rootPositionEnabled": bool(use_root_position),
            "rootRotationEnabled": bool(use_root_rotation),
            "planarRootDisplacementMeters": round(float(root_planar_displacement), 6),
            "planarRootPathMeters": round(root_planar_path, 6),
            "maxYawDeltaDegrees": round(max_yaw_delta_deg, 4),
            "rootMotionThresholdMeters": float(root_motion_threshold_m),
            "rootYawThresholdDegrees": float(root_yaw_threshold_deg),
        },
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(document, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    return document


def main() -> None:
    p = argparse.ArgumentParser(description="Export a Kimodo SOMA77 motion NPZ to the internal VAC bridge JSON format.")
    p.add_argument("--input", type=Path, required=True)
    p.add_argument("--output", type=Path, required=True)
    p.add_argument("--fps", type=float, default=30.0)
    p.add_argument("--clip-id", default="kimodo_motion")
    p.add_argument("--name", default="Kimodo Motion")
    p.add_argument("--prompt", default="")
    p.add_argument("--selected-specialist", default="")
    p.add_argument("--loop", action="store_true")
    p.add_argument("--root-motion-threshold-m", type=float, default=0.20)
    p.add_argument("--root-yaw-threshold-deg", type=float, default=30.0)
    args = p.parse_args()

    doc = export_bridge(
        args.input,
        args.output,
        fps=args.fps,
        clip_id=args.clip_id,
        name=args.name,
        prompt=args.prompt,
        selected_specialist=args.selected_specialist,
        loop=args.loop,
        root_motion_threshold_m=args.root_motion_threshold_m,
        root_yaw_threshold_deg=args.root_yaw_threshold_deg,
        articulated_fingers=True,
    )
    print(json.dumps({
        "output": str(args.output.resolve()),
        "frames": doc["frameCount"],
        "duration": doc["duration"],
        "boneTracks": len(doc["boneRotations"]),
        "rootMotion": doc["rootMotion"],
        "rootPosition": doc["diagnostics"]["rootPositionEnabled"],
        "rootRotation": doc["diagnostics"]["rootRotationEnabled"],
        "planarRootDisplacementMeters": doc["diagnostics"]["planarRootDisplacementMeters"],
        "maxYawDeltaDegrees": doc["diagnostics"]["maxYawDeltaDegrees"],
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
