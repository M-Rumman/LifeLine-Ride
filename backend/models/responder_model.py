from __future__ import annotations

import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Optional

from sqlalchemy import (
    Boolean,
    Column,
    Integer,
    VARCHAR,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB

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
    accountability fields and Module 7's verification/onboarding fields."""
    __tablename__ = "responders"

    responder_id                = Column(VARCHAR(64),  primary_key=True, nullable=False)
    name                        = Column(VARCHAR(128), nullable=True)
    village                     = Column(VARCHAR(64),  nullable=True, index=True)
    linked_bhu_id               = Column(VARCHAR(64),  nullable=True)
    current_availability_status = Column(VARCHAR(16),  nullable=True)
    points_total                = Column(Integer,      nullable=False, default=0)
    reliability_tier            = Column(VARCHAR(16),  nullable=False, default="active")
    created_at                  = Column(VARCHAR(64),  nullable=True)
    updated_at                  = Column(VARCHAR(64),  nullable=True)

    # ----- Module 7: Onboarding & Verification fields -----
    phone_number                = Column(VARCHAR(32),  unique=True, nullable=True)
    is_verified                 = Column(Boolean,      nullable=False, default=False)
    verified_by                 = Column(VARCHAR(128), nullable=True)
    verified_at                 = Column(VARCHAR(64),  nullable=True)
    training_completed          = Column(Boolean,      nullable=False, default=False)
    training_org                = Column(VARCHAR(128), nullable=True)
    equipment_checklist         = Column(JSONB,        nullable=True)


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
    """Persist (INSERT or UPDATE) one FULL responder row. Idempotent."""
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
        reliability_tier=responder_dict.get("reliability_tier", "active"),
        created_at=responder_dict.get("created_at") or now,
        updated_at=now,
        phone_number=responder_dict.get("phone_number"),
        is_verified=bool(responder_dict.get("is_verified", False)),
        verified_by=responder_dict.get("verified_by"),
        verified_at=responder_dict.get("verified_at"),
        training_completed=bool(responder_dict.get("training_completed", False)),
        training_org=responder_dict.get("training_org"),
        equipment_checklist=responder_dict.get("equipment_checklist"),
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


def register_responder_db(responder_data: dict) -> dict:
    """Register a new candidate responder in PostgreSQL.

    Defaults to unverified state (is_verified=False, status='unverified').
    Returns the created responder dict.
    """
    responder_id = responder_data.get("responder_id") or f"RESP-{uuid.uuid4().hex[:6].upper()}"
    now = _now_iso()
    record = {
        "responder_id": responder_id,
        "name": responder_data.get("name"),
        "village": responder_data.get("village"),
        "linked_bhu_id": responder_data.get("linked_bhu_id"),
        "phone_number": responder_data.get("phone_number"),
        "current_availability_status": responder_data.get("current_availability_status", "unverified"),
        "points_total": int(responder_data.get("points_total", 0)),
        "reliability_tier": responder_data.get("reliability_tier", "active"),
        "is_verified": bool(responder_data.get("is_verified", False)),
        "verified_by": responder_data.get("verified_by"),
        "verified_at": responder_data.get("verified_at"),
        "training_completed": bool(responder_data.get("training_completed", False)),
        "training_org": responder_data.get("training_org"),
        "equipment_checklist": responder_data.get("equipment_checklist") or [],
        "created_at": responder_data.get("created_at") or now,
        "updated_at": now,
    }
    upsert_responder_to_db(record)
    return record


def verify_responder_db(
    responder_id: str,
    verified_by: str,
    equipment: list,
) -> Optional[dict]:
    """Promote candidate responder to verified and available in PostgreSQL."""
    db = SessionLocal()
    try:
        row = db.query(ResponderRecord).filter(
            ResponderRecord.responder_id == responder_id
        ).first()
        if row is None:
            return None
        now = _now_iso()
        row.is_verified = True
        row.verified_by = verified_by
        row.verified_at = now
        row.equipment_checklist = equipment
        row.current_availability_status = "available"
        row.updated_at = now
        db.commit()
        return {
            "responder_id": row.responder_id,
            "name": row.name,
            "village": row.village,
            "linked_bhu_id": row.linked_bhu_id,
            "current_availability_status": row.current_availability_status,
            "points_total": row.points_total,
            "reliability_tier": row.reliability_tier,
            "phone_number": row.phone_number,
            "is_verified": row.is_verified,
            "verified_by": row.verified_by,
            "verified_at": row.verified_at,
            "training_completed": row.training_completed,
            "training_org": row.training_org,
            "equipment_checklist": row.equipment_checklist,
            "created_at": row.created_at,
            "updated_at": row.updated_at,
        }
    except Exception as exc:
        db.rollback()
        raise RuntimeError(f"verify_responder_db failed for {responder_id}: {exc}") from exc
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
            "phone_number": row.phone_number,
            "is_verified": row.is_verified,
            "verified_by": row.verified_by,
            "verified_at": row.verified_at,
            "training_completed": row.training_completed,
            "training_org": row.training_org,
            "equipment_checklist": row.equipment_checklist,
            "created_at": row.created_at,
            "updated_at": row.updated_at,
        }
    finally:
        db.close()


def list_responders_from_db(
    village: Optional[str] = None,
    is_verified: Optional[bool] = None,
    order_by_points: bool = False,
) -> List[dict]:
    """List responder rows, optionally filtered by village and verification status."""
    db = SessionLocal()
    try:
        q = db.query(ResponderRecord)
        if village is not None:
            q = q.filter(ResponderRecord.village == village)
        if is_verified is not None:
            q = q.filter(ResponderRecord.is_verified == is_verified)
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
            "phone_number": r.phone_number,
            "is_verified": r.is_verified,
            "verified_by": r.verified_by,
            "verified_at": r.verified_at,
            "training_completed": r.training_completed,
            "training_org": r.training_org,
            "equipment_checklist": r.equipment_checklist,
            "created_at": r.created_at,
            "updated_at": r.updated_at,
        } for r in rows]
    finally:
        db.close()


def clear_pending_responders_db() -> int:
    """Delete all unverified candidate responders (is_verified=False) from DB."""
    db = SessionLocal()
    try:
        count = db.query(ResponderRecord).filter(
            ResponderRecord.is_verified == False  # noqa: E712
        ).delete(synchronize_session=False)
        db.commit()
        return count
    except Exception as exc:
        db.rollback()
        raise RuntimeError(f"clear_pending_responders_db failed: {exc}") from exc
    finally:
        db.close()


def delete_responder_db(responder_id: str) -> bool:
    """Delete a single responder by ID from PostgreSQL."""
    db = SessionLocal()
    try:
        deleted = db.query(ResponderRecord).filter(
            ResponderRecord.responder_id == responder_id
        ).delete(synchronize_session=False)
        db.commit()
        return bool(deleted > 0)
    except Exception as exc:
        db.rollback()
        raise RuntimeError(f"delete_responder_db failed for {responder_id}: {exc}") from exc
    finally:
        db.close()


def update_responder_availability(responder_id: str, status: str) -> bool:
    """Narrow write-through of ONLY current_availability_status (+ updated_at)."""
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
                points_total=0,
                reliability_tier="active",
                phone_number=getattr(seed, "phone_number", None) if seed else None,
                is_verified=getattr(seed, "is_verified", False) if seed else False,
                verified_by=getattr(seed, "verified_by", None) if seed else None,
                verified_at=getattr(seed, "verified_at", None) if seed else None,
                training_completed=getattr(seed, "training_completed", False) if seed else False,
                training_org=getattr(seed, "training_org", None) if seed else None,
                equipment_checklist=getattr(seed, "equipment_checklist", None) if seed else None,
                created_at=now,
                updated_at=now,
            )
            .on_conflict_do_update(
                index_elements=["responder_id"],
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

    Module 7 update: seed responders start as pre-verified.
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
            "current_availability_status": r.current_availability_status,
            "points_total": 0,
            "reliability_tier": "active",
            "phone_number": getattr(r, "phone_number", None),
            "is_verified": getattr(r, "is_verified", True),
            "verified_by": getattr(r, "verified_by", "SEED_ADMIN"),
            "verified_at": getattr(r, "verified_at", now),
            "training_completed": getattr(r, "training_completed", True),
            "training_org": getattr(r, "training_org", "DoH"),
            "equipment_checklist": getattr(r, "equipment_checklist", ["tourniquet", "pressure_bandages", "splints", "antiseptic"]),
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
                set_={
                    "name": pg_insert(ResponderRecord).excluded.name,
                    "village": pg_insert(ResponderRecord).excluded.village,
                    "linked_bhu_id": pg_insert(ResponderRecord).excluded.linked_bhu_id,
                    "phone_number": pg_insert(ResponderRecord).excluded.phone_number,
                    "training_completed": pg_insert(ResponderRecord).excluded.training_completed,
                    "training_org": pg_insert(ResponderRecord).excluded.training_org,
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
    """Reload all responders from PostgreSQL into the in-memory SEED_RESPONDERS list.

    Module 7: rehydrates both existing seed responders and any dynamically
    registered candidate responders, preserving their verified/unverified state
    and availability across process restarts.
    """
    import slice_runner

    rows = list_responders_from_db(order_by_points=False)
    in_memory_map = {r.responder_id: r for r in seed_responders}
    count = 0

    for row in rows:
        rid = row["responder_id"]
        if rid in in_memory_map:
            # Update existing in-memory responder
            r = in_memory_map[rid]
            if row.get("current_availability_status"):
                r.current_availability_status = row["current_availability_status"]
            r.is_verified = bool(row.get("is_verified", False))
            r.verified_by = row.get("verified_by")
            r.verified_at = row.get("verified_at")
            r.training_completed = bool(row.get("training_completed", False))
            r.training_org = row.get("training_org")
            r.equipment_checklist = row.get("equipment_checklist")
            r.phone_number = row.get("phone_number")
            count += 1
        else:
            # Rehydrate dynamically registered responder into memory
            new_r = slice_runner.Responder(
                responder_id=rid,
                name=row.get("name") or "Unknown",
                village=row.get("village") or "Unknown",
                linked_bhu_id=row.get("linked_bhu_id") or "BHU-001",
                current_availability_status=row.get("current_availability_status") or "unverified",
                points_total=int(row.get("points_total", 0)),
                phone_number=row.get("phone_number"),
                is_verified=bool(row.get("is_verified", False)),
                verified_by=row.get("verified_by"),
                verified_at=row.get("verified_at"),
                training_completed=bool(row.get("training_completed", False)),
                training_org=row.get("training_org"),
                equipment_checklist=row.get("equipment_checklist"),
            )
            seed_responders.append(new_r)
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
