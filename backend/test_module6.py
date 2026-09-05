# -*- coding: utf-8 -*-
"""Module 6 test suite — 8 scenarios: outcome confirmation, responder
release, and full-lifecycle incident history.

Run with:
    cd "d:\\LifeLine Ride"
    python backend\\test_module6.py

All tests run with zero network calls (offline-resilient design verification).
The HEADLINE test is T1: the full responder-release loop that closes Module 3's
documented gap — dispatch (Module 3) -> close with confirmed outcome (Module 6)
-> responder available again -> successfully matched to a NEW incident
(Module 3 again).
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

# ---------------------------------------------------------------------------
# Path setup — mirror what dispatch_service.py and test_module3.py do.
# ---------------------------------------------------------------------------
_BACKEND_DIR = Path(__file__).resolve().parent
if str(_BACKEND_DIR) not in [str(p) for p in sys.path]:
    sys.path.insert(0, str(_BACKEND_DIR))

# ---------------------------------------------------------------------------
# Keep ack timers well out of the way — Module 6 tests never need the
# fallback walker, and a late timer must not mutate availability mid-test.
# Set BEFORE importing dispatch_service.
# ---------------------------------------------------------------------------
os.environ["DISPATCH_ACK_TIMEOUT_S"] = "300"

# Same fast-fail discipline as test_module3.py (no AI retry stalls).
os.environ["LIFELINE_REPLAY_MODE"] = "1"

import slice_runner  # noqa: E402  Module 1 contracts + seed data + store
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
)

# Module 2 integration (escalation path) — optional, same pattern as T7 there.
try:
    _SERVICES_DIR = _BACKEND_DIR / "services"
    if str(_SERVICES_DIR) not in [str(p) for p in sys.path]:
        sys.path.insert(0, str(_SERVICES_DIR))
    from help_bot_service import escalateIncident, register_incident  # noqa: E402
    import help_bot_service as _hb_mod  # noqa: E402
    _HB_AVAILABLE = True
except ImportError:
    _HB_AVAILABLE = False


# ===========================================================================
# TEST INFRASTRUCTURE — same hand-rolled harness as test_module3.py
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

def _reset_seed_data() -> None:
    """Restore seed availability, clear dispatch state, incident store, and
    Module 2's active-incident registry so tests don't bleed into each other."""
    _original_availability = {
        "RESP-01": "busy",
        "RESP-02": "available",
        "RESP-03": "offline",
        "RESP-04": "busy",
        "RESP-05": "available",
    }
    for r in slice_runner.SEED_RESPONDERS:
        r.current_availability_status = _original_availability[r.responder_id]
    with _STATE_LOCK:
        _DISPATCH_STATE.clear()
    slice_runner.INCIDENT_STORE.clear()
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
        incident_id=f"INC-M6-{uuid.uuid4().hex[:6].upper()}",
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
    """Module 3's full pipeline + Module 1's logIncident store registration
    (same registration pattern as test_module3.py's T7)."""
    decision = dispatchIncident(incident)
    status_map = {
        "dispatched": "dispatched",
        "escalated_bhu_only": "escalated_bhu_only",
        "no_resources": "no_responders_available",
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
# TEST 1 — HEADLINE: the full responder-release loop (Module 3's gap closed)
# ===========================================================================

def test_t1_end_to_end_release_loop():
    _sep("T1 — END-TO-END: dispatch -> close w/ outcome -> released -> re-matched")
    _reset_seed_data()
    farhan = _responder("RESP-02")

    # --- Step 1: Module 3 dispatches the only available VILLAGE-A responder ---
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
    _assert(
        farhan.current_availability_status == "busy",
        "T1.2 RESP-02 marked busy by Module 3",
        "availability=busy",
        f"expected busy, got {farhan.current_availability_status}",
    )

    # --- Step 2: Module 6 closes the incident with a confirmed outcome ---
    snapshot = closeIncident(inc1.incident_id, "taken_to_bhu", "bhu_staff")
    _assert(
        snapshot["outcome"] == "taken_to_bhu"
        and snapshot["outcome_confirmed_by"] == "bhu_staff"
        and snapshot["incident_closed_timestamp"] is not None,
        "T1.3 incident closed with confirmed outcome",
        f"outcome={snapshot['outcome']} confirmed_by={snapshot['outcome_confirmed_by']} "
        f"closed_at={snapshot['incident_closed_timestamp']}",
        "closure fields not set on the incident snapshot",
    )
    _assert(
        farhan.current_availability_status == "available",
        "T1.4 RESP-02 released back to available (Module 3 gap closed)",
        "availability=available",
        f"expected available, got {farhan.current_availability_status}",
    )
    closed_events = [
        e for e in inc1.dispatch_events if e["event"] == "incident_closed"
    ]
    _assert(
        len(closed_events) == 1
        and closed_events[0]["responder_released"] == "RESP-02",
        "T1.5 incident_closed event on unified timeline (responder_released=RESP-02)",
        f"event={closed_events[0] if closed_events else None}",
        "no incident_closed event with responder_released in dispatch_events",
    )

    # --- Step 3: a NEW incident in the same village matches RESP-02 AGAIN ---
    inc2 = _make_incident("VILLAGE-A", "moderate", flags=["fracture"])
    decision2 = decideDispatch(inc2)
    _assert(
        decision2.status == "dispatched"
        and decision2.selected_responder is not None
        and decision2.selected_responder.responder_id == "RESP-02",
        "T1.6 released responder matched to a NEW incident (full loop proven)",
        f"status={decision2.status} selected=RESP-02",
        f"expected dispatched/RESP-02, got {decision2.status}/"
        f"{decision2.selected_responder.responder_id if decision2.selected_responder else None}",
    )
    sendNotification(decision2, inc2)
    closeIncident(inc2.incident_id, "self-resolved", "responder")  # hygiene


# ===========================================================================
# TEST 2 — Pool-exhaustion guard: closure keeps a one-responder village alive
# ===========================================================================

def test_t2_pool_exhaustion_guard():
    _sep("T2 — Without closure the pool exhausts; with closure the same responder serves again")
    _reset_seed_data()

    # Incident 1 occupies VILLAGE-A's only available responder.
    inc1 = _make_incident("VILLAGE-A", "moderate")
    _dispatch_and_log(inc1)

    # Incident 2 while inc1 is still OPEN: no responders left -> BHU-only.
    inc2 = _make_incident("VILLAGE-A", "moderate")
    decision_open = decideDispatch(inc2)
    _assert(
        decision_open.status == "escalated_bhu_only",
        "T2.1 open incident exhausts pool -> escalated_bhu_only",
        f"status={decision_open.status}",
        f"expected escalated_bhu_only, got {decision_open.status}",
    )

    # Close incident 1 -> responder released -> incident 3 dispatches normally.
    closeIncident(inc1.incident_id, "self-resolved", "responder")
    inc3 = _make_incident("VILLAGE-A", "moderate")
    decision_closed = decideDispatch(inc3)
    _assert(
        decision_closed.status == "dispatched"
        and decision_closed.selected_responder is not None
        and decision_closed.selected_responder.responder_id == "RESP-02",
        "T2.2 after closure the same village dispatches again",
        f"status={decision_closed.status} selected=RESP-02",
        f"expected dispatched/RESP-02, got {decision_closed.status}/"
        f"{decision_closed.selected_responder.responder_id if decision_closed.selected_responder else None}",
    )
    sendNotification(decision_closed, inc3)
    closeIncident(inc3.incident_id, "self-resolved", "responder")  # hygiene


# ===========================================================================
# TEST 3 — Accountability: closure without confirmation is refused
# ===========================================================================

def test_t3_unconfirmed_closure_refused():
    _sep("T3 — closeIncident refuses missing/empty confirmation (incident stays open)")
    _reset_seed_data()
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

    record = getIncidentRecord(inc.incident_id)
    inc_data = record["incident"]
    _assert(
        inc_data["outcome"] is None
        and inc_data["outcome_confirmed_by"] is None
        and inc_data["incident_closed_timestamp"] is None,
        "T3.2 incident remains fully open after refusals",
        "outcome/confirmed_by/closed_timestamp all None",
        f"incident mutated despite refusal: {inc_data['outcome']}/"
        f"{inc_data['outcome_confirmed_by']}/{inc_data['incident_closed_timestamp']}",
    )
    _assert(
        farhan.current_availability_status == "busy",
        "T3.3 responder stays busy while incident is open",
        "availability=busy",
        f"expected busy, got {farhan.current_availability_status}",
    )
    closeIncident(inc.incident_id, "self-resolved", "responder")  # hygiene


# ===========================================================================
# TEST 4 — Validation: invalid outcome + double-close both rejected
# ===========================================================================

def test_t4_invalid_outcome_and_double_close():
    _sep("T4 — invalid outcome rejected; closed records are immutable (no re-close)")
    _reset_seed_data()

    inc = _make_incident("VILLAGE-A", "moderate")
    _dispatch_and_log(inc)

    try:
        closeIncident(inc.incident_id, "healed_at_home", "bhu_staff")
        _fail("T4.1 invalid outcome rejected", "no ValueError for outcome='healed_at_home'")
    except ValueError as exc:
        print(f"  [EXPECTED] {exc}")
        _pass("T4.1 invalid outcome rejected", "ValueError raised, incident untouched")

    closeIncident(inc.incident_id, "unresolved", "bhu_staff")
    try:
        closeIncident(inc.incident_id, "taken_to_bhu", "bhu_staff")
        _fail("T4.2 double-close rejected", "second closeIncident succeeded")
    except ValueError as exc:
        print(f"  [EXPECTED] {exc}")
        record = getIncidentRecord(inc.incident_id)["incident"]
        _assert(
            record["outcome"] == "unresolved",
            "T4.2 double-close rejected; original closure intact",
            "outcome still 'unresolved'",
            f"original closure overwritten: outcome={record['outcome']}",
        )

    try:
        closeIncident("INC-M6-DOES-NOT-EXIST", "self-resolved", "responder")
        _fail("T4.3 unknown incident rejected", "no ValueError for unknown incident_id")
    except ValueError as exc:
        print(f"  [EXPECTED] {exc}")
        _pass("T4.3 unknown incident rejected", "ValueError raised")


# ===========================================================================
# TEST 5 — Module 2 connectivity: help_bot_transitions attached & queryable
# ===========================================================================

def test_t5_help_bot_transitions_connected():
    _sep("T5 — help_bot_transitions live ON the incident record and are queryable")
    _reset_seed_data()

    inc = _make_incident("VILLAGE-A", "critical", flags=["heavy_bleeding"])
    _dispatch_and_log(inc)

    # Simulate the help-bot session appending transitions with Module 2's
    # uniform entry shape (branch entered + step started).
    from datetime import datetime, timezone
    for from_state, to_state, trigger in (
        ("initial_guidance", "ongoing_monitor", "branch_entered"),
        ("ongoing_monitor", "ongoing_monitor", "step_started"),
    ):
        inc.help_bot_transitions.append({
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "branch": "heavy_bleeding",
            "from_state": from_state,
            "to_state": to_state,
            "trigger_type": trigger,
            "detail": "module6 test fixture",
        })

    closeIncident(inc.incident_id, "taken_to_bhu", "bhu_staff")

    transitions = getIncidentTransitions(inc.incident_id)
    _assert(
        len(transitions) == 2
        and transitions[0]["trigger_type"] == "branch_entered",
        "T5.1 getIncidentTransitions returns Module 2's trace after closure",
        f"transitions={len(transitions)}",
        f"expected 2 transitions, got {len(transitions)}",
    )
    record = getIncidentRecord(inc.incident_id)
    _assert(
        len(record["incident"]["help_bot_transitions"]) == 2,
        "T5.2 store record carries help_bot_transitions (not a disconnected log)",
        "store.help_bot_transitions=2 entries",
        "help_bot_transitions missing from the INCIDENT_STORE record",
    )


# ===========================================================================
# TEST 6 — Full lifecycle: dispatch + escalation + closure in ONE record
# ===========================================================================

def test_t6_full_lifecycle_record():
    _sep("T6 — one record carries dispatch, escalation, and closure traces")
    _reset_seed_data()

    # Minor incident in VILLAGE-C -> RESP-05, no BHU, no ambulance.
    inc = _make_incident("VILLAGE-C", "minor", flags=["abrasion"])
    decision = _dispatch_and_log(inc)

    # Escalation through the real Module 2 -> Module 3 wiring (same as T7
    # in test_module3.py), so help_bot_transitions AND dispatch_events grow.
    if _HB_AVAILABLE:
        register_incident(inc)
        snapshot = escalateIncident(inc.incident_id, {
            "trigger": "breathing_difficulty",
            "suggested_tier": "critical",
            "new_flags": ["breathing_difficulty"],
            "transcript_excerpt": "سانس نہیں آ رہی",
        })
    else:
        print("  [WARN] help_bot_service not importable; simulating escalation snapshot.")
        inc.severity_tier = "critical"
        inc.injury_type_flags.append("breathing_difficulty")
        inc.ambulance_requested = True
        snapshot = inc.model_dump()
    handleEscalation(inc.incident_id, snapshot)

    # Close it — Module 6.
    closeIncident(inc.incident_id, "referred_to_hospital", "bhu_staff")

    record = getIncidentRecord(inc.incident_id)
    inc_data = record["incident"]
    events = [e["event"] for e in inc_data["dispatch_events"]]

    _assert(
        "responder_dispatched" in events
        and "escalation_redispatch_triggered" in events
        and "incident_closed" in events,
        "T6.1 dispatch + escalation + closure all on one event timeline",
        f"events={events}",
        f"missing lifecycle events: {events}",
    )
    _assert(
        inc_data["outcome"] == "referred_to_hospital"
        and inc_data["outcome_confirmed_by"] == "bhu_staff"
        and inc_data["incident_closed_timestamp"] is not None,
        "T6.2 outcome/closure fields present in the record",
        f"outcome={inc_data['outcome']} confirmed_by={inc_data['outcome_confirmed_by']}",
        "outcome fields missing from the lifecycle record",
    )
    _assert(
        len(inc_data["help_bot_transitions"]) >= 1,
        "T6.3 Module 2 escalation transition preserved in the closed record",
        f"help_bot_transitions={len(inc_data['help_bot_transitions'])}",
        "no help_bot_transitions in the closed lifecycle record",
    )


# ===========================================================================
# TEST 7 — Module 5 readiness: "confirmed incidents for responder X" query
# ===========================================================================

def test_t7_confirmed_incidents_query():
    _sep("T7 — getConfirmedIncidentsForResponder: the exact query Module 5 will run")
    _reset_seed_data()

    # Two confirmed closures for RESP-02 (one BHU-verified, one self-reported)
    # plus one still-open incident.
    inc_a = _make_incident("VILLAGE-A", "moderate")
    _dispatch_and_log(inc_a)
    closeIncident(inc_a.incident_id, "taken_to_bhu", "bhu_staff")

    inc_b = _make_incident("VILLAGE-A", "moderate")
    _dispatch_and_log(inc_b)
    closeIncident(inc_b.incident_id, "self-resolved", "responder")

    inc_c = _make_incident("VILLAGE-A", "moderate")
    _dispatch_and_log(inc_c)  # left OPEN on purpose

    confirmed = getConfirmedIncidentsForResponder("RESP-02")
    _assert(
        len(confirmed) == 2,
        "T7.1 exactly the 2 confirmed closures returned (open one excluded)",
        f"count={len(confirmed)}",
        f"expected 2 confirmed incidents, got {len(confirmed)}",
    )
    bhu_only = getConfirmedIncidentsForResponder("RESP-02", confirmed_by="bhu_staff")
    _assert(
        len(bhu_only) == 1
        and bhu_only[0]["incident"]["incident_id"] == inc_a.incident_id,
        "T7.2 confirmed_by='bhu_staff' filter returns only the BHU-verified closure",
        f"count={len(bhu_only)} id={bhu_only[0]['incident']['incident_id'] if bhu_only else None}",
        f"expected exactly {inc_a.incident_id}, got "
        f"{[r['incident']['incident_id'] for r in bhu_only]}",
    )
    _assert(
        getConfirmedIncidentsForResponder("RESP-05") == [],
        "T7.3 responder with no closed incidents gets an empty result",
        "RESP-05 -> []",
        "expected empty list for RESP-05",
    )
    closeIncident(inc_c.incident_id, "unresolved", "responder")  # hygiene


# ===========================================================================
# TEST 8 — exportIncidentHistory writes valid, parseable JSON
# ===========================================================================

def test_t8_export_history():
    _sep("T8 — exportIncidentHistory: store survives as an inspectable JSON artifact")
    _reset_seed_data()

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
            "T8.1 exported JSON parses and mirrors the store",
            f"path={out_path} incidents={payload['incident_count']}",
            "exported JSON missing/mismatched vs INCIDENT_STORE",
        )
    except (json.JSONDecodeError, KeyError, IndexError) as exc:
        _fail("T8.1 exported JSON parses and mirrors the store", repr(exc))


# ===========================================================================
# RUNNER
# ===========================================================================

def main() -> int:
    print("=" * 70)
    print("  MODULE 6 TEST SUITE — Incident & Outcome Tracking")
    print("  (zero network calls — offline-resilient design verification)")
    print("=" * 70)

    test_t1_end_to_end_release_loop()
    test_t2_pool_exhaustion_guard()
    test_t3_unconfirmed_closure_refused()
    test_t4_invalid_outcome_and_double_close()
    test_t5_help_bot_transitions_connected()
    test_t6_full_lifecycle_record()
    test_t7_confirmed_incidents_query()
    test_t8_export_history()

    passed = sum(1 for r in _RESULTS if r[0] == "PASS")
    total = len(_RESULTS)
    print(f"\n{'=' * 70}")
    print(f"  MODULE 6 RESULTS: {passed}/{total} checks passed, {_FAILURES} failures")
    print("=" * 70)
    return 0 if _FAILURES == 0 else 1


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    sys.exit(main())
