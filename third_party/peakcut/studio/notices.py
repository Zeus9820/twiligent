"""In-app notifications: the bell in the sidebar.

Things worth knowing about without watching the screen: recordings starting, finishing or failing, clips
ready, posts that failed."""
import time

import sqlalchemy as sa

from . import ctx, db

KEEP = 100   # newest notifications kept per person
_unread: dict = {}   # user -> (when counted, count)


def add(uid, kind: str, title: str, body: str = "", link: str = "", ref: str = None, conn=None):
    """Record a notification. With `ref`, the same notification is only ever recorded once."""
    if not uid:
        return

    def run(c):
        n = db.notices.c
        if ref and c.execute(sa.select(n.id).where(n.user_id == uid, n.ref == ref)).first():
            return
        c.execute(db.notices.insert().values(user_id=uid, t=time.time(), kind=kind[:20], title=title[:160],
                                             body=(body or "")[:400], link=(link or "")[:200], ref=(ref or None)))
        old = [r[0] for r in c.execute(sa.select(n.id).where(n.user_id == uid).order_by(n.t.desc()).offset(KEEP))]
        if old:
            c.execute(db.notices.delete().where(n.id.in_(old)))
    try:
        if conn is not None:
            return run(conn)
        with db.engine.begin() as c:
            run(c)
    finally:
        _unread.pop(uid, None)
        ctx.bump(uid)


def mine(limit: int = 40) -> dict:
    uid = ctx.uid()
    n = db.notices.c
    with db.engine.connect() as c:
        rows = c.execute(sa.select(db.notices).where(n.user_id == uid).order_by(n.t.desc()).limit(limit)).all()
        unread = c.execute(sa.select(sa.func.count()).select_from(db.notices).where(n.user_id == uid, n.read_at.is_(None))).scalar()
    return {"unread": int(unread or 0), "items": [{"id": r.id, "t": r._mapping["t"], "kind": r.kind, "title": r.title,
                                                   "body": r.body, "link": r.link, "read": bool(r.read_at)} for r in rows]}


def unread() -> int:
    uid = ctx.uid()
    got = _unread.get(uid)
    if got and time.time() - got[0] < 20:
        return got[1]
    n = db.notices.c
    with db.engine.connect() as c:
        count = int(c.execute(sa.select(sa.func.count()).select_from(db.notices).where(
            n.user_id == uid, n.read_at.is_(None))).scalar() or 0)
    _unread[uid] = (time.time(), count)
    return count


def read_all():
    n = db.notices.c
    with db.engine.begin() as c:
        c.execute(db.notices.update().where(n.user_id == ctx.uid(), n.read_at.is_(None)).values(read_at=time.time()))
    _unread[ctx.uid()] = (time.time(), 0)
