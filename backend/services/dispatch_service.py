# -*- coding: utf-8 -*-
"""Module 3 — Nearest Responder & BHU Matching / Dispatch.

Architectural invariant: this module's CORE LOGIC is intentionally local-first.
decideDispatch() makes ZERO network calls, imports NO AI SDK, and has NO
dependency on Gemini/DashScope/internet. It can run fully offline — which is
the point, given rural Pakistan deployment with unreliable connectivity.

The module is split into two clearly separate concerns:

    decideDispatch(incident)  -> DispatchDecision
        Pure local decision logic. Deterministic. Testable offline.
        Reads only in-memory seed data (SEED_RESPONDERS, SEED_BHUS in
        slice_runner). No network calls, ever.

    sendNotification(decision, incident)
        Delivery layer. Takes the decision object and notifies (currently:
        structured console/log output, consistent with the vertical slice).
        Kept separate so that real push/SMS delivery can be swapped in here
        later without touching decideDispatch's logic at all.

Integration points:
    - handleEscalation(incident_id, escalation_snapshot) is called AFTER
      escalateIncident() (Module 2) returns. It re-dispatches based on the
      upgraded tier, sending only notifications not yet active.
    - handleResponderDecline(incident_id, responder_id) triggers immediate
      fallback without waiting for the ack timeout to expire.

Logging: every event is appended to incident.dispatch_events (same discipline
as Module 2's help_bot_transitions) and printed with a [DISPATCH] prefix
consistent with existing [DISPATCH LOG] / [DISPATCH WARNING] lines in
slice_runner.py.

Known gap (by design): responder-availability-release (what happens when an
incident resolves and a responder becomes available again) is Module 6 scope.
Module 3 marks a responder "busy" on dispatch; Module 6 releases them.
"""
from __future__ import annotations

import os
import threading
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone

from typing import List, Literal, Optional

# ---------------------------------------------------------------------------
# Import path: allow both `import dispatch_service` (from backend/) and
# `from services.dispatch_service import ...` (from project root).
# Same pattern used by help_bot_service.py.
# ---------------------------------------------------------------------------
import sys
from pathlib import Path

_BACKEND_DIR = Path(__file__).resolve().parent.parent
if str(_BACKEND_DIR) not in [str(p) for p in sys.path]:
    sys.path.insert(0, str(_BACKEND_DIR))

import slice_runner  # Module 1: contracts, seed data, INCIDENT_STORE
from geography import coverage_village_id, bhu_id_for_village

# ---------------------------------------------------------------------------
# CONFIGURATION — env-based, consistent with TRIAGE_CALL_TIMEOUT_S pattern
# ---------------------------------------------------------------------------

def _ack_timeout_s() -> int:
    """Seconds a dispatched responder has to acknowledge before the fallback
    walker triggers. Default: 120 s (2 min). Override: DISPATCH_ACK_TIMEOUT_S."""
    return int(os.environ.get("DISPATCH_ACK_TIMEOUT_S", "120"))


# ---------------------------------------------------------------------------
# DISPATCH DECISION — the stable contract between decideDispatch and
# sendNotification. A plain dataclass (not Pydantic) because it lives only
# within a single dispatch call and needs no serialisation.
# ---------------------------------------------------------------------------

@dataclass
class DispatchDecision:
    incident_id: str
    # Full ranked list of available responders (first = primary). Kept so the
    # fallback walker can step through it without re-querying.
    ranked_responders: List[slice_runner.Responder]
    selected_responder: Optional[slice_runner.Responder]
    bhu: Optional[slice_runner.BHU]
    notify_bhu: bool
    bhu_urgency: Optional[Literal["standby", "urgent"]]
    ambulance_requested: bool
    status: Literal["dispatched", "escalated_bhu_only", "no_resources"]
    reasoning: str   # human-readable single-line trace for logs


# ---------------------------------------------------------------------------
# IN-MEMORY DISPATCH STATE — session state for active incidents.
# Keyed by incident_id. Mirrors _ACTIVE_INCIDENTS discipline in Module 2.
# ---------------------------------------------------------------------------

_DISPATCH_STATE: dict = {}
# Lock protects _DISPATCH_STATE against concurrent timer callbacks + main thread.
_STATE_LOCK = threading.Lock()


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _log(msg: str) -> None:
    print(f"  [DISPATCH] {msg}")


def _warn(msg: str) -> None:
    print(f"  [DISPATCH WARN] {msg}")


def _sync_store_snapshot(incident) -> Optional[dict]:
    """Keep the INCIDENT_STORE record (written by Module 1's logIncident)
    reflecting live dispatch state — an inspectable snapshot, not a second
    store. Same discipline as help_bot_service._sync_store_snapshot.

    Returns the synced store record, or None when the incident is not in the
    store (e.g. a detached Incident rebuilt from the DB)."""
    for record in slice_runner.INCIDENT_STORE:
        if record["incident"].get("incident_id") == incident.incident_id:
            record["incident"] = incident.model_dump()
            record["dispatch_synced_at"] = _now_iso()
            return record
    return None


def _db_upsert_incident(incident_id: str, incident) -> None:
    """Write-through to PostgreSQL (non-fatal).

    Mirrors incident_lifecycle_service._db_upsert. The model import is lazy so
    a DB connection problem can never break Module 3 dispatch at import time."""
    try:
        from models.incident_model import upsert_incident_to_db
        record = next(
            (r for r in slice_runner.INCIDENT_STORE
             if r["incident"].get("incident_id") == incident_id), None)
        upsert_incident_to_db(record if record is not None
                              else {"incident": incident.model_dump()})
    except Exception as exc:  # noqa: BLE001 — persistence is best-effort here
        _warn(f"DB write-through for dispatch update failed (non-fatal): {exc}")


def _append_dispatch_event(incident, event: dict) -> None:
    """Append a timestamped event to incident.dispatch_events and sync the
    INCIDENT_STORE snapshot — same discipline as _sync_store_snapshot in
    help_bot_service.py."""
    event.setdefault("timestamp", _now_iso())
    incident.dispatch_events.append(event)
    # Sync INCIDENT_STORE so logIncident dumps carry the full trace.
    _sync_store_snapshot(incident)


def _get_incident(incident_id: str) -> Optional[slice_runner.Incident]:
    """Retrieve a live Incident object from _DISPATCH_STATE or INCIDENT_STORE,
    with database fallback."""
    with _STATE_LOCK:
        state = _DISPATCH_STATE.get(incident_id)
    if state and state.get("incident"):
        return state["incident"]
    record = next(
        (r for r in slice_runner.INCIDENT_STORE
         if r["incident"].get("incident_id") == incident_id), None
    )
    if record:
        return slice_runner.Incident(**record["incident"])
    try:
        from models.incident_model import get_incident_from_db
        db_rec = get_incident_from_db(incident_id)
        if db_rec and db_rec.get("incident"):
            if not any(r["incident"].get("incident_id") == incident_id for r in slice_runner.INCIDENT_STORE):
                slice_runner.INCIDENT_STORE.append(db_rec)
            return slice_runner.Incident(**db_rec["incident"])
    except Exception:
        pass
    return None


# ===========================================================================
# 1. decideDispatch — PURE LOCAL LOGIC (no network, no AI, deterministic)
# ===========================================================================

def decideDispatch(incident: slice_runner.Incident) -> DispatchDecision:
    """Decide who should be notified for this incident.

    Takes an incident with gps_location.village_id and severity_tier.
    Returns a DispatchDecision with the full ranked responder list and
    notification flags. Makes ZERO network calls.

    Matching rules (per spec):
    - Responders are filtered to village_id and availability == "available".
    - Ranking preserves the original SEED_RESPONDERS list order (consistent
      with the tested Farhan Ali fallback scenario in the vertical slice).
    - BHU is looked up via the village's pre-linked BHU (linked_village_ids),
      NOT geo-radius search (explicitly ruled out of scope).
    - Tier drives notification scope:
        minor    -> responder only
        moderate -> responder + BHU standby
        critical -> responder + BHU urgent + ambulance, simultaneously

    No available responder -> escalated_bhu_only (proven vertical slice
    behavior, preserved exactly).
    """
    village_id = incident.gps_location.village_id
    tier = incident.severity_tier
    # Real Tamman-area locality ids are retained on the incident while dispatch
    # uses the current seeded responder coverage group as a compatibility layer.
    coverage_id = coverage_village_id(village_id)

    # --- BHU lookup: prefer the real locality's linked facility, then fall back
    # to the legacy seed association used by the regression suite. ---
    target_bhu_id = bhu_id_for_village(village_id)
    linked_bhu = next(
        (b for b in slice_runner.SEED_BHUS if target_bhu_id and b.bhu_id == target_bhu_id),
        None,
    )
    if linked_bhu is None:
        linked_bhu = next(
            (b for b in slice_runner.SEED_BHUS if coverage_id in b.linked_village_ids),
            None,
        )

    # --- Ranked responder list: village-specific first, then fallback to coverage group ---
    direct_village_responders = [
        r for r in slice_runner.SEED_RESPONDERS
        if r.village == village_id
        and r.current_availability_status == "available"
        and getattr(r, "is_verified", False) is True
    ]
    if direct_village_responders:
        ranked = direct_village_responders
    elif village_id in ("VILLAGE-A", "VILLAGE-B", "VILLAGE-C"):
        ranked = [
            r for r in slice_runner.SEED_RESPONDERS
            if r.village == coverage_id
            and r.current_availability_status == "available"
            and getattr(r, "is_verified", False) is True
        ]
    else:
        ranked = []

    # --- No available responder: escalate to BHU-only ---
    if not ranked:
        bhu_name = linked_bhu.name if linked_bhu else "None"
        return DispatchDecision(
            incident_id=incident.incident_id,
            ranked_responders=[],
            selected_responder=None,
            bhu=linked_bhu,
            notify_bhu=True,
            bhu_urgency="urgent" if tier == "critical" else "standby",
            ambulance_requested=(tier == "critical"),
            status="escalated_bhu_only" if linked_bhu else "no_resources",
            reasoning=(
                f"No available responders in {village_id}. "
                f"Escalated to {bhu_name}. Tier: {tier}."
            ),
        )

    # --- Primary responder selected; ranked list kept for fallback walker ---
    primary = ranked[0]

    # --- Tier-based notification flags (preserved exactly from vertical slice) ---
    if tier == "minor":
        notify_bhu = False
        urgency = None
        ambulance = False
    elif tier == "moderate":
        notify_bhu = True
        urgency = "standby"
        ambulance = False
    else:  # critical
        notify_bhu = True
        urgency = "urgent"
        ambulance = True

    bhu_desc = f"notify {urgency}" if notify_bhu else "no notification"
    reasoning = (
        f"Selected {primary.name} ({primary.responder_id}) from {village_id} "
        f"[{len(ranked)} available, ranked by list position]. "
        f"Tier: {tier}. BHU: {bhu_desc}. Ambulance: {ambulance}."
    )

    return DispatchDecision(
        incident_id=incident.incident_id,
        ranked_responders=ranked,
        selected_responder=primary,
        bhu=linked_bhu,
        notify_bhu=notify_bhu,
        bhu_urgency=urgency,
        ambulance_requested=ambulance,
        status="dispatched",
        reasoning=reasoning,
    )


# ===========================================================================
# 2. sendNotification — DELIVERY LAYER (swappable, currently console/log)
# ===========================================================================

def sendNotification(
    decision: DispatchDecision,
    incident: slice_runner.Incident,
) -> None:
    """Deliver the dispatch decision.

    Currently: structured console/log output consistent with the vertical
    slice's [DISPATCH LOG] / [DISPATCH WARNING] / [DISPATCH ALERT] pattern.

    This function is intentionally kept separate from decideDispatch so that
    real push notification / SMS delivery can be added later as a swap-in
    implementation here, without touching decideDispatch's logic at all.
    This mirrors the Module 1 provider-swap boundary discipline.
    """
    now = _now_iso()
    tier = incident.severity_tier

    # --- Persist dispatch state for fallback walker immediately ---
    with _STATE_LOCK:
        existing = _DISPATCH_STATE.get(incident.incident_id, {})
        _DISPATCH_STATE[incident.incident_id] = {
            "incident": incident,
            "ranked_responders": decision.ranked_responders,
            "fallback_index": existing.get("fallback_index", 0),
            "ack_timer": existing.get("ack_timer"),
            "dispatched_tier": tier,
            "bhu_already_notified": incident.bhu_notified,
            "ambulance_already_requested": incident.ambulance_requested,
        }

    # --- Module 9: Initial "reported" status if not already present ---
    if not any(u.get("stage") == "reported" for u in incident.reporter_updates):
        incident.reporter_updates.append({
            "update_id": f"UPD-{uuid.uuid4().hex[:6].upper()}",
            "timestamp": now,
            "stage": "reported",
            "message_urdu": "آپ کی ایمرجنسی کی اطلاع موصول ہو چکی ہے۔ سسٹم قریبی رضاکار تلاش کر رہا ہے۔",
            "severity_tier": tier,
        })

    # --- Module 8: Coverage gap check (no available responder in village) ---
    if decision.status in ("escalated_bhu_only", "no_resources") or not decision.selected_responder:
        incident.coverage_gap = True
        if not any(e.get("event") == "coverage_gap_flagged" for e in incident.dispatch_events):
            _append_dispatch_event(incident, {
                "event": "coverage_gap_flagged",
                "village_id": incident.gps_location.village_id,
                "timestamp": now,
                "reason": "candidates_exhausted_or_unavailable",
            })

    # --- Responder notification ---
    if decision.selected_responder:
        r = decision.selected_responder
        # Mark busy — same state mutation as dispatch() in slice_runner.
        r.current_availability_status = "busy"
        incident.responder_assigned_id = r.responder_id
        incident.responder_dispatch_timestamp = now
        print(f"  [DISPATCH LOG] Assigned: {r.name} ({r.responder_id}) -> Status set to BUSY.")
        _append_dispatch_event(incident, {
            "event": "responder_dispatched",
            "responder_id": r.responder_id,
            "responder_name": r.name,
            "tier": tier,
        })
        # Module 9: Append responder_notified update
        incident.reporter_updates.append({
            "update_id": f"UPD-{uuid.uuid4().hex[:6].upper()}",
            "timestamp": now,
            "stage": "responder_notified",
            "message_urdu": f"مددگار {r.name} کو اطلاع دے دی گئی ہے۔",
            "severity_tier": tier,
        })
        # Start ack timeout timer BEFORE the DB write-through. The responder's
        # timeout window must be measured from the dispatch decision; a slow
        # PostgreSQL round-trip in front of it delayed arming the timer, which
        # let it fire *after* the responder had already acknowledged and logged
        # a spurious ack_timeout against them.
        _start_ack_timer(incident.incident_id, r.responder_id)
        # Part B persistence fix: write-through to PostgreSQL so availability
        # status survives process restarts. Narrow update — touches ONLY the
        # status column, so Module 5's persisted status_flag (stored in the
        # repurposed reliability_tier column) is never clobbered. Non-fatal.
        try:
            from models.responder_model import update_responder_availability
            update_responder_availability(r.responder_id, "busy")
        except Exception as _exc:
            _warn(f"DB write-through for busy status failed (non-fatal): {_exc}")

    # --- BHU notification ---
    # Note: both "dispatched" (with BHU standby/urgent) and "escalated_bhu_only"
    # set notify_bhu=True. We use decision.status to pick the correct event name.
    if decision.notify_bhu and decision.bhu:
        bhu = decision.bhu
        urgency_label = decision.bhu_urgency or "standby"
        if not incident.bhu_notified:
            incident.bhu_notified = True
            incident.bhu_notify_timestamp = now
        if decision.status in ("escalated_bhu_only", "no_resources"):
            print(f"  [DISPATCH WARNING] No responders available in "
                  f"{incident.gps_location.village_id}. "
                  f"Escalated to {bhu.name}.")
        print(f"  [DISPATCH LOG] {bhu.name} notified "
              f"({'Standby' if urgency_label == 'standby' else 'Urgent'}).")
        event_name = (
            "escalated_bhu_only"
            if decision.status in ("escalated_bhu_only", "no_resources")
            else "bhu_notified"
        )
        event_payload: dict = {
            "event": event_name,
            "bhu_id": bhu.bhu_id,
            "bhu_name": bhu.name,
            "urgency": urgency_label,
            "tier": tier,
        }
        if event_name == "escalated_bhu_only":
            event_payload["reason"] = "no_available_responders"
        _append_dispatch_event(incident, event_payload)

        # Module 9: Localized BHU notification update
        if not any(u.get("stage") in ("bhu_notified", "escalated_bhu_only") for u in incident.reporter_updates):
            if decision.status in ("escalated_bhu_only", "no_resources"):
                bhu_msg = "علاقے میں کوئی رضاکار دستیاب نہیں — براہ راست بنیادی مرکز صحت (BHU) کو ایمرجنسی بھیج دی گئی ہے۔"
                stage_name = "escalated_bhu_only"
            else:
                bhu_msg = (
                    "بنیادی مرکزِ صحت کو فوری ایمرجنسی الرٹ بھیج دیا گیا ہے۔"
                    if urgency_label == "urgent"
                    else "قریبی بنیادی مرکزِ صحت (BHU) کو الرٹ کر دیا گیا ہے۔"
                )
                stage_name = "bhu_notified"

            incident.reporter_updates.append({
                "update_id": f"UPD-{uuid.uuid4().hex[:6].upper()}",
                "timestamp": now,
                "stage": stage_name,
                "message_urdu": bhu_msg,
                "severity_tier": tier,
            })

    elif not decision.notify_bhu and decision.status in ("escalated_bhu_only", "no_resources"):
        # Edge case: escalated but no BHU linked at all.
        _warn(
            f"No responders AND no linked BHU for "
            f"{incident.gps_location.village_id} — incident "
            f"{incident.incident_id} has no resources."
        )
        _append_dispatch_event(incident, {
            "event": "no_resources",
            "village_id": incident.gps_location.village_id,
            "tier": tier,
        })

    # --- Ambulance notification ---
    if decision.ambulance_requested and not incident.ambulance_requested:
        incident.ambulance_requested = True
        print(f"  [DISPATCH ALERT] Ambulance requested immediately "
              f"for {incident.incident_id}.")
        _append_dispatch_event(incident, {
            "event": "ambulance_requested",
            "tier": tier,
        })
        # Module 9: Localized ambulance update
        if not any(u.get("stage") == "ambulance_en_route" for u in incident.reporter_updates):
            incident.reporter_updates.append({
                "update_id": f"UPD-{uuid.uuid4().hex[:6].upper()}",
                "timestamp": now,
                "stage": "ambulance_en_route",
                "message_urdu": "مریض کی نازک حالت کے پیشِ نظر ایمبولینس کو مطلع کر دیا گیا ہے۔",
                "severity_tier": tier,
            })




# ===========================================================================
# 3. ACK TIMEOUT — no-response fallback
# ===========================================================================

def _start_ack_timer(incident_id: str, responder_id: str) -> None:
    """Start the acknowledgment timeout timer for a just-dispatched responder."""
    timeout = _ack_timeout_s()

    def _on_timeout():
        _log(f"Ack timeout ({timeout}s) for responder {responder_id} "
             f"on incident {incident_id}. Triggering fallback.")
        incident = _get_incident(incident_id)
        if incident:
            _append_dispatch_event(incident, {
                "event": "ack_timeout",
                "responder_id": responder_id,
                "timeout_s": timeout,
            })
        _fallback_dispatch(incident_id, reason=f"ack_timeout_{responder_id}")

    timer = threading.Timer(timeout, _on_timeout)
    timer.daemon = True   # don't block process exit during tests
    timer.start()
    with _STATE_LOCK:
        state = _DISPATCH_STATE.get(incident_id, {})
        old = state.get("ack_timer")
        if old is not None:
            old.cancel()
        state["ack_timer"] = timer
        _DISPATCH_STATE[incident_id] = state


def acknowledgeDispatch(incident_id: str, responder_id: str) -> None:
    """Responder confirms they are responding. Cancels the ack timeout."""
    with _STATE_LOCK:
        state = _DISPATCH_STATE.get(incident_id)
        if not state:
            _warn(f"acknowledgeDispatch: no active state for {incident_id}")
            return
        timer = state.get("ack_timer")
        if timer:
            timer.cancel()
            state["ack_timer"] = None
    incident = _get_incident(incident_id)
    if incident:
        _append_dispatch_event(incident, {
            "event": "responder_acknowledged",
            "responder_id": responder_id,
        })
        # Module 9: responder_en_route update
        responder_name = "رضاکار"
        for r in slice_runner.SEED_RESPONDERS:
            if r.responder_id == responder_id:
                responder_name = r.name
                break
        incident.reporter_updates.append({
            "update_id": f"UPD-{uuid.uuid4().hex[:6].upper()}",
            "timestamp": _now_iso(),
            "stage": "responder_en_route",
            "message_urdu": f"مددگار {responder_name} نے الرٹ قبول کر لیا ہے اور وہ جائے وقوعہ کی طرف روانہ ہیں۔",
            "severity_tier": incident.severity_tier,
        })
        # Ordering fix: _append_dispatch_event above synced the snapshot BEFORE
        # this reporter_update existed, so the acknowledgment never reached
        # INCIDENT_STORE or PostgreSQL — GET /incident/{id}/timeline kept
        # serving the pre-ack state and the reporter's feed never showed the
        # responder accepting. Re-sync and write through, mirroring
        # record_responder_arrival.
        _sync_store_snapshot(incident)
        _db_upsert_incident(incident_id, incident)
    _log(f"Responder {responder_id} acknowledged dispatch for {incident_id}.")


# ===========================================================================
# 4. FALLBACK WALKER — walks ranked_responders on timeout or decline
# ===========================================================================

def _fallback_dispatch(incident_id: str, reason: str = "unknown") -> None:
    """Step to the next ranked responder. If the list is exhausted, escalate
    to BHU-only — same outcome as 'no available responder' from the start."""
    with _STATE_LOCK:
        state = _DISPATCH_STATE.get(incident_id)
        if not state:
            _warn(f"_fallback_dispatch: no state for {incident_id}")
            return
        old_timer = state.get("ack_timer")
        if old_timer:
            old_timer.cancel()
            state["ack_timer"] = None
        state["fallback_index"] = state.get("fallback_index", 0) + 1
        idx = state["fallback_index"]
        ranked = state.get("ranked_responders", [])

    incident = state.get("incident") or _get_incident(incident_id)
    if incident is None:
        _warn(f"_fallback_dispatch: cannot find incident {incident_id}")
        return

    incident.dispatch_fallback_count += 1
    _log(f"Fallback triggered for {incident_id} "
         f"(reason={reason}, fallback_count={incident.dispatch_fallback_count}).")
    _append_dispatch_event(incident, {
        "event": "fallback_triggered",
        "reason": reason,
        "fallback_index": idx,
        "fallback_count": incident.dispatch_fallback_count,
    })

    if idx < len(ranked):
        next_responder = ranked[idx]
        _log(f"Falling through to {next_responder.name} ({next_responder.responder_id}).")
        print(f"  [DISPATCH LOG] Fallback: dispatching {next_responder.name} "
              f"({next_responder.responder_id}) (rank {idx + 1}/{len(ranked)}).")
        # Build a minimal decision for the new responder only (BHU/ambulance
        # already notified in the original dispatch — no duplicates).
        next_decision = DispatchDecision(
            incident_id=incident_id,
            ranked_responders=ranked,
            selected_responder=next_responder,
            bhu=None,
            notify_bhu=False,
            bhu_urgency=None,
            ambulance_requested=False,
            status="dispatched",
            reasoning=f"Fallback rank {idx + 1}: {next_responder.name}",
        )
        with _STATE_LOCK:
            _DISPATCH_STATE[incident_id]["fallback_index"] = idx
        sendNotification(next_decision, incident)
    else:
        # Ranked list exhausted — BHU-only escalation.
        incident.coverage_gap = True
        if not any(e.get("event") == "coverage_gap_flagged" for e in incident.dispatch_events):
            _append_dispatch_event(incident, {
                "event": "coverage_gap_flagged",
                "village_id": incident.gps_location.village_id,
                "timestamp": _now_iso(),
                "reason": "candidates_exhausted_or_unavailable",
            })
        _log(f"Ranked list exhausted for {incident_id}. Escalating to BHU-only.")
        print(f"  [DISPATCH WARNING] All ranked responders exhausted for "
              f"{incident_id}. Escalating to BHU-only.")
        _append_dispatch_event(incident, {
            "event": "all_responders_exhausted",
            "fallback_count": incident.dispatch_fallback_count,
        })
        village_id = incident.gps_location.village_id
        bhu = next(
            (b for b in slice_runner.SEED_BHUS if village_id in b.linked_village_ids),
            None
        )
        if bhu and not incident.bhu_notified:
            tier = incident.severity_tier
            urgency = "urgent" if tier == "critical" else "standby"
            incident.bhu_notified = True
            incident.bhu_notify_timestamp = _now_iso()
            print(f"  [DISPATCH WARNING] No responders available in {village_id}. "
                  f"Escalated to {bhu.name}.")
            print(f"  [DISPATCH LOG] {bhu.name} notified "
                  f"({'Standby' if urgency == 'standby' else 'Urgent'}).")
            _append_dispatch_event(incident, {
                "event": "escalated_bhu_only",
                "bhu_id": bhu.bhu_id,
                "bhu_name": bhu.name,
                "urgency": urgency,
                "reason": "ranked_list_exhausted",
            })
        elif incident.bhu_notified:
            _log(f"BHU already notified for {incident_id}; no duplicate.")


# ===========================================================================
# 5. EXPLICIT RESPONDER DECLINE
# ===========================================================================

def handleResponderDecline(incident_id: str, responder_id: str) -> None:
    """Responder explicitly declines / reports unavailable.
    Triggers immediate fallback — no waiting for the ack timeout to expire."""
    _log(f"Explicit decline from {responder_id} for {incident_id}.")
    with _STATE_LOCK:
        state = _DISPATCH_STATE.get(incident_id)
        if not state:
            _warn(f"handleResponderDecline: no active state for {incident_id}")
            return
        timer = state.get("ack_timer")
        if timer:
            timer.cancel()
            state["ack_timer"] = None

    incident = _get_incident(incident_id)
    if incident:
        # Return the declining responder to available (they are refusing the job).
        for r in slice_runner.SEED_RESPONDERS:
            if r.responder_id == responder_id:
                r.current_availability_status = "available"
                # Part B persistence fix: narrow write-through to PostgreSQL
                # (status column only — preserves Module 5's status_flag).
                try:
                    from models.responder_model import update_responder_availability
                    update_responder_availability(r.responder_id, "available")
                except Exception as _exc:
                    _warn(f"DB write-through for available status failed (non-fatal): {_exc}")
                break
        print(f"  [DISPATCH LOG] {responder_id} declined incident {incident_id}. "
              f"Triggering immediate fallback.")
        _append_dispatch_event(incident, {
            "event": "responder_declined",
            "responder_id": responder_id,
        })
    _fallback_dispatch(incident_id, reason=f"explicit_decline_{responder_id}")


# ===========================================================================
# 6. ESCALATION RE-DISPATCH — Module 2 integration point
# ===========================================================================

def handleEscalation(incident_id: str, escalation_snapshot: dict) -> None:
    """Called AFTER escalateIncident() (Module 2) returns to trigger any
    additional dispatch actions driven by the upgraded severity tier.

    Wiring contract (documented in help_bot_service.py's escalateIncident
    docstring): Module 3 is wired by CALLING escalateIncident() first (Module 2,
    unchanged), then calling this function with the snapshot it returns.
    This avoids any import cycle between help_bot_service <-> dispatch_service.

    What this function does:
    - Reconstructs the updated Incident from the escalation snapshot.
    - Diffs against _DISPATCH_STATE to find what NEW notifications are needed
      (e.g., BHU wasn't notified because tier was minor; now it's critical
      -> send BHU urgent + ambulance request).
    - Calls sendNotification only for the DELTA (no duplicates).
    - Appends the re-dispatch event to incident.dispatch_events.
    """
    updated = slice_runner.Incident(**escalation_snapshot)

    with _STATE_LOCK:
        state = _DISPATCH_STATE.get(incident_id, {})
        bhu_already_notified = state.get("bhu_already_notified", False)
        ambulance_already = state.get("ambulance_already_requested", False)
        incident_in_state = state.get("incident")

    # Use the live object if available (it carries the full transition log).
    if incident_in_state is not None:
        incident_in_state.severity_tier = updated.severity_tier
        incident_in_state.injury_type_flags = updated.injury_type_flags
        incident_in_state.bhu_notified = updated.bhu_notified
        incident_in_state.bhu_notify_timestamp = updated.bhu_notify_timestamp
        incident_in_state.ambulance_requested = updated.ambulance_requested
        incident = incident_in_state
    else:
        incident = updated

    new_tier = incident.severity_tier
    incident.mid_incident_escalated = True

    _log(f"Escalation re-dispatch for {incident_id}: tier={new_tier} | "
         f"bhu_was_notified={bhu_already_notified} | "
         f"ambulance_was_requested={ambulance_already}")

    _append_dispatch_event(incident, {
        "event": "escalation_redispatch_triggered",
        "new_tier": new_tier,
        "bhu_already_notified": bhu_already_notified,
        "ambulance_already_requested": ambulance_already,
    })

    # Module 8 & 9 telemetry: log mid_incident_escalation audit event if not present
    trigger_phrase = (
        escalation_snapshot.get("trigger_phrase")
        or escalation_snapshot.get("trigger")
        or (escalation_snapshot.get("detail", {}).get("trigger") if isinstance(escalation_snapshot.get("detail"), dict) else None)
        or "condition_worsened"
    )
    if not any(e.get("event") == "mid_incident_escalation" for e in incident.dispatch_events):
        _append_dispatch_event(incident, {
            "event": "mid_incident_escalation",
            "trigger_line": trigger_phrase,
            "upgraded_tier": new_tier,
            "ambulance_requested": incident.ambulance_requested,
            "timestamp": _now_iso(),
        })

    # Find the linked BHU for this incident.
    village_id = incident.gps_location.village_id
    bhu = next(
        (b for b in slice_runner.SEED_BHUS if village_id in b.linked_village_ids),
        None
    )

    # Determine what NEW notifications are required by the upgraded tier.
    need_bhu = False
    need_ambulance = False
    new_urgency: Optional[Literal["standby", "urgent"]] = None

    if new_tier in ("moderate", "critical") and not bhu_already_notified:
        need_bhu = True
        new_urgency = "urgent" if new_tier == "critical" else "standby"
    elif new_tier == "critical" and bhu_already_notified:
        # BHU was notified as standby; upgrade urgency.
        need_bhu = True
        new_urgency = "urgent"

    if new_tier == "critical" and not ambulance_already:
        need_ambulance = True

    if not need_bhu and not need_ambulance:
        _log(f"No new notifications needed for escalation of {incident_id} "
             f"(all already active).")
        return

    _log(f"Sending escalation delta: "
         f"bhu={need_bhu}({new_urgency}) ambulance={need_ambulance}")

    if need_bhu and bhu:
        urgency_label = new_urgency or "standby"
        if not incident.bhu_notified:
            incident.bhu_notified = True
            incident.bhu_notify_timestamp = _now_iso()
        print(f"  [DISPATCH LOG] ESCALATION: {bhu.name} notified "
              f"({'Standby' if urgency_label == 'standby' else 'Urgent'}) "
              f"[upgraded tier={new_tier}].")
        _append_dispatch_event(incident, {
            "event": "bhu_notified_escalation",
            "bhu_id": bhu.bhu_id,
            "bhu_name": bhu.name,
            "urgency": urgency_label,
            "new_tier": new_tier,
        })

    if need_ambulance:
        incident.ambulance_requested = True
        print(f"  [DISPATCH ALERT] ESCALATION: Ambulance requested for "
              f"{incident_id} (tier upgraded to critical).")
        _append_dispatch_event(incident, {
            "event": "ambulance_requested_escalation",
            "new_tier": new_tier,
        })
        # Module 9: Localized ambulance update on escalation
        if not any(u.get("stage") == "ambulance_en_route" for u in incident.reporter_updates):
            incident.reporter_updates.append({
                "update_id": f"UPD-{uuid.uuid4().hex[:6].upper()}",
                "timestamp": _now_iso(),
                "stage": "ambulance_en_route",
                "message_urdu": "مریض کی نازک حالت کے پیشِ نظر ایمبولینس کو مطلع کر دیا گیا ہے۔",
                "severity_tier": new_tier,
            })


    # Update _DISPATCH_STATE so future escalations diff correctly.
    with _STATE_LOCK:
        state = _DISPATCH_STATE.get(incident_id, {})
        state["bhu_already_notified"] = incident.bhu_notified
        state["ambulance_already_requested"] = incident.ambulance_requested
        state["dispatched_tier"] = new_tier
        state["incident"] = incident
        _DISPATCH_STATE[incident_id] = state


# ===========================================================================
# 7. CONVENIENCE ENTRY POINT — full dispatch pipeline for a new incident
# ===========================================================================

def dispatchIncident(incident: slice_runner.Incident) -> DispatchDecision:
    """Full Module 3 pipeline for a freshly registered incident:
        decideDispatch -> sendNotification.

    Replaces the old matchResponderAndBHU + dispatch pair for new code. The
    old functions are preserved in slice_runner.py for backward compatibility
    with the existing run_test_suite.

    Returns the DispatchDecision so callers can inspect it.
    """
    decision = decideDispatch(incident)
    _log(f"Decision for {incident.incident_id}: {decision.reasoning}")
    sendNotification(decision, incident)
    return decision
