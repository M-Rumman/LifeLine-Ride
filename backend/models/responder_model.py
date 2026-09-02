# -*- coding: utf-8 -*-
"""Module 5 — SQLAlchemy ORM models for the responders registry and the
points ledger, plus all database helper functions consumed by
services/accountability_service.py.

Design discipline (mirrors incident_model.py exactly):
    - Column naming follows the slice_runner.Responder contract so the
      Pydantic model can be round-tripped without field renaming.
    - created_at / updated_at are ISO strings (project-wide timestamp
      convention, same as the incidents table), not native DateTime columns.
    - All helpers use a short-lived SessionLocal() with explicit rollback on
      failure; no shared global session.
    - upsert_responder_to_db() uses PostgreSQL INSERT … ON CONFLICT DO UPDATE
      so seeding and status syncs are fully idempotent.
    - The point_transactions table is the award LEDGER: one row per awarded
      incident (incident_id UNIQUE) — this is what makes
      awardPointsForIncident idempotent and double-award impossible.
"""
from __future__ import annotations

import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Optional

from sqlalchemy import (
    Column,
    Integer,
    VARCHAR,
)

# ---------------------------------------------------------------------------
# Path bootstrap — allow import from either backend/ or project root.
# ---------------------------------------------------------------------------
_BACKEND_DIR = Path(__file__).resolve().parent.parent
if str(_BACKEND_DIR) not in [str(p) for p in sys.path]:
    sys.path.insert(0, str(_BACKEND_DIR))

from database import Base, SessionLocal, engine  # noqa: E402


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# ===========================================================================
# ORM MODELS
# ===========================================================================

class ResponderRecord(Base):
    """Persistent mirror of slice_runner.Responder extended with Module 5's
    accountability fields (points_total is ledger-maintained, reliability_tier
    is derived by the scoring engine)."""
    __tablename__ = "responders"

    responder_id                = Column(VARCHAR(64),  primary_key=True, nullable=False)
    name                        = Column(VARCHAR(128), nullable=True)
    village                     = Column(VARCHAR(64),  nullable=True, index=True)
    linked_bhu_id               = Column(VARCHAR(64),  nullable=True)
    current_availability_status = Column(VARCHAR(16),  nullable=True)
    points_total                = Column(Integer,      nullable=False, default=0)
    reliability_tier            = Column(VARCHAR(16),  nullable=False, default="bronze")
    created_at                  = Column(VARCHAR(64),  nullable=True)
    updated_at                  = Column(VARCHAR(64),  nullable=True)


class PointTransaction(Base):
    """Points award LEDGER — one row per awarded incident.

    incident_id is UNIQUE: a single incident can only ever be awarded once,
    which is what makes awardPointsForIncident idempotent and is the
    structural fraud guard against double-awarding.
    Penalties are NOT ledger rows — they are deterministically recomputed
    from dispatch_events at scoring time, so the ledger stays a pure record
    of BHU-verified awards.
    """
    __tablename__ = "point_transactions"

    id           = Column(Integer, primary_key=True, autoincrement=True)
    incident_id  = Column(VARCHAR(64), nullable=False, unique=True, index=True)
    responder_id = Column(VARCHAR(64), nullable=False, index=True)
    delta        = Column(Integer,     nullable=False)
    reason       = Column(VARCHAR(64), nullable=True)
    awarded_at   = Column(VARCHAR(64), nullable=True)


# Auto-create the tables on import (no-op if they already exist).
Base.metadata.create_all(bind=engine)


# ===========================================================================
# RESPONDER HELPERS
# ===========================================================================

def upsert_responder_to_db(responder_dict: dict) -> None:
    """Persist (INSERT or UPDATE) one FULL responder row. Idempotent.

    On conflict the mutable columns are overwritten; created_at from the
    first insert is preserved.

    SEEDING ONLY — do NOT use this for availability-status mutations. It is a
    full-row write: every column absent from responder_dict falls back to a
    default (reliability_tier -> "bronze", points_total -> 0) and the ON
    CONFLICT clause writes those defaults over the existing row. Used for a
    status change, it would clobber the status_flag Module 5 stores in the
    reliability_tier column. Status mutations go through
    update_responder_availability() instead, which touches only that column.
    """
    from sqlalchemy.dialects.postgresql import insert as pg_insert

    responder_id = responder_dict.get("responder_id")
    if not responder_id:
        raise ValueError("upsert_responder_to_db: responder_dict has no responder_id")

    now = _now_iso()
    kwargs = dict(
        responder_id=responder_id,
        name=responder_dict.get("name"),
        village=responder_dict.get("village"),
        linked_bhu_id=responder_dict.get("linked_bhu_id"),
        current_availability_status=responder_dict.get("current_availability_status"),
        points_total=int(responder_dict.get("points_total", 0)),
        reliability_tier=responder_dict.get("reliability_tier", "bronze"),
        created_at=responder_dict.get("created_at") or now,
        updated_at=now,
    )

    db = SessionLocal()
    try:
        stmt = (
            pg_insert(ResponderRecord)
            .values(**kwargs)
            .on_conflict_do_update(
                index_elements=["responder_id"],
                set_={k: v for k, v in kwargs.items()
                      if k not in ("responder_id", "created_at")},
            )
        )
        db.execute(stmt)
        db.commit()
    except Exception as exc:
        db.rollback()
        raise RuntimeError(
            f"upsert_responder_to_db: DB write failed for {responder_id}: {exc}"
        ) from exc
    finally:
        db.close()


def get_responder_from_db(responder_id: str) -> Optional[dict]:
    """Retrieve one responder row as a plain dict, or None if not found."""
    db = SessionLocal()
    try:
        row = db.query(ResponderRecord).filter(
            ResponderRecord.responder_id == responder_id
        ).first()
        if row is None:
            return None
        return {
            "responder_id": row.responder_id,
            "name": row.name,
            "village": row.village,
            "linked_bhu_id": row.linked_bhu_id,
            "current_availability_status": row.current_availability_status,
            "points_total": row.points_total,
            "reliability_tier": row.reliability_tier,
            "created_at": row.created_at,
            "updated_at": row.updated_at,
        }
    finally:
        db.close()


def list_responders_from_db(
    village: Optional[str] = None,
    order_by_points: bool = False,
) -> List[dict]:
    """List responder rows, optionally filtered by village.

    order_by_points is retained only for schema compatibility — points_total
    is a vestigial column (Module 5 records factual metrics, not scores) so
    ordering by it is meaningless and is off by default.
    """
    db = SessionLocal()
    try:
        q = db.query(ResponderRecord)
        if village is not None:
            q = q.filter(ResponderRecord.village == village)
        if order_by_points:
            q = q.order_by(ResponderRecord.points_total.desc())
        rows = q.all()
        return [{
            "responder_id": r.responder_id,
            "name": r.name,
            "village": r.village,
            "linked_bhu_id": r.linked_bhu_id,
            "current_availability_status": r.current_availability_status,
            "points_total": r.points_total,
            "reliability_tier": r.reliability_tier,
        } for r in rows]
    finally:
        db.close()


def update_responder_availability(responder_id: str, status: str) -> bool:
    """Narrow write-through of ONLY current_availability_status (+ updated_at).

    Part B persistence fix: this is the single sanctioned way to persist an
    availability mutation (dispatch -> busy, decline/release -> available).
    Unlike upsert_responder_to_db() it never touches the other columns, so a
    status change cannot clobber the status_flag Module 5 stores in the
    repurposed reliability_tier column.

    If the responder has no row yet (first-ever mutation before seeding), a
    minimal row is inserted from the matching slice_runner.SEED_RESPONDERS
    entry so the status still survives a restart.

    Single round-trip: one INSERT … ON CONFLICT DO UPDATE whose set_ clause is
    restricted to the status column. Callers sit on Module 3's dispatch path,
    where an extra SELECT would add latency between the availability mutation
    and the arming of the ack-timeout timer.

    Returns True on a successful write; raises RuntimeError on DB failure so
    callers can apply their own non-fatal warning discipline.
    """
    from sqlalchemy.dialects.postgresql import insert as pg_insert
    import slice_runner  # local import — avoids circular import

    seed = next(
        (r for r in slice_runner.SEED_RESPONDERS
         if r.responder_id == responder_id),
        None,
    )
    now = _now_iso()

    db = SessionLocal()
    try:
        stmt = (
            pg_insert(ResponderRecord)
            .values(
                responder_id=responder_id,
                name=seed.name if seed else None,
                village=seed.village if seed else None,
                linked_bhu_id=seed.linked_bhu_id if seed else None,
                current_availability_status=status,
                # Only used when this INSERT creates the row. reliability_tier
                # is seeded to a valid status_flag, never to "bronze".
                points_total=0,
                reliability_tier="active",
                created_at=now,
                updated_at=now,
            )
            .on_conflict_do_update(
                index_elements=["responder_id"],
                # The whole point of this helper: on an existing row ONLY the
                # status column (plus updated_at) is written. reliability_tier
                # — which stores Module 5's status_flag — is never touched.
                set_={
                    "current_availability_status": status,
                    "updated_at": now,
                },
            )
        )
        db.execute(stmt)
        db.commit()
        return True
    except Exception as exc:
        db.rollback()
        raise RuntimeError(
            f"update_responder_availability: DB write failed for "
            f"{responder_id} -> {status}: {exc}"
        ) from exc
    finally:
        db.close()


def update_responder_points(
    responder_id: str,
    points_total: int,
    reliability_tier: str,
) -> None:
    """Set a responder's points_total and reliability_tier (plus updated_at).
    Called by the scoring engine after every award/sync."""
    db = SessionLocal()
    try:
        row = db.query(ResponderRecord).filter(
            ResponderRecord.responder_id == responder_id
        ).first()
        if row is None:
            raise ValueError(
                f"update_responder_points: unknown responder {responder_id}"
            )
        row.points_total = int(points_total)
        row.reliability_tier = reliability_tier
        row.updated_at = _now_iso()
        db.commit()
    except Exception as exc:
        db.rollback()
        raise RuntimeError(
            f"update_responder_points: DB write failed for {responder_id}: {exc}"
        ) from exc
    finally:
        db.close()


def seed_responders_from_contract() -> int:
    """Upsert slice_runner.SEED_RESPONDERS into the responders table.

    Part B persistence fix: if a responder already exists in PostgreSQL their
    current_availability_status is preserved from the DB row — NOT reset to the
    hardcoded seed default. This means a responder who was "busy" before a
    process restart remains "busy" after seed_responders_from_contract() runs
    on startup. Only truly new responders (not yet in DB) get the seed default.

    The reliability_tier column is repurposed to store status_flag values
    ("active"/"needs_follow_up"/"under_review") by Module 5's accountability
    engine — see accountability_service.py module docstring. points_total is
    written as 0 (unused vestigial column, kept for schema compatibility).

    Uses a single bulk INSERT ... ON CONFLICT to avoid N×round-trip overhead.
    The ON CONFLICT clause only updates mutable non-status fields (name, village,
    linked_bhu_id, updated_at) — current_availability_status is NOT updated on
    conflict so existing DB status is preserved across restarts.

    Returns the number of responders seeded.
    """
    from sqlalchemy.dialects.postgresql import insert as pg_insert
    import slice_runner  # local import — avoids circular import at module load


    now = _now_iso()
    rows = [
        {
            "responder_id": r.responder_id,
            "name": r.name,
            "village": r.village,
            "linked_bhu_id": r.linked_bhu_id,
            # For new rows: seed default. Existing rows: preserved via ON CONFLICT
            # which deliberately excludes this column — see below.
            "current_availability_status": r.current_availability_status,
            "points_total": 0,
            # reliability_tier column repurposed as status_flag storage:
            "reliability_tier": "active",
            "created_at": now,
            "updated_at": now,
        }
        for r in slice_runner.SEED_RESPONDERS
    ]

    db = SessionLocal()
    try:
        stmt = (
            pg_insert(ResponderRecord)
            .values(rows)
            .on_conflict_do_update(
                index_elements=["responder_id"],
                # Preserve current_availability_status from DB on conflict —
                # this is the Part B restart-survival property. Only update
                # non-status mutable fields (name, village, linked_bhu_id).
                # current_availability_status is intentionally NOT in set_{}
                # so existing DB status survives this seed call.
                set_={
                    "name": pg_insert(ResponderRecord).excluded.name,
                    "village": pg_insert(ResponderRecord).excluded.village,
                    "linked_bhu_id": pg_insert(ResponderRecord).excluded.linked_bhu_id,
                    "updated_at": now,
                },
            )
        )
        db.execute(stmt)
        db.commit()
    except Exception as exc:
        db.rollback()
        raise RuntimeError(f"seed_responders_from_contract: bulk upsert failed: {exc}") from exc
    finally:
        db.close()

    return len(rows)




def load_responder_status_from_db(seed_responders) -> int:
    """Reload current_availability_status for each responder from PostgreSQL
    into the in-memory SEED_RESPONDERS list.

    Part B persistence fix: called at startup (after seeding) and after a
    simulated restart in tests. For each responder that exists in the DB,
    the in-memory object's current_availability_status is updated to match
    the persisted value — so a responder who was "busy" before a process
    restart is still "busy" after rehydration, not silently reset to
    "available" by the hardcoded SEED_RESPONDERS defaults.

    Uses a single bulk query for efficiency (O(1) round-trip, not O(N)).

    Args:
        seed_responders: the list of slice_runner.Responder objects to update
                         (typically slice_runner.SEED_RESPONDERS).
    Returns:
        Number of responders whose status was loaded from DB.
    """
    # Single bulk query — same O(1) discipline as seed_responders_from_contract.
    rows = list_responders_from_db(order_by_points=False)
    db_map = {r["responder_id"]: r["current_availability_status"] for r in rows if r.get("current_availability_status")}
    count = 0
    for r in seed_responders:
        status = db_map.get(r.responder_id)
        if status:
            r.current_availability_status = status
            count += 1
    return count



def truncate_responders_table() -> None:
    """Delete all rows from the responders table.
    ONLY for use in test teardown/setup — never called in production code."""
    db = SessionLocal()
    try:
        db.query(ResponderRecord).delete()
        db.commit()
    except Exception as exc:
        db.rollback()
        raise RuntimeError(f"truncate_responders_table failed: {exc}") from exc
    finally:
        db.close()


# ===========================================================================
# POINTS LEDGER HELPERS
# ===========================================================================

def insert_point_transaction(
    incident_id: str,
    responder_id: str,
    delta: int,
    reason: str,
) -> dict:
    """Insert one award into the ledger. Raises RuntimeError if the incident
    was already awarded (incident_id UNIQUE) — callers check
    has_award_for_incident first for a friendlier idempotency path."""
    db = SessionLocal()
    try:
        tx = PointTransaction(
            incident_id=incident_id,
            responder_id=responder_id,
            delta=int(delta),
            reason=reason,
            awarded_at=_now_iso(),
        )
        db.add(tx)
        db.commit()
        return {
            "incident_id": incident_id,
            "responder_id": responder_id,
            "delta": int(delta),
            "reason": reason,
            "awarded_at": tx.awarded_at,
        }
    except Exception as exc:
        db.rollback()
        raise RuntimeError(
            f"insert_point_transaction: ledger write failed for "
            f"{incident_id}: {exc}"
        ) from exc
    finally:
        db.close()


def has_award_for_incident(incident_id: str) -> bool:
    """True if this incident already has a ledger row (award idempotency)."""
    db = SessionLocal()
    try:
        return db.query(PointTransaction).filter(
            PointTransaction.incident_id == incident_id
        ).first() is not None
    finally:
        db.close()


def get_point_transactions(responder_id: str) -> List[dict]:
    """All ledger rows for one responder (the award half of the recompute)."""
    db = SessionLocal()
    try:
        rows = db.query(PointTransaction).filter(
            PointTransaction.responder_id == responder_id
        ).order_by(PointTransaction.awarded_at.asc()).all()
        return [{
            "incident_id": r.incident_id,
            "responder_id": r.responder_id,
            "delta": r.delta,
            "reason": r.reason,
            "awarded_at": r.awarded_at,
        } for r in rows]
    finally:
        db.close()


def truncate_point_transactions_table() -> None:
    """Delete all rows from the point_transactions table.
    ONLY for use in test teardown/setup — never called in production code."""
    db = SessionLocal()
    try:
        db.query(PointTransaction).delete()
        db.commit()
    except Exception as exc:
        db.rollback()
        raise RuntimeError(
            f"truncate_point_transactions_table failed: {exc}"
        ) from exc
    finally:
        db.close()
