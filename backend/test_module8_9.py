# -*- coding: utf-8 -*-
"""Test suite for Module 8 (Coverage Gaps & Escalation Auditing)
and Module 9 (Localized Reporter Status Updates & Responder Arrival).

Covers:
  - M8.1: Village Coverage Gap Flagging (exhausted/unavailable candidates -> coverage_gap=True & audit event)
  - M8.2: Help-Bot Mid-Incident Escalation Auditing (mid_incident_escalated=True & audit event)
  - M9.1: Sequential Timeline Accumulation across full incident lifecycle
  - M9.2: PostgreSQL Persistence & Rehydration of audit flags and timeline updates
  - M9.3: HTTP Endpoints (POST /responder/arrived & GET /emergency/incident/{id}/timeline)
"""
import os
import sys
import uuid
from pathlib import Path

# Add backend directory to sys.path
_BACKEND_DIR = Path(__file__).resolve().parent
if str(_BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(_BACKEND_DIR))

# Ensure offline replay mode and long ack timeouts for test predictability
os.environ["LIFELINE_REPLAY_MODE"] = "1"
os.environ["DISPATCH_ACK_TIMEOUT_S"] = "600"

import slice_runner
from models import incident_model, responder_model
from services import dispatch_service, help_bot_service, incident_lifecycle_service as lifecycle


# ---------------------------------------------------------------------------
# Test Harness
# ---------------------------------------------------------------------------
_PASSED = 0
_FAILED = 0
_FAILURES = []


def check(name: str, condition: bool, detail: str = ""):
    global _PASSED, _FAILED
    if condition:
        _PASSED += 1
        print(f"  [PASS] {name}  {detail}".rstrip())
    else:
        _FAILED += 1
        msg = f"{name}: {detail}" if detail else name
        _FAILURES.append(msg)
        print(f"  [FAIL] {name}  REASON: {detail}".rstrip())


def reset_test_environment():
    """Reset in-memory state and ensure DB tables are ready."""
    slice_runner.INCIDENT_STORE.clear()
    with dispatch_service._STATE_LOCK:
        for incident_id, state in list(dispatch_service._DISPATCH_STATE.items()):
            timer = state.get("ack_timer")
            if timer:
                timer.cancel()
        dispatch_service._DISPATCH_STATE.clear()

    # Re-seed baseline responders
    responder_model.seed_responders_from_contract()
    for r in slice_runner.SEED_RESPONDERS:
        r.current_availability_status = "available"
        r.is_verified = True
        try:
            responder_model.update_responder_availability(r.responder_id, "available")
        except Exception:
            pass


# ===========================================================================
# Test Cases
# ===========================================================================

def test_m8_1_coverage_gap_flagging():
    print("\n" + "=" * 70)
    print("  M8.1 — Village Coverage Gap Flagging")
    print("=" * 70)
    reset_test_environment()

    # Make all responders in Village A unavailable
    for r in slice_runner.SEED_RESPONDERS:
        if r.village == "VILLAGE-A":
            r.current_availability_status = "busy"

    incident = slice_runner.Incident(
        incident_id=f"INC-GAP-{uuid.uuid4().hex[:6].upper()}",
        timestamp_reported="2026-09-02T17:00:00Z",
        reporter_id="REP-GAP-01",
        gps_location=slice_runner.GPSLocation(latitude=31.5204, longitude=74.3587, village_id="VILLAGE-A"),
        photo_ref="mockdata/media/photos/sample.jpg",
        voice_transcript="Test voice transcript for coverage gap",
        severity_tier="moderate",
        injury_type_flags=["fracture"],
    )
    slice_runner.INCIDENT_STORE.append({"incident": incident.model_dump()})

    decision = dispatch_service.dispatchIncident(incident)

    check(
        "M8.1.1 decision status is escalated_bhu_only",
        decision.status == "escalated_bhu_only",
        f"status={decision.status}",
    )
    check(
        "M8.1.2 incident.coverage_gap is True",
        incident.coverage_gap is True,
        f"coverage_gap={incident.coverage_gap}",
    )
    gap_events = [e for e in incident.dispatch_events if e.get("event") == "coverage_gap_flagged"]
    check(
        "M8.1.3 coverage_gap_flagged event logged in dispatch_events",
        len(gap_events) >= 1,
        f"gap_events_count={len(gap_events)}",
    )
    if gap_events:
        check(
            "M8.1.4 event details correct",
            gap_events[0].get("village_id") == "VILLAGE-A" and gap_events[0].get("reason") == "candidates_exhausted_or_unavailable",
            f"event={gap_events[0]}",
        )


def test_m8_2_mid_incident_escalation_audit():
    print("\n" + "=" * 70)
    print("  M8.2 — Help-Bot Mid-Incident Escalation Auditing")
    print("=" * 70)
    reset_test_environment()

    # Village C has Rashid Minhas available
    incident = slice_runner.Incident(
        incident_id=f"INC-ESC-{uuid.uuid4().hex[:6].upper()}",
        timestamp_reported="2026-09-02T17:05:00Z",
        reporter_id="REP-ESC-01",
        gps_location=slice_runner.GPSLocation(latitude=30.0, longitude=70.0, village_id="VILLAGE-C"),
        photo_ref="mockdata/media/photos/sample.jpg",
        voice_transcript="Minor cut initially",
        severity_tier="minor",
        injury_type_flags=["minor_cut"],
    )
    slice_runner.INCIDENT_STORE.append({"incident": incident.model_dump()})

    decision = dispatch_service.dispatchIncident(incident)
    check(
        "M8.2.1 initial dispatch is minor (no ambulance)",
        decision.status == "dispatched" and decision.ambulance_requested is False,
        f"status={decision.status} ambulance={decision.ambulance_requested}",
    )

    # Trigger help-bot escalation (Module 2)
    snapshot = help_bot_service.escalateIncident(
        incident.incident_id,
        {
            "trigger": "bleeding_not_stopping",
            "suggested_tier": "critical",
            "new_flags": ["heavy_bleeding"],
            "transcript_excerpt": "خون رک نہیں رہا",
        },
    )
    # Trigger dispatch handler (Module 3)
    dispatch_service.handleEscalation(incident.incident_id, snapshot)

    check(
        "M8.2.2 incident.mid_incident_escalated is True",
        incident.mid_incident_escalated is True,
        f"mid_incident_escalated={incident.mid_incident_escalated}",
    )
    check(
        "M8.2.3 severity_tier upgraded to critical",
        incident.severity_tier == "critical",
        f"severity_tier={incident.severity_tier}",
    )
    check(
        "M8.2.4 ambulance_requested is True after critical escalation",
        incident.ambulance_requested is True,
        f"ambulance_requested={incident.ambulance_requested}",
    )
    esc_events = [e for e in incident.dispatch_events if e.get("event") == "mid_incident_escalation"]
    check(
        "M8.2.5 mid_incident_escalation event logged in dispatch_events",
        len(esc_events) >= 1,
        f"esc_events={esc_events}",
    )


def test_m9_1_sequential_timeline_accumulation():
    print("\n" + "=" * 70)
    print("  M9.1 — Sequential Localized Timeline Accumulation")
    print("=" * 70)
    reset_test_environment()

    # Village A dispatch to Farhan Ali
    incident = slice_runner.Incident(
        incident_id=f"INC-TIME-{uuid.uuid4().hex[:6].upper()}",
        timestamp_reported="2026-09-02T17:10:00Z",
        reporter_id="REP-TIME-01",
        gps_location=slice_runner.GPSLocation(latitude=31.5204, longitude=74.3587, village_id="VILLAGE-A"),
        photo_ref="mockdata/media/photos/sample.jpg",
        voice_transcript="Report initial text",
        severity_tier="moderate",
        injury_type_flags=["burn"],
    )
    slice_runner.INCIDENT_STORE.append({"incident": incident.model_dump()})

    # 1. Dispatch
    dispatch_service.dispatchIncident(incident)
    assigned_responder = incident.responder_assigned_id
    check(
        "M9.1.1 assigned responder exists",
        assigned_responder is not None,
        f"responder={assigned_responder}",
    )

    # 2. Responder Acknowledge / Accept
    dispatch_service.acknowledgeDispatch(incident.incident_id, assigned_responder)

    # 3. Responder Arrived
    lifecycle.recordResponderArrival(incident.incident_id, assigned_responder)
    check(
        "M9.1.2 responder_arrived_timestamp is recorded",
        incident.responder_arrived_timestamp is not None,
        f"arrived_at={incident.responder_arrived_timestamp}",
    )

    # 4. Incident Close
    lifecycle.closeIncident(incident.incident_id, outcome="taken_to_bhu", confirmed_by="bhu_staff")

    # Verify Timeline Stages
    stages = [u.get("stage") for u in incident.reporter_updates]
    check(
        "M9.1.3 timeline contains 'reported'",
        "reported" in stages,
        f"stages={stages}",
    )
    check(
        "M9.1.4 timeline contains 'responder_notified'",
        "responder_notified" in stages,
        f"stages={stages}",
    )
    check(
        "M9.1.5 timeline contains 'responder_en_route'",
        "responder_en_route" in stages,
        f"stages={stages}",
    )
    check(
        "M9.1.6 timeline contains 'responder_arrived'",
        "responder_arrived" in stages,
        f"stages={stages}",
    )
    check(
        "M9.1.7 timeline contains 'closed'",
        "closed" in stages,
        f"stages={stages}",
    )

    # Verify all updates have non-empty Urdu text
    all_urdu_valid = all(
        isinstance(u.get("message_urdu"), str) and len(u.get("message_urdu").strip()) > 5
        for u in incident.reporter_updates
    )
    check(
        "M9.1.8 all timeline entries contain valid Urdu text",
        all_urdu_valid,
        f"count={len(incident.reporter_updates)}",
    )


def test_m9_2_persistence_and_rehydration():
    print("\n" + "=" * 70)
    print("  M9.2 — PostgreSQL Persistence & Rehydration")
    print("=" * 70)
    reset_test_environment()

    incident_id = f"INC-PERSIST-{uuid.uuid4().hex[:6].upper()}"
    incident = slice_runner.Incident(
        incident_id=incident_id,
        timestamp_reported="2026-09-02T17:15:00Z",
        reporter_id="REP-PERSIST-01",
        gps_location=slice_runner.GPSLocation(latitude=31.5204, longitude=74.3587, village_id="VILLAGE-A"),
        photo_ref="mockdata/media/photos/sample.jpg",
        voice_transcript="Sample transcript",
        severity_tier="critical",
        injury_type_flags=["crush_injury"],
    )
    slice_runner.INCIDENT_STORE.append({"incident": incident.model_dump()})

    dispatch_service.dispatchIncident(incident)
    assigned_responder = incident.responder_assigned_id
    dispatch_service.acknowledgeDispatch(incident.incident_id, assigned_responder)
    lifecycle.recordResponderArrival(incident.incident_id, assigned_responder)
    lifecycle.closeIncident(incident.incident_id, outcome="self-resolved", confirmed_by="responder")

    # Verify persistent DB write
    db_rec = incident_model.get_incident_from_db(incident_id)
    check(
        "M9.2.1 incident retrieved from PostgreSQL",
        db_rec is not None,
        f"incident_id={incident_id}",
    )
    if db_rec:
        db_inc = db_rec["incident"]
        check(
            "M9.2.2 coverage_gap persisted",
            "coverage_gap" in db_inc,
            f"coverage_gap={db_inc.get('coverage_gap')}",
        )
        check(
            "M9.2.3 mid_incident_escalated persisted",
            "mid_incident_escalated" in db_inc,
            f"mid_incident_escalated={db_inc.get('mid_incident_escalated')}",
        )
        check(
            "M9.2.4 responder_arrived_timestamp persisted",
            db_inc.get("responder_arrived_timestamp") is not None,
            f"arrived_at={db_inc.get('responder_arrived_timestamp')}",
        )
        check(
            "M9.2.5 reporter_updates list persisted in DB",
            len(db_inc.get("reporter_updates", [])) >= 4,
            f"count={len(db_inc.get('reporter_updates', []))}",
        )

    # Wipe in-memory store and rehydrate
    slice_runner.INCIDENT_STORE.clear()
    check(
        "M9.2.6 INCIDENT_STORE cleared for simulated restart",
        len(slice_runner.INCIDENT_STORE) == 0,
    )
    loaded = incident_model.rehydrate_store_from_db()
    check(
        "M9.2.7 rehydrate_store_from_db loaded records",
        loaded > 0,
        f"loaded={loaded}",
    )

    rehydrated = lifecycle.getIncidentRecord(incident_id)
    check(
        "M9.2.8 getIncidentRecord retrieves rehydrated record",
        rehydrated is not None,
    )
    if rehydrated:
        reh_inc = rehydrated["incident"]
        check(
            "M9.2.9 rehydrated record has intact reporter_updates",
            len(reh_inc.get("reporter_updates", [])) >= 4,
            f"updates_count={len(reh_inc.get('reporter_updates', []))}",
        )


def test_m9_3_http_endpoints():
    print("\n" + "=" * 70)
    print("  M9.3 — HTTP Timeline Polling & Arrival Check-in")
    print("=" * 70)
    reset_test_environment()

    from fastapi.testclient import TestClient
    from main import app

    client = TestClient(app)

    # 1. Report Emergency
    report_resp = client.post(
        "/api/v1/emergency/report",
        data={
            "latitude": "31.5204",
            "longitude": "74.3587",
            "village_id": "VILLAGE-A",
            "photo_ref": "mockdata/media/photos/sample.jpg",
            "voice_ref": "mockdata/media/voice/sample.mp3",
            "reporter_id": "REP-HTTP-01",
        },
    )
    check(
        "M9.3.1 POST /api/v1/emergency/report returns 201",
        report_resp.status_code == 201,
        f"code={report_resp.status_code}",
    )
    report_data = report_resp.json()
    incident_id = report_data["incident"]["incident_id"]
    assigned_responder = report_data["dispatch"]["responder"]["responder_id"]

    # 2. Query Timeline immediately after report
    timeline_resp = client.get(f"/api/v1/emergency/incident/{incident_id}/timeline")
    check(
        "M9.3.2 GET /timeline returns 200",
        timeline_resp.status_code == 200,
        f"code={timeline_resp.status_code}",
    )
    timeline_data = timeline_resp.json()
    check(
        "M9.3.3 timeline payload contains required fields",
        "incident_id" in timeline_data and "status" in timeline_data and "updates" in timeline_data,
        f"keys={list(timeline_data.keys())}",
    )
    check(
        "M9.3.4 initial timeline has reported update",
        any(u.get("stage") == "reported" for u in timeline_data["updates"]),
        f"stages={[u.get('stage') for u in timeline_data['updates']]}",
    )

    # 3. Accept dispatch
    client.post(
        "/api/v1/responder/respond",
        json={
            "incident_id": incident_id,
            "responder_id": assigned_responder,
            "action": "accept",
        },
    )

    # 4. Responder Arrived Check-in
    arrive_resp = client.post(
        "/api/v1/responder/arrived",
        json={
            "incident_id": incident_id,
            "responder_id": assigned_responder,
        },
    )
    check(
        "M9.3.5 POST /api/v1/responder/arrived returns 200",
        arrive_resp.status_code == 200,
        f"code={arrive_resp.status_code}",
    )

    # 5. Query Timeline after arrival
    timeline_resp2 = client.get(f"/api/v1/emergency/incident/{incident_id}/timeline")
    t2_data = timeline_resp2.json()
    check(
        "M9.3.6 timeline includes responder_arrived update",
        any(u.get("stage") == "responder_arrived" for u in t2_data["updates"]),
        f"stages={[u.get('stage') for u in t2_data['updates']]}",
    )

    # 6. Close Incident
    client.post(
        f"/api/v1/emergency/incident/{incident_id}/close",
        json={
            "outcome": "taken_to_bhu",
            "confirmed_by": "bhu_staff",
        },
    )

    # 7. Final Timeline Check
    final_timeline = client.get(f"/api/v1/emergency/incident/{incident_id}/timeline").json()
    check(
        "M9.3.7 final timeline status is 'closed'",
        final_timeline.get("status") == "closed",
        f"status={final_timeline.get('status')}",
    )
    check(
        "M9.3.8 final timeline has closed update",
        any(u.get("stage") == "closed" for u in final_timeline["updates"]),
        f"stages={[u.get('stage') for u in final_timeline['updates']]}",
    )


def run_all():
    print("=" * 70)
    print("  RUNNING MODULE 8 & 9 TEST SUITE")
    print("=" * 70)

    test_m8_1_coverage_gap_flagging()
    test_m8_2_mid_incident_escalation_audit()
    test_m9_1_sequential_timeline_accumulation()
    test_m9_2_persistence_and_rehydration()
    test_m9_3_http_endpoints()

    print("\n" + "=" * 70)
    print(f"  MODULE 8 & 9 RESULTS: {_PASSED} PASSED  |  {_FAILED} FAILED  |  {_PASSED + _FAILED} TOTAL")
    print("=" * 70)

    if _FAILURES:
        print("\n  FAILURES:")
        for f in _FAILURES:
            print(f"    - {f}")
        sys.exit(1)
    else:
        print("\n  ALL CHECKS PASSED CLEANLY.")
        sys.exit(0)


if __name__ == "__main__":
    run_all()
