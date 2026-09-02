# -*- coding: utf-8 -*-
"""Module 6.5 — Persistence Test Suite.

Replicates all 8 core scenarios from test_module6.py executed against the
live PostgreSQL database, plus a 9th Restart Survival Test that verifies
all nested fields (help_bot_transitions, dispatch_events, gps_location, etc.)
survive a simulated process restart (clear INCIDENT_STORE + rehydrate from DB).

Run with:
    cd "d:\\LifeLine Ride"
    python backend\\test_module6_persistence.py

Prerequisites:
    - DATABASE_URL set in .env (verified by database.py)
    - `python backend/scripts/migrate_seed_data.py` may be run first to
      pre-populate seed data, but is not required for these tests.

Isolation:
    Each test calls _db_reset() which:
        (a) truncates the `incidents` table in PostgreSQL
        (b) clears slice_runner.INCIDENT_STORE
        (c) resets responder availability and dispatch state
    This gives each test a completely clean slate in both stores.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

# ---------------------------------------------------------------------------
# Path setup — mirror test_module6.py exactly.
# ---------------------------------------------------------------------------
_BACKEND_DIR = Path(__file__).resolve().parent
if str(_BACKEND_DIR) not in [str(p) for p in sys.path]:
    sys.path.insert(0, str(_BACKEND_DIR))

# Keep ack timers out of the way (same as test_module6.py).
os.environ["DISPATCH_ACK_TIMEOUT_S"] = "300"
os.environ["LIFELINE_REPLAY_MODE"]   = "1"

import slice_runner  # noqa: E402
from services.dispatch_service import (  # noqa: E402
    _DISPATCH_STATE,
    _STATE_LOCK,
    decideDispatch,
    dispatchIncident,
    handleEscalation,
    sendNotification,
)
from services.incident_lifecycle_service import (  # noqa: E402
    closeIncident,
    exportIncidentHistory,
    getConfirmedIncidentsForResponder,
    getIncidentRecord,
    getIncidentTransitions,
    rehydrate_store_from_db,
)
from models.incident_model import truncate_incidents_table  # noqa: E402

# Module 2 integration (same optional import pattern as test_module6.py).
try:
    _SERVICES_DIR = _BACKEND_DIR / "services"
    if str(_SERVICES_DIR) not in [str(p) for p in sys.path]:
        sys.path.insert(0, str(_SERVICES_DIR))
    from help_bot_service import escalateIncident, register_incident  # noqa
    import help_bot_service as _hb_mod  # noqa
    _HB_AVAILABLE = True
except ImportError:
    _HB_AVAILABLE = False


# ===========================================================================
# TEST INFRASTRUCTURE — same hand-rolled harness as test_module3/6
# ===========================================================================

_RESULTS: list = []
_FAILURES: int = 0


def _sep(title: str) -> None:
    print(f"\n{'=' * 70}")
    print(f"  {title}")
    print("=" * 70)


def _pass(test_name: str, detail: str = "") -> None:
    global _RESULTS
    _RESULTS.append(("PASS", test_name, detail))
    label = f"  [PASS] {test_name}"
    print(f"{label}  {detail}" if detail else label)


def _fail(test_name: str, reason: str) -> None:
    global _RESULTS, _FAILURES
    _FAILURES += 1
    _RESULTS.append(("FAIL", test_name, reason))
    print(f"  [FAIL] {test_name}  REASON: {reason}")


def _assert(condition: bool, test_name: str, pass_detail: str, fail_reason: str) -> bool:
    if condition:
        _pass(test_name, pass_detail)
        return True
    else:
        _fail(test_name, fail_reason)
        return False


# ---------------------------------------------------------------------------
# Fixture helpers
# ---------------------------------------------------------------------------

_original_availability = {
    "RESP-01": "busy",
    "RESP-02": "available",
    "RESP-03": "offline",
    "RESP-04": "busy",
    "RESP-05": "available",
}


def _db_reset() -> None:
    """Full isolation reset: truncate DB table, clear in-memory store,
    reset responder availability and dispatch state."""
    truncate_incidents_table()
    slice_runner.INCIDENT_STORE.clear()
    for r in slice_runner.SEED_RESPONDERS:
        r.current_availability_status = _original_availability[r.responder_id]
    with _STATE_LOCK:
        _DISPATCH_STATE.clear()
    if _HB_AVAILABLE:
        _hb_mod._ACTIVE_INCIDENTS.clear()


def _make_incident(
    village_id: str,
    tier: str,
    flags: list | None = None,
) -> slice_runner.Incident:
    import uuid
    from datetime import datetime, timezone
    return slice_runner.Incident(
        incident_id=f"INC-P6-{uuid.uuid4().hex[:6].upper()}",
        timestamp_reported=datetime.now(timezone.utc).isoformat(),
        reporter_id="REP-TEST",
        gps_location=slice_runner.GPSLocation(
            latitude=31.5204,
            longitude=74.3587,
            village_id=village_id,
        ),
        photo_ref="test_photo.jpg",
        voice_transcript="test transcript",
        severity_tier=tier,
        injury_type_flags=flags or ["test_flag"],
    )


def _responder(responder_id: str) -> slice_runner.Responder:
    return next(r for r in slice_runner.SEED_RESPONDERS if r.responder_id == responder_id)


def _dispatch_and_log(incident: slice_runner.Incident):
    """Module 3 pipeline + Module 1 store registration."""
    decision = dispatchIncident(incident)
    status_map = {
        "dispatched":        "dispatched",
        "escalated_bhu_only": "escalated_bhu_only",
        "no_resources":      "no_responders_available",
    }
    result = slice_runner.DispatchResult(
        incident_id=incident.incident_id,
        responder=decision.selected_responder,
        bhu=decision.bhu,
        ambulance_requested=decision.ambulance_requested,
        status=status_map[decision.status],
    )
    slice_runner.logIncident(incident, result)
    return decision


# ===========================================================================
# T1 — END-TO-END: dispatch -> close -> DB persisted -> responder released
# ===========================================================================

def test_t1_end_to_end_release_loop():
    _sep("T1 — END-TO-END: dispatch -> close (DB write-through) -> release -> re-match")
    _db_reset()
    farhan = _responder("RESP-02")

    inc1 = _make_incident("VILLAGE-A", "moderate", flags=["heavy_bleeding"])
    decision1 = _dispatch_and_log(inc1)
    _assert(
        decision1.selected_responder is not None
        and decision1.selected_responder.responder_id == "RESP-02",
        "T1.1 Module 3 dispatched RESP-02",
        f"selected={decision1.selected_responder.responder_id}",
        f"expected RESP-02, got "
        f"{decision1.selected_responder.responder_id if decision1.selected_responder else None}",
    )

    snapshot = closeIncident(inc1.incident_id, "taken_to_bhu", "bhu_staff")
    _assert(
        snapshot["outcome"] == "taken_to_bhu"
        and snapshot["outcome_confirmed_by"] == "bhu_staff"
        and snapshot["incident_closed_timestamp"] is not None,
        "T1.2 incident closed with confirmed outcome",
        f"outcome={snapshot['outcome']} confirmed_by={snapshot['outcome_confirmed_by']}",
        "closure fields not set on the incident snapshot",
    )
    _assert(
        farhan.current_availability_status == "available",
        "T1.3 RESP-02 released back to available",
        "availability=available",
        f"expected available, got {farhan.current_availability_status}",
    )

    # Verify DB persisted the closure.
    db_rec = getIncidentRecord(inc1.incident_id)
    _assert(
        db_rec is not None
        and db_rec["incident"]["outcome"] == "taken_to_bhu"
        and db_rec["incident"]["outcome_confirmed_by"] == "bhu_staff"
        and db_rec["incident"]["incident_closed_timestamp"] is not None,
        "T1.4 PostgreSQL persisted: outcome + confirmed_by + closed_timestamp",
        f"outcome={db_rec['incident']['outcome'] if db_rec else None}",
        "DB record missing or closure fields absent",
    )

    # Re-match — same as test_module6.py T1.6.
    inc2 = _make_incident("VILLAGE-A", "moderate", flags=["fracture"])
    decision2 = decideDispatch(inc2)
    _assert(
        decision2.status == "dispatched"
        and decision2.selected_responder is not None
        and decision2.selected_responder.responder_id == "RESP-02",
        "T1.5 released responder matched to new incident (full loop proven)",
        f"status={decision2.status} selected=RESP-02",
        f"expected dispatched/RESP-02, got {decision2.status}/"
        f"{decision2.selected_responder.responder_id if decision2.selected_responder else None}",
    )
    sendNotification(decision2, inc2)
    closeIncident(inc2.incident_id, "self-resolved", "responder")


# ===========================================================================
# T2 — Pool exhaustion guard (same logic as test_module6.py T2)
# ===========================================================================

def test_t2_pool_exhaustion_guard():
    _sep("T2 — Pool exhaustion: closure releases responder for next incident (persisted)")
    _db_reset()

    inc1 = _make_incident("VILLAGE-A", "moderate")
    _dispatch_and_log(inc1)

    inc2 = _make_incident("VILLAGE-A", "moderate")
    decision_open = decideDispatch(inc2)
    _assert(
        decision_open.status == "escalated_bhu_only",
        "T2.1 open incident exhausts pool -> escalated_bhu_only",
        f"status={decision_open.status}",
        f"expected escalated_bhu_only, got {decision_open.status}",
    )

    closeIncident(inc1.incident_id, "self-resolved", "responder")

    # Confirm DB reflects the closure.
    db_rec = getIncidentRecord(inc1.incident_id)
    _assert(
        db_rec is not None
        and db_rec["incident"]["outcome"] == "self-resolved",
        "T2.2 DB confirms closure of inc1",
        "outcome=self-resolved in DB",
        "DB record missing or outcome wrong",
    )

    inc3 = _make_incident("VILLAGE-A", "moderate")
    decision_closed = decideDispatch(inc3)
    _assert(
        decision_closed.status == "dispatched"
        and decision_closed.selected_responder is not None
        and decision_closed.selected_responder.responder_id == "RESP-02",
        "T2.3 after closure village dispatches again",
        f"status={decision_closed.status} selected=RESP-02",
        f"expected dispatched/RESP-02, got {decision_closed.status}/"
        f"{decision_closed.selected_responder.responder_id if decision_closed.selected_responder else None}",
    )
    sendNotification(decision_closed, inc3)
    closeIncident(inc3.incident_id, "self-resolved", "responder")


# ===========================================================================
# T3 — Unconfirmed closure refused; incident stays open in DB
# ===========================================================================

def test_t3_unconfirmed_closure_refused():
    _sep("T3 — Unconfirmed closure refused; DB record shows incident still open")
    _db_reset()
    farhan = _responder("RESP-02")

    inc = _make_incident("VILLAGE-A", "moderate")
    _dispatch_and_log(inc)

    refused = 0
    for bad_confirmed_by in (None, "", "anonymous_caller"):
        try:
            closeIncident(inc.incident_id, "self-resolved", bad_confirmed_by)
        except ValueError as exc:
            refused += 1
            print(f"  [EXPECTED] refused confirmed_by={bad_confirmed_by!r}: {exc}")
    _assert(
        refused == 3,
        "T3.1 all 3 unconfirmed closure attempts refused",
        f"refused={refused}/3",
        f"expected 3 refusals, got {refused}",
    )

    # The incident has NOT been persisted to DB (no successful closeIncident).
    db_rec = getIncidentRecord(inc.incident_id)
    # It should be found via in-memory fallback (not yet in DB).
    inc_data = db_rec["incident"] if db_rec else None
    _assert(
        inc_data is not None
        and inc_data["outcome"] is None
        and inc_data["outcome_confirmed_by"] is None
        and inc_data["incident_closed_timestamp"] is None,
        "T3.2 incident remains open after refusals (outcome/confirmed_by/closed_ts all None)",
        "outcome/confirmed_by/closed_ts all None",
        f"incident mutated despite refusal: {inc_data}",
    )
    _assert(
        farhan.current_availability_status == "busy",
        "T3.3 responder stays busy while incident is open",
        "availability=busy",
        f"expected busy, got {farhan.current_availability_status}",
    )
    closeIncident(inc.incident_id, "self-resolved", "responder")


# ===========================================================================
# T4 — Invalid outcome + double-close both rejected (DB immutability)
# ===========================================================================

def test_t4_invalid_outcome_and_double_close():
    _sep("T4 — Invalid outcome rejected; closed DB records are immutable (no re-close)")
    _db_reset()

    inc = _make_incident("VILLAGE-A", "moderate")
    _dispatch_and_log(inc)

    try:
        closeIncident(inc.incident_id, "healed_at_home", "bhu_staff")
        _fail("T4.1 invalid outcome rejected", "no ValueError for outcome='healed_at_home'")
    except ValueError as exc:
        print(f"  [EXPECTED] {exc}")
        _pass("T4.1 invalid outcome rejected", "ValueError raised, incident untouched")

    closeIncident(inc.incident_id, "unresolved", "bhu_staff")

    # Verify first close is in DB.
    db_rec = getIncidentRecord(inc.incident_id)
    _assert(
        db_rec is not None and db_rec["incident"]["outcome"] == "unresolved",
        "T4.2 first closure persisted to DB as 'unresolved'",
        "outcome=unresolved in DB",
        f"DB record: {db_rec['incident']['outcome'] if db_rec else None}",
    )

    # Double-close attempt must be rejected.
    try:
        closeIncident(inc.incident_id, "taken_to_bhu", "bhu_staff")
        _fail("T4.3 double-close rejected", "second closeIncident succeeded")
    except ValueError as exc:
        print(f"  [EXPECTED] {exc}")
        # DB must still show the original outcome.
        db_rec2 = getIncidentRecord(inc.incident_id)
        _assert(
            db_rec2 is not None and db_rec2["incident"]["outcome"] == "unresolved",
            "T4.3 double-close rejected; DB outcome still 'unresolved'",
            "outcome still 'unresolved' in DB",
            f"DB overwritten: outcome={db_rec2['incident']['outcome'] if db_rec2 else None}",
        )

    try:
        closeIncident("INC-P6-DOES-NOT-EXIST", "self-resolved", "responder")
        _fail("T4.4 unknown incident rejected", "no ValueError for unknown incident_id")
    except ValueError as exc:
        print(f"  [EXPECTED] {exc}")
        _pass("T4.4 unknown incident rejected", "ValueError raised")


# ===========================================================================
# T5 — help_bot_transitions persisted to DB
# ===========================================================================

def test_t5_help_bot_transitions_persisted():
    _sep("T5 — help_bot_transitions live ON the incident record and survive in DB")
    _db_reset()

    inc = _make_incident("VILLAGE-A", "critical", flags=["heavy_bleeding"])
    _dispatch_and_log(inc)

    from datetime import datetime, timezone
    for from_state, to_state, trigger in (
        ("initial_guidance", "ongoing_monitor", "branch_entered"),
        ("ongoing_monitor",  "ongoing_monitor", "step_started"),
    ):
        inc.help_bot_transitions.append({
            "timestamp":    datetime.now(timezone.utc).isoformat(),
            "branch":       "heavy_bleeding",
            "from_state":   from_state,
            "to_state":     to_state,
            "trigger_type": trigger,
            "detail":       "module6.5 persistence test fixture",
        })

    closeIncident(inc.incident_id, "taken_to_bhu", "bhu_staff")

    db_rec = getIncidentRecord(inc.incident_id)
    _assert(
        db_rec is not None
        and len(db_rec["incident"]["help_bot_transitions"]) == 2
        and db_rec["incident"]["help_bot_transitions"][0]["trigger_type"] == "branch_entered",
        "T5.1 help_bot_transitions (2 entries) persisted and retrieved from DB",
        f"transitions={len(db_rec['incident']['help_bot_transitions']) if db_rec else 0}",
        "help_bot_transitions missing or wrong count in DB record",
    )


# ===========================================================================
# T6 — Full lifecycle record in DB: dispatch + escalation + closure
# ===========================================================================

def test_t6_full_lifecycle_record_in_db():
    _sep("T6 — DB record carries dispatch + escalation + closure traces")
    _db_reset()

    inc = _make_incident("VILLAGE-C", "minor", flags=["abrasion"])
    decision = _dispatch_and_log(inc)

    if _HB_AVAILABLE:
        register_incident(inc)
        snapshot = escalateIncident(inc.incident_id, {
            "trigger":          "breathing_difficulty",
            "suggested_tier":   "critical",
            "new_flags":        ["breathing_difficulty"],
            "transcript_excerpt": "سانس نہیں آ رہی",
        })
    else:
        print("  [WARN] help_bot_service not importable; simulating escalation snapshot.")
        inc.severity_tier = "critical"
        inc.injury_type_flags.append("breathing_difficulty")
        inc.ambulance_requested = True
        snapshot = inc.model_dump()
    handleEscalation(inc.incident_id, snapshot)

    closeIncident(inc.incident_id, "referred_to_hospital", "bhu_staff")

    db_rec = getIncidentRecord(inc.incident_id)
    inc_data = db_rec["incident"] if db_rec else {}
    events = [e["event"] for e in inc_data.get("dispatch_events", [])]

    _assert(
        "responder_dispatched" in events
        and "escalation_redispatch_triggered" in events
        and "incident_closed" in events,
        "T6.1 dispatch + escalation + closure all on one DB event timeline",
        f"events={events}",
        f"missing lifecycle events in DB: {events}",
    )
    _assert(
        inc_data.get("outcome") == "referred_to_hospital"
        and inc_data.get("outcome_confirmed_by") == "bhu_staff"
        and inc_data.get("incident_closed_timestamp") is not None,
        "T6.2 outcome/closure fields present in DB record",
        f"outcome={inc_data.get('outcome')} confirmed_by={inc_data.get('outcome_confirmed_by')}",
        "outcome fields missing from DB record",
    )
    _assert(
        len(inc_data.get("help_bot_transitions", [])) >= 1,
        "T6.3 Module 2 escalation transition preserved in DB closed record",
        f"help_bot_transitions={len(inc_data.get('help_bot_transitions', []))}",
        "no help_bot_transitions in DB record",
    )


# ===========================================================================
# T7 — getConfirmedIncidentsForResponder queries PostgreSQL (indexed)
# ===========================================================================

def test_t7_confirmed_incidents_query_from_db():
    _sep("T7 — getConfirmedIncidentsForResponder: indexed DB query (Module 5 readiness)")
    _db_reset()

    inc_a = _make_incident("VILLAGE-A", "moderate")
    _dispatch_and_log(inc_a)
    closeIncident(inc_a.incident_id, "taken_to_bhu", "bhu_staff")

    inc_b = _make_incident("VILLAGE-A", "moderate")
    _dispatch_and_log(inc_b)
    closeIncident(inc_b.incident_id, "self-resolved", "responder")

    inc_c = _make_incident("VILLAGE-A", "moderate")
    _dispatch_and_log(inc_c)  # left OPEN

    confirmed = getConfirmedIncidentsForResponder("RESP-02")
    _assert(
        len(confirmed) == 2,
        "T7.1 exactly 2 confirmed closures returned from DB (open one excluded)",
        f"count={len(confirmed)}",
        f"expected 2, got {len(confirmed)}",
    )

    bhu_only = getConfirmedIncidentsForResponder("RESP-02", confirmed_by="bhu_staff")
    _assert(
        len(bhu_only) == 1
        and bhu_only[0]["incident"]["incident_id"] == inc_a.incident_id,
        "T7.2 confirmed_by='bhu_staff' DB filter returns only BHU-verified closure",
        f"count={len(bhu_only)} id={bhu_only[0]['incident']['incident_id'] if bhu_only else None}",
        f"expected {inc_a.incident_id}, got "
        f"{[r['incident']['incident_id'] for r in bhu_only]}",
    )
    _assert(
        getConfirmedIncidentsForResponder("RESP-05") == [],
        "T7.3 responder with no closed incidents -> empty result from DB",
        "RESP-05 -> []",
        "expected empty list for RESP-05",
    )
    closeIncident(inc_c.incident_id, "unresolved", "responder")


# ===========================================================================
# T8 — exportIncidentHistory still works alongside DB persistence
# ===========================================================================

def test_t8_export_history_alongside_db():
    _sep("T8 — exportIncidentHistory: JSON artifact works alongside DB persistence")
    _db_reset()

    inc = _make_incident("VILLAGE-A", "moderate")
    _dispatch_and_log(inc)
    closeIncident(inc.incident_id, "taken_to_bhu", "bhu_staff")

    out_path = exportIncidentHistory()
    try:
        payload = json.loads(out_path.read_text(encoding="utf-8"))
        ok = (
            payload["incident_count"] == len(slice_runner.INCIDENT_STORE)
            and len(payload["records"]) == payload["incident_count"]
            and payload["records"][0]["incident"]["incident_id"] == inc.incident_id
        )
        _assert(
            ok,
            "T8.1 exported JSON parses and mirrors the in-memory store",
            f"path={out_path} incidents={payload['incident_count']}",
            "exported JSON missing/mismatched vs INCIDENT_STORE",
        )
    except (json.JSONDecodeError, KeyError, IndexError) as exc:
        _fail("T8.1 exported JSON parses and mirrors the in-memory store", repr(exc))

    # Verify DB record also exists.
    db_rec = getIncidentRecord(inc.incident_id)
    _assert(
        db_rec is not None and db_rec["incident"]["outcome"] == "taken_to_bhu",
        "T8.2 DB record also present after export (both stores in sync)",
        "DB record found with correct outcome",
        "DB record missing after export",
    )


# ===========================================================================
# T9 — RESTART SURVIVAL TEST (the new Module 6.5 check)
# ===========================================================================

def test_t9_restart_survival():
    _sep("T9 — RESTART SURVIVAL: incident survives in-memory wipe + DB rehydration")
    _db_reset()

    from datetime import datetime, timezone

    # --- Step 1: create and close a richly-populated incident ---
    inc = _make_incident("VILLAGE-A", "critical", flags=["heavy_bleeding", "fracture"])
    _dispatch_and_log(inc)

    # Append help_bot_transitions to make the nested field non-trivial.
    for i in range(3):
        inc.help_bot_transitions.append({
            "timestamp":    datetime.now(timezone.utc).isoformat(),
            "branch":       "heavy_bleeding",
            "from_state":   f"state_{i}",
            "to_state":     f"state_{i+1}",
            "trigger_type": "step_started",
            "detail":       f"restart-survival step {i}",
        })

    original_id = inc.incident_id
    closeIncident(original_id, "referred_to_hospital", "bhu_staff")

    # Verify it landed in DB before the restart simulation.
    pre_reset_rec = getIncidentRecord(original_id)
    _assert(
        pre_reset_rec is not None
        and pre_reset_rec["incident"]["outcome"] == "referred_to_hospital",
        "T9.1 incident persisted to DB before simulated restart",
        f"incident_id={original_id} in DB with correct outcome",
        "DB record missing before restart simulation",
    )

    # --- Step 2: simulate process restart (clear in-memory store) ---
    slice_runner.INCIDENT_STORE.clear()
    _assert(
        len(slice_runner.INCIDENT_STORE) == 0,
        "T9.2 INCIDENT_STORE cleared (restart simulated)",
        "store is empty",
        "INCIDENT_STORE not cleared",
    )

    # --- Step 3: rehydrate from DB ---
    loaded = rehydrate_store_from_db()
    _assert(
        loaded >= 1,
        "T9.3 rehydrate_store_from_db() loaded at least 1 record",
        f"loaded={loaded}",
        f"expected >= 1, got {loaded}",
    )

    # --- Step 4: retrieve and verify all nested fields ---
    post_rec = getIncidentRecord(original_id)
    _assert(
        post_rec is not None,
        "T9.4 getIncidentRecord() finds the incident post-restart",
        f"incident_id={original_id} found",
        "incident not found post-restart",
    )

    if post_rec:
        inc_data = post_rec["incident"]

        _assert(
            inc_data.get("outcome") == "referred_to_hospital"
            and inc_data.get("outcome_confirmed_by") == "bhu_staff"
            and inc_data.get("incident_closed_timestamp") is not None,
            "T9.5 outcome / outcome_confirmed_by / incident_closed_timestamp intact",
            f"outcome={inc_data.get('outcome')} "
            f"confirmed_by={inc_data.get('outcome_confirmed_by')}",
            "closure fields corrupted or missing post-restart",
        )

        _assert(
            len(inc_data.get("help_bot_transitions", [])) == 3
            and inc_data["help_bot_transitions"][0]["trigger_type"] == "step_started",
            "T9.6 help_bot_transitions (3 entries) intact post-restart",
            f"transitions={len(inc_data.get('help_bot_transitions', []))}",
            "help_bot_transitions missing or wrong count post-restart",
        )

        closed_events = [
            e for e in inc_data.get("dispatch_events", [])
            if e.get("event") == "incident_closed"
        ]
        _assert(
            len(closed_events) == 1
            and closed_events[0].get("confirmed_by") == "bhu_staff",
            "T9.7 dispatch_events (including incident_closed) intact post-restart",
            f"incident_closed event found: {closed_events[0] if closed_events else None}",
            "dispatch_events corrupted or incident_closed event missing",
        )

        gps = inc_data.get("gps_location", {})
        _assert(
            gps.get("village_id") == "VILLAGE-A"
            and gps.get("latitude") is not None
            and gps.get("longitude") is not None,
            "T9.8 gps_location (latitude/longitude/village_id) intact post-restart",
            f"village_id={gps.get('village_id')} "
            f"lat={gps.get('latitude')} lon={gps.get('longitude')}",
            f"gps_location corrupted post-restart: {gps}",
        )

        _assert(
            inc_data.get("injury_type_flags") == ["heavy_bleeding", "fracture"],
            "T9.9 injury_type_flags (JSONB list) intact post-restart",
            f"flags={inc_data.get('injury_type_flags')}",
            f"injury_type_flags corrupted: {inc_data.get('injury_type_flags')}",
        )


# ===========================================================================
# RUNNER
# ===========================================================================

def main() -> int:
    print("=" * 70)
    print("  MODULE 6.5 PERSISTENCE TEST SUITE")
    print("  (PostgreSQL — 8 lifecycle scenarios + 1 restart survival test)")
    print("=" * 70)

    test_t1_end_to_end_release_loop()
    test_t2_pool_exhaustion_guard()
    test_t3_unconfirmed_closure_refused()
    test_t4_invalid_outcome_and_double_close()
    test_t5_help_bot_transitions_persisted()
    test_t6_full_lifecycle_record_in_db()
    test_t7_confirmed_incidents_query_from_db()
    test_t8_export_history_alongside_db()
    test_t9_restart_survival()

    passed   = sum(1 for r in _RESULTS if r[0] == "PASS")
    total    = len(_RESULTS)
    print(f"\n{'=' * 70}")
    print(f"  MODULE 6.5 RESULTS: {passed}/{total} checks passed, {_FAILURES} failures")
    print("=" * 70)
    return 0 if _FAILURES == 0 else 1


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    sys.exit(main())
