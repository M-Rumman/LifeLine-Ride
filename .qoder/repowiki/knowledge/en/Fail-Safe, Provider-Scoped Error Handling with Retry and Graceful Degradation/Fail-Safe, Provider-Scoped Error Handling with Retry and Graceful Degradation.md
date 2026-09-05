---
kind: error_handling
name: Fail-Safe, Provider-Scoped Error Handling with Retry and Graceful Degradation
category: error_handling
scope:
    - '**'
source_files:
    - backend/slice_runner.py
    - backend/services/help_bot_service.py
    - backend/help_bot_runner.py
---

## Overview

The LifeLine Ride backend uses a **fail-safe-first** error handling strategy centered on three pillars: (1) provider-scoped AI calls wrapped in retry logic, (2) per-step try/except blocks that swallow failures and return sentinel values or safe defaults, and (3) pre-rendered fail-safe audio lines so the responder always hears guidance even when every external service is down. There is no centralized exception hierarchy, no HTTP middleware, and no structured logging framework — errors are handled inline at each boundary.

## Core Mechanisms

### 1. Centralized Retry Wrapper (`slice_runner._call_with_retry`)
All Gemini API calls go through `_call_with_retry(fn, step_name)` which retries only on quota/rate-limit errors (`429`, `RESOURCE_EXHAUSTED`) with exponential backoff capped at 60s. Non-quota exceptions are re-raised immediately. The number of attempts is controlled by `TRIAGE_QUOTA_RETRIES`. This is the single shared retry policy for STT, vision, and classifier steps.

### 2. Sentinel Failures via `FAILED_SIGNAL`
The triage pipeline defines a module-level sentinel:
```python
FAILED_SIGNAL = {"status": "failed"}
```
Each provider step (`transcribe_voice_note`, `classify_injury_photo`, `_combine_triage_signals`) wraps its call in try/except and returns `dict(FAILED_SIGNAL)` on any exception instead of raising. The pipeline then checks `vision.get("status") != "failed"` to decide whether to proceed. This turns transient failures into data-flow signals rather than control-flow breaks.

### 3. Per-Step Fail-Safes in Help Bot Service
`services/help_bot_service.py` mirrors the same pattern for Module 2:
- `transcribeResponderInput`: catches all exceptions, logs via `_warn`, returns `{"text": "", "usable": False}`.
- `detectResponderIntent`: catches all exceptions, returns a normalized intent dict with `intent=INTENT_UNCLEAR` and `reason=f"call_failed: {exc}"[:120]`.
- `play_wav`: best-effort playback; if no audio device exists it returns `False` without crashing.
- `MicMonitor.__init__`: raises `RuntimeError("sounddevice is not available")` only when live mic mode is explicitly requested — replay mode works headless.

### 4. Pre-Rendered Failsafe Audio
Every scripted line is rendered once to disk under `mockdata/helpbot/tts_cache/` via `speakGuidance`. On TTS failure, `_speak()` falls back to `SHARED_LINES["failsafe_line"]` and plays a pre-rendered WAV if available. The session constructor `_prerender_failsafe()` renders this line at startup so a later network failure still produces audible output. The rule is explicit in comments: *"never silence/hang"*.

### 5. Environment & Credential Errors
Missing API keys raise `RuntimeError` at import/configuration time:
- `_get_api_key()`: raises if `DASHSCOPE_API_KEY` is unset.
- `_get_gemini_key()`: raises if `GEMINI_API_KEY` is unset.
- `_triage_timeout_s()`: enforces a per-call timeout (default 30s) via `TRIAGE_CALL_TIMEOUT_S`; timeouts propagate as exceptions and route to fail-safes.

### 6. Explicit Error Types Used
No custom exception classes exist. The codebase raises built-in types deliberately:
- `RuntimeError` — configuration errors (missing keys), unverified providers (`dashscope_synthesize_speech` refuses to run until Urdu voice is verified), non-JSON model responses, missing media files.
- `KeyError` — unknown `incident_id` passed to `escalateIncident`.
- `KeyboardInterrupt` — caught in `HelpBotSession.run_mic` to cleanly stop the mic stream.
- `SystemExit` — raised from `main()` to set process exit codes.

### 7. Logging as Error Surface
There is no logger instance. Errors surface via two helpers:
- `_log(msg)`: normal progress messages prefixed `[HELPBOT]`.
- `_warn(msg)`: warning messages prefixed `[HELPBOT WARN]`.
In `slice_runner.py`, warnings use `[TRIAGE WARN]` and retries use `[TRIAGE RETRY]`. All output goes to stdout; there is no file-based log rotation.

### 8. State Mutation as Side-Effect Error Reporting
Escalations and transitions are recorded by appending entries to `incident.help_bot_transitions` via `_transition()`, which captures `from_state`, `to_state`, `trigger_type`, and `detail`. This doubles as an audit trail of both successful flows and error-triggered transitions (e.g., `unintelligible_input`, `step_started`).

## Conventions Observed

- **Provider boundaries are isolated**: every AI capability has a `gemini_*` and `dashscope_*` implementation selected by `TRIAGE_AI_PROVIDER`; failures in one provider do not leak into the other.
- **Downgrade-to-safe-default**: STT/intent/vision failures never crash the flow; they produce usable-but-degraded results (empty transcript, `INTENT_UNCLEAR`, `moderate` tier with `low_confidence_triage` flag).
- **Quota-aware pacing**: `prewarm_tts()` renders all scripted lines with 8-second sleeps between fresh renders to stay under free-tier rate limits; failures are retried up to 3 times with 60s waits.
- **Never improvise content**: out-of-scope questions get a fixed fallback line (`SHARED_LINES["out_of_scope_fallback"]`) rather than generating new text, preventing hallucinated medical advice.
- **Headless operation**: audio-dependent features gracefully degrade; replay mode requires no sound hardware.

## Constraints Enforced by Code

- Missing `DASHSCOPE_API_KEY` / `GEMINI_API_KEY` → immediate `RuntimeError` before any AI call.
- DashScope SDK import failure + `TRIAGE_AI_PROVIDER=dashscope` → `RuntimeError` explaining the missing SDK.
- Non-JSON LLM responses → `RuntimeError` with truncated response snippet for diagnostics.
- Unknown `incident_id` in `escalateIncident` → `KeyError` with incident lookup context.
- Live mic mode without audio stack → `RuntimeError("sounddevice is not available")`.
- TTS synthesis for unverified DashScope Urdu voice → `RuntimeError` refusing to speak possibly non-Urdu audio.