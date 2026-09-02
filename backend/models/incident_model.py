# -*- coding: utf-8 -*-
"""Module 6.5 — SQLAlchemy ORM model for the incidents table, plus all
database helper functions consumed by incident_lifecycle_service.py.

Design discipline:
    - JSONB columns (PostgreSQL dialect) for list/dict fields.
    - gps_location is decomposed to latitude/longitude/village_id columns
      (flat columns are friendlier to future SQL queries than nested JSONB).
    - Indexes on responder_assigned_id, outcome, and outcome_confirmed_by
      — the columns getConfirmedIncidentsForResponder queries.
    - All helpers use a short-lived SessionLocal() with explicit rollback on
      failure; no shared global session.
    - upsert_incident_to_db() uses PostgreSQL INSERT … ON CONFLICT DO UPDATE
      (via SQLAlchemy dialect insert + set_) so the helper is fully idempotent.
    - The INCIDENT_STORE dict shape is preserved in all public returns so
      the existing test harnesses need no changes.
"""
from __future__ import annotations

import sys
from pathlib import Path
from typing import List, Optional

from sqlalchemy import (
    Boolean,
    Column,
    Float,
    Index,
    Integer,
    Text,
    VARCHAR,
)
from sqlalchemy.dialects.postgresql import JSONB

# ---------------------------------------------------------------------------
# Path bootstrap — allow import from either backend/ or project root.
# ---------------------------------------------------------------------------
_BACKEND_DIR = Path(__file__).resolve().parent.parent
if str(_BACKEND_DIR) not in [str(p) for p in sys.path]:
    sys.path.insert(0, str(_BACKEND_DIR))

from database import Base, SessionLocal, engine  # noqa: E402


# ===========================================================================
# ORM MODEL
# ===========================================================================

class IncidentRecord(Base):
    """Persistent mirror of the slice_runner.Incident + logIncident wrapper.

    Column naming follows the Incident Pydantic model exactly so that
    model_dump() can be round-tripped without field renaming.
    """
    __tablename__ = "incidents"

    # ----- Primary key -----
    incident_id = Column(VARCHAR(64), primary_key=True, nullable=False)

    # ----- Core incident fields -----
    timestamp_reported           = Column(VARCHAR(64),  nullable=True)
    reporter_id                  = Column(VARCHAR(64),  nullable=True)

    # gps_location decomposed (avoids JSONB for simple scalar lookups)
    latitude                     = Column(Float,        nullable=True)
    longitude                    = Column(Float,        nullable=True)
    village_id                   = Column(VARCHAR(64),  nullable=True)

    photo_ref                    = Column(VARCHAR(255), nullable=True)
    voice_transcript             = Column(Text,         nullable=True)
    severity_tier                = Column(VARCHAR(16),  nullable=True)
    injury_type_flags            = Column(JSONB,        nullable=True)  # list[str]

    # ----- Dispatch fields -----
    responder_assigned_id        = Column(VARCHAR(64),  nullable=True, index=True)
    responder_dispatch_timestamp = Column(VARCHAR(64),  nullable=True)
    bhu_notified                 = Column(Boolean,      nullable=True, default=False)
    bhu_notify_timestamp         = Column(VARCHAR(64),  nullable=True)
    ambulance_requested          = Column(Boolean,      nullable=True, default=False)

    # ----- Outcome / closure fields (Module 6) -----
    outcome                      = Column(VARCHAR(32),  nullable=True, index=True)
    outcome_confirmed_by         = Column(VARCHAR(16),  nullable=True, index=True)
    incident_closed_timestamp    = Column(VARCHAR(64),  nullable=True)

    # ----- Trace fields (JSONB lists) -----
    help_bot_transitions         = Column(JSONB, nullable=True)  # list[dict]
    dispatch_events              = Column(JSONB, nullable=True)  # list[dict]
    dispatch_fallback_count      = Column(Integer, nullable=True, default=0)

    # ----- logIncident wrapper fields -----
    dispatch_status              = Column(VARCHAR(32),  nullable=True)
    logged_at                    = Column(VARCHAR(64),  nullable=True)
    closed_at                    = Column(VARCHAR(64),  nullable=True)

    # Composite index: the exact query getConfirmedIncidentsForResponder runs.
    __table_args__ = (
        Index(
            "ix_incidents_responder_confirmed",
            "responder_assigned_id",
            "outcome_confirmed_by",
        ),
    )


# Auto-create the table on import (no-op if it already exists).
Base.metadata.create_all(bind=engine)


# ===========================================================================
# RECORD SHAPE HELPERS
# (translate between the DB row and the INCIDENT_STORE dict format)
# ===========================================================================

def _row_to_store_dict(row: IncidentRecord) -> dict:
    """Convert an ORM row back to the INCIDENT_STORE record format:
    {"incident": {...}, "dispatch_status": ..., "logged_at": ..., "closed_at": ...}
    """
    inc = {
        "incident_id":                   row.incident_id,
        "timestamp_reported":            row.timestamp_reported,
        "reporter_id":                   row.reporter_id,
        "gps_location": {
            "latitude":  row.latitude,
            "longitude": row.longitude,
            "village_id": row.village_id,
        },
        "photo_ref":                     row.photo_ref,
        "voice_transcript":              row.voice_transcript,
        "severity_tier":                 row.severity_tier,
        "injury_type_flags":             row.injury_type_flags or [],
        "responder_assigned_id":         row.responder_assigned_id,
        "responder_dispatch_timestamp":  row.responder_dispatch_timestamp,
        "bhu_notified":                  bool(row.bhu_notified),
        "bhu_notify_timestamp":          row.bhu_notify_timestamp,
        "ambulance_requested":           bool(row.ambulance_requested),
        "outcome":                       row.outcome,
        "outcome_confirmed_by":          row.outcome_confirmed_by,
        "incident_closed_timestamp":     row.incident_closed_timestamp,
        "help_bot_transitions":          row.help_bot_transitions or [],
        "dispatch_events":               row.dispatch_events or [],
        "dispatch_fallback_count":       row.dispatch_fallback_count or 0,
    }
    record: dict = {"incident": inc}
    if row.dispatch_status is not None:
        record["dispatch_status"] = row.dispatch_status
    if row.logged_at is not None:
        record["logged_at"] = row.logged_at
    if row.closed_at is not None:
        record["closed_at"] = row.closed_at
    return record


def _store_dict_to_kwargs(store_record: dict) -> dict:
    """Extract ORM column kwargs from an INCIDENT_STORE dict."""
    inc: dict = store_record.get("incident", store_record)
    gps = inc.get("gps_location") or {}
    if hasattr(gps, "latitude"):          # handle GPSLocation Pydantic model
        lat, lon, vid = gps.latitude, gps.longitude, gps.village_id
    else:
        lat = gps.get("latitude")
        lon = gps.get("longitude")
        vid = gps.get("village_id")

    return dict(
        incident_id=inc.get("incident_id"),
        timestamp_reported=inc.get("timestamp_reported"),
        reporter_id=inc.get("reporter_id"),
        latitude=lat,
        longitude=lon,
        village_id=vid,
        photo_ref=inc.get("photo_ref"),
        voice_transcript=inc.get("voice_transcript"),
        severity_tier=inc.get("severity_tier"),
        injury_type_flags=inc.get("injury_type_flags") or [],
        responder_assigned_id=inc.get("responder_assigned_id"),
        responder_dispatch_timestamp=inc.get("responder_dispatch_timestamp"),
        bhu_notified=bool(inc.get("bhu_notified", False)),
        bhu_notify_timestamp=inc.get("bhu_notify_timestamp"),
        ambulance_requested=bool(inc.get("ambulance_requested", False)),
        outcome=inc.get("outcome"),
        outcome_confirmed_by=inc.get("outcome_confirmed_by"),
        incident_closed_timestamp=inc.get("incident_closed_timestamp"),
        help_bot_transitions=inc.get("help_bot_transitions") or [],
        dispatch_events=inc.get("dispatch_events") or [],
        dispatch_fallback_count=inc.get("dispatch_fallback_count") or 0,
        dispatch_status=store_record.get("dispatch_status"),
        logged_at=store_record.get("logged_at"),
        closed_at=store_record.get("closed_at"),
    )


# ===========================================================================
# PUBLIC DB HELPERS
# ===========================================================================

def upsert_incident_to_db(store_record: dict) -> None:
    """Persist (INSERT or UPDATE) one INCIDENT_STORE record to PostgreSQL.

    Idempotent: safe to call multiple times for the same incident_id.
    Uses PostgreSQL dialect INSERT … ON CONFLICT DO UPDATE so that partial
    updates (e.g., a second upsert after closure) correctly overwrite all
    columns with the latest state.
    Raises RuntimeError (with the underlying cause) only if the session
    cannot commit — callers should log and continue rather than propagate.
    """
    from sqlalchemy.dialects.postgresql import insert as pg_insert

    kwargs = _store_dict_to_kwargs(store_record)
    incident_id = kwargs.get("incident_id")
    if not incident_id:
        raise ValueError("upsert_incident_to_db: store_record has no incident_id")

    db = SessionLocal()
    try:
        stmt = (
            pg_insert(IncidentRecord)
            .values(**kwargs)
            .on_conflict_do_update(
                index_elements=["incident_id"],
                set_={k: v for k, v in kwargs.items() if k != "incident_id"},
            )
        )
        db.execute(stmt)
        db.commit()
    except Exception as exc:
        db.rollback()
        raise RuntimeError(
            f"upsert_incident_to_db: DB write failed for {incident_id}: {exc}"
        ) from exc
    finally:
        db.close()


def get_incident_from_db(incident_id: str) -> Optional[dict]:
    """Retrieve one incident by id from PostgreSQL.

    Returns the record in INCIDENT_STORE dict format (matching the existing
    callers' expectations), or None if not found.
    """
    db = SessionLocal()
    try:
        row = db.query(IncidentRecord).filter(
            IncidentRecord.incident_id == incident_id
        ).first()
        return _row_to_store_dict(row) if row else None
    finally:
        db.close()


def get_confirmed_incidents_from_db(
    responder_id: str,
    confirmed_by: Optional[str] = None,
) -> List[dict]:
    """Return closed, confirmed incidents for a responder — the exact query
    getConfirmedIncidentsForResponder runs.  Uses the composite index on
    (responder_assigned_id, outcome_confirmed_by) for O(log n) performance
    instead of the previous O(n) linear scan of INCIDENT_STORE.
    """
    db = SessionLocal()
    try:
        q = db.query(IncidentRecord).filter(
            IncidentRecord.responder_assigned_id == responder_id,
            IncidentRecord.outcome_confirmed_by.isnot(None),
        )
        if confirmed_by is not None:
            q = q.filter(IncidentRecord.outcome_confirmed_by == confirmed_by)
        rows = q.all()
        return [_row_to_store_dict(r) for r in rows]
    finally:
        db.close()


def get_all_incidents_from_db() -> List[dict]:
    """Return EVERY persisted incident record (all lifecycle states).

    Module 5's accountability engine needs to scan dispatch_events across
    ALL incidents involving a responder (dispatches, declines, timeouts) —
    not just confirmed closures, which is what
    get_confirmed_incidents_from_db returns.
    """
    db = SessionLocal()
    try:
        rows = db.query(IncidentRecord).all()
        return [_row_to_store_dict(r) for r in rows]
    finally:
        db.close()


def rehydrate_store_from_db() -> int:
    """Load all persisted incident records from PostgreSQL into
    slice_runner.INCIDENT_STORE (in-memory).

    Call this at process startup (or in tests to simulate a restart) to
    restore full lifecycle history from the DB.  Records already present
    in INCIDENT_STORE (by incident_id) are skipped to avoid duplicates.

    Returns: number of records actually loaded (new ones only).
    """
    # Import here to avoid circular imports — slice_runner imports nothing
    # from backend/models/.
    import slice_runner  # noqa: PLC0415

    db = SessionLocal()
    try:
        rows = db.query(IncidentRecord).all()
    finally:
        db.close()

    existing_ids = {
        r["incident"].get("incident_id")
        for r in slice_runner.INCIDENT_STORE
        if "incident" in r
    }

    loaded = 0
    for row in rows:
        if row.incident_id not in existing_ids:
            slice_runner.INCIDENT_STORE.append(_row_to_store_dict(row))
            loaded += 1
    return loaded


def truncate_incidents_table() -> None:
    """Delete all rows from the incidents table.

    ONLY for use in test teardown/setup — never called in production code.
    """
    db = SessionLocal()
    try:
        db.query(IncidentRecord).delete()
        db.commit()
    except Exception as exc:
        db.rollback()
        raise RuntimeError(f"truncate_incidents_table failed: {exc}") from exc
    finally:
        db.close()
