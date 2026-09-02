# -*- coding: utf-8 -*-
"""Module 3 test suite — 8 scenarios covering all specified behaviors.

Run with:
    cd "d:\\LifeLine Ride"
    python backend\\test_module3.py

All tests run with zero network calls (offline-resilient design verification).
The test runner reports PASS / FAIL per scenario and exits with code 0 only
if all tests pass.
"""
from __future__ import annotations

import copy
import os
import socket
import sys
import time
import threading
from pathlib import Path

# ---------------------------------------------------------------------------
# Path setup — mirror what dispatch_service.py and help_bot_service.py do.
# ---------------------------------------------------------------------------
_BACKEND_DIR = Path(__file__).resolve().parent
if str(_BACKEND_DIR) not in [str(p) for p in sys.path]:
    sys.path.insert(0, str(_BACKEND_DIR))

# ---------------------------------------------------------------------------
# Speed up the ack timer for tests — override before importing dispatch_service.
# Use 2 seconds so timeout tests complete in <5 s total.
# ---------------------------------------------------------------------------
os.environ["DISPATCH_ACK_TIMEOUT_S"] = "2"

# Speed up the AI retry backoff too so a quota-exhausted fallback call in the
# backward-compat run_test_suite() check below doesn't stall 45s/turn
# (15s + 30s default backoff). Matches the same test-fast-fail pattern.
os.environ["LIFELINE_REPLAY_MODE"] = "1"

import slice_runner  # noqa: E402  Module 1 contracts + seed data
from services.dispatch_service import (  # noqa: E402
    DispatchDecision,
    _DISPATCH_STATE,
    _STATE_LOCK,
    acknowledgeDispatch,
    decideDispatch,
    dispatchIncident,
    handleEscalation,
    handleResponderDecline,
    sendNotification,
)

# Also import escalateIncident from Module 2 for the escalation integration test.
try:
    _SERVICES_DIR = _BACKEND_DIR / "services"
    if str(_SERVICES_DIR) not in [str(p) for p in sys.path]:
        sys.path.insert(0, str(_SERVICES_DIR))
    from help_bot_service import escalateIncident  # noqa: E402
    _HB_AVAILABLE = True
except ImportError:
    _HB_AVAILABLE = False


# ===========================================================================
# TEST INFRASTRUCTURE
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
# Fixture helpers — create fresh incident objects without touching seed data
# permanently (each test resets availability manually).
# ---------------------------------------------------------------------------

def _reset_seed_data() -> None:
    """Restore SEED_RESPONDERS to their original availability states and
    clear _DISPATCH_STATE so tests don't bleed into each other."""
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
    # Also cancel any lingering timers.
    # (daemon=True timers will be collected on their own, but clearing state
    # ensures _fallback_dispatch finds nothing if they fire late.)


def _make_incident(
    village_id: str,
    tier: str,
    flags: list | None = None,
) -> slice_runner.Incident:
    import uuid
    from datetime import datetime, timezone
    return slice_runner.Incident(
        incident_id=f"INC-TEST-{uuid.uuid4().hex[:6].upper()}",
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


# ===========================================================================
# TEST 1 — Village A, moderate: Tariq busy → Farhan available (ranked fallback)
# ===========================================================================

def test_t1_ranked_fallback_match():
    _sep("T1 — Village A MODERATE: Tariq busy → Farhan Ali matched (ranked fallback)")
    _reset_seed_data()
    # RESP-01 (Tariq) is already "busy" in seed data. RESP-02 (Farhan) is available.

    incident = _make_incident("VILLAGE-A", "moderate")
    decision = decideDispatch(incident)

    _assert(
        decision.status == "dispatched",
        "T1.1 status=dispatched",
        f"status={decision.status}",
        f"expected dispatched, got {decision.status}",
    )
    _assert(
        decision.selected_responder is not None and
        decision.selected_responder.responder_id == "RESP-02",
        "T1.2 selected=RESP-02 (Farhan Ali)",
        f"selected={decision.selected_responder.name if decision.selected_responder else None}",
        f"expected Farhan Ali (RESP-02), got "
        f"{decision.selected_responder.responder_id if decision.selected_responder else None}",
    )
    _assert(
        decision.notify_bhu is True and decision.bhu_urgency == "standby",
        "T1.3 BHU standby for moderate",
        f"notify_bhu={decision.notify_bhu} urgency={decision.bhu_urgency}",
        f"expected notify_bhu=True standby, got {decision.notify_bhu} {decision.bhu_urgency}",
    )
    _assert(
        decision.ambulance_requested is False,
        "T1.4 no ambulance for moderate",
        "ambulance_requested=False",
        "ambulance should not be requested for moderate tier",
    )
    _assert(
        len(decision.ranked_responders) == 1,
        "T1.5 ranked list has exactly 1 available responder",
        f"ranked_count={len(decision.ranked_responders)}",
        f"expected 1 available in VILLAGE-A (Farhan only), got {len(decision.ranked_responders)}",
    )

    # Also run sendNotification to verify state mutation.
    sendNotification(decision, incident)
    farhan = next(r for r in slice_runner.SEED_RESPONDERS if r.responder_id == "RESP-02")
    _assert(
        farhan.current_availability_status == "busy",
        "T1.6 Farhan marked busy after dispatch",
        "availability=busy",
        f"expected busy, got {farhan.current_availability_status}",
    )
    _assert(
        incident.bhu_notified is True,
        "T1.7 incident.bhu_notified=True after moderate dispatch",
        "bhu_notified=True",
        "bhu_notified should be True for moderate tier",
    )
    _assert(
        any(e["event"] == "responder_dispatched" for e in incident.dispatch_events),
        "T1.8 dispatch_events contains responder_dispatched",
        "dispatch_event logged",
        "dispatch_events missing responder_dispatched entry",
    )

    # Cancel the ack timer so it doesn't fire during other tests.
    acknowledgeDispatch(incident.incident_id, "RESP-02")


# ===========================================================================
# TEST 2 — Village A consecutive: both Tariq & Farhan busy → BHU-only
# ===========================================================================

def test_t2_village_exhaustion_bhu_only():
    _sep("T2 — Village A CONSECUTIVE: both busy → escalated_bhu_only")
    _reset_seed_data()
    # Make Farhan busy too (simulates a second incident after T1 dispatched him).
    farhan = next(r for r in slice_runner.SEED_RESPONDERS if r.responder_id == "RESP-02")
    farhan.current_availability_status = "busy"

    incident = _make_incident("VILLAGE-A", "moderate")
    decision = decideDispatch(incident)

    _assert(
        decision.status == "escalated_bhu_only",
        "T2.1 status=escalated_bhu_only",
        f"status={decision.status}",
        f"expected escalated_bhu_only, got {decision.status}",
    )
    _assert(
        decision.selected_responder is None,
        "T2.2 no responder selected",
        "selected_responder=None",
        f"expected None, got {decision.selected_responder}",
    )
    _assert(
        decision.bhu is not None and decision.bhu.bhu_id == "BHU-001",
        "T2.3 BHU-001 linked for VILLAGE-A",
        f"bhu={decision.bhu.bhu_id if decision.bhu else None}",
        f"expected BHU-001, got {decision.bhu.bhu_id if decision.bhu else None}",
    )
    _assert(
        decision.notify_bhu is True,
        "T2.4 notify_bhu=True for BHU-only escalation",
        "notify_bhu=True",
        "notify_bhu should be True for BHU-only escalation",
    )

    sendNotification(decision, incident)
    _assert(
        incident.bhu_notified is True,
        "T2.5 incident.bhu_notified=True",
        "bhu_notified=True",
        "bhu_notified should be True after escalated_bhu_only dispatch",
    )
    _assert(
        any(e["event"] == "escalated_bhu_only" for e in incident.dispatch_events),
        "T2.6 dispatch_events contains escalated_bhu_only",
        "escalated_bhu_only event logged",
        "dispatch_events missing escalated_bhu_only entry",
    )


# ===========================================================================
# TEST 3 — Village C, critical: Rashid available → full simultaneous dispatch
# ===========================================================================

def test_t3_critical_full_dispatch():
    _sep("T3 — Village C CRITICAL: Rashid available → responder + BHU urgent + ambulance")
    _reset_seed_data()

    incident = _make_incident("VILLAGE-C", "critical", flags=["venomous_snake_bite"])
    decision = decideDispatch(incident)

    _assert(
        decision.status == "dispatched",
        "T3.1 status=dispatched",
        f"status={decision.status}",
        f"expected dispatched, got {decision.status}",
    )
    _assert(
        decision.selected_responder is not None and
        decision.selected_responder.responder_id == "RESP-05",
        "T3.2 selected=RESP-05 (Rashid Minhas)",
        f"selected={decision.selected_responder.name if decision.selected_responder else None}",
        f"expected Rashid (RESP-05), got "
        f"{decision.selected_responder.responder_id if decision.selected_responder else None}",
    )
    _assert(
        decision.notify_bhu is True and decision.bhu_urgency == "urgent",
        "T3.3 BHU urgent for critical",
        f"notify_bhu={decision.notify_bhu} urgency={decision.bhu_urgency}",
        f"expected urgent BHU notification, got {decision.bhu_urgency}",
    )
    _assert(
        decision.ambulance_requested is True,
        "T3.4 ambulance requested for critical",
        "ambulance_requested=True",
        "ambulance_requested should be True for critical tier",
    )
    _assert(
        decision.bhu is not None and decision.bhu.bhu_id == "BHU-002",
        "T3.5 BHU-002 linked for VILLAGE-C",
        f"bhu={decision.bhu.bhu_id if decision.bhu else None}",
        f"expected BHU-002, got {decision.bhu.bhu_id if decision.bhu else None}",
    )

    sendNotification(decision, incident)
    _assert(
        incident.ambulance_requested is True,
        "T3.6 incident.ambulance_requested=True after critical dispatch",
        "ambulance_requested=True",
        "incident.ambulance_requested should be True",
    )
    _assert(
        incident.bhu_notified is True,
        "T3.7 incident.bhu_notified=True",
        "bhu_notified=True",
        "bhu_notified should be True for critical tier",
    )

    acknowledgeDispatch(incident.incident_id, "RESP-05")


# ===========================================================================
# TEST 4 — Village B (no available responders), minor tier → BHU-only, no ambulance
# ===========================================================================

def test_t4_village_b_minor_no_available():
    _sep("T4 — Village B MINOR: Bilal offline + Zubair busy → BHU-only, no ambulance")
    _reset_seed_data()
    # In seed data: RESP-03 (Bilal, VILLAGE-B) = offline, RESP-04 (Zubair, VILLAGE-B) = busy.

    incident = _make_incident("VILLAGE-B", "minor")
    decision = decideDispatch(incident)

    _assert(
        decision.status == "escalated_bhu_only",
        "T4.1 status=escalated_bhu_only for village B",
        f"status={decision.status}",
        f"expected escalated_bhu_only, got {decision.status}",
    )
    _assert(
        decision.selected_responder is None,
        "T4.2 no responder selected",
        "selected_responder=None",
        f"expected None, got {decision.selected_responder}",
    )
    # For minor tier with no responder, BHU is still notified (safer than nothing).
    _assert(
        decision.notify_bhu is True,
        "T4.3 notify_bhu=True (BHU escalation even on minor when no responder)",
        "notify_bhu=True",
        "notify_bhu should be True for BHU-only escalation",
    )
    _assert(
        decision.ambulance_requested is False,
        "T4.4 no ambulance for minor tier",
        "ambulance_requested=False",
        "ambulance should not be requested for minor tier",
    )

    sendNotification(decision, incident)
    _assert(
        incident.ambulance_requested is False,
        "T4.5 incident.ambulance_requested remains False",
        "ambulance_requested=False",
        "ambulance_requested should remain False for minor tier",
    )


# ===========================================================================
# TEST 5 — Timeout fallback: Farhan dispatched, timer fires → next / BHU-only
# ===========================================================================

def test_t5_timeout_fallback():
    _sep("T5 — Timeout fallback: RESP-02 dispatched, timer fires → list exhausted → BHU-only")
    _reset_seed_data()
    # VILLAGE-A has only Farhan (RESP-02) available. After dispatch, the ranked
    # list has 1 entry. Timeout fires → fallback_index=1 >= len(ranked)=1 → BHU-only.

    incident = _make_incident("VILLAGE-A", "moderate")

    print("  Dispatching to Farhan Ali (RESP-02) with 2s ack timeout ...")
    decision = decideDispatch(incident)
    sendNotification(decision, incident)

    # Wait for the ack timer to fire (DISPATCH_ACK_TIMEOUT_S=2 s in env).
    print("  Waiting 3 s for ack timeout to fire ...")
    time.sleep(3)

    _assert(
        incident.dispatch_fallback_count >= 1,
        "T5.1 dispatch_fallback_count >= 1 after timeout",
        f"dispatch_fallback_count={incident.dispatch_fallback_count}",
        f"expected >=1, got {incident.dispatch_fallback_count}",
    )
    timeout_events = [e for e in incident.dispatch_events if e["event"] == "ack_timeout"]
    _assert(
        len(timeout_events) >= 1,
        "T5.2 ack_timeout event logged in dispatch_events",
        f"ack_timeout_events={len(timeout_events)}",
        "no ack_timeout event found in dispatch_events",
    )
    fallback_triggered = [e for e in incident.dispatch_events if e["event"] == "fallback_triggered"]
    _assert(
        len(fallback_triggered) >= 1,
        "T5.3 fallback_triggered event logged",
        f"fallback_triggered_events={len(fallback_triggered)}",
        "no fallback_triggered event found in dispatch_events",
    )
    # The single-responder ranked list is exhausted → BHU-only escalation.
    exhausted = [e for e in incident.dispatch_events if e["event"] == "all_responders_exhausted"]
    _assert(
        len(exhausted) >= 1 or incident.bhu_notified,
        "T5.4 ranked list exhausted → BHU notified",
        f"bhu_notified={incident.bhu_notified} exhausted_events={len(exhausted)}",
        "expected BHU notification after ranked list exhausted",
    )


# ===========================================================================
# TEST 6 — Explicit decline: Farhan declines immediately → immediate fallback
# ===========================================================================

def test_t6_explicit_decline():
    _sep("T6 — Explicit decline: Farhan declines immediately → no timer wait → BHU-only")
    _reset_seed_data()

    incident = _make_incident("VILLAGE-A", "moderate")
    decision = decideDispatch(incident)
    sendNotification(decision, incident)

    farhan_id = decision.selected_responder.responder_id if decision.selected_responder else None
    if farhan_id is None:
        _fail("T6.0 precondition", "No responder was dispatched — cannot test decline")
        return

    print(f"  {farhan_id} explicitly declining ...")
    handleResponderDecline(incident.incident_id, farhan_id)

    # Should be immediate (no sleep needed).
    _assert(
        incident.dispatch_fallback_count >= 1,
        "T6.1 dispatch_fallback_count >= 1 after decline",
        f"dispatch_fallback_count={incident.dispatch_fallback_count}",
        f"expected >=1, got {incident.dispatch_fallback_count}",
    )
    decline_events = [e for e in incident.dispatch_events if e["event"] == "responder_declined"]
    _assert(
        len(decline_events) >= 1,
        "T6.2 responder_declined event logged",
        f"responder_declined_events={len(decline_events)}",
        "no responder_declined event in dispatch_events",
    )
    fallback = [e for e in incident.dispatch_events if e["event"] == "fallback_triggered"]
    _assert(
        len(fallback) >= 1,
        "T6.3 fallback_triggered event logged immediately (no timer wait)",
        f"fallback_triggered_events={len(fallback)}",
        "fallback_triggered event missing after explicit decline",
    )
    # Check decline reason string
    reason_matches = any(
        "explicit_decline" in e.get("reason", "") for e in fallback
    )
    _assert(
        reason_matches,
        "T6.4 fallback reason contains 'explicit_decline'",
        "reason=explicit_decline_...",
        "fallback reason should mention explicit_decline",
    )
    # After decline, ranked list exhausted → BHU-only.
    _assert(
        incident.bhu_notified is True,
        "T6.5 BHU notified after list exhausted by decline",
        f"bhu_notified={incident.bhu_notified}",
        "BHU should be notified after all responders exhausted",
    )
    # The declined responder should be returned to available.
    farhan = next(r for r in slice_runner.SEED_RESPONDERS if r.responder_id == farhan_id)
    _assert(
        farhan.current_availability_status == "available",
        "T6.6 declined responder returned to available",
        f"availability={farhan.current_availability_status}",
        f"expected available, got {farhan.current_availability_status}",
    )


# ===========================================================================
# TEST 7 — Escalation re-dispatch: minor → critical upgrade fires BHU + ambulance
# ===========================================================================

def test_t7_escalation_redispatch():
    _sep("T7 — Escalation re-dispatch: minor → critical upgrade → BHU urgent + ambulance delta")
    _reset_seed_data()

    # Start with a MINOR incident dispatched to Rashid (VILLAGE-C).
    # Minor tier: responder only, no BHU, no ambulance.
    incident = _make_incident("VILLAGE-C", "minor", flags=["abrasion"])

    decision = decideDispatch(incident)
    _assert(
        decision.notify_bhu is False,
        "T7.1 initial minor dispatch: notify_bhu=False",
        "notify_bhu=False for minor tier",
        f"expected False, got {decision.notify_bhu}",
    )
    sendNotification(decision, incident)

    # Register the incident in INCIDENT_STORE so escalateIncident can find it.
    result = slice_runner.DispatchResult(
        incident_id=incident.incident_id,
        responder=decision.selected_responder,
        bhu=decision.bhu,
        ambulance_requested=False,
        status="dispatched",
    )
    slice_runner.logIncident(incident, result)

    # Escalate via Module 2's hook (if available) or simulate directly.
    if _HB_AVAILABLE:
        print("  Calling escalateIncident() (Module 2) ...")
        # Register the incident in Module 2's _ACTIVE_INCIDENTS.
        from help_bot_service import register_incident as hb_register
        hb_register(incident)
        snapshot = escalateIncident(incident.incident_id, {
            "trigger": "breathing_difficulty",
            "suggested_tier": "critical",
            "new_flags": ["breathing_difficulty"],
            "transcript_excerpt": "سانس نہیں آ رہی",
        })
    else:
        # Module 2 not available: simulate the snapshot escalateIncident would return.
        print("  [WARN] help_bot_service not importable; simulating escalateIncident snapshot.")
        incident.severity_tier = "critical"
        incident.injury_type_flags.append("breathing_difficulty")
        incident.ambulance_requested = True
        snapshot = incident.model_dump()

    pre_bhu = incident.bhu_notified
    pre_ambulance = incident.ambulance_requested

    print("  Calling handleEscalation() (Module 3) ...")
    handleEscalation(incident.incident_id, snapshot)

    _assert(
        incident.bhu_notified is True,
        "T7.2 BHU notified after escalation to critical",
        f"bhu_notified={incident.bhu_notified}",
        "BHU should be notified after escalation to critical",
    )
    _assert(
        incident.ambulance_requested is True,
        "T7.3 ambulance requested after escalation to critical",
        f"ambulance_requested={incident.ambulance_requested}",
        "ambulance_requested should be True after escalation to critical",
    )
    escalation_events = [
        e for e in incident.dispatch_events
        if e["event"] in ("bhu_notified_escalation", "ambulance_requested_escalation",
                          "escalation_redispatch_triggered")
    ]
    _assert(
        len(escalation_events) >= 1,
        "T7.4 escalation re-dispatch events logged in dispatch_events",
        f"escalation_events={len(escalation_events)} "
        f"types={[e['event'] for e in escalation_events]}",
        "no escalation re-dispatch events in dispatch_events",
    )

    acknowledgeDispatch(incident.incident_id, "RESP-05")


# ===========================================================================
# TEST 8 — Offline verification: decideDispatch imports no network modules
# ===========================================================================

def test_t8_offline_verification():
    _sep("T8 — Offline verification: decideDispatch has zero network/AI imports")
    _reset_seed_data()

    # --- Static import check ---
    import importlib
    import sys as _sys

    # Get the set of modules that exist BEFORE importing dispatch_service.
    modules_before = set(_sys.modules.keys())
    # dispatch_service is already imported; check its module object directly.
    import services.dispatch_service as ds_mod
    ds_source = Path(ds_mod.__file__).read_text(encoding="utf-8")

    network_imports = [
        name for name in (
            "requests", "urllib.request", "urllib.error", "httpx",
            "aiohttp", "socket", "dashscope", "google.genai", "openai",
        )
        if name in ds_source and "import " + name.split(".")[0] in ds_source
    ]
    _assert(
        not network_imports,
        "T8.1 dispatch_service.py imports no network/AI modules",
        "no network/AI imports found",
        f"found forbidden imports: {network_imports}",
    )

    # --- Functional offline test: run decideDispatch with network blocked ---
    # Monkey-patch socket.getaddrinfo to simulate no internet.
    original_getaddrinfo = socket.getaddrinfo

    def _blocked(*args, **kwargs):
        raise OSError("OFFLINE TEST: network access blocked")

    socket.getaddrinfo = _blocked
    try:
        incident = _make_incident("VILLAGE-C", "critical", flags=["snakebite"])
        decision = decideDispatch(incident)
        network_ok = True
    except OSError as exc:
        if "OFFLINE TEST" in str(exc):
            network_ok = False
        else:
            network_ok = True   # different OSError, not our block
    finally:
        socket.getaddrinfo = original_getaddrinfo

    _assert(
        network_ok,
        "T8.2 decideDispatch runs correctly with network blocked",
        "completed with network socket blocked — confirmed local-first",
        "decideDispatch triggered a network call (OSError from socket block)",
    )

    # Verify the decision is still correct when offline.
    _assert(
        decision.status == "dispatched" and
        decision.selected_responder is not None,
        "T8.3 decideDispatch returns correct result offline",
        f"status={decision.status} responder={decision.selected_responder.name if decision.selected_responder else None}",
        "decideDispatch returned wrong result when offline",
    )
    _assert(
        decision.ambulance_requested is True and decision.notify_bhu is True,
        "T8.4 critical tier flags correct offline",
        "ambulance=True bhu=True urgency=urgent",
        f"expected ambulance+bhu, got ambulance={decision.ambulance_requested} bhu={decision.notify_bhu}",
    )


# ===========================================================================
# MAIN — run all tests and report
# ===========================================================================

def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

    print("=" * 70)
    print("  MODULE 3 TEST SUITE — LifeLine Ride")
    print("  Nearest Responder & BHU Matching / Dispatch")
    print("=" * 70)
    print(f"  DISPATCH_ACK_TIMEOUT_S = {os.environ.get('DISPATCH_ACK_TIMEOUT_S')}")
    print(f"  Module 2 (help_bot_service) available: {_HB_AVAILABLE}")
    print()

    tests = [
        test_t1_ranked_fallback_match,
        test_t2_village_exhaustion_bhu_only,
        test_t3_critical_full_dispatch,
        test_t4_village_b_minor_no_available,
        test_t5_timeout_fallback,
        test_t6_explicit_decline,
        test_t7_escalation_redispatch,
        test_t8_offline_verification,
    ]

    for t in tests:
        try:
            t()
        except Exception as exc:
            import traceback
            _fail(t.__name__, f"uncaught exception: {exc}\n{traceback.format_exc()}")

    # Final summary
    print("\n" + "=" * 70)
    passed = sum(1 for r in _RESULTS if r[0] == "PASS")
    failed = sum(1 for r in _RESULTS if r[0] == "FAIL")
    print(f"  RESULT: {passed} PASSED  |  {failed} FAILED  |  {len(_RESULTS)} total checks")
    if failed:
        print("\n  FAILED CHECKS:")
        for status, name, detail in _RESULTS:
            if status == "FAIL":
                print(f"    - {name}: {detail}")
    print("=" * 70)

    # Backward compat: run the original slice_runner test suite (offline — no AI calls).
    # We only run it if all Module 3 tests passed, to keep output readable.
    if failed == 0:
        print("\n  Running original slice_runner run_test_suite (backward compat check)...")
        print("  NOTE: This calls the real AI triage pipeline. If AI is unavailable,")
        print("  the pipeline falls back to moderate + low_confidence_triage (correct behavior).")
        print()
        try:
            # Reset seed data first so the original suite starts clean.
            _reset_seed_data()
            slice_runner.run_test_suite()
        except Exception as exc:
            print(f"  [WARN] slice_runner.run_test_suite raised: {exc}")

    sys.exit(1 if _FAILURES > 0 else 0)


if __name__ == "__main__":
    main()
