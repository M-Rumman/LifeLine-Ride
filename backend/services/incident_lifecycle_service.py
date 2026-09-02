# -*- coding: utf-8 -*-
"""Module 6 — Incident Lifecycle & Outcome Tracking.

Closes the gap Module 3 documents in its own docstring ("Known gap (by
design): responder-availability-release ... is Module 6 scope"): Module 3
marks a responder "busy" on dispatch; this module releases them when the
incident is closed with a confirmed outcome.

Design discipline (same as Modules 2/3):
    - NO changes to Module 1/2/3 internals. This module only CONSUMES their
      public data structures: slice_runner.SEED_RESPONDERS / INCIDENT_STORE
      and dispatch_service._DISPATCH_STATE / _STATE_LOCK (read/cleanup only,
      the same way test_module3.py exercises them).
    - Responder release uses the IDENTICAL mechanism Module 3 uses to mark
      busy (direct mutation of SEED_RESPONDERS in sendNotification) and its
      exact inverse in handleResponderDecline — no parallel status pathway.
    - Store sync follows the _sync_store_snapshot discipline from
      help_bot_service.py: mutate the live Incident, then re-dump into the
      matching INCIDENT_STORE record so one record carries the full lifecycle
      (registration + dispatch_events + help_bot_transitions + outcome).
    - Pure local logic: zero network calls, zero AI imports, offline-safe.

Module 6.5 — Persistence layer (PostgreSQL write-through):
    - closeIncident() additionally calls upsert_incident_to_db() after
      every successful in-memory closure. DB failure is non-fatal: it is
      logged as a warning and the in-memory state remains consistent.
    - getIncidentRecord() queries PostgreSQL first (covering closed/persisted
      incidents), then falls back to in-memory INCIDENT_STORE (covering
      freshly-registered, still-open incidents in the current session).
    - getConfirmedIncidentsForResponder() replaces the linear INCIDENT_STORE
      scan with an indexed PostgreSQL query, with an in-memory fallback for
      records not yet persisted (open incidents are never in this result set
      by construction, so the fallback is a no-op in production).
    - rehydrate_store_from_db() is a new public helper (not part of the
      original 4-function surface) used by tests and startup code to reload
      persisted incidents into the in-memory INCIDENT_STORE after a restart.
    - All 4 original function signatures are unchanged.

Accountability contract (Module 5 readiness):
    closeIncident() REFUSES to close an incident without an explicit
    confirmed_by ("responder" | "bhu_staff"). An incident never silently
    closes with an unconfirmed/ambiguous outcome — this is the
    fraud-prevention property Module 5's verified-points awarding depends on.
"""
from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Optional


# ---------------------------------------------------------------------------
# Import path: allow both `import incident_lifecycle_service` (from
# backend/services/) and `from services.incident_lifecycle_service import ...`
# (from project root). Same pattern as dispatch_service.py.
# ---------------------------------------------------------------------------
import sys

_BACKEND_DIR = Path(__file__).resolve().parent.parent
if str(_BACKEND_DIR) not in [str(p) for p in sys.path]:
    sys.path.insert(0, str(_BACKEND_DIR))

import slice_runner  # Module 1: contracts, seed data, INCIDENT_STORE
from services import dispatch_service  # Module 3: _DISPATCH_STATE / _STATE_LOCK

# ---------------------------------------------------------------------------
# Module 6.5: DB helpers — imported lazily inside functions so that the
# service remains importable even if the DB layer has a connection issue
# (keeps Module 3 regression tests unaffected).
# ---------------------------------------------------------------------------
def _db_upsert(store_record: dict) -> None:
    """Write-through to PostgreSQL; logs a warning on any failure."""
    try:
        from models.incident_model import upsert_incident_to_db
        upsert_incident_to_db(store_record)
    except Exception as exc:
        _warn(f"DB write-through failed (non-fatal): {exc}")


def _db_get(incident_id: str) -> Optional[dict]:
    """Retrieve from PostgreSQL; returns None on any error."""
    try:
        from models.incident_model import get_incident_from_db
        return get_incident_from_db(incident_id)
    except Exception as exc:
        _warn(f"DB read failed (falling back to in-memory): {exc}")
        return None


def _db_get_confirmed(
    responder_id: str,
    confirmed_by: Optional[str],
) -> Optional[List[dict]]:
    """Indexed DB query for confirmed incidents; returns None on any error."""
    try:
        from models.incident_model import get_confirmed_incidents_from_db
        return get_confirmed_incidents_from_db(responder_id, confirmed_by)
    except Exception as exc:
        _warn(f"DB query failed (falling back to in-memory): {exc}")
        return None


# ---------------------------------------------------------------------------
# CONSTANTS — the closure contract
# ---------------------------------------------------------------------------

VALID_OUTCOMES = (
    "self-resolved",
    "taken_to_bhu",
    "referred_to_hospital",
    "unresolved",
)
VALID_CONFIRMERS = ("responder", "bhu_staff")

_PROJECT_ROOT = _BACKEND_DIR.parent
_DEFAULT_HISTORY_PATH = _PROJECT_ROOT / "mockdata" / "incidents" / "incident_history.json"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _log(msg: str) -> None:
    print(f"  [LIFECYCLE] {msg}")


def _warn(msg: str) -> None:
    print(f"  [LIFECYCLE WARN] {msg}")


# ===========================================================================
# 1. LIVE-INCIDENT LOOKUP — mirrors dispatch_service._get_incident
# ===========================================================================

def _get_live_incident(incident_id: str) -> Optional[slice_runner.Incident]:
    """Retrieve the live Incident object: Module 3's active dispatch state
    first (carries timers + full trace), then rehydrate from INCIDENT_STORE
    (same fallback discipline as dispatch_service._get_incident)."""
    with dispatch_service._STATE_LOCK:
        state = dispatch_service._DISPATCH_STATE.get(incident_id)
    if state and state.get("incident"):
        return state["incident"]
    record = next(
        (r for r in slice_runner.INCIDENT_STORE
         if r["incident"].get("incident_id") == incident_id), None
    )
    if record:
        return slice_runner.Incident(**record["incident"])
    return None


def _sync_store_snapshot(incident: slice_runner.Incident) -> None:
    """Keep the INCIDENT_STORE record (written by Module 1's logIncident)
    reflecting closure state — inspectable, not a second store. Same
    discipline as help_bot_service._sync_store_snapshot."""
    for record in slice_runner.INCIDENT_STORE:
        if record["incident"].get("incident_id") == incident.incident_id:
            record["incident"] = incident.model_dump()
            record["closed_at"] = _now_iso()
            return


# ===========================================================================
# 2. closeIncident — outcome confirmation + responder release (PRIORITY 1)
# ===========================================================================

def closeIncident(
    incident_id: str,
    outcome: str,
    confirmed_by: str,
) -> dict:
    """Close an incident with a confirmed outcome and release its responder.

    Inputs:
        incident_id   — id of a registered incident.
        outcome       — one of VALID_OUTCOMES.
        confirmed_by  — REQUIRED: "responder" (self-reported) or "bhu_staff"
                        (BHU-verified). Closure without explicit confirmation
                        is refused — the fraud-prevention property Module 5
                        points awarding will rely on.

    Effects (all-or-nothing; validation happens BEFORE any mutation):
        1. Sets outcome / outcome_confirmed_by / incident_closed_timestamp.
        2. Releases the assigned responder back to "available" — the exact
           inverse of sendNotification's busy-mutation, using the same
           SEED_RESPONDERS mechanism as handleResponderDecline. Only a
           "busy" responder is flipped; "offline" is never touched.
        3. Cancels the incident's pending ack timer and removes its
           _DISPATCH_STATE entry (Module 3 session cleanup — a late timer
           must not trigger fallback dispatch after closure).
        4. Appends an "incident_closed" event to incident.dispatch_events —
           the same unified event timeline Modules 2/3 write to.
        5. Syncs the INCIDENT_STORE snapshot (full lifecycle in one record).
        6. [Module 6.5] Upserts the full record to PostgreSQL (non-fatal on
           failure — in-memory state is always committed first).

    Returns the updated incident snapshot (dict). Raises ValueError on any
    invalid input — the incident stays open and untouched.
    """
    # --- Validate FIRST: a rejected closure must never mutate anything ---
    if outcome not in VALID_OUTCOMES:
        raise ValueError(
            f"closeIncident: invalid outcome {outcome!r}. "
            f"Must be one of {VALID_OUTCOMES}."
        )
    if confirmed_by not in VALID_CONFIRMERS:
        raise ValueError(
            f"closeIncident: outcome confirmation is required. confirmed_by "
            f"must be one of {VALID_CONFIRMERS}, got {confirmed_by!r}. "
            f"Incidents never close with an unconfirmed/ambiguous outcome."
        )

    incident = _get_live_incident(incident_id)
    if incident is None:
        raise ValueError(
            f"closeIncident: unknown incident {incident_id} — not in "
            f"dispatch state or INCIDENT_STORE."
        )
    if incident.incident_closed_timestamp is not None:
        raise ValueError(
            f"closeIncident: incident {incident_id} is already closed "
            f"(outcome={incident.outcome}, "
            f"confirmed_by={incident.outcome_confirmed_by}, "
            f"closed_at={incident.incident_closed_timestamp}). "
            f"Closed records are immutable — no silent rewrites."
        )

    now = _now_iso()
    incident.outcome = outcome
    incident.outcome_confirmed_by = confirmed_by
    incident.incident_closed_timestamp = now

    # --- Release the assigned responder (inverse of Module 3 busy-mark) ---
    released_id: Optional[str] = None
    if incident.responder_assigned_id:
        for r in slice_runner.SEED_RESPONDERS:
            if r.responder_id == incident.responder_assigned_id:
                if r.current_availability_status == "busy":
                    # Same mutation pattern as handleResponderDecline.
                    r.current_availability_status = "available"
                    released_id = r.responder_id
                    _log(f"Released {r.name} ({r.responder_id}) -> available.")
                    # Part B persistence fix: write-through to PostgreSQL so
                    # availability status survives process restarts. Narrow
                    # update — touches ONLY the status column, so Module 5's
                    # persisted status_flag (repurposed reliability_tier
                    # column) is never clobbered. Non-fatal.
                    try:
                        from models.responder_model import update_responder_availability
                        update_responder_availability(r.responder_id, "available")
                    except Exception as _exc:
                        _warn(f"DB write-through for available status failed "
                              f"(non-fatal): {_exc}")
                else:
                    # Never flip "offline" (or already-available) responders.
                    _warn(
                        f"Responder {r.responder_id} status is "
                        f"{r.current_availability_status!r}, not busy — "
                        f"left untouched on closure of {incident_id}."
                    )
                break
    else:
        _log(f"No responder was assigned to {incident_id} (BHU-only path) — "
             f"nothing to release.")

    # --- Module 3 session cleanup: cancel ack timer, drop dispatch state ---
    with dispatch_service._STATE_LOCK:
        state = dispatch_service._DISPATCH_STATE.pop(incident_id, None)
    if state is not None:
        timer = state.get("ack_timer")
        if timer is not None:
            timer.cancel()

    # --- Closure event on the unified event timeline ---
    incident.dispatch_events.append({
        "event": "incident_closed",
        "timestamp": now,
        "outcome": outcome,
        "confirmed_by": confirmed_by,
        "responder_released": released_id,
    })

    # --- Module 9: Append localized closure update ---
    if outcome == "taken_to_bhu":
        close_msg = "مریض کو بحفاظت بنیادی مرکزِ صحت منتقل کر دیا گیا ہے۔ ایمرجنسی مکمل ہو چکی ہے۔"
    elif outcome == "self-resolved":
        close_msg = "ابتدائی طبی امداد مکمل ہو گئی ہے اور صورتحال قابو میں ہے۔ شکریہ۔"
    else:  # referred_to_hospital or unresolved
        close_msg = "ایمرجنسی کارروائی مکمل ہو گئی ہے اور متعلقہ ہسپتال کو رپورٹ بھیج دی گئی ہے۔"

    incident.reporter_updates.append({
        "update_id": f"UPD-{uuid.uuid4().hex[:6].upper()}",
        "timestamp": now,
        "stage": "closed",
        "message_urdu": close_msg,
        "severity_tier": incident.severity_tier,
    })

    # --- Sync the store snapshot (full lifecycle in one record) ---
    _sync_store_snapshot(incident)

    # --- [Module 6.5] Write-through to PostgreSQL ---
    # Retrieve the updated in-memory record (now has closed_at) to upsert.
    store_record = next(
        (r for r in slice_runner.INCIDENT_STORE
         if r["incident"].get("incident_id") == incident_id),
        None,
    )
    if store_record is not None:
        _db_upsert(store_record)
    else:
        # Fallback: build a minimal record from the incident snapshot alone.
        _db_upsert({"incident": incident.model_dump()})

    _log(f"Incident {incident_id} closed: outcome={outcome} "
         f"confirmed_by={confirmed_by} (responder_released={released_id}).")
    return incident.model_dump()


def recordResponderArrival(incident_id: str, responder_id: str) -> dict:
    """Record that the dispatched responder has arrived on scene (Module 9).

    Sets responder_arrived_timestamp, logs 'responder_arrived' in dispatch_events,
    and appends the localized Urdu update to reporter_updates.
    Persists to PostgreSQL and syncs INCIDENT_STORE.
    """
    incident = _get_live_incident(incident_id)
    if incident is None:
        raise ValueError(f"recordResponderArrival: unknown incident {incident_id}")

    now = _now_iso()
    incident.responder_arrived_timestamp = now

    responder_name = "رضاکار"
    for r in slice_runner.SEED_RESPONDERS:
        if r.responder_id == responder_id:
            responder_name = r.name
            break

    # 1. Log arrival in dispatch_events
    incident.dispatch_events.append({
        "event": "responder_arrived",
        "responder_id": responder_id,
        "responder_name": responder_name,
        "timestamp": now,
    })

    # 2. Append localized Urdu update
    update_entry = {
        "update_id": f"UPD-{uuid.uuid4().hex[:6].upper()}",
        "timestamp": now,
        "stage": "responder_arrived",
        "message_urdu": f"مددگار {responder_name} جائے وقوعہ پر پہنچ چکے ہیں۔",
        "severity_tier": incident.severity_tier,
    }
    incident.reporter_updates.append(update_entry)

    # 3. Sync INCIDENT_STORE & PostgreSQL
    _sync_store_snapshot(incident)
    store_record = next(
        (r for r in slice_runner.INCIDENT_STORE
         if r["incident"].get("incident_id") == incident_id),
        None,
    )
    if store_record is not None:
        _db_upsert(store_record)
    else:
        _db_upsert({"incident": incident.model_dump()})

    _log(f"Responder arrival recorded for {incident_id} ({responder_id} - {responder_name}).")
    return update_entry



# ===========================================================================
# 3. QUERY LAYER — full-lifecycle history + Module 5 readiness
# ===========================================================================

def getIncidentRecord(incident_id: str) -> Optional[dict]:
    """Full lifecycle record for one incident: registration snapshot,
    dispatch_events (Module 3), help_bot_transitions (Module 2), and
    outcome/closure fields (Module 6) — all in the one record kept synced
    by every module.

    [Module 6.5] Query order:
        1. PostgreSQL (covers closed/persisted incidents across restarts).
        2. In-memory INCIDENT_STORE fallback (covers freshly-registered,
           still-open incidents in the current session).
    """
    # 1. Try the persistent store first.
    db_record = _db_get(incident_id)
    if db_record is not None:
        return db_record

    # 2. Fall back to the in-memory store (open incidents not yet persisted).
    for record in slice_runner.INCIDENT_STORE:
        if record["incident"].get("incident_id") == incident_id:
            return record
    return None


def getIncidentTransitions(incident_id: str) -> List[dict]:
    """Module 2's help_bot_transitions for this incident — proves the
    help-bot trace lives ON the incident record and is queryable, not
    sitting in a disconnected log."""
    incident = _get_live_incident(incident_id)
    if incident is None:
        raise ValueError(f"getIncidentTransitions: unknown incident {incident_id}")
    return list(incident.help_bot_transitions)


def getConfirmedIncidentsForResponder(
    responder_id: str,
    confirmed_by: Optional[str] = None,
) -> List[dict]:
    """All incidents this responder handled that closed with a CONFIRMED
    outcome — exactly the query Module 5's points calculation will run.

    confirmed_by=None  -> any confirmed closure (responder or bhu_staff).
    confirmed_by="bhu_staff" -> only BHU-verified closures (the strongest
    fraud-prevention tier for future points awarding).

    Unclosed incidents and closures without confirmation are excluded by
    construction — closeIncident never permits the latter.

    [Module 6.5] Scope to current-session incidents if INCIDENT_STORE is
    populated, falling back to full DB query if empty (restart).
    """
    if slice_runner.INCIDENT_STORE:
        results: List[dict] = []
        for record in slice_runner.INCIDENT_STORE:
            inc = record["incident"]
            if inc.get("responder_assigned_id") != responder_id:
                continue
            if inc.get("outcome_confirmed_by") is None:
                continue
            if confirmed_by is not None and inc.get("outcome_confirmed_by") != confirmed_by:
                continue
            results.append(record)
        return results

    # Fallback to full DB query (restart scenario)
    return _db_get_confirmed(responder_id, confirmed_by) or []


def exportIncidentHistory(path: Optional[str] = None) -> Path:
    """Write the full INCIDENT_STORE to disk as JSON — same artifact pattern
    as mockdata/helpbot/test_runs/. A stopgap for inspectability across
    process restarts, NOT a replacement for the real persistence layer
    Module 5/7 will need."""
    out_path = Path(path) if path else _DEFAULT_HISTORY_PATH
    out_path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "exported_at": _now_iso(),
        "incident_count": len(slice_runner.INCIDENT_STORE),
        "records": slice_runner.INCIDENT_STORE,
    }
    out_path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    _log(f"Incident history exported: {out_path} "
         f"({payload['incident_count']} incidents).")
    return out_path


# ===========================================================================
# 4. RESTART SURVIVAL HELPER (Module 6.5 addition — not part of original API)
# ===========================================================================

def rehydrate_store_from_db() -> int:
    """Reload all persisted incidents from PostgreSQL into
    slice_runner.INCIDENT_STORE.

    Safe to call at process startup or in test fixtures that simulate a
    restart.  Records already present in INCIDENT_STORE (by incident_id)
    are skipped to avoid duplicates.

    Returns: number of new records loaded from DB.
    """
    try:
        from models.incident_model import rehydrate_store_from_db as _db_rehydrate
        count = _db_rehydrate()
        _log(f"Rehydrated {count} incident(s) from PostgreSQL into INCIDENT_STORE.")
        return count
    except Exception as exc:
        _warn(f"rehydrate_store_from_db failed: {exc}")
        return 0
