"""The "new version" notice: the version here is read from .git, GitHub is asked what is newer (a stand-in here,
so nothing leaves this machine), and only the owner is told."""
import json, os, sys, tempfile
from pathlib import Path
os.environ["PEAKCUT_DATA"] = tempfile.mkdtemp(prefix="pc-upd-")
os.environ.update(DATABASE_URL="", PEAKCUT_ACCOUNTS="0", PEAKCUT_PUBLIC_URL="http://127.0.0.1:8765", PEAKCUT_AI_KEY="", PEAKCUT_AI_MODELS="")
sys.path.insert(0, ".")
from fastapi.testclient import TestClient
from studio import config, db, server, updates
db.init()
fails = []
def check(n, got, want=True):
    ok = want(got) if callable(want) else got == want
    print(("PASS " if ok else "FAIL ") + n + ("" if ok else f"   got {got!r}")); ok or fails.append(n)

# ---- which version is running: straight from .git, in each of the ways git keeps it
real_root = config.ROOT
fake = Path(tempfile.mkdtemp(prefix="pc-git-"))
config.ROOT = fake
check("no .git (a downloaded zip): the version is unknown", updates.current(), "")
(fake / ".git" / "refs" / "heads").mkdir(parents=True)
(fake / ".git" / "HEAD").write_text("ref: refs/heads/main\n")
(fake / ".git" / "refs" / "heads" / "main").write_text("a" * 40 + "\n")
check("the branch's commit is read", updates.current(), "a" * 40)
(fake / ".git" / "refs" / "heads" / "main").unlink()
(fake / ".git" / "packed-refs").write_text("# pack-refs with: peeled\n" + "b" * 40 + " refs/heads/main\n")
check("...also when git has packed it away", updates.current(), "b" * 40)
(fake / ".git" / "HEAD").write_text("c" * 40 + "\n")
check("...and on a single commit", updates.current(), "c" * 40)
config.ROOT = real_root
check("this folder's own version is found", len(updates.current()), 40)

# ---- asking GitHub
class R:
    def __init__(self, code, data):
        self.status_code, self._d = code, data
    def json(self):
        return self._d
asked = []
answer = {"now": None}
def fake_get(url, timeout=None, headers=None, params=None):
    asked.append((url, headers or {}))
    return answer["now"]
updates.httpx.get = fake_get
here = updates.current()
answer["now"] = R(200, {"ahead_by": 2, "commits": [
    {"sha": "1111111aaaa", "commit": {"message": "Connect TikTok in one click\n\nlong text", "committer": {"date": "2026-11-15T10:00:00Z"}}},
    {"sha": "2222222bbbb", "commit": {"message": "Captions always in English", "committer": {"date": "2026-11-16T10:00:00Z"}}}]})
got = updates.check(force=True)
check("two newer commits are found", (got["behind"], got["latest"], got["current"]), (2, "2222222", here[:7]))
check("newest change first, one line each, with its date", [(n["title"], n["date"]) for n in got["notes"]],
      [("Captions always in English", "2026-11-16"), ("Connect TikTok in one click", "2026-11-15")])
check("GitHub is asked for exactly this commit against the branch", asked[-1][0], f"https://api.github.com/repos/{updates.REPO}/compare/{here}...main")
check("nothing about this server is sent", set(asked[-1][1]) <= {"Accept", "User-Agent"} and "PeakCut" in asked[-1][1]["User-Agent"])
asked.clear()
check("the answer is kept: GitHub is not asked again for hours", (updates.check(), len(asked)), (got, 0))
answer["now"] = R(200, {"ahead_by": 0, "commits": []})
check("up to date: no notice", updates.check(force=True), None)
answer["now"] = R(404, {"message": "Not Found"})
check("a private or unknown repository: no notice, no error", updates.check(force=True), None)
def boom(*a, **k):
    raise OSError("offline")
updates.httpx.get = boom
check("offline: no notice, no error", updates.check(force=True), None)

# ---- only the owner is told
updates.httpx.get = fake_get
answer["now"] = R(200, {"ahead_by": 1, "commits": [{"sha": "3333333", "commit": {"message": "Fix", "committer": {"date": "2026-11-17"}}}]})
updates.check(force=True)
c = TestClient(server.app, base_url="http://127.0.0.1:8765")
st = c.get("/api/status").json()
check("the owner's dashboard gets the notice", (st["update"] or {}).get("behind"), 1)
updates.ON = False
updates._state.update(checked=0, result=None)
check("PEAKCUT_UPDATE_CHECK=0: never asks, never tells", (updates.check(force=True), c.get("/api/status").json()["update"]), (None, None))

print("ALL PASSED" if not fails else f"{len(fails)} failed")
import shutil; db.engine.dispose(); shutil.rmtree(os.environ["PEAKCUT_DATA"], ignore_errors=True); shutil.rmtree(fake, ignore_errors=True)
sys.exit(1 if fails else 0)
