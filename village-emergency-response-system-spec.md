# Village Emergency Response Network — Full Project Spec

**Context:** AI-powered community first-responder system for rural Pakistan. A concerned person reports an emergency (patient photo + Urdu voice description); AI triages severity and simultaneously dispatches a trained village responder and, if needed, the nearest government BHU (Basic Health Unit). Responders are non-professional but trained in first aid, guided in real time by an AI assistant, tracked via a points-based accountability system, and linked to their village's associated BHU.

**Default language:** Urdu (UI, voice input/output, and AI responses all Urdu-first).

**Target platform:** Mobile app (two user roles: Reporter/Family, Responder) + lightweight admin/BHU dashboard.

---

## Module 1 — Emergency Registration & AI Triage

**Purpose:** Let a family member or bystander report an emergency in under 30 seconds, using only a photo of the visible injury and a spoken description — no forms, no typing.

**Input:**
- One or more photos of the patient's **visible injury** (wound, burn, swelling, bleeding, visible trauma) — not scene photos.
- One voice recording in Urdu describing what happened and the patient's condition.
- Auto-captured GPS location of the reporter's device.
- Reporter's phone number (auto-filled from device/account).

**Processing pipeline (two models feeding one triage decision — do not try to do this in a single model call):**
1. **Speech-to-text (Urdu):** Transcribe the voice note. Must handle regional accents reasonably; if using a general-purpose STT model, test it against Urdu spoken with Punjabi/Pashto/Seraiki inflection since that's the real deployment context.
2. **Vision model:** Classify the visible injury type and apparent severity from the photo (e.g., laceration, burn, fracture indicator, heavy bleeding, unclear/none).
3. **Triage classifier:** Combine the transcript + vision output into a **severity tier**:
   - **Tier 1 — Minor:** dispatch responder only.
   - **Tier 2 — Moderate:** dispatch responder + notify BHU (BHU placed on standby, not yet moving).
   - **Tier 3 — Critical:** dispatch responder + BHU + ambulance simultaneously, no delay.
   - This tiering must be an explicit, inspectable output (not buried logic) — store the tier and the reasoning/flags that produced it on the incident record, both for the dispatch logic in Module 3 and for the outcome analytics in Module 6.

**Output of this module:**
- A structured incident object: `{incident_id, timestamp, reporter_id, gps_location, photo(s), voice_transcript, severity_tier, injury_type_flags}`.
- This object is handed to Module 3 (matching/dispatch) immediately on creation.

**Failure handling:**
- If the photo is unclear or the voice note is inaudible/too short, do not block dispatch — default to **Tier 2** (safer default) and flag the incident as "low-confidence triage" for later review, rather than asking the reporter to retry (they are in an emergency, not a support chat).

---

## Module 2 — Responder AI Help Bot (Hardcoded Reactive Flow)

**Purpose:** Give the on-scene responder (trained in first aid, but not a paramedic) real-time guidance, including for situations outside standard training — via voice, since their hands are occupied.

**Design decision (confirmed):** This is a **hardcoded reactive flow**, not a freeform conversational AI. Build it as a decision-tree / state-machine script keyed to the incident's injury type and severity tier from Module 1, with specific branch points for common complications. Example shape:

```
State: bleeding_wound
  -> Standard instructions (pressure, elevation, clean cloth)
  -> Responder voice input: "bleeding not stopping"
      -> Branch: escalate instructions (tourniquet guidance if applicable, or
         explicit "this needs the ambulance now" alert routed to Module 3/8)
  -> Responder voice input: "patient losing consciousness"
      -> Branch: switch to consciousness/shock protocol, auto-flag incident
         severity as upgraded to Tier 3, notify BHU/ambulance if not already en route
```

**Requirements:**
- Voice in, voice out, Urdu, hands-free (no screen interaction required mid-task).
- A **fixed, pre-validated set of branch triggers** per injury type (bleeding, burns, fracture, choking, snakebite, cardiac symptoms, unconsciousness) — write these branches out explicitly and have them reviewed by the "professionals" doing the training, since this is medical-adjacent content and accuracy matters more than coverage breadth.
- Any branch that indicates the situation has escalated **must automatically notify Module 8 (Escalation Logic)** to re-trigger dispatch — this bot is not just advisory, it's a sensor for "this got worse."
- Log every state transition to the incident record (Module 6) — this becomes useful both for training-quality feedback and for Module 5 accountability review if something goes wrong.

**Hackathon scope note:** For the demo, 2–3 fully built-out branches (e.g., bleeding, burns, unconsciousness) is enough to prove the concept — don't try to cover all first-aid categories before the deadline.

---

## Module 3 — Nearest Responder & BHU Matching

**Purpose:** On incident creation, identify and dispatch the correct responder(s) and BHU based on location, availability, and severity tier.

**Logic:**
1. Look up the incident's GPS location against the responder database (Module 5) to find the **nearest available** (not just nearest) trained responder.
   - "Available" means: currently marked active/on-duty, not already assigned to another open incident.
   - If the nearest responder is unavailable, fall through to the next-nearest — this must be a ranked list, not a single lookup.
2. Simultaneously (per Module 1's severity tier):
   - Tier 1: notify responder only.
   - Tier 2: notify responder + place linked BHU on standby notification.
   - Tier 3: notify responder + BHU + trigger ambulance dispatch request, all at once — no sequential waiting.
3. Each village's responder group is pre-associated with one nearby BHU (set during Module 5/7 registration) — use that fixed mapping as the default BHU target, don't re-search for "nearest BHU" independently, since the pre-linked relationship is intentional (established local relationships/coverage areas).
4. If no responder in the entire network responds within the timeout window, this hands off to **Module 8 (Escalation Logic)**.

**Output:** Dispatch record `{incident_id, responder_assigned, dispatch_timestamp, bhu_notified, bhu_notify_timestamp, ambulance_requested (bool)}`.

---

## Module 4 — Language Default

- **Urdu is the default language** across: app UI, voice prompts/responses (Modules 1 STT and 2 TTS), and any system-generated notifications (Module 9).
- Treat this as a global config flag, not a per-module decision, so future language additions (regional languages, English for admin/BHU dashboard users) don't require touching every module individually.
- The BHU/admin dashboard (Module 5/6 facing side) can reasonably default to Urdu or English depending on typical BHU staff literacy — confirm with domain contacts, but this is a lower priority than the responder/reporter-facing Urdu requirement.

---

## Module 5 — Responder & BHU Database (Accountability & Points)

**Purpose:** Central registry of trained responders and BHUs, with a points-based performance record for accountability.

**Core entities:**
- **Responder record:** `{responder_id, name, village, linked_bhu_id, phone, registration_date, trained_by (professional/org reference), equipment_checklist_status, current_availability_status, points_total, active_status (active/suspended)}`
- **BHU record:** `{bhu_id, name, union_council, location, linked_village_ids[], contact_info, capacity_notes}`
- **Village → Responder group → BHU mapping:** each village has one or more responders, all linked to a single nearby BHU (set at registration, Module 7).

**Points/accountability logic:**
- Points are earned per **verified** completed incident response (verification detail lives in Module 6 — points should be awarded from confirmed outcome records, not self-reported completion, to avoid gaming).
- Points feed two things: (1) a performance/accountability score visible to admins, and (2) the basis for the payment mechanism (per-point or per-verified-response payout — exact payment integration can be a "designed, not built" item for the hackathon demo).
- Track a simple history, not just a running total — you need "points earned this month" and "total incidents responded to" for the accountability view to be meaningful, not just a single number.

**Why this is separate from Module 6:** this database is the *registry of who exists and their standing*; Module 6 is the *log of what happened*. Points here are a derived/aggregated field computed from Module 6's incident records.

---

## Module 6 — Incident & Outcome Tracking

**Purpose:** Log every emergency from report to resolution — this is what makes Module 5's points meaningful and gives you real impact data.

**Incident record (extends Module 1's object through the full lifecycle):**
```
{
  incident_id, timestamp_reported, reporter_id, gps_location,
  severity_tier, injury_type_flags,
  responder_assigned_id, responder_dispatch_timestamp, responder_arrival_timestamp,
  bhu_notified (bool), bhu_notify_timestamp, bhu_response_timestamp,
  ambulance_requested (bool), ambulance_arrival_timestamp,
  help_bot_transitions[] (from Module 2, for review/training feedback),
  outcome: [self-resolved | taken_to_bhu | referred_to_hospital | unresolved],
  outcome_confirmed_by: [responder | bhu_staff],
  incident_closed_timestamp
}
```

**Why outcome confirmation matters:** to keep the points system (Module 5) honest, an incident should only count toward a responder's points once its outcome is confirmed — ideally by the BHU side (they receive the patient or the standby notification) rather than purely self-reported by the responder. This is your fraud-prevention story for judges.

**What this feeds:**
- Module 5 points calculation.
- Response-time analytics (report → responder arrival, report → BHU response) — this is strong "impact evidence" material for your pitch and demo dashboard.
- Coverage gap analysis (which villages have slow response times / no available responder) — useful for Alkhidmat's actual planning use case, worth mentioning even if not fully built.

---

## Module 7 — Responder Onboarding & Verification

**Purpose:** Define how a trained villager actually enters the system, since trust and accountability start here, not just at response time.

**Flow:**
1. Responder completes first-aid training delivered by a professional/partner org (per your existing plan).
2. The training professional/org **signs off** on the responder in-app or via an admin action — this is the verification gate, not self-registration.
3. Responder registration captures: identity info, village, phone, equipment checklist (confirms they have the necessary first-aid equipment from training), and links them to their village's associated BHU (per Module 5's mapping).
4. Responder's `active_status` starts as active only after sign-off is complete.

**Hackathon scope note:** doesn't need a built admin panel — a simple "verified: true/false" field set by a seed script/admin action is enough to demonstrate the concept exists.

---

## Module 8 — Escalation & Timeout Logic

**Purpose:** Handle the non-happy-path: no response, refusal, or mid-incident escalation.

**Triggers:**
1. **No responder acknowledgment within timeout window (e.g., 2–3 minutes):** automatically fall through to the next-nearest available responder (from Module 3's ranked list). If the entire village group is exhausted/unavailable, escalate directly to BHU-only dispatch (skip the responder layer) and flag the village as a coverage gap for Module 6 analytics.
2. **Responder explicitly declines/unavailable:** same fallback as above, immediate, no waiting for a timeout.
3. **Mid-incident escalation from Module 2's help bot** (e.g., "bleeding not stopping," "losing consciousness"): immediately upgrade severity tier and re-trigger Module 3's BHU/ambulance dispatch if not already active — this should not wait for the responder to manually request it.

**Output:** every escalation event should be logged to the incident record (Module 6) — both for transparency and because repeated escalations from the same village or same injury type are useful signal for Module 5/7 (training gaps, coverage gaps).

---

## Module 9 — Reporter Follow-Up & Status Updates

**Purpose:** Close the loop for the person who reported the emergency — they're often the most anxious person in the scenario and currently get no feedback after submitting.

**Flow:** After Module 1 registration, the reporter receives lightweight status pings (push notification or SMS, Urdu):
- "Responder [name] has been notified and is on the way."
- "BHU has been informed." (Tier 2/3 only)
- "Ambulance has been requested." (Tier 3 only)
- "[Responder] has arrived." (on Module 6 arrival timestamp)
- Final resolution status once the incident is closed.

**Hackathon scope note:** even a simple status-string push (not a full chat interface) is enough to demonstrate this — the point is showing the loop is closed, not building a rich messaging UI.

---

## Suggested Build Priority for Hackathon Demo

**Core demoable loop (build fully):**
- Module 1 (registration + triage)
- Module 2 (2–3 hardcoded reactive branches)
- Module 3 (matching/dispatch logic)
- Module 6 (minimal incident logging — enough to show the lifecycle and feed a simple outcome/response-time view)

**Present as designed architecture, partially/minimally built:**
- Module 4 (language default — apply globally, low effort, keep it fully done since it's cheap)
- Module 5 (database schema + points logic can be built; full accountability dashboard UI can be minimal)
- Module 7 (onboarding flow can be a stub/seed data rather than a full UI)
- Module 8 (implement the core timeout fallback since it's simple and strengthens the demo; the rest can be described)
- Module 9 (simple status string push is enough)

**Additional notes to carry into the build:**
- Data privacy: patient images and health-related voice data should be handled carefully — encrypt at rest, and have at least a stated policy (e.g., auto-delete images after incident closure + N days) even if not fully implemented for the hackathon.
- Offline/low-connectivity fallback (SMS/USSD) is worth one slide in the pitch as a roadmap item — signals awareness of the real rural deployment environment, doesn't need to be built.
- Keep the severity-tier field (Module 1) visible and inspectable throughout the pipeline in the demo — it's the clearest way to show judges "this is where AI actually makes a decision," not just a UI layer on top of static logic.
