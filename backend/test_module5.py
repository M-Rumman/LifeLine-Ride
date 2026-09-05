# -*- coding: utf-8 -*-
"""Module 5 test suite — Responder Performance Record & Accountability Engine.

Eight scenarios covering the factual metrics system:
    S1  BHU-confirmed outcome recorded (and ledger idempotency)
    S2  Fraud prevention — self-reported closure never counted
    S3  BHU-confirmed referred_to_hospital counted correctly (no bonus)
    S4  Historical event audit — timeout counted, status_flag stays active
    S5  Fallback handling — real Module 3 ack-timeout: A times out, B recorded
    S6  Status flag logic — active / needs_follow_up / under_review
    S7  Mixed-outcome portfolio — the full ResponderPerformanceRecord shape
    S8  Regression — persisted status_flag survives a later dispatch/release

Run with:
    cd "d:\\LifeLine Ride"
    python backend\\test_module5.py

Deterministic: zero AI calls. The only external dependency is the Module 6.5
PostgreSQL layer (DATABASE_URL in .env), exactly like test_module6_persistence.

Isolation: every test starts from _db_reset() which truncates incidents +
responders + point_transactions, clears the in-memory store, resets seed
availability, and re-seeds the responders table.
"""
from __future__ import annotations

import os
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

# ---------------------------------------------------------------------------
# Path setup — mirror test_module6_persistence.py exactly.
# ---------------------------------------------------------------------------
_BACKEND_DIR = Path(__file__).resolve().parent
if str(_BACKEND_DIR) not in [str(p) for p in sys.path]:
    sys.path.insert(0, str(_BACKEND_DIR))

# Ack-timeout window. Only S5 exercises the real timeout -> fallback path, and
# it narrows this to 2 s for its own duration (_db_reset restores the default).
# Everywhere else the responder acknowledges, so the window has to be wide
# enough to absorb the PostgreSQL round-trips that sit between the
# responder_dispatched event and the acknowledgeDispatch call. At 2 s those
# round-trips occasionally out-ran the timer, which then fired a spurious
# ack_timeout and corrupted timeout_count / acceptance_rate_pct.
_ACK_TIMEOUT_DEFAULT = "60"
os.environ["DISPATCH_ACK_TIMEOUT_S"] = _ACK_TIMEOUT_DEFAULT
os.environ["LIFELINE_REPLAY_MODE"]   = "1"

import slice_runner  # noqa: E402
from services.dispatch_service import (  # noqa: E402
    _DISPATCH_STATE,
    _STATE_LOCK,
    acknowledgeDispatch,
    dispatchIncident,
)
from services.incident_lifecycle_service import closeIncident  # noqa: E402
from services.accountability_service import (  # noqa: E402
    awardPointsForIncident,
    getResponderPerformanceRecord,
)
from models.incident_model import truncate_incidents_table  # noqa: E402
from models.responder_model import (  # noqa: E402
    get_responder_from_db,
    seed_responders_from_contract,
    truncate_point_transactions_table,
    truncate_responders_table,
)

# Module 2 registry (optional) — same pattern as the other suites.
try:
    _SERVICES_DIR = _BACKEND_DIR / "services"
    if str(_SERVICES_DIR) not in [str(p) for p in sys.path]:
        sys.path.insert(0, str(_SERVICES_DIR))
    import help_bot_service as _hb_mod  # noqa: E402
    _HB_AVAILABLE = True
except ImportError:
    _HB_AVAILABLE = False


# ===========================================================================
# TEST INFRASTRUCTURE — same hand-rolled harness as test_module3/6/6.5
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
    """Full isolation reset across BOTH stores + the contribution ledger, then
    re-seed the responders table (fresh accountability era)."""
    truncate_incidents_table()
    truncate_responders_table()
    truncate_point_transactions_table()
    slice_runner.INCIDENT_STORE.clear()
    for r in slice_runner.SEED_RESPONDERS:
        r.current_availability_status = _original_availability.get(r.responder_id, "available")
    with _STATE_LOCK:
        _DISPATCH_STATE.clear()
    # Clearing _DISPATCH_STATE above drops the ack-timer references, so also
    # restore the wide timeout window: S5 narrows it to 2 s to exercise the
    # real timeout -> fallback path and no later scenario may inherit that.
    os.environ["DISPATCH_ACK_TIMEOUT_S"] = _ACK_TIMEOUT_DEFAULT
    if _HB_AVAILABLE:
        _hb_mod._ACTIVE_INCIDENTS.clear()
    seed_responders_from_contract()


def _make_incident(
    village_id: str,
    tier: str,
    flags: list | None = None,
) -> slice_runner.Incident:
    import uuid
    return slice_runner.Incident(
        incident_id=f"INC-M5-{uuid.uuid4().hex[:6].upper()}",
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
        "dispatched":         "dispatched",
        "escalated_bhu_only": "escalated_bhu_only",
        "no_resources":       "no_responders_available",
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


def _dispatch_close_record(village_id: str, tier: str = "moderate",
                            outcome: str = "taken_to_bhu"):
    """One full verified-completion cycle: dispatch -> acknowledge -> close
    (bhu_staff) -> record. Returns (incident, decision, receipt).

    The acknowledge step is what makes this deterministic. This suite sets
    DISPATCH_ACK_TIMEOUT_S=2 so S4/S5/S6 can exercise the real timeout path,
    which means every scenario that is NOT about timeouts must cancel its own
    ack timer — otherwise a slow DB round-trip lets the 2 s timer fire mid-test
    and pollutes timeout_count. A responder who completed the incident plainly
    acknowledged it, so this is also the realistic event sequence.
    """
    inc = _make_incident(village_id, tier)
    decision = _dispatch_and_log(inc)
    if decision.selected_responder is not None:
        acknowledgeDispatch(inc.incident_id,
                            decision.selected_responder.responder_id)
    closeIncident(inc.incident_id, outcome, "bhu_staff")
    receipt = awardPointsForIncident(inc.incident_id)
    return inc, decision, receipt


# ===========================================================================
# S1 — BHU-Confirmed Outcome Recorded (and ledger idempotency)
# ===========================================================================

def test_s1_bhu_confirmed_record():
    _sep("S1 — BHU-confirmed resolution recorded; ledger idempotency")
    _db_reset()

    inc = _make_incident("VILLAGE-A", "moderate", flags=["heavy_bleeding"])
    decision = _dispatch_and_log(inc)
    _assert(
        decision.selected_responder is not None
        and decision.selected_responder.responder_id == "RESP-02",
        "S1.1 dispatch to RESP-02",
        "selected=RESP-02",
        f"expected RESP-02, got "
        f"{decision.selected_responder.responder_id if decision.selected_responder else None}",
    )

    # Cancel the 2 s ack timer: this scenario measures the confirmed-outcome
    # record, not timeout behaviour (see _dispatch_close_record).
    acknowledgeDispatch(inc.incident_id, "RESP-02")
    closeIncident(inc.incident_id, "taken_to_bhu", "bhu_staff")
    receipt = awardPointsForIncident(inc.incident_id)
    _assert(
        receipt["status"] == "recorded" and receipt["outcome"] == "taken_to_bhu",
        "S1.2 receipt: status=recorded, outcome=taken_to_bhu",
        f"status={receipt.get('status')} outcome={receipt.get('outcome')}",
        f"expected recorded/taken_to_bhu, got {receipt.get('status')}/{receipt.get('outcome')}",
    )

    perf = getResponderPerformanceRecord("RESP-02")
    print(f"\n  [EXAMPLE ResponderPerformanceRecord for RESP-02]:")
    print(f"    incidents_responded_to: {perf['incidents_responded_to']}")
    print(f"    incidents_by_outcome:   {perf['incidents_by_outcome']}")
    print(f"    timeout_count:          {perf['timeout_count']}")
    print(f"    decline_count:          {perf['decline_count']}")
    print(f"    average_response_time:  {perf['average_response_time_seconds']}s")
    print(f"    dispatch_metrics:       {perf['dispatch_metrics']}")
    print(f"    status_flag:            {perf['status_flag']}")

    _assert(
        perf["incidents_responded_to"] == 1
        and perf["incidents_by_outcome"]["taken_to_bhu"] == 1
        and perf["incidents_by_outcome"]["self-resolved"] == 0
        and perf["status_flag"] == "active"
        and perf["dispatch_metrics"]["total_assigned"] == 1
        and perf["dispatch_metrics"]["completed"] == 1
        and perf["dispatch_metrics"]["acceptance_rate_pct"] == 100.0,
        "S1.3 performance record: 1 incident, taken_to_bhu, active, 100% acceptance",
        f"responded_to={perf['incidents_responded_to']} "
        f"taken_to_bhu={perf['incidents_by_outcome']['taken_to_bhu']} "
        f"status={perf['status_flag']}",
        f"performance record mismatch: {perf}",
    )

    # Idempotency: a second call must NOT double-count the incident.
    receipt2 = awardPointsForIncident(inc.incident_id)
    perf2 = getResponderPerformanceRecord("RESP-02")
    _assert(
        receipt2["status"] == "already_recorded"
        and perf2["incidents_responded_to"] == 1,
        "S1.4 re-call refused by ledger (no double-count)",
        f"status=already_recorded incidents_responded_to=1",
        f"expected already_recorded/1, got "
        f"{receipt2['status']}/{perf2['incidents_responded_to']}",
    )

    # DB row: status_flag stored via reliability_tier column.
    row = get_responder_from_db("RESP-02")
    _assert(
        row is not None and row["reliability_tier"] == "active",
        "S1.5 DB reliability_tier stores status_flag='active'",
        f"reliability_tier={row['reliability_tier'] if row else None}",
        f"expected 'active', got {row['reliability_tier'] if row else None}",
    )


# ===========================================================================
# S2 — Fraud Prevention: self-reported closure never counted
# ===========================================================================

def test_s2_fraud_prevention():
    _sep("S2 — Fraud prevention: confirmed_by='responder' -> not counted")
    _db_reset()

    inc = _make_incident("VILLAGE-A", "moderate")
    _dispatch_and_log(inc)
    acknowledgeDispatch(inc.incident_id, "RESP-02")  # cancel the 2 s ack timer
    closeIncident(inc.incident_id, "self-resolved", "responder")

    # THE fraud gate: self-reported closure must be ignored.
    receipt = awardPointsForIncident(inc.incident_id)
    _assert(
        receipt["status"] == "ignored"
        and receipt["reason"] == "unconfirmed_by_bhu",
        "S2.1 contribution refused: unconfirmed_by_bhu",
        f"status={receipt['status']} reason={receipt['reason']}",
        f"expected ignored/unconfirmed_by_bhu, got "
        f"{receipt.get('status')}/{receipt.get('reason')}",
    )

    perf = getResponderPerformanceRecord("RESP-02")
    _assert(
        perf["incidents_responded_to"] == 0
        and perf["incidents_by_outcome"]["self-resolved"] == 0,
        "S2.2 performance record: 0 incidents (unverified closure not counted)",
        f"incidents_responded_to={perf['incidents_responded_to']}",
        f"expected 0 incidents, got {perf['incidents_responded_to']}",
    )
    _assert(
        perf["dispatch_metrics"]["completed"] == 1
        and perf["dispatch_metrics"]["acceptance_rate_pct"] == 100.0,
        "S2.3 dispatch metrics still count the completed response",
        f"metrics={perf['dispatch_metrics']}",
        f"dispatch metrics should still count the response: {perf['dispatch_metrics']}",
    )

    # Confirm ledger is empty (no row was written).
    receipt2 = awardPointsForIncident(inc.incident_id)
    _assert(
        receipt2["status"] == "ignored",
        "S2.4 second call also ignored (no ledger row from fraud gate)",
        "still ignored on re-call",
        f"expected ignored, got {receipt2.get('status')}",
    )


# ===========================================================================
# S3 — referred_to_hospital counted correctly (no bonus concept)
# ===========================================================================

def test_s3_referred_to_hospital():
    _sep("S3 — referred_to_hospital: counted as 1 BHU-confirmed incident")
    _db_reset()

    inc = _make_incident("VILLAGE-A", "critical", flags=["heavy_bleeding"])
    _dispatch_and_log(inc)
    acknowledgeDispatch(inc.incident_id, "RESP-02")  # cancel the 2 s ack timer
    closeIncident(inc.incident_id, "referred_to_hospital", "bhu_staff")

    receipt = awardPointsForIncident(inc.incident_id)
    _assert(
        receipt["status"] == "recorded"
        and receipt["outcome"] == "referred_to_hospital",
        "S3.1 receipt: status=recorded, outcome=referred_to_hospital",
        f"status={receipt.get('status')} outcome={receipt.get('outcome')}",
        f"expected recorded/referred_to_hospital, got {receipt.get('status')}/{receipt.get('outcome')}",
    )

    perf = getResponderPerformanceRecord("RESP-02")
    _assert(
        perf["incidents_responded_to"] == 1
        and perf["incidents_by_outcome"]["referred_to_hospital"] == 1
        and perf["incidents_by_outcome"]["taken_to_bhu"] == 0,
        "S3.2 performance record: 1 incident, referred_to_hospital",
        f"responded_to={perf['incidents_responded_to']} "
        f"referred={perf['incidents_by_outcome']['referred_to_hospital']}",
        f"performance record mismatch: {perf}",
    )
    _assert(
        perf["status_flag"] == "active",
        "S3.3 status_flag=active for healthy responder",
        "status_flag=active",
        f"expected active, got {perf['status_flag']}",
    )


# ===========================================================================
# S4 — Historical Event Audit: timeout counted, status_flag stays active
# ===========================================================================

def test_s4_historical_timeout_audit():
    _sep("S4 — Historical audit: ack_timeout event -> timeout_count=1, status active")
    _db_reset()

    # Fabricate a historical record exactly as Module 3 would have logged it:
    # dispatched, then the responder ghosted (ack_timeout), no closure.
    inc = _make_incident("VILLAGE-A", "moderate")
    t0 = datetime.now(timezone.utc)
    inc.responder_assigned_id = "RESP-02"
    inc.dispatch_events = [
        {
            "event": "responder_dispatched",
            "responder_id": "RESP-02",
            "responder_name": "Farhan Ali",
            "tier": "moderate",
            "timestamp": t0.isoformat(),
        },
        {
            "event": "ack_timeout",
            "responder_id": "RESP-02",
            "timeout_s": 90,
            "timestamp": (t0 + timedelta(seconds=90)).isoformat(),
        },
    ]
    slice_runner.INCIDENT_STORE.append({
        "incident": inc.model_dump(),
        "dispatch_status": "dispatched",
        "logged_at": t0.isoformat(),
    })

    perf = getResponderPerformanceRecord("RESP-02")
    _assert(
        perf["timeout_count"] == 1
        and perf["dispatch_metrics"]["total_assigned"] == 1
        and perf["dispatch_metrics"]["completed"] == 0,
        "S4.1 timeout counted from historical dispatch_events",
        f"timeout_count={perf['timeout_count']} total_assigned={perf['dispatch_metrics']['total_assigned']}",
        f"expected 1 timeout, got {perf['timeout_count']}",
    )
    _assert(
        perf["status_flag"] == "active",
        "S4.2 single timeout does not flag (under_review requires >3 consecutive)",
        f"status_flag={perf['status_flag']}",
        f"expected active for 1 timeout, got {perf['status_flag']}",
    )
    _assert(
        perf["dispatch_metrics"]["acceptance_rate_pct"] == 0.0,
        "S4.3 acceptance rate drops to 0% with one timeout",
        f"acceptance={perf['dispatch_metrics']['acceptance_rate_pct']}",
        f"expected 0.0, got {perf['dispatch_metrics']['acceptance_rate_pct']}",
    )
    # incidents_responded_to stays 0: no BHU-confirmed closure, so no metric entry.
    _assert(
        perf["incidents_responded_to"] == 0,
        "S4.4 incidents_responded_to=0 (no BHU-confirmed closure in this incident)",
        "incidents_responded_to=0",
        f"expected 0, got {perf['incidents_responded_to']}",
    )


# ===========================================================================
# S5 — Fallback Handling: A times out, B completes
# ===========================================================================

def test_s5_fallback_responder_handling():
    _sep("S5 — REAL Module 3 path: RESP-01 timeout -> fallback RESP-02 completes")
    _db_reset()

    # The ONE scenario that needs the real ack timer to fire, so it narrows the
    # window and waits it out. The next _db_reset() restores the wide default.
    os.environ["DISPATCH_ACK_TIMEOUT_S"] = "2"

    # Make Tariq available so VILLAGE-A ranks [RESP-01, RESP-02].
    _responder("RESP-01").current_availability_status = "available"

    inc = _make_incident("VILLAGE-A", "moderate")
    decision = _dispatch_and_log(inc)
    _assert(
        decision.selected_responder is not None
        and decision.selected_responder.responder_id == "RESP-01",
        "S5.1 primary dispatch to RESP-01 (Tariq)",
        "selected=RESP-01",
        f"expected RESP-01, got "
        f"{decision.selected_responder.responder_id if decision.selected_responder else None}",
    )

    # Wait for the real ack timeout + fallback to land. Poll rather than sleep
    # a fixed interval: the fallback runs on Module 3's timer thread, so a fixed
    # sleep can wake up either before RESP-02 has been dispatched (the ack then
    # cancels nothing and RESP-02's freshly armed timer still fires) or after
    # RESP-02's own 2 s timer has already expired. Acknowledging as soon as the
    # fallback lands maximises the margin on both sides.
    print("  Waiting for the ack timeout + fallback ...")
    _deadline = time.time() + 15.0
    while inc.responder_assigned_id != "RESP-02" and time.time() < _deadline:
        time.sleep(0.05)
    _assert(
        inc.responder_assigned_id == "RESP-02"
        and _responder("RESP-02").current_availability_status == "busy",
        "S5.2 fallback dispatched RESP-02 after RESP-01 timeout",
        f"assigned={inc.responder_assigned_id} RESP-02=busy",
        f"expected RESP-02 assigned/busy, got {inc.responder_assigned_id}",
    )
    timeout_events = [
        e for e in inc.dispatch_events
        if e["event"] == "ack_timeout" and e.get("responder_id") == "RESP-01"
    ]
    _assert(
        len(timeout_events) == 1,
        "S5.3 genuine ack_timeout event logged for RESP-01",
        "ack_timeout event present",
        f"expected 1 ack_timeout for RESP-01, got {len(timeout_events)}",
    )

    acknowledgeDispatch(inc.incident_id, "RESP-02")
    closeIncident(inc.incident_id, "taken_to_bhu", "bhu_staff")
    receipt = awardPointsForIncident(inc.incident_id)
    _assert(
        receipt["status"] == "recorded" and receipt["responder_id"] == "RESP-02",
        "S5.4 contribution recorded for RESP-02 (the fallback responder)",
        f"recorded outcome={receipt.get('outcome')} -> RESP-02",
        f"expected recorded/RESP-02, got {receipt.get('status')}/"
        f"{receipt.get('responder_id')}",
    )

    perf_a = getResponderPerformanceRecord("RESP-01")
    _assert(
        perf_a["timeout_count"] == 1
        and perf_a["dispatch_metrics"]["acceptance_rate_pct"] == 0.0
        and perf_a["incidents_responded_to"] == 0,
        "S5.5 RESP-01: timeout_count=1, 0% acceptance, 0 confirmed incidents",
        f"timeout={perf_a['timeout_count']} acceptance={perf_a['dispatch_metrics']['acceptance_rate_pct']}",
        f"RESP-01 record wrong: {perf_a}",
    )
    perf_b = getResponderPerformanceRecord("RESP-02")
    _assert(
        perf_b["incidents_responded_to"] == 1
        and perf_b["incidents_by_outcome"]["taken_to_bhu"] == 1
        and perf_b["decline_count"] == 0
        and perf_b["timeout_count"] == 0,
        "S5.6 RESP-02: 1 confirmed incident, no inherited timeout/decline",
        f"responded_to={perf_b['incidents_responded_to']} decline={perf_b['decline_count']}",
        f"RESP-02 record wrong: {perf_b}",
    )


# ===========================================================================
# S6 — Status Flag Logic: active / needs_follow_up / under_review
# ===========================================================================

def test_s6_status_flag_logic():
    _sep("S6 — Status flag: active / needs_follow_up / under_review")
    _db_reset()

    # --- UNDER_REVIEW: RESP-03 with 4 consecutive historical timeouts ---
    # ONE INCIDENT PER DISPATCH CYCLE. _dispatch_history() classifies a
    # dispatch by its own incident's verdict, and Module 3's fallback walker
    # never dispatches the same responder twice to the same incident — so
    # stacking all four cycles into one incident describes a state that cannot
    # occur in production and would make every dispatch inherit that single
    # incident's timeout verdict.
    base_t = datetime.now(timezone.utc) - timedelta(hours=2)
    for k in range(4):
        t_disp = base_t + timedelta(minutes=k * 30)
        ghost = _make_incident("VILLAGE-B", "moderate")
        ghost.responder_assigned_id = "RESP-03"
        ghost.dispatch_events = [
            {
                "event": "responder_dispatched",
                "responder_id": "RESP-03",
                "tier": "moderate",
                "timestamp": t_disp.isoformat(),
            },
            {
                "event": "ack_timeout",
                "responder_id": "RESP-03",
                "timeout_s": 90,
                "timestamp": (t_disp + timedelta(seconds=90)).isoformat(),
            },
        ]
        slice_runner.INCIDENT_STORE.append({
            "incident": ghost.model_dump(),
            "dispatch_status": "dispatched",
            "logged_at": t_disp.isoformat(),
        })

    perf3 = getResponderPerformanceRecord("RESP-03")
    _assert(
        perf3["timeout_count"] == 4
        and perf3["status_flag"] == "under_review",
        "S6.1 RESP-03 -> under_review (4 consecutive timeouts > limit of 3)",
        f"timeout_count=4 status_flag={perf3['status_flag']}",
        f"expected under_review with 4 consecutive timeouts, got {perf3['status_flag']} "
        f"(timeout_count={perf3['timeout_count']})",
    )

    # --- NEEDS_FOLLOW_UP: RESP-04 with 2 concerns in recent 5 dispatches ---
    # 5 dispatch cycles, again one incident each: the first 3 acknowledged and
    # completed, the last 2 ghosted. The two timeouts are the most recent, so
    # they land inside the 5-dispatch recent-concern window but do not form a
    # run longer than the under_review limit of 3.
    base_t2 = datetime.now(timezone.utc) - timedelta(hours=1)
    for k in range(5):
        t_disp = base_t2 + timedelta(minutes=k * 10)
        ghost2 = _make_incident("VILLAGE-B", "moderate")
        ghost2.responder_assigned_id = "RESP-04"
        events2 = [{
            "event": "responder_dispatched",
            "responder_id": "RESP-04",
            "tier": "moderate",
            "timestamp": t_disp.isoformat(),
        }]
        if k < 3:
            events2.append({
                "event": "responder_acknowledged",
                "responder_id": "RESP-04",
                "timestamp": (t_disp + timedelta(seconds=30)).isoformat(),
            })
        else:
            events2.append({
                "event": "ack_timeout",
                "responder_id": "RESP-04",
                "timeout_s": 90,
                "timestamp": (t_disp + timedelta(seconds=90)).isoformat(),
            })
        ghost2.dispatch_events = events2
        slice_runner.INCIDENT_STORE.append({
            "incident": ghost2.model_dump(),
            "dispatch_status": "dispatched",
            "logged_at": t_disp.isoformat(),
        })

    perf4 = getResponderPerformanceRecord("RESP-04")
    _assert(
        perf4["timeout_count"] == 2
        and perf4["status_flag"] == "needs_follow_up",
        "S6.2 RESP-04 -> needs_follow_up (2 of last 5 dispatches are timeouts)",
        f"timeout_count=2 status_flag={perf4['status_flag']}",
        f"expected needs_follow_up, got {perf4['status_flag']} "
        f"(timeout_count={perf4['timeout_count']})",
    )

    # --- ACTIVE: RESP-05 with clean record ---
    inc, decision, receipt = _dispatch_close_record("VILLAGE-C")
    assert decision.selected_responder.responder_id == "RESP-05"
    assert receipt["status"] == "recorded"
    perf5 = getResponderPerformanceRecord("RESP-05")
    _assert(
        perf5["incidents_responded_to"] == 1
        and perf5["status_flag"] == "active",
        "S6.3 RESP-05 -> active (1 completed incident, no concerns)",
        f"responded_to=1 status_flag={perf5['status_flag']}",
        f"expected active/1, got {perf5['status_flag']}/{perf5['incidents_responded_to']}",
    )

    # --- DB row: status_flag stored via reliability_tier column ---
    row = get_responder_from_db("RESP-03")
    # Note: _sync_responder_status is only called when awardPointsForIncident
    # fires. Since RESP-03's historical incident was injected without going
    # through awardPointsForIncident, the DB row may still be at seed default.
    # The status_flag computed in-memory is what matters for the logic test above.
    # For DB persistence, trigger it explicitly via a manual sync:
    from services.accountability_service import _sync_responder_status
    _sync_responder_status("RESP-03")
    row3 = get_responder_from_db("RESP-03")
    _assert(
        row3 is not None and row3["reliability_tier"] == "under_review",
        "S6.4 DB reliability_tier='under_review' persisted for RESP-03",
        f"reliability_tier={row3['reliability_tier'] if row3 else None}",
        f"expected under_review, got {row3['reliability_tier'] if row3 else None}",
    )


# ===========================================================================
# S7 — Mixed-outcome portfolio: the example ResponderPerformanceRecord
# ===========================================================================

def test_s7_mixed_outcome_portfolio():
    """Build a realistic responder history — four BHU-confirmed closures with
    DIFFERENT outcomes, plus one ghosted dispatch and one explicit decline —
    then print and assert the complete ResponderPerformanceRecord.

    This is the shape sanity-check: it proves the record reports facts (what
    happened, how often, how fast) and never a score. The only evaluative
    output is the threshold-based status_flag.
    """
    _sep("S7 — Mixed-outcome portfolio: full ResponderPerformanceRecord shape")
    _db_reset()

    def _verified_cycle(outcome: str, tier: str = "moderate",
                        ack_delay_s: float = 0.4):
        """dispatch -> acknowledge -> close (bhu_staff) -> record.

        acknowledgeDispatch cancels the 2 s ack timer (so no spurious
        ack_timeout can pollute timeout_count) and produces the real
        responder_acknowledged event that average_response_time_seconds is
        measured from.
        """
        inc = _make_incident("VILLAGE-A", tier)
        decision = _dispatch_and_log(inc)
        assert decision.selected_responder is not None, "no responder dispatched"
        assert decision.selected_responder.responder_id == "RESP-02"
        time.sleep(ack_delay_s)
        acknowledgeDispatch(inc.incident_id, "RESP-02")
        closeIncident(inc.incident_id, outcome, "bhu_staff")
        return inc, awardPointsForIncident(inc.incident_id)

    # --- Four BHU-confirmed closures, one of each trackable outcome ---
    receipts = {}
    for outcome in ("taken_to_bhu", "referred_to_hospital",
                    "self-resolved", "unresolved"):
        tier = "critical" if outcome == "referred_to_hospital" else "moderate"
        _, receipt = _verified_cycle(outcome, tier=tier)
        receipts[outcome] = receipt["status"]

    _assert(
        all(s == "recorded" for s in receipts.values()),
        "S7.1 all four BHU-confirmed outcomes recorded (one ledger row each)",
        f"{receipts}",
        f"expected all recorded, got {receipts}",
    )

    # --- One ghosted dispatch and one explicit decline, both MORE RECENT than
    # --- the four completions, so they land in the recent-concern window.
    now = datetime.now(timezone.utc)

    def _inject_history(kind: str, offset_s: int) -> None:
        """Fabricate a historical record exactly as Module 3 would have logged
        it (same technique as S4/S6) — no closure, so it contributes to the
        dispatch audit but never to incidents_by_outcome."""
        inc = _make_incident("VILLAGE-A", "moderate")
        t_disp = now + timedelta(seconds=offset_s)
        inc.responder_assigned_id = "RESP-02"
        events = [{
            "event": "responder_dispatched",
            "responder_id": "RESP-02",
            "responder_name": "Farhan Ali",
            "tier": "moderate",
            "timestamp": t_disp.isoformat(),
        }]
        if kind == "timeout":
            events.append({
                "event": "ack_timeout",
                "responder_id": "RESP-02",
                "timeout_s": 90,
                "timestamp": (t_disp + timedelta(seconds=90)).isoformat(),
            })
        else:
            events.append({
                "event": "responder_declined",
                "responder_id": "RESP-02",
                "reason": "already accompanying another patient to the BHU",
                "timestamp": (t_disp + timedelta(seconds=20)).isoformat(),
            })
        inc.dispatch_events = events
        slice_runner.INCIDENT_STORE.append({
            "incident": inc.model_dump(),
            "dispatch_status": "dispatched",
            "logged_at": t_disp.isoformat(),
        })

    _inject_history("declined", 60)
    _inject_history("timeout", 120)

    perf = getResponderPerformanceRecord("RESP-02")

    print("\n  [EXAMPLE ResponderPerformanceRecord — realistic mixed outcomes]")
    print("  {")
    print(f"    \"responder_id\": \"{perf['responder_id']}\",")
    print(f"    \"incidents_responded_to\": {perf['incidents_responded_to']},")
    print("    \"incidents_by_outcome\": {")
    for _k, _v in perf["incidents_by_outcome"].items():
        print(f"      \"{_k}\": {_v},")
    print("    },")
    print("    \"average_response_time_seconds\": "
          f"{perf['average_response_time_seconds']},")
    print(f"    \"timeout_count\": {perf['timeout_count']},")
    print(f"    \"decline_count\": {perf['decline_count']},")
    print("    \"dispatch_metrics\": {")
    for _k, _v in perf["dispatch_metrics"].items():
        print(f"      \"{_k}\": {_v},")
    print("    },")
    print(f"    \"status_flag\": \"{perf['status_flag']}\"")
    print("  }")

    _assert(
        perf["incidents_responded_to"] == 4
        and perf["incidents_by_outcome"] == {
            "self-resolved": 1,
            "taken_to_bhu": 1,
            "referred_to_hospital": 1,
            "unresolved": 1,
        },
        "S7.2 incidents_by_outcome counts one of each trackable outcome",
        f"responded_to={perf['incidents_responded_to']} "
        f"by_outcome={perf['incidents_by_outcome']}",
        f"outcome breakdown mismatch: {perf['incidents_by_outcome']}",
    )
    _assert(
        perf["timeout_count"] == 1 and perf["decline_count"] == 1,
        "S7.3 timeout_count=1 and decline_count=1 from the dispatch audit",
        f"timeout={perf['timeout_count']} decline={perf['decline_count']}",
        f"expected 1/1, got {perf['timeout_count']}/{perf['decline_count']}",
    )
    _assert(
        perf["average_response_time_seconds"] > 0.0,
        "S7.4 average_response_time_seconds measured from real ack events",
        f"avg={perf['average_response_time_seconds']}s over 4 acked dispatches",
        f"expected > 0.0, got {perf['average_response_time_seconds']}",
    )
    _assert(
        perf["dispatch_metrics"]["total_assigned"] == 6
        and perf["dispatch_metrics"]["completed"] == 4
        and perf["dispatch_metrics"]["acceptance_rate_pct"] == 66.7,
        "S7.5 dispatch_metrics: 6 assigned, 4 completed, 66.7% acceptance",
        f"{perf['dispatch_metrics']}",
        f"dispatch metrics mismatch: {perf['dispatch_metrics']}",
    )
    _assert(
        perf["status_flag"] == "needs_follow_up",
        "S7.6 status_flag=needs_follow_up (2 concerns in the last 5 dispatches)",
        "needs_follow_up — a human check-in signal, not a penalty",
        f"expected needs_follow_up, got {perf['status_flag']}",
    )
    _assert(
        set(perf.keys()) == {
            "responder_id", "incidents_responded_to", "incidents_by_outcome",
            "average_response_time_seconds", "timeout_count", "decline_count",
            "dispatch_metrics", "status_flag",
        },
        "S7.7 record shape is exactly the metrics contract (no points/tier keys)",
        f"keys={sorted(perf.keys())}",
        f"unexpected record keys: {sorted(perf.keys())}",
    )


# ===========================================================================
# S8 — REGRESSION: persisted status_flag survives a later dispatch/release
# ===========================================================================

VALID_STATUS_FLAGS = ("active", "needs_follow_up", "under_review")


def test_s8_status_flag_survives_redispatch():
    """Regression for the full-row-upsert clobber.

    The availability write-through used to call upsert_responder_to_db()
    without reliability_tier, whose default is "bronze". Because that helper's
    ON CONFLICT clause writes every kwarg, each dispatch or release overwrote
    the status_flag Module 5 persists in that column with "bronze" — a value
    that is not a valid status flag at all. Every mutation point now calls
    update_responder_availability(), which touches ONLY the status column.
    """
    _sep("S8 — REGRESSION: status_flag survives a later dispatch + release")
    _db_reset()

    # --- 1. One BHU-confirmed closure persists status_flag="active" ---
    inc1 = _make_incident("VILLAGE-A", "moderate")
    decision1 = _dispatch_and_log(inc1)
    _assert(
        decision1.selected_responder is not None
        and decision1.selected_responder.responder_id == "RESP-02",
        "S8.1 first incident dispatched to RESP-02",
        "selected=RESP-02",
        f"expected RESP-02, got "
        f"{decision1.selected_responder.responder_id if decision1.selected_responder else None}",
    )
    acknowledgeDispatch(inc1.incident_id, "RESP-02")  # cancels the 2s ack timer
    closeIncident(inc1.incident_id, "taken_to_bhu", "bhu_staff")
    receipt1 = awardPointsForIncident(inc1.incident_id)

    row1 = get_responder_from_db("RESP-02")
    _assert(
        receipt1["status"] == "recorded"
        and row1 is not None
        and row1["reliability_tier"] == "active",
        "S8.2 status_flag='active' persisted after the confirmed closure",
        f"reliability_tier={row1['reliability_tier'] if row1 else None}",
        f"expected recorded/active, got {receipt1.get('status')}/"
        f"{row1['reliability_tier'] if row1 else None}",
    )

    # --- 2. Re-dispatch the SAME responder: the busy write-through fires ---
    inc2 = _make_incident("VILLAGE-A", "moderate")
    decision2 = _dispatch_and_log(inc2)
    _assert(
        decision2.selected_responder is not None
        and decision2.selected_responder.responder_id == "RESP-02",
        "S8.3 RESP-02 released and re-dispatched to a second incident",
        "selected=RESP-02",
        f"expected RESP-02, got "
        f"{decision2.selected_responder.responder_id if decision2.selected_responder else None}",
    )
    acknowledgeDispatch(inc2.incident_id, "RESP-02")  # cancels the 2s ack timer

    row2 = get_responder_from_db("RESP-02")
    _assert(
        row2 is not None
        and row2["current_availability_status"] == "busy"
        and row2["reliability_tier"] in VALID_STATUS_FLAGS,
        "S8.4 busy write-through did NOT clobber the persisted status_flag",
        f"status={row2['current_availability_status']} "
        f"flag={row2['reliability_tier']}",
        f"status_flag clobbered by the busy write-through: "
        f"{row2['reliability_tier'] if row2 else None} "
        f"(valid values: {VALID_STATUS_FLAGS})",
    )

    # --- 3. The release path must not clobber it either ---
    closeIncident(inc2.incident_id, "self-resolved", "bhu_staff")

    row3 = get_responder_from_db("RESP-02")
    _assert(
        row3 is not None
        and row3["current_availability_status"] == "available"
        and row3["reliability_tier"] in VALID_STATUS_FLAGS,
        "S8.5 available write-through did NOT clobber the persisted status_flag",
        f"status={row3['current_availability_status']} "
        f"flag={row3['reliability_tier']}",
        f"status_flag clobbered by the release write-through: "
        f"{row3['reliability_tier'] if row3 else None}",
    )

    # --- 4. Both closures counted; the flag is recomputed, not stored blindly ---
    awardPointsForIncident(inc2.incident_id)
    perf = getResponderPerformanceRecord("RESP-02")
    _assert(
        perf["incidents_responded_to"] == 2
        and perf["incidents_by_outcome"]["taken_to_bhu"] == 1
        and perf["incidents_by_outcome"]["self-resolved"] == 1
        and perf["status_flag"] == "active",
        "S8.6 both closures counted, status_flag recomputed to 'active'",
        f"responded_to={perf['incidents_responded_to']} "
        f"status_flag={perf['status_flag']}",
        f"performance record wrong after re-dispatch: {perf}",
    )


# ===========================================================================
# RUNNER
# ===========================================================================

def main() -> int:
    print("=" * 70)
    print("  MODULE 5 TEST SUITE — Responder Performance Record & Accountability")
    print("  (factual metrics — zero AI calls; PostgreSQL via Module 6.5)")
    print("=" * 70)

    test_s1_bhu_confirmed_record()
    test_s2_fraud_prevention()
    test_s3_referred_to_hospital()
    test_s4_historical_timeout_audit()
    test_s5_fallback_responder_handling()
    test_s6_status_flag_logic()
    test_s7_mixed_outcome_portfolio()
    test_s8_status_flag_survives_redispatch()

    passed = sum(1 for r in _RESULTS if r[0] == "PASS")
    total = len(_RESULTS)
    print(f"\n{'=' * 70}")
    print(f"  MODULE 5 RESULTS: {passed}/{total} checks passed, {_FAILURES} failures")
    print("=" * 70)
    return 0 if _FAILURES == 0 else 1


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    sys.exit(main())
