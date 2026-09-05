# -*- coding: utf-8 -*-
"""Module 6.5 — Seed & Migration Utility.

Ingests existing incident records from mockdata/incidents/incident_history.json
and persists them into the PostgreSQL `incidents` table.

Usage:
    cd "d:\\LifeLine Ride"
    python backend/scripts/migrate_seed_data.py

Properties:
    - Idempotent: uses upsert (INSERT ON CONFLICT DO UPDATE), so re-running
      never creates duplicates or raises errors on existing rows.
    - Schema-safe: Base.metadata.create_all() runs first, creating the
      incidents table if it does not exist yet.
    - Validates the incident_id field before each upsert; records without
      an id are skipped with a warning.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

# ---------------------------------------------------------------------------
# Path bootstrap — run as `python backend/scripts/migrate_seed_data.py`
# from the project root, or directly from backend/scripts/.
# ---------------------------------------------------------------------------
_SCRIPT_DIR   = Path(__file__).resolve().parent
_BACKEND_DIR  = _SCRIPT_DIR.parent
_PROJECT_ROOT = _BACKEND_DIR.parent

for _p in [str(_BACKEND_DIR), str(_PROJECT_ROOT)]:
    if _p not in [str(x) for x in sys.path]:
        sys.path.insert(0, _p)

from models.incident_model import upsert_incident_to_db  # noqa: E402  (also runs create_all)

_HISTORY_PATH = _PROJECT_ROOT / "mockdata" / "incidents" / "incident_history.json"


def migrate() -> None:
    print("=" * 65)
    print("  Module 6.5 — Seed Migration: incident_history.json -> PostgreSQL")
    print("=" * 65)

    if not _HISTORY_PATH.exists():
        print(f"  [SKIP] History file not found: {_HISTORY_PATH}")
        print("  Nothing to migrate.")
        return

    raw = _HISTORY_PATH.read_text(encoding="utf-8")
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as exc:
        print(f"  [ERROR] Cannot parse {_HISTORY_PATH}: {exc}")
        sys.exit(1)

    records = payload.get("records", [])
    exported_at = payload.get("exported_at", "unknown")
    print(f"  Source  : {_HISTORY_PATH}")
    print(f"  Exported: {exported_at}")
    print(f"  Records : {len(records)}")
    print()

    migrated = 0
    skipped  = 0
    errors   = 0

    for i, record in enumerate(records, start=1):
        inc = record.get("incident", {})
        incident_id = inc.get("incident_id", "")
        if not incident_id:
            print(f"  [WARN] Record #{i} has no incident_id — skipped.")
            skipped += 1
            continue

        try:
            upsert_incident_to_db(record)
            print(f"  [OK] Upserted {incident_id}")
            migrated += 1
        except Exception as exc:
            print(f"  [ERROR] Failed to upsert {incident_id}: {exc}")
            errors += 1

    print()
    print("=" * 65)
    print(f"  Migration complete: {migrated} upserted, "
          f"{skipped} skipped, {errors} errors.")
    print("=" * 65)

    if errors:
        sys.exit(1)


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    migrate()
