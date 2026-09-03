---
kind: build_system
name: Python Virtualenv + Manual Uvicorn/FastAPI Deployment (No Container/CI)
category: build_system
scope:
    - '**'
source_files:
    - backend/requirements.txt
    - backend/main.py
    - backend/help_bot_runner.py
    - backend/slice_runner.py
    - backend/scripts/migrate_seed_data.py
    - .env
---

## What system/approach is used

This repository has **no formal build system, containerization, CI pipeline, or packaging tooling**. The project is a Python application deployed by running scripts directly from the source tree. The only build-adjacent artifact is `backend/requirements.txt`, which pins runtime dependencies for a local virtual environment (`python -m venv .venv` at the repo root). There are no `Makefile`, `Dockerfile`, `docker-compose.yml`, `pyproject.toml`, `setup.py`, tox config, GitHub Actions, or any other automation script.

The application is started in two ways:
- HTTP server: `uvicorn main:app --port 5000` from `backend/`, or `python backend/main.py` (which internally calls `uvicorn.run("main:app", host="0.0.0.0", port=PORT)` with `PORT` read from `.env`).
- CLI runners: `python backend/help_bot_runner.py` and `python backend/slice_runner.py` invoke the same underlying service stack as entry points for triage simulation, replay, and TTS verification.

## Key files and packages

- `backend/requirements.txt` — single dependency manifest; all third-party packages (FastAPI, uvicorn, SQLAlchemy, psycopg2-binary, google-genai, dashscope, python-dotenv, sounddevice, soundfile, httpx) are listed here.
- `backend/main.py` — FastAPI application entrypoint; mounts routers, static media, lifespan startup bootstrap, `/health` probe, and `uvicorn.run` when executed as `__main__`.
- `backend/help_bot_runner.py` — argparse-based CLI that drives Module 2 help-bot scenarios (simulate, replay, mic, prewarm-tts, verify-tts).
- `backend/slice_runner.py` — core vertical-slice module containing seed data, AI provider selection (Gemini vs DashScope via `TRIAGE_AI_PROVIDER`), triage pipeline, dispatch logic, and an embedded test suite runnable via `python backend/slice_runner.py`.
- `backend/scripts/migrate_seed_data.py` — one-off DB migration/seed script invoked manually.
- `.env` at repo root — holds secrets (`DASHSCOPE_API_KEY`, `GEMINI_API_KEY`, `PORT`, etc.); loaded by `dotenv.load_dotenv` from `slice_runner.py` and `main.py`.

## Architecture and conventions

- **Single-process deployment**: everything runs in one Python process per invocation. There is no multi-service orchestration, no reverse proxy, no systemd unit, no Docker image.
- **Environment-driven configuration**: all external wiring (AI providers, API keys, timeouts, retry backoff, replay mode) is controlled through environment variables loaded from `.env`. Switching between Gemini and DashScope requires no code change — only `TRIAGE_AI_PROVIDER=dashscope` in `.env`.
- **Fail-fast replay mode**: setting `LIFELINE_REPLAY_MODE=1` (automatically done by `help_bot_runner.py` for `--mode replay` and `--verify-tts`) reduces retry backoff from 15s to 2s so deterministic tests do not stall on quota limits.
- **Manual testing discipline**: each feature/module has its own top-level `test_module*.py`, `test_api_live.py`, `verify_stt.py`, `verify_vision.py` scripts run directly with `python`. There is no unified test runner command.
- **Static assets served from disk**: the FastAPI app mounts `/media` pointing at `mockdata/`, so TTS audio and photos are served as static files without a separate asset server.

## Conventions and constraints

- **No automated builds or releases**: there is no versioned release process, no changelog generator, no artifact upload step. Version is hardcoded as `APP_VERSION = "1.0.0"` in `main.py`.
- **Secrets must live in `.env` at the repo root**: both `main.py` and `slice_runner.py` load dotenv from `Path(__file__).resolve().parent.parent / ".env"`; hardcoding keys raises explicit `RuntimeError`s if missing.
- **Dependencies are pinned loosely** using `>=` operators in `requirements.txt` (e.g., `fastapi>=0.141.0`, `uvicorn>=0.52.0`); reproducibility relies on the shared `.venv` directory rather than lockfiles.
- **Startup is resilient to DB failure**: `bootstrap_responder_state()` catches every DB exception as non-fatal and boots from seed defaults, so the emergency line stays up even if PostgreSQL is unreachable.
- **No cross-compilation or platform-specific builds**: the codebase targets a single Python interpreter on the developer machine; Windows console encoding is handled via `sys.stdout.reconfigure(encoding="utf-8")` in each entry point.