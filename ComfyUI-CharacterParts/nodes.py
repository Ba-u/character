"""
ComfyUI-CharacterParts v3
캐릭터 프롬프트를 [캐릭터(외형)] [감정] [의상] [배경] [임신] 프리팹으로 나눠 관리한다.

- 감정은 여러 개 선택 → 감정 × 임신 상태 조합마다 프롬프트를 리스트로 출력 (여러 장 생성)
- 모든 프리팹에 코드 (캐릭터 C01, 의상 O01, 배경 B01, 감정 E01 자동, 임신 전 NP01 / 임신 후 PG01)
- 감정마다 그룹 켜기/끄기 설정 (Fast Groups Muter 방식, 프론트엔드의 '감정별 실행' 버튼에서 적용)

노드 사이 연결은 모두 STRING(text).
저장 위치: ComfyUI/user/character_prefabs/*.json
"""

import copy
import json
import os
import re
import threading

# ---------------------------------------------------------------------------
# 스키마
# ---------------------------------------------------------------------------
SCHEMA = {
    "appearance": {
        "label": "캐릭터(외형)", "code_label": "캐릭터 코드", "prefix": "C", "auto_code": False, "code_is_name": False,
        "fields": [
            ("base", "기본 (1girl, 이름, 나이대)"),
            ("hair", "머리카락"),
            ("bangs", "앞머리"),
            ("eyes", "눈"),
            ("face", "얼굴/피부"),
            ("body_front", "체형 (앞)"),
            ("body_back", "체형 (뒤)"),
            ("nude_front", "나체 (앞)"),
            ("nude_back", "나체 (뒤)"),
            ("combat", "⚔ 전투 (무기·전투 자세 등)"),
        ],
    },
    "emotion": {
        "label": "감정", "code_label": "감정 코드", "prefix": "E", "auto_code": True, "code_is_name": True,
        "fields": [
            ("expression", "표정"),
            ("eyes", "눈 표현"),
            ("mouth", "입 모양"),
            ("effects", "감정 효과 (blush, tears, 땀방울...)"),
            ("gesture", "몸짓/포즈"),
        ],
    },
    "outfit": {
        "label": "의상", "code_label": "의상 코드", "prefix": "O", "auto_code": False, "code_is_name": False,
        "fields": [
            ("top", "상의"),
            ("bottom", "하의"),
            ("bra", "브라"),
            ("panties", "팬티"),
            ("legwear", "다리/양말/신발"),
            ("accessories", "액세서리"),
        ],
    },
    "background": {
        "label": "배경", "code_label": "", "prefix": "", "auto_code": False, "code_is_name": False,
        "has_code": False,
        "fields": [
            ("main", "대표 배경"),
            ("indoor", "실내 배경"),
            ("outdoor", "실외 배경"),
            ("common", "공통 (조명·구도 등, 모든 종류에 붙음)"),
        ],
    },
}
for _v in SCHEMA.values():
    _v.setdefault("has_code", True)

# 감정마다 캐릭터/의상의 어느 칸을 넣을지 — 여기 있는 칸은 기본이 '빼기'
PART_SECTIONS = ("appearance", "outfit")
DEFAULT_OFF = {"appearance": {"body_back", "nude_front", "nude_back", "combat"}, "outfit": {"bra", "panties"}}
# 이전 버전 칸 이름 → 새 칸 이름
FIELD_RENAMES = {"appearance": {"body": "body_front", "nude": "nude_front"}}


def default_parts():
    return {s: {k: k not in DEFAULT_OFF[s] for k, _ in SCHEMA[s]["fields"]} for s in PART_SECTIONS}


# 배경 종류 (감정마다 선택)
BG_VARIANTS = {"main": "대표", "indoor": "실내", "outdoor": "실외", "none": "없음"}
SECTIONS = list(SCHEMA.keys())
BASE_SECTIONS = ["appearance", "outfit", "background"]  # 캐릭터에 스냅샷으로 들어가는 섹션

PREG_KEYS = ("before", "after")
PREG_LABEL = {"before": "임신 전", "after": "임신 후"}
PREG_PREFIX = {"before": "NP", "after": "PG"}
STATE_CHOICES = {"임신 전 (before)": "before", "임신 후 (after)": "after", "둘 다 (both)": "both"}

COLLECTIONS = SECTIONS + ["pregnancy", "character", "emotion_group"]  # emotion_group = 감정 묶음
GROUP_ACTIONS = ("on", "mute", "bypass")

NONE = "(none)"
KEEP = "(keep)"
DEFAULT_FORMAT = "{character}_{outfit}_{emotion}_{pregnancy}"
DEFAULT_EXTRA_PATH = "점검중"  # 감정별 추가 경로 기본값
# 캐릭터마다 지정하는 의상 칸 (감정에서 어느 칸의 의상을 입힐지 고름)
CHAR_OUTFIT_SLOTS = {"default": "기본 의상", "idol": "아이돌 의상"}
OUTFIT_SLOT_CHOICES = ("node", "prefab", *CHAR_OUTFIT_SLOTS)
CATEGORY = "prompt/character prefab"


def _emo(expression, eyes, mouth, effects, gesture, bg_variant="main"):
    return {"code": "", "fields": {"expression": expression, "eyes": eyes, "mouth": mouth,
                                     "effects": effects, "gesture": gesture},
            "weight": 1.0, "negative": "", "note": "", "groups": {},
            "background": {"prefab": "", "variant": bg_variant}, "path": DEFAULT_EXTRA_PATH}


DEFAULTS = {  # 감정 코드는 이름과 같음 (seed 때 채움)
    "appearance": {
        "예시_은발소녀": {
            "code": "C01",
            "fields": {"base": "1girl, solo, young woman", "hair": "long hair, silver hair, straight hair",
                       "eyes": "red eyes", "face": "fair skin", "body": "slim"},
            "weight": 1.0, "negative": "", "note": "예시 프리팹",
            "outfits": {"default": "교복", "idol": "아이돌_무대의상"},
        },
    },
    "emotion": {
        "기쁨": _emo("happy, smile", "closed eyes, ^_^", "open mouth", "", "hands up"),
        "미소": _emo("gentle smile", "", "closed mouth", "light blush", ""),
        "슬픔": _emo("sad", "teary eyes, looking down", "frown", "tears, streaming tears", ""),
        "분노": _emo("angry", "glaring, narrowed eyes", "clenched teeth", "anger vein", "clenched hands"),
        "놀람": _emo("surprised", "wide-eyed", "open mouth, :o", "sweatdrop", ""),
        "부끄러움": _emo("embarrassed, shy", "looking away", "wavy mouth", "blush, full-face blush",
                     "hands on own cheeks"),
        "무표정": _emo("expressionless", "half-closed eyes", "closed mouth", "", ""),
    },
    "outfit": {
        "교복": {
            "code": "O01",
            "fields": {"top": "school uniform, white shirt, sailor collar, red neckerchief",
                       "bottom": "pleated skirt, navy skirt", "legwear": "black thighhighs, loafers",
                       "accessories": ""},
            "weight": 1.0, "negative": "", "note": "",
        },
        "아이돌_무대의상": {
            "code": "O03",
            "fields": {"top": "idol, idol clothes, frilled top, ribbon", "bottom": "frilled skirt, layered skirt",
                       "legwear": "white thighhighs, boots", "accessories": "hair ornament, microphone"},
            "weight": 1.0, "negative": "", "note": "",
        },
        "후드티_캐주얼": {
            "code": "O02",
            "fields": {"top": "oversized hoodie, grey hoodie", "bottom": "denim shorts",
                       "legwear": "sneakers", "accessories": "headphones around neck"},
            "weight": 1.0, "negative": "", "note": "",
        },
    },
    "background": {
        "밤_도시": {
            "fields": {"main": "city street, neon lights, night",
                       "indoor": "bar interior, neon sign, night",
                       "outdoor": "city street, neon lights, night, crowd",
                       "common": "rim light, cinematic lighting, cowboy shot"},
            "weight": 1.0, "negative": "", "note": "",
        },
        "교실": {
            "fields": {"main": "classroom, window, desks",
                       "indoor": "classroom, desks, chalkboard",
                       "outdoor": "school rooftop, fence, blue sky",
                       "common": "sunlight, afternoon, upper body"},
            "weight": 1.0, "negative": "", "note": "",
        },
    },
    "pregnancy": {
        "기본": {
            "before": {"code": "NP01", "prompt": "flat stomach", "negative": "pregnant"},
            "after": {"code": "PG01", "prompt": "pregnant, round belly", "negative": ""},
            "weight": 1.0, "note": "예시",
        },
    },
    "character": {},
    "emotion_group": {
        "기본 표정": {"emotions": ["기쁨", "미소", "무표정"], "note": "예시 묶음"},
        "부정 감정": {"emotions": ["슬픔", "분노"], "note": ""},
    },
}


# ---------------------------------------------------------------------------
# 저장소
# ---------------------------------------------------------------------------
def _data_dir():
    try:
        import folder_paths
        d = os.path.join(folder_paths.get_user_directory(), "character_prefabs")
    except Exception:
        d = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
    os.makedirs(d, exist_ok=True)
    return d


DATA_DIR = _data_dir()
_lock = threading.RLock()


def _path(coll):
    return os.path.join(DATA_DIR, f"{coll}.json")


def load_collection(coll):
    p = _path(coll)
    if not os.path.exists(p):
        return {}
    try:
        with open(p, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except Exception as e:
        print(f"[CharacterPrefab] {p} 읽기 실패: {e}")
        return {}


def write_collection(coll, data):
    with _lock:
        p = _path(coll)
        tmp = p + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        os.replace(tmp, p)


def all_collections():
    return {c: load_collection(c) for c in COLLECTIONS}


def nat_key(s):
    """자연 정렬 키: 이름 속 숫자는 숫자 크기로 비교 (1, 2, 3 … 10, 11)."""
    return [(0, int(t), "") if t.isdigit() else (1, 0, t.lower()) for t in re.split(r"(\d+)", str(s)) if t != ""]


def names(coll):
    return sorted(load_collection(coll).keys(), key=nat_key)


def _mtimes():
    return "|".join(
        str(os.path.getmtime(_path(c))) if os.path.exists(_path(c)) else "0" for c in COLLECTIONS
    )


def _dict(v):
    return v if isinstance(v, dict) else {}


def _str(v):
    return str(v or "")


# ---------------------------------------------------------------------------
# 코드
# ---------------------------------------------------------------------------
def next_code(prefix, used):
    n = 1
    while f"{prefix}{n:02d}" in used:
        n += 1
    return f"{prefix}{n:02d}"


def _codes_of(coll, item):
    if coll == "pregnancy":
        return [_str(_dict(item.get(k)).get("code")).strip() for k in PREG_KEYS]
    return [_str(item.get("code")).strip()]


def used_codes(coll, items, exclude=()):
    """{code: 사용 중인 이름}"""
    out = {}
    for n, v in items.items():
        if n in exclude or not isinstance(v, dict):
            continue
        for c in _codes_of(coll, v):
            if c:
                out[c] = n
    return out


def _migrate_and_seed():
    """기본값 생성 + 코드가 없는 기존 항목에 코드 자동 부여 (이전 버전 호환)."""
    for coll, items in DEFAULTS.items():
        if not os.path.exists(_path(coll)):
            write_collection(coll, copy.deepcopy(items))
    emos = load_collection("emotion")
    if any(_dict(v).get("code") != n for n, v in emos.items()):
        for n, v in emos.items():
            if isinstance(v, dict):
                v["code"] = n  # 감정 코드 = 감정 이름
        write_collection("emotion", emos)
    bgs = load_collection("background")
    if any("main" not in _dict(_dict(v).get("fields")) or _dict(v).get("code") for v in bgs.values()):
        write_collection("background", {n: norm_prefab("background", v) for n, v in bgs.items()})
    for coll in SECTIONS + ["pregnancy"]:
        if SCHEMA.get(coll, {}).get("code_is_name") or not SCHEMA.get(coll, {}).get("has_code", True):
            continue
        items = load_collection(coll)
        changed = False
        for name, v in items.items():
            if not isinstance(v, dict):
                continue
            used = used_codes(coll, items)
            if coll == "pregnancy":
                for k in PREG_KEYS:
                    st = v[k] = _dict(v.get(k))
                    if not _str(st.get("code")).strip():
                        st["code"] = next_code(PREG_PREFIX[k], used)
                        used[st["code"]] = name
                        changed = True
            elif not _str(v.get("code")).strip():
                v["code"] = next_code(SCHEMA[coll]["prefix"], used)
                changed = True
        if changed:
            write_collection(coll, items)




# ---------------------------------------------------------------------------
# 정규화
# ---------------------------------------------------------------------------
def clean_tags(text) -> str:
    if not text:
        return ""
    tags, seen = [], set()
    for t in str(text).replace("\n", ",").split(","):
        t = t.strip()
        if t and t.lower() not in seen:
            seen.add(t.lower())
            tags.append(t)
    return ", ".join(tags)


def apply_weight(text, weight) -> str:
    text = clean_tags(text)
    if not text or weight <= 0:
        return ""
    if abs(weight - 1.0) < 1e-6:
        return text
    return f"({text}:{weight:.2f})"


def _float(v, default=1.0):
    try:
        return max(0.0, min(2.0, float(v)))
    except (TypeError, ValueError):
        return default


def _migrate_bg_fields(fields):
    """v1~v6 배경 필드(scene/lighting/composition) → 대표/공통."""
    if "main" in fields or not any(k in fields for k in ("scene", "lighting", "composition")):
        return fields
    common = ", ".join(_str(fields.get(k)) for k in ("lighting", "composition") if _str(fields.get(k)).strip())
    return {"main": _str(fields.get("scene")), "indoor": "", "outdoor": "", "common": common}


def norm_path(v):
    """추가 경로 정리: 역슬래시→/, 앞뒤 / 제거, 빈 조각·'.'·'..' 제거."""
    parts = [p.strip() for p in _str(v).replace("\\", "/").split("/")]
    return "/".join(p for p in parts if p and p not in (".", ".."))


def norm_emotion_outfit(d):
    """감정별 의상.
    slot: node = 노드 의상 / default = 캐릭터 기본 의상 / idol = 캐릭터 아이돌 의상 / prefab = 특정 의상(prefab)
    code: 의상 코드 직접 지정 (비우면 입힌 의상의 코드)"""
    d = _dict(d)
    prefab = _str(d.get("prefab")).strip()
    slot = d.get("slot")
    if slot not in OUTFIT_SLOT_CHOICES:
        slot = "prefab" if prefab else "node"  # 이전 버전 호환
    return {"slot": slot, "prefab": prefab, "code": _str(d.get("code")).strip()}


def norm_emotion_bg(d):
    d = _dict(d)
    v = d.get("variant")
    return {"prefab": _str(d.get("prefab")).strip(), "variant": v if v in BG_VARIANTS else "main"}


DEFAULT_SIZE = (1024, 1024)
RES_PRESETS = [  # (라벨, 가로, 세로) — 매니저 창의 빠른 선택
    ("1:1", 1024, 1024), ("2:3 세로", 832, 1216), ("3:2 가로", 1216, 832),
    ("3:4 세로", 896, 1152), ("4:3 가로", 1152, 896), ("9:16 세로", 768, 1344), ("16:9 가로", 1344, 768),
    ("SD 세로", 512, 768), ("SD 가로", 768, 512),
]


def _size(v, default):
    try:
        v = int(v)
    except (TypeError, ValueError):
        return default
    return max(64, min(8192, v // 8 * 8))


def norm_resolution(d):
    """감정별 해상도: mode node = 노드 설정 따름, custom = width×height."""
    d = _dict(d)
    mode = d.get("mode") if d.get("mode") in ("node", "custom") else "node"
    return {"mode": mode, "width": _size(d.get("width"), DEFAULT_SIZE[0]), "height": _size(d.get("height"), DEFAULT_SIZE[1])}


def norm_extras(v):
    """캐릭터의 추가 프롬: [{name, positive, negative}] — 이름 중복/빈 이름 제거."""
    out, seen = [], set()
    for e in v if isinstance(v, list) else []:
        e = _dict(e)
        name = _str(e.get("name")).strip()
        if not name or name in seen:
            continue
        seen.add(name)
        out.append({"name": name, "positive": _str(e.get("positive")), "negative": _str(e.get("negative"))})
    return out


def norm_prefab(section, d):
    d = _dict(d)
    fields = _dict(d.get("fields"))
    if section == "background":
        fields = _migrate_bg_fields(fields)
    for old, new in FIELD_RENAMES.get(section, {}).items():
        if old in fields and new not in fields:
            fields = {**fields, new: fields[old]}
    out = {
        "code": _str(d.get("code")).strip(),
        "fields": {k: _str(fields.get(k)) for k, _ in SCHEMA[section]["fields"]},
        "weight": _float(d.get("weight", 1.0)),
        "negative": _str(d.get("negative")),
        "note": _str(d.get("note")),
    }
    if section == "emotion":
        out["groups"] = {str(k): v for k, v in _dict(d.get("groups")).items() if v in GROUP_ACTIONS}
        out["background"] = norm_emotion_bg(d.get("background"))
        parts = {s: dict(_dict(v)) for s, v in _dict(d.get("parts")).items()}
        for sec, ren in FIELD_RENAMES.items():
            for old, new in ren.items():
                if old in parts.get(sec, {}) and new not in parts[sec]:
                    parts[sec][new] = parts[sec][old]
        out["parts"] = {
            s: {k: bool(_dict(parts.get(s)).get(k, on)) for k, on in default_parts()[s].items()}
            for s in PART_SECTIONS
        }
        out["resolution"] = norm_resolution(d.get("resolution"))
        # 캐릭터의 '추가 프롬' 중 이 감정에서 켤 것 (기본 꺼짐)
        out["extras"] = {str(k).strip(): True for k, v in _dict(d.get("extras")).items() if v and str(k).strip()}
        out["outfit"] = norm_emotion_outfit(d.get("outfit"))
        # 감정별 추가 경로 (저장 폴더). 값이 없던 감정은 기본값 '점검중', 일부러 비우면 경로 없음
        out["path"] = DEFAULT_EXTRA_PATH if d.get("path") is None else norm_path(d.get("path"))
        out["folder"] = norm_path(d.get("folder"))  # 매니저/노드에서 감정을 묶어 보여줄 폴더 (정리용)
    if section == "appearance":
        out["extras"] = norm_extras(d.get("extras"))
        outfits = _dict(d.get("outfits"))
        out["outfits"] = {k: _str(outfits.get(k)).strip() for k in CHAR_OUTFIT_SLOTS}
    if not SCHEMA[section]["has_code"]:
        out["code"] = ""
    return out


def norm_state(d):
    d = _dict(d)
    return {"code": _str(d.get("code")).strip(), "prompt": _str(d.get("prompt")), "negative": _str(d.get("negative"))}


def norm_pregnancy(d):
    d = _dict(d)
    return {
        "before": norm_state(d.get("before")),
        "after": norm_state(d.get("after")),
        "weight": _float(d.get("weight", 1.0)),
        "note": _str(d.get("note")),
    }


def has_pregnancy(p):
    return bool(p.get("name")) or any(p[k]["code"] or p[k]["prompt"] for k in PREG_KEYS)


def norm_base(d):
    """캐릭터(저장 단위). 감정은 이름 목록으로, 나머지는 스냅샷으로 보관."""
    d = _dict(d)
    out = {}
    for s in BASE_SECTIONS:
        sec = _dict(d.get(s))
        out[s] = {"name": _str(sec.get("name")), **norm_prefab(s, sec)}
    preg = _dict(d.get("pregnancy"))
    out["pregnancy"] = {"name": _str(preg.get("name")), **norm_pregnancy(preg)}
    emotions = d.get("emotions")
    if not isinstance(emotions, list):  # v2 호환: 단일 emotion 섹션
        old = _dict(d.get("emotion"))
        emotions = [old["name"]] if old.get("name") else []
    out["emotions"] = [str(e).strip() for e in emotions if str(e).strip()]
    st = d.get("pregnancy_state")
    out["pregnancy_state"] = st if st in ("before", "after", "both") else "before"
    for k in ("quality", "expression_pose", "extra", "negative", "note"):
        out[k] = _str(d.get(k))
    return out


_migrate_and_seed()  # 정규화 함수들이 정의된 뒤 실행


# ---------------------------------------------------------------------------
# 렌더링
# ---------------------------------------------------------------------------
def section_text(section, sec, include=None, skip=()):
    """include: {칸: True/False} (감정별 포함 설정). skip: 따로 렌더링하는 칸."""
    keys = [k for k, _ in SCHEMA[section]["fields"] if k not in skip and (include is None or include.get(k, True))]
    raw = ", ".join(sec["fields"].get(k, "") for k in keys)
    return apply_weight(raw, sec["weight"])


def resolve_emotions(tokens, emo_items):
    """감정 이름 또는 감정 코드 목록 → 감정 이름 목록 (중복 제거, 순서 유지)."""
    if isinstance(tokens, str):
        tokens = tokens.replace("\n", ",").split(",")
    by_code = {_str(_dict(v).get("code")).strip().lower(): n for n, v in emo_items.items()}
    out = []
    for t in tokens:
        t = str(t).strip()
        if not t:
            continue
        name = t if t in emo_items else by_code.get(t.lower())
        if name is None:
            print(f"[CharacterPrefab] 감정 '{t}' 을(를) 찾을 수 없어 건너뜁니다.")
        elif name not in out:
            out.append(name)
    return out


class _SafeDict(dict):
    def __missing__(self, key):
        return ""


def format_code(fmt, values):
    try:
        s = (fmt or DEFAULT_FORMAT).format_map(_SafeDict(values))
    except Exception:
        s = DEFAULT_FORMAT.format_map(_SafeDict(values))
    s = re.sub(r"([_\-. ])[_\-. ]+", r"\1", s)  # 빈 코드로 생긴 연속 구분자 정리
    return s.strip("_-. ")


def background_text(bg, variant):
    if variant == "none":
        return ""
    f = bg["fields"]
    main = f.get(variant, "") if variant in ("indoor", "outdoor") else f.get("main", "")
    if not main.strip() and variant in ("indoor", "outdoor"):
        main = f.get("main", "")  # 실내/실외가 비어 있으면 대표 배경 사용
    return apply_weight(", ".join([main, f.get("common", "")]), bg["weight"])


def _outfit_is_empty(o):
    return not o.get("name") and not any(_str(v).strip() for v in o.get("fields", {}).values())


def resolve_outfit(base, emo):
    """감정에서 고른 의상 칸에 따라 입힐 의상을 결정.
    node: 노드 의상 (노드 의상이 비어 있으면 캐릭터 기본 의상) / default·idol: 캐릭터에 지정한 의상 / prefab: 특정 의상"""
    items = load_collection("outfit")
    get = lambda n: {"name": n, **norm_prefab("outfit", items[n])} if n and n in items else None
    char_outfits = base["appearance"].get("outfits", {})
    slot = emo["outfit"]["slot"] if emo else "node"
    if slot == "prefab":
        r = get(emo["outfit"]["prefab"])
        if r:
            return r
        print(f"[CharacterPrefab] 감정 '{emo['name']}' 의 의상 '{emo['outfit']['prefab']}' 이(가) 없어 노드 의상을 씁니다.")
    elif slot in CHAR_OUTFIT_SLOTS:
        r = get(char_outfits.get(slot))
        if r:
            return r
        print(f"[CharacterPrefab] 캐릭터 '{base['appearance'].get('name')}' 에 {CHAR_OUTFIT_SLOTS[slot]} 이(가) 없어 노드 의상을 씁니다.")
    if _outfit_is_empty(base["outfit"]):
        r = get(char_outfits.get("default"))  # 노드 의상이 비었으면 캐릭터 기본 의상
        if r:
            return r
    return base["outfit"]


def resolve_background(base, emo):
    """감정이 배경 프리팹을 지정했으면 그것, 아니면 노드/캐릭터의 배경."""
    pref = emo["background"]["prefab"] if emo else ""
    if pref:
        items = load_collection("background")
        if pref in items:
            return {"name": pref, **norm_prefab("background", items[pref])}
        print(f"[CharacterPrefab] 감정 '{emo['name']}' 의 배경 '{pref}' 이(가) 없어 노드 배경을 씁니다.")
    return base["background"]


def render_item(base, emo_name, emo_items, state, size=DEFAULT_SIZE):
    emo = {"name": emo_name or "", **norm_prefab("emotion", emo_items.get(emo_name) if emo_name else {})}
    bg = resolve_background(base, emo if emo_name else None)
    variant = emo["background"]["variant"] if emo_name else "main"
    preg = base["pregnancy"]
    ps = preg[state] if state else norm_state({})

    parts = emo["parts"] if emo_name else default_parts()  # 감정 없으면 기본 설정
    outfit = resolve_outfit(base, emo if emo_name else None)
    app_ = base["appearance"]
    combat = apply_weight(app_["fields"].get("combat", ""), app_["weight"]) if parts["appearance"].get("combat") else ""
    on_extras = emo.get("extras", {}) if emo_name else {}
    extras = [x for x in app_.get("extras", []) if on_extras.get(x["name"])]
    chunks = [
        clean_tags(base["quality"]),
        section_text("appearance", app_, parts["appearance"], skip=("combat",)),
        *[apply_weight(x["positive"], app_["weight"]) for x in extras],
        apply_weight(ps["prompt"], preg["weight"]) if state else "",
        section_text("emotion", emo),
        clean_tags(base["expression_pose"]),
        combat,
        section_text("outfit", outfit, parts["outfit"]),
        background_text(bg, variant),
        clean_tags(base["extra"]),
    ]
    pos = ", ".join(c for c in chunks if c)
    negs = [base["negative"]] + [sec["negative"] for sec in (app_, outfit) if sec["weight"] > 0]
    if app_["weight"] > 0:
        negs += [x["negative"] for x in extras]
    if bg["weight"] > 0 and variant != "none":
        negs.append(bg["negative"])
    if emo["weight"] > 0:
        negs.append(emo["negative"])
    if state and preg["weight"] > 0:
        negs.append(ps["negative"])
    neg = clean_tags(", ".join(negs))

    codes = {
        "character": base["appearance"]["code"],
        "outfit": (emo["outfit"]["code"] if emo_name else "") or outfit["code"],  # 감정에서 의상 코드 직접 지정 가능
        "emotion": emo_name or "",  # 감정 코드 = 감정 이름
        "pregnancy": ps["code"],
    }
    code = format_code(DEFAULT_FORMAT, codes)
    item = copy.deepcopy(base)
    item["item"] = {"emotion": emo_name or "", "pregnancy_state": state or "", "codes": codes, "code": code,
                    "background": bg.get("name", ""), "background_variant": variant, "outfit": outfit.get("name", ""),
                    "extras": [x["name"] for x in extras]}
    res = emo["resolution"] if emo_name else norm_resolution({})
    w, h = (res["width"], res["height"]) if res["mode"] == "custom" else size
    extra_path = emo["path"] if emo_name else DEFAULT_EXTRA_PATH
    save_path = "/".join(x for x in (extra_path, code) if x)
    item["item"].update(width=w, height=h, path=extra_path)
    return {"positive": pos, "negative": neg, "json": json.dumps(item, ensure_ascii=False),
            "code": code, "emotion": emo_name or "", "width": w, "height": h,
            "extra_path": extra_path, "save_path": save_path,
            **{f"{k}_code": v for k, v in codes.items()}}


def fill_missing_codes(base):
    """이전 버전에서 저장된 캐릭터처럼 코드가 비어 있으면, 같은 이름의 현재 프리팹 코드로 채움."""
    for s in ("appearance", "outfit"):
        sec = base[s]
        if not sec["code"] and sec["name"]:
            sec["code"] = _str(_dict(load_collection(s).get(sec["name"])).get("code")).strip()
    p = base["pregnancy"]
    if p["name"]:
        src = _dict(load_collection("pregnancy").get(p["name"]))
        for k in PREG_KEYS:
            if not p[k]["code"]:
                p[k]["code"] = _str(_dict(src.get(k)).get("code")).strip()
    return base


def expand(base, size=DEFAULT_SIZE):
    """감정 × 임신 상태 조합마다 1개씩. size = 노드의 기본 해상도."""
    base = fill_missing_codes(copy.deepcopy(base))
    emo_items = load_collection("emotion")
    emotions = sorted(resolve_emotions(base["emotions"], emo_items), key=nat_key) or [None]  # 숫자 순으로 생성
    if has_pregnancy(base["pregnancy"]):
        st = base["pregnancy_state"]
        states = ["before", "after"] if st == "both" else [st]
    else:
        states = [None]
    return [render_item(base, e, emo_items, s, size) for e in emotions for s in states]


_OUT = [  # (출력 이름, render_item 키, 설명, 타입)
    ("positive", "positive", "포지티브 프롬프트 (감정 × 임신 상태마다 1개)"),
    ("negative", "negative", "네거티브 프롬프트"),
    ("character", "json", "캐릭터 전체 정보 JSON 텍스트 → Character Save / Character Codes에 연결"),
    ("code", "code", "조합 코드 (예: C01_O02_E03_PG01) → Save Image 파일명 등에 연결"),
    ("character_code", "character_code", "캐릭터 코드 (C01)"),
    ("emotion_code", "emotion_code", "감정 코드 (= 감정 이름)"),
    ("outfit_code", "outfit_code", "의상 코드 (O01)"),
    ("pregnancy_code", "pregnancy_code", "임신 여부 코드 (임신 전 NP01 / 임신 후 PG01)"),
    ("emotion_name", "emotion", "감정 이름"),
    ("width", "width", "가로 해상도 → Empty Latent Image 의 width 에 연결", "INT"),
    ("height", "height", "세로 해상도 → Empty Latent Image 의 height 에 연결", "INT"),
    ("extra_path", "extra_path", "감정별 추가 경로 (기본 '점검중')"),
    ("save_path", "save_path", "추가 경로/코드 (예: 점검중/C01_O01_기쁨) → Save Image 의 filename_prefix 에 연결"),
]
_OUT = [o if len(o) == 4 else (*o, "STRING") for o in _OUT]


def outputs(base, size=DEFAULT_SIZE):
    items = expand(base, size)
    return tuple([it[k] for it in items] for _, k, _, _ in _OUT)


OUT_TYPES = tuple(t for _, _, _, t in _OUT)
OUT_NAMES = tuple(n for n, _, _, _ in _OUT)
OUT_LIST = (True,) * len(_OUT)
OUT_TIPS = tuple(t for _, _, t, _ in _OUT)


def _size_widget(default, label):
    return ("INT", {"default": default, "min": 64, "max": 8192, "step": 8,
                    "tooltip": f"기본 {label} 해상도 (감정에서 해상도를 따로 정하면 그 값을 사용)"})

RUN_MODES = ["감정마다 따로 실행 (그룹 적용)", "한 번에 실행 (리스트)"]
RUN_MODE_TIP = ("감정마다 따로: Run 한 번에 감정(×임신 상태)마다 별도 작업으로 큐에 들어가 결과물이 각각 나오고, "
                "감정별 그룹 설정이 적용됩니다. 한 번에: 작업 하나에서 리스트로 모두 생성")


def strip_selection(base):
    """캐릭터로 저장할 때는 감정 선택과 임신 설정을 빼고 저장 (불러올 때 노드에서 고름)."""
    base = copy.deepcopy(base)
    base["emotions"] = []
    base["pregnancy"] = {"name": "", **norm_pregnancy({})}
    base["pregnancy_state"] = "before"
    return base


def prefab_or_empty(section, name):
    if name and name not in (NONE, KEEP):
        items = load_collection(section)
        if name in items:
            return {"name": name, **norm_prefab(section, items[name])}
        print(f"[CharacterPrefab] '{name}' {SCHEMA[section]['label']} 프리팹이 없어 비워둡니다.")
    return {"name": "", **norm_prefab(section, {})}


def pregnancy_or_empty(name):
    if name and name not in (NONE, KEEP):
        items = load_collection("pregnancy")
        if name in items:
            return {"name": name, **norm_pregnancy(items[name])}
        print(f"[CharacterPrefab] 임신 프리팹 '{name}' 이(가) 없어 비워둡니다.")
    return {"name": "", **norm_pregnancy({})}


def parse_character_text(text, negative=""):
    """Composer/Load의 character(JSON) → (base, item). 일반 텍스트 → extra 로."""
    text = (text or "").strip()
    if text.startswith("{"):
        try:
            d = json.loads(text)
            if isinstance(d, dict) and any(k in d for k in SECTIONS + ["pregnancy", "emotions"]):
                base = norm_base(d)
                if negative and negative.strip():
                    base["negative"] = clean_tags(f"{base['negative']}, {negative}")
                return base, _dict(d.get("item"))
        except ValueError:
            pass
    return norm_base({"extra": text, "negative": negative or ""}), {}


def _line(default="", tip=""):
    return ("STRING", {"default": default, "multiline": False, "tooltip": tip})


EMOTIONS_TIP = "감정 이름(= 감정 코드)을 쉼표로 여러 개 (예: 기쁨, 슬픔). 감정마다 1장씩 생성"


# ---------------------------------------------------------------------------
# 노드 1 : Composer
# ---------------------------------------------------------------------------
class CharacterPrefabComposer:
    DESCRIPTION = ("캐릭터·의상·배경·임신 프리팹을 고르고 감정을 여러 개 선택하면 "
                   "감정 × 임신 상태마다 프롬프트를 리스트로 출력합니다.")

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "appearance": ([NONE] + names("appearance"), {"tooltip": "캐릭터(외형) 프리팹"}),
                "emotions": _line("", EMOTIONS_TIP),
                "run_mode": (RUN_MODES, {"tooltip": RUN_MODE_TIP}),
                "outfit": ([NONE] + names("outfit"), {"tooltip": "의상 프리팹"}),
                "background": ([NONE] + names("background"), {"tooltip": "배경 프리팹"}),
                "pregnancy": ([NONE] + names("pregnancy"), {"tooltip": "임신 프리팹 (임신 전/후 프롬프트·코드)"}),
                "pregnancy_state": (list(STATE_CHOICES.keys()), {"tooltip": "둘 다 = 임신 전/후 각각 생성"}),
                "width": _size_widget(DEFAULT_SIZE[0], "가로"),
                "height": _size_widget(DEFAULT_SIZE[1], "세로"),
                "quality": _line("masterpiece, best quality", "맨 앞 품질 태그"),
                "expression_pose": _line("", "추가 표정/포즈 태그 (감정 뒤에 붙음)"),
                "extra": _line("", "맨 뒤 추가 태그"),
                "negative": _line("lowres, bad anatomy, bad hands", "공통 네거티브"),
            }
        }

    RETURN_TYPES = OUT_TYPES
    RETURN_NAMES = OUT_NAMES
    OUTPUT_IS_LIST = OUT_LIST
    OUTPUT_TOOLTIPS = OUT_TIPS
    FUNCTION = "compose"
    CATEGORY = CATEGORY

    @classmethod
    def IS_CHANGED(cls, **kw):
        return _mtimes()

    def compose(self, appearance, emotions, outfit, background, pregnancy, pregnancy_state,
                quality, expression_pose, extra, negative, run_mode=None, width=1024, height=1024):
        base = norm_base({
            "appearance": prefab_or_empty("appearance", appearance),
            "outfit": prefab_or_empty("outfit", outfit),
            "background": prefab_or_empty("background", background),
            "pregnancy": pregnancy_or_empty(pregnancy),
            "emotions": resolve_emotions(emotions, load_collection("emotion")),
            "pregnancy_state": STATE_CHOICES.get(pregnancy_state, "before"),
            "quality": quality, "expression_pose": expression_pose, "extra": extra, "negative": negative,
        })
        return outputs(base, (_size(width, 1024), _size(height, 1024)))


# ---------------------------------------------------------------------------
# 노드 2 : Save
# ---------------------------------------------------------------------------
def _first(v, default=""):
    if isinstance(v, list):
        return v[0] if v else default
    return default if v is None else v


class CharacterSave:
    DESCRIPTION = ("캐릭터 프롬프트 정보를 이름을 붙여 저장합니다 (캐릭터·의상·배경·태그). "
                   "감정 선택과 임신 설정은 저장하지 않고 Character Load에서 고릅니다. "
                   "일반 텍스트를 연결하면 텍스트 그대로 저장됩니다.")

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "text": ("STRING", {"forceInput": True, "tooltip": "character(JSON) 또는 일반 프롬프트 텍스트"}),
                "name": _line("my_character", "저장할 캐릭터 이름"),
                "overwrite": ("BOOLEAN", {"default": True, "tooltip": "같은 이름이 있으면 덮어쓰기"}),
            },
            "optional": {
                "negative": ("STRING", {"forceInput": True, "tooltip": "(선택) 네거티브 텍스트"}),
            },
        }

    INPUT_IS_LIST = True  # 리스트로 들어와도 한 번만 저장
    RETURN_TYPES = OUT_TYPES
    RETURN_NAMES = OUT_NAMES
    OUTPUT_IS_LIST = OUT_LIST
    OUTPUT_TOOLTIPS = OUT_TIPS
    FUNCTION = "save"
    CATEGORY = CATEGORY
    OUTPUT_NODE = True

    def save(self, text, name, overwrite, negative=None):
        base, _ = parse_character_text(_first(text), _first(negative))
        name, overwrite = str(_first(name)).strip(), bool(_first(overwrite, True))
        if not name or name in (NONE, KEEP):
            msg = "저장 실패: 이름이 비어 있거나 사용할 수 없는 이름입니다."
        else:
            with _lock:
                items = load_collection("character")
                if name in items and not overwrite:
                    msg = f"'{name}' 이(가) 이미 있어 저장하지 않았습니다 (overwrite 끔)."
                else:
                    items[name] = strip_selection(base)
                    write_collection("character", items)
                    msg = f"캐릭터 '{name}' 저장 완료"
        print(f"[CharacterPrefab] {msg}")
        return {"ui": {"text": [msg]}, "result": outputs(base)}


# ---------------------------------------------------------------------------
# 노드 3 : Load
# ---------------------------------------------------------------------------
class CharacterLoad:
    DESCRIPTION = "저장된 캐릭터(캐릭터·의상·배경·태그)를 불러오고, 감정과 임신은 이 노드에서 고릅니다."

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "character": ([NONE] + names("character"),),
                "emotions": _line("", EMOTIONS_TIP),
                "run_mode": (RUN_MODES, {"tooltip": RUN_MODE_TIP}),
                "outfit_override": ([KEEP] + names("outfit"), {"tooltip": "(keep) = 저장된 의상"}),
                "background_override": ([KEEP] + names("background"), {"tooltip": "(keep) = 저장된 배경"}),
                "pregnancy": ([NONE] + names("pregnancy"), {"tooltip": "임신 프리팹 (임신 전/후 프롬프트·코드)"}),
                "pregnancy_state": (list(STATE_CHOICES.keys()), {"tooltip": "둘 다 = 임신 전/후 각각 생성"}),
                "width": _size_widget(DEFAULT_SIZE[0], "가로"),
                "height": _size_widget(DEFAULT_SIZE[1], "세로"),
                "expression_pose": _line("", "추가 표정/포즈. 비우면 저장된 값"),
            }
        }

    RETURN_TYPES = OUT_TYPES
    RETURN_NAMES = OUT_NAMES
    OUTPUT_IS_LIST = OUT_LIST
    OUTPUT_TOOLTIPS = OUT_TIPS
    FUNCTION = "load"
    CATEGORY = CATEGORY

    @classmethod
    def IS_CHANGED(cls, **kw):
        return _mtimes()

    def load(self, character, emotions, outfit_override, background_override, pregnancy, pregnancy_state,
             expression_pose, run_mode=None, width=1024, height=1024):
        items = load_collection("character")
        if character != NONE and character not in items:
            print(f"[CharacterPrefab] 캐릭터 '{character}' 이(가) 없습니다.")
        base = strip_selection(norm_base(items.get(character, {})))
        base["emotions"] = resolve_emotions(emotions, load_collection("emotion"))
        base["pregnancy"] = pregnancy_or_empty(pregnancy)
        base["pregnancy_state"] = STATE_CHOICES.get(pregnancy_state, "before")
        if outfit_override != KEEP:
            base["outfit"] = prefab_or_empty("outfit", outfit_override)
        if background_override != KEEP:
            base["background"] = prefab_or_empty("background", background_override)
        if expression_pose.strip():
            base["expression_pose"] = expression_pose
        return outputs(base, (_size(width, 1024), _size(height, 1024)))


# ---------------------------------------------------------------------------
# 노드 4 : Codes (코드 연결부)
# ---------------------------------------------------------------------------
class CharacterCodes:
    DESCRIPTION = ("character 출력에서 각 코드를 꺼냅니다. 리스트가 들어오면 항목마다 처리됩니다. "
                   "format 키: {character} {outfit} {emotion} {pregnancy} {emotion_name} {state} {background} {bg_type}")

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "character": ("STRING", {"forceInput": True, "tooltip": "Composer/Load/Save의 character 출력"}),
                "format": _line(DEFAULT_FORMAT, "code 출력 형식. 빈 코드는 구분자와 함께 자동 생략"),
            }
        }

    RETURN_TYPES = ("STRING",) * 7
    RETURN_NAMES = ("code", "character_code", "outfit_code", "emotion_code", "pregnancy_code",
                    "emotion_name", "pregnancy_state")
    FUNCTION = "codes"
    CATEGORY = CATEGORY

    @classmethod
    def IS_CHANGED(cls, **kw):
        return _mtimes()

    def codes(self, character, format):
        base, item = parse_character_text(character)
        if not item.get("codes"):
            item = json.loads(expand(base)[0]["json"])["item"]
        c = {k: _str(v) for k, v in _dict(item.get("codes")).items()}
        state = item.get("pregnancy_state") or ""
        values = {**c, "emotion_name": item.get("emotion") or "", "state": PREG_LABEL.get(state, ""),
                  "background": item.get("background") or "",
                  "bg_type": BG_VARIANTS.get(item.get("background_variant") or "", "")}
        return (format_code(format, values), c.get("character", ""), c.get("outfit", ""), c.get("emotion", ""),
                c.get("pregnancy", ""), values["emotion_name"], values["state"])


# ---------------------------------------------------------------------------
# 노드 5 : Name Tools (순번 붙이기 / 숫자만 / 문자만)
# ---------------------------------------------------------------------------
KEEP_MODES = ["그대로", "숫자만 남기기", "문자만 남기기", "숫자 지우기", "문자 지우기"]
NUM_MODES = ["번호 없음", "뒤에 번호", "앞에 번호", "번호만"]
COUNTER_MODES = ["계속 이어서 (실행 누적)", "실행마다 처음부터"]
_SEPS = "_-. "
_COUNTERS = {}  # unique_id -> {"sig": (start, step), "next": int}


def filter_text(text, mode, keep_separators=True):
    seps = _SEPS if keep_separators else ""
    if mode == "숫자만 남기기":
        ok = lambda ch: ch.isdigit() or ch in seps
    elif mode == "문자만 남기기":
        ok = lambda ch: ch.isalpha() or ch in seps
    elif mode == "숫자 지우기":
        ok = lambda ch: not ch.isdigit()
    elif mode == "문자 지우기":
        ok = lambda ch: not ch.isalpha()
    else:
        return text
    out = "".join(ch for ch in text if ok(ch))
    out = re.sub(r"([_\-. ])[_\-. ]+", r"\1", out)  # 지운 뒤 남은 연속 구분자 정리
    return out.strip(_SEPS)


def number_text(text, n, mode, digits, sep):
    num = str(n).zfill(digits) if digits > 0 else str(n)
    if mode == "번호만" or (mode != "번호 없음" and not text):
        return num
    if mode == "뒤에 번호":
        return f"{text}{sep}{num}"
    if mode == "앞에 번호":
        return f"{num}{sep}{text}"
    return text


class CharacterNameTools:
    DESCRIPTION = ("이름/코드 텍스트 가공: 순차 번호 붙이기(1, 2, 3…), 숫자만 남기기, 문자만 남기기 등. "
                   "Save Image의 filename_prefix 앞에 두고 쓰면 편합니다.")

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "text": ("STRING", {"forceInput": True, "tooltip": "code, emotion_name 등 아무 텍스트"}),
                "keep": (KEEP_MODES, {"tooltip": "문자 = 한글/영문 글자, 숫자 = 0-9"}),
                "keep_separators": ("BOOLEAN", {"default": True, "tooltip": "_ - . 공백 같은 구분자는 남기기"}),
                "numbering": (NUM_MODES, {"default": "뒤에 번호"}),
                "start": ("INT", {"default": 1, "min": 0, "max": 999999}),
                "step": ("INT", {"default": 1, "min": 1, "max": 1000}),
                "digits": ("INT", {"default": 0, "min": 0, "max": 8, "tooltip": "자리수 (0 = 1,2,3 / 3 = 001,002)"}),
                "separator": _line("_", "이름과 번호 사이 구분자"),
                "counter": (COUNTER_MODES, {"tooltip": "계속 이어서: 실행할 때마다 번호가 이어짐 (start/step을 바꾸면 처음부터)"}),
            },
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    INPUT_IS_LIST = True
    RETURN_TYPES = ("STRING", "INT")
    RETURN_NAMES = ("text", "number")
    OUTPUT_IS_LIST = (True, True)
    FUNCTION = "run"
    CATEGORY = CATEGORY

    @classmethod
    def IS_CHANGED(cls, counter=None, **kw):
        c = _first(counter, "")
        return float("nan") if c == COUNTER_MODES[0] else ""

    def run(self, text, keep, keep_separators, numbering, start, step, digits, separator, counter, unique_id=None):
        keep, keep_sep, numbering = _first(keep), bool(_first(keep_separators, True)), _first(numbering)
        start, step, digits = int(_first(start, 1)), int(_first(step, 1)), int(_first(digits, 0))
        sep, counter = _str(_first(separator)), _first(counter)
        texts = text if isinstance(text, list) else [text]
        uid = str(_first(unique_id, "0"))
        if counter == COUNTER_MODES[0]:
            st = _COUNTERS.get(uid)
            if not st or st["sig"] != (start, step):
                st = _COUNTERS[uid] = {"sig": (start, step), "next": start}
            n = st["next"]
            st["next"] = n + step * len(texts)
        else:
            n = start
        out_t, out_n = [], []
        for i, t in enumerate(texts):
            num = n + i * step
            out_t.append(number_text(filter_text(_str(t), keep, keep_sep), num, numbering, digits, sep))
            out_n.append(num)
        return (out_t, out_n)


# ---------------------------------------------------------------------------
# REST API (프리팹 매니저 창)
# ---------------------------------------------------------------------------
def api_payload():
    return {
        "schema": {
            s: {"label": v["label"], "code_label": v["code_label"], "prefix": v["prefix"],
                "auto_code": v["auto_code"], "code_is_name": v["code_is_name"], "has_code": v["has_code"], "fields": [{"key": k, "label": l} for k, l in v["fields"]],
                "default_off": sorted(DEFAULT_OFF.get(s, ()))}
            for s, v in SCHEMA.items()
        },
        "pregnancy": {"keys": list(PREG_KEYS), "label": PREG_LABEL, "prefix": PREG_PREFIX},
        "state_choices": STATE_CHOICES,
        "collections": all_collections(),
        "none": NONE,
        "keep": KEEP,
        "default_format": DEFAULT_FORMAT,
        "run_modes": RUN_MODES,
        "bg_variants": BG_VARIANTS,
        "res_presets": RES_PRESETS,
        "default_path": DEFAULT_EXTRA_PATH,
        "char_outfit_slots": CHAR_OUTFIT_SLOTS,
    }


def norm_emotion_group(d):
    d = _dict(d)
    ems = d.get("emotions") if isinstance(d.get("emotions"), list) else []
    out = []
    for e in ems:
        e = str(e).strip()
        if e and e not in out:
            out.append(e)
    return {"emotions": out, "note": _str(d.get("note"))}


def _normalize_for(coll, data):
    if coll == "emotion_group":
        return norm_emotion_group(data)
    if coll == "character":
        return strip_selection(norm_base(data))
    if coll == "pregnancy":
        return norm_pregnancy(data)
    return norm_prefab(coll, data)


def api_save(body):
    coll = body.get("collection")
    if coll not in COLLECTIONS:
        raise ValueError(f"알 수 없는 종류: {coll}")
    name = str(body.get("name", "")).strip()
    if not name or name in (NONE, KEEP) or len(name) > 80:
        raise ValueError("이름이 비어 있거나 사용할 수 없는 이름입니다.")
    data = _normalize_for(coll, body.get("data"))
    old = body.get("old_name") or None
    with _lock:
        items = load_collection(coll)
        if coll in SECTIONS or coll == "pregnancy":
            used = used_codes(coll, items, exclude={name, old})
            if coll == "pregnancy":
                b, a = data["before"]["code"], data["after"]["code"]
                if b and b == a:
                    raise ValueError("임신 전 코드와 임신 후 코드는 달라야 합니다.")
                for k in PREG_KEYS:
                    c = data[k]["code"]
                    if not c:
                        c = data[k]["code"] = next_code(PREG_PREFIX[k], used)
                    elif c in used:
                        raise ValueError(f"{PREG_LABEL[k]} 코드 '{c}' 는 '{used[c]}' 에서 이미 사용 중입니다.")
                    used[c] = name
            elif not SCHEMA[coll]["has_code"]:
                data["code"] = ""
            elif SCHEMA[coll]["code_is_name"]:
                data["code"] = name  # 감정 코드 = 감정 이름 (이름을 바꾸면 코드도 바뀜)
            else:
                c = data["code"]
                if not c:
                    data["code"] = next_code(SCHEMA[coll]["prefix"], used)
                elif c in used:
                    raise ValueError(f"코드 '{c}' 는 '{used[c]}' 에서 이미 사용 중입니다.")
        items[name] = data
        if old and old != name:
            items.pop(old, None)
        write_collection(coll, items)
        if coll == "emotion" and old and old != name:
            _update_groups(lambda ems: [name if e == old else e for e in ems])  # 감정 이름 변경 → 묶음에도 반영


def api_delete(body):
    coll = body.get("collection")
    if coll not in COLLECTIONS:
        raise ValueError(f"알 수 없는 종류: {coll}")
    with _lock:
        items = load_collection(coll)
        gone = str(body.get("name", ""))
        items.pop(gone, None)
        write_collection(coll, items)
        if coll == "emotion":
            _update_groups(lambda ems: [e for e in ems if e != gone])  # 삭제된 감정은 묶음에서도 제거


def api_save_many(body):
    """여러 항목을 한 번에 저장: {collection, items: [{name, data, old_name}]}. 실패한 항목은 errors 로."""
    coll = body.get("collection")
    errors = []
    with _lock:
        for it in body.get("items") or []:
            it = _dict(it)
            try:
                api_save({"collection": coll, "name": it.get("name"), "data": it.get("data"), "old_name": it.get("old_name")})
            except Exception as e:
                errors.append(f"{it.get('name')}: {e}")
    return errors


def api_delete_many(body):
    with _lock:
        for n in body.get("names") or []:
            api_delete({"collection": body.get("collection"), "name": n})
    return []


def _update_groups(fn):
    groups = load_collection("emotion_group")
    changed = False
    for g in groups.values():
        if isinstance(g, dict) and isinstance(g.get("emotions"), list):
            new = fn(g["emotions"])
            if new != g["emotions"]:
                g["emotions"], changed = new, True
    if changed:
        write_collection("emotion_group", groups)


def _register_routes():
    try:
        from aiohttp import web
        from server import PromptServer
        routes = PromptServer.instance.routes
    except Exception:
        return

    @routes.get("/charprefab/data")
    async def _get(request):
        return web.json_response(api_payload())

    def _handler(fn):
        async def h(request):
            try:
                errors = fn(await request.json()) or []
                return web.json_response({"ok": True, "errors": errors, "collections": all_collections()})
            except Exception as e:
                return web.json_response({"error": str(e)}, status=400)
        return h

    routes.post("/charprefab/save")(_handler(api_save))
    routes.post("/charprefab/delete")(_handler(api_delete))
    routes.post("/charprefab/save_many")(_handler(api_save_many))
    routes.post("/charprefab/delete_many")(_handler(api_delete_many))


_register_routes()


NODE_CLASS_MAPPINGS = {
    "CharacterPrefabComposer": CharacterPrefabComposer,
    "CharacterSave": CharacterSave,
    "CharacterLoad": CharacterLoad,
    "CharacterCodes": CharacterCodes,
    "CharacterNameTools": CharacterNameTools,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "CharacterPrefabComposer": "Character Prefab Composer 🧍",
    "CharacterSave": "Character Save 💾",
    "CharacterLoad": "Character Load 📂",
    "CharacterCodes": "Character Codes 🏷",
    "CharacterNameTools": "Character Name Tools 🔢",
}
