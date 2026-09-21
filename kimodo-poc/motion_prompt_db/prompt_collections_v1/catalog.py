"""Curated prompt collection v1 for Kimodo/Qwen motion research.

The catalog is built from short pose/action vocabulary researched from AI-image,
AI-video, idol-photo, fashion/editorial and runway references. Long source prompts
are not copied. Instead, normalized body mechanics are recombined into original
Japanese/canonical-English motion prompts.

All human subjects in this catalog are explicitly scoped to adults.
"""
from __future__ import annotations

from hashlib import sha256
from itertools import product

SUBJECT_AGE_SCOPE = "adult"

SOURCE_GROUPS = {
    "GE_SRC": [
        "mitsune_pose", "atelab_pose", "jcasablancas_editorial",
        "pixeledit_apparel", "ururu_gravure",
    ],
    "IC_SRC": [
        "edgehub_pose", "korea_gestures", "idol_fusion",
        "noa_kpop_heart", "reddit_idol_pose",
    ],
    "RF_SRC": [
        "runway_model_academy", "ngm_catwalk", "jobwork_catwalk",
        "pixeledit_apparel", "runway_video", "veo_guide",
    ],
    "DC_SRC": [
        "runway_video", "veo_guide", "edgehub_pose", "idol_fusion",
    ],
    "BS_SRC": [
        "ururu_gravure", "atelab_pose", "mitsune_pose",
        "jcasablancas_editorial", "pixeledit_apparel",
    ],
}


def _stable_take(items, count: int, salt: str):
    """Select a deterministic, well-distributed subset instead of taking product-order prefixes."""
    ranked = sorted(
        items,
        key=lambda item: sha256((salt + "|" + repr(item)).encode("utf-8")).digest(),
    )
    return ranked[:count]


def _row(pid, genre, ja, en, intensity, motion_type, route_hint, source_group,
         *, adult_glamour=False, hand_pose_critical=False):
    return {
        "id": pid,
        "genre": genre,
        "ja_prompt": ja,
        "canonical_en": en,
        "intensity": intensity,
        "motion_type": motion_type,
        "route_hint": route_hint,
        "source_group": source_group,
        "source_ids": SOURCE_GROUPS[source_group],
        "composition": "derived",
        "subject_age_scope": SUBJECT_AGE_SCOPE,
        "adult_glamour": adult_glamour,
        "hand_pose_critical": hand_pose_critical,
    }


# ---------------------------------------------------------------------------
# 1) Glamour / editorial — 200 adult-only non-explicit photo poses
# ---------------------------------------------------------------------------
GE_STANCES = [
    ("片脚に重心を乗せて立ち", "stand in contrapposto with weight on one leg"),
    ("脚を軽く交差して立ち", "stand with legs lightly crossed"),
    ("片脚を前に出して立ち", "stand with one leg forward"),
    ("片膝を少し曲げて立ち", "stand with one knee slightly bent"),
    ("壁にもたれて立ち", "stand leaning against a wall"),
    ("腰を横へずらして立ち", "stand with the hip shifted to one side"),
    ("肩幅より少し広く脚を開いて立ち", "stand with a slightly wide stance"),
    ("片足のかかとを上げて立ち", "stand with one heel lifted"),
]
GE_TORSO = [
    ("上体をわずかにひねり", "twist the torso slightly"),
    ("背筋を長く伸ばし", "elongate the torso"),
    ("上体を少し前へ傾け", "lean the torso slightly forward"),
    ("上体を少し後ろへ反らし", "arch the back slightly"),
    ("肩を片方だけ下げ", "drop one shoulder"),
]
GE_HANDS = [
    ("片手を腰に置く", "place one hand on the hip"),
    ("両腕を背中側へ回す", "hold both arms behind the back"),
    ("片手を髪に触れる", "touch the hair with one hand"),
    ("片手を太ももに添える", "rest one hand on the thigh"),
    ("片手を首元に添える", "place one hand near the neck"),
]
GE_GAZE = [
    ("顔を正面へ向ける", "face forward"),
    ("肩越しに振り返る", "look back over the shoulder"),
    ("顔を少し横へ向ける", "turn the face slightly to the side"),
    ("顎を少し下げる", "lower the chin slightly"),
    ("視線だけ横へ流す", "glance sideways"),
]


def _build_glamour():
    out = []
    combos = _stable_take(
        list(product(GE_STANCES, GE_TORSO, GE_HANDS, GE_GAZE)), 200, "glamour_editorial_v1"
    )
    for i, (stance, torso, hands, gaze) in enumerate(combos, start=1):
        ja = f"{stance[0]}、{torso[0]}、{hands[0]}。{gaze[0]}。"
        en = f"{stance[1]}; {torso[1]}; {hands[1]}; {gaze[1]}."
        out.append(_row(
            f"GE{i:03d}", "glamour_editorial", ja, en,
            2 + (i % 3), "static_pose", "pose_library", "GE_SRC",
            adult_glamour=True,
        ))
    return out


# ---------------------------------------------------------------------------
# 2) Idol / cute — 200 adult idol-photo/fan-service pose prompts
# ---------------------------------------------------------------------------
IC_BASE = [
    ("両足をそろえて軽く内股で立ち", "stand with feet together and toes slightly inward"),
    ("片足を少し前に出して立ち", "stand with one foot slightly forward"),
    ("片脚に軽く重心を乗せて立ち", "stand with weight lightly on one leg"),
    ("片足のかかとを上げて立ち", "stand with one heel lifted"),
    ("膝を少し曲げて小さくしゃがみ", "bend the knees into a tiny crouch"),
]
IC_GESTURE = [
    ("顔の横で右手のピースを作る", "make a right-hand peace sign beside the face", True),
    ("顔の横で両手のピースを作る", "make double peace signs beside the face", True),
    ("片手で指ハートを作る", "make a finger heart with one hand", True),
    ("両手で胸元にハートを作る", "make a heart with both hands near the chest", True),
    ("両手を頬の下に添える", "place both hands under the cheeks", False),
    ("両手を猫の手のように丸める", "hold both hands in a cat-paw pose", True),
    ("片手を頬に当てる", "place one hand on the cheek", False),
    ("片手でカメラへ小さく手を振る", "give a small wave toward the camera", False),
]
IC_EXPRESSION = [
    ("首を少し右へ傾ける", "tilt the head slightly right"),
    ("首を少し左へ傾ける", "tilt the head slightly left"),
    ("顎を少し引く", "lower the chin slightly"),
    ("顔を正面へ向ける", "face forward"),
    ("肩を少しすくめる", "raise the shoulders slightly"),
]


def _build_idol():
    out = []
    combos = _stable_take(
        list(product(IC_BASE, IC_GESTURE, IC_EXPRESSION)), 200, "idol_cute_v1"
    )
    for i, (base, gesture, expression) in enumerate(combos, start=1):
        ja = f"{base[0]}、{gesture[0]}。{expression[0]}。"
        en = f"{base[1]}; {gesture[1]}; {expression[1]}."
        route = "hand_layer" if gesture[2] else "direct"
        out.append(_row(
            f"IC{i:03d}", "idol_cute", ja, en,
            1 + (i % 3), "static_pose", route, "IC_SRC",
            hand_pose_critical=gesture[2],
        ))
    return out


# ---------------------------------------------------------------------------
# 3) Runway / fashion — 200 walk, turn, stop and garment-presenting prompts
# ---------------------------------------------------------------------------
RF_WALK = [
    ("まっすぐ前へ落ち着いたランウェイ歩きをする", "walk straight forward with a controlled runway stride"),
    ("脚をややクロスさせながらキャットウォークする", "catwalk forward with slightly crossing steps"),
    ("堂々としたパワーウォークで前進する", "move forward with a confident power walk"),
    ("ゆっくりしたモデル歩きで前進する", "walk forward with a slow model stride"),
    ("軽快だが姿勢を崩さず前進する", "move forward briskly while maintaining runway posture"),
]
RF_ARMS = [
    ("腕は自然に小さく振る", "keep a small natural arm swing"),
    ("両腕を体側に近づけて保つ", "keep both arms close to the sides"),
    ("片手を腰に添えながら歩く", "walk with one hand resting on the hip"),
    ("片手で衣装の裾を軽く見せる", "lightly present the garment hem with one hand"),
]
RF_FINISH = [
    ("最後に片脚へ重心を移して静止する", "finish by shifting weight onto one leg and hold", False),
    ("最後に半回転して正面へ戻る", "finish with a half turn and return to face forward", True),
    ("最後に肩越しへ振り返って静止する", "finish with an over-the-shoulder look and hold", False),
    ("最後に一歩止まって片手を腰に置く", "stop at the end and place one hand on the hip", True),
    ("最後に180度ピボットして歩き去る", "finish with a 180-degree pivot and walk away", True),
]
RF_STYLE = [("滑らかに", "smoothly"), ("シャープに", "sharply")]


def _build_runway():
    out = []
    combos = _stable_take(
        list(product(RF_WALK, RF_ARMS, RF_FINISH, RF_STYLE)), 200, "runway_fashion_v1"
    )
    for i, (walk, arms, finish, style) in enumerate(combos, start=1):
        ja = f"{style[0]}、{walk[0]}。{arms[0]}。{finish[0]}。"
        en = f"{style[1]}, {walk[1]}; {arms[1]}; {finish[1]}."
        out.append(_row(
            f"RF{i:03d}", "runway_fashion", ja, en,
            2 + (i % 3), "sequence",
            "direct", "RF_SRC",
        ))
    return out


# ---------------------------------------------------------------------------
# 4) Dynamic cute / idol dance — 200 short choreography prompts
# ---------------------------------------------------------------------------
DC_STEP = [
    ("左右に小さくステップする", "make small side-to-side steps"),
    ("その場で軽く弾む", "bounce lightly in place"),
    ("前へ二歩進んで一歩戻る", "take two steps forward and one step back"),
    ("小さくスキップしながら前進する", "skip forward with small steps"),
    ("左右へ体重移動しながらリズムを取る", "shift weight left and right to the rhythm"),
]
DC_UPPER = [
    ("両手を肩の高さで左右に振る", "swing both hands side to side at shoulder height"),
    ("右手を振ってから左手を振る", "wave the right hand and then the left"),
    ("両腕を胸元から外へ開く", "open both arms outward from the chest"),
    ("片手で前を指さしてから腕を戻す", "point forward with one hand and return the arm"),
    ("両手を上げて小さくV字を作る", "raise both hands into a small V shape"),
]
DC_FINISH = [
    ("最後に小さく半回転する", "finish with a small half turn", False),
    ("最後に片足を上げて決める", "finish by lifting one foot into a pose", False),
    ("最後に両手を頬の横へ持っていく", "finish with both hands beside the cheeks", False),
    ("最後に軽くジャンプして着地する", "finish with a small jump and landing", True),
    ("最後に胸元でハートポーズを作る", "finish with a heart pose near the chest", True),
]
DC_STYLE = [("ゆっくり", "slowly"), ("元気よく", "energetically")]


def _build_dynamic():
    out = []
    combos = _stable_take(
        list(product(DC_STEP, DC_UPPER, DC_FINISH, DC_STYLE)), 200, "dynamic_cute_dance_v1"
    )
    for i, (step, upper, finish, style) in enumerate(combos, start=1):
        ja = f"{style[0]}、{step[0]}。{upper[0]}。{finish[0]}。"
        en = f"{style[1]}, {step[1]}; {upper[1]}; {finish[1]}."
        out.append(_row(
            f"DC{i:03d}", "dynamic_cute_dance", ja, en,
            2 + (i % 3), "sequence", "direct", "DC_SRC",
            hand_pose_critical=finish[2],
        ))
    return out


# ---------------------------------------------------------------------------
# 5) Bold sensual — 200 adult-only, high-intensity, non-explicit poses
# ---------------------------------------------------------------------------
BS_LEVEL = [
    ("片膝立ちになり", "kneel on one knee"),
    ("両膝立ちになり", "kneel on both knees"),
    ("椅子にまたがるように座り", "sit straddling a chair"),
    ("床へ横向きに腰を下ろし", "sit sideways on the floor"),
    ("椅子へ深く腰掛け", "sit deep in a chair"),
]
BS_BODY = [
    ("背中を大きめに反らし", "arch the back deeply"),
    ("腰を強く横へひねり", "twist the hips strongly to one side"),
    ("上体を大胆に前へ傾け", "lean the torso boldly forward"),
    ("胸を開くように肩を後ろへ引き", "draw the shoulders back to open the chest"),
    ("腰を落としてS字のラインを強調し", "lower the hips into an emphasized S-curve"),
]
BS_HANDS = [
    ("片手を太ももに置く", "rest one hand on the thigh"),
    ("両手を太ももに置く", "rest both hands on the thighs"),
    ("片手を髪へ入れる", "place one hand in the hair"),
    ("両手を頭の後ろへ回す", "place both hands behind the head"),
    ("片手を腰に置く", "place one hand on the hip"),
]
BS_GAZE = [
    ("肩越しに強く振り返る", "look back boldly over the shoulder"),
    ("顎を少し上げて正面を見る", "raise the chin slightly and face forward"),
    ("視線を横へ流す", "give a sideways gaze"),
    ("顔を横へ向けて目線だけ戻す", "turn the face aside while returning the gaze"),
]


def _build_bold():
    out = []
    combos = _stable_take(
        list(product(BS_LEVEL, BS_BODY, BS_HANDS, BS_GAZE)), 200, "bold_sensual_v1"
    )
    for i, (level, body, hands, gaze) in enumerate(combos, start=1):
        ja = f"{level[0]}、{body[0]}、{hands[0]}。{gaze[0]}。"
        en = f"{level[1]}; {body[1]}; {hands[1]}; {gaze[1]}."
        out.append(_row(
            f"BS{i:03d}", "bold_sensual", ja, en,
            4 + (i % 2), "static_pose", "pose_library", "BS_SRC",
            adult_glamour=True,
        ))
    return out


GLAMOUR_EDITORIAL = _build_glamour()
IDOL_CUTE = _build_idol()
RUNWAY_FASHION = _build_runway()
DYNAMIC_CUTE_DANCE = _build_dynamic()
BOLD_SENSUAL = _build_bold()

PROMPTS = (
    GLAMOUR_EDITORIAL
    + IDOL_CUTE
    + RUNWAY_FASHION
    + DYNAMIC_CUTE_DANCE
    + BOLD_SENSUAL
)

BY_GENRE = {
    "glamour_editorial": GLAMOUR_EDITORIAL,
    "idol_cute": IDOL_CUTE,
    "runway_fashion": RUNWAY_FASHION,
    "dynamic_cute_dance": DYNAMIC_CUTE_DANCE,
    "bold_sensual": BOLD_SENSUAL,
}


def get_prompt(prompt_id: str):
    for row in PROMPTS:
        if row["id"] == prompt_id:
            return row
    raise KeyError(prompt_id)


FORBIDDEN_SCOPE_TERMS = (
    "schoolgirl", "school boy", "schoolboy", "teen", "minor", "child",
    "少女", "少年", "女子高生", "高校生", "中学生", "小学生",
    "nude", "naked", "explicit sexual",
)


def validate():
    assert len(PROMPTS) == 1000
    assert all(len(rows) == 200 for rows in BY_GENRE.values())
    ids = [row["id"] for row in PROMPTS]
    assert len(ids) == len(set(ids))
    assert all(row["subject_age_scope"] == "adult" for row in PROMPTS)
    assert all(1 <= row["intensity"] <= 5 for row in PROMPTS)
    assert all(row["intensity"] >= 4 for row in BOLD_SENSUAL)
    for row in PROMPTS:
        searchable = (row["ja_prompt"] + " " + row["canonical_en"]).lower()
        assert not any(term.lower() in searchable for term in FORBIDDEN_SCOPE_TERMS), row["id"]
    return {
        "total": len(PROMPTS),
        "genres": {genre: len(rows) for genre, rows in BY_GENRE.items()},
        "intensity": {
            level: sum(row["intensity"] == level for row in PROMPTS)
            for level in range(1, 6)
        },
    }


if __name__ == "__main__":
    print(validate())
