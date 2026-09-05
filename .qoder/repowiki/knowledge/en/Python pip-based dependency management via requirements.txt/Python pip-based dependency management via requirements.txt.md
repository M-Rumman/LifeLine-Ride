---
kind: dependency_management
name: Python pip-based dependency management via requirements.txt
category: dependency_management
scope:
    - '**'
source_files:
    - backend/requirements.txt
---

This repository uses a minimal Python dependency-management setup centered on a single `requirements.txt` file located at `backend/requirements.txt`. There is no lockfile (no `requirements.lock`, `poetry.lock`, `Pipfile.lock`, or `pipenv` artifacts), no vendored third-party packages, and no private PyPI registry configuration.

**System/approach used**
- Package manager: standard `pip` with a flat `requirements.txt` manifest in the backend directory.
- Versioning style: loose upper-bound constraints using `>=` pins (e.g. `dashscope>=1.20.0`, `python-dotenv>=1.0.0`, `google-genai>=2.19.0`, `sounddevice>=0.5.0`, `soundfile>=0.13.0`). No exact version pins are declared, so installs resolve to the latest compatible release available in the environment at install time.
- Scope: only the Python backend declares dependencies; the `frontend/` directory is empty and contains no `package.json`, `yarn.lock`, or other frontend manifests.

**Key files**
- `backend/requirements.txt` — the sole dependency manifest for the project.

**Architecture and conventions**
- Dependencies are grouped by functional area within one file rather than split across multiple requirement files (no `dev-requirements.txt`, `test-requirements.txt`, etc.).
- The listed packages map directly to backend capabilities: `dashscope` and `google-genai` for AI/model access, `python-dotenv` for environment variable loading, and `sounddevice`/`soundfile` for audio I/O used by the help-bot and triage runners.
- No virtual-environment state is committed to the repo (no `venv/` or `.venv/` under version control); the `.gitignore` at the repo root likely excludes such directories.

**Conventions and constraints**
- All runtime dependencies are pinned with minimum-version (`>=`) constraints only — there is no explicit maximum version pinning, which means upgrades are automatic unless an incompatible major release appears.
- There is no documented policy for how dependencies should be updated, reviewed, or audited; no CI step or script was found that enforces dependency freshness or vulnerability scanning.
- No private package registry or custom index URL is configured in any visible file.