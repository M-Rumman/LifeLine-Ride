"""End-to-end walk of the 12-step demo script against the LIVE backend.

Issues the exact same HTTP calls the cockpit UI makes (same verbs, same
payload shapes, same form-encoding for /emergency/report) and asserts the
observable state each demo step depends on. Temporary verification harness —
not part of the shipped test suite.
"""
import sys
import time
import urllib.parse

import requests

try:  # Urdu names/messages in the payload must survive a cp1252 console.
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:  # noqa: BLE001
    pass

BASE = "http://localhost:5050"
V1 = f"{BASE}/api/v1"

PHOTO = "D:\\LifeLine Ride\\mockdata\\media\\photos\\PhotoshopExtension_Image (1).png"
VOICE = "D:\\LifeLine Ride\\mockdata\\media\\voice\\ungli.mp3"

FAILURES = []


def check(label, ok, detail=""):
    mark = "PASS" if ok else "FAIL"
    print(f"[{mark}] {label}" + (f"  ->  {detail}" if detail else ""))
    if not ok:
        FAILURES.append(f"{label} :: {detail}")


def step(n, title):
    print(f"\n--- STEP {n}: {title} ---")


# ---------------------------------------------------------------- 1. health
step(1, "status bar green (backend + DB + AI provider)")
h = requests.get(f"{BASE}/health", timeout=10).json()
check("backend /health 200 + status ok", h.get("status") == "ok", str(h.get("status")))
check("db_reachable true", h.get("db_reachable") is True, str(h.get("db_reachable")))
check("ai_provider exposed", bool(h.get("ai_provider")), str(h.get("ai_provider")))
check("responders_loaded > 0", (h.get("responders_loaded") or 0) > 0,
      str(h.get("responders_loaded")))

# ------------------------------------------------------- 2. roster baseline
step(2, "GET /responders — roster + unique villages (View 1 dropdown, View 2 roster)")
r0 = requests.get(f"{V1}/responders", timeout=10).json()
responders = r0.get("responders", r0 if isinstance(r0, list) else [])
villages = sorted({r.get("village") for r in responders if r.get("village")})
check("roster non-empty", len(responders) > 0, f"count={len(responders)}")
check("unique villages derived", len(villages) > 0, str(villages))
for r in responders:
    print(f"    {r.get('responder_id')}  {r.get('name'):<22} "
          f"{r.get('village'):<12} {r.get('current_availability_status')}")

# ------------------------------------------------------------ 3. report
step(3, "POST /emergency/report — Quick Demo fixture (cached triage, zero quota)")
t0 = time.time()
form = urllib.parse.urlencode({
    "latitude": "31.5204",
    "longitude": "74.3587",
    "village_id": "VILLAGE-A",
    "reporter_id": "REP-USER-001",
    "photo_ref": PHOTO,
    "voice_ref": VOICE,
})
resp = requests.post(f"{V1}/emergency/report", data=form,
                     headers={"Content-Type": "application/x-www-form-urlencoded"},
                     timeout=60)
elapsed = time.time() - t0
check("report accepted", resp.status_code in (200, 201),
      f"status={resp.status_code} body={resp.text[:300]}")
body = resp.json()
inc = body.get("incident", {})
incident_id = inc.get("incident_id")
triage = inc.get("triage_result") or inc
tier = triage.get("severity_tier") or inc.get("severity_tier")
flags = triage.get("injury_type_flags") or inc.get("injury_type_flags") or []
transcript = (triage.get("voice_transcript") or inc.get("voice_transcript")
              or triage.get("transcript_urdu") or "")
print(f"    incident_id={incident_id}  elapsed={elapsed:.1f}s")
check("incident_id returned", bool(incident_id), str(incident_id))
check("triage under 10s (cache hit)", elapsed < 10.0, f"{elapsed:.1f}s")
check("severity_tier == critical", tier == "critical", str(tier))
check("injury flags present", len(flags) > 0, str(flags))
check("Urdu transcript present", bool(str(transcript).strip()), str(transcript)[:80])

assigned = (body.get("dispatch", {}).get("responder", {}) or {}).get("responder_id")
print(f"    assigned_responder={assigned}")

# ------------------------------------------------- 4. responder flips busy
step(4, "View 2 — assigned responder flips available -> busy")
time.sleep(1.0)
r1 = requests.get(f"{V1}/responders", timeout=10).json()
resp1 = r1.get("responders", [])
me = next((r for r in resp1 if r.get("responder_id") == assigned), None)
check("assigned responder now busy",
      bool(me) and me.get("current_availability_status") == "busy",
      str(me.get("current_availability_status") if me else "not found"))

# ------------------------------------------------------------- 5. accept
step(5, "POST /responder/respond accept -> timeline shows dispatched -> acked")
acc = requests.post(f"{V1}/responder/respond", json={
    "incident_id": incident_id, "responder_id": assigned, "action": "accept",
}, timeout=30)
check("accept 200", acc.status_code == 200,
      f"status={acc.status_code} body={acc.text[:300]}")

tl = requests.get(f"{V1}/emergency/incident/{incident_id}/timeline", timeout=10).json()
stages = [u.get("stage") for u in tl.get("updates", [])]
print(f"    timeline.status={tl.get('status')}  stages={stages}")
check("THE FIX: 'responder_en_route' (acked) reaches the timeline",
      "responder_en_route" in stages, str(stages))
check("timeline status advanced dispatched -> acknowledged",
      tl.get("status") == "acknowledged", str(tl.get("status")))

full = requests.get(f"{V1}/emergency/incident/{incident_id}", timeout=10).json()
events = [e.get("event") for e in
          (full.get("incident", {}).get("dispatch_events") or [])]
check("dispatch_events carries responder_acknowledged",
      "responder_acknowledged" in events, str(events))

# ------------------------------------------ 6/7. View 3 dispatch details
step(6, "View 3 — BHU notified (urgent) + ambulance requested + map pin")
incd = full.get("incident", {})
dispatch = body.get("dispatch", {})
check("BHU notified", bool(incd.get("bhu_notified")), str(incd.get("bhu_notified")))
# bhu_urgency only exists on the report response, exactly as the UI reads it.
print(f"    bhu_urgency={dispatch.get('bhu_urgency')}  "
      f"bhu={(dispatch.get('bhu') or {}).get('name')}")
check("BHU urgency == urgent (tier 3)", dispatch.get("bhu_urgency") == "urgent",
      str(dispatch.get("bhu_urgency")))
check("ambulance requested (tier 3)", bool(incd.get("ambulance_requested")),
      str(incd.get("ambulance_requested")))
gps = incd.get("gps_location") or {}
check("incident GPS present for map pin",
      bool(gps.get("latitude")) and bool(gps.get("longitude")), str(gps))
check("ambulance_en_route in timeline", "ambulance_en_route" in stages, str(stages))
check("bhu_notified in timeline", "bhu_notified" in stages, str(stages))

# ---------------------------------------------------------- 8. arrived
step(8, "POST /responder/arrived -> timeline updates again")
arr = requests.post(f"{V1}/responder/arrived", json={
    "incident_id": incident_id, "responder_id": assigned,
}, timeout=30)
check("arrived 200", arr.status_code == 200,
      f"status={arr.status_code} body={arr.text[:300]}")
tl2 = requests.get(f"{V1}/emergency/incident/{incident_id}/timeline", timeout=10).json()
stages2 = [u.get("stage") for u in tl2.get("updates", [])]
check("'responder_arrived' in timeline", "responder_arrived" in stages2, str(stages2))
check("timeline status advanced -> arrived", tl2.get("status") == "arrived",
      str(tl2.get("status")))

# --------------------------------------------------- 9. help-bot escalation
step(9, 'POST /helpbot/step "khoon band nahi ho raha" -> escalation')
bot = requests.post(f"{V1}/helpbot/step", json={
    "incident_id": incident_id,
    "responder_transcript": "khoon band nahi ho raha",
}, timeout=90)
check("helpbot step 200", bot.status_code == 200,
      f"status={bot.status_code} body={bot.text[:300]}")
if bot.status_code == 200:
    b = bot.json()
    print(f"    branch={b.get('branch_id')}  intent={b.get('intent') or b.get('classified_intent')}")
    spoken = str(b.get("spoken_text_urdu") or "")
    print(f"    escalated={b.get('escalated')}  signal={b.get('escalation_signal')}")
    print(f"    spoken_text_urdu={spoken[:110]}")
    check("branch reported", bool(b.get("branch_id")), str(b.get("branch_id")))
    check("intent classification reported",
          bool(b.get("intent") or b.get("classified_intent")),
          str(b.get("intent") or b.get("classified_intent")))
    check("Urdu guidance line returned (View 2 renders spoken_text_urdu)",
          bool(spoken.strip()), spoken[:60])
    check("ESCALATION fired", bool(b.get("escalated")) or bool(b.get("escalation")),
          str(b.get("escalated")))

time.sleep(1.0)
tl3 = requests.get(f"{V1}/emergency/incident/{incident_id}/timeline", timeout=10).json()
stages3 = [u.get("stage") for u in tl3.get("updates", [])]
print(f"    post-escalation stages={stages3}")
check("escalation visible to reporter timeline",
      tl3.get("mid_incident_escalated") is True
      or any("escalat" in str(s) for s in stages3),
      f"mid_incident_escalated={tl3.get('mid_incident_escalated')} stages={stages3}")

# ------------------------------------------------------------- 10. close
step(10, "POST close outcome=taken_to_bhu confirmed_by=bhu_staff")
cl = requests.post(f"{V1}/emergency/incident/{incident_id}/close", json={
    "outcome": "taken_to_bhu", "confirmed_by": "bhu_staff",
}, timeout=30)
check("close 200", cl.status_code == 200,
      f"status={cl.status_code} body={cl.text[:300]}")
tl4 = requests.get(f"{V1}/emergency/incident/{incident_id}/timeline", timeout=10).json()
stages4 = [u.get("stage") for u in tl4.get("updates", [])]
check("timeline status == closed", tl4.get("status") == "closed", str(tl4.get("status")))
check("'closed' update in timeline", "closed" in stages4, str(stages4))

# ------------------------------------------------------- 11. performance
step(11, "GET /accountability/responder/{id}/performance after closure")
perf = requests.get(f"{V1}/accountability/responder/{assigned}/performance",
                    timeout=30).json()
print(f"    incidents_responded_to={perf.get('incidents_responded_to')} "
      f"avg_response_s={perf.get('average_response_time_seconds')} "
      f"status_flag={perf.get('status_flag')}")
check("incidents_responded_to >= 1",
      (perf.get("incidents_responded_to") or 0) >= 1,
      str(perf.get("incidents_responded_to")))
check("status_flag reported", bool(perf.get("status_flag")), str(perf.get("status_flag")))
check("average_response_time_seconds present",
      perf.get("average_response_time_seconds") is not None,
      str(perf.get("average_response_time_seconds")))

# -------------------------------------------- 12. responder flips to green
step(12, "View 2 — responder flips busy -> available")
time.sleep(1.0)
r2 = requests.get(f"{V1}/responders", timeout=10).json()
me2 = next((r for r in r2.get("responders", [])
            if r.get("responder_id") == assigned), None)
check("responder released back to available",
      bool(me2) and me2.get("current_availability_status") == "available",
      str(me2.get("current_availability_status") if me2 else "not found"))

# --------------------------------------------------------------- summary
print("\n" + "=" * 72)
if FAILURES:
    print(f"  {len(FAILURES)} CHECK(S) FAILED")
    for f in FAILURES:
        print(f"    - {f}")
    sys.exit(1)
print("  ALL DEMO-SCRIPT API CHECKS PASSED")
print("=" * 72)
