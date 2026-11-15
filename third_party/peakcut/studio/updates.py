"""Is there a newer PeakCut? Compares the version running here with the latest on GitHub.

The version here is the git commit this folder is on (read straight from .git, no git program needed). Every few
hours PeakCut asks GitHub's public API what has been added since; nothing about this server or its users is sent,
only the two commit ids. The owner then sees a notice in the dashboard with what changed and how to update.

    PEAKCUT_UPDATE_REPO     where to look (default: the project's own repository; a fork points at itself)
    PEAKCUT_UPDATE_BRANCH   which branch (default: main)
    PEAKCUT_UPDATE_CHECK=0  never look"""
import re
import threading
import time

import httpx

from . import config

REPO = (config.env("PEAKCUT_UPDATE_REPO") or "haziqahmedqasmi/peakcut").strip().strip("/")
BRANCH = (config.env("PEAKCUT_UPDATE_BRANCH") or "main").strip()
ON = config.env("PEAKCUT_UPDATE_CHECK", "1") != "0" and bool(re.fullmatch(r"[\w.\-]+/[\w.\-]+", REPO))
EVERY = 6 * 3600
_state = {"checked": 0.0, "result": None}
_lock = threading.Lock()


def current() -> str:
    """The commit this copy is on, or "" when it was not installed with git (a downloaded zip, for example)."""
    g = config.ROOT / ".git"
    try:
        if g.is_file():                      # a worktree or submodule: .git points somewhere else
            g = (config.ROOT / g.read_text(encoding="utf-8").split(":", 1)[1].strip()).resolve()
        head = (g / "HEAD").read_text(encoding="utf-8").strip()
        if not head.startswith("ref:"):
            return head if re.fullmatch(r"[0-9a-f]{40}", head) else ""
        ref = head.split(":", 1)[1].strip()
        f = g / ref
        if f.is_file():
            return f.read_text(encoding="utf-8").strip()
        packed = g / "packed-refs"
        if packed.is_file():
            for line in packed.read_text(encoding="utf-8").splitlines():
                parts = line.split()
                if len(parts) == 2 and parts[1] == ref:
                    return parts[0]
    except (OSError, IndexError):
        pass
    return ""


def _ask_github(here: str):
    r = httpx.get(f"https://api.github.com/repos/{REPO}/compare/{here}...{BRANCH}", timeout=20,
                  headers={"Accept": "application/vnd.github+json", "User-Agent": "PeakCut-update-check"})
    if r.status_code != 200:
        return None                         # not public yet, a commit GitHub doesn't know, or too many checks
    d = r.json()
    behind = int(d.get("ahead_by") or 0)    # what the branch has that this copy does not
    notes = []
    for c in reversed(d.get("commits") or []):
        msg = str((c.get("commit") or {}).get("message") or "").strip().splitlines()
        notes.append({"sha": str(c.get("sha") or "")[:7], "title": (msg[0] if msg else "")[:140],
                      "date": str(((c.get("commit") or {}).get("committer") or {}).get("date") or "")[:10]})
    latest = (d.get("commits") or [{}])[-1].get("sha") if d.get("commits") else here
    return {"current": here[:7], "latest": str(latest or "")[:7], "behind": behind, "notes": notes[:20],
            "url": f"https://github.com/{REPO}/commits/{BRANCH}"}


def check(force: bool = False):
    """What is new, from the last look at GitHub (looked at again every few hours). None when up to date or unknown."""
    if not ON:
        return None
    now = time.time()
    if not force and now - _state["checked"] < EVERY:
        return _state["result"]
    with _lock:
        if not force and now - _state["checked"] < EVERY:
            return _state["result"]
        _state["checked"] = now
        here = current()
        try:
            got = _ask_github(here) if here else None
        except Exception:  # noqa: BLE001 - offline, GitHub down: try again later
            got = None
        _state["result"] = got if got and got["behind"] > 0 else None
    return _state["result"]


def latest():
    """For the pages: the last result, never waiting on GitHub (the look itself happens in the background)."""
    if ON and time.time() - _state["checked"] >= EVERY:
        threading.Thread(target=check, daemon=True).start()
    return _state["result"]
