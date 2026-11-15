"""Permission tests against a throwaway PeakCut server. Usage: test_permissions.py <base url> <project root> <python exe>"""
import os
import subprocess
import sys

import httpx

BASE, ROOT, PY = sys.argv[1], sys.argv[2], sys.argv[3]
ORIGIN = {"Origin": BASE}
fails = []


def check(name, got, want):
    ok = got == want if not callable(want) else want(got)
    print(("PASS " if ok else "FAIL ") + name + ("" if ok else f"   got {got!r}"))
    if not ok:
        fails.append(name)


def client():
    return httpx.Client(base_url=BASE, timeout=30, follow_redirects=False)


def signup(email, extra=None):
    c = client()
    r = c.post("/api/auth/signup", json={"email": email, "password": "test-pass-123", "name": "<img src=x onerror=alert(1)>", **(extra or {})}, headers=ORIGIN)
    assert r.status_code == 200, r.text
    return c, r.json()["user"]


def cli(*args):
    return subprocess.run([PY, "-m", "studio.admin", *args], cwd=ROOT, env=os.environ, capture_output=True, text=True)


anon = client()
a, ua = signup("alice@example.com", {"is_admin": True, "role": "admin"})
b, ub = signup("bob@example.com")

# ---- nobody is an admin by signing up, whatever they send
check("first account is a normal user", ua["role"], "user")
check("is_admin in signup body ignored", ua["is_admin"], False)
check("no AI key: the app still answers, and says so", a.get("/api/status").json()["ai"]["ready"], False)

# ---- the admin area does not exist for them
for who, c in (("anon", anon), ("user", a)):
    for path in ("/admin", "/admin/users", "/api/admin/overview", f"/api/admin/users/{ub['id']}"):
        check(f"{who} GET {path} -> 404", c.get(path).status_code, 404)
    check(f"{who} disable -> 404", c.post(f"/api/admin/users/{ub['id']}/disabled", json={"disabled": True}, headers=ORIGIN).status_code, 404)
check("anon /app -> login", anon.get("/app").status_code, 303)
check("anon /api/status -> 401", anon.get("/api/status").status_code, 401)

# ---- a user cannot give themselves a role
a.put("/api/settings", json={"is_admin": True, "role": "admin"}, headers=ORIGIN)
check("settings cannot change role", a.get("/api/auth/me").json()["user"]["role"], "user")
check("cross-site POST refused", a.post("/api/settings", json={}, headers={"Origin": "https://evil.example"}).status_code, 403)

# ---- one user's data is invisible to another
r = a.post("/api/creators", json={"name": "Alice Secret"}, headers=ORIGIN)
check("alice creates a creator", r.status_code, 200)
cid = r.json()["id"]
check("bob sees no creators", b.get("/api/creators").json(), [])
check("bob cannot edit alice's creator", b.put(f"/api/creators/{cid}", json={"name": "pwned"}, headers=ORIGIN).status_code, 404)
check("bob cannot record alice's creator", b.post(f"/api/creators/{cid}/live", json={}, headers=ORIGIN).status_code, lambda s: s in (403, 404))
check("bob cannot read alice's avatar", b.get(f"/api/creators/{cid}/avatar").status_code, 404)
check("alice's creator unchanged", a.get("/api/creators").json()[0]["name"], "Alice Secret")
check("bob sees no jobs", b.get("/api/jobs").json(), [])
check("bob job lookup with path tricks -> 404", b.get("/api/jobs/..%2F..%2Fx").status_code, 404)
check("bob media guess -> 404", b.get("/media/20260101-000000-abcdef1234/clip01.mp4").status_code, 404)
check("bob overview empty", b.get("/api/overview").json()["creators"], [])
check("bob notifications are his own", b.get("/api/notifications").json()["items"], [])
check("bob's AI usage is his own and empty", b.get("/api/usage").json()["calls_total"], 0)
check("new user gets the tour", b.get("/api/status").json()["tour"], True)
b.put("/api/settings", json={"tour_done": True}, headers=ORIGIN)
check("tour shows once", b.get("/api/status").json()["tour"], False)
check("alice still gets her tour", a.get("/api/status").json()["tour"], True)

# ---- make alice an admin by hand, on the server
check("grant unknown email fails", cli("grant", "nobody@example.com").returncode, 1)
check("grant alice", cli("grant", "alice@example.com").returncode, 0)
check("admin page loads", a.get("/admin").status_code, 200)
check("bob still 404", b.get("/admin").status_code, 404)
ov = a.get("/api/admin/overview")
check("admin overview", ov.status_code, 200)
o = ov.json()
check("overview counts users", o["totals"]["users"], 2)
check("overview lists both", sorted(u["email"] for u in o["users"]), ["alice@example.com", "bob@example.com"])
check("overview never includes password hashes", "password" in ov.text or "scrypt" in ov.text, False)

check("user detail", a.get(f"/api/admin/users/{ub['id']}").json()["email"], "bob@example.com")
check("user detail of an unknown account", a.get("/api/admin/users/u_0000000000000000").status_code, 404)

# ---- disabling
dis = f"/api/admin/users/{ub['id']}/disabled"
check("disable without Origin refused", a.post(dis, json={"disabled": True}).status_code, 403)
check("disable from another site refused", a.post(dis, json={"disabled": True}, headers={"Origin": "https://evil.example"}).status_code, 403)
check("disable needs a real boolean", a.post(dis, json={"disabled": "yes"}, headers=ORIGIN).status_code, 400)
check("admin cannot disable self", a.post(f"/api/admin/users/{ua['id']}/disabled", json={"disabled": True}, headers=ORIGIN).status_code, 400)
check("disable bob", a.post(dis, json={"disabled": True}, headers=ORIGIN).status_code, 200)
check("bob is signed out at once", b.get("/api/status").status_code, 401)
check("bob cannot sign back in", client().post("/api/auth/login", json={"email": "bob@example.com", "password": "test-pass-123"}, headers=ORIGIN).status_code, 400)
check("enable bob", a.post(dis, json={"disabled": False}, headers=ORIGIN).status_code, 200)
check("disabling is in the admin log", [l["action"] for l in a.get("/api/admin/overview").json()["log"]][:2], ["enable", "disable"])
check("bob can sign in again", client().post("/api/auth/login", json={"email": "bob@example.com", "password": "test-pass-123"}, headers=ORIGIN).status_code, 200)
check("a wrong password is refused", client().post("/api/auth/login", json={"email": "bob@example.com", "password": "not-the-password"}, headers=ORIGIN).status_code, 400)

# ---- taking the role away works on the very next request
check("revoke alice", cli("revoke", "alice@example.com").returncode, 0)
check("old admin session -> gone", a.get("/api/admin/overview").status_code, 404)
a2 = client()
a2.post("/api/auth/login", json={"email": "alice@example.com", "password": "test-pass-123"}, headers=ORIGIN)
check("alice signed in again is a user", a2.get("/admin").status_code, 404)

print("\n%d failed" % len(fails) if fails else "\nALL PASSED")
sys.exit(1 if fails else 0)
