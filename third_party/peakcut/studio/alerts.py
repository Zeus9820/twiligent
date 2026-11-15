"""Messages to your phone: Discord webhook and/or Telegram bot, whichever is set up in Settings."""
import threading
import time

import httpx

import os

from . import accounts, auth, ctx


def configured() -> bool:
    s = accounts.settings()
    return bool(s["discord_webhook"] or (s["telegram_token"] and s["telegram_chat"]))


def send(text: str) -> list:
    """Returns a list of problems (empty when every configured channel accepted the message)."""
    s = accounts.settings()
    problems = []
    if s["discord_webhook"]:
        try:
            r = httpx.post(s["discord_webhook"], json={"content": text[:1900], "allowed_mentions": {"parse": []}}, timeout=15)
            if r.status_code >= 400:
                problems.append(f"Discord said {r.status_code}")
        except Exception as e:  # noqa: BLE001
            problems.append(f"Discord: {str(e)[:80]}")
    if s["telegram_token"] and s["telegram_chat"]:
        try:
            r = httpx.post(f"https://api.telegram.org/bot{s['telegram_token']}/sendMessage",
                           json={"chat_id": s["telegram_chat"], "text": text[:3900]}, timeout=15)
            if r.status_code >= 400:
                problems.append(f"Telegram said {r.status_code}")
        except Exception:  # noqa: BLE001 - never echo the bot token back in an error
            problems.append("Telegram: could not connect")
    return problems


def notify(text: str, kind: str = "live", link: str = ""):
    """Fire and forget, so a slow network never holds up recording or posting. Also shows in the app's bell."""
    try:
        from . import notices
        uid = ctx.uid_or_none()
        if uid:
            notices.add(uid, kind, text[:1].upper() + text[1:160], "", link)
    except Exception:  # noqa: BLE001
        pass
    if configured():
        threading.Thread(target=ctx.bind(send), args=("PeakCut: " + text,), daemon=True).start()


def digest_loop(make_summary):
    while True:
        time.sleep(60)
        for uid in auth.user_ids():
            try:
                with ctx.as_user(uid):
                    s = accounts.settings()
                    today = time.strftime("%Y-%m-%d")
                    if configured() and time.localtime().tm_hour == s["digest_hour"] and s["last_digest"] != today:
                        accounts.save_settings({"last_digest": today})
                        send(make_summary())
            except Exception:  # noqa: BLE001
                pass


def keep_awake_loop(is_busy):
    """Stops Windows going to sleep while something is recording or waiting to post."""
    if os.name != "nt":
        return  # servers don't go to sleep
    import ctypes
    ES_CONTINUOUS, ES_SYSTEM_REQUIRED = 0x80000000, 0x00000001
    state = None
    while True:
        want = bool(is_busy())
        if want != state:
            ctypes.windll.kernel32.SetThreadExecutionState(ES_CONTINUOUS | (ES_SYSTEM_REQUIRED if want else 0))
            state = want
        time.sleep(30)
