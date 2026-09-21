import argparse
import json
import re
from pathlib import Path


SEQUENCE_MARKERS = [
    (re.compile(r"\s*。?\s*(?:そのあと|その後|続いて|次に|それから)\s*[、,]?\s*"), "sequence_marker"),
    (re.compile(r"\s*。?\s*(?:最後に|仕上げに|締めに|終わりに)\s*"), "finish_marker"),
    (re.compile(r"(?<=[てで])から\s*[、,]?\s*"), "after_marker"),
    (re.compile(r"(?<=た)あと(?:で|に)?\s*[、,]?\s*"), "after_marker"),
]

# These expressions indicate simultaneity and must not be split.
SIMULTANEOUS_MARKERS = ("ながら", "つつ", "まま")


def normalize(text: str) -> str:
    text = text.strip().replace("，", "、").replace(",", "、")
    text = re.sub(r"\s+", " ", text)
    return text


CLAUSE_END_NORMALIZATION = {
    "しゃがんで": "しゃがむ",
    "立ち上がって": "立ち上がる",
    "立ち上がり": "立ち上がる",
    "座って": "座る",
    "立って": "立つ",
    "歩いて": "歩く",
    "歩き": "歩く",
    "走って": "走る",
    "走り": "走る",
    "振り返って": "振り返る",
    "振り返り": "振り返る",
    "回って": "回る",
    "止まって": "止まる",
    "跳んで": "跳ぶ",
    "飛んで": "飛ぶ",
    "手を振って": "手を振る",
    "指さして": "指さす",
    "拍手して": "拍手する",
    "ジャンプして": "ジャンプする",
    "ターンして": "ターンする",
    "ポーズして": "ポーズする",
    "重心を移して": "重心を移す",
}


def normalize_clause_end(text: str) -> str:
    text = text.strip(" 、。")
    for suffix, replacement in sorted(CLAUSE_END_NORMALIZATION.items(), key=lambda kv: len(kv[0]), reverse=True):
        if text.endswith(suffix):
            return text[:-len(suffix)] + replacement
    return text


def split_explicit_sequence(text: str):
    parts = [(text, None)]
    for pattern, reason in SEQUENCE_MARKERS:
        next_parts = []
        for part, inherited_reason in parts:
            pos = 0
            found = False
            for m in pattern.finditer(part):
                left = part[pos:m.start()].strip(" 、。")
                if left:
                    if reason == "after_marker" or inherited_reason == "after_marker":
                        left = normalize_clause_end(left)
                    next_parts.append((left, inherited_reason))
                pos = m.end()
                inherited_reason = reason
                found = True
            tail = part[pos:].strip(" 、。")
            if tail:
                if inherited_reason == "after_marker":
                    tail = normalize_clause_end(tail)
                next_parts.append((tail, inherited_reason))
            elif not found and part.strip():
                next_parts.append((part.strip(), inherited_reason))
        parts = next_parts
    return parts


def split_finish_clause(text: str):
    # Common catalog/natural form: "A。B。最後にC" is already handled by marker.
    # Also accept a strong Japanese comma before an explicit finite follow-up action.
    # Do not split clauses containing simultaneity markers such as "ながら".
    if any(marker in text for marker in SIMULTANEOUS_MARKERS):
        return [(text, None)]
    return [(text, None)]


def infer_clip_type(text: str) -> str:
    if any(word in text for word in ("歩", "走", "進", "後退", "移動", "スキップ", "ステップ", "キャットウォーク", "ランウェイ")):
        return "locomotion_or_dynamic"
    if any(word in text for word in ("回転", "ターン", "振り返", "向き")):
        return "turn_or_orientation"
    if any(word in text for word in ("ジャンプ", "跳", "着地")):
        return "jump"
    if any(word in text for word in ("座", "膝", "しゃが", "立ち", "ポーズ", "重心", "腰")):
        return "pose_or_transition"
    if any(word in text for word in ("手を振", "ピース", "ハート", "指さ", "拍手", "頬", "髪")):
        return "gesture"
    return "generic_motion"


def recommended_duration(text: str, clip_type: str) -> float:
    if clip_type == "locomotion_or_dynamic":
        if any(word in text for word in ("ゆっくり", "ゆるやか", "落ち着")):
            return 4.0
        return 3.0
    if clip_type in ("turn_or_orientation", "jump"):
        return 2.0
    if clip_type == "pose_or_transition":
        return 2.5
    if clip_type == "gesture":
        return 2.0
    return 3.0


def plan(prompt: str) -> dict:
    """Analyze sequence complexity while keeping generation strictly single-VAC."""
    prompt = normalize(prompt)
    detected_stages = split_explicit_sequence(prompt)
    stage_count = max(1, len(detected_stages))
    ctype = infer_clip_type(prompt)
    duration = recommended_duration(prompt, ctype)
    if stage_count > 1:
        duration = max(duration, min(6.0, 2.0 + stage_count))

    return {
        "source_prompt": prompt,
        "mode": "single_vac",
        "clip_count": 1,
        "ordered_sequence_detected": stage_count > 1,
        "detected_stage_count": stage_count,
        "preserve_simultaneous_markers": list(SIMULTANEOUS_MARKERS),
        "clips": [{
            "index": 0,
            "prompt": prompt,
            "clip_type": ctype,
            "duration_seconds": duration,
            "split_reason": None,
            "routing": "generate_routed_motion",
        }],
        "notes": [
            "The AI motion feature always generates exactly one VAC.",
            "Temporal markers are detected only as a capability/difficulty signal; they never create clip boundaries.",
            "Simultaneous and ordered actions are both passed to Kimodo as one prompt.",
        ],
    }


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--prompt", required=True)
    p.add_argument("--output", type=Path)
    args = p.parse_args()
    result = plan(args.prompt)
    rendered = json.dumps(result, ensure_ascii=False, indent=2)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered + "\n", encoding="utf-8")
    print(rendered)


if __name__ == "__main__":
    main()
