# -*- coding: utf-8 -*-
"""Part B — Availability Persistence Test Suite.

Proves that current_availability_status survives process restarts:
    TP1  dispatch RESP-02 -> busy -> written to PostgreSQL
    TP2  simulate restart: reset in-memory state, run main.bootstrap_responder_state()
    TP3  after restart RESP-02 still shows busy (NOT reset to available)
    TP4  close incident -> available -> written to PostgreSQL
    TP5  simulate restart again -> RESP-02 still shows available
    TP6  t1_end_to_end_release_loop regression: full dispatch -> close ->
         re-match cycle still works correctly with persistence active

The restart simulation calls main.bootstrap_responder_state() — the SAME
function the app's lifespan startup hook calls — so these tests prove the
startup wiring loads availability from PostgreSQL, not merely that the model
helper works when invoked by hand.

Run with:
    cd "d:\\LifeLine Ride"
    python backend\\test_availability_persistence.py

Isolation: _db_reset() truncates incidents + responders tables and re-seeds
from contract (same discipline as the other test suites). Responder table
truncation means the startup bootstrap begins from a clean slate, making tests
fully isolated.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path
from datetime import datetime, timezone

# ---------------------------------------------------------------------------
# Path setup
# ---------------------------------------------------------------------------
_BACKEND_DIR = Path(__file__).resolve().parent
if str(_BACKEND_DIR) not in [str(p) for p in sys.path]:
    sys.path.insert(0, str(_BACKEND_DIR))

# Keep ack timers out of the way — same as test_module6_persistence.py.
os.environ["DISPATCH_ACK_TIMEOUT_S"] = "300"
os.environ["LIFELINE_REPLAY_MODE"]   = "1"

import slice_runner  # noqa: E402
# Aliased: this suite defines its own main() runner further down, which would
# otherwise shadow the imported module of the same name.
import main as app_main  # noqa: E402  — the real app startup path
from services.dispatch_service import (  # noqa: E402
    _DISPATCH_STATE,
    _STATE_LOCK,
    dispatchIncident,
)
from services.incident_lifecycle_service import closeIncident  # noqa: E402
from models.incident_model import truncate_incidents_table  # noqa: E402
from models.responder_model import (  # noqa: E402
    get_responder_from_db,
    seed_responders_from_contract,
    truncate_responders_table,
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
# TEST INFRASTRUCTURE — same hand-rolled harness
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
    # seed_responders_from_contract now starts fresh (table just truncated)
    # so it inserts at seed defaults — no old statuses to preserve.
    seed_responders_from_contract()


def _make_incident(village_id: str, tier: str) -> slice_runner.Incident:
    import uuid
    return slice_runner.Incident(
        incident_id=f"INC-TP-{uuid.uuid4().hex[:6].upper()}",
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


def _responder(responder_id: str) -> slice_runner.Responder:
    return next(r for r in slice_runner.SEED_RESPONDERS if r.responder_id == responder_id)


def _dispatch_and_log(incident: slice_runner.Incident):
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


def _simulate_restart() -> None:
    """Simulate a process restart by running the REAL application startup path.

    Sequence, matching what a freshly-started process actually does:
        1. Module imported -> SEED_RESPONDERS rebuilt from hardcoded defaults
           (reproduced here by resetting every status to its seed value)
        2. main.bootstrap_responder_state() -> the lifespan startup hook:
           seeds responders missing from PostgreSQL, makes the DB authoritative
           for current_availability_status, then rehydrates incidents.

    Calling the same function uvicorn calls is what turns this into a proof of
    the startup wiring rather than a proof that the model helper works when
    invoked by hand.
    """
    print("  [RESTART SIM] Resetting in-memory status to seed defaults ...")
    for r in slice_runner.SEED_RESPONDERS:
        r.current_availability_status = _original_availability[r.responder_id]
    print(f"  [RESTART SIM] RESP-02 in-memory after reset: "
          f"{_responder('RESP-02').current_availability_status}")

    print("  [RESTART SIM] Running main.bootstrap_responder_state() "
          "(the real app startup path) ...")
    summary = app_main.bootstrap_responder_state()
    print(f"  [RESTART SIM] Bootstrap summary: {summary}")
    print(f"  [RESTART SIM] RESP-02 in-memory after startup bootstrap: "
          f"{_responder('RESP-02').current_availability_status}")


# ===========================================================================
# TP1-TP5 — Restart Survival Test
# ===========================================================================

def test_tp1_tp5_restart_survival():
    _sep("TP1-TP5 — Availability persistence: busy -> restart -> still busy")
    _db_reset()

    # TP1: dispatch RESP-02 -> in-memory busy + DB busy
    inc = _make_incident("VILLAGE-A", "moderate")
    decision = _dispatch_and_log(inc)
    _assert(
        decision.selected_responder is not None
        and decision.selected_responder.responder_id == "RESP-02",
        "TP1.1 dispatched RESP-02",
        "selected=RESP-02",
        f"expected RESP-02, got "
        f"{decision.selected_responder.responder_id if decision.selected_responder else None}",
    )
    _assert(
        _responder("RESP-02").current_availability_status == "busy",
        "TP1.2 in-memory status=busy after dispatch",
        "in-memory=busy",
        f"expected busy, got {_responder('RESP-02').current_availability_status}",
    )

    db_row = get_responder_from_db("RESP-02")
    _assert(
        db_row is not None and db_row["current_availability_status"] == "busy",
        "TP1.3 PostgreSQL row: current_availability_status='busy' (write-through confirmed)",
        f"DB status={db_row['current_availability_status'] if db_row else None}",
        f"expected busy in DB, got {db_row['current_availability_status'] if db_row else None}",
    )

    # TP2-TP3: simulate restart -> RESP-02 must still be busy
    _simulate_restart()

    _assert(
        _responder("RESP-02").current_availability_status == "busy",
        "TP3 after restart: RESP-02 still busy (not reset to available)",
        "in-memory=busy after restart",
        f"RESP-02 was reset to {_responder('RESP-02').current_availability_status} "
        f"after restart — persistence FAILED",
    )

    # TP4: close incident -> in-memory available + DB available
    closeIncident(inc.incident_id, "taken_to_bhu", "bhu_staff")
    _assert(
        _responder("RESP-02").current_availability_status == "available",
        "TP4.1 in-memory status=available after incident close",
        "in-memory=available",
        f"expected available, got {_responder('RESP-02').current_availability_status}",
    )

    db_row2 = get_responder_from_db("RESP-02")
    _assert(
        db_row2 is not None and db_row2["current_availability_status"] == "available",
        "TP4.2 PostgreSQL row: current_availability_status='available' after close",
        f"DB status={db_row2['current_availability_status'] if db_row2 else None}",
        f"expected available in DB, got "
        f"{db_row2['current_availability_status'] if db_row2 else None}",
    )

    # TP5: simulate restart again -> RESP-02 must show available (not reverted to seed)
    _simulate_restart()

    _assert(
        _responder("RESP-02").current_availability_status == "available",
        "TP5 after second restart: RESP-02 still available",
        "in-memory=available after restart",
        f"RESP-02 was reset to {_responder('RESP-02').current_availability_status} "
        f"after second restart — persistence FAILED",
    )


# ===========================================================================
# TP6 — Regression: test_t1_end_to_end_release_loop
# ===========================================================================

def test_tp6_t1_end_to_end_release_loop_regression():
    """Inline reproduction of test_module6_persistence.py's T1 test.

    This is the [!IMPORTANT] regression claim: the full dispatch -> close ->
    responder-available -> re-match cycle must still work correctly with the
    DB write-through active.
    """
    _sep("TP6 — REGRESSION: T1 end-to-end release loop (must still pass)")
    _db_reset()

    farhan = _responder("RESP-02")

    # Step 1: dispatch incident 1 to RESP-02
    inc1 = _make_incident("VILLAGE-A", "moderate")
    decision1 = _dispatch_and_log(inc1)
    _assert(
        decision1.selected_responder is not None
        and decision1.selected_responder.responder_id == "RESP-02",
        "TP6.1 Module 3 dispatched RESP-02",
        f"selected={decision1.selected_responder.responder_id}",
        f"expected RESP-02, got "
        f"{decision1.selected_responder.responder_id if decision1.selected_responder else None}",
    )
    _assert(
        farhan.current_availability_status == "busy",
        "TP6.2 RESP-02 marked busy in-memory",
        "in-memory=busy",
        f"expected busy, got {farhan.current_availability_status}",
    )

    # DB should also show busy (write-through active).
    db_pre = get_responder_from_db("RESP-02")
    _assert(
        db_pre is not None and db_pre["current_availability_status"] == "busy",
        "TP6.3 RESP-02 busy written to PostgreSQL",
        f"DB status={db_pre['current_availability_status'] if db_pre else None}",
        f"expected busy in DB, got "
        f"{db_pre['current_availability_status'] if db_pre else None}",
    )

    # Step 2: no second incident can be dispatched to RESP-02 while busy
    inc2 = _make_incident("VILLAGE-A", "moderate")
    decision2 = _dispatch_and_log(inc2)
    _assert(
        decision2.selected_responder is None
        or decision2.selected_responder.responder_id != "RESP-02",
        "TP6.4 RESP-02 not re-dispatched while busy",
        f"second incident went to "
        f"{decision2.selected_responder.responder_id if decision2.selected_responder else 'BHU'}",
        "RESP-02 was incorrectly dispatched again while busy",
    )

    # Step 3: close incident 1 -> RESP-02 released to available
    closeIncident(inc1.incident_id, "taken_to_bhu", "bhu_staff")
    _assert(
        farhan.current_availability_status == "available",
        "TP6.5 RESP-02 released to available after incident close",
        "in-memory=available",
        f"expected available, got {farhan.current_availability_status}",
    )

    # DB should also show available (write-through on release).
    db_post = get_responder_from_db("RESP-02")
    _assert(
        db_post is not None and db_post["current_availability_status"] == "available",
        "TP6.6 RESP-02 available written to PostgreSQL after release",
        f"DB status={db_post['current_availability_status'] if db_post else None}",
        f"expected available in DB, got "
        f"{db_post['current_availability_status'] if db_post else None}",
    )

    # Step 4: RESP-02 can now be matched to a new incident (the release loop closes)
    inc3 = _make_incident("VILLAGE-A", "moderate")
    decision3 = _dispatch_and_log(inc3)
    _assert(
        decision3.selected_responder is not None
        and decision3.selected_responder.responder_id == "RESP-02",
        "TP6.7 RESP-02 successfully re-dispatched after release (release loop closed)",
        f"selected={decision3.selected_responder.responder_id}",
        f"expected RESP-02 re-matched, got "
        f"{decision3.selected_responder.responder_id if decision3.selected_responder else None}",
    )


# ===========================================================================
# RUNNER
# ===========================================================================

def main() -> int:
    print("=" * 70)
    print("  PART B — AVAILABILITY PERSISTENCE TEST SUITE")
    print("  (restart survival + T1 release loop regression)")
    print("=" * 70)

    test_tp1_tp5_restart_survival()
    test_tp6_t1_end_to_end_release_loop_regression()

    passed = sum(1 for r in _RESULTS if r[0] == "PASS")
    total = len(_RESULTS)
    print(f"\n{'=' * 70}")
    print(f"  AVAILABILITY PERSISTENCE RESULTS: {passed}/{total} checks passed, "
          f"{_FAILURES} failures")
    print("=" * 70)
    return 0 if _FAILURES == 0 else 1


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    sys.exit(main())
