"""Bug reports, feature ideas and other messages from users, read by admins in the admin dashboard."""
import time

import sqlalchemy as sa

from . import db, notices

KINDS = {"bug": "Bug report", "idea": "Feature idea", "other": "Message"}
STATUSES = ("new", "seen", "done")


class Refused(ValueError):
    pass


def submit(uid: str, kind: str, message: str, page: str = "", context: str = "") -> dict:
    kind = kind if kind in KINDS else "other"
    message = (message or "").strip()
    if len(message) < 3:
        raise Refused("Write a few words so we know what you mean.")
    if len(message) > 4000:
        raise Refused("That's a bit long. Keep it under 4,000 characters.")
    now = time.time()
    with db.engine.begin() as c:
        fid = c.execute(db.feedback.insert().values(user_id=uid, t=now, kind=kind, message=message,
                                                    page=(page or "")[:200], context=(context or "")[:1000],
                                                    status="new", updated_at=now)).inserted_primary_key[0]
        who = c.execute(sa.select(db.users.c.email).where(db.users.c.id == uid)).scalar() or "someone"
        admins = [r[0] for r in c.execute(sa.select(db.users.c.id).where(db.users.c.is_admin == sa.true(),
                                                                         db.users.c.disabled == sa.false()))]
        for a in admins:
            notices.add(a, "feedback", f"New {KINDS[kind].lower()} from {who}", message[:140], "/admin/feedback", conn=c)
    return {"id": fid}


def listing(status: str = "") -> dict:
    f, u = db.feedback.c, db.users.c
    q = (sa.select(db.feedback, u.email, u.name).select_from(db.feedback.outerjoin(db.users, u.id == f.user_id))
         .order_by(f.t.desc()).limit(300))
    if status in STATUSES:
        q = q.where(f.status == status)
    with db.engine.connect() as c:
        rows = c.execute(q).all()
        counts = dict(c.execute(sa.select(f.status, sa.func.count()).group_by(f.status)).all())
    return {"items": [{"id": r.id, "t": r._mapping["t"], "kind": r.kind, "message": r.message, "page": r.page,
                       "context": r.context, "status": r.status, "email": r.email or "", "name": r.name or ""} for r in rows],
            "counts": {s: int(counts.get(s, 0)) for s in STATUSES}}


def set_status(fid: int, status: str):
    if status not in STATUSES:
        raise Refused("Unknown status.")
    with db.engine.begin() as c:
        done = c.execute(db.feedback.update().where(db.feedback.c.id == fid).values(status=status, updated_at=time.time()))
        if done.rowcount != 1:
            raise Refused("That message no longer exists.")
