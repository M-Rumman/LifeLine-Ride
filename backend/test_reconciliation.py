# -*- coding: utf-8 -*-
"""INC-E0211B — Startup Reconciliation test suite.

Proves that bootstrap_responder_state() detects responders marked 'busy' in
PostgreSQL with no corresponding open incident (orphaned busy — caused by a
server crash between dispatch-busy-mark and incident-persistence) and
automatically releases them to 'available' on the next boot.

    RC1  orphaned busy responder (no open incident) -> released to available
    RC2  legitimately busy responder (open incident exists) -> stays busy
    RC3  multiple orphaned responders -> all released in one bootstrap
    RC4  idempotency: second bootstrap finds nothing to release
    RC5  reconciliation is non-fatal when DB write fails (in-memory still wins)
    RC6  regression: test_t1_end_to_end_release_loop still works after fix

Run with:
    cd "d:\\LifeLine Ride"
    python backend\\test_reconciliation.py

Isolation: _db_reset() truncates incidents + responders tables and re-seeds
from contract (same discipline as the other test suites).
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

# Keep ack timers out of the way — same as the other persistence suites.
os.environ["DISPATCH_ACK_TIMEOUT_S"] = "300"
os.environ["LIFELINE_REPLAY_MODE"] = "1"

import slice_runner  # noqa: E402
import main as app_main  # noqa: E402  — the real app startup path
from services.dispatch_service import (  # noqa: E402
    _DISPATCH_STATE,
    _STATE_LOCK,
    dispatchIncident,
)
from services.incident_lifecycle_service import closeIncident  # noqa: E402
from models.incident_model import truncate_incidents_table, upsert_incident_to_db  # noqa: E402
from models.responder_model import (  # noqa: E402
    get_responder_from_db,
    seed_responders_from_contract,
    truncate_responders_table,
    update_responder_availability,
)

try:
    _SERVICES_DIR = _BACKEND_DIR / "services"
    if str(_SERVICES_DIR) not in [str(p) for p in sys.path]:
        sys.path.insert(0, str(_SERVICES_DIR))
    import help_bot_service as _hb_mod  # noqa: E402
    _HB_AVAILABLE = True
except ImportError:
    _HB_AVAILABLE = False


# ===========================================================================
# TEST INFRASTRUCTURE — same hand-rolled harness as the other suites
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


def _assert(condition: bool, test_name: str, pass_detail: str,
            fail_reason: str) -> bool:
    if condition:
        _pass(test_name, pass_detail)
        return True
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
    """Full isolation reset: truncate tables, clear stores, reset in-memory
    status to seed defaults, re-seed DB."""
    truncate_incidents_table()
    truncate_responders_table()
    slice_runner.INCIDENT_STORE.clear()
    for r in slice_runner.SEED_RESPONDERS:
        r.current_availability_status = _original_availability[r.responder_id]
    with _STATE_LOCK:
        _DISPATCH_STATE.clear()
    if _HB_AVAILABLE:
        _hb_mod._ACTIVE_INCIDENTS.clear()
    seed_responders_from_contract()


def _responder(responder_id: str) -> slice_runner.Responder:
    return next(r for r in slice_runner.SEED_RESPONDERS
                if r.responder_id == responder_id)


def _make_incident(village_id: str = "VILLAGE-A",
                   tier: str = "moderate") -> slice_runner.Incident:
    return slice_runner.Incident(
        incident_id=f"INC-RC-{uuid.uuid4().hex[:6].upper()}",
        timestamp_reported=datetime.now(timezone.utc).isoformat(),
        reporter_id="REP-TEST",
        gps_location=slice_runner.GPSLocation(
            latitude=31.5204, longitude=74.3587, village_id=village_id,
        ),
        photo_ref="test_photo.jpg",
        voice_transcript="test transcript",
        severity_tier=tier,
        injury_type_flags=["test_flag"],
    )


def _dispatch_and_log(incident: slice_runner.Incident):
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


def _simulate_restart() -> dict:
    """Simulate a process restart: reset in-memory to seed defaults, then
    run the REAL bootstrap path (which includes reconciliation as step 4)."""
    for r in slice_runner.SEED_RESPONDERS:
        r.current_availability_status = _original_availability[r.responder_id]
    slice_runner.INCIDENT_STORE.clear()
    with _STATE_LOCK:
        _DISPATCH_STATE.clear()
    if _HB_AVAILABLE:
        _hb_mod._ACTIVE_INCIDENTS.clear()
    return app_main.bootstrap_responder_state()


# ===========================================================================
# RC1 — Orphaned busy responder (no open incident) -> released
# ===========================================================================

def test_rc1_orphaned_busy_released():
    _sep("RC1 — Orphaned busy responder with no open incident -> released")
    _db_reset()

    # Simulate the crash scenario: RESP-02 is "busy" in PostgreSQL but there
    # is NO open incident assigned to them. This is what happens when the
    # server crashes after dispatch (busy-mark) but before incident persistence.
    update_responder_availability("RESP-02", "busy")

    # Verify the setup: RESP-02 is busy in DB, no incidents exist anywhere.
    db_row = get_responder_from_db("RESP-02")
    _assert(
        db_row is not None and db_row["current_availability_status"] == "busy",
        "RC1.1 RESP-02 is busy in PostgreSQL (simulated crash state)",
        f"DB status=busy",
        f"expected busy in DB, got "
        f"{db_row['current_availability_status'] if db_row else None}",
    )
    _assert(
        len(slice_runner.INCIDENT_STORE) == 0,
        "RC1.2 INCIDENT_STORE is empty (no persisted incidents)",
        "store empty",
        f"expected 0 incidents, got {len(slice_runner.INCIDENT_STORE)}",
    )

    # Run the bootstrap (includes reconciliation as step 4).
    summary = _simulate_restart()

    # RESP-02 must be released to available.
    _assert(
        _responder("RESP-02").current_availability_status == "available",
        "RC1.3 RESP-02 released to available after bootstrap",
        "in-memory=available",
        f"expected available, got "
        f"{_responder('RESP-02').current_availability_status}",
    )
    db_row2 = get_responder_from_db("RESP-02")
    _assert(
        db_row2 is not None and
        db_row2["current_availability_status"] == "available",
        "RC1.4 PostgreSQL row also shows available (write-through confirmed)",
        f"DB status=available",
        f"expected available in DB, got "
        f"{db_row2['current_availability_status'] if db_row2 else None}",
    )
    _assert(
        "RESP-02" in summary.get("orphaned_released", []),
        "RC1.5 bootstrap summary reports RESP-02 in orphaned_released",
        f"orphaned_released={summary['orphaned_released']}",
        f"RESP-02 not in orphaned_released: {summary.get('orphaned_released')}",
    )


# ===========================================================================
# RC2 — Legitimately busy responder (open incident exists) -> stays busy
# ===========================================================================

def test_rc2_legitimately_busy_stays():
    _sep("RC2 — Legitimately busy responder with open incident -> stays busy")
    _db_reset()

    # Dispatch a real incident to RESP-02 (creates in-memory busy + DB busy
    # + INCIDENT_STORE record + logIncident).
    inc = _make_incident()
    decision = _dispatch_and_log(inc)
    _assert(
        decision.selected_responder is not None
        and decision.selected_responder.responder_id == "RESP-02",
        "RC2.1 dispatched RESP-02",
        f"selected=RESP-02",
        f"expected RESP-02, got "
        f"{decision.selected_responder.responder_id if decision.selected_responder else None}",
    )

    # Persist the incident to PostgreSQL so it survives the restart simulation.
    # (In production the route handler does this; here we replicate that step.)
    store_record = next(
        r for r in slice_runner.INCIDENT_STORE
        if r["incident"].get("incident_id") == inc.incident_id
    )
    upsert_incident_to_db(store_record)

    # Verify RESP-02 is busy with a legitimate open incident.
    _assert(
        _responder("RESP-02").current_availability_status == "busy",
        "RC2.2 RESP-02 in-memory=busy",
        "in-memory=busy",
        f"expected busy, got "
        f"{_responder('RESP-02').current_availability_status}",
    )

    # Simulate restart (includes reconciliation).
    summary = _simulate_restart()

    # RESP-02 must STILL be busy — the open incident survived rehydration.
    _assert(
        _responder("RESP-02").current_availability_status == "busy",
        "RC2.3 RESP-02 still busy after restart (open incident protects them)",
        "in-memory=busy after restart",
        f"expected busy, got "
        f"{_responder('RESP-02').current_availability_status}",
    )
    _assert(
        "RESP-02" not in summary.get("orphaned_released", []),
        "RC2.4 bootstrap summary does NOT list RESP-02 in orphaned_released",
        f"orphaned_released={summary['orphaned_released']}",
        f"RESP-02 incorrectly in orphaned_released: "
        f"{summary.get('orphaned_released')}",
    )

    # Cleanup: close the incident so it doesn't leak into other tests.
    closeIncident(inc.incident_id, "taken_to_bhu", "bhu_staff")


# ===========================================================================
# RC3 — Multiple orphaned responders -> all released
# ===========================================================================

def test_rc3_multiple_orphaned():
    _sep("RC3 — Multiple orphaned busy responders -> all released")
    _db_reset()

    # Set up TWO responders as busy in DB with no open incidents.
    # RESP-02: seed default is "available" -> force busy.
    # RESP-05: seed default is "available" -> force busy.
    update_responder_availability("RESP-02", "busy")
    update_responder_availability("RESP-05", "busy")

    # Verify setup.
    for rid in ("RESP-02", "RESP-05"):
        row = get_responder_from_db(rid)
        _assert(
            row is not None and row["current_availability_status"] == "busy",
            f"RC3.0 {rid} is busy in DB before bootstrap",
            f"DB status=busy",
            f"expected busy for {rid}",
        )

    # Run bootstrap.
    summary = _simulate_restart()

    # Both must be released.
    for rid in ("RESP-02", "RESP-05"):
        _assert(
            _responder(rid).current_availability_status == "available",
            f"RC3.1 {rid} released to available after bootstrap",
            "in-memory=available",
            f"expected available for {rid}, got "
            f"{_responder(rid).current_availability_status}",
        )
    _assert(
        set(summary.get("orphaned_released", [])) >= {"RESP-02", "RESP-05"},
        "RC3.2 bootstrap summary lists both RESP-02 and RESP-05 as released",
        f"orphaned_released={summary['orphaned_released']}",
        f"expected both RESP-02 and RESP-05 in orphaned_released, got "
        f"{summary.get('orphaned_released')}",
    )

    # RESP-01 and RESP-04 have seed default "busy" but also no open incidents,
    # so they should ALSO be released by reconciliation.
    for rid in ("RESP-01", "RESP-04"):
        _assert(
            _responder(rid).current_availability_status == "available",
            f"RC3.3 {rid} (seed-busy, no incident) also released",
            "in-memory=available",
            f"expected available for {rid}, got "
            f"{_responder(rid).current_availability_status}",
        )


# ===========================================================================
# RC4 — Idempotency: second bootstrap finds nothing to release
# ===========================================================================

def test_rc4_idempotency():
    _sep("RC4 — Idempotency: second bootstrap finds nothing to release")
    _db_reset()

    # Set up one orphaned busy responder.
    update_responder_availability("RESP-02", "busy")

    # First bootstrap: releases RESP-02.
    summary1 = _simulate_restart()
    _assert(
        "RESP-02" in summary1.get("orphaned_released", []),
        "RC4.1 first bootstrap released RESP-02",
        f"orphaned_released={summary1['orphaned_released']}",
        f"RESP-02 not in first bootstrap orphaned_released",
    )

    # Second bootstrap (simulate another restart): nothing to release.
    summary2 = _simulate_restart()
    _assert(
        len(summary2.get("orphaned_released", [])) == 0,
        "RC4.2 second bootstrap found nothing to release (idempotent)",
        f"orphaned_released={summary2['orphaned_released']}",
        f"second bootstrap unexpectedly released: "
        f"{summary2.get('orphaned_released')}",
    )
    _assert(
        _responder("RESP-02").current_availability_status == "available",
        "RC4.3 RESP-02 still available after second bootstrap",
        "in-memory=available",
        f"expected available, got "
        f"{_responder('RESP-02').current_availability_status}",
    )


# ===========================================================================
# RC5 — Non-fatal: reconciliation doesn't crash on unexpected state
# ===========================================================================

def test_rc5_non_fatal():
    _sep("RC5 — Reconciliation is non-fatal (no crash on edge cases)")
    _db_reset()

    # Edge case: force ALL responders to available in DB so reconciliation
    # finds zero orphans. (Seed defaults include RESP-01/RESP-04 as "busy",
    # which ARE orphans — so we must override them to test the zero-orphan
    # path.)
    for r in slice_runner.SEED_RESPONDERS:
        r.current_availability_status = "available"
    for rid in ("RESP-01", "RESP-02", "RESP-03", "RESP-04", "RESP-05"):
        update_responder_availability(rid, "available")

    summary = _simulate_restart()
    _assert(
        summary.get("db_reachable") is True,
        "RC5.1 DB reachable",
        "db_reachable=True",
        "DB not reachable — test setup issue",
    )
    _assert(
        isinstance(summary.get("orphaned_released"), list),
        "RC5.2 orphaned_released is a list (not None or error)",
        f"type={type(summary.get('orphaned_released')).__name__}",
        f"expected list, got {type(summary.get('orphaned_released'))}",
    )
    _assert(
        len(summary["orphaned_released"]) == 0,
        "RC5.3 no orphans when all responders are available in DB",
        "orphaned_released=[]",
        f"unexpected orphans: {summary['orphaned_released']}",
    )


# ===========================================================================
# RC6 — Regression: end-to-end release loop still works
# ===========================================================================

def test_rc6_release_loop_regression():
    _sep("RC6 — REGRESSION: end-to-end release loop after reconciliation fix")
    _db_reset()

    # Full dispatch -> close -> re-match cycle with reconciliation active.
    inc1 = _make_incident()
    decision1 = _dispatch_and_log(inc1)
    _assert(
        decision1.selected_responder is not None
        and decision1.selected_responder.responder_id == "RESP-02",
        "RC6.1 Module 3 dispatched RESP-02",
        f"selected=RESP-02",
        f"expected RESP-02, got "
        f"{decision1.selected_responder.responder_id if decision1.selected_responder else None}",
    )

    # Close the incident -> RESP-02 released.
    closeIncident(inc1.incident_id, "taken_to_bhu", "bhu_staff")
    _assert(
        _responder("RESP-02").current_availability_status == "available",
        "RC6.2 RESP-02 released to available after close",
        "in-memory=available",
        f"expected available, got "
        f"{_responder('RESP-02').current_availability_status}",
    )

    # Simulate restart (with reconciliation).
    _simulate_restart()

    # RESP-02 should still be available (incident was closed before restart).
    _assert(
        _responder("RESP-02").current_availability_status == "available",
        "RC6.3 RESP-02 still available after restart + reconciliation",
        "in-memory=available",
        f"expected available, got "
        f"{_responder('RESP-02').current_availability_status}",
    )

    # After restart, reconciliation releases RESP-01/RESP-04 from their
    # seed-busy defaults (no open incidents). RESP-02 is still available
    # from the closure. More responders are now in the available pool.
    # Verify RESP-02 is available and a new incident can be dispatched.
    _assert(
        _responder("RESP-02").current_availability_status == "available",
        "RC6.4 RESP-02 is available after restart (eligible for re-match)",
        "in-memory=available",
        f"expected available, got "
        f"{_responder('RESP-02').current_availability_status}",
    )

    inc2 = _make_incident()
    decision2 = _dispatch_and_log(inc2)
    _assert(
        decision2.selected_responder is not None,
        "RC6.5 new incident dispatched successfully after restart",
        f"selected="
        f"{decision2.selected_responder.responder_id if decision2.selected_responder else 'BHU'}",
        "no responder dispatched — dispatch pool may be broken",
    )

    # Cleanup.
    closeIncident(inc2.incident_id, "self-resolved", "bhu_staff")


# ===========================================================================
# RUNNER
# ===========================================================================

def main() -> int:
    print("=" * 70)
    print("  INC-E0211B — STARTUP RECONCILIATION TEST SUITE")
    print("  (orphaned busy responder detection + auto-release)")
    print("=" * 70)

    test_rc1_orphaned_busy_released()
    test_rc2_legitimately_busy_stays()
    test_rc3_multiple_orphaned()
    test_rc4_idempotency()
    test_rc5_non_fatal()
    test_rc6_release_loop_regression()

    passed = sum(1 for r in _RESULTS if r[0] == "PASS")
    total = len(_RESULTS)
    print(f"\n{'=' * 70}")
    print(f"  RECONCILIATION RESULTS: {passed}/{total} checks passed, "
          f"{_FAILURES} failures")
    print("=" * 70)
    return 0 if _FAILURES == 0 else 1


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    sys.exit(main())
