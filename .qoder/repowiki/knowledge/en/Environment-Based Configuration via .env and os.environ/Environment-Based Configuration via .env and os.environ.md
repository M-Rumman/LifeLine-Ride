---
kind: configuration_system
name: Environment-Based Configuration via .env and os.environ
category: configuration_system
scope:
    - '**'
source_files:
    - backend/slice_runner.py
    - backend/services/help_bot_service.py
    - backend/requirements.txt
---

## What system/approach is used

The repository uses a minimal, environment-variable-driven configuration approach. There is no centralized config loader, YAML/TOML parser, or settings module. Instead, runtime behavior is controlled entirely through `os.environ` variables loaded from a `.env` file at the repository root (one level above `backend/`). The `python-dotenv` library (`load_dotenv`) is invoked once in `backend/slice_runner.py` to populate `os.environ` before any service code runs.

## Key files and packages

- `backend/slice_runner.py` — single source of truth for all configuration loading:
  - Loads `.env` from `Path(__file__).resolve().parent.parent / ".env"` (repo root).
  - Provides helper functions `_get_api_key()`, `_get_gemini_key()`, `_triage_timeout_s()`, `_ai_provider()` that read env vars with defaults and raise `RuntimeError` when required secrets are missing.
  - Configures DashScope endpoint selection (`DASHSCOPE_BASE_URL`, auto-detects intl vs cn based on key length).
  - Defines retry/backoff parameters via `TRIAGE_QUOTA_RETRIES`.
- `backend/services/help_bot_service.py` — reads additional provider/model/env knobs directly via `os.environ.get`:
  - `GEMINI_STT_MODEL`, `GEMINI_CLASSIFIER_MODEL`, `GEMINI_VISION_MODEL`
  - `DASHSCOPE_CLASSIFIER_MODEL`
  - `GEMINI_TTS_MODEL`, `GEMINI_TTS_VOICE`
- `requirements.txt` — declares `dotenv` as a dependency.

## Architecture and conventions

1. **Single entrypoint loads `.env`**: Only `slice_runner.py` calls `load_dotenv`; other modules import it and rely on its side effect. This centralizes secret loading so credentials never appear in code.
2. **Provider switch via one env var**: `TRIAGE_AI_PROVIDER` (default `gemini`) selects between Gemini and DashScope implementations across STT, vision, classifier, and TTS steps. Switching providers requires no code changes — only flipping this one variable.
3. **Secrets are mandatory and fail-fast**: `_get_api_key()` and `_get_gemini_key()` raise `RuntimeError` with explicit instructions to add the key to the repo-root `.env` file if absent. The comments explicitly state keys must never be hardcoded or committed.
4. **Feature toggles via env with typed defaults**: Numeric/config values use `os.environ.get("VAR", "default")` followed by `int(...)` conversion, e.g. `TRIAGE_CALL_TIMEOUT_S` (default 30), `TRIAGE_QUOTA_RETRIES` (default 3). Missing or malformed values will raise `ValueError` at startup — there is no validation layer beyond Python's built-in type coercion.
5. **No per-environment config files**: There are no `config/dev.yaml`, `config/prod.toml`, or similar. All variation is expressed as environment variables.
6. **Hardcoded paths for non-secret assets**: Paths like `mockdata/media/.triage_cache`, `mockdata/helpbot/tts_cache`, and `mockdata/helpbot/test_runs` are hard-coded relative to the repo root; these are not configurable.

## Conventions and constraints

- **`.env` lives at the repository root** (one directory above `backend/`); `load_dotenv` resolves it via `Path(__file__).resolve().parent.parent / ".env"`.
- **API keys must be set in `.env`**: `DASHSCOPE_API_KEY` and `GEMINI_API_KEY` are required; their absence raises `RuntimeError` with instructions to add them to `.env`.
- **Never hardcode secrets**: Explicitly documented in comments in `slice_runner.py` — keys are never printed or logged, and callers are told to put them in `.env`.
- **Provider swap without code changes**: Setting `TRIAGE_AI_PROVIDER=dashscope` in `.env` switches the entire pipeline (STT, vision, classifier, intent detection) to DashScope; the code path is selected uniformly via `_ai_provider()`.
- **Model names are overridable per step**: Each AI call reads its model name from an env var with a sensible default (e.g. `GEMINI_STT_MODEL`, `GEMINI_VISION_MODEL`, `GEMINI_CLASSIFIER_MODEL`, `DASHSCOPE_CLASSIFIER_MODEL`, `GEMINI_TTS_MODEL`), allowing per-step tuning without changing code.
- **Timeouts and retries are environment-configurable**: `TRIAGE_CALL_TIMEOUT_S` controls per-call timeout (used for both Gemini HTTP options and DashScope calls); `TRIAGE_QUOTA_RETRIES` controls how many times quota-exhausted (429/RESOURCE_EXHAUSTED) errors are retried with exponential backoff.
- **DashScope endpoint can be forced**: `DASHSCOPE_BASE_URL` overrides automatic intl/cn endpoint detection based on key length.
- **TTS voice is configurable**: `GEMINI_TTS_VOICE` defaults to `Kore`; audio output is cached to disk keyed by voice+text hash, so changing the voice produces new cache entries rather than invalidating everything.