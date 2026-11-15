"""Accounts and sign-in: email + password, Sign in with Google, and session cookies."""
import collections
import hashlib
import hmac
import re
import secrets
import threading
import time
from urllib.parse import urlencode

import httpx
import sqlalchemy as sa

from . import config, db

COOKIE = "peakcut_session"
EMAIL_RE = re.compile(r"^[^@\s]{1,64}@[^@\s]{1,180}\.[A-Za-z]{2,24}$")
_SCRYPT = {"n": 2 ** 15, "r": 8, "p": 1}
_states: dict = {}            # one-time values for the Google redirect: state -> (created, next path)
_attempts = collections.defaultdict(collections.deque)
_lock = threading.Lock()


class AuthError(ValueError):
    pass


# ---------------------------------------------------------------- passwords
def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    h = hashlib.scrypt(password.encode(), salt=salt, dklen=32, maxmem=64 * 1024 * 1024, **_SCRYPT)
    return f"scrypt${_SCRYPT['n']}${_SCRYPT['r']}${_SCRYPT['p']}${salt.hex()}${h.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        _, n, r, p, salt, h = stored.split("$")
        got = hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt), dklen=32, maxmem=64 * 1024 * 1024,
                             n=int(n), r=int(r), p=int(p))
        return hmac.compare_digest(got.hex(), h)
    except Exception:  # noqa: BLE001
        return False


_DUMMY = hash_password(secrets.token_hex(8))  # checked when the email is unknown, so timing does not reveal which emails exist


def _check_password_rules(password: str):
    if len(password) < 8:
        raise AuthError("Use a password of at least 8 characters.")
    if len(password) > 200:
        raise AuthError("That password is too long.")


# ---------------------------------------------------------------- rate limiting (per address and per email)
def throttle(key: str, limit: int, window: int):
    """Raise if `key` has been used more than `limit` times in the last `window` seconds."""
    now, key = time.time(), key[:200]
    with _lock:
        if len(_attempts) > 20000:     # never let the store of attempts grow without limit
            for k in [k for k, v in _attempts.items() if not v or v[-1] < now - 3600]:
                del _attempts[k]
        q = _attempts[key]
        while q and q[0] < now - window:
            q.popleft()
        if len(q) >= limit:
            raise AuthError("Too many attempts. Wait a few minutes and try again.")
        q.append(now)


# ---------------------------------------------------------------- users
def public(u) -> dict:
    return {"id": u.id, "email": u.email, "name": u.name or u.email.split("@")[0], "is_admin": bool(u.is_admin),
            "role": "admin" if u.is_admin else "user",
            "has_password": bool(u.password_hash), "google": bool(u.google_sub), "created_at": u.created_at,
            "verified": is_verified(u.id), "photo": _photo_stamp(u.id)}


def _photo_stamp(uid: str) -> int:
    p = photo(uid)
    if not p:
        return 0
    if len(_photos[uid]) < 3:
        _photos[uid] = (*_photos[uid], int(p[0].stat().st_mtime))
    return _photos[uid][2]


# ---------------------------------------------------------------- email ownership and one-time links
_verified: set = set()      # confirmed emails never become unconfirmed, so a yes can be remembered for good
_photos: dict = {}


def is_verified(uid: str) -> bool:
    if not config.VERIFY_EMAIL or uid in _verified:
        return True
    with db.engine.connect() as c:
        ok = bool(c.execute(sa.select(db.email_ok.c.user_id).where(db.email_ok.c.user_id == uid)).first())
    if ok:
        _verified.add(uid)
    return ok


def mark_verified(uid: str):
    with db.engine.begin() as c:
        if not c.execute(sa.select(db.email_ok.c.user_id).where(db.email_ok.c.user_id == uid)).first():
            c.execute(db.email_ok.insert().values(user_id=uid, verified_at=time.time()))


def _make_link(uid: str, purpose: str, ttl: int) -> str:
    token = secrets.token_urlsafe(32)
    with db.engine.begin() as c:
        # one live link per purpose: a new email makes the older link stop working
        c.execute(db.email_tokens.delete().where(db.email_tokens.c.user_id == uid, db.email_tokens.c.purpose == purpose))
        c.execute(db.email_tokens.delete().where(db.email_tokens.c.expires_at < time.time() - 86400))
        c.execute(db.email_tokens.insert().values(token_hash=_h(token), user_id=uid, purpose=purpose,
                                                  expires_at=time.time() + ttl))
    return token


def _use_link(token: str, purpose: str) -> str:
    """The account a link belongs to. Each link works once and only until it expires."""
    if not token or len(token) > 200:
        raise AuthError("That link isn't valid.")
    with db.engine.begin() as c:
        row = c.execute(sa.select(db.email_tokens).where(db.email_tokens.c.token_hash == _h(token),
                                                          db.email_tokens.c.purpose == purpose)).first()
        if not row or row.used_at:
            raise AuthError("That link has already been used or isn't valid. Ask for a new one.")
        if row.expires_at < time.time():
            raise AuthError("That link has expired. Ask for a new one.")
        c.execute(db.email_tokens.update().where(db.email_tokens.c.token_hash == row.token_hash).values(used_at=time.time()))
    return row.user_id


def send_verify(u) -> bool:
    from . import mailer
    link = f"{config.PUBLIC_URL}/auth/verify?t={_make_link(u.id, 'verify', 3 * 86400)}"
    return mailer.send(u.email, "Confirm your email for PeakCut", "Confirm your email",
                       "Thanks for joining PeakCut. Confirm this is your email address to start clipping.",
                       "Confirm my email", link, "The link works for 3 days. If you didn't sign up, you can ignore this email.")


def verify_link(token: str) -> str:
    uid = _use_link(token, "verify")
    mark_verified(uid)
    return uid


def forgot(email: str):
    """Email a reset link if the account exists. Says nothing either way, so this can't be used to find accounts."""
    from . import mailer
    with db.engine.connect() as c:
        u = c.execute(sa.select(db.users).where(db.users.c.email == email.strip().lower())).first()
    if not u or u.disabled:
        return
    link = f"{config.PUBLIC_URL}/reset?t={_make_link(u.id, 'reset', 3600)}"
    mailer.send(u.email, "Reset your PeakCut password", "Reset your password",
                "Someone asked to reset the password for this PeakCut account. If that was you, choose a new one below.",
                "Choose a new password", link, "The link works for one hour. If you didn't ask for this, ignore this email and your password stays the same.")


def reset_password(token: str, new: str):
    _check_password_rules(new)
    uid = _use_link(token, "reset")
    with db.engine.begin() as c:
        c.execute(db.users.update().where(db.users.c.id == uid).values(password_hash=hash_password(new)))
        c.execute(db.sessions.delete().where(db.sessions.c.user_id == uid))   # sign out everywhere
    forget(uid)
    mark_verified(uid)          # they proved they can read that inbox
    return get_user(uid)


def get_user(uid: str):
    with db.engine.connect() as c:
        return c.execute(sa.select(db.users).where(db.users.c.id == uid)).first()


def user_ids() -> list:
    with db.engine.connect() as c:
        return [r[0] for r in c.execute(sa.select(db.users.c.id).where(db.users.c.disabled == sa.false()))]


def _create(email: str, name: str, password_hash=None, google_sub=None):
    email = email.strip().lower()
    if not EMAIL_RE.match(email):
        raise AuthError("Enter a valid email address.")
    uid = "u_" + secrets.token_hex(8)
    with db.engine.begin() as c:
        if c.execute(sa.select(db.users.c.id).where(db.users.c.email == email)).first():
            raise AuthError("There is already an account with that email. Sign in instead.")
        first = c.execute(sa.select(sa.func.count()).select_from(db.users)).scalar() == 0
        # Every new account is a normal user. Admins are made by hand on the server: python -m studio.admin grant <email>
        c.execute(db.users.insert().values(id=uid, email=email, name=name.strip()[:120], password_hash=password_hash,
                                           google_sub=google_sub, is_admin=False, created_at=time.time()))
    config.user_dir(uid).mkdir(parents=True, exist_ok=True)
    if google_sub:
        mark_verified(uid)      # Google has already confirmed this address
    return get_user(uid), first


def signup(email: str, password: str, name: str = ""):
    """A new account with an email and password. Only a salted scrypt hash of the password is kept."""
    _check_password_rules(password)
    return _create(email, name, password_hash=hash_password(password))


def login(email: str, password: str):
    email = email.strip().lower()
    with db.engine.connect() as c:
        u = c.execute(sa.select(db.users).where(db.users.c.email == email)).first()
    if u and not u.password_hash and u.google_sub and not u.disabled:
        raise AuthError("This account uses Google. Choose Continue with Google, or use Forgot password to add a password.")
    if not u or not u.password_hash:
        verify_password(password, _DUMMY)            # same timing whether or not the email exists
        raise AuthError("That email and password don't match.")
    if not verify_password(password, u.password_hash):
        raise AuthError("That email and password don't match.")
    if u.disabled:
        raise AuthError("This account has been disabled.")
    return get_user(u.id)


def change_password(uid: str, current: str, new: str, keep_token: str = ""):
    u = get_user(uid)
    _check_password_rules(new)
    if u.password_hash:
        try:
            login(u.email, current)
        except AuthError:
            raise AuthError("Your current password is not right.")
    with db.engine.begin() as c:
        c.execute(db.users.update().where(db.users.c.id == uid).values(password_hash=hash_password(new)))
        # sign out everywhere else, so a stolen session dies with the old password
        c.execute(db.sessions.delete().where(db.sessions.c.user_id == uid, db.sessions.c.token_hash != _h(keep_token)))
    forget(uid)


# ---------------------------------------------------------------- no sign-in: one built-in owner
LOCAL_ID = "u_local"
_local = None


def local_user():
    """With accounts switched off there is nothing to sign in to: everything belongs to one owner, who may do
    everything. If accounts were used here before, the oldest one becomes the owner, so nothing they made is lost."""
    global _local
    if _local is None:
        with db.engine.begin() as c:
            u = c.execute(sa.select(db.users).order_by(db.users.c.created_at).limit(1)).first()
            if not u:
                c.execute(db.users.insert().values(id=LOCAL_ID, email="you@localhost", name="You", is_admin=True, created_at=time.time()))
            elif not u.is_admin or u.disabled:
                c.execute(db.users.update().where(db.users.c.id == u.id).values(is_admin=True, disabled=False))
            uid = u.id if u else LOCAL_ID
        config.user_dir(uid).mkdir(parents=True, exist_ok=True)
        mark_verified(uid)
        _local = get_user(uid)
    return _local


# ---------------------------------------------------------------- sessions
def _h(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def start_session(uid: str, ip: str = "", agent: str = "") -> str:
    token = secrets.token_urlsafe(32)
    with db.engine.begin() as c:
        c.execute(db.sessions.insert().values(token_hash=_h(token), user_id=uid, created_at=time.time(),
                                              expires_at=time.time() + config.SESSION_DAYS * 86400,
                                              ip=ip[:64], agent=agent[:300]))
        c.execute(db.sessions.delete().where(db.sessions.c.expires_at < time.time()))
    return token


_sess: dict = {}        # session -> (looked up at, user): saves a database round trip on almost every request
SESS_FOR = 20           # seconds; anything about permissions (the admin area) always asks the database instead


def user_for(token: str, fresh: bool = False):
    """The signed-in user for a session cookie, or None."""
    if not token or len(token) > 200:
        return None
    h, now = _h(token), time.time()
    got = None if fresh else _sess.get(h)
    if got and now - got[0] < SESS_FOR:
        return got[1]
    with db.engine.connect() as c:
        row = c.execute(sa.select(db.users).join(db.sessions, db.sessions.c.user_id == db.users.c.id).where(
            db.sessions.c.token_hash == h, db.sessions.c.expires_at > now,
            db.users.c.disabled == sa.false())).first()
    if row:
        if len(_sess) > 50000:
            for k in [k for k, v in list(_sess.items()) if now - v[0] > SESS_FOR]:
                _sess.pop(k, None)
        _sess[h] = (now, row)
    else:
        _sess.pop(h, None)
    return row


def forget(uid: str):
    """This account's sessions changed (signed out, disabled, new password): stop trusting what is remembered."""
    for k in [k for k, v in list(_sess.items()) if v[1].id == uid]:
        _sess.pop(k, None)


def seen_recently(uid: str) -> bool:
    return time.time() - _seen.get(uid, 0) < 300


_seen: dict = {}


def touch(uid: str):
    """Remember when this account was last active, at most once every five minutes."""
    now = time.time()
    if now - _seen.get(uid, 0) < 300:
        return
    _seen[uid] = now
    try:
        with db.engine.begin() as c:
            c.execute(db.users.update().where(db.users.c.id == uid).values(last_seen=now))
    except Exception:  # noqa: BLE001 - never fail a request over this
        pass


def end_session(token: str):
    _sess.pop(_h(token), None)
    with db.engine.begin() as c:
        c.execute(db.sessions.delete().where(db.sessions.c.token_hash == _h(token)))


def cookie_args(token: str) -> dict:
    return {"key": COOKIE, "value": token, "max_age": config.SESSION_DAYS * 86400, "httponly": True,
            "samesite": "lax", "secure": config.HTTPS, "path": "/"}


# ---------------------------------------------------------------- Sign in with Google
def google_ready() -> bool:
    return all(config.google_client())


def google_url(next_path: str = "/app") -> tuple:
    """(address to send the browser to, the one-time state to remember in that browser's cookie)."""
    cid, _ = config.google_client()
    state = secrets.token_urlsafe(24)
    with _lock:
        for k in [k for k, v in _states.items() if v[0] < time.time() - 900]:
            _states.pop(k, None)
        if len(_states) > 5000:               # someone hammering the start link: drop the oldest half
            for k in sorted(_states, key=lambda k: _states[k][0])[:2500]:
                _states.pop(k, None)
        next_path = next_path[:200]
        _states[state] = (time.time(), next_path if re.fullmatch(r"/(?![/\\])[^\\\t\r\n]*", next_path) else "/app")
    return "https://accounts.google.com/o/oauth2/v2/auth?" + urlencode({
        "client_id": cid, "redirect_uri": config.PUBLIC_URL + "/auth/google/callback", "response_type": "code",
        "scope": "openid email profile", "state": state, "prompt": "select_account"}), state


def google_finish(code: str, state: str):
    """Returns (user, is_first_user, next path)."""
    with _lock:
        st = _states.pop(state, None)
    if not st:
        raise AuthError("That sign-in link has expired. Try again.")
    cid, secret = config.google_client()
    tok = httpx.post("https://oauth2.googleapis.com/token", timeout=30, data={
        "code": code, "client_id": cid, "client_secret": secret, "grant_type": "authorization_code",
        "redirect_uri": config.PUBLIC_URL + "/auth/google/callback"})
    if tok.status_code != 200:
        raise AuthError("Google sign-in failed. Try again.")
    info = httpx.get("https://openidconnect.googleapis.com/v1/userinfo", timeout=30,
                     headers={"Authorization": f"Bearer {tok.json()['access_token']}"}).json()
    if not info.get("email") or not info.get("email_verified") or not info.get("sub"):
        raise AuthError("Google did not confirm that email address.")
    email = info["email"].lower()
    pic = info.get("picture") or ""
    with db.engine.begin() as c:
        u = c.execute(sa.select(db.users).where(sa.or_(db.users.c.google_sub == info["sub"], db.users.c.email == email))).first()
        if u and not u.google_sub:
            # First Google sign-in for an email that already has a password account. That password was set without
            # proving ownership of the email, so drop it (and any open sessions): only the Google owner keeps access.
            c.execute(db.users.update().where(db.users.c.id == u.id).values(google_sub=info["sub"], password_hash=None))
            c.execute(db.sessions.delete().where(db.sessions.c.user_id == u.id))
    if u:
        forget(u.id)
        if u.disabled:
            raise AuthError("This account has been disabled.")
        mark_verified(u.id)
        save_photo(u.id, pic)
        return get_user(u.id), False, st[1]
    u, first = _create(email, info.get("name") or "", google_sub=info["sub"])
    save_photo(u.id, pic)
    return u, first, st[1]


PHOTO_TYPES = {b"\xff\xd8\xff": "image/jpeg", b"\x89PNG": "image/png", b"RIFF": "image/webp"}


def save_photo(uid: str, url: str):
    """Keep a copy of the Google profile photo, so the app can show it from its own address. Best effort."""
    from urllib.parse import urlparse
    try:
        host = urlparse(url).hostname or ""
        if not url.startswith("https://") or not (host == "googleusercontent.com" or host.endswith(".googleusercontent.com")):
            return
        url = url.split("=s")[0] + "=s128-c" if "=s" in url else url + "=s128-c"   # a small square version
        r = httpx.get(url, timeout=10, follow_redirects=True)
        data = r.content[:400_001]
        if r.status_code != 200 or len(data) > 400_000 or not any(data.startswith(m) for m in PHOTO_TYPES):
            return
        (config.user_dir(uid) / "photo.img").write_bytes(data)
        _photos.pop(uid, None)
    except Exception:  # noqa: BLE001
        pass


def photo(uid: str):
    """(path, media type) of the saved profile photo, or None. Looked at on disk at most every two minutes."""
    got = _photos.get(uid)
    if got and time.time() - got[0] < 120:
        return got[1]
    f = config.user_dir(uid) / "photo.img"
    out = None
    if f.is_file():
        with f.open("rb") as fh:
            head = fh.read(4)
        kind = next((t for m, t in PHOTO_TYPES.items() if head.startswith(m)), None)
        out = (f, kind) if kind else None
    _photos[uid] = (time.time(), out)
    return out
