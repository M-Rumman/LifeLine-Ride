---
kind: logging_system
name: Console-Print Logging with In-Memory Incident Store and Structured Triage Signals
category: logging_system
scope:
    - '**'
source_files:
    - backend/slice_runner.py
    - backend/help_bot_runner.py
    - backend/verify_stt.py
    - backend/verify_vision.py
---

## What system/approach is used

The repository does **not** use a logging framework (no `logging` module import, no loggers, no log levels). All observability is produced via:

1. **`print()` to stdout** — every operational event emits a human-readable line prefixed by a bracketed tag such as `[RUNNER]`, `[TRIAGE WARN]`, `[DISPATCH LOG]`, `[DISPATCH WARNING]`, `[DISPATCH ALERT]`, or `[TRIAGE RETRY]`. This is the only runtime output mechanism in the backend.
2. **In-memory structured records** — `slice_runner.INCIDENT_STORE` is a module-level list that accumulates full incident + dispatch records via `logIncident(incident, result)`, which serializes each entry as a dict containing `incident.model_dump()`, `dispatch_status`, and `logged_at` ISO timestamp.
3. **File-based artifacts** — verification and replay outputs are written as JSON files under `mockdata/helpbot/test_runs/` (e.g. `verify_tts.json`, replay JSONs) and the triage pipeline caches intermediate results as JSON under `mockdata/media/.triage_cache/`.

There is no configuration of sinks, rotation, file handlers, or log levels; everything goes to standard output plus on-disk JSON artifacts.

## Key files and packages

- `backend/slice_runner.py` — central source of all console logs and the in-memory store. Defines `logIncident()` (line 665–672), prints `[TRIAGE WARN]` / `[DISPATCH LOG]` / `[DISPATCH WARNING]` / `[DISPATCH ALERT]` / `[TRIAGE RETRY]` messages, and appends records to `INCIDENT_STORE`.
- `backend/help_bot_runner.py` — top-level CLI entrypoint for Module 2; prints `[RUNNER]` lines around incident build, dispatch, session routing, prewarm progress, and final session summary.
- `backend/verify_stt.py` and `backend/verify_vision.py` — verification scripts that print per-clip/per-photo results and return non-zero exit codes on failures.
- `mockdata/helpbot/test_runs/*.json` — persisted replay/verification artifacts produced by the help-bot runner.
- `mockdata/media/.triage_cache/*.json` — cached triage results produced by `_save_triage_cache`.

## Architecture and conventions

### Console log format
Every `print()` call follows a consistent shape: an optional separator banner (`"=" * 70/75`) followed by tagged lines:
- `[RUNNER]` — help-bot orchestration events (incident dispatched, branch routed, session complete).
- `[TRIAGE WARN]` — non-fatal AI-call warnings (missing audio, STT/vision/classifier failure).
- `[DISPATCH LOG]` / `[DISPATCH WARNING]` / `[DISPATCH ALERT]` — dispatcher outcomes (responder assigned, no responders available, ambulance requested).
- `[TRIAGE RETRY]` — quota/429 backoff events during AI calls.

Tags are printed inline with the message rather than via a formatter; there is no structured log object emitted to stdout.

### Structured in-memory log
`logIncident()` builds a dict with three fields:
```python
{
    "incident": incident.model_dump(),
    "dispatch_status": dispatch_result.status,
    "logged_at": datetime.now(timezone.utc).isoformat()
}
```
and appends it to the module-level `INCIDENT_STORE` list. This is the only place where a fully structured record is assembled; callers do not serialize it further.

### Triage signal enrichment
The triage pipeline itself enriches its own output with a `triage_signals` list (source/provider/status/detail) so downstream consumers can inspect what happened at each step (STT, vision, classifier). Failures produce `FAILED_SIGNAL = {"status": "failed"}` and are logged via `[TRIAGE WARN]` before returning the fail-safe moderate tier.

### Secrets policy
A comment in `slice_runner.py` explicitly states: *"The API key lives in the repo-root .env ... The key is NEVER printed or logged anywhere in this module."* The code enforces this by reading keys via `os.environ.get(...)` and raising `RuntimeError` when missing, never interpolating them into print statements.

### Conventions and constraints
- **No log levels**: There is no distinction between INFO/WARN/ERROR in the output; severity is conveyed purely through tag names and message wording.
- **No external sink**: Logs are not routed to files, syslog, or a monitoring service; they are consumed by humans running the scripts directly.
- **Deterministic replay artifacts**: Verification runs write JSON reports (`verify_tts.json`, replay JSONs) instead of relying solely on stdout, enabling automated comparison.
- **Fail-safe logging**: Every AI call path catches exceptions and prints a `[TRIAGE WARN]` line before returning a degraded result, ensuring the emergency flow never blocks on logging.
- **UTF-8 stdout**: Scripts call `sys.stdout.reconfigure(encoding="utf-8")` to support Urdu text in console output.