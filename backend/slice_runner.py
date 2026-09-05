import os
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Optional, Literal

from dotenv import load_dotenv
from pydantic import BaseModel

# ==========================================
# 0. ENVIRONMENT (DASHSCOPE CREDENTIALS)
# ==========================================
# The API key lives in the repo-root .env (one level above this backend/ dir).
# The key is NEVER printed or logged anywhere in this module.
load_dotenv(dotenv_path=Path(__file__).resolve().parent.parent / ".env")

# The stored key is an international Model Studio key: the China endpoint
# rejects it (InvalidApiKey) while dashscope-intl authenticates it. Select the
# endpoint explicitly via DASHSCOPE_BASE_URL in .env, otherwise auto-detect.
_DASHSCOPE_ENDPOINTS = {
    "intl": "https://dashscope-intl.aliyuncs.com/api/v1",
    "cn": "https://dashscope.aliyuncs.com/api/v1",
}


def _configure_dashscope_endpoint() -> None:
    base_url = os.environ.get("DASHSCOPE_BASE_URL")
    if not base_url:
        key = os.environ.get("DASHSCOPE_API_KEY", "")
        # International keys are longer than legacy China-region keys.
        base_url = _DASHSCOPE_ENDPOINTS["intl" if len(key) > 60 else "cn"]
    dashscope.base_http_api_url = base_url


def _get_api_key() -> str:
    api_key = os.environ.get("DASHSCOPE_API_KEY")
    if not api_key:
        raise RuntimeError(
            "DASHSCOPE_API_KEY is not set. Add it to the project-root .env file "
            "(never hardcode or commit it)."
        )
    return api_key


def _get_gemini_key() -> str:
    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        raise RuntimeError(
            "GEMINI_API_KEY is not set. Add it to the project-root .env file."
        )
    return api_key


def _triage_timeout_s() -> int:
    """Per-AI-call timeout in seconds. On expiry the call raises, which routes
    the pipeline to the fail-safe tier ('moderate' + low_confidence_triage)
    instead of blocking the emergency flow."""
    return int(os.environ.get("TRIAGE_CALL_TIMEOUT_S", "30"))


def _gemini_client():
    from google import genai
    from google.genai import types

    return genai.Client(
        api_key=_get_gemini_key(),
        http_options=types.HttpOptions(timeout=_triage_timeout_s() * 1000),
    )


def _normalize_gemini_model(model_name: Optional[str], default: str = "gemini-3.1-flash-lite") -> str:
    """Safely map Gemini model names, correcting non-existent aliases like 'gemini-3.1-flash'."""
    if not model_name or not str(model_name).strip():
        return default
    m = str(model_name).strip()
    if m == "gemini-3.1-flash":
        return "gemini-3.1-flash-lite"
    return m


def _call_with_retry(fn, step_name: str):
    """Run an AI call; retry on quota/rate-limit errors (429) with backoff.

    Free-tier quotas replenish over time, so a bounded wait-then-retry keeps
    the pipeline usable during demos. Any final failure raises and is handled
    by the step wrapper's fail-safe.

    Backoff is env-driven so replay/test runs can fail fast instead of
    stalling the terminal waiting on quota replenishment:

      TRIAGE_RETRY_BACKOFF_S   base backoff (seconds) per attempt. Default 15.
                               Capped at 60 so a misconfigured value cannot
                               stall indefinitely.
      LIFELINE_REPLAY_MODE=1   shortcut: forces base=2. Set automatically by
                               help_bot_runner.py for --mode replay and
                               --verify-tts; set manually for ad-hoc tests.

    Worst-case terminal stall (3 attempts, default base 15) = 15+30 = 45s/turn.
    In replay mode (base 2) = 2+4 = 6s/turn.
    """
    import time

    # Auto-fast-fail when the runner has flagged a replay/test run; otherwise
    # honour the explicit per-base env var, then fall back to the default 15s.
    if os.environ.get("LIFELINE_REPLAY_MODE", "").lower() in ("1", "true", "yes"):
        base_backoff_s = 2
    else:
        base_backoff_s = int(os.environ.get("TRIAGE_RETRY_BACKOFF_S", "15"))

    attempts = int(os.environ.get("TRIAGE_QUOTA_RETRIES", "3"))
    for attempt in range(1, attempts + 1):
        try:
            return fn()
        except Exception as exc:
            message = str(exc)
            if "429" not in message and "RESOURCE_EXHAUSTED" not in message:
                raise
            if attempt == attempts:
                raise
            wait_s = min(base_backoff_s * attempt, 60)
            mode_tag = " (replay-mode fast backoff)" if base_backoff_s == 2 else ""
            print(f"  [TRIAGE RETRY] {step_name} hit a quota limit; "
                  f"waiting {wait_s}s (attempt {attempt}/{attempts - 1}){mode_tag}.")
            time.sleep(wait_s)


_MEDIA_CACHE_DIR = Path(__file__).resolve().parent.parent / "mockdata" / "media" / ".triage_cache"


def _triage_cache_path(photo_ref: str, voice_ref: str) -> Path:
    import hashlib

    key = hashlib.sha256(f"{photo_ref}|{voice_ref}".encode("utf-8")).hexdigest()[:16]
    return _MEDIA_CACHE_DIR / f"{key}.json"


def _load_cached_triage(photo_ref: str, voice_ref: str) -> Optional[dict]:
    import json

    path = _triage_cache_path(photo_ref, voice_ref)
    if path.is_file():
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return None
    return None


def _save_triage_cache(photo_ref: str, voice_ref: str, result: dict) -> None:
    import json

    # Only cache genuine AI-derived results, never fail-safe fallbacks, so a
    # quota blip doesn't poison the cache with a degraded tier.
    if "low_confidence_triage" in result.get("injury_type_flags", []):
        return
    _MEDIA_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    _triage_cache_path(photo_ref, voice_ref).write_text(
        json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8"
    )


# ---------------------------------------------------------------------------
# AI PROVIDER SELECTION (temporary Gemini default, DashScope swap-back ready)
# ---------------------------------------------------------------------------
# DashScope model access is being activated (China-region account in progress).
# Until then Gemini serves all three AI steps. Flip the provider by setting
# TRIAGE_AI_PROVIDER=dashscope in the repo-root .env - no code changes needed.
def _ai_provider() -> str:
    return os.environ.get("TRIAGE_AI_PROVIDER", "gemini").lower()


# DashScope SDK import is deferred so the module can still be imported/inspected
# in environments without the SDK installed; the real triage pipeline enforces it.
try:
    import dashscope
    from dashscope import Generation, MultiModalConversation
    from dashscope.audio.asr import Transcription
    from dashscope.utils.oss_utils import upload_file as _dashscope_upload_file
    _DASHSCOPE_IMPORT_ERROR = None
except ImportError as exc:  # environment-dependent
    _DASHSCOPE_IMPORT_ERROR = exc
else:
    _configure_dashscope_endpoint()

# ==========================================
# 1. DATA CONTRACTS (STABLE SPECIFICATION)
# ==========================================

SeverityTier = Literal["minor", "moderate", "critical"]
OutcomeType = Literal["self-resolved", "taken_to_bhu", "referred_to_hospital", "unresolved"]
AvailabilityStatus = Literal["unverified", "available", "busy", "offline"]


class GPSLocation(BaseModel):
    latitude: float
    longitude: float
    village_id: str


class Incident(BaseModel):
    incident_id: str
    timestamp_reported: str
    reporter_id: str
    gps_location: GPSLocation
    photo_ref: str
    voice_transcript: str
    severity_tier: SeverityTier
    injury_type_flags: List[str]
    responder_assigned_id: Optional[str] = None
    responder_dispatch_timestamp: Optional[str] = None
    bhu_notified: bool = False
    bhu_notify_timestamp: Optional[str] = None
    ambulance_requested: bool = False
    outcome: Optional[OutcomeType] = None
    # ADDITIVE (Module 6): Who confirmed the outcome — required for closure.
    # "responder" = self-reported, "bhu_staff" = verified by the BHU side
    # (the confirmation Module 5's points awarding will key off).
    outcome_confirmed_by: Optional[Literal["responder", "bhu_staff"]] = None
    # ADDITIVE (Module 6): ISO timestamp when the incident was closed with a
    # confirmed outcome. None = incident still open.
    incident_closed_timestamp: Optional[str] = None
    # ADDITIVE (Module 2): Responder Help Bot state-transition log. Never
    # written by Module 1; appended by the help-bot session (branch entered,
    # steps, intents, escalations) for later Module 5 accountability review.
    help_bot_transitions: List[dict] = []
    # ADDITIVE (Module 3): Dispatch event log — timestamped trace of every
    # dispatch, fallback, BHU notification, ambulance request, escalation
    # re-dispatch, and decline event. Mirrors help_bot_transitions discipline.
    dispatch_events: List[dict] = []
    # ADDITIVE (Module 3): How many times the fallback walker was triggered for
    # this incident (responder timeout or explicit decline). Zero = primary
    # responder dispatched and acknowledged (or BHU-only from the start).
    dispatch_fallback_count: int = 0
    # ADDITIVE (Module 8): Village coverage gap flag — True when all village candidates
    # are exhausted / unavailable and the incident had to escalate to BHU-only.
    coverage_gap: bool = False
    # ADDITIVE (Module 8): Mid-incident condition escalation flag — True if
    # upgraded from within a help-bot session.
    mid_incident_escalated: bool = False
    # ADDITIVE (Module 9): Responder arrival check-in timestamp.
    responder_arrived_timestamp: Optional[str] = None
    # ADDITIVE: Localized Urdu timeline status updates for distressed reporters.
    reporter_updates: List[dict] = []
    # ADDITIVE: Gemini multimodal anticipated condition and emergency detection.
    detected_emergency: Optional[str] = None
    anticipated_condition: Optional[str] = None
    first_aid_guidance: Optional[List[str]] = None



class Responder(BaseModel):
    responder_id: str
    name: str
    village: str
    linked_bhu_id: str
    current_availability_status: AvailabilityStatus
    points_total: int = 0
    phone_number: Optional[str] = None
    is_verified: bool = False
    verified_by: Optional[str] = None
    verified_at: Optional[str] = None
    training_completed: bool = False
    training_org: Optional[str] = None
    equipment_checklist: Optional[List[str]] = None


class BHU(BaseModel):
    bhu_id: str
    name: str
    union_council: str
    linked_village_ids: List[str]


class DispatchResult(BaseModel):
    incident_id: str
    responder: Optional[Responder]
    bhu: Optional[BHU]
    ambulance_requested: bool
    status: Literal["dispatched", "escalated_bhu_only", "no_responders_available"]


# ==========================================
# 2. SEED DATA
# ==========================================

SEED_BHUS: List[BHU] = [
    BHU(
        bhu_id="BHU-001",
        name="Chak 45 Basic Health Unit",
        union_council="UC-7 North",
        linked_village_ids=["VILLAGE-A", "VILLAGE-B"]
    ),
    BHU(
        bhu_id="BHU-002",
        name="Dera Ghazi Union Health Center",
        union_council="UC-12 South",
        linked_village_ids=["VILLAGE-C"]
    ),
    # Real Tamman/Talagang pilot facilities. The legacy VILLAGE-A/B groups
    # remain untouched for backwards-compatible tests; these facilities are
    # selected whenever a real locality id is submitted.
    BHU(
        bhu_id="BHU-003",
        name="BHU Dhermond",
        union_council="Dhermond",
        linked_village_ids=["DHERMOND", "SANGWALA", "DAROT", "BEDHAR"],
    ),
    BHU(
        bhu_id="BHU-004",
        name="BHU Multan Khurd",
        union_council="Multan Khurd",
        linked_village_ids=["MULTAN-KHURD"],
    ),
    BHU(
        bhu_id="BHU-005",
        name="BHU Patwali",
        union_council="Patwali",
        linked_village_ids=["PATWALI", "BUDHIAL", "JASIAL", "KOT-SARANG", "JHATLA"],
    ),
]

SEED_RESPONDERS: List[Responder] = [
    # ── Tamman (3 responders) ────────────────────────────────────────────────
    Responder(
        responder_id="RESP-TAM-01",
        name="Tariq Mahmood",
        village="TAMMAN",
        linked_bhu_id="BHU-001",
        current_availability_status="available",
        points_total=120,
        phone_number="+923001234101",
        is_verified=True,
        verified_by="SEED_ADMIN",
        verified_at="2026-01-01T00:00:00+00:00",
        training_completed=True,
        training_org="Rescue 1122",
        equipment_checklist=["tourniquet", "pressure_bandages", "splints", "antiseptic"],
    ),
    Responder(
        responder_id="RESP-TAM-02",
        name="Farhan Ali",
        village="TAMMAN",
        linked_bhu_id="BHU-001",
        current_availability_status="available",
        points_total=85,
        phone_number="+923001234102",
        is_verified=True,
        verified_by="SEED_ADMIN",
        verified_at="2026-01-01T00:00:00+00:00",
        training_completed=True,
        training_org="Rescue 1122",
        equipment_checklist=["tourniquet", "pressure_bandages", "splints", "antiseptic"],
    ),
    Responder(
        responder_id="RESP-TAM-03",
        name="Zubair Khan",
        village="TAMMAN",
        linked_bhu_id="BHU-001",
        current_availability_status="available",
        points_total=40,
        phone_number="+923001234103",
        is_verified=True,
        verified_by="SEED_ADMIN",
        verified_at="2026-01-01T00:00:00+00:00",
        training_completed=True,
        training_org="Pakistan Red Crescent",
        equipment_checklist=["tourniquet", "pressure_bandages", "splints", "antiseptic"],
    ),

    # ── Dhermond (3 responders) ──────────────────────────────────────────────
    Responder(
        responder_id="RESP-DHR-01",
        name="Malik Aslam",
        village="DHERMOND",
        linked_bhu_id="BHU-003",
        current_availability_status="available",
        points_total=95,
        phone_number="+923001234201",
        is_verified=True,
        verified_by="SEED_ADMIN",
        verified_at="2026-01-01T00:00:00+00:00",
        training_completed=True,
        training_org="Rescue 1122",
        equipment_checklist=["tourniquet", "pressure_bandages", "splints", "antiseptic"],
    ),
    Responder(
        responder_id="RESP-DHR-02",
        name="Hamza Rasheed",
        village="DHERMOND",
        linked_bhu_id="BHU-003",
        current_availability_status="available",
        points_total=60,
        phone_number="+923001234202",
        is_verified=True,
        verified_by="SEED_ADMIN",
        verified_at="2026-01-01T00:00:00+00:00",
        training_completed=True,
        training_org="Rescue 1122",
        equipment_checklist=["tourniquet", "pressure_bandages", "splints", "antiseptic"],
    ),
    Responder(
        responder_id="RESP-DHR-03",
        name="Usman Qureshi",
        village="DHERMOND",
        linked_bhu_id="BHU-003",
        current_availability_status="available",
        points_total=30,
        phone_number="+923001234203",
        is_verified=True,
        verified_by="SEED_ADMIN",
        verified_at="2026-01-01T00:00:00+00:00",
        training_completed=True,
        training_org="DoH",
        equipment_checklist=["tourniquet", "pressure_bandages", "splints", "antiseptic"],
    ),

    # ── Multan Khurd (3 responders) ──────────────────────────────────────────
    Responder(
        responder_id="RESP-MLT-01",
        name="Bilal Shah",
        village="MULTAN-KHURD",
        linked_bhu_id="BHU-004",
        current_availability_status="available",
        points_total=110,
        phone_number="+923001234301",
        is_verified=True,
        verified_by="SEED_ADMIN",
        verified_at="2026-01-01T00:00:00+00:00",
        training_completed=True,
        training_org="Pakistan Red Crescent",
        equipment_checklist=["tourniquet", "pressure_bandages", "splints", "antiseptic"],
    ),
    Responder(
        responder_id="RESP-MLT-02",
        name="Kashif Nadeem",
        village="MULTAN-KHURD",
        linked_bhu_id="BHU-004",
        current_availability_status="available",
        points_total=75,
        phone_number="+923001234302",
        is_verified=True,
        verified_by="SEED_ADMIN",
        verified_at="2026-01-01T00:00:00+00:00",
        training_completed=True,
        training_org="Rescue 1122",
        equipment_checklist=["tourniquet", "pressure_bandages", "splints", "antiseptic"],
    ),
    Responder(
        responder_id="RESP-MLT-03",
        name="Waqas Ahmed",
        village="MULTAN-KHURD",
        linked_bhu_id="BHU-004",
        current_availability_status="available",
        points_total=45,
        phone_number="+923001234303",
        is_verified=True,
        verified_by="SEED_ADMIN",
        verified_at="2026-01-01T00:00:00+00:00",
        training_completed=True,
        training_org="Rescue 1122",
        equipment_checklist=["tourniquet", "pressure_bandages", "splints", "antiseptic"],
    ),

    # ── Patwali (3 responders) ───────────────────────────────────────────────
    Responder(
        responder_id="RESP-PAT-01",
        name="Adnan Siddiqui",
        village="PATWALI",
        linked_bhu_id="BHU-005",
        current_availability_status="available",
        points_total=130,
        phone_number="+923001234401",
        is_verified=True,
        verified_by="SEED_ADMIN",
        verified_at="2026-01-01T00:00:00+00:00",
        training_completed=True,
        training_org="Rescue 1122",
        equipment_checklist=["tourniquet", "pressure_bandages", "splints", "antiseptic"],
    ),
    Responder(
        responder_id="RESP-PAT-02",
        name="Naveed Iqbal",
        village="PATWALI",
        linked_bhu_id="BHU-005",
        current_availability_status="available",
        points_total=70,
        phone_number="+923001234402",
        is_verified=True,
        verified_by="SEED_ADMIN",
        verified_at="2026-01-01T00:00:00+00:00",
        training_completed=True,
        training_org="Pakistan Red Crescent",
        equipment_checklist=["tourniquet", "pressure_bandages", "splints", "antiseptic"],
    ),
    Responder(
        responder_id="RESP-PAT-03",
        name="Sohail Abbas",
        village="PATWALI",
        linked_bhu_id="BHU-005",
        current_availability_status="available",
        points_total=35,
        phone_number="+923001234403",
        is_verified=True,
        verified_by="SEED_ADMIN",
        verified_at="2026-01-01T00:00:00+00:00",
        training_completed=True,
        training_org="DoH",
        equipment_checklist=["tourniquet", "pressure_bandages", "splints", "antiseptic"],
    ),

    # ── Sangwala (3 responders) ──────────────────────────────────────────────
    Responder(
        responder_id="RESP-SNG-01",
        name="Mohsin Raza",
        village="SANGWALA",
        linked_bhu_id="BHU-003",
        current_availability_status="available",
        points_total=105,
        phone_number="+923001234511",
        is_verified=True,
        verified_by="SEED_ADMIN",
        verified_at="2026-01-01T00:00:00+00:00",
        training_completed=True,
        training_org="Rescue 1122",
        equipment_checklist=["tourniquet", "pressure_bandages", "splints", "antiseptic"],
    ),
    Responder(
        responder_id="RESP-SNG-02",
        name="Arslan Javed",
        village="SANGWALA",
        linked_bhu_id="BHU-003",
        current_availability_status="available",
        points_total=65,
        phone_number="+923001234512",
        is_verified=True,
        verified_by="SEED_ADMIN",
        verified_at="2026-01-01T00:00:00+00:00",
        training_completed=True,
        training_org="Pakistan Red Crescent",
        equipment_checklist=["tourniquet", "pressure_bandages", "splints", "antiseptic"],
    ),
    Responder(
        responder_id="RESP-SNG-03",
        name="Babar Azam",
        village="SANGWALA",
        linked_bhu_id="BHU-003",
        current_availability_status="available",
        points_total=50,
        phone_number="+923001234513",
        is_verified=True,
        verified_by="SEED_ADMIN",
        verified_at="2026-01-01T00:00:00+00:00",
        training_completed=True,
        training_org="Rescue 1122",
        equipment_checklist=["tourniquet", "pressure_bandages", "splints", "antiseptic"],
    ),

    # ── Darot (3 responders) ─────────────────────────────────────────────────
    Responder(
        responder_id="RESP-DRT-01",
        name="Kamran Akmal",
        village="DAROT",
        linked_bhu_id="BHU-003",
        current_availability_status="available",
        points_total=90,
        phone_number="+923001234601",
        is_verified=True,
        verified_by="SEED_ADMIN",
        verified_at="2026-01-01T00:00:00+00:00",
        training_completed=True,
        training_org="Rescue 1122",
        equipment_checklist=["tourniquet", "pressure_bandages", "splints", "antiseptic"],
    ),
    Responder(
        responder_id="RESP-DRT-02",
        name="Faisal Masood",
        village="DAROT",
        linked_bhu_id="BHU-003",
        current_availability_status="available",
        points_total=55,
        phone_number="+923001234602",
        is_verified=True,
        verified_by="SEED_ADMIN",
        verified_at="2026-01-01T00:00:00+00:00",
        training_completed=True,
        training_org="DoH",
        equipment_checklist=["tourniquet", "pressure_bandages", "splints", "antiseptic"],
    ),
    Responder(
        responder_id="RESP-DRT-03",
        name="Zahid Hussain",
        village="DAROT",
        linked_bhu_id="BHU-003",
        current_availability_status="available",
        points_total=25,
        phone_number="+923001234603",
        is_verified=True,
        verified_by="SEED_ADMIN",
        verified_at="2026-01-01T00:00:00+00:00",
        training_completed=True,
        training_org="Pakistan Red Crescent",
        equipment_checklist=["tourniquet", "pressure_bandages", "splints", "antiseptic"],
    ),

    # ── Wanhar (3 responders) ────────────────────────────────────────────────
    Responder(
        responder_id="RESP-WNH-01",
        name="Sajid Mehmood",
        village="WANHAR",
        linked_bhu_id="BHU-003",
        current_availability_status="available",
        points_total=115,
        phone_number="+923001234701",
        is_verified=True,
        verified_by="SEED_ADMIN",
        verified_at="2026-01-01T00:00:00+00:00",
        training_completed=True,
        training_org="Rescue 1122",
        equipment_checklist=["tourniquet", "pressure_bandages", "splints", "antiseptic"],
    ),
    Responder(
        responder_id="RESP-WNH-02",
        name="Tanveer Shah",
        village="WANHAR",
        linked_bhu_id="BHU-003",
        current_availability_status="available",
        points_total=80,
        phone_number="+923001234702",
        is_verified=True,
        verified_by="SEED_ADMIN",
        verified_at="2026-01-01T00:00:00+00:00",
        training_completed=True,
        training_org="Rescue 1122",
        equipment_checklist=["tourniquet", "pressure_bandages", "splints", "antiseptic"],
    ),
    Responder(
        responder_id="RESP-WNH-03",
        name="Qasim Ali",
        village="WANHAR",
        linked_bhu_id="BHU-003",
        current_availability_status="available",
        points_total=40,
        phone_number="+923001234703",
        is_verified=True,
        verified_by="SEED_ADMIN",
        verified_at="2026-01-01T00:00:00+00:00",
        training_completed=True,
        training_org="DoH",
        equipment_checklist=["tourniquet", "pressure_bandages", "splints", "antiseptic"],
    ),

    # ── Saghar (3 responders) ────────────────────────────────────────────────
    Responder(
        responder_id="RESP-SGH-01",
        name="Rashid Minhas",
        village="SAGHAR",
        linked_bhu_id="BHU-003",
        current_availability_status="available",
        points_total=140,
        phone_number="+923001234801",
        is_verified=True,
        verified_by="SEED_ADMIN",
        verified_at="2026-01-01T00:00:00+00:00",
        training_completed=True,
        training_org="Rescue 1122",
        equipment_checklist=["tourniquet", "pressure_bandages", "splints", "antiseptic"],
    ),
    Responder(
        responder_id="RESP-SGH-02",
        name="Irfan Haider",
        village="SAGHAR",
        linked_bhu_id="BHU-003",
        current_availability_status="available",
        points_total=90,
        phone_number="+923001234802",
        is_verified=True,
        verified_by="SEED_ADMIN",
        verified_at="2026-01-01T00:00:00+00:00",
        training_completed=True,
        training_org="Pakistan Red Crescent",
        equipment_checklist=["tourniquet", "pressure_bandages", "splints", "antiseptic"],
    ),
    Responder(
        responder_id="RESP-SGH-03",
        name="Shahid Afridi",
        village="SAGHAR",
        linked_bhu_id="BHU-003",
        current_availability_status="available",
        points_total=45,
        phone_number="+923001234803",
        is_verified=True,
        verified_by="SEED_ADMIN",
        verified_at="2026-01-01T00:00:00+00:00",
        training_completed=True,
        training_org="Rescue 1122",
        equipment_checklist=["tourniquet", "pressure_bandages", "splints", "antiseptic"],
    ),

    # ── Budhial (3 responders) ───────────────────────────────────────────────
    Responder(
        responder_id="RESP-BDH-01",
        name="Haris Rauf",
        village="BUDHIAL",
        linked_bhu_id="BHU-005",
        current_availability_status="available",
        points_total=125,
        phone_number="+923001234901",
        is_verified=True,
        verified_by="SEED_ADMIN",
        verified_at="2026-01-01T00:00:00+00:00",
        training_completed=True,
        training_org="Rescue 1122",
        equipment_checklist=["tourniquet", "pressure_bandages", "splints", "antiseptic"],
    ),
    Responder(
        responder_id="RESP-BDH-02",
        name="Shoaib Akhtar",
        village="BUDHIAL",
        linked_bhu_id="BHU-005",
        current_availability_status="available",
        points_total=85,
        phone_number="+923001234902",
        is_verified=True,
        verified_by="SEED_ADMIN",
        verified_at="2026-01-01T00:00:00+00:00",
        training_completed=True,
        training_org="Rescue 1122",
        equipment_checklist=["tourniquet", "pressure_bandages", "splints", "antiseptic"],
    ),
    Responder(
        responder_id="RESP-BDH-03",
        name="Imran Nazir",
        village="BUDHIAL",
        linked_bhu_id="BHU-005",
        current_availability_status="available",
        points_total=50,
        phone_number="+923001234903",
        is_verified=True,
        verified_by="SEED_ADMIN",
        verified_at="2026-01-01T00:00:00+00:00",
        training_completed=True,
        training_org="DoH",
        equipment_checklist=["tourniquet", "pressure_bandages", "splints", "antiseptic"],
    ),

    # ── Legacy backward-compatibility responders ────────────────────────────
    Responder(
        responder_id="RESP-01",
        name="Tariq Mahmood",
        village="VILLAGE-A",
        linked_bhu_id="BHU-001",
        current_availability_status="busy",
        points_total=120,
        phone_number="+923001234561",
        is_verified=True,
        verified_by="SEED_ADMIN",
        verified_at="2026-01-01T00:00:00+00:00",
        training_completed=True,
        training_org="Pakistan Red Crescent",
        equipment_checklist=["tourniquet", "pressure_bandages", "splints", "antiseptic"],
    ),
    Responder(
        responder_id="RESP-02",
        name="Farhan Ali",
        village="VILLAGE-A",
        linked_bhu_id="BHU-001",
        current_availability_status="available",
        points_total=45,
        phone_number="+923001234562",
        is_verified=True,
        verified_by="SEED_ADMIN",
        verified_at="2026-01-01T00:00:00+00:00",
        training_completed=True,
        training_org="Rescue 1122",
        equipment_checklist=["tourniquet", "pressure_bandages", "splints", "antiseptic"],
    ),
    Responder(
        responder_id="RESP-03",
        name="Bilal Shah",
        village="VILLAGE-B",
        linked_bhu_id="BHU-001",
        current_availability_status="offline",
        points_total=80,
        phone_number="+923001234563",
        is_verified=True,
        verified_by="SEED_ADMIN",
        verified_at="2026-01-01T00:00:00+00:00",
        training_completed=True,
        training_org="Pakistan Red Crescent",
        equipment_checklist=["tourniquet", "pressure_bandages", "splints", "antiseptic"],
    ),
    Responder(
        responder_id="RESP-04",
        name="Zubair Khan",
        village="VILLAGE-B",
        linked_bhu_id="BHU-001",
        current_availability_status="busy",
        points_total=15,
        phone_number="+923001234564",
        is_verified=True,
        verified_by="SEED_ADMIN",
        verified_at="2026-01-01T00:00:00+00:00",
        training_completed=True,
        training_org="DoH",
        equipment_checklist=["tourniquet", "pressure_bandages", "splints", "antiseptic"],
    ),
    Responder(
        responder_id="RESP-05",
        name="Rashid Minhas",
        village="VILLAGE-C",
        linked_bhu_id="BHU-002",
        current_availability_status="available",
        points_total=210,
        phone_number="+923001234565",
        is_verified=True,
        verified_by="SEED_ADMIN",
        verified_at="2026-01-01T00:00:00+00:00",
        training_completed=True,
        training_org="Rescue 1122",
        equipment_checklist=["tourniquet", "pressure_bandages", "splints", "antiseptic"],
    )
]

INCIDENT_STORE: List[dict] = []


# ==========================================
# 3. CORE LOGIC CHAIN & SWAPPABLE AI STUBS
# ==========================================

# MOCK — replace with real vision+speech triage pipeline (Module 1)
def getTriageResultMOCK(photo_ref: str, voice_note_transcript: str) -> dict:
    text_lower = voice_note_transcript.lower()
    
    if "unconscious" in text_lower or "heavy bleeding" in text_lower or "critical" in text_lower:
        return {
            "severity_tier": "critical",
            "injury_type_flags": ["heavy_bleeding", "unconscious_risk"]
        }
    elif "burn" in text_lower or "fracture" in text_lower or "deep cut" in text_lower:
        return {
            "severity_tier": "moderate",
            "injury_type_flags": ["deep_laceration", "swelling"]
        }
    else:
        return {
            "severity_tier": "minor",
            "injury_type_flags": ["abrasion", "mild_trauma"]
        }


# ==========================================
# 3b. REAL TRIAGE PIPELINE (Module 1)
# ==========================================
# Provider boundary: step functions (transcribe / classify / combine) are
# provider-agnostic; each has one gemini_* and one dashscope_* implementation.
# Active provider is selected via TRIAGE_AI_PROVIDER in the repo-root .env.
# When DashScope model access is confirmed, flip the env value - the rest of
# the pipeline and everything downstream stays untouched.

FAILED_SIGNAL = {"status": "failed"}

VISION_PROMPT = (
    "You are an emergency triage image analyzer. Look at this photo and "
    "classify any visible injury. Respond with ONLY a JSON object, no extra text: "
    '{"injury_classification": "<one of: laceration, burn, fracture_indicator, '
    'heavy_bleeding, bruise, swelling, no_visible_injury, unclear>", '
    '"apparent_severity": "<one of: minor, moderate, critical, unclear>", '
    '"confidence": <number 0.0-1.0>, '
    '"visible_signals": ["<short observable facts>"], '
    '"image_usable": <true if clear enough to assess, false if blurry/dark/no injury visible>}'
)

CLASSIFIER_PROMPT = (
    "You are the severity-tier classifier of an emergency triage system. "
    "You receive (1) a speech-to-text transcript of the reporter's Urdu voice note "
    "and (2) a vision model's JSON injury classification of the photo. "
    "Combine them into ONE severity tier. Rules: "
    "critical = life-threatening signs (unconsciousness, heavy/uncontrolled bleeding, "
    "major trauma); moderate = significant injury (fracture, deep cut, burn, heavy bruising); "
    "minor = superficial injury only. If BOTH inputs are missing/unclear choose moderate "
    "(safer default). "
    "CONFLICT RESOLUTION (SAFETY RULE): when the transcript and the vision output "
    "disagree, ALWAYS adopt the MORE SEVERE tier. Voice-reported danger signals - "
    "venomous/poisonous bite or sting, unconsciousness, uncontrolled bleeding, "
    "crushing or machine entanglement, breathing difficulty - may be invisible in the "
    "photo and MUST NEVER be downgraded by the vision output. If EITHER source "
    "indicates critical, the final tier is critical. "
    "Respond with ONLY a JSON object: "
    '{"severity_tier": "<minor|moderate|critical>", '
    '"injury_type_flags": ["<snake_case flags derived from the signals, e.g. heavy_bleeding>"], '
    '"reasoning_signals": ["<which transcript/vision signal drove each flag>"]}'
)


def _parse_json_loose(raw: str) -> Optional[dict]:
    """Parse a model JSON reply, tolerating markdown fences and stray prose."""
    import json
    import re

    text = raw.strip().removeprefix("```json").removeprefix("```").removesuffix("```").strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", text, re.DOTALL)
        if match:
            try:
                return json.loads(match.group(0))
            except json.JSONDecodeError:
                return None
        return None


def resolve_media_path(ref: str) -> Optional[Path]:
    """Robustly resolve any media reference (absolute, relative, or bare filename)."""
    if not ref:
        return None
    p = Path(ref)
    if p.is_file():
        return p
    clean = str(ref).replace("\\", "/").lstrip("/")
    if clean.startswith("mockdata/media/"):
        clean = clean[len("mockdata/media/"):]
    elif clean.startswith("mockdata/"):
        clean = clean[len("mockdata/"):]
    elif clean.startswith("media/"):
        clean = clean[len("media/"):]

    root_dir = Path(__file__).resolve().parent.parent
    backend_dir = Path(__file__).resolve().parent
    media_dir = root_dir / "mockdata" / "media"

    candidates = [
        root_dir / ref,
        root_dir / "mockdata" / clean,
        backend_dir / ref,
        media_dir / clean,
        media_dir / "uploads" / clean,
        media_dir / "photos" / clean,
        media_dir / "voice" / clean,
        media_dir / "uploads" / Path(clean).name,
        media_dir / "photos" / Path(clean).name,
        media_dir / "voice" / Path(clean).name,
    ]
    for c in candidates:
        if c.is_file():
            return c
    return None


# ----------------------------- STT step ------------------------------------

def gemini_transcribe_voice(audio_path: Path) -> dict:
    from google.genai import types

    client = _gemini_client()
    ext = audio_path.suffix.lower()
    mime_map = {
        ".mp3": "audio/mp3",
        ".wav": "audio/wav",
        ".ogg": "audio/ogg",
        ".webm": "audio/webm",
        ".m4a": "audio/m4a",
        ".aac": "audio/aac",
        ".flac": "audio/flac",
    }
    mime_type = mime_map.get(ext, "audio/mp3")
    part = types.Part.from_bytes(data=audio_path.read_bytes(), mime_type=mime_type)
    model = _normalize_gemini_model(os.environ.get("GEMINI_FLASH_MODEL", os.environ.get("GEMINI_STT_MODEL", "gemini-3.1-flash-lite")))
    resp = _call_with_retry(lambda: client.models.generate_content(
        model=model,
        contents=[part, "Transcribe this Urdu audio verbatim in Urdu script. "
                          "Output only the transcription."],
        config=types.GenerateContentConfig(
            tool_config=types.ToolConfig(
                function_calling_config=types.FunctionCallingConfig(
                    mode="NONE"
                )
            ),
            automatic_function_calling=types.AutomaticFunctionCallingConfig(
                disable=True
            ),
        ),
    ), "STT")
    text = (resp.text or "").strip()
    return {"text": text, "usable": bool(text)}


def dashscope_transcribe_voice(audio_path: Path) -> dict:
    # SenseVoice-v1 = the only DashScope ASR with Urdu (code 'ur').
    # China-region endpoint required; model is absent from the intl region.
    api_key = _get_api_key()
    remote_url = _dashscope_upload_file(
        model="sensevoice-v1", upload_path=audio_path.as_uri(), api_key=api_key
    )
    if not remote_url:
        raise RuntimeError(f"DashScope upload helper returned no URL for {audio_path.name}")
    task = Transcription.async_call(
        model="sensevoice-v1", file_urls=[remote_url], language_hints=["ur"],
    )
    if task.status_code != 200:
        raise RuntimeError(f"STT task submit failed: {task.code} - {task.message}")
    result = Transcription.wait(task=task.output.task_id)
    if result.status_code != 200:
        raise RuntimeError(f"STT task failed: {result.code} - {result.message}")
    entries = result.output.get("results") or []
    if not entries or entries[0].get("subtask_status") != "SUCCEEDED":
        raise RuntimeError("STT subtask did not succeed")
    import json
    import urllib.request

    with urllib.request.urlopen(entries[0]["transcription_url"], timeout=30) as fh:
        payload = json.load(fh)
    text = " ".join(
        tr.get("text", "") for tr in payload.get("transcripts", [])
    ).strip()
    return {"text": text, "usable": bool(text)}


def transcribe_voice_note(audio_ref: str) -> dict:
    """STT step. Returns {'text', 'usable'} or FAILED_SIGNAL on any error."""
    try:
        resolved = resolve_media_path(audio_ref)
        if not resolved or not resolved.is_file():
            print(f"  [TRIAGE WARN] Audio file not found: {audio_ref}")
            return dict(FAILED_SIGNAL)
        impl = gemini_transcribe_voice if _ai_provider() == "gemini" else dashscope_transcribe_voice
        return impl(resolved)
    except Exception as exc:
        print(f"  [TRIAGE WARN] STT failed ({_ai_provider()}): {exc}")
        return dict(FAILED_SIGNAL)


# Backward-compatible alias
transcribe_audio = transcribe_voice_note


# ---------------------------- Vision step ----------------------------------

def gemini_classify_injury(photo_ref: str) -> dict:
    from google.genai import types

    client = _gemini_client()
    if photo_ref.startswith(("http://", "https://")):
        image_part = types.Part.from_uri(file_uri=photo_ref, mime_type="image/jpeg")
    else:
        resolved = resolve_media_path(photo_ref)
        local = resolved if resolved else Path(photo_ref)
        ext = local.suffix.lower()
        mime_map = {
            ".png": "image/png",
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
            ".webp": "image/webp",
            ".gif": "image/gif",
        }
        mime_type = mime_map.get(ext, "image/jpeg")
        image_part = types.Part.from_bytes(data=local.read_bytes(), mime_type=mime_type)
    model = _normalize_gemini_model(os.environ.get("GEMINI_FLASH_MODEL", os.environ.get("GEMINI_VISION_MODEL", "gemini-3.1-flash-lite")))
    resp = _call_with_retry(lambda: client.models.generate_content(
        model=model,
        contents=[image_part, VISION_PROMPT],
        config=types.GenerateContentConfig(
            tool_config=types.ToolConfig(
                function_calling_config=types.FunctionCallingConfig(
                    mode="NONE"
                )
            ),
            automatic_function_calling=types.AutomaticFunctionCallingConfig(
                disable=True
            ),
        ),
    ), "vision")
    data = _parse_json_loose(resp.text or "")
    if data is None:
        raise RuntimeError(f"Vision model returned non-JSON output: {(resp.text or '')[:120]}")
    return data


def dashscope_classify_injury(photo_ref: str) -> dict:
    resolved = resolve_media_path(photo_ref)
    local = resolved if resolved else Path(photo_ref)
    image_ref = photo_ref if photo_ref.startswith(("http://", "https://")) else local.as_uri()
    resp = MultiModalConversation.call(
        model="qwen-vl-max",
        api_key=_get_api_key(),
        timeout=_triage_timeout_s(),
        messages=[{"role": "user", "content": [{"image": image_ref}, {"text": VISION_PROMPT}]}],
    )
    if resp.status_code != 200:
        raise RuntimeError(f"Vision API error: {resp.code} - {resp.message}")
    raw = resp.output.choices[0].message.content
    text = "".join(p.get("text", "") for p in raw) if isinstance(raw, list) else str(raw)
    data = _parse_json_loose(text)
    if data is None:
        raise RuntimeError(f"Vision model returned non-JSON output: {text[:120]}")
    return data


def classify_injury_photo(photo_ref: str) -> dict:
    """Vision step. Returns the classification JSON or FAILED_SIGNAL."""
    try:
        impl = gemini_classify_injury if _ai_provider() == "gemini" else dashscope_classify_injury
        return impl(photo_ref)
    except Exception as exc:
        print(f"  [TRIAGE WARN] Vision failed ({_ai_provider()}): {exc}")
        return dict(FAILED_SIGNAL)


# Backward-compatible alias
classify_injury_visual = classify_injury_photo


# --------------------------- Classifier step -------------------------------

def gemini_combine_signals(transcript: str, vision: dict) -> dict:
    from google.genai import types
    client = _gemini_client()
    model = _normalize_gemini_model(os.environ.get("GEMINI_CLASSIFIER_MODEL", os.environ.get("GEMINI_FLASH_MODEL", "gemini-3.1-flash-lite")))
    resp = _call_with_retry(lambda: client.models.generate_content(
        model=model,
        contents=[CLASSIFIER_PROMPT,
                  f"Transcript: {transcript or '(none)'}\nVision JSON: {vision}"],
        config=types.GenerateContentConfig(
            tool_config=types.ToolConfig(
                function_calling_config=types.FunctionCallingConfig(
                    mode="NONE"
                )
            ),
            automatic_function_calling=types.AutomaticFunctionCallingConfig(
                disable=True
            ),
        ),
    ), "classifier")
    data = _parse_json_loose(resp.text or "")
    if data is None:
        raise RuntimeError(f"Classifier returned non-JSON output: {(resp.text or '')[:120]}")
    return data


def dashscope_combine_signals(transcript: str, vision: dict) -> dict:
    resp = Generation.call(
        model=os.environ.get("DASHSCOPE_CLASSIFIER_MODEL", "qwen-plus"),
        api_key=_get_api_key(),
        messages=[{"role": "user", "content":
                   f"{CLASSIFIER_PROMPT}\nTranscript: {transcript or '(none)'}\nVision JSON: {vision}"}],
        result_format="message",
        timeout=_triage_timeout_s(),
    )
    if resp.status_code != 200:
        raise RuntimeError(f"Classifier API error: {resp.code} - {resp.message}")
    data = _parse_json_loose(resp.output.choices[0].message.content)
    if data is None:
        raise RuntimeError("Classifier returned non-JSON output")
    return data


def _combine_triage_signals(transcript: str, vision: dict) -> dict:
    """Classifier step. Returns tier JSON or FAILED_SIGNAL."""
    try:
        impl = gemini_combine_signals if _ai_provider() == "gemini" else dashscope_combine_signals
        return impl(transcript, vision)
    except Exception as exc:
        print(f"  [TRIAGE WARN] Classifier failed ({_ai_provider()}): {exc}")
        return dict(FAILED_SIGNAL)


# ---------------------- Multimodal Anticipation ----------------------------

MULTIMODAL_ANTICIPATION_PROMPT = (
    "You are an emergency triage coordinator for a rural first-responder dispatch network.\n"
    "Analyze the distress inputs provided (audio voice note / Urdu transcript, and/or incident photo).\n"
    "\n"
    "PRIORITY RULES:\n"
    "1. Prioritize the actual dictated voice transcript or spoken audio over any generic, absent, or mismatching photo. "
    "If no photo is attached or the photo is unclear, triage dynamically and purely from the voice transcript.\n"
    "2. NEVER default to a finger amputation or preset injury when evaluating voice dictation.\n"
    "3. SIMPLIFIED PLAIN LANGUAGE INSTRUCTION:\n"
    "   Explain the patient condition in simple, plain language. Avoid clinical textbook jargon like 'hypovolemic shock', "
    "'traumatic amputation', 'exsanguination', or 'hemorrhaging'. Explain simply in Urdu and English what happened and what help is required.\n"
    "   Example simplified output for gunshot wound ('مجھے گولی لگی ہے'):\n"
    "   - detected_emergency: 'شدید ایمرجنسی - گولی کا زخم (Critical Emergency - Gunshot Wound)'\n"
    "   - anticipated_condition: 'مریض کو گولی لگی ہے اور خون بہہ رہا ہے۔ فوری ہسپتال منتقلی اور ایمبولینس کی ضرورت ہے۔ (Patient has a gunshot wound with active bleeding. Immediate ambulance and hospital transfer required.)'\n"
    "   - injury_type_flags: ['penetrating_trauma', 'gunshot_wound', 'heavy_bleeding']\n"
    "   - severity_tier: 'critical'\n"
    "\n"
    "CRITICAL TRIAGE MAPPINGS:\n"
    "- If transcript or voice mentions 'گولی' / gunshot / bullet / shooting: assign severity_tier 'critical', and include 'penetrating_trauma', 'gunshot_wound', 'heavy_bleeding' in injury_type_flags.\n"
    "- If transcript mentions snakebite ('سانپ'): assign severity_tier 'critical', flags ['venomous_snake_bite', 'puncture_wounds'].\n"
    "- If unconsciousness, severe bleed, or major fracture/trauma: assign severity_tier 'critical' or 'moderate' appropriately.\n"
    "\n"
    "Respond with ONLY a JSON object formatted strictly as follows (no markdown wrap, no other text):\n"
    "{\n"
    '  "detected_emergency": "<Simple title in Urdu and English, e.g. شدید ایمرجنسی - گولی کا زخم (Critical Emergency - Gunshot Wound)>",\n'
    '  "anticipated_condition": "<1-2 plain sentences in Urdu + English explaining condition without medical jargon>",\n'
    '  "severity_tier": "<minor|moderate|critical>",\n'
    '  "injury_type_flags": ["<snake_case tags, e.g. penetrating_trauma, gunshot_wound, heavy_bleeding>"],\n'
    '  "voice_signals": "<what was heard or deduced from the speech/transcript>",\n'
    '  "image_signals": "<what was observed from the photo, or \'No photo provided\'>",\n'
    '  "confidence": 0.95,\n'
    '  "first_aid_guidance": ["<step 1 in English>", "<step 2 in English>", "<step 3 in English>"],\n'
    '  "first_aid_guidance_ur": ["<step 1 in Urdu>", "<step 2 in Urdu>", "<step 3 in Urdu>"]\n'
    "}"
)


def gemini_anticipate_condition(
    transcript: Optional[str] = None,
    audio_path: Optional[Path] = None,
    photo_path: Optional[Path] = None,
) -> dict:
    """Anticipates the emergency condition and severity from voice and/or photo using Gemini."""
    from google.genai import types

    client = _gemini_client()
    contents = [MULTIMODAL_ANTICIPATION_PROMPT]

    # Voice audio input
    if audio_path and audio_path.is_file():
        ext = audio_path.suffix.lower()
        mime_map = {
            ".mp3": "audio/mp3",
            ".wav": "audio/wav",
            ".ogg": "audio/ogg",
            ".webm": "audio/webm",
            ".m4a": "audio/m4a",
            ".aac": "audio/aac",
            ".flac": "audio/flac",
        }
        mime_type = mime_map.get(ext, "audio/mp3")
        try:
            audio_part = types.Part.from_bytes(data=audio_path.read_bytes(), mime_type=mime_type)
            contents.append(audio_part)
        except Exception as exc:
            print(f"  [TRIAGE WARN] Failed to load audio bytes: {exc}")

    # Voice transcript
    if transcript and transcript.strip():
        contents.append(f"Spoken Distress Transcript: {transcript.strip()}")

    # Photo input
    if photo_path and photo_path.is_file():
        ext = photo_path.suffix.lower()
        mime_map = {
            ".png": "image/png",
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
            ".webp": "image/webp",
            ".gif": "image/gif",
        }
        mime_type = mime_map.get(ext, "image/jpeg")
        try:
            image_part = types.Part.from_bytes(data=photo_path.read_bytes(), mime_type=mime_type)
            contents.append(image_part)
        except Exception as exc:
            print(f"  [TRIAGE WARN] Failed to load photo bytes: {exc}")

    model = _normalize_gemini_model(os.environ.get("GEMINI_CLASSIFIER_MODEL", os.environ.get("GEMINI_FLASH_MODEL", "gemini-3.1-flash-lite")))
    resp = _call_with_retry(lambda: client.models.generate_content(
        model=model,
        contents=contents,
        config=types.GenerateContentConfig(
            tool_config=types.ToolConfig(
                function_calling_config=types.FunctionCallingConfig(
                    mode="NONE"
                )
            ),
            automatic_function_calling=types.AutomaticFunctionCallingConfig(
                disable=True
            ),
        ),
    ), "multimodal_triage")

    data = _parse_json_loose(resp.text or "")
    if not data or not data.get("severity_tier"):
        raise RuntimeError("Failed to parse Gemini multimodal triage JSON")

    # Priority rule: ensure gunshot voice dictation reliably maps to exact flags and plain language
    tr_text = (transcript or "").lower()
    is_gunshot = "گولی" in (transcript or "") or "gunshot" in tr_text or "bullet" in tr_text or "فائرنگ" in (transcript or "")
    if is_gunshot:
        data["severity_tier"] = "critical"
        flags = set(data.get("injury_type_flags", []))
        flags.update(["penetrating_trauma", "gunshot_wound", "heavy_bleeding"])
        flags.discard("traumatic_amputation")
        flags.discard("machine_entanglement")
        data["injury_type_flags"] = list(flags)
        if not data.get("detected_emergency") or "amputation" in str(data.get("detected_emergency")).lower():
            data["detected_emergency"] = "شدید ایمرجنسی - گولی کا زخم (Critical Emergency - Gunshot Wound)"

        cond = data.get("anticipated_condition", "")
        # Remove textbook clinical jargon
        for jargon in ["hypovolemic shock", "exsanguination", "circulatory collapse", "traumatic amputation", "hemorrhagic"]:
            if jargon in cond.lower():
                data["anticipated_condition"] = "مریض کو گولی لگی ہے اور خون بہہ رہا ہے۔ فوری ہسپتال منتقلی اور ایمبولینس کی ضرورت ہے۔ (Patient has a gunshot wound with active bleeding. Immediate ambulance and hospital transfer required.)"
                break

    return data


# ----------------------- Pipeline entry point ------------------------------
# Same name/signature as the mock it replaces, per the Module 1 brief.
def getTriageResultMOCK(photo_ref: str, voice_note_transcript: str) -> dict:
    """Real triage pipeline. Inputs are file paths (photo, voice note audio).

    Returns {'severity_tier', 'injury_type_flags'} plus additive inspectable keys
    ('voice_transcript', 'triage_signals'). Any failure anywhere in the chain
    falls back to tier 'moderate' flagged 'low_confidence_triage' (spec fail-safe).
    """
    provider = _ai_provider()
    if _DASHSCOPE_IMPORT_ERROR is not None and provider == "dashscope":
        raise RuntimeError(f"dashscope SDK unavailable: {_DASHSCOPE_IMPORT_ERROR}")

    # Direct voice gunshot check (e.g. "مجھے گولی لگی ہے")
    is_direct_gunshot = (
        "گولی" in (voice_note_transcript or "")
        or "gunshot" in (voice_note_transcript or "").lower()
        or "bullet" in (voice_note_transcript or "").lower()
        or "فائرنگ" in (voice_note_transcript or "")
    )
    if is_direct_gunshot:
        return {
            "severity_tier": "critical",
            "injury_type_flags": ["penetrating_trauma", "gunshot_wound", "heavy_bleeding"],
            "voice_transcript": voice_note_transcript,
            "triage_signals": [{
                "source": "voice_transcript", "provider": provider, "status": "ok",
                "detail": "Gunshot wound identified directly from voice input",
            }],
        }

    # Only load cache if photo_ref is actually attached and not overridden by voice
    if photo_ref and photo_ref.strip():
        cached = _load_cached_triage(photo_ref, voice_note_transcript)
        if cached is not None:
            print("  [TRIAGE] Using cached result for identical media (quota-friendly).")
            return cached

    signals = []

    # 1. STT (separate call, never merged with vision)
    stt = transcribe_voice_note(voice_note_transcript)
    transcript = stt.get("text", "") if stt is not FAILED_SIGNAL and stt.get("status") != "failed" else ""
    signals.append({
        "source": "stt", "provider": provider,
        "status": "ok" if transcript else ("inaudible_or_missing" if stt.get("status") == "failed" else "empty"),
        "detail": transcript[:200],
    })

    # 2. Vision (separate call)
    vision = classify_injury_photo(photo_ref)
    vision_ok = vision.get("status") != "failed" and bool(vision.get("image_usable", False))
    signals.append({
        "source": "vision", "provider": provider,
        "status": "ok" if vision_ok else "failed_or_unusable",
        "detail": vision if vision.get("status") != "failed" else "call_failed",
    })

    # 3. Classifier combines both into the tier
    combined = _combine_triage_signals(transcript, vision if vision.get("status") != "failed" else {})
    tier_valid = combined.get("severity_tier") in ("minor", "moderate", "critical")

    if tier_valid:
        result = {
            "severity_tier": combined["severity_tier"],
            "injury_type_flags": [str(f) for f in combined.get("injury_type_flags", [])] or ["unspecified"],
            "voice_transcript": transcript,
            "triage_signals": signals + [{
                "source": "classifier", "provider": provider, "status": "ok",
                "detail": combined.get("reasoning_signals", []),
            }],
        }
        if not transcript or not vision_ok:
            # Partial input degraded confidence even though a tier was produced.
            result["injury_type_flags"] = result["injury_type_flags"] + ["low_confidence_triage"]
        _save_triage_cache(photo_ref, voice_note_transcript, result)
        return result

    # Fail-safe per Module 1 spec: never block dispatch, default to moderate.
    return {
        "severity_tier": "moderate",
        "injury_type_flags": ["low_confidence_triage"],
        "voice_transcript": transcript,
        "triage_signals": signals + [{
            "source": "classifier", "provider": provider,
            "status": "failed_or_invalid", "detail": combined,
        }],
    }


def registerIncident(
    photo_ref: str,
    voice_transcript: str,
    gps_location: GPSLocation,
    reporter_id: str = "REP-USER-001"
) -> Incident:
    now_iso = datetime.now(timezone.utc).isoformat()
    incident_id = f"INC-{uuid.uuid4().hex[:6].upper()}"

    triage_data = getTriageResultMOCK(photo_ref, voice_transcript)

    return Incident(
        incident_id=incident_id,
        timestamp_reported=now_iso,
        reporter_id=reporter_id,
        gps_location=gps_location,
        photo_ref=photo_ref,
        voice_transcript=triage_data.get("voice_transcript") or voice_transcript,
        severity_tier=triage_data["severity_tier"],
        injury_type_flags=triage_data["injury_type_flags"]
    )


def matchResponderAndBHU(incident: Incident) -> tuple[Optional[Responder], Optional[BHU]]:
    village_id = incident.gps_location.village_id
    try:
        from geography import bhu_id_for_village, coverage_village_id
        target_bhu_id = bhu_id_for_village(village_id)
        coverage_id = coverage_village_id(village_id)
    except Exception:
        target_bhu_id = None
        coverage_id = village_id

    linked_bhu = next((b for b in SEED_BHUS if target_bhu_id and b.bhu_id == target_bhu_id), None)
    if linked_bhu is None:
        linked_bhu = next((b for b in SEED_BHUS if village_id in b.linked_village_ids), None)
    if linked_bhu is None:
        linked_bhu = next((b for b in SEED_BHUS if coverage_id in b.linked_village_ids), None)

    # Filter direct village responders first
    village_responders = [r for r in SEED_RESPONDERS if r.village == village_id]
    if not village_responders:
        village_responders = [r for r in SEED_RESPONDERS if r.village == coverage_id]

    assigned_responder = next(
        (r for r in village_responders if r.current_availability_status == "available"),
        None
    )

    return assigned_responder, linked_bhu


def dispatch(incident: Incident, responder: Optional[Responder], bhu: Optional[BHU]) -> DispatchResult:
    now_iso = datetime.now(timezone.utc).isoformat()
    tier = incident.severity_tier
    ambulance_requested = (tier == "critical")

    if responder:
        incident.responder_assigned_id = responder.responder_id
        incident.responder_dispatch_timestamp = now_iso
        # CRITICAL FIX: Mutate state to busy so responder cannot be double-assigned
        responder.current_availability_status = "busy"
        # Part B persistence fix: this legacy vertical-slice dispatch path is a
        # real availability mutation, so it writes through to PostgreSQL like
        # Module 3's dispatchIncident does — otherwise a restart would revert a
        # genuinely busy responder to their hardcoded seed default and allow a
        # double-dispatch. Narrow update (status column only) so Module 5's
        # status_flag is preserved. Lazy import + non-fatal: Module 1 stays
        # importable and runnable without the DB layer.
        try:
            from models.responder_model import update_responder_availability
            update_responder_availability(responder.responder_id, "busy")
        except Exception as exc:
            print(f"  [DISPATCH WARNING] DB write-through for busy status failed (non-fatal): {exc}")

    if tier in ["moderate", "critical"]:
        incident.bhu_notified = True
        incident.bhu_notify_timestamp = now_iso

    incident.ambulance_requested = ambulance_requested

    if responder:
        status = "dispatched"
        print(f"  [DISPATCH LOG] Assigned: {responder.name} ({responder.responder_id}) -> Status set to BUSY.")
    else:
        status = "escalated_bhu_only" if bhu else "no_responders_available"
        print(f"  [DISPATCH WARNING] No responders available in {incident.gps_location.village_id}. Escalated to {bhu.name if bhu else 'None'}.")

    if incident.bhu_notified and bhu:
        print(f"  [DISPATCH LOG] {bhu.name} notified ({'Standby' if tier == 'moderate' else 'Urgent'}).")

    if ambulance_requested:
        print(f"  [DISPATCH ALERT] Ambulance requested immediately for {incident.incident_id}.")

    return DispatchResult(
        incident_id=incident.incident_id,
        responder=responder,
        bhu=bhu,
        ambulance_requested=ambulance_requested,
        status=status
    )


def logIncident(incident: Incident, dispatch_result: DispatchResult) -> dict:
    record = {
        "incident": incident.model_dump(),
        "dispatch_status": dispatch_result.status,
        "logged_at": datetime.now(timezone.utc).isoformat()
    }
    INCIDENT_STORE.append(record)
    return record


# ==========================================
# 4. EXPANDED TEST SUITE (WITH EDGE CASES)
# ==========================================

def run_test_suite():
    print("=" * 75)
    print("RUNNING LIFELINE RIDE VERTICAL SLICE TEST TRACE (WITH EDGE CASES)")
    print("=" * 75)

    scenarios = [
        {
            "title": "Test 1 (Real Media - Machine Hand Injury, Fallback Match)",
            "desc": "Village A: Tariq is busy -> Farhan Ali (available) is matched & marked busy. Real Urdu voice note + photo through the live AI pipeline.",
            "photo": r"D:\LifeLine Ride\mockdata\media\photos\PhotoshopExtension_Image (1).png",
            "voice": r"D:\LifeLine Ride\mockdata\media\voice\ungli.mp3",
            "loc": GPSLocation(latitude=31.5204, longitude=74.3587, village_id="VILLAGE-A")
        },
        {
            "title": "Test 2 (Real Media - Crushed Leg, Village Exhaustion)",
            "desc": "Village A (Immediate consecutive incident): Now both Tariq and Farhan are busy -> Escalates directly to BHU.",
            "photo": r"D:\LifeLine Ride\mockdata\media\photos\PhotoshopExtension_Image.png",
            "voice": r"D:\LifeLine Ride\mockdata\media\voice\taang.mp3",
            "loc": GPSLocation(latitude=31.5204, longitude=74.3587, village_id="VILLAGE-A")
        },
        {
            "title": "Test 3 (Real Media - Venomous Snakebite, Critical Simultaneous Dispatch)",
            "desc": "Village C: Rashid available -> Dispatches Rashid + BHU + Ambulance.",
            "photo": r"D:\LifeLine Ride\mockdata\media\photos\PhotoshopExtension_Image (2).png",
            "voice": r"D:\LifeLine Ride\mockdata\media\voice\saanp.mp3",
            "loc": GPSLocation(latitude=30.1575, longitude=71.5249, village_id="VILLAGE-C")
        },
        {
            "title": "Test 4 (Edge Case - Missing/Unusable Media, Fail-Safe Path)",
            "desc": "Both photo and voice note unusable -> pipeline defaults to MODERATE + low_confidence_triage; Village B has no available responders -> BHU escalation.",
            "photo": r"D:\LifeLine Ride\mockdata\media\photos\__missing__.jpg",
            "voice": r"D:\LifeLine Ride\mockdata\media\voice\__missing__.mp3",
            "loc": GPSLocation(latitude=31.5497, longitude=74.3436, village_id="VILLAGE-B")
        }
    ]

    for step in scenarios:
        print(f"\n>>> {step['title']}")
        print(f"    Scenario: {step['desc']}")
        
        # 1. Register & Triage
        incident = registerIncident(step["photo"], step["voice"], step["loc"])
        print(f"    [1. TRIAGE] Tier: {incident.severity_tier.upper()} | Flags: {incident.injury_type_flags}")
        print(f"    [1. TRANSCRIPT] {(incident.voice_transcript or '(none)')[:110]}")

        # 2. Match
        resp, bhu = matchResponderAndBHU(incident)
        print(f"    [2. MATCH] Selected Responder: {resp.name if resp else 'NONE AVAILABLE'} | Linked BHU: {bhu.name if bhu else 'None'}")

        # 3. Dispatch & Mutate State
        res = dispatch(incident, resp, bhu)
        print(f"    [3. RESULT] Dispatch Status: {res.status}")

        # 4. Log
        logIncident(incident, res)

    print("\n" + "=" * 75)
    print(f"VERIFICATION COMPLETE: {len(INCIDENT_STORE)} total incidents logged with full lifecycle.")
    print("=" * 75)


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    run_test_suite()