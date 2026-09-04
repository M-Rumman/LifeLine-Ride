# -*- coding: utf-8 -*-
"""Temporary demo-prep harness (same status as _reset_demo_state.py).

Rehearsals and verification runs leave BHU-confirmed closures behind, which
inflate RESP-01's accountability scorecard (Module 5 awards metrics only for
confirmed_by == "bhu_staff"). The live demo script expects the judge's own
closure to be the FIRST verified one (incidents_responded_to: 1), so every
incident that is not part of the seeded history is deleted here.

Usage:
    cd "d:\\LifeLine Ride"
    python _restore_demo_baseline.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

_PROJECT_ROOT = Path(__file__).resolve().parent
_BACKEND_DIR = _PROJECT_ROOT / "backend"
for _p in [str(_BACKEND_DIR), str(_PROJECT_ROOT)]:
    if _p not in sys.path:
        sys.path.insert(0, _p)

from database import SessionLocal  # noqa: E402
from models.incident_model import IncidentRecord  # noqa: E402

_HISTORY = _PROJECT_ROOT / "mockdata" / "incidents" / "incident_history.json"


def main() -> None:
    seed_ids = set()
    if _HISTORY.exists():
        payload = json.loads(_HISTORY.read_text(encoding="utf-8"))
        # migrate_seed_data.py feeds each record's nested "incident" dict to
        # upsert_incident_to_db, so the id lives one level down.
        for rec in payload.get("records", []):
            sid = rec.get("incident", {}).get("incident_id") or rec.get("incident_id")
            if sid:
                seed_ids.add(sid)
    print(f"seed history ids: {len(seed_ids)}")

    db = SessionLocal()
    try:
        rows = db.query(IncidentRecord.incident_id).all()
        all_ids = [r.incident_id for r in rows]
        demo_ids = [i for i in all_ids if i not in seed_ids]
        print(f"incidents in DB: {len(all_ids)} -> deleting {len(demo_ids)}: {demo_ids}")
        if demo_ids:
            db.query(IncidentRecord).filter(
                IncidentRecord.incident_id.in_(demo_ids)
            ).delete(synchronize_session=False)
            db.commit()
        remaining = db.query(IncidentRecord.incident_id).count()
        print(f"remaining incidents: {remaining}")
    finally:
        db.close()


if __name__ == "__main__":
    main()
