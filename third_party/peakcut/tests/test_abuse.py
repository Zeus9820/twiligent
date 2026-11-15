"""Abuse and limit tests against a throwaway PeakCut server. Usage: test_abuse.py <base url> <project root>"""
import sys

import httpx

BASE = sys.argv[1]
ORIGIN = {"Origin": BASE}
fails = []


def check(name, got, want):
    ok = got == want if not callable(want) else want(got)
    print(("PASS " if ok else "FAIL ") + name + ("" if ok else f"   got {got!r}"))
    if not ok:
        fails.append(name)


c = httpx.Client(base_url=BASE, timeout=60)
anon = httpx.Client(base_url=BASE, timeout=60)
r = c.post("/api/auth/signup", json={"email": "zed@example.com", "password": "test-pass-123", "name": "Zed"}, headers=ORIGIN)
assert r.status_code == 200, r.text

# ---- big bodies are refused before anything reads them
big = b"x" * (300 * 1024)
check("300 KB login body refused (signed out)", anon.post("/api/auth/login", content=big, headers={**ORIGIN, "Content-Type": "application/json"}).status_code, 413)
check("300 KB body to an unknown address refused", anon.post("/api/auth/nothing-here", content=big).status_code, 413)


def chunks():
    for _ in range(40):
        yield b"y" * 16384


check("chunked 640 KB body with no length refused", anon.post("/api/auth/login", content=chunks(), headers={**ORIGIN, "Content-Type": "application/json"}).status_code, lambda s: s in (413, 400))
check("normal login still works", anon.post("/api/auth/login", json={"email": "zed@example.com", "password": "test-pass-123"}, headers=ORIGIN).status_code, 200)

# ---- the page's cheap check
s1 = c.get("/api/sync").json()
check("first sync sends everything", sorted(s1), ["accounts", "ai", "creators", "jobs", "unread", "v"])
s2 = c.get("/api/sync", params={"v": s1["v"]}).json()
check("second sync says nothing changed", s2, {"v": s1["v"]})
c.post("/api/creators", json={"name": "Sync Test"}, headers=ORIGIN)
s3 = c.get("/api/sync", params={"v": s1["v"]}).json()
check("sync notices a new creator", [x["name"] for x in s3.get("creators", [])], ["Sync Test"])
check("sync needs a session", anon.__class__(base_url=BASE).get("/api/sync").status_code, 401)

# ---- unverified account: no AI work, no uploads accepted
check("unverified cannot start a job", c.post("/api/jobs", json={"url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ"}, headers=ORIGIN).status_code, 403)
check("unverified upload refused before the file is read", c.post("/api/upload", files={"file": ("a.mp4", b"0" * 200000, "video/mp4")}, headers=ORIGIN).status_code, 403)

# ---- confirm the email the way the server would after the link is clicked, then try bad options
import os, subprocess  # noqa: E401,E402
uid = c.get("/api/auth/me").json()["user"]["id"]
subprocess.run([sys.executable, "-c", f"from studio import auth, db; db.init(); auth.mark_verified({uid!r})"],
               cwd=sys.argv[2], env=os.environ, check=True, capture_output=True)
check("verified now", c.get("/api/auth/me").json()["user"]["verified"], True)
for bad in ({"range_start": -5}, {"range_start": 50, "range_end": 10}, {"quality": "abc"}, {"range_end": "NaN"}):
    check(f"options {bad} refused", c.post("/api/jobs", json={"url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ", "options": bad}, headers=ORIGIN).status_code, 400)
check("non-video site refused", c.post("/api/jobs", json={"url": "http://169.254.169.254/latest/meta-data"}, headers=ORIGIN).status_code, 400)
check("look-alike host refused", c.post("/api/jobs", json={"url": "https://youtube.com.evil.example/watch?v=1"}, headers=ORIGIN).status_code, 400)
check("user@host trick refused", c.post("/api/jobs", json={"url": "https://youtube.com@127.0.0.1/x"}, headers=ORIGIN).status_code, 400)
check("no jobs were created by any of that", c.get("/api/jobs").json(), [])
check("upload of a non-video refused", c.post("/api/upload", files={"file": ("a.exe", b"MZ" + b"0" * 1000, "application/octet-stream")}, headers=ORIGIN).status_code, 400)

# ---- Google sign-in cannot be finished by a different browser
check("google callback without the browser's cookie", anon.get("/auth/google/callback", params={"code": "x", "state": "y"}, follow_redirects=False).headers.get("location"), "/login?error=google")

# ---- caching: a browser that already has the current copy gets "not modified", never a stale or shared private page
fresh = httpx.Client(base_url=BASE, timeout=60)      # a browser nobody has signed in on
for path, who in (("/", fresh), ("/login", fresh), ("/app", c), ("/brand/favicon.svg", anon), ("/assets/ascii.js", anon)):
    r1 = who.get(path)
    tag = r1.headers.get("etag", "")
    r2 = who.get(path, headers={"If-None-Match": tag})
    check(f"{path} is not re-sent when unchanged", (r1.status_code, bool(tag), r2.status_code, len(r2.content)), (200, True, 304, 0))
    check(f"{path} is sent again when the copy is old", who.get(path, headers={"If-None-Match": '"something-else"'}).status_code, 200)
check("the signed-in app page is never kept by a shared cache", "private" in c.get("/app").headers.get("cache-control", ""), True)
check("API answers are never cached", c.get("/api/status").headers.get("cache-control"), "no-store")
check("not-modified never bypasses sign-in", httpx.Client(base_url=BASE).get("/app", headers={"If-None-Match": c.get("/app").headers.get("etag", "")}, follow_redirects=False).status_code, 303)

# ---- the visitor address: a header anyone can send must not let them dodge rate limits
import subprocess  # noqa: E402
probe = """
import os
os.environ["PEAKCUT_CLIENT_IP_HEADER"] = "CF-Connecting-IP"; os.environ["PEAKCUT_TRUST_PROXY"] = "1"
from studio import server
from starlette.datastructures import Headers
class R:
    def __init__(s, peer, h): s.headers = Headers(h); s.client = type("C", (), {"host": peer})()
print(server._ip(R("203.0.113.9", {"cf-connecting-ip": "1.2.3.4"})),
      server._ip(R("10.0.0.2", {"x-forwarded-for": "172.67.1.1", "cf-connecting-ip": "1.2.3.4"})),
      server._ip(R("10.0.0.2", {"x-forwarded-for": "198.51.100.7", "cf-connecting-ip": "1.2.3.4"})))
"""
got = subprocess.run([sys.executable, "-c", probe], cwd=sys.argv[2], capture_output=True, text=True).stdout.split()
check("a forged visitor header is ignored, the CDN's is used", got, ["203.0.113.9", "1.2.3.4", "198.51.100.7"])
check("redirects are never cached", fresh.get("/app", follow_redirects=False).headers.get("cache-control"), "private, no-store")
check("a missing file is never cached", fresh.get("/brand/nope.png").headers.get("cache-control"), "private, no-store")

# ---- throttles
codes = [c.put("/api/creators/sync-test", json={"min_score": 50}, headers=ORIGIN).status_code for _ in range(65)]
check("creator edits are throttled", (codes[0], codes[-1]), (200, 429))
bad_login = [anon.post("/api/auth/login", json={"email": "zed@example.com", "password": "wrong"}, headers=ORIGIN).status_code for _ in range(10)]
check("password guessing is throttled", bad_login[-1], 400)
check("...and says so", "Too many" in anon.post("/api/auth/login", json={"email": "zed@example.com", "password": "wrong"}, headers=ORIGIN).text, True)

print("\n%d failed" % len(fails) if fails else "\nALL PASSED")
sys.exit(1 if fails else 0)
