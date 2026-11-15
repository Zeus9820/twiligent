"""Creator workspaces. Each user has their own: users/<user>/creators/<id>/{videos,live,creator.json,log.jsonl}."""
import copy
import json
import re
import threading
import time
from pathlib import Path

from . import config, ctx


def _root() -> Path:
    return config.user_dir(ctx.uid()) / "creators"

_lock = threading.RLock()

DEFAULTS = {"name": "", "channel": "", "style": "bounce", "layout": "blur", "min_len": 15, "max_len": 60,
            "max_clips": 6, "min_score": 80, "auto_watch": False, "buffer_min": 20, "live_per_hour": 4, "ai_every_min": 3, "ai_only_on_spike": True, "auto_jump_pct": 60,
            "plan": "free", "decide_mode": "both", "must_clip_min": 0, "min_gap_min": 2,
            "trigger_words": "clip that, clip it",
            "autopost": False, "accounts": [], "post_min_score": 75, "post_gap_min": 45, "daily_cap": 6,
            "privacy": "public", "post_footer": "", "rate_per_1k": 0.0, "channels": {}}
PLATFORMS = ("youtube", "twitch", "kick")


def platform_key(url: str) -> str:
    from urllib.parse import urlparse
    h = (urlparse(url if "://" in url else "https://" + url).hostname or "").lower()
    return "youtube" if "youtube" in h or h == "youtu.be" else "twitch" if "twitch" in h else "kick" if "kick" in h else ""


def _fix(c: dict) -> dict:
    """One channel per platform in `channels`; `channel` is the one to record from and is always one of them."""
    ch = {k: v for k, v in (c.get("channels") or {}).items() if k in PLATFORMS and v}
    if c.get("channel") and platform_key(c["channel"]) and c["channel"] not in ch.values():
        ch.setdefault(platform_key(c["channel"]), c["channel"])
    c["channels"] = ch
    if not c.get("ai_every_min"):
        c["ai_every_min"] = 3       # "Auto" (0) is gone: jumps in loudness and chat are now always checked
    if c.get("channel") not in ch.values():
        c["channel"] = next((ch[k] for k in PLATFORMS if k in ch), "")
    return c
NUMERIC = {"min_len": (5, 120), "max_len": (10, 180), "max_clips": (1, 20), "min_score": (0, 100), "buffer_min": (5, 120), "live_per_hour": (1, 60), "ai_every_min": (1, 30), "auto_jump_pct": (20, 300), "must_clip_min": (0, 240), "min_gap_min": (0, 60),
           "post_min_score": (0, 100), "post_gap_min": (5, 1440), "daily_cap": (1, 50)}


def root(cid) -> Path:
    if not re.fullmatch(r"[\w\-]{1,60}", cid or ""):
        raise ValueError("bad creator id")
    return _root() / cid


def _clean(data: dict) -> dict:
    out = {}
    for k in DEFAULTS:
        if k not in data or data[k] is None:
            continue
        v = data[k]
        if k in NUMERIC:
            lo, hi = NUMERIC[k]
            v = max(lo, min(hi, int(float(v))))
        elif k in ("auto_watch", "autopost", "ai_only_on_spike"):
            v = bool(v)
        elif k == "channels":
            v = {p: str(u).strip()[:300] for p, u in (v.items() if isinstance(v, dict) else []) if p in PLATFORMS and str(u).strip()}
        elif k == "accounts":
            v = [str(x) for x in v][:20] if isinstance(v, list) else []
        elif k == "rate_per_1k":
            v = max(0.0, min(1000.0, float(v or 0)))
        elif k == "plan":
            v = v if v in ("free", "pro", "max") else "free"
        elif k == "decide_mode":
            v = v if v in ("both", "either") else "both"
        elif k == "privacy":
            v = v if v in ("public", "unlisted", "private") else "public"
        else:
            v = str(v).strip()[:300]
        out[k] = v
    return out


_mem: dict = {}   # user -> {creator id: creator}. The files stay the truth; this saves re-reading them on every page check.


def _mine() -> dict:
    u = ctx.uid()
    got = _mem.get(u)
    if got is None:
        got = {}
        for f in sorted(_root().glob("*/creator.json")):
            try:
                c = _fix({**DEFAULTS, **json.loads(f.read_text(encoding="utf-8"))})
                got[c.get("id") or f.parent.name] = c
            except Exception:  # noqa: BLE001
                pass
        with _lock:
            got = _mem.setdefault(u, got)
    return got


def forget(uid: str):
    """Files were changed from outside this module (old data moved in): read them again next time."""
    _mem.pop(uid, None)
    ctx.bump(uid)


def all_creators() -> list:
    return [copy.deepcopy(c) for c in list(_mine().values())]


def get(cid):
    if not cid or not re.fullmatch(r"[\w\-]{1,60}", str(cid)):
        return None
    c = _mine().get(str(cid))
    return copy.deepcopy(c) if c else None


def _write(c):
    with _lock:
        d = root(c["id"])
        for sub in ("videos", "live"):
            (d / sub).mkdir(parents=True, exist_ok=True)
        tmp = d / "creator.json.tmp"
        tmp.write_text(json.dumps(c, indent=1), encoding="utf-8")
        tmp.replace(d / "creator.json")
        _mine()[c["id"]] = copy.deepcopy(c)
    ctx.bump()


def create(data: dict) -> dict:
    c = _fix({**DEFAULTS, **_clean(data)})
    if not c["name"]:
        raise ValueError("Give the creator a name.")
    slug = re.sub(r"[^a-z0-9]+", "-", c["name"].lower()).strip("-")[:40] or "creator"
    cid, n = slug, 2
    while root(cid).exists():
        cid, n = f"{slug}-{n}", n + 1
    c.update(id=cid, created=time.time())
    _write(c)
    log(cid, f"Workspace created for {c['name']}")
    return c


def update(cid, data: dict) -> dict:
    c = get(cid)
    if not c:
        raise KeyError(cid)
    new = _clean(data)
    if "channels" in new and "channel" not in new and c["channel"] not in new["channels"].values():
        c["channel"] = ""  # the recording channel was removed: fall back to another one
    if "channel" in new and new["channel"] and "channels" not in new:
        new["channels"] = {**c["channels"], platform_key(new["channel"]): new["channel"]}
    c.update(new)
    _fix(c)
    if c["min_len"] >= c["max_len"]:
        raise ValueError("Shortest clip must be shorter than longest clip.")
    _write(c)
    return c


def set_profiles(cid, profiles: dict, extra: dict = None):
    """Each channel's public profile and live state, written by profiles.refresh. `profile` is the recording
    channel's one, used for the creator's picture."""
    with _lock:
        c = get(cid)
        if not c:
            return
        before = json.dumps([c.get("profiles"), {k: c.get(k) for k in (extra or {})}], sort_keys=True, default=str)
        c["profiles"] = {k: v for k, v in profiles.items() if k in c["channels"]}
        main = platform_key(c["channel"]) if c["channel"] else ""
        c["profile"] = c["profiles"].get(main) or next(iter(c["profiles"].values()), {})
        c.update(extra or {})
        same = re.sub(r'"live_at": [\d.]+', "", before) == re.sub(
            r'"live_at": [\d.]+', "", json.dumps([c["profiles"], {k: c.get(k) for k in (extra or {})}], sort_keys=True, default=str))
        if same:       # only "checked just now" moved on: remember it, but there is nothing new to save or show
            _mine()[c["id"]] = copy.deepcopy(c)
            return
        _write(c)


def log(cid, msg: str):
    if not cid or ctx.uid_or_none() is None or not root(cid).exists():
        return
    with _lock, (root(cid) / "log.jsonl").open("a", encoding="utf-8") as f:
        f.write(json.dumps({"t": time.time(), "msg": msg}) + "\n")
    ctx.bump()


def read_log(cid, n=40) -> list:
    f = root(cid) / "log.jsonl"
    if not f.exists():
        return []
    lines = f.read_text(encoding="utf-8").splitlines()[-n:]
    return [json.loads(x) for x in reversed(lines) if x.strip()]
