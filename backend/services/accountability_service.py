# -*- coding: utf-8 -*-
"""Module 5 — Responder Performance Record & Accountability Engine.

Deterministic metrics tracking over the Module 6/6.5 lifecycle data.
Replaces the previous points/tier system (Gold/Silver/Bronze) which was
removed because scoring-to-win misaligns with the actual goal of helping
people in an emergency — a responder should not avoid difficult incidents
to protect their score.

What is tracked instead — a factual, auditable ResponderPerformanceRecord:
    incidents_responded_to      int    BHU-confirmed closures only
    incidents_by_outcome        dict   breakdown per outcome type
    average_response_time_s     float  dispatch-timestamp to ack-event
    timeout_count               int    ack_timeout events (Module 3 audit)
    decline_count               int    responder_declined events
    status_flag                 str    "active" | "needs_follow_up" | "under_review"

Status flag thresholds (simple, not scored):
    under_review    more than 3 consecutive timeouts/no-responses
    needs_follow_up 2 or more timeouts/declines in the most recent 5 dispatches
    active          default / healthy

Fraud-prevention design FULLY PRESERVED (unchanged from the previous version):
    - incidents_by_outcome and average_response_time are only populated for
      incidents where outcome_confirmed_by == "bhu_staff". Self-reported,
      unconfirmed outcomes are never counted.
    - The idempotency mechanism is preserved intact: the point_transactions
      ledger table (UNIQUE on incident_id) is REPURPOSED as an incident
      contribution log — one row per confirmed incident, preventing any
      incident from being counted twice even if the trigger fires more than
      once. The "delta" column now stores 1 (one incident counted) and the
      "reason" column stores the outcome string.

DB COLUMN REPURPOSING NOTE:
    The responders table has two columns from the old points system that are
    repurposed here rather than migrated (to avoid ALTER TABLE in production):
        - reliability_tier (VARCHAR 16): now stores status_flag values
          ("active", "needs_follow_up", "under_review"). Old tier values
          (gold/silver/bronze) are replaced by these on first status sync.
        - points_total (INTEGER): no longer meaningful; always written as 0.
          It is kept in the schema as a vestigial column — a future migration
          may rename or drop it, but no code reads it for accountability logic.

Design discipline:
    - Pure deterministic logic: ZERO AI calls, zero network beyond the
      existing PostgreSQL layer.
    - DB helpers are imported lazily inside try/except (same pattern as
      incident_lifecycle_service's Module 6.5 wiring) so this module stays
      importable even if the DB layer is unreachable.
    - Does not touch Module 1–3 internals: consumes only the Module 6 query
      layer (getIncidentRecord / getConfirmedIncidentsForResponder),
      slice_runner.INCIDENT_STORE, and Module 3's dispatch_events records.
"""
from __future__ import annotations

import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Optional

# ---------------------------------------------------------------------------
# Import path: allow both `import accountability_service` (from
# backend/services/) and `from services.accountability_service import ...`
# (from project root). Same pattern as incident_lifecycle_service.py.
# ---------------------------------------------------------------------------
_BACKEND_DIR = Path(__file__).resolve().parent.parent
if str(_BACKEND_DIR) not in [str(p) for p in sys.path]:
    sys.path.insert(0, str(_BACKEND_DIR))

import slice_runner  # Module 1: INCIDENT_STORE for current-session records
from services import incident_lifecycle_service as lifecycle  # Module 6 query layer

# ---------------------------------------------------------------------------
# THRESHOLD CONSTANTS — the only tunable values in the status-flag logic
# ---------------------------------------------------------------------------

CONSECUTIVE_TIMEOUT_FLAG_LIMIT = 3    # flag "under_review" when run EXCEEDS this
RECENT_DISPATCH_WINDOW         = 5    # window size for "needs_follow_up" check
RECENT_CONCERN_THRESHOLD       = 2    # min timeouts+declines in window to flag

# Dispatch-event vocabulary written by Module 3 (dispatch_service.py).
EVENT_DISPATCHED = "responder_dispatched"
EVENT_TIMEOUT    = "ack_timeout"
EVENT_DECLINED   = "responder_declined"
EVENT_ACK        = "responder_acknowledged"

# Outcome vocabulary (matches VALID_OUTCOMES in incident_lifecycle_service).
ALL_OUTCOMES = ("self-resolved", "taken_to_bhu", "referred_to_hospital", "unresolved")
BHU_CONFIRMED_OUTCOMES = ("taken_to_bhu", "referred_to_hospital")


def _log(msg: str) -> None:
    print(f"  [ACCOUNTABILITY] {msg}")


def _warn(msg: str) -> None:
    print(f"  [ACCOUNTABILITY WARN] {msg}")


# ===========================================================================
# LAZY DB HELPERS — never let a DB outage break module import
# ===========================================================================

def _get_all_incidents_db() -> List[dict]:
    try:
        from models.incident_model import get_all_incidents_from_db
        return get_all_incidents_from_db()
    except Exception as exc:
        _warn(f"DB incident scan failed (using in-memory store only): {exc}")
        return []


def _has_contribution(incident_id: str) -> bool:
    """Check if this incident already has a ledger row (idempotency gate)."""
    try:
        from models.responder_model import has_award_for_incident
        return has_award_for_incident(incident_id)
    except Exception as exc:
        _warn(f"Ledger lookup failed for {incident_id}: {exc}")
        return False


def _insert_contribution(incident_id: str, responder_id: str, outcome: str) -> Optional[dict]:
    """Insert one row into the incident contribution ledger.

    delta=1 (one incident counted), reason=outcome string.
    The UNIQUE(incident_id) constraint makes double-counting structurally
    impossible — same idempotency guarantee as the old point_transactions ledger.
    """
    try:
        from models.responder_model import insert_point_transaction
        # delta=1: one incident counted. The "delta" column is repurposed from
        # its original point-value role to an incident-count contribution.
        return insert_point_transaction(incident_id, responder_id, delta=1, reason=outcome)
    except Exception as exc:
        _warn(f"Ledger insert failed for {incident_id}: {exc}")
        return None


def _get_contributions(responder_id: str) -> List[dict]:
    """All ledger rows for one responder (the confirmed-incident record)."""
    try:
        from models.responder_model import get_point_transactions
        return get_point_transactions(responder_id)
    except Exception as exc:
        _warn(f"Ledger read failed for {responder_id}: {exc}")
        return []


def _write_status_flag_db(responder_id: str, status_flag: str) -> bool:
    """Persist the status_flag to the responders table.

    Uses the reliability_tier column for storage (repurposed — see module
    docstring). points_total is written as 0 (unused vestigial column).
    """
    try:
        from models.responder_model import update_responder_points
        # update_responder_points(responder_id, points_total, reliability_tier)
        # reliability_tier column now stores status_flag values.
        # points_total is written as 0 — unused but kept for schema compatibility.
        update_responder_points(responder_id, 0, status_flag)
        return True
    except Exception as exc:
        _warn(f"Status flag update failed for {responder_id}: {exc}")
        return False


# ===========================================================================
# 1. DISPATCH HISTORY — metrics from Module 3's event timeline
# ===========================================================================

def _gather_incident_records(responder_id: str) -> List[dict]:
    """Union of DB incidents and the in-memory INCIDENT_STORE (store wins on
    id collision — it carries the live state), filtered to records that
    involve this responder either as the assigned responder or anywhere in
    dispatch_events (dispatched / declined / timed-out / released)."""
    merged: dict = {}
    for rec in _get_all_incidents_db():
        iid = rec["incident"].get("incident_id")
        if iid:
            merged[iid] = rec
    for rec in slice_runner.INCIDENT_STORE:
        iid = rec.get("incident", {}).get("incident_id")
        if iid:
            merged[iid] = rec  # live/current-session record wins

    def involves(rec: dict) -> bool:
        inc = rec["incident"]
        if inc.get("responder_assigned_id") == responder_id:
            return True
        for ev in inc.get("dispatch_events") or []:
            if responder_id in (ev.get("responder_id"), ev.get("responder_released")):
                return True
        return False

    return [rec for rec in merged.values() if involves(rec)]


def _dispatch_history(responder_id: str) -> dict:
    """Deterministic audit of this responder's dispatch history across ALL
    incidents (DB + current session): counts, acceptance rate, and the
    consecutive-timeout run used for the under-review flag."""
    dispatches: List[tuple] = []      # (timestamp, incident_id)
    timed_out_incidents: set = set()
    declined_incidents: set = set()

    for rec in _gather_incident_records(responder_id):
        inc = rec["incident"]
        iid = inc.get("incident_id")
        for ev in inc.get("dispatch_events") or []:
            if ev.get("responder_id") != responder_id:
                continue
            event = ev.get("event")
            if event == EVENT_DISPATCHED:
                dispatches.append((ev.get("timestamp") or "", iid))
            elif event == EVENT_TIMEOUT:
                timed_out_incidents.add(iid)
            elif event == EVENT_DECLINED:
                declined_incidents.add(iid)

    dispatches.sort()  # ISO timestamps sort chronologically as strings

    outcomes: List[str] = []
    declined = 0
    timed_out = 0
    for _, iid in dispatches:
        if iid in declined_incidents:
            declined += 1
            outcomes.append("declined")
        elif iid in timed_out_incidents:
            timed_out += 1
            outcomes.append("timeout")
        else:
            outcomes.append("completed")

    total_assigned = len(dispatches)
    completed = max(total_assigned - declined - timed_out, 0)
    acceptance = round(completed / total_assigned * 100, 1) if total_assigned else 0.0

    # Consecutive-timeout run (chronological dispatch outcomes).
    max_run = run = 0
    for outcome in outcomes:
        run = run + 1 if outcome == "timeout" else 0
        max_run = max(max_run, run)

    # Concern count in the most recent RECENT_DISPATCH_WINDOW dispatches.
    recent = outcomes[-RECENT_DISPATCH_WINDOW:] if outcomes else []
    recent_concerns = sum(1 for o in recent if o in ("timeout", "declined"))

    return {
        "total_assigned": total_assigned,
        "completed": completed,
        "declined": declined,
        "timed_out": timed_out,
        "acceptance_rate_pct": acceptance,
        "flagged_for_review": max_run > CONSECUTIVE_TIMEOUT_FLAG_LIMIT,
        "recent_concerns": recent_concerns,
    }


def _avg_response_time(responder_id: str, incident_records: List[dict]) -> float:
    """Average seconds from responder_dispatched event to responder_acknowledged
    event, across BHU-confirmed incidents for this responder.

    Only incidents that have BOTH a dispatch timestamp and an ack timestamp are
    included in the average — incidents where the responder timed out or declined
    (no ack) are excluded from this metric (their impact shows in timeout_count
    and decline_count instead).

    Returns 0.0 if no valid data points exist.
    """
    durations: List[float] = []
    for rec in incident_records:
        inc = rec["incident"]
        events = inc.get("dispatch_events") or []
        dispatch_ts: Optional[str] = None
        ack_ts: Optional[str] = None
        for ev in events:
            if ev.get("responder_id") == responder_id:
                if ev.get("event") == EVENT_DISPATCHED and dispatch_ts is None:
                    dispatch_ts = ev.get("timestamp")
                elif ev.get("event") == EVENT_ACK and ack_ts is None:
                    ack_ts = ev.get("timestamp")
        if dispatch_ts and ack_ts:
            try:
                def _parse(ts: str) -> datetime:
                    # Handle both "+00:00" and "Z" suffix styles.
                    ts = ts.replace("Z", "+00:00")
                    return datetime.fromisoformat(ts)
                delta_s = (_parse(ack_ts) - _parse(dispatch_ts)).total_seconds()
                if delta_s >= 0:
                    durations.append(delta_s)
            except Exception:
                pass  # malformed timestamp — skip, don't crash
    return round(sum(durations) / len(durations), 2) if durations else 0.0


def _status_flag_for(hist: dict) -> str:
    """Derive status_flag from dispatch history metrics.

    Priority order (highest concern wins):
        1. under_review  — more than CONSECUTIVE_TIMEOUT_FLAG_LIMIT consecutive
                           timeouts (structural pattern of non-response)
        2. needs_follow_up — RECENT_CONCERN_THRESHOLD or more timeouts/declines
                           in the last RECENT_DISPATCH_WINDOW dispatches
                           (lighter signal — worth a human check-in)
        3. active        — default / healthy
    """
    if hist["flagged_for_review"]:
        return "under_review"
    if hist["recent_concerns"] >= RECENT_CONCERN_THRESHOLD:
        return "needs_follow_up"
    return "active"


# ===========================================================================
# 2. getResponderPerformanceRecord — read-only deterministic record
# ===========================================================================

def getResponderPerformanceRecord(responder_id: str) -> dict:
    """Full performance record for one responder.

    Confirmed incidents come from Module 6's getConfirmedIncidentsForResponder
    filtered to confirmed_by="bhu_staff" (the fraud-prevention gate).
    Dispatch metrics (timeout_count, decline_count, status_flag) come from the
    dispatch_events audit. Pure read — no mutation anywhere.

    Returns a ResponderPerformanceRecord dict:
        {
          "responder_id": str,
          "incidents_responded_to": int,
          "incidents_by_outcome": {
            "self-resolved": int,
            "taken_to_bhu": int,
            "referred_to_hospital": int,
            "unresolved": int,
          },
          "average_response_time_seconds": float,
          "timeout_count": int,
          "decline_count": int,
          "dispatch_metrics": {
            "total_assigned": int,
            "completed": int,
            "acceptance_rate_pct": float,
          },
          "status_flag": "active" | "needs_follow_up" | "under_review",
        }
    """
    # Fraud gate: only BHU-verified closures count toward the performance record.
    confirmed = lifecycle.getConfirmedIncidentsForResponder(
        responder_id, confirmed_by="bhu_staff"
    )

    outcomes_count: dict = {o: 0 for o in ALL_OUTCOMES}
    for rec in confirmed:
        inc = rec["incident"]
        outcome = inc.get("outcome")
        if outcome in outcomes_count:
            outcomes_count[outcome] += 1

    incidents_responded_to = sum(outcomes_count.values())
    avg_rt = _avg_response_time(responder_id, confirmed)

    hist = _dispatch_history(responder_id)
    status = _status_flag_for(hist)

    return {
        "responder_id": responder_id,
        "incidents_responded_to": incidents_responded_to,
        "incidents_by_outcome": outcomes_count,
        "average_response_time_seconds": avg_rt,
        "timeout_count": hist["timed_out"],
        "decline_count": hist["declined"],
        "dispatch_metrics": {
            "total_assigned": hist["total_assigned"],
            "completed": hist["completed"],
            "acceptance_rate_pct": hist["acceptance_rate_pct"],
        },
        "status_flag": status,
    }


# ===========================================================================
# 3. recordIncidentContribution — idempotent, fraud-guarded metric trigger
# ===========================================================================

def awardPointsForIncident(incident_id: str) -> dict:
    """Evaluate one closed incident and record its contribution to the
    assigned responder's performance metrics if — and only if — the outcome
    is BHU-verified.

    The function name is preserved for backward compatibility with the Module 3
    trigger wiring. Internally it now records a metric contribution (not points).

    Returns a transaction receipt:
        {"status": "recorded", ...}         ledger row written, status synced
        {"status": "already_recorded", ...} idempotent re-call, no mutation
        {"status": "ignored", "reason": ...} zero mutation. Reasons:
            unconfirmed_by_bhu  — confirmed_by != bhu_staff (fraud guard)
            not_closed          — incident still open
            no_responder_assigned — BHU-only incident, nobody to record for
            outcome_not_countable — outcome is not in the trackable set
            unknown_incident    — not in DB or store
    """
    record = lifecycle.getIncidentRecord(incident_id)
    if record is None:
        _warn(f"awardPointsForIncident: unknown incident {incident_id}")
        return {"status": "ignored", "reason": "unknown_incident",
                "incident_id": incident_id}

    inc = record["incident"]
    responder_id = inc.get("responder_assigned_id")
    if not responder_id:
        _log(f"{incident_id}: no responder assigned (BHU-only) — nothing to record.")
        return {"status": "ignored", "reason": "no_responder_assigned",
                "incident_id": incident_id}
    if inc.get("incident_closed_timestamp") is None or inc.get("outcome") is None:
        _log(f"{incident_id}: still open — metrics only after confirmed closure.")
        return {"status": "ignored", "reason": "not_closed",
                "incident_id": incident_id}
    if inc.get("outcome_confirmed_by") != "bhu_staff":
        # THE fraud-prevention gate: self-reported closures earn nothing.
        _log(f"{incident_id}: confirmed_by="
             f"{inc.get('outcome_confirmed_by')!r}, not bhu_staff — "
             f"contribution refused (pending BHU verification).")
        return {"status": "ignored", "reason": "unconfirmed_by_bhu",
                "incident_id": incident_id, "responder_id": responder_id}

    outcome = inc["outcome"]
    if outcome not in ALL_OUTCOMES:
        _log(f"{incident_id}: outcome={outcome!r} not in trackable set.")
        return {"status": "ignored", "reason": "outcome_not_countable",
                "incident_id": incident_id, "responder_id": responder_id}

    # Idempotency: one incident can only ever contribute once (UNIQUE ledger).
    if _has_contribution(incident_id):
        _log(f"{incident_id}: already recorded — no double-count.")
        return {"status": "already_recorded", "incident_id": incident_id,
                "responder_id": responder_id, "outcome": outcome}

    tx = _insert_contribution(incident_id, responder_id, outcome)
    if tx is None:
        return {"status": "error", "reason": "ledger_write_failed",
                "incident_id": incident_id, "responder_id": responder_id}

    status_flag = _sync_responder_status(responder_id)
    _log(f"Recorded contribution for {responder_id}: incident={incident_id} "
         f"outcome={outcome!r} -> status_flag={status_flag}.")
    return {
        "status": "recorded",
        "incident_id": incident_id,
        "responder_id": responder_id,
        "outcome": outcome,
        "recorded_at": tx["awarded_at"],
        "status_flag": status_flag,
    }


def _sync_responder_status(responder_id: str) -> str:
    """Deterministic recompute: derive status_flag from dispatch history and
    write it to the DB via the reliability_tier column (repurposed — see module
    docstring). Returns the computed status_flag string."""
    hist = _dispatch_history(responder_id)
    status_flag = _status_flag_for(hist)
    _write_status_flag_db(responder_id, status_flag)
    return status_flag
