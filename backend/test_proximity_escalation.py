# -*- coding: utf-8 -*-
"""
test_proximity_escalation.py
Comprehensive test suite verifying Dynamic Proximity-Based Escalation and
Realistic Distances for Responders in LifeLine Ride.

Tests:
  1. Coordinate generation & distinct distances (~0.6 km, ~1.4 km, ~2.8 km).
  2. Prioritized dispatch queue: sorting strictly ascending by distance.
  3. First-nearest assignment to queue[0] with distance and ETA.
  4. Single responder decline: immediate handoff to next nearest candidate.
  5. Consecutive responder declines: seamless handoff through queue until exhaustion.
  6. Clean fallback to BHU-only when all candidates decline (no dead-ends).
"""
import copy
import os
import sys
from pathlib import Path

_BACKEND_DIR = Path(__file__).resolve().parent
if str(_BACKEND_DIR) not in [str(p) for p in sys.path]:
    sys.path.insert(0, str(_BACKEND_DIR))

# Ensure fast local test execution
os.environ["DISPATCH_ACK_TIMEOUT_S"] = "2"
os.environ["LIFELINE_REPLAY_MODE"] = "1"

import slice_runner
from geography import (
    VILLAGE_COORDINATES,
    calculate_responder_coords,
    haversine_distance_km,
    calculate_eta_minutes,
)
from services.dispatch_service import (
    decideDispatch,
    sendNotification,
    handleResponderDecline,
    acknowledgeDispatch,
    _DISPATCH_STATE,
    _STATE_LOCK,
)

_FAILURES = 0
_TOTAL_CHECKS = 0

def _check(condition: bool, name: str, detail: str = ""):
    global _FAILURES, _TOTAL_CHECKS
    _TOTAL_CHECKS += 1
    if condition:
        print(f"  [PASS] {name} {detail}")
    else:
        _FAILURES += 1
        print(f"  [FAIL] {name} {detail}")


def _reset_state():
    with _STATE_LOCK:
        for st in _DISPATCH_STATE.values():
            timer = st.get("ack_timer")
            if timer:
                timer.cancel()
        _DISPATCH_STATE.clear()
    slice_runner.init_seed_responder_coordinates()
    for r in slice_runner.SEED_RESPONDERS:
        r.current_availability_status = "available"
        r.is_verified = True


def test_1_coordinate_and_distance_variety():
    print("\n--- Scenario 1: Coordinate Generation & Distance Realism ---")
    tamman_lat, tamman_lng = VILLAGE_COORDINATES["TAMMAN"]

    # Generate coordinates for rank 0, 1, 2
    lat0, lng0 = calculate_responder_coords("TAMMAN", 0)
    lat1, lng1 = calculate_responder_coords("TAMMAN", 1)
    lat2, lng2 = calculate_responder_coords("TAMMAN", 2)

    dist0 = haversine_distance_km(tamman_lat, tamman_lng, lat0, lng0)
    dist1 = haversine_distance_km(tamman_lat, tamman_lng, lat1, lng1)
    dist2 = haversine_distance_km(tamman_lat, tamman_lng, lat2, lng2)

    _check(0.5 <= dist0 <= 0.7, "Rank 0 distance ~0.6 km", f"dist0={dist0:.2f} km")
    _check(1.3 <= dist1 <= 1.5, "Rank 1 distance ~1.4 km", f"dist1={dist1:.2f} km")
    _check(2.6 <= dist2 <= 3.0, "Rank 2 distance ~2.8 km", f"dist2={dist2:.2f} km")
    _check(dist0 < dist1 < dist2, "Distances strictly increasing with rank", f"{dist0:.2f} < {dist1:.2f} < {dist2:.2f}")

    eta0 = calculate_eta_minutes(dist0)
    eta1 = calculate_eta_minutes(dist1)
    eta2 = calculate_eta_minutes(dist2)
    _check(eta0 <= eta1 <= eta2, "ETAs correlate with distance", f"eta0={eta0}m, eta1={eta1}m, eta2={eta2}m")


import uuid
from datetime import datetime, timezone

def _make_incident(village_id: str, tier: str = "moderate", flags: list | None = None) -> slice_runner.Incident:
    lat, lng = VILLAGE_COORDINATES.get(village_id, VILLAGE_COORDINATES["TAMMAN"])
    return slice_runner.Incident(
        incident_id=f"INC-PROX-{uuid.uuid4().hex[:6].upper()}",
        timestamp_reported=datetime.now(timezone.utc).isoformat(),
        reporter_id="REP-TEST",
        gps_location=slice_runner.GPSLocation(
            village_id=village_id,
            latitude=lat,
            longitude=lng,
        ),
        photo_ref="test.jpg",
        severity_tier=tier,
        injury_type_flags=flags or ["fracture"],
        voice_transcript="مریض کا بازو ٹوٹ گیا ہے",
        audio_url_or_path="",
        declined_responder_ids=[],
    )


def test_2_prioritized_queue_sorting():
    print("\n--- Scenario 2: Prioritized Dispatch Queue Ascending Sorting ---")
    # Reset seed responders
    slice_runner.init_seed_responder_coordinates()

    # Set all Tamman responders available
    tam_responders = [r for r in slice_runner.SEED_RESPONDERS if r.village == "TAMMAN"]
    for r in tam_responders:
        r.current_availability_status = "available"
        r.is_verified = True

    incident = _make_incident("TAMMAN", "moderate")
    decision = decideDispatch(incident)

    _check(decision.status == "dispatched", "Decision status is dispatched", f"status={decision.status}")
    _check(len(decision.ranked_responders) >= 3, "Ranked queue contains at least 3 responders", f"count={len(decision.ranked_responders)}")

    # Verify strictly sorted ascending by distance
    distances = [getattr(r, "distance_km", 999.0) for r in decision.ranked_responders]
    is_sorted = all(distances[i] <= distances[i + 1] for i in range(len(distances) - 1))
    _check(is_sorted, "Ranked responders sorted in ascending distance order", f"distances={distances}")

    # Nearest responder is queue[0]
    nearest = decision.selected_responder
    _check(nearest is not None, "Nearest responder selected", f"selected={nearest.name if nearest else None}")
    _check(nearest.responder_id == decision.ranked_responders[0].responder_id, "Selected responder is queue[0]")
    _check(nearest.distance_km is not None and nearest.distance_km < 1.0, "Nearest responder is closest (~0.6 km)", f"dist={nearest.distance_km} km")


def test_3_single_responder_decline_and_reassignment():
    print("\n--- Scenario 3: Single Responder Decline & Immediate Handoff ---")
    slice_runner.init_seed_responder_coordinates()

    # Ensure all Tamman responders available
    for r in slice_runner.SEED_RESPONDERS:
        if r.village == "TAMMAN":
            r.current_availability_status = "available"

    incident = _make_incident("TAMMAN", "moderate", ["heavy_bleeding"])

    decision = decideDispatch(incident)
    sendNotification(decision, incident)

    first_responder = decision.selected_responder
    _check(first_responder is not None, "Initial dispatch successful", f"assigned={first_responder.responder_id}")
    _check(incident.responder_assigned_id == first_responder.responder_id, "Incident assigned to responder 1")

    # Responder 1 declines
    print(f"  --> Responder {first_responder.responder_id} declines dispatch...")
    handleResponderDecline(incident.incident_id, first_responder.responder_id)

    # Verify handoff to next nearest responder
    _check(first_responder.responder_id in incident.declined_responder_ids, "Responder 1 tracked in declined_responder_ids", f"declined={incident.declined_responder_ids}")
    _check(first_responder.current_availability_status == "available", "Declined responder returned to available for other calls")
    _check(incident.responder_assigned_id is not None and incident.responder_assigned_id != first_responder.responder_id,
           "Incident reassigned to a different responder", f"now_assigned={incident.responder_assigned_id}")
    _check(incident.status == "REASSIGNED_TO_NEXT_RESPONDER", "Incident status updated to REASSIGNED_TO_NEXT_RESPONDER", f"status={incident.status}")

    # Verify newly assigned responder has distinct distance and ETA
    second_responder = next(r for r in slice_runner.SEED_RESPONDERS if r.responder_id == incident.responder_assigned_id)
    _check(incident.responder_distance_km == second_responder.distance_km, "Incident has responder 2 distance", f"dist={incident.responder_distance_km} km")
    _check(incident.responder_eta_minutes == second_responder.eta_minutes, "Incident has responder 2 ETA", f"eta={incident.responder_eta_minutes} m")
    _check(second_responder.distance_km > first_responder.distance_km, "Second responder distance is greater than first",
           f"{second_responder.distance_km} km > {first_responder.distance_km} km")

    # Cancel remaining ack timer for scenario 3
    acknowledgeDispatch(incident.incident_id, incident.responder_assigned_id)


def test_4_exhaustion_fallback_to_bhu():
    print("\n--- Scenario 4: All Responders Decline -> BHU-Only Fallback ---")
    _reset_state()

    incident = _make_incident("TAMMAN", "moderate", ["head_injury"])

    decision = decideDispatch(incident)
    sendNotification(decision, incident)

    # Decline responder 1
    r1_id = incident.responder_assigned_id
    print(f"  --> Responder 1 ({r1_id}) declines...")
    handleResponderDecline(incident.incident_id, r1_id)

    # Decline responder 2
    r2_id = incident.responder_assigned_id
    print(f"  --> Responder 2 ({r2_id}) declines...")
    handleResponderDecline(incident.incident_id, r2_id)

    # Decline responder 3 (exhaustion)
    r3_id = incident.responder_assigned_id
    print(f"  --> Responder 3 ({r3_id}) declines...")
    handleResponderDecline(incident.incident_id, r3_id)

    # Incident should now be escalated to BHU-only
    _check(incident.responder_assigned_id is None, "No responder assigned after total exhaustion")
    _check(incident.status == "ESCALATED_TO_BHU_ONLY", "Incident status set to ESCALATED_TO_BHU_ONLY", f"status={incident.status}")
    _check(incident.bhu_notified is True, "BHU is notified upon exhaustion", f"bhu_notified={incident.bhu_notified}")

    has_exhausted_event = any(e.get("event") == "all_responders_exhausted" for e in incident.dispatch_events)
    _check(has_exhausted_event, "all_responders_exhausted event logged in dispatch timeline")

    _reset_state()


def main():
    print("======================================================================")
    print("  DYNAMIC PROXIMITY & ESCALATION TEST SUITE — LifeLine Ride")
    print("======================================================================")

    test_1_coordinate_and_distance_variety()
    test_2_prioritized_queue_sorting()
    test_3_single_responder_decline_and_reassignment()
    test_4_exhaustion_fallback_to_bhu()

    print("\n======================================================================")
    passed = _TOTAL_CHECKS - _FAILURES
    print(f"  RESULTS: {passed} PASSED  |  {_FAILURES} FAILED  |  {_TOTAL_CHECKS} total checks")
    print("======================================================================")
    if _FAILURES > 0:
        sys.exit(1)
    sys.exit(0)


if __name__ == "__main__":
    main()
