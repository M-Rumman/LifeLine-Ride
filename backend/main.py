# -*- coding: utf-8 -*-
"""LifeLine Ride — FastAPI application entrypoint.

Wires the verified Module 1/2/3/5/6/6.5 service stack into a runnable HTTP
app. main.py owns NO domain logic: it builds the app, installs the project
error contract, mounts the router from routes/emergency.py, serves cached
help-bot media, and runs the startup bootstrap that makes responder state
survive a process restart.

STARTUP BOOTSTRAP (Part B persistence fix)
    bootstrap_responder_state() is the single place where in-memory responder
    state is reconciled with PostgreSQL, and it runs on every app start via the
    lifespan hook. Order matters:

        1. seed_responders_from_contract()
           Inserts any responder missing from PostgreSQL at seed defaults. Its
           ON CONFLICT clause deliberately EXCLUDES current_availability_status,
           so an existing row keeps its persisted status.
        2. load_responder_status_from_db(SEED_RESPONDERS)
           PostgreSQL is authoritative: every responder present in the DB has
           its in-memory current_availability_status overwritten with the
           persisted value. A responder who was "busy" before the restart is
           still "busy" after it — never silently reset to the hardcoded seed
           default, which is what would allow a double-dispatch of someone
           still on an active incident.
        3. rehydrate_store_from_db()
           Module 6.5 incident restart survival — routes/emergency.py's
           _fresh_record() already assumes rehydrated records exist.

    Every step is non-fatal: if PostgreSQL is unreachable the app still boots
    and serves from seed data, logging a warning (the project's fail-safe
    discipline — a DB outage must not take the emergency line down).

    bootstrap_responder_state() is module-level and side-effect-only-on-state
    so tests can invoke the REAL startup path directly instead of simulating it
    (test_availability_persistence.py, test_restart_process.py).

Run with:
    cd "d:\\LifeLine Ride\\backend"
    uvicorn main:app --port 5000
  or
    python main.py            # honours PORT from .env (default 5000)
"""
from __future__ import annotations

import os
import sys
from contextlib import asynccontextmanager
from pathlib import Path

# ---------------------------------------------------------------------------
# Path bootstrap — identical discipline to routes/emergency.py so the app runs
# from either backend/ or the project root.
# ---------------------------------------------------------------------------
_BACKEND_DIR = Path(__file__).resolve().parent
if str(_BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(_BACKEND_DIR))

_PROJECT_ROOT = _BACKEND_DIR.parent
_MEDIA_DIR = _PROJECT_ROOT / "mockdata"

from dotenv import load_dotenv  # noqa: E402

load_dotenv()

from fastapi import FastAPI                       # noqa: E402
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402
from fastapi.staticfiles import StaticFiles        # noqa: E402

import slice_runner                                # noqa: E402
from models import responder_model                 # noqa: E402
from routes import emergency                       # noqa: E402
from services import incident_lifecycle_service as lifecycle  # noqa: E402

APP_TITLE = "LifeLine Ride — Village Emergency Response Network"
APP_VERSION = "1.0.0"

# Browser origins allowed to drive the cockpit dashboard. The Vite dev server
# is the primary consumer; the list is env-overridable so a deployed frontend
# can be whitelisted without a code change. Same fail-safe discipline as the
# rest of the bootstrap: a missing/blank value falls back to localhost only,
# never to "*" with credentials.
_DEFAULT_ORIGINS = (
    "http://localhost:3000,http://127.0.0.1:3000,"
    "http://localhost:5173,http://127.0.0.1:5173,"
    "http://localhost:4173,http://127.0.0.1:4173"
)
CORS_ORIGINS = [
    o.strip() for o in os.getenv("CORS_ORIGINS", _DEFAULT_ORIGINS).split(",")
    if o.strip()
]


def _log(msg: str) -> None:
    print(f"  [STARTUP] {msg}")


def _warn(msg: str) -> None:
    print(f"  [STARTUP WARN] {msg}")


# ===========================================================================
# DB REACHABILITY
# ===========================================================================

def db_reachable() -> bool:
    """Cheap liveness probe (SELECT 1). Never raises — a DB outage is a
    degraded state to report, not a crash."""
    try:
        from sqlalchemy import text
        from database import engine
        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
        return True
    except Exception as exc:  # noqa: BLE001
        _warn(f"PostgreSQL unreachable: {exc}")
        return False


# ===========================================================================
# STARTUP BOOTSTRAP — DB-first responder state reconciliation
# ===========================================================================

def _reconcile_orphaned_responders() -> list:
    """Release responders marked 'busy' in-memory but with no open incident.

    INC-E0211B fix: if the server crashes after dispatch (responder -> busy in
    PostgreSQL) but before the incident is fully persisted, the responder
    remains 'busy' in the DB forever after every restart — an orphaned busy.
    This function detects that mismatch and safely releases them.

    Runs AFTER steps 2+3 of bootstrap (status loaded from DB, incidents
    rehydrated into INCIDENT_STORE) so the open-incident scan is complete.

    Returns a list of responder_ids that were released.
    """
    released = []
    for r in slice_runner.SEED_RESPONDERS:
        if r.current_availability_status != "busy":
            continue

        # Check INCIDENT_STORE (populated after rehydration in step 3).
        has_open = any(
            rec["incident"].get("responder_assigned_id") == r.responder_id
            and rec["incident"].get("incident_closed_timestamp") is None
            for rec in slice_runner.INCIDENT_STORE
        )
        if has_open:
            continue  # legitimately busy — an open incident exists

        # No open incident found — orphaned busy, release to available.
        r.current_availability_status = "available"
        try:
            responder_model.update_responder_availability(
                r.responder_id, "available")
        except Exception as exc:  # noqa: BLE001
            _warn(f"Reconciliation DB write failed for {r.responder_id} "
                  f"(non-fatal, in-memory already available): {exc}")
        released.append(r.responder_id)
        _log(f"Reconciliation: released orphaned responder {r.responder_id} "
             f"({r.name}) -> available (no open incident found).")
    return released


def bootstrap_responder_state() -> dict:
    """Reconcile in-memory responder + incident state with PostgreSQL.

    Idempotent and safe to call repeatedly (tests call it to simulate the
    startup half of a restart). Returns a summary dict:
        {
          "db_reachable": bool,
          "responders_seeded": int,       # rows upserted (new responders only
                                          #   get seed-default status)
          "statuses_loaded": int,         # in-memory statuses taken from DB
          "incidents_rehydrated": int,    # records restored into INCIDENT_STORE
          "orphaned_released": [str],     # responder_ids released from busy
        }
    """
    summary = {
        "db_reachable": False,
        "responders_seeded": 0,
        "statuses_loaded": 0,
        "incidents_rehydrated": 0,
        "orphaned_released": [],
    }

    summary["db_reachable"] = db_reachable()
    if not summary["db_reachable"]:
        _warn("Booting from hardcoded seed defaults — responder availability "
              "will NOT survive this run's restarts.")
        return summary

    # --- 1. Seed missing responders (existing rows keep their DB status) ---
    try:
        summary["responders_seeded"] = \
            responder_model.seed_responders_from_contract()
    except Exception as exc:  # noqa: BLE001
        _warn(f"Responder seeding failed (non-fatal): {exc}")
        return summary

    # --- 2. DB is authoritative for availability status ---
    try:
        summary["statuses_loaded"] = \
            responder_model.load_responder_status_from_db(
                slice_runner.SEED_RESPONDERS)
    except Exception as exc:  # noqa: BLE001
        _warn(f"Availability status load failed (non-fatal): {exc}")

    # --- 3. Module 6.5 incident restart survival ---
    # lifecycle.rehydrate_store_from_db() is the service facade over
    # incident_model.rehydrate_store_from_db() — same delegation the rest of
    # the stack uses, and it is already non-fatal by construction.
    try:
        summary["incidents_rehydrated"] = lifecycle.rehydrate_store_from_db()
    except Exception as exc:  # noqa: BLE001
        _warn(f"Incident rehydration failed (non-fatal): {exc}")

    # --- 4. INC-E0211B: release orphaned busy responders ---
    # Must run AFTER step 3 so INCIDENT_STORE is populated before the scan.
    try:
        summary["orphaned_released"] = _reconcile_orphaned_responders()
    except Exception as exc:  # noqa: BLE001
        _warn(f"Reconciliation failed (non-fatal): {exc}")

    busy = [r.responder_id for r in slice_runner.SEED_RESPONDERS
            if r.current_availability_status == "busy"]
    _log(f"Bootstrap complete: seeded={summary['responders_seeded']} "
         f"statuses_from_db={summary['statuses_loaded']} "
         f"incidents_rehydrated={summary['incidents_rehydrated']} "
         f"orphaned_released={summary['orphaned_released'] or 'none'}")
    _log(f"Responders still BUSY after reconciliation: {busy or 'none'}")
    return summary


# ===========================================================================
# APP + LIFESPAN
# ===========================================================================

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup hook. Uses lifespan (not the deprecated @app.on_event) because
    the installed stack is fastapi 0.141.x / starlette 1.6.x."""
    app.state.bootstrap = bootstrap_responder_state()
    yield
    _log("Shutdown: in-memory state discarded; PostgreSQL remains authoritative.")


app = FastAPI(title=APP_TITLE, version=APP_VERSION, lifespan=lifespan)

# CORS must be installed BEFORE the router so preflights (OPTIONS) on every
# /api/v1 route are answered. Without it the browser blocks the cockpit's
# form-encoded report POST and every JSON call.
app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization"],
)

# Project error contract: EVERY error body is {"code": <string>, "message": ...}
emergency.install_error_handlers(app)

# Router already carries prefix="/api/v1".
app.include_router(emergency.router)

# Cached help-bot audio: routes/emergency.py returns
# /media/helpbot/tts_cache/<file>.wav URLs, served from mockdata/.
if _MEDIA_DIR.is_dir():
    app.mount("/media", StaticFiles(directory=str(_MEDIA_DIR)), name="media")
else:
    _warn(f"Media directory missing ({_MEDIA_DIR}) — /media URLs will 404.")


def ai_provider_snapshot() -> dict:
    """Which AI stack the triage + help-bot pipelines will actually call.

    The cockpit's status bar reports this so a presenter can see at a glance
    whether the demo is about to burn live Gemini quota or serve from
    `.triage_cache`. Read from the same env vars slice_runner reads — never
    guessed — so the header cannot drift from the provider that really runs.
    """
    provider = slice_runner._ai_provider()
    if provider == "dashscope":
        models = {
            "stt": os.environ.get("DASHSCOPE_STT_MODEL", "sensevoice-v1"),
            "vision": os.environ.get("DASHSCOPE_VISION_MODEL", "qwen-vl-max"),
            "classifier": os.environ.get("DASHSCOPE_CLASSIFIER_MODEL", "qwen-plus"),
        }
    else:
        models = {
            "stt": os.environ.get("GEMINI_STT_MODEL", "gemini-3.5-flash"),
            "vision": os.environ.get("GEMINI_VISION_MODEL", "gemini-3.5-flash"),
            "classifier": os.environ.get("GEMINI_CLASSIFIER_MODEL", "gemini-3.5-flash"),
        }
    return {"provider": provider, "models": models}


@app.get("/health")
def health() -> dict:
    """Liveness + a snapshot of the in-memory state the app is serving.
    Reports the live help-bot session count (routes/emergency.py documents
    that /health owns this number)."""
    ai = ai_provider_snapshot()
    return {
        "status": "ok",
        "version": APP_VERSION,
        "db_reachable": db_reachable(),
        "responders_loaded": len(slice_runner.SEED_RESPONDERS),
        "incidents_in_memory": len(slice_runner.INCIDENT_STORE),
        "helpbot_sessions": len(emergency._HELPBOT_SESSIONS),
        "cors_origins": CORS_ORIGINS,
        "ai_provider": ai["provider"],
        "ai_models": ai["models"],
        "port": int(os.getenv("PORT", "5000")),
    }


if __name__ == "__main__":
    import uvicorn

    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:  # noqa: BLE001
        pass

    _port = int(os.getenv("PORT", "5000"))
    _log(f"Starting uvicorn on 0.0.0.0:{_port}")
    uvicorn.run("main:app", host="0.0.0.0", port=_port, reload=False)
