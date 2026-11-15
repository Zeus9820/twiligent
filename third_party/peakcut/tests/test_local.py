"""With accounts off (the default): no sign-in, and the AI key is set from the dashboard. Runs against the code
directly, with its own empty data folder and the network replaced: nothing outside it is touched."""
import json
import os
import sys
import tempfile

os.environ["PEAKCUT_DATA"] = tempfile.mkdtemp(prefix="pc-local-")
os.environ.update(DATABASE_URL="", PEAKCUT_ACCOUNTS="0", PEAKCUT_AI_PROVIDER="gemini", PEAKCUT_AI_MODELS="", PEAKCUT_AI_KEY="",
                  PEAKCUT_AI_KEY_FILE="", PEAKCUT_AI_BASE_URL="", PEAKCUT_PUBLIC_URL="http://127.0.0.1:8765")
sys.path.insert(0, ".")
from fastapi.testclient import TestClient  # noqa: E402

from studio import ai, config, db, server  # noqa: E402

db.init()
fails = []
BASE = "http://127.0.0.1:8765"
ORIGIN = {"Origin": BASE}
c = TestClient(server.app, base_url=BASE, follow_redirects=False)


def check(name, got, want=True):
    ok = want(got) if callable(want) else got == want
    print(("PASS " if ok else "FAIL ") + name + ("" if ok else f"   got {got!r}"))
    ok or fails.append(name)


# ---- no sign-in anywhere
check("the dashboard opens with no sign-in", c.get("/app").status_code, 200)
check("the front page goes straight to the dashboard", (c.get("/").status_code, c.get("/").headers.get("location")), (303, "/app"))
check("the sign-in page goes to the dashboard", (c.get("/login").status_code, c.get("/signup").status_code, c.get("/reset").status_code), (303, 303, 303))
st = c.get("/api/status").json()
check("the page is told there are no accounts", st["accounts"], False)
check("there is one owner, who may do everything", (st["user"]["is_admin"], st["user"]["name"]), (True, "You"))
check("nobody can make an account", c.post("/api/auth/signup", json={"email": "x@example.com", "password": "test-pass-123"}, headers=ORIGIN).status_code, 404)
check("...or sign in", c.post("/api/auth/login", json={"email": "x@example.com", "password": "test-pass-123"}, headers=ORIGIN).status_code, 404)
check("the owner's things work", c.post("/api/creators", json={"name": "Someone"}, headers=ORIGIN).status_code, 200)
check("the owner cannot delete themself", c.post("/api/account/delete", json={"confirm": st["user"]["email"]}, headers=ORIGIN).status_code, 409)

# ---- with no sign-in, the address and the sender still have to be right
check("another website cannot change things", c.post("/api/creators", json={"name": "x"}, headers={"Origin": "https://evil.example"}).status_code, 403)
check("a made-up name pointing at this machine is refused", c.get("/api/status", headers={"Host": "evil.example:8765"}).status_code, 403)
for host in ("localhost:8765", "192.168.1.20:8765", "[::1]:8765", "127.0.0.1"):
    check(f"reached as {host}", c.get("/api/status", headers={"Host": host}).status_code, 200)

# ---- the AI key, from the dashboard
KEY = "test-key-abcdefgh12345678"
a = c.get("/api/ai").json()
check("no AI to begin with", (a["ready"], a["has_key"], st["ai"]["ready"]), (False, False, False))
check("the services are listed", [p["id"] for p in a["providers"]][:3], ["gemini", "openai", "xai"])
put = lambda body: c.put("/api/ai", json=body, headers=ORIGIN)  # noqa: E731
check("a service needs its key", put({"provider": "gemini", "models": "model-a"}).status_code, 400)
check("...and a model", put({"provider": "gemini", "models": "", "key": KEY}).status_code, 400)
check("an unknown service is refused", put({"provider": "nonsense", "models": "m", "key": KEY}).status_code, 400)
check("a custom service needs an address", put({"provider": "custom", "models": "m"}).status_code, 400)
check("an address must be a web address", put({"provider": "custom", "models": "m", "base_url": "file:///etc/passwd"}).status_code, 400)
check("a model id cannot carry anything odd", put({"provider": "gemini", "models": "m\"}; drop", "key": KEY}).status_code, 400)
check("saving from another website is refused", c.put("/api/ai", json={"provider": "gemini", "models": "m", "key": KEY}, headers={"Origin": "https://evil.example"}).status_code, 403)
r = put({"provider": "gemini", "models": "model-a, model-b", "key": KEY})
check("the key is saved", (r.status_code, r.json()["ready"], r.json()["models"], r.json()["key_hint"]), (200, True, ["model-a", "model-b"], "5678"))
check("the key itself is never sent back", KEY in r.text or KEY in c.get("/api/ai").text or KEY in c.get("/api/status").text, False)
check("every page now says the AI is ready", c.get("/api/status").json()["ai"], lambda x: x["ready"] and x["provider"] == "Gemini" and x["model"] == "model-a")
check("it is kept in the data folder", json.loads((config.DATA_DIR / "ai.json").read_text())["key"], KEY)
r = put({"provider": "gemini", "models": "model-c", "key": ""})
check("saving again without typing the key keeps it", (r.status_code, r.json()["has_key"], ai.key()), (200, True, KEY))
check("changing service without a key is refused, and the old key is not carried over", put({"provider": "openai", "models": "m"}).status_code, 400)
r = put({"provider": "ollama", "models": "llama"})
check("a model on this machine needs no key", (r.status_code, r.json()["ready"], ai.key()), (200, True, ""))


# ---- finding models and testing, with the network replaced
class Reply:
    def __init__(self, status, data):
        self.status_code, self._d, self.text = status, data, json.dumps(data)

    def json(self):
        return self._d


asked = []


def fake_get(url, params=None, headers=None, timeout=None):
    asked.append((url, headers or {}))
    if "generativelanguage" in url:
        if (headers or {}).get("x-goog-api-key") != KEY:
            return Reply(400, {"error": {"message": f"API key not valid: {(headers or {}).get('x-goog-api-key')}"}})
        return Reply(200, {"models": [{"name": "models/g-fast", "supportedGenerationMethods": ["generateContent"]},
                                      {"name": "models/g-embed", "supportedGenerationMethods": ["embedContent"]}]})
    return Reply(200, {"data": [{"id": "b-model"}, {"id": "a-model"}]})


def fake_post(url, json=None, headers=None, timeout=None):  # noqa: A002
    if (headers or {}).get("x-goog-api-key") != KEY:
        return Reply(403, {"error": {"message": "bad key " + str((headers or {}).get("x-goog-api-key"))}})
    return Reply(200, {"candidates": [{"content": {"parts": [{"text": '["ok"]'}]}}], "usageMetadata": {"promptTokenCount": 9, "totalTokenCount": 12}})


ai.httpx.get, ai.httpx.post = fake_get, fake_post
post = lambda path, body=None: c.post(path, json=body or {}, headers=ORIGIN)  # noqa: E731
r = post("/api/ai/models", {"provider": "gemini", "key": KEY})
check("models are listed with a key typed but not saved yet", (r.status_code, r.json().get("models")), (200, ["g-fast"]))
r = post("/api/ai/models", {"provider": "openai", "key": "sk-whatever-123456"})
check("other services list theirs, in order", r.json().get("models"), ["a-model", "b-model"])
r = post("/api/ai/models", {"provider": "gemini", "key": "wrong-key-000000000000"})
check("a refused key is explained without repeating it", (r.status_code, "wrong-key-000000000000" in r.text), (502, False))
put({"provider": "gemini", "models": "g-fast", "key": KEY})
r = post("/api/ai/test")
check("the test asks the saved model and reports back", (r.status_code, r.json().get("model"), r.json().get("ok")), (200, "g-fast", True))
put({"provider": "gemini", "models": "g-fast", "key": "wrong-key-000000000000"})
r = post("/api/ai/test")
check("a failed test says why, without the key", (r.status_code, "wrong-key-000000000000" in r.text), (502, False))

print("ALL PASSED" if not fails else f"{len(fails)} failed")
import shutil  # noqa: E402
db.engine.dispose()
shutil.rmtree(os.environ["PEAKCUT_DATA"], ignore_errors=True)
sys.exit(1 if fails else 0)
