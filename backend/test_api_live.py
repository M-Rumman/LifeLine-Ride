# -*- coding: utf-8 -*-
"""Live-boot API regression test — real uvicorn process, real HTTP calls.

Unlike test_api_routes.py (which uses FastAPI's TestClient in-process), this
suite spawns a genuine uvicorn subprocess and drives it over HTTP via httpx.
This catches a different class of bugs:

    AL1  port binding — uvicorn actually listens on the configured port
    AL2  health endpoint — the app bootstraps successfully (DB, seed data)
    AL3  full incident lifecycle over HTTP — report → retrieve → close
    AL4  process termination — SIGTERM kills the process cleanly, port freed
    AL5  restart survival — data persisted by phase 1 survives a kill+restart
    AL6  performance endpoint — Module 5 factual metrics reachable over HTTP

Run with:
    cd "d:\\LifeLine Ride"
    python backend\\test_api_live.py

Prerequisites:
    - PostgreSQL reachable (DATABASE_URL in .env).
    - Port 5050 free (configurable via LIVE_TEST_PORT env var).
    - LIFELINE_REPLAY_MODE=1 to avoid real AI calls in triage.
"""
from __future__ import annotations

import httpx
import os
import signal
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Optional

# ---------------------------------------------------------------------------
# Path setup
# ---------------------------------------------------------------------------
_BACKEND_DIR = Path(__file__).resolve().parent
if str(_BACKEND_DIR) not in [str(p) for p in sys.path]:
    sys.path.insert(0, str(_BACKEND_DIR))

# Keep ack timers out of the way and avoid real AI calls.
os.environ["DISPATCH_ACK_TIMEOUT_S"] = "600"
os.environ["LIFELINE_REPLAY_MODE"] = "1"

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
_PORT = int(os.environ.get("LIVE_TEST_PORT", "5050"))
_BASE_URL = f"http://127.0.0.1:{_PORT}"
_API = f"{_BASE_URL}/api/v1"
_STARTUP_TIMEOUT_S = 60      # max seconds to wait for uvicorn to bind
_SHUTDOWN_TIMEOUT_S = 15     # max seconds to wait for process exit
_POLL_INTERVAL_S = 0.3       # health-check polling interval


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


# ===========================================================================
# PROCESS MANAGEMENT — start / stop / wait
# ===========================================================================

def _port_free(port: int) -> bool:
    """True if the TCP port is not bound by any process."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.5)
        try:
            s.bind(("127.0.0.1", port))
            return True
        except OSError:
            return False


def _wait_for_port(port: int, timeout_s: float) -> bool:
    """Poll until the port accepts connections or timeout expires."""
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=1):
                return True
        except (ConnectionRefusedError, OSError):
            time.sleep(_POLL_INTERVAL_S)
    return False


def _start_uvicorn() -> subprocess.Popen:
    """Spawn a real uvicorn process. Returns the Popen handle.

    stderr is drained in a background thread to prevent the pipe buffer from
    filling up and blocking the child process (a common Windows deadlock).
    """
    env = os.environ.copy()
    env["DISPATCH_ACK_TIMEOUT_S"] = "600"
    env["LIFELINE_REPLAY_MODE"] = "1"
    env["PORT"] = str(_PORT)
    env["PYTHONUNBUFFERED"] = "1"

    proc = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "main:app",
         "--host", "127.0.0.1", "--port", str(_PORT)],
        cwd=str(_BACKEND_DIR),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )

    # Background stdout drain — prevents pipe-buffer deadlock.
    _stdout_lines: list = []

    def _drain_out():
        try:
            while True:
                line = proc.stdout.readline()
                if not line:
                    break
                _stdout_lines.append(line)
        except Exception:
            pass

    t_out = threading.Thread(target=_drain_out, daemon=True)
    t_out.start()
    proc._stdout_lines = _stdout_lines
    proc._stderr_lines = _stdout_lines  # point both to combined stream
    return proc


def _stop_uvicorn(proc: subprocess.Popen) -> bool:
    """SIGTERM the process and wait for clean exit. Returns True on success."""
    if proc.poll() is not None:
        return True  # already dead
    try:
        proc.terminate()  # SIGTERM on POSIX; on Windows falls back to kill
    except Exception:
        try:
            proc.kill()
        except Exception:
            return False
    try:
        proc.wait(timeout=_SHUTDOWN_TIMEOUT_S)
        return True
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait(timeout=5)
        return False


def _drain_stderr(proc: subprocess.Popen, max_chars: int = 1200) -> str:
    """Return whatever the background stderr drain has collected so far."""
    lines = getattr(proc, "_stderr_lines", [])
    text = b"".join(lines).decode("utf-8", errors="replace")
    return text[-max_chars:]


# ===========================================================================
# HTTP HELPERS
# ===========================================================================

def _get(path: str, **kwargs) -> httpx.Response:
    return httpx.get(f"{_API}{path}", timeout=60, **kwargs)


def _post(path: str, **kwargs) -> httpx.Response:
    return httpx.post(f"{_API}{path}", timeout=60, **kwargs)


def _health() -> httpx.Response:
    return httpx.get(f"{_BASE_URL}/health", timeout=60)


# ===========================================================================
# AL1-AL2 — Port binding + health check
# ===========================================================================

def test_al1_al2_port_and_health(proc: subprocess.Popen) -> bool:
    _sep("AL1-AL2 — Port binding + health endpoint")

    ready = _wait_for_port(_PORT, _STARTUP_TIMEOUT_S)
    if not ready:
        # Diagnose: did the process die?
        rc = proc.poll()
        stderr_tail = _drain_stderr(proc)
        detail = (f"process exited with rc={rc}" if rc is not None
                  else f"process alive (pid={proc.pid}) but port not bound")
        _fail("AL1 uvicorn bound to port " + str(_PORT),
              f"uvicorn did not bind port {_PORT} within {_STARTUP_TIMEOUT_S}s. "
              f"{detail}. stderr tail:\n{stderr_tail}")
        return False

    _pass("AL1 uvicorn bound to port " + str(_PORT),
          f"port {_PORT} is accepting connections")

    resp = _health()
    if not _assert(resp.status_code == 200,
                   "AL2.1 /health returns 200",
                   f"status={resp.status_code}",
                   f"expected 200, got {resp.status_code}"):
        return False

    body = resp.json()
    _assert(body.get("status") == "ok",
            "AL2.2 /health body has status='ok'",
            f"status={body.get('status')}",
            f"expected 'ok', got {body.get('status')!r}")
    _assert("responders_loaded" in body,
            "AL2.3 /health reports responders_loaded count",
            f"responders_loaded={body.get('responders_loaded')}",
            "missing 'responders_loaded' in /health body")
    _assert("db_reachable" in body,
            "AL2.4 /health reports db_reachable",
            f"db_reachable={body.get('db_reachable')}",
            "missing 'db_reachable' in /health body")
    return True


# ===========================================================================
# AL3 — Full incident lifecycle over HTTP
# ===========================================================================

def _drain_stdout(proc: subprocess.Popen, max_chars: int = 2000) -> str:
    lines = getattr(proc, "_stdout_lines", [])
    text = b"".join(lines).decode("utf-8", errors="replace")
    return text[-max_chars:]


def test_al3_lifecycle(proc: Optional[subprocess.Popen] = None) -> Optional[dict]:
    """Report → retrieve → responder ack → close → verify.
    Returns the incident_id for the restart-survival test, or None on failure.
    """
    _sep("AL3 — Full incident lifecycle over HTTP")

    # --- Report ---
    resp = _post("/emergency/report", data={
        "latitude": "31.5204",
        "longitude": "74.3587",
        "village_id": "VILLAGE-A",
        "reporter_id": "REP-LIVE-TEST",
        "photo_ref": "snake.jpg",
        "voice_ref": "snake.mp3",
    })
    if not _assert(resp.status_code == 201,
                   "AL3.1 POST /emergency/report -> 201",
                   f"status={resp.status_code}",
                   f"expected 201, got {resp.status_code}; body={resp.text[:200]}"):
        return None

    report_body = resp.json()
    incident_id = report_body.get("incident", {}).get("incident_id")
    _assert(incident_id is not None,
            "AL3.2 report returned an incident_id",
            f"incident_id={incident_id}",
            "no incident_id in report response")
    if not incident_id:
        return None

    _assert(report_body.get("db_persisted") is True,
            "AL3.3 report db_persisted=True (PostgreSQL write succeeded)",
            "db_persisted=True",
            f"db_persisted={report_body.get('db_persisted')}")

    dispatch = report_body.get("dispatch", {})
    responder_id = (dispatch.get("responder") or {}).get("responder_id")
    _assert(responder_id is not None,
            "AL3.4 dispatch selected a responder",
            f"responder={responder_id}",
            f"no responder in dispatch: {dispatch}")

    # --- Retrieve ---
    resp2 = _get(f"/emergency/incident/{incident_id}")
    _assert(resp2.status_code == 200,
            "AL3.5 GET /emergency/incident/{id} -> 200",
            f"status={resp2.status_code}",
            f"expected 200, got {resp2.status_code}")

    # --- Responder ack ---
    if responder_id:
        resp3 = _post("/responder/respond", json={
            "incident_id": incident_id,
            "responder_id": responder_id,
            "action": "accept",
        })
        _assert(resp3.status_code == 200,
                "AL3.6 POST /responder/respond (accept) -> 200",
                f"status={resp3.status_code}",
                f"expected 200, got {resp3.status_code}; body={resp3.text[:200]}")

    # --- Close with BHU confirmation ---
    resp4 = _post(f"/emergency/incident/{incident_id}/close", json={
        "outcome": "taken_to_bhu",
        "confirmed_by": "bhu_staff",
        "closed_by_id": "BHU-01",
    })
    _assert(resp4.status_code == 200,
            "AL3.7 POST close (bhu_staff) -> 200",
            f"status={resp4.status_code}",
            f"expected 200, got {resp4.status_code}; body={resp4.text[:200]}")

    close_body = resp4.json()
    _assert(close_body.get("outcome_recorded") is not None,
            "AL3.8 close returned outcome_recorded (Module 5 contribution logged)",
            f"status={close_body.get('outcome_recorded', {}).get('status')}",
            "outcome_recorded is None — Module 5 award was not triggered")

    # --- Double-close refused ---
    resp5 = _post(f"/emergency/incident/{incident_id}/close", json={
        "outcome": "taken_to_bhu",
        "confirmed_by": "bhu_staff",
    })
    _assert(resp5.status_code == 409,
            "AL3.9 double-close -> 409 ALREADY_CLOSED",
            f"status={resp5.status_code}",
            f"expected 409, got {resp5.status_code}")

    return {"incident_id": incident_id, "responder_id": responder_id}


# ===========================================================================
# AL4 — Process termination + port freed
# ===========================================================================

def test_al4_termination(proc: subprocess.Popen) -> bool:
    _sep("AL4 — Process termination + port freed")

    pid = proc.pid
    stopped = _stop_uvicorn(proc)
    _assert(stopped,
            "AL4.1 uvicorn exited cleanly after SIGTERM",
            f"pid={pid} terminated",
            f"process {pid} did not exit within {_SHUTDOWN_TIMEOUT_S}s")

    # Give the OS a moment to release the socket.
    time.sleep(1.0)
    freed = _port_free(_PORT)
    _assert(freed,
            "AL4.2 port " + str(_PORT) + " is free after shutdown",
            "port released",
            f"port {_PORT} is still bound — process may not have fully exited")
    return freed


# ===========================================================================
# AL5 — Restart survival
# ===========================================================================

def test_al5_restart_survival(incident_id: str) -> bool:
    _sep("AL5 — Restart survival (data persisted across kill+restart)")

    # Start a second uvicorn process.
    proc2 = _start_uvicorn()
    try:
        ready = _wait_for_port(_PORT, _STARTUP_TIMEOUT_S)
        if not _assert(ready,
                       "AL5.1 second uvicorn instance started",
                       f"port {_PORT} accepting connections",
                       f"second instance did not bind within {_STARTUP_TIMEOUT_S}s"):
            return False

        # The incident from phase 1 must survive the restart.
        resp = _get(f"/emergency/incident/{incident_id}")
        if not _assert(resp.status_code == 200,
                       "AL5.2 incident survived restart (GET -> 200)",
                       f"incident_id={incident_id}",
                       f"expected 200, got {resp.status_code}"):
            return False

        body = resp.json()
        inc = body.get("incident", {})
        _assert(
            inc.get("incident_closed_timestamp") is not None,
            "AL5.3 restarted instance reports the incident as closed",
            f"closed_at={inc.get('incident_closed_timestamp')}",
            "incident_closed_timestamp is None — closure did not survive restart",
        )
        _assert(
            inc.get("outcome") == "taken_to_bhu",
            "AL5.4 outcome survived restart",
            f"outcome={inc.get('outcome')}",
            f"expected 'taken_to_bhu', got {inc.get('outcome')!r}",
        )
        _assert(
            inc.get("outcome_confirmed_by") == "bhu_staff",
            "AL5.5 confirmed_by survived restart",
            f"confirmed_by={inc.get('outcome_confirmed_by')}",
            f"expected 'bhu_staff', got {inc.get('outcome_confirmed_by')!r}",
        )

        # Health endpoint should report rehydrated incidents.
        h = _health()
        hbody = h.json()
        _assert(
            hbody.get("incidents_in_memory", 0) >= 1,
            "AL5.6 /health reports incidents_in_memory >= 1 after rehydration",
            f"incidents_in_memory={hbody.get('incidents_in_memory')}",
            f"expected >= 1, got {hbody.get('incidents_in_memory')}",
        )

        return True
    finally:
        _stop_uvicorn(proc2)
        time.sleep(0.5)


# ===========================================================================
# AL6 — Performance endpoint over HTTP
# ===========================================================================

def test_al6_performance(responder_id: str) -> None:
    _sep("AL6 — Performance endpoint (Module 5 factual metrics)")

    if not responder_id:
        _fail("AL6 skipped", "no responder_id from lifecycle test")
        return

    resp = _get(f"/accountability/responder/{responder_id}/performance")
    if not _assert(resp.status_code == 200,
                   "AL6.1 GET /performance -> 200",
                   f"status={resp.status_code}",
                   f"expected 200, got {resp.status_code}; body={resp.text[:200]}"):
        return

    body = resp.json()
    _assert("incidents_responded_to" in body,
            "AL6.2 response has incidents_responded_to",
            f"incidents_responded_to={body.get('incidents_responded_to')}",
            "missing 'incidents_responded_to'")
    _assert("incidents_by_outcome" in body,
            "AL6.3 response has incidents_by_outcome",
            f"keys={list(body.get('incidents_by_outcome', {}).keys())}",
            "missing 'incidents_by_outcome'")
    _assert("status_flag" in body,
            "AL6.4 response has status_flag",
            f"status_flag={body.get('status_flag')}",
            "missing 'status_flag'")
    # No points or tier fields (the old system was removed).
    _assert("points" not in body and "tier" not in body,
            "AL6.5 no legacy points/tier fields in response",
            "clean factual record only",
            "response contains legacy scoring fields")

    # Unknown responder -> 404
    resp2 = _get("/accountability/responder/RESP-999/performance")
    _assert(resp2.status_code == 404,
            "AL6.7 unknown responder -> 404 RESPONDER_NOT_FOUND",
            f"status={resp2.status_code}",
            f"expected 404, got {resp2.status_code}")


# ===========================================================================
# AL7 — Responders list endpoint
# ===========================================================================

def test_al7_responders_list() -> None:
    _sep("AL7 — GET /responders (read-only availability view)")

    resp = _get("/responders")
    if not _assert(resp.status_code == 200,
                   "AL7.1 GET /responders -> 200",
                   f"status={resp.status_code}",
                   f"expected 200, got {resp.status_code}"):
        return

    body = resp.json()
    responders = body.get("responders", [])
    _assert(len(responders) >= 5,
            "AL7.2 at least 5 seed responders returned",
            f"count={len(responders)}",
            f"expected >= 5, got {len(responders)}")

    first = responders[0] if responders else {}
    for key in ("responder_id", "name", "village", "linked_bhu_id",
                "current_availability_status"):
        _assert(key in first,
                f"AL7.3 responder has '{key}' field",
                f"{key}={first.get(key)}",
                f"missing '{key}' in responder object")


# ===========================================================================
# RUNNER
# ===========================================================================

def main() -> int:
    print("=" * 70)
    print("  LIVE-BOOT API REGRESSION TEST")
    print("  (real uvicorn subprocess, real HTTP, port lifecycle)")
    print("=" * 70)
    print(f"  Target: {_BASE_URL}")
    print(f"  PID:    {os.getpid()}")

    # --- Pre-flight: ensure the port is free ---
    if not _port_free(_PORT):
        print(f"\n  FATAL: port {_PORT} is already in use. "
              f"Set LIVE_TEST_PORT env var to override.")
        return 2

    # --- Pre-flight DB reset: close dangling test incidents and restore available statuses ---
    try:
        from database import SessionLocal
        from models.incident_model import IncidentRecord
        from models.responder_model import ResponderRecord
        from datetime import datetime, timezone
        db = SessionLocal()
        now = datetime.now(timezone.utc).isoformat()
        db.query(IncidentRecord).filter(IncidentRecord.incident_closed_timestamp.is_(None)).update(
            {"incident_closed_timestamp": now, "outcome": "taken_to_bhu", "outcome_confirmed_by": "bhu_staff"},
            synchronize_session=False,
        )
        for r in db.query(ResponderRecord).all():
            if r.responder_id != "RESP-03":
                r.current_availability_status = "available"
        db.commit()
        db.close()
    except Exception as exc:
        print(f"  [PREFLIGHT WARN] DB reset failed: {exc}")

    # --- Phase 1: start uvicorn ---
    print("\n  Starting uvicorn subprocess ...")
    proc = _start_uvicorn()

    try:
        # AL1-AL2: port binding + health
        if not test_al1_al2_port_and_health(proc):
            print("\n  ABORT: server failed to start. Cannot continue.")
            _stop_uvicorn(proc)
            return 1

        # AL3: full lifecycle
        ctx = test_al3_lifecycle(proc)
        if not ctx:
            out_tail = b"".join(getattr(proc, "_stdout_lines", [])).decode("utf-8", errors="replace")
            print("\n  [DEBUG] uvicorn stdout tail:\n", out_tail[-2000:])

        # AL4: process termination
        if not test_al4_termination(proc):
            print("\n  ABORT: process did not terminate cleanly.")
            return 1

        # AL5: restart survival (starts its own process)
        if ctx:
            test_al5_restart_survival(ctx["incident_id"])
        else:
            _sep("AL5 — SKIPPED (no incident from AL3)")

        # AL6 + AL7 need the second process still running — start another.
        print("\n  Starting uvicorn for AL6/AL7 ...")
        proc3 = _start_uvicorn()
        try:
            ready = _wait_for_port(_PORT, _STARTUP_TIMEOUT_S)
            if ready:
                responder_id = (ctx or {}).get("responder_id")
                test_al6_performance(responder_id)
                test_al7_responders_list()
            else:
                _fail("AL6/AL7", "third uvicorn instance failed to start")
        finally:
            _stop_uvicorn(proc3)
            time.sleep(0.5)

    except Exception as exc:
        _fail("UNCAUGHT", str(exc))
        import traceback
        traceback.print_exc()
    finally:
        # Belt-and-braces: make sure the port is freed.
        _stop_uvicorn(proc)

    # --- Summary ---
    passed = sum(1 for r in _RESULTS if r[0] == "PASS")
    total = len(_RESULTS)
    print(f"\n{'=' * 70}")
    print(f"  LIVE-BOOT API RESULTS: {passed}/{total} checks passed, "
          f"{_FAILURES} failures")
    print("=" * 70)
    return 0 if _FAILURES == 0 else 1


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    sys.exit(main())
