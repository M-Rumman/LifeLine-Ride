# -*- coding: utf-8 -*-
"""Module 7 test suite — Responder Onboarding, Verification & Dynamic Registration.

Scenarios:
    M7.1  Candidate Registration: New responder registers with 'unverified' status and is_verified=False.
    M7.2  Dispatch Gate Isolation: Unverified candidate in the exact incident village cannot be matched or dispatched.
    M7.3  Trainer Sign-Off: Sign-off promotes candidate to is_verified=True and status 'available'.
    M7.4  Post-Verification Matching: Candidate is immediately selectable by dispatchIncident() once verified.
    M7.5  Restart Survival: Unverified and verified statuses survive process rehydration and PostgreSQL restart.
    M7.6  HTTP Endpoints Integration: Full validation of /api/v1/responders/register, /pending, /verify, and query filters.

Run with:
    cd "d:\\LifeLine Ride"
    python backend\\test_module7_onboarding.py
"""
from __future__ import annotations

import os
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

# ---------------------------------------------------------------------------
# Path setup
# ---------------------------------------------------------------------------
_BACKEND_DIR = Path(__file__).resolve().parent
if str(_BACKEND_DIR) not in [str(p) for p in sys.path]:
    sys.path.insert(0, str(_BACKEND_DIR))

os.environ["DISPATCH_ACK_TIMEOUT_S"] = "300"
os.environ["LIFELINE_REPLAY_MODE"] = "1"

from fastapi.testclient import TestClient
import slice_runner
from database import Base, SessionLocal, engine
from models import incident_model, responder_model
from services import dispatch_service, onboarding_service
from main import app, bootstrap_responder_state


# ===========================================================================
# TEST INFRASTRUCTURE — Standard hand-rolled harness
# ===========================================================================

_RESULTS: list = []
_FAILURES: int = 0


def _sep(title: str) -> None:
    print(f"\n{'=' * 70}")
    print(f"  {title}")
    print("=" * 70)


def _pass(test_name: str, detail: str = "") -> None:
    _RESULTS.append(("PASS", test_name, detail))
    label = f"  [PASS] {test_name}"
    print(f"{label}  {detail}" if detail else label)


def _fail(test_name: str, reason: str) -> None:
    global _FAILURES
    _FAILURES += 1
    _RESULTS.append(("FAIL", test_name, reason))
    print(f"  [FAIL] {test_name}  REASON: {reason}")


def _assert(condition: bool, test_name: str, pass_detail: str, fail_reason: str) -> bool:
    if condition:
        _pass(test_name, pass_detail)
        return True
    _fail(test_name, fail_reason)
    return False


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

_original_availability = {
    "RESP-01": "busy",
    "RESP-02": "available",
    "RESP-03": "offline",
    "RESP-04": "busy",
    "RESP-05": "available",
}


def _reset_seed_responders() -> None:
    """Reset slice_runner.SEED_RESPONDERS to the clean 5 seed responders."""
    slice_runner.SEED_RESPONDERS.clear()
    slice_runner.SEED_RESPONDERS.extend([
        slice_runner.Responder(
            responder_id="RESP-01",
            name="Tariq Mahmood",
            village="VILLAGE-A",
            linked_bhu_id="BHU-001",
            current_availability_status=_original_availability["RESP-01"],
            points_total=120,
            phone_number="+923001234561",
            is_verified=True,
            verified_by="SEED_ADMIN",
            verified_at="2026-01-01T00:00:00+00:00",
            training_completed=True,
            training_org="Pakistan Red Crescent",
            equipment_checklist=["tourniquet", "pressure_bandages", "splints", "antiseptic"],
        ),
        slice_runner.Responder(
            responder_id="RESP-02",
            name="Farhan Ali",
            village="VILLAGE-A",
            linked_bhu_id="BHU-001",
            current_availability_status=_original_availability["RESP-02"],
            points_total=45,
            phone_number="+923001234562",
            is_verified=True,
            verified_by="SEED_ADMIN",
            verified_at="2026-01-01T00:00:00+00:00",
            training_completed=True,
            training_org="Rescue 1122",
            equipment_checklist=["tourniquet", "pressure_bandages", "splints", "antiseptic"],
        ),
        slice_runner.Responder(
            responder_id="RESP-03",
            name="Bilal Shah",
            village="VILLAGE-B",
            linked_bhu_id="BHU-001",
            current_availability_status=_original_availability["RESP-03"],
            points_total=80,
            phone_number="+923001234563",
            is_verified=True,
            verified_by="SEED_ADMIN",
            verified_at="2026-01-01T00:00:00+00:00",
            training_completed=True,
            training_org="Pakistan Red Crescent",
            equipment_checklist=["tourniquet", "pressure_bandages", "splints", "antiseptic"],
        ),
        slice_runner.Responder(
            responder_id="RESP-04",
            name="Zubair Khan",
            village="VILLAGE-B",
            linked_bhu_id="BHU-001",
            current_availability_status=_original_availability["RESP-04"],
            points_total=15,
            phone_number="+923001234564",
            is_verified=True,
            verified_by="SEED_ADMIN",
            verified_at="2026-01-01T00:00:00+00:00",
            training_completed=True,
            training_org="DoH",
            equipment_checklist=["tourniquet", "pressure_bandages", "splints", "antiseptic"],
        ),
        slice_runner.Responder(
            responder_id="RESP-05",
            name="Rashid Minhas",
            village="VILLAGE-C",
            linked_bhu_id="BHU-002",
            current_availability_status=_original_availability["RESP-05"],
            points_total=210,
            phone_number="+923001234565",
            is_verified=True,
            verified_by="SEED_ADMIN",
            verified_at="2026-01-01T00:00:00+00:00",
            training_completed=True,
            training_org="Rescue 1122",
            equipment_checklist=["tourniquet", "pressure_bandages", "splints", "antiseptic"],
        ),
    ])


def _db_reset() -> None:
    """Isolate tests: truncate DB tables and reset in-memory registries."""
    incident_model.truncate_incidents_table()
    responder_model.truncate_responders_table()
    responder_model.truncate_point_transactions_table()
    slice_runner.INCIDENT_STORE.clear()
    with dispatch_service._STATE_LOCK:
        dispatch_service._DISPATCH_STATE.clear()
    _reset_seed_responders()
    responder_model.seed_responders_from_contract()


def _make_incident(village_id: str, tier: str = "moderate") -> slice_runner.Incident:
    return slice_runner.Incident(
        incident_id=f"INC-M7-{uuid.uuid4().hex[:6].upper()}",
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
        injury_type_flags=["test_flag"],
    )


# ===========================================================================
# 1. CANDIDATE REGISTRATION
# ===========================================================================

def test_m7_1_candidate_registration():
    _sep("M7.1 — Candidate Registration (unverified default)")
    _db_reset()

    candidate_data = {
        "responder_id": "RESP-NEW-01",
        "name": "Ali Raza",
        "village": "VILLAGE-A",
        "phone_number": "+923009998877",
        "linked_bhu_id": "BHU-001",
        "training_completed": True,
        "training_org": "Rescue 1122",
        "equipment_checklist": ["first_aid_kit"],
    }

    res = onboarding_service.registerCandidateResponder(candidate_data)

    _assert(
        res["responder_id"] == "RESP-NEW-01",
        "M7.1.1 responder_id preserved in registration",
        f"id={res['responder_id']}",
        f"expected RESP-NEW-01, got {res.get('responder_id')}",
    )
    _assert(
        res["is_verified"] is False,
        "M7.1.2 newly registered responder is_verified is False",
        "is_verified=False",
        f"expected False, got {res.get('is_verified')}",
    )
    _assert(
        res["current_availability_status"] == "unverified",
        "M7.1.3 newly registered responder status is 'unverified'",
        "status='unverified'",
        f"expected 'unverified', got {res.get('current_availability_status')}",
    )

    # In-memory registry check
    in_mem = next((r for r in slice_runner.SEED_RESPONDERS if r.responder_id == "RESP-NEW-01"), None)
    _assert(
        in_mem is not None and in_mem.is_verified is False and in_mem.current_availability_status == "unverified",
        "M7.1.4 in-memory SEED_RESPONDERS updated with unverified candidate",
        f"in_mem={in_mem.responder_id if in_mem else None} status={in_mem.current_availability_status if in_mem else None}",
        f"expected in-memory unverified responder, got {in_mem}",
    )

    # Pending list check
    pending = onboarding_service.listPendingVerifications("VILLAGE-A")
    _assert(
        any(p["responder_id"] == "RESP-NEW-01" for p in pending),
        "M7.1.5 candidate listed in pending verifications",
        f"count={len(pending)}",
        f"RESP-NEW-01 missing from pending list: {pending}",
    )


# ===========================================================================
# 2. DISPATCH GATE ISOLATION
# ===========================================================================

def test_m7_2_dispatch_gate_isolation():
    _sep("M7.2 — Dispatch Gate Isolation (unverified candidates excluded from dispatch)")
    _db_reset()

    # Register candidate in VILLAGE-A
    onboarding_service.registerCandidateResponder({
        "responder_id": "RESP-CANDIDATE-A",
        "name": "Hamza Tariq",
        "village": "VILLAGE-A",
        "phone_number": "+923001112233",
        "linked_bhu_id": "BHU-001",
    })

    # Mark existing verified responders in VILLAGE-A as busy
    for r in slice_runner.SEED_RESPONDERS:
        if r.village == "VILLAGE-A" and r.responder_id != "RESP-CANDIDATE-A":
            r.current_availability_status = "busy"

    # Only RESP-CANDIDATE-A is in VILLAGE-A, but status='unverified' and is_verified=False
    inc = _make_incident("VILLAGE-A", tier="moderate")
    decision = dispatch_service.dispatchIncident(inc)

    _assert(
        decision.selected_responder is None,
        "M7.2.1 unverified candidate is NOT selected for dispatch",
        f"selected={decision.selected_responder}",
        f"unverified candidate {decision.selected_responder.responder_id if decision.selected_responder else None} was illegally selected",
    )
    _assert(
        decision.status == "escalated_bhu_only",
        "M7.2.2 system escalates to BHU-only when only unverified candidates exist",
        f"status={decision.status}",
        f"expected 'escalated_bhu_only', got {decision.status}",
    )


# ===========================================================================
# 3. TRAINER SIGN-OFF
# ===========================================================================

def test_m7_3_trainer_sign_off():
    _sep("M7.3 — Trainer Sign-Off (verification promotion)")
    _db_reset()

    candidate = onboarding_service.registerCandidateResponder({
        "responder_id": "RESP-VERIFY-01",
        "name": "Kamran Akmal",
        "village": "VILLAGE-B",
        "phone_number": "+923004445566",
        "linked_bhu_id": "BHU-001",
    })

    # Sign off with verified equipment
    equipment = ["tourniquet", "pressure_bandages", "splints", "antiseptic"]
    verified = onboarding_service.signOffResponder(
        responder_id="RESP-VERIFY-01",
        verified_by="PRC-TRAINER-07",
        equipment_checklist=equipment,
    )

    _assert(
        verified["is_verified"] is True,
        "M7.3.1 candidate is_verified promoted to True",
        "is_verified=True",
        f"expected True, got {verified.get('is_verified')}",
    )
    _assert(
        verified["current_availability_status"] == "available",
        "M7.3.2 candidate status promoted to 'available'",
        "status='available'",
        f"expected 'available', got {verified.get('current_availability_status')}",
    )
    _assert(
        verified["verified_by"] == "PRC-TRAINER-07" and verified.get("verified_at") is not None,
        "M7.3.3 verified_by and verified_at recorded",
        f"verified_by={verified.get('verified_by')} at={verified.get('verified_at')}",
        f"verification attribution missing in {verified}",
    )
    _assert(
        verified["equipment_checklist"] == equipment,
        "M7.3.4 equipment_checklist recorded",
        f"equipment={verified.get('equipment_checklist')}",
        f"equipment checklist mismatch: {verified.get('equipment_checklist')}",
    )

    # In-memory check
    in_mem = next(r for r in slice_runner.SEED_RESPONDERS if r.responder_id == "RESP-VERIFY-01")
    _assert(
        in_mem.is_verified is True and in_mem.current_availability_status == "available",
        "M7.3.5 in-memory SEED_RESPONDERS updated to verified and available",
        f"in_mem status={in_mem.current_availability_status} verified={in_mem.is_verified}",
        f"in-memory state not updated: {in_mem}",
    )

    # Must no longer be in pending
    pending = onboarding_service.listPendingVerifications("VILLAGE-B")
    _assert(
        not any(p["responder_id"] == "RESP-VERIFY-01" for p in pending),
        "M7.3.6 verified responder removed from pending verifications",
        f"pending_count={len(pending)}",
        f"RESP-VERIFY-01 still in pending list: {pending}",
    )


# ===========================================================================
# 4. POST-VERIFICATION MATCHING
# ===========================================================================

def test_m7_4_post_verification_matching():
    _sep("M7.4 — Post-Verification Matching (newly verified responder immediately dispatchable)")
    _db_reset()

    # Make existing VILLAGE-B responders busy/offline
    for r in slice_runner.SEED_RESPONDERS:
        if r.village == "VILLAGE-B":
            r.current_availability_status = "offline"

    # Register and verify a new responder in VILLAGE-B
    onboarding_service.registerCandidateResponder({
        "responder_id": "RESP-VILLAGE-B-NEW",
        "name": "Saad Khan",
        "village": "VILLAGE-B",
        "phone_number": "+923008887766",
        "linked_bhu_id": "BHU-001",
    })

    onboarding_service.signOffResponder(
        responder_id="RESP-VILLAGE-B-NEW",
        verified_by="BHU-001-DOCTOR",
        equipment_checklist=["tourniquet", "antiseptic", "pressure_bandages"],
    )

    # Dispatch incident in VILLAGE-B
    inc = _make_incident("VILLAGE-B", tier="moderate")
    decision = dispatch_service.dispatchIncident(inc)

    _assert(
        decision.selected_responder is not None
        and decision.selected_responder.responder_id == "RESP-VILLAGE-B-NEW",
        "M7.4.1 newly verified responder is matched and selected by dispatchIncident",
        f"selected={decision.selected_responder.responder_id if decision.selected_responder else None}",
        f"expected RESP-VILLAGE-B-NEW, got {decision.selected_responder.responder_id if decision.selected_responder else None}",
    )
    _assert(
        decision.status == "dispatched",
        "M7.4.2 dispatch decision status is 'dispatched'",
        f"status={decision.status}",
        f"expected 'dispatched', got {decision.status}",
    )


# ===========================================================================
# 5. RESTART SURVIVAL & REHYDRATION
# ===========================================================================

def test_m7_5_restart_survival():
    _sep("M7.5 — Restart Survival (verification and dynamic registration survive restarts)")
    _db_reset()

    # 1. Register candidate 1 (unverified)
    onboarding_service.registerCandidateResponder({
        "responder_id": "RESP-PERSIST-UNVERIFIED",
        "name": "Unverified Volunteer",
        "village": "VILLAGE-A",
        "phone_number": "+923001111111",
        "linked_bhu_id": "BHU-001",
    })

    # 2. Register candidate 2 and verify them
    onboarding_service.registerCandidateResponder({
        "responder_id": "RESP-PERSIST-VERIFIED",
        "name": "Verified Volunteer",
        "village": "VILLAGE-C",
        "phone_number": "+923002222222",
        "linked_bhu_id": "BHU-002",
    })
    onboarding_service.signOffResponder(
        responder_id="RESP-PERSIST-VERIFIED",
        verified_by="PRC-ADMIN-01",
        equipment_checklist=["tourniquet", "splints"],
    )

    # 3. Simulate process restart: wipe in-memory list back to initial seed defaults
    _reset_seed_responders()

    _assert(
        not any(r.responder_id in ("RESP-PERSIST-UNVERIFIED", "RESP-PERSIST-VERIFIED") for r in slice_runner.SEED_RESPONDERS),
        "M7.5.1 memory wiped before restart bootstrap",
        f"count={len(slice_runner.SEED_RESPONDERS)}",
        "memory not wiped",
    )

    # 4. Bootstrap from PostgreSQL
    bootstrap_summary = bootstrap_responder_state()

    _assert(
        bootstrap_summary["statuses_loaded"] >= 7,
        "M7.5.2 bootstrap rehydrated dynamic responders from DB",
        f"statuses_loaded={bootstrap_summary['statuses_loaded']}",
        f"expected >= 7 statuses loaded, got {bootstrap_summary['statuses_loaded']}",
    )

    # Check unverified candidate post-restart
    unver_r = next((r for r in slice_runner.SEED_RESPONDERS if r.responder_id == "RESP-PERSIST-UNVERIFIED"), None)
    _assert(
        unver_r is not None
        and unver_r.is_verified is False
        and unver_r.current_availability_status == "unverified",
        "M7.5.3 unverified candidate retains is_verified=False and status='unverified' post-restart",
        f"status={unver_r.current_availability_status if unver_r else None} is_verified={unver_r.is_verified if unver_r else None}",
        f"unverified candidate lost state: {unver_r}",
    )

    # Check verified candidate post-restart
    ver_r = next((r for r in slice_runner.SEED_RESPONDERS if r.responder_id == "RESP-PERSIST-VERIFIED"), None)
    _assert(
        ver_r is not None
        and ver_r.is_verified is True
        and ver_r.current_availability_status == "available"
        and ver_r.verified_by == "PRC-ADMIN-01",
        "M7.5.4 verified candidate retains is_verified=True, status='available', and verified_by post-restart",
        f"status={ver_r.current_availability_status if ver_r else None} verified_by={ver_r.verified_by if ver_r else None}",
        f"verified candidate lost state: {ver_r}",
    )


# ===========================================================================
# 6. HTTP ENDPOINTS INTEGRATION
# ===========================================================================

def test_m7_6_http_endpoints():
    _sep("M7.6 — HTTP Endpoints Integration (FastAPI TestClient)")
    _db_reset()
    client = TestClient(app)

    # 1. POST /api/v1/responders/register (Valid)
    reg_payload = {
        "responder_id": "RESP-HTTP-01",
        "name": "Zeeshan Qureshi",
        "village": "VILLAGE-A",
        "phone_number": "+923005556677",
        "linked_bhu_id": "BHU-001",
        "training_completed": True,
        "training_org": "Rescue 1122",
    }
    r = client.post("/api/v1/responders/register", json=reg_payload)
    _assert(
        r.status_code == 201,
        "M7.6.1 POST /api/v1/responders/register returns 201 Created",
        f"code={r.status_code}",
        f"expected 201, got {r.status_code}: {r.text}",
    )
    data = r.json()
    _assert(
        data.get("is_verified") is False and data.get("current_availability_status") == "unverified",
        "M7.6.2 registration response reflects unverified status",
        f"is_verified={data.get('is_verified')} status={data.get('current_availability_status')}",
        f"unexpected response payload: {data}",
    )

    # 2. POST /api/v1/responders/register (Missing fields validation)
    bad_payload = {"name": "Incomplete Candidate"}
    r_bad = client.post("/api/v1/responders/register", json=bad_payload)
    _assert(
        r_bad.status_code == 422 or r_bad.status_code == 400,
        "M7.6.3 registration with missing fields fails with 4xx",
        f"code={r_bad.status_code}",
        f"expected 400/422, got {r_bad.status_code}: {r_bad.text}",
    )

    # 3. GET /api/v1/responders/pending
    r_pending = client.get("/api/v1/responders/pending?village_id=VILLAGE-A")
    _assert(
        r_pending.status_code == 200,
        "M7.6.4 GET /api/v1/responders/pending returns 200 OK",
        f"code={r_pending.status_code}",
        f"expected 200, got {r_pending.status_code}",
    )
    p_data = r_pending.json()
    _assert(
        any(p["responder_id"] == "RESP-HTTP-01" for p in p_data.get("pending_responders", [])),
        "M7.6.5 candidate present in GET /pending response",
        f"count={p_data.get('count')}",
        f"RESP-HTTP-01 missing from pending: {p_data}",
    )

    # 4. POST /api/v1/responders/{id}/verify (Invalid - empty equipment)
    r_v_bad = client.post(
        "/api/v1/responders/RESP-HTTP-01/verify",
        json={"verified_by": "TRAINER-01", "equipment_checklist": []},
    )
    _assert(
        r_v_bad.status_code == 400,
        "M7.6.6 sign-off with empty equipment checklist returns 400 Bad Request",
        f"code={r_v_bad.status_code}",
        f"expected 400, got {r_v_bad.status_code}: {r_v_bad.text}",
    )

    # 5. POST /api/v1/responders/{id}/verify (Valid sign-off)
    r_v = client.post(
        "/api/v1/responders/RESP-HTTP-01/verify",
        json={
            "verified_by": "PRC-MASTER-TRAINER",
            "equipment_checklist": ["tourniquet", "pressure_bandages", "antiseptic"],
        },
    )
    _assert(
        r_v.status_code == 200,
        "M7.6.7 POST /api/v1/responders/{id}/verify returns 200 OK",
        f"code={r_v.status_code}",
        f"expected 200, got {r_v.status_code}: {r_v.text}",
    )
    v_data = r_v.json()
    _assert(
        v_data.get("is_verified") is True and v_data.get("current_availability_status") == "available",
        "M7.6.8 verified candidate promoted to available",
        f"verified={v_data.get('is_verified')} status={v_data.get('current_availability_status')}",
        f"unexpected verify payload: {v_data}",
    )

    # 6. GET /api/v1/responders?verified=true & verified=false filters
    r_all_ver = client.get("/api/v1/responders?verified=true")
    _assert(
        r_all_ver.status_code == 200 and all(r["is_verified"] is True for r in r_all_ver.json()["responders"]),
        "M7.6.9 GET /responders?verified=true returns only verified responders",
        f"count={len(r_all_ver.json()['responders'])}",
        "non-verified responder found in verified=true filter",
    )


# ===========================================================================
# MAIN RUNNER
# ===========================================================================

def main() -> int:
    print("=" * 70)
    print("  MODULE 7 TEST SUITE — Responder Onboarding, Verification & Dynamic Registration")
    print("=" * 70)

    test_m7_1_candidate_registration()
    test_m7_2_dispatch_gate_isolation()
    test_m7_3_trainer_sign_off()
    test_m7_4_post_verification_matching()
    test_m7_5_restart_survival()
    test_m7_6_http_endpoints()

    passed = sum(1 for r in _RESULTS if r[0] == "PASS")
    total = len(_RESULTS)
    print(f"\n{'=' * 70}")
    print(f"  MODULE 7 RESULTS: {passed}/{total} checks passed, {_FAILURES} failures")
    print("=" * 70)
    return 0 if _FAILURES == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
