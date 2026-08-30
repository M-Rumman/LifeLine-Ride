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


def _call_with_retry(fn, step_name: str):
    """Run an AI call; retry on quota/rate-limit errors (429) with backoff.

    Free-tier quotas replenish over time, so a bounded wait-then-retry keeps
    the pipeline usable during demos. Any final failure raises and is handled
    by the step wrapper's fail-safe.
    """
    import time

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
            wait_s = min(15 * attempt, 60)
            print(f"  [TRIAGE RETRY] {step_name} hit a quota limit; "
                  f"waiting {wait_s}s (attempt {attempt}/{attempts - 1}).")
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
AvailabilityStatus = Literal["available", "busy", "offline"]


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
    # ADDITIVE (Module 2): Responder Help Bot state-transition log. Never
    # written by Module 1; appended by the help-bot session (branch entered,
    # steps, intents, escalations) for later Module 5 accountability review.
    help_bot_transitions: List[dict] = []


class Responder(BaseModel):
    responder_id: str
    name: str
    village: str
    linked_bhu_id: str
    current_availability_status: AvailabilityStatus
    points_total: int = 0


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
    )
]

SEED_RESPONDERS: List[Responder] = [
    Responder(
        responder_id="RESP-01",
        name="Tariq Mahmood",
        village="VILLAGE-A",
        linked_bhu_id="BHU-001",
        current_availability_status="busy",
        points_total=120
    ),
    Responder(
        responder_id="RESP-02",
        name="Farhan Ali",
        village="VILLAGE-A",
        linked_bhu_id="BHU-001",
        current_availability_status="available",
        points_total=45
    ),
    Responder(
        responder_id="RESP-03",
        name="Bilal Shah",
        village="VILLAGE-B",
        linked_bhu_id="BHU-001",
        current_availability_status="offline",
        points_total=80
    ),
    Responder(
        responder_id="RESP-04",
        name="Zubair Khan",
        village="VILLAGE-B",
        linked_bhu_id="BHU-001",
        current_availability_status="busy",
        points_total=15
    ),
    Responder(
        responder_id="RESP-05",
        name="Rashid Minhas",
        village="VILLAGE-C",
        linked_bhu_id="BHU-002",
        current_availability_status="available",
        points_total=210
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


# ----------------------------- STT step ------------------------------------

def gemini_transcribe_voice(audio_path: Path) -> dict:
    from google.genai import types

    client = _gemini_client()
    part = types.Part.from_bytes(data=audio_path.read_bytes(), mime_type="audio/mpeg")
    resp = _call_with_retry(lambda: client.models.generate_content(
        model=os.environ.get("GEMINI_STT_MODEL", "gemini-3.5-flash"),
        contents=[part, "Transcribe this Urdu audio verbatim in Urdu script. "
                          "Output only the transcription."],
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
        audio_path = Path(audio_ref)
        if not audio_path.is_file():
            print(f"  [TRIAGE WARN] Audio file not found: {audio_ref}")
            return dict(FAILED_SIGNAL)
        impl = gemini_transcribe_voice if _ai_provider() == "gemini" else dashscope_transcribe_voice
        return impl(audio_path)
    except Exception as exc:
        print(f"  [TRIAGE WARN] STT failed ({_ai_provider()}): {exc}")
        return dict(FAILED_SIGNAL)


# ---------------------------- Vision step ----------------------------------

def gemini_classify_injury(photo_ref: str) -> dict:
    from google.genai import types

    client = _gemini_client()
    if photo_ref.startswith(("http://", "https://")):
        image_part = types.Part.from_uri(file_uri=photo_ref, mime_type="image/jpeg")
    else:
        local = Path(photo_ref)
        image_part = types.Part.from_bytes(data=local.read_bytes(), mime_type="image/png")
    resp = _call_with_retry(lambda: client.models.generate_content(
        model=os.environ.get("GEMINI_VISION_MODEL", "gemini-3.5-flash"),
        contents=[image_part, VISION_PROMPT],
    ), "vision")
    data = _parse_json_loose(resp.text or "")
    if data is None:
        raise RuntimeError(f"Vision model returned non-JSON output: {(resp.text or '')[:120]}")
    return data


def dashscope_classify_injury(photo_ref: str) -> dict:
    image_ref = photo_ref if photo_ref.startswith(("http://", "https://")) else Path(photo_ref).as_uri()
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


# --------------------------- Classifier step -------------------------------

def gemini_combine_signals(transcript: str, vision: dict) -> dict:
    client = _gemini_client()
    resp = _call_with_retry(lambda: client.models.generate_content(
        model=os.environ.get("GEMINI_CLASSIFIER_MODEL", "gemini-3.5-flash"),
        contents=[CLASSIFIER_PROMPT,
                  f"Transcript: {transcript or '(none)'}\nVision JSON: {vision}"],
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

    linked_bhu = next((b for b in SEED_BHUS if village_id in b.linked_village_ids), None)

    village_responders = [r for r in SEED_RESPONDERS if r.village == village_id]
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