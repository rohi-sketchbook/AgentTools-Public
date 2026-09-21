import argparse
import json
import random
from pathlib import Path

LOCOMOTIONS = [
    ("歩く", "walk"),
    ("走る", "run"),
    ("ジョギングする", "jog"),
    ("行進する", "march"),
    ("つま先立ちで歩く", "walk on tiptoes"),
    ("しゃがんだまま歩く", "crouch-walk"),
    ("スキップする", "skip"),
    ("軽く跳ねながら進む", "move forward with small hops"),
]
DIRECTIONS = [
    ("前に", "forward"),
    ("後ろに", "backward"),
    ("左に", "to the left"),
    ("右に", "to the right"),
]
STYLES = [
    ("ゆっくり", "slowly"),
    ("普通の速さで", "at a normal pace"),
    ("素早く", "quickly"),
    ("慎重に", "carefully"),
]
GESTURES = [
    ("右手を軽く振る", "gently wave the right hand"),
    ("左手を軽く振る", "gently wave the left hand"),
    ("右手を高く上げる", "raise the right hand high"),
    ("左手を高く上げる", "raise the left hand high"),
    ("右手で前を指さす", "point forward with the right hand"),
    ("左手で前を指さす", "point forward with the left hand"),
    ("両手を広げる", "spread both arms"),
    ("両手を胸の前で合わせる", "bring both hands together in front of the chest"),
]
STATIONARY = [
    ("お辞儀をする", "bow"),
    ("うなずく", "nod"),
    ("首を横に振る", "shake the head"),
    ("拍手する", "clap"),
    ("しゃがむ", "squat down"),
    ("立ち上がる", "stand up"),
    ("右足で前に蹴る", "kick forward with the right leg"),
    ("左足で前に蹴る", "kick forward with the left leg"),
    ("右手で前にパンチする", "punch forward with the right hand"),
    ("左手で前にパンチする", "punch forward with the left hand"),
    ("両腕を上に伸ばす", "stretch both arms upward"),
    ("腰を左右にひねる", "twist the torso left and right"),
    ("その場で一回転する", "spin around once in place"),
    ("右足で片足立ちする", "stand on the right leg"),
    ("左足で片足立ちする", "stand on the left leg"),
    ("軽くジャンプする", "make a small jump"),
]

# Stationary actions need multiple Japanese surface forms. With only one sentence
# per action, a random validation split can otherwise leave an action with no
# related training example at all.
STATIONARY_PARAPHRASES = {
    "bow": ["深くお辞儀をする", "上体を前に倒してお辞儀する", "その場で一礼する"],
    "nod": ["頭を上下に動かしてうなずく", "何度か軽くうなずく", "首を縦に振る"],
    "shake the head": ["首を左右に振る", "頭を左右に振る", "顔を左右に振って否定する"],
    "clap": ["両手をたたいて拍手する", "その場で手をたたく", "両手で何度か拍手する"],
    "squat down": ["その場でしゃがみ込む", "腰を落としてしゃがむ", "膝を曲げて低くしゃがむ"],
    "stand up": ["しゃがんだ姿勢から立ち上がる", "ゆっくり立ち上がる", "腰を上げて立つ"],
    "kick forward with the right leg": ["右脚を前に蹴り出す", "右足で前方をキックする", "右脚を振り上げて前に蹴る"],
    "kick forward with the left leg": ["左脚を前に蹴り出す", "左足で前方をキックする", "左脚を振り上げて前に蹴る"],
    "punch forward with the right hand": ["右腕で前にパンチする", "右拳を前へ突き出す", "右手で前方を殴る動きをする"],
    "punch forward with the left hand": ["左腕で前にパンチする", "左拳を前へ突き出す", "左手で前方を殴る動きをする"],
    "stretch both arms upward": ["両手を頭上へ伸ばす", "両腕をまっすぐ上に上げる", "両腕を高く伸ばす"],
    "twist the torso left and right": ["上半身を左右にひねる", "腰を左右にねじる", "胴体を左右へ交互にひねる"],
    "spin around once in place": ["その場で一周回る", "立ったまま一回転する", "その位置で360度回転する"],
    "stand on the right leg": ["右脚だけで片足立ちする", "右足を軸に片足で立つ", "左足を浮かせて右足一本で立つ"],
    "stand on the left leg": ["左脚だけで片足立ちする", "左足を軸に片足で立つ", "右足を浮かせて左足一本で立つ"],
    "make a small jump": ["その場で小さく跳ぶ", "軽くぴょんとジャンプする", "両足で小さく跳ねる"],
}

TARGET_JA = "ゆっくり前に歩きながら、右手を軽く振る。"
TARGET_EN = "Walk slowly forward while gently waving the right hand."


def add(rows, ja, en, kind):
    rows.append({"ja": ja, "en": en, "kind": kind})


def build_rows():
    rows = []
    for (lja, len_), (dja, den), (sja, sen) in [(l, d, s) for l in LOCOMOTIONS for d in DIRECTIONS for s in STYLES]:
        add(rows, f"{sja}{dja}{lja}。", f"{sen.capitalize()} {len_} {den}.", "locomotion")

    for (lja, len_), (dja, den), (sja, sen), (g_ja, g_en) in [
        (l, d, s, g) for l in LOCOMOTIONS[:4] for d in DIRECTIONS for s in STYLES for g in GESTURES
    ]:
        add(rows, f"{sja}{dja}{lja}ながら、{g_ja}。", f"{sen.capitalize()} {len_} {den} while you {g_en}.", "combined")

    for (sja, sen), (g_ja, g_en) in [(s, g) for s in STYLES for g in GESTURES]:
        add(rows, f"{sja}{g_ja}。", f"{sen.capitalize()} {g_en}.", "gesture")

    for ja, en in STATIONARY:
        add(rows, f"{ja}。", f"{en.capitalize()}.", "stationary")
        for variant_ja in STATIONARY_PARAPHRASES[en]:
            add(rows, f"{variant_ja}。", f"{en.capitalize()}.", "stationary_paraphrase")

    # Explicit compositional variants around the held-out target. These teach the
    # individual concepts without leaking the exact Japanese/English sentence.
    variants = [
        ("ゆっくり前に歩く。", "Walk slowly forward."),
        ("その場で右手を軽く振る。", "Gently wave the right hand while standing still."),
        ("ゆっくり前に歩きながら、左手を軽く振る。", "Walk slowly forward while gently waving the left hand."),
        ("普通の速さで前に歩きながら、右手を軽く振る。", "Walk forward at a normal pace while gently waving the right hand."),
        ("ゆっくり後ろに歩きながら、右手を軽く振る。", "Walk slowly backward while gently waving the right hand."),
        ("ゆっくり前に走りながら、右手を軽く振る。", "Run slowly forward while gently waving the right hand."),
    ]
    for ja, en in variants:
        add(rows, ja, en, "target_neighbor")

    # Deduplicate while preserving order.
    seen = set()
    unique = []
    for row in rows:
        key = (row["ja"], row["en"])
        if key not in seen and row["ja"] != TARGET_JA and row["en"] != TARGET_EN:
            seen.add(key)
            unique.append(row)
    return unique


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--seed", type=int, default=20260824)
    parser.add_argument("--train", type=int, default=448)
    parser.add_argument("--val", type=int, default=48)
    args = parser.parse_args()

    rows = build_rows()
    rng = random.Random(args.seed)
    rng.shuffle(rows)
    if args.train + args.val > len(rows):
        raise SystemExit(f"Requested {args.train + args.val} rows but only {len(rows)} are available")

    selected = rows[: args.train + args.val]
    for i, row in enumerate(selected):
        row["id"] = f"pair_{i:04d}"
        row["split"] = "train" if i < args.train else "val"

    selected.append({
        "id": "target_ja_walk_wave",
        "split": "test",
        "kind": "held_out_target",
        "ja": TARGET_JA,
        "en": TARGET_EN,
    })

    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("w", encoding="utf-8") as f:
        for row in selected:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
    print(json.dumps({"output": str(args.output), "train": args.train, "val": args.val, "test": 1, "available": len(rows)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
