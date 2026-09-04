# -*- coding: utf-8 -*-
"""HTTP controller layer — Emergency Network routes over the verified services.

PURE CONTROLLER: payload validation -> service invocation -> JSON response.
No domain logic lives here; every observable behavior stays in Modules 1/2/3/
5/6/6.5. Error contract (project dev spec): EVERY error body is JSON
    {"code": <STRING_CODE>, "message": <human-readable detail>}
installed app-wide by install_error_handlers().

Endpoints (prefix /api/v1):
    POST /emergency/report                           Module 1 triage + Module 3
    GET  /emergency/incident/{incident_id}           Module 6.5 lifecycle record
    POST /emergency/incident/{incident_id}/close     Module 6 close + Module 5
    POST /responder/respond                          Module 3 ack / decline
    POST /helpbot/step                               Module 2 guidance session
    GET  /responders                                 read-only availability view
    GET  /accountability/responder/{id}/performance  Module 5 metrics record

Help-bot sessions are STATEFUL per incident (_HELPBOT_SESSIONS) — the HTTP
counterpart of HelpBotSession's conversation loop: step index + turn history
advance across requests, and escalation wires Module 2 -> Module 3 exactly as
documented (escalateIncident first, then dispatch_service.handleEscalation
with the returned snapshot). Audio is never played server-side; the reply
carries a /media/helpbot/tts_cache URL for the cached wav instead.
"""
from __future__ import annotations

import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, Literal, Optional

# --- import path bootstrap: allow direct imports from backend/ -------------
_BACKEND_DIR = Path(__file__).resolve().parent.parent
if str(_BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(_BACKEND_DIR))

from fastapi import APIRouter, Form, Request                     # noqa: E402
from fastapi.exceptions import RequestValidationError            # noqa: E402
from fastapi.responses import JSONResponse                       # noqa: E402
from pydantic import BaseModel                                   # noqa: E402
from starlette.exceptions import (                               # noqa: E402
    HTTPException as StarletteHTTPException,
)

import slice_runner                                              # noqa: E402
from models import incident_model, responder_model               # noqa: E402
from services import accountability_service                      # noqa: E402
from services import dispatch_service                            # noqa: E402
from services import help_bot_service                            # noqa: E402
from services import incident_lifecycle_service as lifecycle     # noqa: E402


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _warn(msg: str) -> None:
    print(f"  [API WARN] {msg}")


# ===========================================================================
# ERROR CONTRACT — {"code", "message"} everywhere, string codes
# ===========================================================================

class ApiError(Exception):
    """Structured controller error -> JSON {"code", "message"} + HTTP status."""

    def __init__(self, status_code: int, code: str, message: str):
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message


def install_error_handlers(app) -> None:
    """Guarantee the project error contract on EVERY failure path:
    every error body is JSON {"code": <string>, "message": <detail>}."""

    @app.exception_handler(ApiError)
    async def _api_error(request: Request, exc: ApiError):
        return JSONResponse(status_code=exc.status_code,
                            content={"code": exc.code, "message": exc.message})

    @app.exception_handler(StarletteHTTPException)
    async def _http_error(request: Request, exc: StarletteHTTPException):
        if isinstance(exc.detail, dict) and exc.detail.get("code"):
            code = exc.detail["code"]
            message = str(exc.detail.get("message", exc.detail))
        else:
            message = str(exc.detail)
            code = {404: "NOT_FOUND", 405: "METHOD_NOT_ALLOWED",
                    409: "CONFLICT"}.get(exc.status_code,
                                         f"HTTP_{exc.status_code}")
        return JSONResponse(status_code=exc.status_code,
                            content={"code": code, "message": message})

    @app.exception_handler(RequestValidationError)
    async def _validation_error(request: Request, exc: RequestValidationError):
        errors = exc.errors()
        first = errors[0] if errors else {}
        loc = ".".join(str(p) for p in first.get("loc", []) if p != "body")
        return JSONResponse(status_code=400, content={
            "code": "VALIDATION_ERROR",
            "message": f"{loc or 'payload'}: "
                       f"{first.get('msg', 'invalid request payload')}",
        })

    @app.exception_handler(ValueError)
    async def _value_error(request: Request, exc: ValueError):
        # Services raise ValueError for refused mutations (closed records,
        # invalid inputs) — surface as a 400 under the same contract.
        return JSONResponse(status_code=400,
                            content={"code": "VALIDATION_ERROR",
                                     "message": str(exc)})

    @app.exception_handler(Exception)
    async def _unhandled(request: Request, exc: Exception):
        _warn(f"unhandled error on {request.url.path}: {exc}")
        return JSONResponse(status_code=500,
                            content={"code": "INTERNAL_ERROR",
                                     "message": str(exc)[:300]})


# ===========================================================================
# SHARED HELPERS + REQUEST MODELS
# ===========================================================================

# Live help-bot guidance sessions, keyed by incident_id. main.py's /health
# reports len(_HELPBOT_SESSIONS); the tests rely on step state persisting
# across requests (step index + turn history advance turn by turn).
_HELPBOT_SESSIONS: Dict[str, dict] = {}


def _fresh_record(incident_id: str) -> Optional[dict]:
    """Store-first (freshest — every dispatch/help-bot event syncs it),
    DB-second (covers rehydrated records across restarts)."""
    for record in slice_runner.INCIDENT_STORE:
        if record["incident"].get("incident_id") == incident_id:
            return record
    return lifecycle.getIncidentRecord(incident_id)


def _require_open_record(incident_id: str) -> dict:
    record = _fresh_record(incident_id)
    if record is None:
        raise ApiError(404, "INCIDENT_NOT_FOUND",
                       f"Incident {incident_id} is not registered.")
    if record["incident"].get("incident_closed_timestamp") is not None:
        raise ApiError(409, "INCIDENT_CLOSED",
                       f"Incident {incident_id} is closed — closed records "
                       "are immutable.")
    return record


def _responder_status(responder_id: str) -> Optional[str]:
    r = next((r for r in slice_runner.SEED_RESPONDERS
              if r.responder_id == responder_id), None)
    return r.current_availability_status if r else None


class ResponderActionRequest(BaseModel):
    incident_id: str
    responder_id: str
    action: Literal["accept", "decline"]
    reason: Optional[str] = None


class CloseIncidentRequest(BaseModel):
    outcome: str
    confirmed_by: str
    closed_by_id: Optional[str] = None


class HelpBotStepRequest(BaseModel):
    incident_id: str
    responder_transcript: str = ""


router = APIRouter(prefix="/api/v1", tags=["Emergency Network"])


# ===========================================================================
# 1. REPORT — Module 1 triage + Module 3 dispatch + persistence (form-encoded)
# ===========================================================================

@router.post("/emergency/report", status_code=201)
def report_emergency(
    latitude: Optional[str] = Form(None),
    longitude: Optional[str] = Form(None),
    village_id: Optional[str] = Form(None),
    reporter_id: Optional[str] = Form(None),
    photo_ref: Optional[str] = Form(None),
    voice_ref: Optional[str] = Form(None),
    voice_transcript: Optional[str] = Form(None),
):
    """Register + triage + dispatch one emergency. Form-encoded because the
    field-app reports media refs alongside GPS; JSON validation errors map to
    string codes via manual checks (ordered: identity -> photo -> voice)."""
    # --- location + village identity first -> VALIDATION_ERROR -------------
    try:
        lat = float((latitude or "").strip())
        lon = float((longitude or "").strip())
    except ValueError:
        raise ApiError(400, "VALIDATION_ERROR",
                       "latitude and longitude are required numeric fields.")
    if not (village_id or "").strip():
        raise ApiError(400, "VALIDATION_ERROR", "village_id is required.")
    if not (-90.0 <= lat <= 90.0 and -180.0 <= lon <= 180.0):
        raise ApiError(400, "VALIDATION_ERROR",
                       "latitude/longitude out of range.")
    # --- both evidence channels are mandatory for triage -------------------
    if not (photo_ref or "").strip():
        raise ApiError(400, "MISSING_PHOTO",
                       "photo_ref is required — triage needs the injury photo.")
    if not (voice_ref or "").strip():
        raise ApiError(400, "MISSING_VOICE_INPUT",
                       "voice_ref is required — triage needs the voice note.")

    gps = slice_runner.GPSLocation(latitude=lat, longitude=lon,
                                   village_id=village_id.strip())
    # Module 1: registration + AI triage (cached media pairs burn zero quota).
    incident = slice_runner.registerIncident(
        photo_ref.strip(), voice_ref.strip(), gps,
        reporter_id=(reporter_id or "REP-USER-001").strip())

    # Attach live speech-to-text transcript if provided
    if (voice_transcript or "").strip():
        incident.voice_transcript = voice_transcript.strip()

    # Module 3 canonical entry (replaces legacy matchResponderAndBHU+dispatch):
    # match + notify + busy-mark + ack timer in one call.
    decision = dispatch_service.dispatchIncident(incident)
    record = slice_runner.logIncident(incident, decision)
    if (voice_transcript or "").strip():
        record["incident"]["voice_transcript"] = voice_transcript.strip()

    # Module 6.5: PostgreSQL archive (non-fatal — memory state commits first).
    db_persisted = True
    try:
        incident_model.upsert_incident_to_db(record)
    except Exception as exc:  # noqa: BLE001
        db_persisted = False
        _warn(f"PostgreSQL upsert failed for {incident.incident_id}: {exc}")

    return {
        "incident": incident.model_dump(),
        "dispatch": {
            "status": decision.status,
            "responder": (decision.selected_responder.model_dump()
                          if decision.selected_responder else None),
            "bhu": decision.bhu.model_dump() if decision.bhu else None,
            "notify_bhu": decision.notify_bhu,
            "bhu_urgency": decision.bhu_urgency,
            "ambulance_requested": decision.ambulance_requested,
            "reasoning": decision.reasoning,
        },
        "db_persisted": db_persisted,
    }


# ===========================================================================
# 2. INCIDENT RETRIEVAL — Module 6.5 full lifecycle record
# ===========================================================================

@router.get("/emergency/incident/{incident_id}")
def get_incident(incident_id: str):
    record = lifecycle.getIncidentRecord(incident_id)
    if record is None:
        raise ApiError(404, "INCIDENT_NOT_FOUND",
                       f"Incident {incident_id} is not registered.")
    return record


# ===========================================================================
# 3. RESPONDER RESPOND — Module 3 ack / decline with fallback walker
# ===========================================================================

@router.post("/responder/respond")
def responder_respond(payload: ResponderActionRequest):
    record = _require_open_record(payload.incident_id)
    incident = record["incident"]
    assigned = incident.get("responder_assigned_id")
    if assigned != payload.responder_id:
        raise ApiError(409, "NOT_ASSIGNED_RESPONDER",
                       f"Incident {payload.incident_id} is assigned to "
                       f"{assigned!r}, not {payload.responder_id!r}.")

    if payload.action == "accept":
        dispatch_service.acknowledgeDispatch(payload.incident_id,
                                             payload.responder_id)
    else:
        # Immediate fallback walk; the decliner returns to available.
        dispatch_service.handleResponderDecline(payload.incident_id,
                                                payload.responder_id)

    updated = (_fresh_record(payload.incident_id) or {}).get("incident", {})
    return {
        "incident_id": payload.incident_id,
        "action": payload.action,
        "reason": payload.reason,
        "responder_id": payload.responder_id,
        "responder_assigned_id": updated.get("responder_assigned_id"),
        "dispatch_events": updated.get("dispatch_events", []),
        "responder_status_after": _responder_status(payload.responder_id),
    }


# ===========================================================================
# 4. HELP-BOT STEP — stateful Module 2 guidance over stateless HTTP
# ===========================================================================

def _session_transition(session: dict, to_state: str, trigger_type: str,
                        detail: str) -> None:
    """Append a help_bot_transitions entry ON the incident (same trace the
    terminal session produces) and sync the INCIDENT_STORE snapshot."""
    incident = session["incident"]
    incident.help_bot_transitions.append({
        "timestamp": _now_iso(),
        "branch": session["branch_id"],
        "from_state": session["state"],
        "to_state": to_state,
        "trigger_type": trigger_type,
        "detail": str(detail)[:300],
    })
    session["state"] = to_state
    help_bot_service._sync_store_snapshot(incident)


def _create_session(incident_id: str, incident_dict: dict) -> dict:
    """First helpbot/step for an incident: rebuild the live Incident, route
    its flags to a knowledge branch, and enter at step 1.

    NOTE: this only LOGS `step_started` for step 1 — the line itself is
    delivered by the first `step_done` turn (see `step1_delivered` in
    helpbot_step). Nothing else speaks it, so without that the greeting which
    opens a session would advance straight to step 2 and step 1 would never be
    heard over HTTP."""
    incident = slice_runner.Incident(**incident_dict)
    help_bot_service.register_incident(incident)
    branch_id, matched = help_bot_service.route_branch(
        incident.injury_type_flags)
    branch = help_bot_service.BRANCHES[branch_id]
    session = {
        "incident": incident,
        "branch_id": branch_id,
        "branch_matched": matched,
        "branch": branch,
        "state": "created",
        "step_index": 0,
        "step1_delivered": False,
        "turns": [],
    }
    _session_transition(session, "initial_guidance", "branch_entered",
                        f"branch={branch_id}; matched={matched}; "
                        f"flags={incident.injury_type_flags}")
    steps = branch["steps"]
    if steps:
        _session_transition(session, "ongoing_monitor", "step_started",
                            f"step 1/{len(steps)}: {steps[0]['step_id']}")
    _HELPBOT_SESSIONS[incident_id] = session
    return session


def _current_step_line(session: dict) -> Optional[str]:
    steps = session["branch"]["steps"]
    idx = session["step_index"]
    if 0 <= idx < len(steps):
        return steps[idx]["line"]
    return None


def _recent_context(session: dict) -> list:
    return [f"{t['speaker']}: {t['text']}" for t in session["turns"][-6:]]


def _best_effort_audio(line: str) -> tuple:
    """Cached-TTS URL for the spoken line (synthesized on cache miss, disk-
    cached thereafter). Never fails the turn — text replies stand alone."""
    try:
        tts = help_bot_service.speakGuidance(line)
        return (f"/media/helpbot/tts_cache/{Path(tts['wav_path']).name}",
                bool(tts["cached"]))
    except Exception as exc:  # noqa: BLE001 — audio is enhancement, not core
        _warn(f"TTS unavailable for help-bot line ({exc}); text reply only.")
        return None, False


@router.post("/helpbot/step")
def helpbot_step(payload: HelpBotStepRequest):
    record = _require_open_record(payload.incident_id)
    session = (_HELPBOT_SESSIONS.get(payload.incident_id)
               or _create_session(payload.incident_id, record["incident"]))
    branch = session["branch"]
    transcript = (payload.responder_transcript or "").strip()
    session["turns"].append({"speaker": "responder", "text": transcript,
                             "timestamp": _now_iso()})

    escalated = False
    escalation_snapshot = None
    qa_entry_id = None
    escalation_signal = None

    if not transcript:
        # Zero AI calls on empty input: fail-safe line, never silence.
        intent_name = help_bot_service.INTENT_UNCLEAR
        _session_transition(session, session["state"], "unintelligible_input",
                            "empty transcript; fail-safe line spoken")
        spoken = help_bot_service.SHARED_LINES["failsafe_line"]
    else:
        intent = help_bot_service.detectResponderIntent(
            session["branch_id"], transcript,
            current_step_line=_current_step_line(session),
            recent_context=_recent_context(session))
        intent_name = intent["intent"]
        qa_entry_id = intent.get("qa_entry_id")
        escalation_signal = intent.get("escalation_signal")

        if not session.get("branch_matched", True):
            _session_transition(session, session["state"],
                                "unmapped_branch_fallback",
                                "injury not in predefined branches; honest fallback")
            spoken = help_bot_service.SHARED_LINES["out_of_scope_fallback"]

        elif intent_name == help_bot_service.INTENT_STEP_DONE:
            steps = branch["steps"]
            if steps and not session.get("step1_delivered", True):
                # `_create_session` logged `step_started` for step 1 but never
                # returned its line over HTTP. Speak it now instead of
                # advancing, so the greeting that opens a session receives the
                # FIRST aid step rather than silently skipping to step 2.
                # Deterioration on turn 1 is unaffected: it classifies as
                # `escalation` above and never reaches this branch.
                session["step1_delivered"] = True
                _session_transition(
                    session, "ongoing_monitor", "step_started",
                    f"step 1/{len(steps)}: {steps[0]['step_id']} "
                    f"(initial line delivered on first step_done turn)")
                spoken = steps[0]["line"]
            else:
                session["step_index"] += 1
                if session["step_index"] < len(steps):
                    step = steps[session["step_index"]]
                    _session_transition(
                        session, "ongoing_monitor", "step_started",
                        f"step {session['step_index'] + 1}/{len(steps)}: "
                        f"{step['step_id']}")
                    spoken = step["line"]
                else:
                    _session_transition(session, "ongoing_monitor",
                        "steps_complete",
                        "all scripted steps delivered")
                    spoken = help_bot_service.SHARED_LINES["session_complete_line"]

        elif intent_name == help_bot_service.INTENT_IN_SCOPE:
            entry = next((e for e in branch["qa_entries"]
                          if e["qa_id"] == qa_entry_id), None)
            if entry is not None:
                _session_transition(session, session["state"],
                                    "in_scope_question",
                                    f"qa_entry={entry['qa_id']}")
                spoken = entry["answer"]
            else:
                _session_transition(session, session["state"],
                                    "unintelligible_input",
                                    "in_scope intent without resolvable "
                                    "qa_entry; fail-safe spoken")
                spoken = help_bot_service.SHARED_LINES["failsafe_line"]

        elif intent_name == help_bot_service.INTENT_OUT_OF_SCOPE:
            _session_transition(session, session["state"],
                                "out_of_scope_question",
                                "honest fallback; no improvisation")
            spoken = help_bot_service.SHARED_LINES["out_of_scope_fallback"]

        elif intent_name == help_bot_service.INTENT_ESCALATION:
            signal = escalation_signal or "condition_worsening"
            suggested = intent.get("suggested_tier") or "critical"
            _session_transition(session, "escalated_monitor",
                                "escalation_triggered",
                                f"signal={signal}; suggested_tier={suggested}")
            spoken = " ".join(branch["escalated_guidance"])
            escalated = True
            # Documented Module 2 -> 3 wiring: escalateIncident FIRST, then
            # Module 3 picks up the delta notifications from the snapshot.
            escalation_snapshot = help_bot_service.escalateIncident(
                payload.incident_id, {
                    "trigger": signal,
                    "suggested_tier": suggested,
                    "new_flags": [signal],
                    "transcript_excerpt": transcript,
                })
            dispatch_service.handleEscalation(payload.incident_id,
                                              escalation_snapshot)

        else:  # unclear / classifier failure: fail-safe, never silence
            _session_transition(session, session["state"],
                                "unintelligible_input",
                                "fail-safe line spoken; session continues")
            spoken = help_bot_service.SHARED_LINES["failsafe_line"]

    session["turns"].append({"speaker": "bot", "text": spoken,
                             "timestamp": _now_iso()})
    audio_url, audio_cached = _best_effort_audio(spoken)
    steps = branch["steps"]
    idx = session["step_index"]
    return {
        "incident_id": payload.incident_id,
        "branch_id": session["branch_id"],
        "state": session["state"],
        "intent": intent_name,
        "qa_entry_id": qa_entry_id,
        "escalation_signal": escalation_signal,
        "escalated": escalated,
        "escalation_snapshot": escalation_snapshot,
        "spoken_text_urdu": spoken,
        "step_index": idx,
        "step_id": steps[idx]["step_id"] if 0 <= idx < len(steps) else None,
        "turn_count": len(session["turns"]),
        "audio_url": audio_url,
        "audio_cached": audio_cached,
    }


# ===========================================================================
# 5. CLOSE + OUTCOME RECORD — Module 6 closure, Module 5 metrics contribution
# ===========================================================================

@router.post("/emergency/incident/{incident_id}/close")
def close_incident(incident_id: str, payload: CloseIncidentRequest):
    record = _fresh_record(incident_id)
    if record is None:
        raise ApiError(404, "INCIDENT_NOT_FOUND",
                       f"Incident {incident_id} is not registered.")
    if record["incident"].get("incident_closed_timestamp") is not None:
        raise ApiError(409, "ALREADY_CLOSED",
                       f"Incident {incident_id} is already closed — closed "
                       "records are immutable.")
    if payload.outcome not in lifecycle.VALID_OUTCOMES:
        raise ApiError(400, "VALIDATION_ERROR",
                       f"outcome must be one of "
                       f"{list(lifecycle.VALID_OUTCOMES)}.")
    if payload.confirmed_by not in lifecycle.VALID_CONFIRMERS:
        raise ApiError(400, "VALIDATION_ERROR",
                       f"confirmed_by must be one of "
                       f"{list(lifecycle.VALID_CONFIRMERS)}.")

    snapshot = lifecycle.closeIncident(incident_id, payload.outcome,
                                       payload.confirmed_by)

    # Module 5 fraud gate: only BHU-verified closures contribute metrics.
    # Self-reported (confirmed_by="responder") closures are never counted.
    outcome_recorded = None
    if payload.confirmed_by == "bhu_staff":
        outcome_recorded = accountability_service.awardPointsForIncident(
            incident_id)

    # Session cleanup: guidance ends when the incident closes.
    _HELPBOT_SESSIONS.pop(incident_id, None)

    return {
        "incident": snapshot,
        "outcome_recorded": outcome_recorded,
        "closed_by_id": payload.closed_by_id,
    }


# ===========================================================================
# 6. ACCOUNTABILITY SURFACE — Module 5 factual performance record
# ===========================================================================
# No score, no tier, no ranking. The former /accountability/leaderboard
# endpoint was removed together with the points system: ranking responders by
# a composite score incentivises scoring well over helping, which is the wrong
# objective for a life-critical system (it can push responders away from
# harder, messier incidents unlikely to produce a clean high-scoring outcome).
# A view ranking ONE factual metric (e.g. fastest average response time, or
# most incidents helped) remains a reasonable future addition — deliberately
# not designed or built inside this change.

@router.get("/accountability/responder/{responder_id}/performance")
def responder_performance_record(responder_id: str):
    """Module 5 ResponderPerformanceRecord — auditable metrics only.

    Pure read, recomputed deterministically from BHU-confirmed closures and
    the Module 3 dispatch_events audit. Carries no point values and no tier:
    incidents_responded_to, incidents_by_outcome, average_response_time_seconds,
    timeout_count, decline_count, dispatch_metrics and status_flag.
    """
    if responder_model.get_responder_from_db(responder_id) is None:
        raise ApiError(404, "RESPONDER_NOT_FOUND",
                       f"Responder {responder_id} is not in the registry.")
    return accountability_service.getResponderPerformanceRecord(responder_id)


from services import onboarding_service


class RegisterResponderRequest(BaseModel):
    name: str
    village: str
    phone_number: str
    linked_bhu_id: str
    responder_id: Optional[str] = None
    training_completed: bool = False
    training_org: Optional[str] = None
    equipment_checklist: Optional[list] = None


class VerifyResponderRequest(BaseModel):
    verified_by: str
    equipment_checklist: list


# ===========================================================================
# 7. RESPONDER ONBOARDING & REGISTRY VIEWS (Module 7)
# ===========================================================================

@router.post("/responders/register", status_code=201)
def register_responder(body: RegisterResponderRequest):
    """Register a new candidate responder profile.

    Candidate starts in an unverified state (is_verified=False,
    current_availability_status='unverified') and cannot be dispatched until
    verified by an authorized trainer or BHU.
    """
    try:
        data = body.model_dump()
        created = onboarding_service.registerCandidateResponder(data)
        return created
    except ValueError as exc:
        raise ApiError(400, "INVALID_REGISTRATION", str(exc))
    except Exception as exc:
        raise ApiError(500, "REGISTRATION_FAILED", f"Registration failed: {exc}")


@router.post("/responders/{responder_id}/verify", status_code=200)
def verify_responder(responder_id: str, body: VerifyResponderRequest):
    """Admin / trainer sign-off endpoint to verify a responder."""
    try:
        verified = onboarding_service.signOffResponder(
            responder_id=responder_id,
            verified_by=body.verified_by,
            equipment_checklist=body.equipment_checklist,
        )
        return verified
    except KeyError as exc:
        raise ApiError(404, "RESPONDER_NOT_FOUND", str(exc))
    except ValueError as exc:
        raise ApiError(400, "INVALID_VERIFICATION", str(exc))
    except Exception as exc:
        raise ApiError(500, "VERIFICATION_FAILED", f"Verification failed: {exc}")


@router.get("/responders/pending")
def list_pending_responders(village_id: Optional[str] = None):
    """List all candidate responders awaiting verification review."""
    pending = onboarding_service.listPendingVerifications(village_id=village_id)
    return {
        "pending_responders": pending,
        "count": len(pending),
    }


@router.delete("/responders/pending/clear")
def clear_pending_responders():
    """Delete all unverified candidate responders from DB and in-memory state."""
    count = onboarding_service.clearPendingResponders()
    return {
        "status": "cleared",
        "cleared_count": count,
    }


@router.delete("/responders/{responder_id}")
def delete_responder(responder_id: str):
    """Delete a single candidate responder by ID."""
    deleted = onboarding_service.deleteCandidateResponder(responder_id)
    return {
        "status": "deleted" if deleted else "not_found",
        "responder_id": responder_id,
    }


@router.get("/responders")
def list_responders(
    village_id: Optional[str] = None,
    verified: Optional[bool] = None,
):
    """In-memory responder registry with live availability & verification status.

    Optionally filter by village_id and verified boolean.
    """
    responders = []
    for r in slice_runner.SEED_RESPONDERS:
        if village_id is not None and r.village != village_id:
            continue
        is_ver = getattr(r, "is_verified", False)
        if verified is not None and is_ver != verified:
            continue
        responders.append({
            "responder_id": r.responder_id,
            "name": r.name,
            "village": r.village,
            "linked_bhu_id": r.linked_bhu_id,
            "current_availability_status": r.current_availability_status,
            "phone_number": getattr(r, "phone_number", None),
            "is_verified": is_ver,
            "verified_by": getattr(r, "verified_by", None),
            "verified_at": getattr(r, "verified_at", None),
            "equipment_checklist": getattr(r, "equipment_checklist", None),
        })
    return {
        "responders": responders,
    }


# ===========================================================================
# 8. MODULE 8 & 9: REPORTER TIMELINE & RESPONDER ARRIVAL
# ===========================================================================

class ResponderArrivedRequest(BaseModel):
    incident_id: str
    responder_id: str


@router.post("/responder/arrived")
def responder_arrived(payload: ResponderArrivedRequest):
    """Responder check-in upon reaching the incident location (Module 9)."""
    record = _fresh_record(payload.incident_id)
    if record is None:
        raise ApiError(404, "INCIDENT_NOT_FOUND",
                       f"Incident {payload.incident_id} is not registered.")
    try:
        update_entry = lifecycle.recordResponderArrival(payload.incident_id, payload.responder_id)
        return {
            "status": "ok",
            "incident_id": payload.incident_id,
            "arrival_update": update_entry,
        }
    except ValueError as exc:
        raise ApiError(400, "INVALID_ARRIVAL", str(exc))
    except Exception as exc:
        raise ApiError(500, "ARRIVAL_FAILED", f"Arrival check-in failed: {exc}")


# Reporter-facing lifecycle stages that advance the timeline status past the
# frozen Module 3 dispatch decision. "acknowledged" is the stage the demo
# script calls "acked".
_STAGE_TO_LIFECYCLE_STATUS = {
    "responder_en_route": "acknowledged",
    "responder_arrived": "arrived",
}


@router.get("/emergency/incident/{incident_id}/timeline")
def get_incident_timeline(incident_id: str):
    """Dedicated endpoint for distressed reporter status tracking (Module 9).

    Returns lightweight chronological Urdu status updates, coverage gap flags,
    and current lifecycle stage without expensive long-polling.
    """
    record = _fresh_record(incident_id)
    if record is None:
        raise ApiError(404, "INCIDENT_NOT_FOUND",
                       f"Incident {incident_id} is not registered.")

    inc = record.get("incident", {})
    dispatch_status = record.get("dispatch_status")
    updates = inc.get("reporter_updates") or []

    # `dispatch_status` is frozen at the Module 3 decision, so on its own the
    # reporter's feed would keep reading "dispatched" for the whole incident —
    # the acknowledgment and the arrival would never show up as a stage change.
    # Walk the updates backwards for the latest responder-lifecycle stage and
    # let it advance the reported status. Only those two stages override: a
    # coverage-gap dispatch must keep reporting escalated_bhu_only /
    # no_responders_available rather than a stage it never reached.
    live_stage = None
    for update in reversed(updates):
        mapped = _STAGE_TO_LIFECYCLE_STATUS.get(update.get("stage"))
        if mapped is not None:
            live_stage = mapped
            break

    if inc.get("incident_closed_timestamp") is not None:
        current_status = "closed"
    elif live_stage is not None:
        current_status = live_stage
    elif dispatch_status is not None:
        current_status = dispatch_status
    elif inc.get("responder_assigned_id"):
        current_status = "dispatched"
    elif inc.get("bhu_notified"):
        current_status = "escalated_bhu_only"
    else:
        current_status = "open"

    return {
        "incident_id": inc.get("incident_id", incident_id),
        "status": current_status,
        "severity_tier": inc.get("severity_tier"),
        "assigned_responder": inc.get("responder_assigned_id"),
        "coverage_gap": bool(inc.get("coverage_gap", False)),
        "mid_incident_escalated": bool(inc.get("mid_incident_escalated", False)),
        "updates": updates,
    }


