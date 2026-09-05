# -*- coding: utf-8 -*-
"""Part B — REAL two-process restart proof for responder availability.

test_availability_persistence.py simulates a restart inside one interpreter
(reset statuses, then re-run the startup bootstrap). This suite removes even
that courtesy: phase 2 runs in a genuinely NEW Python process, so
slice_runner.SEED_RESPONDERS is rebuilt from its hardcoded literals by the
interpreter itself — exactly what happens when uvicorn is killed and started
again.

    RP1  parent: dispatch RESP-02 -> in-memory busy
    RP2  parent: PostgreSQL row shows busy (write-through)
    RP3  child:  fresh interpreter reports the SEED default (available) before
                 bootstrap -> proves the child really did start from hardcoded
                 values, not inherited state
    RP4  child:  after main.bootstrap_responder_state() the SAME fresh process
                 reports busy -> the headline restart-survival property
    RP5  parent: close the incident -> available in memory and in PostgreSQL
    RP6  child:  a second fresh process reports available after bootstrap
                 (the release mutation persists too, not just dispatch)

Run with:
    cd "d:\\LifeLine Ride"
    python backend\\test_restart_process.py
"""
from __future__ import annotations

import os
import subprocess
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

# Keep ack timers out of the way — same as test_availability_persistence.py.
os.environ["DISPATCH_ACK_TIMEOUT_S"] = "300"
os.environ["LIFELINE_REPLAY_MODE"]   = "1"

import slice_runner  # noqa: E402
from services.dispatch_service import (  # noqa: E402
    _DISPATCH_STATE,
    _STATE_LOCK,
    dispatchIncident,
)
from services.incident_lifecycle_service import closeIncident  # noqa: E402
from models.incident_model import (  # noqa: E402
    truncate_incidents_table,
    upsert_incident_to_db,
)
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


TARGET = "RESP-02"          # seed default: available
SEED_DEFAULT = "available"  # what a fresh interpreter hardcodes for RESP-02


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


def _db_reset() -> None:
    """Full isolation reset, same discipline as the other suites."""
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


def _make_incident() -> slice_runner.Incident:
    return slice_runner.Incident(
        incident_id=f"INC-RP-{uuid.uuid4().hex[:6].upper()}",
        timestamp_reported=datetime.now(timezone.utc).isoformat(),
        reporter_id="REP-TEST",
        gps_location=slice_runner.GPSLocation(
            latitude=31.5204, longitude=74.3587, village_id="VILLAGE-A",
        ),
        photo_ref="test_photo.jpg",
        voice_transcript="test transcript",
        severity_tier="moderate",
        injury_type_flags=["test_flag"],
    )


def _dispatch_and_log(incident: slice_runner.Incident):
    decision = dispatchIncident(incident)
    result = slice_runner.DispatchResult(
        incident_id=incident.incident_id,
        responder=decision.selected_responder,
        bhu=decision.bhu,
        ambulance_requested=decision.ambulance_requested,
        status={
            "dispatched":         "dispatched",
            "escalated_bhu_only": "escalated_bhu_only",
            "no_resources":       "no_responders_available",
        }[decision.status],
    )
    record = slice_runner.logIncident(incident, result)
    upsert_incident_to_db(record)
    return decision


# ---------------------------------------------------------------------------
# The child process: a genuinely fresh interpreter
# ---------------------------------------------------------------------------

_CHILD_SCRIPT = f"""
import sys
sys.path.insert(0, r'{_BACKEND_DIR}')
import os
os.environ['DISPATCH_ACK_TIMEOUT_S'] = '300'
os.environ['LIFELINE_REPLAY_MODE'] = '1'

# Report this interpreter's PID first, so the parent can prove the two halves
# of this test really ran in two distinct OS processes.
print('CHILD_PID:' + str(os.getpid()), flush=True)

import slice_runner
target = '{TARGET}'


def status():
    r = next(x for x in slice_runner.SEED_RESPONDERS if x.responder_id == target)
    return str(r.current_availability_status)


# BEFORE bootstrap: whatever the hardcoded SEED_RESPONDERS literal says.
print('CHILD_PRE:' + status(), flush=True)

import main
summary = main.bootstrap_responder_state()
print('CHILD_BOOTSTRAP:' + repr(summary), flush=True)

# AFTER bootstrap: whatever PostgreSQL says.
print('CHILD_POST:' + status(), flush=True)
"""


def _run_child() -> dict:
    """Spawn a fresh interpreter, run the app startup path, parse its report."""
    proc = subprocess.run(
        [sys.executable, "-c", _CHILD_SCRIPT],
        capture_output=True,
        text=True,
        cwd=str(_BACKEND_DIR),
        timeout=180,
    )
    out = proc.stdout or ""
    parsed = {"pre": None, "post": None, "bootstrap": None, "pid": None,
              "returncode": proc.returncode, "stderr": (proc.stderr or "")[-800:]}
    for line in out.splitlines():
        if line.startswith("CHILD_PID:"):
            parsed["pid"] = line.split(":", 1)[1].strip()
        elif line.startswith("CHILD_PRE:"):
            parsed["pre"] = line.split(":", 1)[1].strip()
        elif line.startswith("CHILD_POST:"):
            parsed["post"] = line.split(":", 1)[1].strip()
        elif line.startswith("CHILD_BOOTSTRAP:"):
            parsed["bootstrap"] = line.split(":", 1)[1].strip()
    # subprocess.run returns a CompletedProcess, which carries no .pid — the
    # child reports its own, so the parent/child PIDs can be contrasted.
    print(f"  [CHILD pid={parsed['pid'] or '?'} (parent pid={os.getpid()})] "
          f"pre-bootstrap={parsed['pre']} post-bootstrap={parsed['post']}")
    if parsed["bootstrap"]:
        print(f"  [CHILD] bootstrap summary: {parsed['bootstrap']}")
    if proc.returncode != 0:
        print(f"  [CHILD STDERR] {parsed['stderr']}")
    return parsed


# ===========================================================================
# RP1-RP6
# ===========================================================================

def test_restart_survival_across_processes():
    _sep("RP1-RP6 — Availability survives a REAL process restart")
    _db_reset()

    # --- RP1: dispatch in the parent -> in-memory busy ---
    inc = _make_incident()
    decision = _dispatch_and_log(inc)
    _assert(
        decision.selected_responder is not None
        and decision.selected_responder.responder_id == TARGET,
        f"RP1 parent dispatched {TARGET}",
        f"selected={TARGET}",
        f"expected {TARGET}, got "
        f"{decision.selected_responder.responder_id if decision.selected_responder else None}",
    )
    _assert(
        _responder(TARGET).current_availability_status == "busy",
        "RP1.2 parent in-memory status=busy",
        "in-memory=busy",
        f"expected busy, got {_responder(TARGET).current_availability_status}",
    )

    # --- RP2: write-through reached PostgreSQL ---
    row = get_responder_from_db(TARGET)
    if not _assert(
        row is not None and row["current_availability_status"] == "busy",
        "RP2 PostgreSQL row: current_availability_status='busy'",
        f"DB status={row['current_availability_status'] if row else None}",
        f"expected busy in DB, got "
        f"{row['current_availability_status'] if row else None}",
    ):
        return  # nothing further is meaningful without the persisted write

    # --- RP3 + RP4: a genuinely fresh interpreter must recover busy ---
    print("\n  Spawning a fresh Python process (real restart) ...")
    child = _run_child()

    _assert(
        child["returncode"] == 0 and child["pre"] is not None,
        "RP3 child process started and reported its pre-bootstrap status",
        f"returncode={child['returncode']}",
        f"child failed (rc={child['returncode']}): {child['stderr']}",
    )
    _assert(
        child["pid"] is not None and int(child["pid"]) != os.getpid(),
        "RP3.1 the child ran in a DIFFERENT OS process than this test",
        f"parent pid={os.getpid()} child pid={child['pid']}",
        f"child pid {child['pid']!r} is not a distinct process from the parent "
        f"({os.getpid()}) — the restart would not be genuine",
    )
    _assert(
        child["pre"] == SEED_DEFAULT,
        f"RP3.2 fresh process started from the hardcoded seed default "
        f"('{SEED_DEFAULT}')",
        f"pre-bootstrap={child['pre']} — the child truly had no inherited state",
        f"expected the seed default '{SEED_DEFAULT}' before bootstrap, got "
        f"{child['pre']!r} — the restart is not genuine",
    )
    _assert(
        child["post"] == "busy",
        "RP4 AFTER startup bootstrap the fresh process reports busy "
        "(restart survival PROVEN across a real process boundary)",
        f"pre={child['pre']} -> post={child['post']}",
        f"{TARGET} came back as {child['post']!r} after a real restart — "
        f"PostgreSQL was not treated as authoritative",
    )

    # --- RP5: release in the parent -> available in memory AND in DB ---
    closeIncident(inc.incident_id, "taken_to_bhu", "bhu_staff")
    _assert(
        _responder(TARGET).current_availability_status == "available",
        "RP5.1 parent in-memory status=available after close",
        "in-memory=available",
        f"expected available, got {_responder(TARGET).current_availability_status}",
    )
    row2 = get_responder_from_db(TARGET)
    _assert(
        row2 is not None and row2["current_availability_status"] == "available",
        "RP5.2 PostgreSQL row: current_availability_status='available'",
        f"DB status={row2['current_availability_status'] if row2 else None}",
        f"expected available in DB, got "
        f"{row2['current_availability_status'] if row2 else None}",
    )

    # --- RP6: a second fresh process must recover available ---
    print("\n  Spawning a second fresh Python process ...")
    child2 = _run_child()
    _assert(
        child2["post"] == "available",
        "RP6 second fresh process reports available (release persists too)",
        f"pre={child2['pre']} -> post={child2['post']}",
        f"{TARGET} came back as {child2['post']!r} after the release — "
        f"expected 'available'",
    )


# ===========================================================================
# RUNNER
# ===========================================================================

def main() -> int:
    print("=" * 70)
    print("  PART B — REAL TWO-PROCESS RESTART PROOF")
    print("  (fresh interpreter, hardcoded seeds, PostgreSQL authoritative)")
    print("=" * 70)

    test_restart_survival_across_processes()

    passed = sum(1 for r in _RESULTS if r[0] == "PASS")
    total = len(_RESULTS)
    print(f"\n{'=' * 70}")
    print(f"  RESTART-PROCESS RESULTS: {passed}/{total} checks passed, "
          f"{_FAILURES} failures")
    print("=" * 70)
    return 0 if _FAILURES == 0 else 1


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    sys.exit(main())
