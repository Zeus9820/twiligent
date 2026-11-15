"""All settings come from environment variables (or a .env file next to the project), so the same code runs
on a laptop and on a server. Nothing here is specific to one machine."""
import json
import os
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def _load_dotenv():
    f = ROOT / ".env"
    if not f.exists():
        return
    for line in f.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


_load_dotenv()
env = os.environ.get


_kept: dict = {}


def _keep(key, make, seconds=60):
    """Settings read from files (keys, the Google client) are looked at once a minute, not on every request."""
    import time
    got = _kept.get(key)
    if not got or time.time() - got[0] > seconds:
        got = _kept[key] = (time.time(), make())
    return got[1]


def _secret(var: str, file_var: str, pattern: str = r"\S{16,}") -> str:
    """A secret given directly (VAR) or as a path to a file holding it (VAR_FILE)."""
    return _keep(("secret", var, file_var), lambda: _read_secret(var, file_var, pattern))


def _read_secret(var: str, file_var: str, pattern: str) -> str:
    if env(var):
        return env(var).strip()
    path = env(file_var)
    if path and Path(path).exists():
        text = Path(path).read_text(encoding="utf-8", errors="ignore")
        m = re.search(pattern, text)
        return m.group(0) if m else text.strip().strip('"')
    return ""


# ---------------------------------------------------------------- where things live
DATA_DIR = Path(env("PEAKCUT_DATA") or ROOT / "data")
USERS_DIR = DATA_DIR / "users"          # users/<user id>/{creators,jobs,accounts}
MODELS_DIR = Path(env("PEAKCUT_MODELS") or DATA_DIR / "models")
TMP_DIR = DATA_DIR / "tmp"
FONTS_DIR = DATA_DIR / "fonts"          # caption fonts, copied from studio/fonts so every server renders the same
# YouTube already has a word-by-word transcript of most videos. With this on, that is what the AI reads to find the
# clips (seconds instead of transcribing hours), and our own model is run only on the clips themselves.
YT_TRANSCRIPT = env("PEAKCUT_YT_TRANSCRIPT", "1") != "0"
# the compact model for processors; a machine with a graphics card sets PEAKCUT_ASR_MODEL to the full-precision one
ASR_MODEL_NAME = env("PEAKCUT_ASR_MODEL", "sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8")
ASR_MODEL_DIR = MODELS_DIR / ASR_MODEL_NAME
DATABASE_URL = env("DATABASE_URL") or f"sqlite:///{(DATA_DIR / 'peakcut.db').as_posix()}"

for d in (USERS_DIR, MODELS_DIR, TMP_DIR, FONTS_DIR):
    d.mkdir(parents=True, exist_ok=True)


def user_dir(uid: str) -> Path:
    if not re.fullmatch(r"[A-Za-z0-9_]{6,40}", uid or ""):
        raise ValueError("bad user id")
    return USERS_DIR / uid


# ---------------------------------------------------------------- the site
HOST = env("PEAKCUT_HOST", "127.0.0.1")
PORT = int(env("PEAKCUT_PORT") or "8765")
PUBLIC_URL = (env("PEAKCUT_PUBLIC_URL") or f"http://127.0.0.1:{PORT}").rstrip("/")   # e.g. https://peakcut.com
HTTPS = PUBLIC_URL.startswith("https://")
SESSION_DAYS = int(env("PEAKCUT_SESSION_DAYS", "30"))
# Accounts are off by default: PeakCut opens straight into the dashboard, with no sign-in, which is what you want
# on your own computer. On a server that other people can reach, set PEAKCUT_ACCOUNTS=1: everyone then signs up
# and signs in, and each person only sees their own videos.
ACCOUNTS = env("PEAKCUT_ACCOUNTS", "0") == "1"
# The two buttons along the top of the dashboard: the project's code, and where to follow its maker (feedback goes
# there too). Set either to an empty value to hide that button, or point them at your own pages in a fork.
REPO_URL = env("PEAKCUT_REPO_URL", "https://github.com/haziqahmedqasmi/peakcut").strip()
FOLLOW_URL = env("PEAKCUT_FOLLOW_URL", "https://www.instagram.com/haziq.builds/").strip()

# ---------------------------------------------------------------- limits (per user, and for the whole server)
# Your own PeakCut has no limits unless you set them: 0 (the default) means "none" for every limit below. The
# machine still protects itself: new work waits while the processor, memory or disk are nearly full (load.py).
_NONE = 10 ** 7                      # what "no limit" becomes: far beyond anything real, and still a plain number


def _limit(name: str, default: str = "0"):
    v = float(env(name) or default)
    return _NONE if v <= 0 else v


MAX_UPLOAD_MB = int(_limit("PEAKCUT_MAX_UPLOAD_MB"))              # the largest video file someone may upload
# A big file is sent in pieces of this size and joined here, because web servers and CDNs in front of the app
# refuse very large single requests (Cloudflare stops at 100 MB).
UPLOAD_PART_MB = max(5, int(env("PEAKCUT_UPLOAD_PART_MB", "40")))
# The most videos that may ever run at once. How many actually run is decided by how busy the machine is (load.py).
JOB_WORKERS = int(env("PEAKCUT_JOB_WORKERS") or max(2, os.cpu_count() or 4))
MAX_ACTIVE_JOBS_PER_USER = int(_limit("PEAKCUT_MAX_JOBS_PER_USER", "5"))    # videos sent and worked on at once
MAX_LIVE_TOTAL = int(env("PEAKCUT_MAX_LIVE") or max(4, 2 * (os.cpu_count() or 4)))   # ceiling; real load decides below it
MAX_LIVE_PER_USER = int(_limit("PEAKCUT_MAX_LIVE_PER_USER"))     # streams one person records at once
MAX_VIDEO_HOURS = _limit("PEAKCUT_MAX_VIDEO_HOURS")              # longest video (or chosen part of one) that is processed
MAX_LIVE_HOURS = _limit("PEAKCUT_MAX_LIVE_HOURS")                # a recording stops by itself after this long
MAX_USER_GB = _limit("PEAKCUT_MAX_USER_GB")                      # disk space one account may fill
MAX_CREATORS = int(_limit("PEAKCUT_MAX_CREATORS"))               # creators one account may add
ALLOWED_SITES = tuple(s.strip().lower() for s in env(
    "PEAKCUT_ALLOWED_SITES", "youtube.com,youtu.be,twitch.tv,kick.com").split(",") if s.strip())

# ---------------------------------------------------------------- AI (bring your own key: see studio/ai.py)
# These are the starting values. Whatever is saved from the dashboard (Settings, AI) is used instead.
AI_PROVIDER = env("PEAKCUT_AI_PROVIDER", "gemini").strip().lower()            # gemini, openai, xai, groq, openrouter, anthropic, ollama, custom
AI_MODELS = [m.strip() for m in env("PEAKCUT_AI_MODELS", "").split(",") if m.strip()]   # tried in this order
AI_BASE_URL = env("PEAKCUT_AI_BASE_URL", "").rstrip("/")                      # only for "custom", or to override a provider's address


def ai_key() -> str:
    return _secret("PEAKCUT_AI_KEY", "PEAKCUT_AI_KEY_FILE", r"\S{8,}")


def ai_ready() -> bool:
    from . import ai
    return ai.ready()


# ---------------------------------------------------------------- account emails (see mailer.py)
SMTP_HOST = env("PEAKCUT_SMTP_HOST", "")
SMTP_PORT = int(env("PEAKCUT_SMTP_PORT", "587"))
SMTP_USER = env("PEAKCUT_SMTP_USER", "")
MAIL_FROM = env("PEAKCUT_MAIL_FROM", "")
CONTACT_EMAIL = env("PEAKCUT_CONTACT_EMAIL", "")
LEGAL_NAME = env("PEAKCUT_LEGAL_NAME", "")            # the business that runs PeakCut, for the legal pages
LEGAL_COUNTRY = env("PEAKCUT_LEGAL_COUNTRY", "")      # whose law applies, for the terms
# Set to 1 on a public site with email set up: password sign-ups must then confirm their address before clipping.
VERIFY_EMAIL = env("PEAKCUT_VERIFY_EMAIL", "0") == "1"


def smtp_password() -> str:
    return _secret("PEAKCUT_SMTP_PASSWORD", "PEAKCUT_SMTP_PASSWORD_FILE", r"\S{4,}")


# ---------------------------------------------------------------- Google (sign in with Google, and connecting YouTube)
def google_client() -> tuple:
    """(client id, client secret). Either GOOGLE_CLIENT_ID/SECRET, or GOOGLE_CLIENT_FILE = the JSON Google lets you download."""
    return _keep("google", _read_google_client)


def _read_google_client() -> tuple:
    if env("GOOGLE_CLIENT_ID") and env("GOOGLE_CLIENT_SECRET"):
        return env("GOOGLE_CLIENT_ID").strip(), env("GOOGLE_CLIENT_SECRET").strip()
    path = env("GOOGLE_CLIENT_FILE")
    if path and Path(path).exists():
        try:
            data = json.loads(Path(path).read_text(encoding="utf-8"))
            web = data.get("web") or data.get("installed") or {}
            return web.get("client_id", ""), web.get("client_secret", "")
        except ValueError:
            pass
    return "", ""


# ---------------------------------------------------------------- video
MAX_SOURCE_HEIGHT = 1080
OUT_W, OUT_H, OUT_FPS = 1080, 1920, 30
