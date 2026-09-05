# -*- coding: utf-8 -*-
"""Module 2 — Responder AI Help Bot: conversation engine (hardcoded reactive flow).

Voice-first, Urdu-only guidance for a dispatched first responder. The flow is
a continuous listen-think-respond loop built from request-response parts
(VAD-chunked capture -> STT -> intent classification -> scripted Urdu TTS with
barge-in). The Gemini Live API was deliberately ruled out: native-audio freeform
phrasing conflicts with the rulebook requirement that this bot be a hardcoded
decision tree, never a freeform LLM chat.

Hard rules implemented here:
- Every spoken sentence comes verbatim from services/help_bot_content.py.
- The AI provider is used ONLY for STT (ears) and intent classification
  (routing). It never composes what the responder hears.
- Provider boundary mirrors Module 1 exactly: gemini_* implementations are
  active, dashscope_* implementations are isolated behind TRIAGE_AI_PROVIDER,
  every call has the shared TRIAGE_CALL_TIMEOUT_S timeout + quota retry
  (env-driven backoff: TRIAGE_RETRY_BACKOFF_S, default 15s; auto-fast-fail
  when LIFELINE_REPLAY_MODE=1, used by help_bot_runner.py for replay/verify
  runs so a rate-limited call doesn't stall 45s/turn), and failures route
  to a pre-rendered Urdu fail-safe line (never silence/hang).
- escalateIncident() below is THE clean integration point for the future
  Module 3/8: wire them by calling it, not by rewriting it.
"""
from __future__ import annotations

import collections
import hashlib
import io
import json
import os
import re
import threading
import time
import wave
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

# --- import path: allow both `import slice_runner` and `from services...` ----
_BACKEND_DIR = Path(__file__).resolve().parent.parent
_REPO_ROOT = _BACKEND_DIR.parent
if str(_BACKEND_DIR) not in [str(p) for p in __import__("sys").path]:
    __import__("sys").path.insert(0, str(_BACKEND_DIR))

import slice_runner  # noqa: E402  Module 1: contracts, provider helpers, INCIDENT_STORE

try:  # noqa: E402
    from services.help_bot_content import BRANCHES, SHARED_LINES
except ImportError:  # direct import from inside services/
    from help_bot_content import BRANCHES, SHARED_LINES

TIER_ORDER = ("minor", "moderate", "critical")

TTS_CACHE_DIR = _REPO_ROOT / "mockdata" / "helpbot" / "tts_cache"
TEST_RUNS_DIR = _REPO_ROOT / "mockdata" / "helpbot" / "test_runs"
TTS_SAMPLE_RATE = 24000          # Gemini TTS returns 24 kHz 16-bit mono PCM
MIC_SAMPLE_RATE = 16000          # mic capture rate for STT
VAD_SILENCE_END_S = 1.2          # trailing silence that ends an utterance
VAD_MIN_UTTERANCE_S = 0.35
VAD_MAX_UTTERANCE_S = 15.0
LISTEN_TIMEOUT_S = 20.0
SILENT_CYCLES_BEFORE_CHECKIN = 2
BARGE_IN_HOLD_S = 0.35           # sustained speech needed to interrupt playback
BARGE_IN_FACTOR = 1.8            # barge-in threshold = speech threshold x this
                                 # (speaker echo tolerance; documented limitation)

INTENT_STEP_DONE = "step_done"
INTENT_IN_SCOPE = "in_scope_question"
INTENT_OUT_OF_SCOPE = "out_of_scope"
INTENT_ESCALATION = "escalation"
INTENT_UNCLEAR = "unclear"
_VALID_INTENTS = {INTENT_STEP_DONE, INTENT_IN_SCOPE, INTENT_OUT_OF_SCOPE,
                  INTENT_ESCALATION, INTENT_UNCLEAR}

# Live Incident objects for sessions in progress. escalateIncident() prefers
# these over INCIDENT_STORE snapshots so tier upgrades and the transition log
# mutate the record the session is actively using.
_ACTIVE_INCIDENTS: dict = {}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _log(msg: str) -> None:
    print(f"  [HELPBOT] {msg}")


def _warn(msg: str) -> None:
    print(f"  [HELPBOT WARN] {msg}")


def register_incident(incident) -> None:
    _ACTIVE_INCIDENTS[incident.incident_id] = incident


# ===========================================================================
# BRANCH ROUTING (incident.injury_type_flags -> knowledge branch)
# ===========================================================================
# Keyword sets match the real flags Module 1's classifier emits (verified
# against mockdata/media/.triage_cache). Order matters: checked top to bottom.
_BRANCH_KEYWORDS = [
    ("snakebite", ("snake", "saanp", "venom", "zehr", "bite",
                   "سانپ", "زہر")),
    ("fracture_crush", ("fracture", "crush", "major_trauma", "broken", "bone",
                        "ہڈی", "ٹوٹ", "کچل")),
    ("heavy_bleeding", ("bleed", "blood", "khoon", "amput", "laceration",
                        "wound", "machine", "cut", "خون", "زخم")),
]
DEFAULT_BRANCH = "heavy_bleeding"  # safest default: pressure guidance first


def route_branch(injury_type_flags) -> tuple:
    """Map incident flags to a branch id. Returns (branch_id, matched)."""
    haystack = " ".join(str(f).lower() for f in (injury_type_flags or []))
    for branch_id, keywords in _BRANCH_KEYWORDS:
        if any(k in haystack for k in keywords):
            return branch_id, True
    return DEFAULT_BRANCH, False


# ===========================================================================
# PROVIDER BOUNDARY — STT (responder's spoken input)
# ===========================================================================

def _audio_mime(audio_bytes: bytes) -> str:
    return "audio/wav" if audio_bytes[:4] == b"RIFF" else "audio/mpeg"


def gemini_transcribe_responder(audio_bytes: bytes) -> dict:
    """Gemini STT of one responder utterance (same pattern as Module 1 STT)."""
    from google.genai import types

    client = slice_runner._gemini_client()
    part = types.Part.from_bytes(data=audio_bytes, mime_type=_audio_mime(audio_bytes))
    stt_model = slice_runner._normalize_gemini_model(os.environ.get("GEMINI_FLASH_MODEL", os.environ.get("GEMINI_STT_MODEL", "gemini-3.1-flash-lite")))
    resp = slice_runner._call_with_retry(lambda: client.models.generate_content(
        model=stt_model,
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
    ), "HB-STT")
    text = (resp.text or "").strip()
    return {"text": text, "usable": bool(text)}


def dashscope_transcribe_responder(audio_bytes: bytes) -> dict:
    """DashScope swap-back target: SenseVoice-v1, the only DashScope ASR with
    Urdu (code 'ur'). Kept isolated behind TRIAGE_AI_PROVIDER exactly like
    Module 1; usable once the China-region account is activated."""
    import tempfile

    suffix = ".wav" if _audio_mime(audio_bytes) == "audio/wav" else ".mp3"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(audio_bytes)
        tmp_path = Path(tmp.name)
    try:
        # Reuse Module 1's proven DashScope implementation verbatim.
        return slice_runner.dashscope_transcribe_voice(tmp_path)
    finally:
        tmp_path.unlink(missing_ok=True)


def transcribeResponderInput(audio_bytes: bytes) -> dict:
    """STT step. Returns {'text', 'usable'}; on any error returns unusable."""
    try:
        impl = (gemini_transcribe_responder if slice_runner._ai_provider() == "gemini"
                else dashscope_transcribe_responder)
        return impl(audio_bytes)
    except Exception as exc:
        _warn(f"responder STT failed ({slice_runner._ai_provider()}): {exc}")
        return {"text": "", "usable": False}


# ===========================================================================
# PROVIDER BOUNDARY — INTENT DETECTION (classification only, never content)
# ===========================================================================

_INTENT_INSTRUCTION = """\
You are the intent classifier for an Urdu first-aid voice assistant guiding a \
village first responder during an active emergency. The responder speaks Urdu, \
possibly with regional (Punjabi/Pashto/Seraiki) inflection or Roman-Urdu \
spelling. You NEVER give medical advice. You ONLY classify the responder's \
latest utterance for a fixed state machine.

Current branch: {branch_title} (id: {branch_id})
Guidance step the responder is most likely working on now: {current_step}
In-scope Q&A entries for THIS branch (id :: what the responder may be asking):
{qa_list}
Escalation signals for THIS branch (patient getting worse): {esc_signals}
Recent conversation, newest last:
{context}

Classify the responder's latest utterance into EXACTLY ONE intent:
- "step_done": responder confirms the current step is complete, or asks for the next instruction.
- "in_scope_question": a question covered by one of the listed Q&A entries; set qa_entry_id to that entry's id.
- "escalation": the patient is deteriorating or any escalation signal is reported; set escalation_signal to a short snake_case label, and suggested_tier to "critical" for unconsciousness, uncontrolled bleeding, or breathing difficulty, otherwise "moderate".
- "out_of_scope": ANY question not covered by the listed entries (other injuries, medicines/doses, transport, prognosis, small talk).
- "unclear": empty, noise, or impossible to understand.

Respond with ONLY a JSON object, no other text:
{{"intent": "<one of the five>", "qa_entry_id": "<id or null>", "escalation_signal": "<label or null>", "suggested_tier": "<moderate|critical|null>", "reason": "<10 words max>"}}"""


def _build_intent_prompt(branch_id: str, transcript: str,
                         current_step_line: Optional[str],
                         recent_context: list) -> str:
    branch = BRANCHES[branch_id]
    qa_list = "\n".join(
        f'- {e["qa_id"]} :: {" / ".join(e["hints"])}' for e in branch["qa_entries"]
    ) or "- (none)"
    esc_signals = "; ".join(branch["escalation_signals"])
    context = "\n".join(recent_context[-6:]) or "(start of conversation)"
    return _INTENT_INSTRUCTION.format(
        branch_title=branch["title_ur"], branch_id=branch_id,
        current_step=current_step_line or "(initial guidance)",
        qa_list=qa_list, esc_signals=esc_signals, context=context,
    ) + f'\n\nResponder\'s latest utterance (Urdu):\n"{transcript}"'


def _normalize_intent(raw: Optional[dict], branch_id: str) -> dict:
    """Coerce a model reply into the strict intent schema; junk -> unclear."""
    branch = BRANCHES[branch_id]
    valid_qa = {e["qa_id"] for e in branch["qa_entries"]}
    out = {"intent": INTENT_UNCLEAR, "qa_entry_id": None,
           "escalation_signal": None, "suggested_tier": None, "reason": ""}
    if not isinstance(raw, dict):
        return out
    intent = str(raw.get("intent", "")).strip()
    if intent in _VALID_INTENTS:
        out["intent"] = intent
    qa = raw.get("qa_entry_id")
    if intent == INTENT_IN_SCOPE and qa in valid_qa:
        out["qa_entry_id"] = qa
    elif intent == INTENT_IN_SCOPE:
        # Question claimed in-scope but no valid entry matched: never guess an
        # answer -> treat as out-of-scope so the honest fallback speaks.
        out["intent"] = INTENT_OUT_OF_SCOPE
    sig = raw.get("escalation_signal")
    if intent == INTENT_ESCALATION and sig:
        out["escalation_signal"] = str(sig)
    tier = raw.get("suggested_tier")
    if tier in TIER_ORDER:
        out["suggested_tier"] = tier
    out["reason"] = str(raw.get("reason", ""))[:120]
    return out


def gemini_detect_intent(prompt: str) -> dict:
    from google.genai import types
    client = slice_runner._gemini_client()
    classifier_model = os.environ.get("GEMINI_CLASSIFIER_MODEL", os.environ.get("GEMINI_FLASH_MODEL", "gemini-3.1-flash-lite"))
    resp = slice_runner._call_with_retry(lambda: client.models.generate_content(
        model=classifier_model,
        contents=[prompt],
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
    ), "HB-INTENT")
    data = slice_runner._parse_json_loose(resp.text or "")
    if data is None:
        raise RuntimeError(f"intent classifier returned non-JSON: {(resp.text or '')[:120]}")
    return data


def dashscope_detect_intent(prompt: str) -> dict:
    """DashScope swap-back target: qwen-plus (same light text model Module 1
    uses for its classifier step). Isolated behind TRIAGE_AI_PROVIDER."""
    resp = slice_runner.Generation.call(
        model=os.environ.get("DASHSCOPE_CLASSIFIER_MODEL", "qwen-plus"),
        api_key=slice_runner._get_api_key(),
        messages=[{"role": "user", "content": prompt}],
        result_format="message",
        timeout=slice_runner._triage_timeout_s(),
    )
    if resp.status_code != 200:
        raise RuntimeError(f"DashScope intent API error: {resp.code} - {resp.message}")
    data = slice_runner._parse_json_loose(resp.output.choices[0].message.content)
    if data is None:
        raise RuntimeError("DashScope intent classifier returned non-JSON output")
    return data


def detectResponderIntent(branch_id: str, transcript: str,
                          current_step_line: Optional[str] = None,
                          recent_context: Optional[list] = None) -> dict:
    """Intent step. Always returns the strict schema; unclear on any failure."""
    try:
        prompt = _build_intent_prompt(branch_id, transcript, current_step_line,
                                      recent_context or [])
        impl = (gemini_detect_intent if slice_runner._ai_provider() == "gemini"
                else dashscope_detect_intent)
        return _normalize_intent(impl(prompt), branch_id)
    except Exception as exc:
        _warn(f"intent detection failed ({slice_runner._ai_provider()}): {exc}")
        return {"intent": INTENT_UNCLEAR, "qa_entry_id": None,
                "escalation_signal": None, "suggested_tier": None,
                "reason": f"call_failed: {exc}"[:120]}


# ===========================================================================
# PROVIDER BOUNDARY — TTS (bot's spoken guidance output, real spoken Urdu)
# ===========================================================================

def _tts_model() -> str:
    # Default: gemini-3.1-flash-tts-preview (newest Gemini TTS, Urdu 'ur'
    # supported per Google docs). Note: gemini-2.5-flash-preview-tts also
    # works, but its free-tier quota is a tiny per-day per-model budget —
    # observed exhausted mid-testing; override anytime via GEMINI_TTS_MODEL.
    return os.environ.get("GEMINI_TTS_MODEL", "gemini-3.1-flash-tts-preview")


def _tts_voice() -> str:
    return os.environ.get("GEMINI_TTS_VOICE", "Kore")


def _tts_provider() -> str:
    """edge (default): Microsoft Edge neural Urdu voice — free, no API key,
    no daily quota. gemini: fallback only; its free tier allows ~10 renders
    per day per model, which a live demo exhausts in minutes."""
    return os.environ.get("TTS_PROVIDER", "edge").strip().lower()


def _edge_voice() -> str:
    # ur-PK-UzmaNeural is the female Pakistan-Urdu voice (ur-PK-GulNeural does
    # not exist — Gul is ur-IN; a wrong voice name renders silence).
    return os.environ.get("EDGE_TTS_VOICE", "ur-PK-UzmaNeural")


def _edge_rate() -> str:
    """Slightly slower than the default: clearer Urdu articulation for a
    responder working on a noisy, stressful scene."""
    return os.environ.get("EDGE_TTS_RATE", "-10%")


def gemini_synthesize_speech(text: str) -> bytes:
    """Gemini TTS -> raw PCM bytes (24 kHz 16-bit mono). Urdu ('ur') is a
    documented supported language of the Gemini TTS model family."""
    from google.genai import types

    client = slice_runner._gemini_client()
    resp = slice_runner._call_with_retry(lambda: client.models.generate_content(
        model=_tts_model(),
        contents=("Speak the following Urdu text aloud in Urdu with a calm, "
                  "clear, steady voice for an emergency responder:\n" + text),
        config=types.GenerateContentConfig(
            response_modalities=["AUDIO"],
            speech_config=types.SpeechConfig(
                voice_config=types.VoiceConfig(
                    prebuilt_voice_config=types.PrebuiltVoiceConfig(
                        voice_name=_tts_voice())))),
    ), "HB-TTS")
    return resp.candidates[0].content.parts[0].inline_data.data


def edge_synthesize_speech(text: str) -> bytes:
    """Microsoft Edge neural TTS -> MP3 bytes (24 kHz mono) in a native Urdu
    voice. Primary Urdu voice of the help bot: unlike Gemini TTS's free tier
    it has no daily render quota. edge-tts is async, so when this runs inside
    FastAPI's event loop the render happens on a worker thread's own loop."""
    import asyncio
    import edge_tts

    async def _render() -> bytes:
        parts: list = []
        async for chunk in edge_tts.Communicate(
            text, _edge_voice(), rate=_edge_rate()
        ).stream():
            if chunk["type"] == "audio":
                parts.append(chunk["data"])
        if not parts:
            raise RuntimeError("edge-tts returned no audio")
        return b"".join(parts)

    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(_render())
    with ThreadPoolExecutor(max_workers=1) as pool:
        return pool.submit(asyncio.run, _render()).result()


def dashscope_synthesize_speech(text: str) -> bytes:
    """DashScope swap-back target: CosyVoice. Urdu voice availability is
    UNVERIFIED (DashScope docs must be checked first, same discipline as
    SenseVoice in Module 1), so this boundary intentionally refuses to run
    until verified — flip only after confirming an Urdu-capable CosyVoice
    voice, then implement here."""
    raise RuntimeError(
        "CosyVoice Urdu voice availability is unverified; refusing to speak "
        "possibly-non-Urdu audio to a responder. Verify an Urdu-capable "
        "CosyVoice voice against current DashScope docs, then implement."
    )


# Latin first-aid terms a model may still emit; the spoken form gets the Urdu
# equivalent so the voice never switches into English mid-sentence.
_LATIN_TO_URDU = {
    "gauze": "پٹی", "bandage": "پٹی", "pressure": "دباؤ", "cloth": "کپڑا",
    "clean": "صاف", "water": "پانی", "ice": "برف", "pulse": "نبض",
    "breathing": "سانس", "unconscious": "بے ہوش", "hospital": "ہسپتال",
    "ambulance": "ایمبولینس", "stitches": "ٹانکے", "stitch": "ٹانکہ",
    "suture": "ٹانکے", "tourniquet": "ٹورنیکیٹ", "splint": "سپلنٹ",
    "blanket": "کمبل", "position": "پوزیشن",
}


def sanitize_for_speech(text: str) -> str:
    """Plain-text, Urdu-only form of a reply for the TTS boundary.

    Two jobs:
    1. Markdown (‏**bold**, _emphasis_, `code`, [label](url), heading hashes)
       is stripped — a TTS model vocalises it literally (responders heard
       "asterisk asterisk").
    2. English is purged — the Urdu voice reads Latin words in English, so
       parenthetical glosses like "(apply pressure)" are removed, known terms
       are mapped to their Urdu equivalent, and any remaining Latin runs are
       dropped. The ON-SCREEN text keeps everything; only the spoken form is
       normalised here.
    """
    t = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", text)  # [label](url) -> label
    t = t.replace("**", " ").replace("__", " ")        # bold markers first
    t = re.sub(r"[*_`#]+", " ", t)                     # italic / code / headings
    # Parenthetical/bracketed English glosses: the Urdu sentence already
    # carries the meaning, so the gloss is dropped rather than spoken.
    t = re.sub(r"[\(\[][^)\]]*[A-Za-z][^)\]]*[\)\]]", " ", t)
    for latin, urdu in _LATIN_TO_URDU.items():
        t = re.sub(rf"\b{latin}s?\b", urdu, t, flags=re.IGNORECASE)
    t = re.sub(r"[A-Za-z]+", " ", t)                   # any leftover Latin words
    # Punctuation the Urdu voice stumbles on -> natural Urdu stops.
    t = t.replace(":", "۔").replace(";", "،")
    t = t.replace("/", " یا ").replace("&", " اور ").replace("-", " ")
    t = re.sub(r"۔{2,}", "۔", t)
    t = re.sub(r"\s+", " ", t).strip()
    return t


def _pcm_to_wav_bytes(pcm: bytes, sample_rate: int = TTS_SAMPLE_RATE) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(pcm)
    return buf.getvalue()


def _tts_manifest() -> dict:
    path = TTS_CACHE_DIR / "manifest.json"
    if path.is_file():
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return {}
    return {}


def _tts_cache_path(text: str, voice: str, suffix: str = ".wav") -> Path:
    # Keyed by voice+text only (not model): audio rendered by one Gemini TTS
    # model stays valid if the model is swapped (e.g. quota-driven). Rendering
    # provenance is tracked in tts_cache/manifest.json instead.
    key = hashlib.sha1(f"{voice}|{text}".encode("utf-8")).hexdigest()[:16]
    return TTS_CACHE_DIR / f"{key}{suffix}"


# One Gemini TTS call must finish inside TRIAGE_CALL_TIMEOUT_S (30 s); ~150
# Urdu characters (~12-15 s of speech) render comfortably within it, while a
# full 700+ char copilot reply timed out and silenced the bot.
SPEECH_CHUNK_CHARS = 150
_MANIFEST_LOCK = threading.Lock()


def _split_for_speech(text: str, max_chars: int = SPEECH_CHUNK_CHARS) -> list:
    """Sentence-boundary chunks (Urdu ۔ / . / ! / ? / newline) so every TTS
    call stays inside the client read timeout."""
    chunks: list = []
    cur = ""
    for sentence in re.split(r"(?<=[۔!?\n])\s*", text):
        sentence = sentence.strip()
        if not sentence:
            continue
        if cur and len(cur) + 1 + len(sentence) > max_chars:
            chunks.append(cur)
            cur = sentence
        else:
            cur = f"{cur} {sentence}".strip()
        while len(cur) > max_chars:  # hard-split an overlong sentence
            chunks.append(cur[:max_chars])
            cur = cur[max_chars:]
    if cur:
        chunks.append(cur)
    return chunks or [text.strip()]


def _write_cache(path: Path, payload: bytes, text: str, meta: dict) -> None:
    TTS_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    path.write_bytes(payload)
    with _MANIFEST_LOCK:  # parallel chunk renders share manifest.json
        manifest = _tts_manifest()
        entry = {"rendered_at": _now_iso(), "text": text[:120]}
        entry.update(meta)
        manifest[path.name] = entry
        (TTS_CACHE_DIR / "manifest.json").write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")


def _chunk_pcm(impl, chunk: str) -> bytes:
    """Render one speech chunk (cache-first) and return its raw PCM frames.
    A retry after a partial failure re-renders only the chunk that failed."""
    cpath = _tts_cache_path(chunk, _tts_voice())
    if cpath.is_file():
        with wave.open(str(cpath), "rb") as wf:
            return wf.readframes(wf.getnframes())
    pcm = impl(chunk)
    _write_cache(cpath, _pcm_to_wav_bytes(pcm), chunk,
                 {"provider": "gemini", "model": _tts_model(),
                  "voice": _tts_voice()})
    return pcm


def speakGuidance(text: str) -> dict:
    """TTS step with disk cache. Returns {'wav_path', 'cached', 'bytes'}.

    Every scripted line is rendered once and cached, so repeat runs do not
    burn quota and the fail-safe line can be pre-rendered at session start
    (a later network failure then needs no live call to stay vocal). The text
    is sanitised FIRST so the cache key and the rendered audio both carry the
    markdown-free spoken form.

    Provider order: Edge neural Urdu (free, quota-free, single call) then
    Gemini TTS — its free tier (~10 renders/day per model) is chunked on
    sentence bounds and rendered in parallel so each call stays inside the
    client read timeout and the cockpit's 90 s request budget."""
    text = sanitize_for_speech(text)
    if _tts_provider() == "edge":
        path = _tts_cache_path(text, _edge_voice(), ".mp3")
        if path.is_file():
            return {"wav_path": path, "cached": True, "bytes": path.stat().st_size}
        try:
            mp3 = edge_synthesize_speech(text)
            _write_cache(path, mp3, text,
                         {"provider": "edge", "voice": _edge_voice()})
            return {"wav_path": path, "cached": False,
                    "bytes": path.stat().st_size}
        except Exception as exc:  # noqa: BLE001 — voice must survive via Gemini
            _warn(f"Edge TTS failed ({exc}); falling back to Gemini TTS.")
    path = _tts_cache_path(text, _tts_voice())
    if path.is_file():
        return {"wav_path": path, "cached": True, "bytes": path.stat().st_size}
    impl = (gemini_synthesize_speech if slice_runner._ai_provider() == "gemini"
            else dashscope_synthesize_speech)
    chunks = _split_for_speech(text)
    if len(chunks) == 1:
        pcm = _chunk_pcm(impl, text)
    else:
        # Parallel: sequential chunk renders would push a long reply past the
        # cockpit's 90 s request budget.
        with ThreadPoolExecutor(max_workers=min(4, len(chunks))) as pool:
            pcm = b"".join(pool.map(lambda c: _chunk_pcm(impl, c), chunks))
    _write_cache(path, _pcm_to_wav_bytes(pcm), text,
                 {"provider": "gemini", "model": _tts_model(),
                  "voice": _tts_voice()})
    return {"wav_path": path, "cached": False, "bytes": path.stat().st_size}


# ===========================================================================
# AUDIO I/O (lazy imports: replay/text mode works without audio hardware)
# ===========================================================================

def _audio_deps():
    try:
        import numpy as np  # noqa: W0612
        import sounddevice as sd
        import soundfile as sf  # noqa: F401
        return sd
    except Exception as exc:
        _warn(f"audio stack unavailable ({exc}); continuing without playback/capture.")
        return None


def play_wav(wav_path: Path, mic_monitor=None) -> bool:
    """Play a wav file; returns True if interrupted by barge-in.

    Best-effort: if no audio device exists (e.g. headless box), logs and
    returns False — the transcript + saved wav still evidence the run."""
    sd = _audio_deps()
    if sd is None:
        return False
    try:
        if wav_path.suffix.lower() == ".mp3":
            data, sr = _read_mp3_int16(wav_path)
        else:
            data, sr = _read_wav_int16(wav_path)
        frames_total = len(data)
        cursor = {"i": 0}
        finished = threading.Event()

        def _callback(outdata, frames, _time_info, status):
            start = cursor["i"]
            end = start + frames
            chunk = data[start:end]
            if len(chunk) < frames:
                outdata[:len(chunk), 0] = chunk
                outdata[len(chunk):, 0] = 0
                cursor["i"] = frames_total
                raise sd.CallbackStop()
            outdata[:, 0] = chunk
            cursor["i"] = end

        stream = sd.OutputStream(samplerate=sr, channels=1, dtype="int16",
                                 callback=_callback, finished_callback=finished.set)
        stream.start()
        interrupted = False
        while not finished.wait(0.05):
            if mic_monitor is not None and mic_monitor.barge_in_detected():
                stream.abort()
                interrupted = True
                break
        stream.close()
        return interrupted
    except Exception as exc:
        _warn(f"playback failed: {exc}")
        return False


def _read_wav_int16(wav_path: Path):
    import numpy as np

    with wave.open(str(wav_path), "rb") as wf:
        sr = wf.getframerate()
        frames = wf.readframes(wf.getnframes())
    return np.frombuffer(frames, dtype=np.int16), sr


def _read_mp3_int16(mp3_path: Path):
    """Decode an Edge-TTS mp3 for terminal playback (libsndfile >= 1.1)."""
    import numpy as np  # noqa: F401  (dtype namespace, mirrors _read_wav_int16)
    import soundfile as sf

    pcm, sr = sf.read(str(mp3_path), dtype="int16")
    if pcm.ndim > 1:
        pcm = pcm[:, 0]
    return pcm, sr


class MicMonitor:
    """Continuous 16 kHz mono capture with energy VAD and barge-in detection.

    Known limitation (hackathon scope): there is no acoustic echo cancellation,
    so barge-in uses a raised energy threshold to avoid the bot interrupting
    itself through the speaker->mic path. Loud nearby speakers can still cause
    false barge-in; replay mode is the deterministic verification path."""

    BLOCK_S = 0.05  # 800-sample blocks at 16 kHz

    def __init__(self):
        sd = _audio_deps()
        if sd is None:
            raise RuntimeError("sounddevice is not available")
        import numpy as np

        self._np = np
        self._sd = sd
        self._lock = threading.Lock()
        self._blocks = collections.deque(maxlen=int(30 / self.BLOCK_S))  # 30s ring
        self.noise_floor = 0.0
        self.speech_threshold = 0.0
        self._stream = sd.InputStream(
            samplerate=MIC_SAMPLE_RATE, channels=1, dtype="int16",
            blocksize=int(MIC_SAMPLE_RATE * self.BLOCK_S), callback=self._on_block)

    def _on_block(self, indata, frames, _time_info, status):
        block = bytes(indata)
        with self._lock:
            self._blocks.append((time.monotonic(), block))

    def start(self):
        self._stream.start()

    def stop(self):
        self._stream.stop()
        self._stream.close()

    def _energy(self, block: bytes) -> float:
        samples = self._np.frombuffer(block, dtype=self._np.int16).astype(self._np.float32)
        return float(self._np.sqrt(self._np.mean(samples * samples)) + 1e-9)

    def calibrate(self, seconds: float = 1.0):
        """Measure ambient noise; set speech threshold above the noise floor."""
        time.sleep(0.1)
        with self._lock:
            baseline = [b for _t, b in list(self._blocks)]
        energies = [self._energy(b) for b in baseline[-int(seconds / self.BLOCK_S):]]
        self.noise_floor = (sum(energies) / len(energies)) if energies else 100.0
        self.speech_threshold = max(self.noise_floor * 2.5, 400.0)
        _log(f"mic calibrated: noise_floor={self.noise_floor:.0f}, "
             f"speech_threshold={self.speech_threshold:.0f}")

    def barge_in_detected(self) -> bool:
        if not self.speech_threshold:
            return False
        cutoff = time.monotonic() - BARGE_IN_HOLD_S
        with self._lock:
            recent = [b for t, b in self._blocks if t >= cutoff]
        if not recent:
            return False
        hits = sum(1 for b in recent
                   if self._energy(b) > self.speech_threshold * BARGE_IN_FACTOR)
        return hits >= max(2, int(0.6 * len(recent)))

    def capture_utterance(self, timeout_s: float = LISTEN_TIMEOUT_S) -> Optional[bytes]:
        """VAD-chunked capture: returns wav bytes for one utterance or None."""
        deadline = time.monotonic() + timeout_s
        started = self._blocks[-1][0] if self._blocks else time.monotonic()
        speech = []
        speaking = False
        last_speech = 0.0
        first_speech = 0.0
        last_appended_t = started
        while time.monotonic() < deadline:
            time.sleep(self.BLOCK_S)
            with self._lock:
                window = [(t, b) for t, b in self._blocks if t > started]
            if not window:
                continue
            energies = [(t, self._energy(b)) for t, b in window]
            loud_now = energies[-1][1] > self.speech_threshold
            if not speaking:
                if loud_now and len(energies) >= 2 and energies[-2][1] > self.speech_threshold:
                    speaking = True
                    first_speech = energies[-1][0]
                    last_speech = first_speech
                    pre_roll = window[-int(0.4 / self.BLOCK_S):]
                    speech = [b for _t, b in pre_roll]
                    last_appended_t = pre_roll[-1][0] if pre_roll else started
            else:
                fresh = [(t, b) for t, b in window if t > last_appended_t]
                for t, b in fresh:
                    speech.append(b)
                if fresh:
                    last_appended_t = fresh[-1][0]
                now_t = window[-1][0]
                if loud_now:
                    last_speech = now_t
                if now_t - last_speech > VAD_SILENCE_END_S:
                    break
                if last_speech - first_speech > VAD_MAX_UTTERANCE_S:
                    _log("max utterance length reached; cutting.")
                    break
        if not speaking or (last_speech - first_speech) < VAD_MIN_UTTERANCE_S:
            return None
        pcm = b"".join(speech)
        buf = io.BytesIO()
        with wave.open(buf, "wb") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(MIC_SAMPLE_RATE)
            wf.writeframes(pcm)
        return buf.getvalue()


# ===========================================================================
# ESCALATION HOOK — the clean Module 3/8 integration point
# ===========================================================================

def escalateIncident(incident_id: str, new_signals: dict) -> dict:
    """Escalate an incident mid-guidance. THE integration point for Module 3
    (matching/dispatch) and Module 8 (escalation), which do not exist yet:
    when they are built, wiring means CALLING this function, not rewriting it.

    Does the right thing with what exists today:
    - upgrades severity_tier if new_signals suggest higher (never downgrades),
    - merges new injury flags (additive),
    - flags BHU (re)notification and ambulance request on the incident record
      (the dispatch-intent markers Module 3 will pick up),
    - appends a timestamped escalation event (with trigger) to
      incident.help_bot_transitions,
    - refreshes the INCIDENT_STORE snapshot so the log stays inspectable.

    Inputs:  incident_id (str), new_signals (dict: trigger, new_flags,
             suggested_tier, transcript_excerpt).
    Output:  updated incident snapshot (dict). No hidden state beyond the
             incident record itself.
    """
    incident = _ACTIVE_INCIDENTS.get(incident_id)
    if incident is None:
        record = next((r for r in slice_runner.INCIDENT_STORE
                       if r["incident"].get("incident_id") == incident_id), None)
        if record is None:
            raise KeyError(
                f"escalateIncident: unknown incident_id {incident_id!r} — "
                "incident is neither in an active help-bot session nor in INCIDENT_STORE.")
        incident = slice_runner.Incident(**record["incident"])
        _ACTIVE_INCIDENTS[incident_id] = incident

    new_signals = dict(new_signals or {})
    trigger = str(new_signals.get("trigger") or "responder_report")
    old_tier = incident.severity_tier
    suggested = new_signals.get("suggested_tier")
    if suggested in TIER_ORDER and TIER_ORDER.index(suggested) > TIER_ORDER.index(old_tier):
        incident.severity_tier = suggested

    for flag in new_signals.get("new_flags") or []:
        flag = str(flag)
        if flag not in incident.injury_type_flags:
            incident.injury_type_flags.append(flag)

    now = _now_iso()
    if not incident.bhu_notified:
        incident.bhu_notified = True
        incident.bhu_notify_timestamp = now
        print(f"  [ESCALATION] BHU notification flagged for {incident_id} "
              "(Module 3 dispatch hook point).")
    if incident.severity_tier == "critical" and not incident.ambulance_requested:
        incident.ambulance_requested = True
        print(f"  [ESCALATION ALERT] Ambulance requested for {incident_id} "
              "(tier upgraded to critical).")

    event = {
        "timestamp": now,
        "branch": None,
        "from_state": "escalation_hook",
        "to_state": "escalated",
        "trigger_type": "escalateIncident",
        "detail": {
            "trigger": trigger,
            "old_tier": old_tier,
            "new_tier": incident.severity_tier,
            "transcript_excerpt": str(new_signals.get("transcript_excerpt", ""))[:200],
            "new_flags": new_signals.get("new_flags") or [],
        },
    }
    incident.help_bot_transitions.append(event)

    # Module 8 & 9 telemetry: mark mid_incident_escalated and log audit event
    incident.mid_incident_escalated = True
    incident.dispatch_events.append({
        "event": "mid_incident_escalation",
        "trigger_line": trigger,
        "upgraded_tier": incident.severity_tier,
        "ambulance_requested": incident.ambulance_requested,
        "timestamp": now,
    })

    _sync_store_snapshot(incident)
    print(f"  [ESCALATION] {incident_id}: severity {old_tier} -> {incident.severity_tier} "
          f"(trigger: {trigger})")
    return incident.model_dump()



def _sync_store_snapshot(incident) -> None:
    """Keep the INCIDENT_STORE record (written by Module 1's logIncident)
    reflecting live session state — inspectable, not a second store."""
    for record in slice_runner.INCIDENT_STORE:
        if record["incident"].get("incident_id") == incident.incident_id:
            record["incident"] = incident.model_dump()
            record["help_bot_synced_at"] = _now_iso()


# ===========================================================================
# CONVERSATION SESSION (state machine + continuous loop)
# ===========================================================================

class HelpBotSession:
    """One responder guidance session for one dispatched incident.

    States: initial_guidance -> ongoing_monitor -> escalated_monitor.
    The state machine only DECIDES; every spoken word is pre-written content.
    """

    def __init__(self, incident, mode: str = "replay"):
        register_incident(incident)
        self.incident = incident
        self.mode = mode
        self.branch_id, self.branch_matched = route_branch(incident.injury_type_flags)
        self.branch = BRANCHES[self.branch_id]
        self.state = "created"
        self.step_index = -1  # -1 = initial guidance not yet delivered
        self.turns: list = []
        self.latencies: list = []
        self.expectations: list = []
        self.mic: Optional[MicMonitor] = None
        self._failsafe_wav: Optional[Path] = None
        self._turn_t0: Optional[float] = None
        self._first_playback_delay_ms: Optional[int] = None
        self._prerender_failsafe()

    # ------------------------- internal helpers -------------------------

    def _prerender_failsafe(self) -> None:
        try:
            self._failsafe_wav = speakGuidance(SHARED_LINES["failsafe_line"])["wav_path"]
        except Exception as exc:
            _warn(f"could not pre-render fail-safe audio ({exc}); "
                  "fail-safe will fall back to printed Urdu text.")

    def _transition(self, to_state: str, trigger_type: str, detail: str,
                    latency_ms: Optional[int] = None) -> None:
        entry = {
            "timestamp": _now_iso(),
            "branch": self.branch_id,
            "from_state": self.state,
            "to_state": to_state,
            "trigger_type": trigger_type,
            "detail": detail[:300],
        }
        if latency_ms is not None:
            entry["latency_ms"] = latency_ms
        self.incident.help_bot_transitions.append(entry)
        self.state = to_state
        _sync_store_snapshot(self.incident)
        _log(f"TRANSITION {entry['from_state']} -> {to_state} ({trigger_type}: {detail[:80]})")

    def _record_turn(self, speaker: str, text: str, **extra) -> None:
        turn = {"timestamp": _now_iso(), "speaker": speaker, "text": text}
        turn.update(extra)
        self.turns.append(turn)

    def _recent_context(self) -> list:
        return [f"{t['speaker']}: {t['text']}" for t in self.turns[-6:]]

    def _current_step_line(self) -> Optional[str]:
        steps = self.branch["steps"]
        if 0 <= self.step_index < len(steps):
            return steps[self.step_index]["line"]
        return None

    def _speak(self, line: str) -> dict:
        """Speak one scripted line (TTS + best-effort playback)."""
        info = {"spoken": line, "tts": None, "playback": "skipped"}
        try:
            tts = speakGuidance(line)
            info["tts"] = {"wav": str(tts["wav_path"]), "cached": tts["cached"]}
            self._record_turn("bot", line, tts_cached=tts["cached"])
            print(f"  [BOT · اردو] {line}")
            # Latency = utterance end -> response playback START (the delay the
            # responder actually feels); playback duration is NOT latency.
            if self._turn_t0 is not None and self._first_playback_delay_ms is None:
                self._first_playback_delay_ms = int((time.perf_counter() - self._turn_t0) * 1000)
            interrupted = play_wav(tts["wav_path"], mic_monitor=self.mic)
            info["playback"] = "barge_in" if interrupted else "played"
        except Exception as exc:
            _warn(f"TTS failed ({exc}); speaking fail-safe instead.")
            self._record_turn("bot", SHARED_LINES["failsafe_line"],
                              tts_error=str(exc)[:120], intended_line=line)
            print(f"  [BOT · اردو · failsafe] {SHARED_LINES['failsafe_line']} "
                  f"(intended: {line[:60]})")
            if self._failsafe_wav is not None:
                play_wav(self._failsafe_wav, mic_monitor=self.mic)
            info["playback"] = "failsafe"
        return info

    def _speak_failsafe(self) -> None:
        self._record_turn("bot", SHARED_LINES["failsafe_line"])
        print(f"  [BOT · اردو · failsafe] {SHARED_LINES['failsafe_line']}")
        if self._failsafe_wav is not None:
            play_wav(self._failsafe_wav, mic_monitor=self.mic)

    # ------------------------- session lifecycle -------------------------

    def start_guidance(self) -> None:
        """Enter the branch: spoken initial guidance, then step 1."""
        detail = (f"branch={self.branch_id}; matched={self.branch_matched}; "
                  f"flags={self.incident.injury_type_flags}")
        if not self.branch_matched:
            detail += "; WARNING: no branch matched flags, safest default used (branch_unmatched)"
        self._transition("initial_guidance", "branch_entered", detail)
        for line in self.branch["initial_guidance"]:
            self._speak(line)
        self._advance_step()

    def _advance_step(self) -> None:
        steps = self.branch["steps"]
        self.step_index += 1
        if self.step_index < len(steps):
            step = steps[self.step_index]
            self._transition("ongoing_monitor", "step_started",
                             f"step {self.step_index + 1}/{len(steps)}: {step['step_id']}")
            self._speak(step["line"])
        else:
            self._transition("ongoing_monitor", "steps_complete",
                             "all scripted steps delivered")
            self._speak(SHARED_LINES["session_complete_line"])

    # ------------------------- turn handling -------------------------

    def handle_transcript(self, transcript: str, expect: Optional[str] = None) -> dict:
        """One responder turn: classify intent, act, speak scripted content.

        Returns the outcome dict (intent, action taken, latency)."""
        t_start = time.perf_counter()
        self._turn_t0 = t_start
        self._first_playback_delay_ms = None
        transcript = (transcript or "").strip()
        self._record_turn("responder", transcript)
        print(f"  [RESPONDER · اردو] {transcript}")

        if not transcript:
            intent = {"intent": INTENT_UNCLEAR, "qa_entry_id": None,
                      "escalation_signal": None, "suggested_tier": None,
                      "reason": "empty transcript"}
        else:
            intent = detectResponderIntent(
                self.branch_id, transcript,
                current_step_line=self._current_step_line(),
                recent_context=self._recent_context())
        t_detected = time.perf_counter()
        _log(f"intent={intent['intent']} qa={intent['qa_entry_id']} "
             f"signal={intent['escalation_signal']} tier={intent['suggested_tier']} "
             f"({intent['reason']})")

        action = self._act_on_intent(intent, transcript)
        t_end = time.perf_counter()
        # respond_ms = utterance end -> first playback start (honest latency);
        # turn_wall_ms additionally includes full audio playback duration.
        latency_ms = (self._first_playback_delay_ms
                      if self._first_playback_delay_ms is not None
                      else int((t_end - t_start) * 1000))
        self.latencies.append({"transcript": transcript[:80],
                               "intent": intent["intent"],
                               "detect_ms": int((t_detected - t_start) * 1000),
                               "respond_ms": latency_ms,
                               "turn_wall_ms": int((t_end - t_start) * 1000)})
        outcome = {"intent": intent, "action": action, "latency_ms": latency_ms}
        if expect:
            self.expectations.append({
                "transcript": transcript[:80], "expected": expect,
                "actual": intent["intent"], "match": expect == intent["intent"],
            })
            _log(f"expectation: {expect} -> {intent['intent']} "
                 f"({'MATCH' if expect == intent['intent'] else 'MISMATCH'})")
        return outcome

    def _act_on_intent(self, intent: dict, transcript: str) -> str:
        kind = intent["intent"]

        if kind == INTENT_STEP_DONE:
            action = f"advance_step (was step {self.step_index + 1})"
            self._advance_step()
            return action

        if kind == INTENT_IN_SCOPE:
            entry = next(e for e in self.branch["qa_entries"]
                         if e["qa_id"] == intent["qa_entry_id"])
            self._transition(self.state, "in_scope_question",
                             f"qa_entry={entry['qa_id']}")
            self._speak(entry["answer"])
            return f"answered_in_scope:{entry['qa_id']}"

        if kind == INTENT_OUT_OF_SCOPE:
            self._transition(self.state, "out_of_scope_question",
                             "honest fallback; no improvisation")
            self._speak(SHARED_LINES["out_of_scope_fallback"])
            return "honest_out_of_scope_fallback"

        if kind == INTENT_ESCALATION:
            signal = intent["escalation_signal"] or "condition_worsening"
            suggested = intent["suggested_tier"] or "critical"  # safer default
            self._transition("escalated_monitor", "escalation_triggered",
                             f"signal={signal}; suggested_tier={suggested}")
            for line in self.branch["escalated_guidance"]:
                self._speak(line)
            escalateIncident(self.incident.incident_id, {
                "trigger": signal,
                "suggested_tier": suggested,
                "new_flags": [signal],
                "transcript_excerpt": transcript,
            })
            return f"escalated:{signal}->tier:{suggested}"

        # unclear / STT failure: fail-safe, never silence
        self._transition(self.state, "unintelligible_input",
                         "fail-safe line spoken; loop continues")
        self._speak_failsafe()
        return "failsafe_line"

    # ------------------------- run modes -------------------------

    def run_replay(self, script: dict) -> dict:
        """Deterministic harness: scripted responder turns through the real
        pipeline. 'text' turns skip STT (zero quota); 'audio' turns exercise
        the real STT path. TTS is always real (cached)."""
        _log(f"replay script: {script.get('title', '(untitled)')}")
        self.start_guidance()
        for i, turn in enumerate(script.get("turns", []), start=1):
            print(f"\n--- replay turn {i} ---")
            if turn.get("kind") == "audio":
                audio_bytes = Path(turn["audio_path"]).read_bytes()
                stt = transcribeResponderInput(audio_bytes)
                text = stt.get("text", "")
                _log(f"STT: usable={stt.get('usable')} text={text[:80]}")
                if not stt.get("usable"):
                    text = ""
            else:
                text = turn.get("urdu", "")
            self.handle_transcript(text, expect=turn.get("expect"))
        return self.finalize(run_kind="replay", script_title=script.get("title"))

    def run_mic(self) -> dict:
        """Live hands-free loop: continuous listening, barge-in, no push-to-talk."""
        self.mic = MicMonitor()
        self.mic.start()
        _log("mic open; calibrating noise floor (stay quiet 1s)...")
        self.mic.calibrate()
        silent_cycles = 0
        try:
            self.start_guidance()
            while True:
                wav_bytes = self.mic.capture_utterance()
                if wav_bytes is None:
                    silent_cycles += 1
                    if silent_cycles >= SILENT_CYCLES_BEFORE_CHECKIN:
                        self._speak(SHARED_LINES["check_in_line"])
                        silent_cycles = 0
                    continue
                silent_cycles = 0
                stt = transcribeResponderInput(wav_bytes)
                if not stt.get("usable"):
                    self._speak_failsafe()
                    continue
                self.handle_transcript(stt["text"])
        except KeyboardInterrupt:
            _log("session interrupted by operator (Ctrl+C).")
        finally:
            self.mic.stop()
        return self.finalize(run_kind="mic")

    # ------------------------- evidence -------------------------

    def finalize(self, run_kind: str, script_title: Optional[str] = None) -> dict:
        self._turn_t0 = None
        self._transition(self.state, "session_finalized", f"run_kind={run_kind}")
        matched = sum(1 for e in self.expectations if e["match"])
        respond_ms = [l["respond_ms"] for l in self.latencies]
        record = {
            "run_kind": run_kind,
            "script_title": script_title,
            "incident_id": self.incident.incident_id,
            "branch_id": self.branch_id,
            "branch_matched": self.branch_matched,
            "provider": slice_runner._ai_provider(),
            "started_at": self.turns[0]["timestamp"] if self.turns else None,
            "finalized_at": _now_iso(),
            "turns": self.turns,
            "expectations": self.expectations,
            "expectation_summary": f"{matched}/{len(self.expectations)} matched",
            "latencies": self.latencies,
            "latency_summary_ms": {
                "min": min(respond_ms) if respond_ms else None,
                "max": max(respond_ms) if respond_ms else None,
                "avg": int(sum(respond_ms) / len(respond_ms)) if respond_ms else None,
            },
            "help_bot_transitions": self.incident.help_bot_transitions,
            "final_incident": self.incident.model_dump(),
        }
        TEST_RUNS_DIR.mkdir(parents=True, exist_ok=True)
        out = TEST_RUNS_DIR / f"{self.incident.incident_id}_{run_kind}_{int(time.time())}.json"
        out.write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8")
        _log(f"run record written: {out}")
        return record
