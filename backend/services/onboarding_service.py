# -*- coding: utf-8 -*-
"""Module 7 — Responder Onboarding, Verification & Dynamic Registration Service.

Core Principles:
    - Trust starts at registration. Responders cannot self-verify.
    - Any volunteer can register their profile, but they remain in an inactive,
      unverified state (is_verified=False, current_availability_status='unverified')
      until an authorized training partner or Basic Health Unit (BHU) signs off on
      their equipment and training.
    - Only after verification sign-off is a responder promoted to 'available' and
      eligible for emergency dispatch in Module 3.
    - Full synchronization between PostgreSQL persistence and in-memory registry.
"""
from __future__ import annotations

import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Optional

# ---------------------------------------------------------------------------
# Path setup
# ---------------------------------------------------------------------------
_BACKEND_DIR = Path(__file__).resolve().parent.parent
if str(_BACKEND_DIR) not in [str(p) for p in sys.path]:
    sys.path.insert(0, str(_BACKEND_DIR))

import slice_runner
from models import responder_model


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _log(msg: str) -> None:
    print(f"  [ONBOARDING] {msg}")


def _warn(msg: str) -> None:
    print(f"  [ONBOARDING WARN] {msg}")


# ===========================================================================
# 1. CANDIDATE REGISTRATION
# ===========================================================================

def registerCandidateResponder(data: dict) -> dict:
    """Register a new candidate responder profile.

    Validates required fields: name, village, phone_number, linked_bhu_id.
    Defaults is_verified=False, current_availability_status='unverified'.
    Persists to PostgreSQL and syncs in-memory SEED_RESPONDERS immediately.

    Raises:
        ValueError: If any required field is missing or empty.
    """
    required_fields = ["name", "village", "phone_number", "linked_bhu_id"]
    for field in required_fields:
        val = data.get(field)
        if not val or not str(val).strip():
            raise ValueError(f"Missing required registration field: '{field}'")

    responder_id = data.get("responder_id")
    if not responder_id or not str(responder_id).strip():
        responder_id = f"RESP-{uuid.uuid4().hex[:6].upper()}"

    candidate = {
        "responder_id": responder_id.strip(),
        "name": data["name"].strip(),
        "village": data["village"].strip(),
        "phone_number": data["phone_number"].strip(),
        "linked_bhu_id": data["linked_bhu_id"].strip(),
        "current_availability_status": "unverified",
        "points_total": int(data.get("points_total", 0)),
        "reliability_tier": "active",
        "is_verified": False,
        "verified_by": None,
        "verified_at": None,
        "training_completed": bool(data.get("training_completed", False)),
        "training_org": data.get("training_org"),
        "equipment_checklist": data.get("equipment_checklist") or [],
        "created_at": _now_iso(),
        "updated_at": _now_iso(),
    }

    # 1. Write through to PostgreSQL
    try:
        persisted = responder_model.register_responder_db(candidate)
    except Exception as exc:
        _warn(f"DB registration write failed for {responder_id}: {exc}")
        persisted = candidate

    # 2. Sync in-memory slice_runner.SEED_RESPONDERS
    in_mem = next(
        (r for r in slice_runner.SEED_RESPONDERS if r.responder_id == responder_id),
        None,
    )
    if in_mem:
        in_mem.name = candidate["name"]
        in_mem.village = candidate["village"]
        in_mem.linked_bhu_id = candidate["linked_bhu_id"]
        in_mem.phone_number = candidate["phone_number"]
        in_mem.current_availability_status = "unverified"
        in_mem.is_verified = False
        in_mem.verified_by = None
        in_mem.verified_at = None
        in_mem.training_completed = candidate["training_completed"]
        in_mem.training_org = candidate["training_org"]
        in_mem.equipment_checklist = candidate["equipment_checklist"]
    else:
        new_responder = slice_runner.Responder(
            responder_id=candidate["responder_id"],
            name=candidate["name"],
            village=candidate["village"],
            linked_bhu_id=candidate["linked_bhu_id"],
            current_availability_status="unverified",
            points_total=candidate["points_total"],
            phone_number=candidate["phone_number"],
            is_verified=False,
            verified_by=None,
            verified_at=None,
            training_completed=candidate["training_completed"],
            training_org=candidate["training_org"],
            equipment_checklist=candidate["equipment_checklist"],
        )
        slice_runner.SEED_RESPONDERS.append(new_responder)

    _log(f"Candidate registered: {candidate['responder_id']} ({candidate['name']}, {candidate['village']}) -> UNVERIFIED.")
    return persisted


# ===========================================================================
# 2. TRAINER / BHU SIGN-OFF (VERIFICATION)
# ===========================================================================

def signOffResponder(
    responder_id: str,
    verified_by: str,
    equipment_checklist: list,
) -> dict:
    """Authorize and verify a candidate responder.

    Requires:
        - responder_id: must exist in registry
        - verified_by: valid, non-empty identifier (trainer/admin ID, e.g. 'BHU-001-STAFF' or 'PRC-TRAINER-01')
        - equipment_checklist: non-empty list of verified emergency items

    Transitions:
        - is_verified: True
        - current_availability_status: 'available'
        - verified_by: verified_by
        - verified_at: current timestamp
        - equipment_checklist: equipment_checklist

    Raises:
        KeyError: If responder_id is not found.
        ValueError: If verified_by or equipment_checklist is missing or invalid.
    """
    if not verified_by or not str(verified_by).strip():
        raise ValueError("verified_by must be a non-empty string identifier.")

    if not isinstance(equipment_checklist, list) or len(equipment_checklist) == 0:
        raise ValueError("equipment_checklist must be a non-empty list of verified items.")

    # Check existence in DB or memory
    db_record = responder_model.get_responder_from_db(responder_id)
    in_mem = next(
        (r for r in slice_runner.SEED_RESPONDERS if r.responder_id == responder_id),
        None,
    )

    if not db_record and not in_mem:
        raise KeyError(f"Responder '{responder_id}' not found in registry.")

    # 1. Update PostgreSQL
    try:
        updated = responder_model.verify_responder_db(
            responder_id=responder_id,
            verified_by=verified_by.strip(),
            equipment=equipment_checklist,
        )
    except Exception as exc:
        _warn(f"DB verification update failed for {responder_id}: {exc}")
        updated = None

    if not updated:
        now = _now_iso()
        updated = {
            "responder_id": responder_id,
            "name": in_mem.name if in_mem else (db_record.get("name") if db_record else ""),
            "village": in_mem.village if in_mem else (db_record.get("village") if db_record else ""),
            "linked_bhu_id": in_mem.linked_bhu_id if in_mem else (db_record.get("linked_bhu_id") if db_record else ""),
            "phone_number": in_mem.phone_number if in_mem else (db_record.get("phone_number") if db_record else None),
            "current_availability_status": "available",
            "is_verified": True,
            "verified_by": verified_by.strip(),
            "verified_at": now,
            "equipment_checklist": equipment_checklist,
            "training_completed": True,
            "training_org": in_mem.training_org if in_mem else (db_record.get("training_org") if db_record else None),
            "points_total": in_mem.points_total if in_mem else (db_record.get("points_total", 0) if db_record else 0),
            "reliability_tier": "active",
            "updated_at": now,
        }

    # 2. Update in-memory state
    if in_mem:
        in_mem.is_verified = True
        in_mem.verified_by = updated.get("verified_by")
        in_mem.verified_at = updated.get("verified_at")
        in_mem.equipment_checklist = updated.get("equipment_checklist")
        in_mem.training_completed = True
        in_mem.current_availability_status = "available"
    else:
        new_responder = slice_runner.Responder(
            responder_id=updated["responder_id"],
            name=updated.get("name") or "Unknown",
            village=updated.get("village") or "Unknown",
            linked_bhu_id=updated.get("linked_bhu_id") or "BHU-001",
            current_availability_status="available",
            points_total=int(updated.get("points_total", 0)),
            phone_number=updated.get("phone_number"),
            is_verified=True,
            verified_by=updated.get("verified_by"),
            verified_at=updated.get("verified_at"),
            training_completed=True,
            training_org=updated.get("training_org"),
            equipment_checklist=updated.get("equipment_checklist"),
        )
        slice_runner.SEED_RESPONDERS.append(new_responder)

    _log(f"Responder sign-off complete: {responder_id} verified by '{verified_by}' -> AVAILABLE.")
    return updated


# ===========================================================================
# 3. QUERY HELPERS
# ===========================================================================

def listPendingVerifications(village_id: Optional[str] = None) -> List[dict]:
    """List all candidate responders pending verification."""
    try:
        db_rows = responder_model.list_responders_from_db(
            village=village_id,
            is_verified=False,
        )
        if db_rows:
            return db_rows
    except Exception as exc:
        _warn(f"DB pending query failed: {exc}")

    # Fallback to in-memory filter
    results = []
    for r in slice_runner.SEED_RESPONDERS:
        if village_id is not None and r.village != village_id:
            continue
        if not getattr(r, "is_verified", False) or r.current_availability_status == "unverified":
            results.append({
                "responder_id": r.responder_id,
                "name": r.name,
                "village": r.village,
                "linked_bhu_id": r.linked_bhu_id,
                "phone_number": getattr(r, "phone_number", None),
                "current_availability_status": r.current_availability_status,
                "is_verified": getattr(r, "is_verified", False),
                "verified_by": getattr(r, "verified_by", None),
                "verified_at": getattr(r, "verified_at", None),
                "training_completed": getattr(r, "training_completed", False),
                "training_org": getattr(r, "training_org", None),
                "equipment_checklist": getattr(r, "equipment_checklist", None),
                "points_total": getattr(r, "points_total", 0),
            })
    return results


def getResponderProfile(responder_id: str) -> Optional[dict]:
    """Retrieve full responder profile from DB or in-memory state."""
    db_record = responder_model.get_responder_from_db(responder_id)
    if db_record:
        return db_record

    in_mem = next(
        (r for r in slice_runner.SEED_RESPONDERS if r.responder_id == responder_id),
        None,
    )
    if in_mem:
        return {
            "responder_id": in_mem.responder_id,
            "name": in_mem.name,
            "village": in_mem.village,
            "linked_bhu_id": in_mem.linked_bhu_id,
            "phone_number": getattr(in_mem, "phone_number", None),
            "current_availability_status": in_mem.current_availability_status,
            "is_verified": getattr(in_mem, "is_verified", False),
            "verified_by": getattr(in_mem, "verified_by", None),
            "verified_at": getattr(in_mem, "verified_at", None),
            "training_completed": getattr(in_mem, "training_completed", False),
            "training_org": getattr(in_mem, "training_org", None),
            "equipment_checklist": getattr(in_mem, "equipment_checklist", None),
            "points_total": getattr(in_mem, "points_total", 0),
        }
    return None


def clearPendingResponders() -> int:
    """Delete all unverified candidate responders from PostgreSQL and in-memory registry."""
    count = 0
    try:
        count = responder_model.clear_pending_responders_db()
    except Exception as exc:
        _warn(f"DB clear pending failed: {exc}")

    # Remove from in-memory slice_runner.SEED_RESPONDERS
    slice_runner.SEED_RESPONDERS = [
        r for r in slice_runner.SEED_RESPONDERS
        if getattr(r, "is_verified", False) is True
    ]
    _log(f"Cleared {count} pending candidate responders from DB and memory.")
    return count


def deleteCandidateResponder(responder_id: str) -> bool:
    """Delete a single candidate responder from PostgreSQL and in-memory registry."""
    deleted = False
    try:
        deleted = responder_model.delete_responder_db(responder_id)
    except Exception as exc:
        _warn(f"DB delete failed for {responder_id}: {exc}")

    # Remove from in-memory slice_runner.SEED_RESPONDERS
    slice_runner.SEED_RESPONDERS = [
        r for r in slice_runner.SEED_RESPONDERS
        if r.responder_id != responder_id
    ]
    _log(f"Deleted responder {responder_id} from registry.")
    return deleted

