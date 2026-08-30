---
trigger: always_on
---
# QODER WORKSPACE RULEBOOK: LifeLine Ride (Village Emergency Response Network)

## 0. QODER MODE ROUTING & ADVISORY DIRECTIVE
Whenever a prompt or task is received, Qoder MUST explicitly indicate the recommended mode at the very start of its response:
* **Ask Mode (Strategic Advisor):** Recommend this for architecture decisions, prompt engineering for triage models, medical decision-tree mapping, and technical troubleshooting without modifying code.
* **Agent Mode (Elite Programmer):** Recommend this for targeted implementations, writing API clients, single-module tests, bug fixing, script execution, or refactoring specific components.
* **Quest Mode (Autonomous Feature Team):** Recommend this for executing end-to-end multi-file features (e.g., building the full Module 1 registration-to-triage pipeline, scaffolding the complete Module 3 matching engine with database models).

---

## 1. CORE PROJECT PHILOSOPHY & HACKATHON CONSTRAINTS
* **Project Identity:** LifeLine Ride is an AI-powered, Urdu-first emergency response system for rural Pakistan connecting reporters, non-professional first-responders, and Basic Health Units (BHUs)[cite: 1].
* **Healthcare Guardrail Principle:** AI MUST "Assist — do not diagnose. Make limitations explicit." AI facilitates symptom triage and dispatch, but never replaces medical judgment.
* **Scope Reduction (MVP Rule):** Focus exclusively on the primary loop: 1 primary user (rural reporter) + 1 critical problem (rapid emergency dispatch & triage) + 1 first workflow (report -> triage -> responder matching -> first aid guidance)[cite: 1]. Postpone all non-essential features.
* **Inspectable AI Decisions:** The triage severity tier (Tier 1: Minor, Tier 2: Moderate, Tier 3: Critical) must be an explicit, transparent JSON payload with logged reasoning flags, never an opaque decision[cite: 1].

---

## 2. LANGUAGE & LOCALIZATION CONVENTIONS
* **Global Urdu Default:** Urdu is the global default language across the UI, voice prompts, TTS/ASR services, and push notifications[cite: 1].
* **Dialect Tolerance:** Voice input pipelines must support Urdu spoken with regional inflections (Punjabi, Pashto, Seraiki)[cite: 1].
* **Plain Language:** Explanations and status alerts must be simple, concise, and accessible to users with low digital literacy.

---

## 3. ARCHITECTURE & MODULE RULES

### Module 1: Emergency Registration & AI Triage Pipeline
* **Separation of Models:** NEVER merge Speech-to-Text and Vision into a single call.
  1. STT: Transcribe Urdu voice note[cite: 1].
  2. Vision: Classify visible injury type/severity from photo[cite: 1].
  3. Classifier: Combine transcript + vision tags to produce `{ severity_tier, reasoning_flags }`[cite: 1].
* **Fail-Safe Dispatch:** If an image is blurry or audio is inaudible, DO NOT block the emergency flow. Default to **Tier 2 (Moderate)** and flag as `low_confidence_triage`[cite: 1].

### Module 2: Responder AI Help Bot
* **Deterministic Flow:** Build as a hardcoded reactive decision tree / state machine, NOT a freeform LLM chat[cite: 1].
* **Hands-Free Operation:** Must be 100% voice-in, voice-out (Urdu)[cite: 1].
* **Escalation Sensor:** Any condition deterioration detected during first-aid (e.g., "bleeding not stopping") must automatically trigger Module 8 escalation logic[cite: 1].

### Module 3: Matching & Dispatch Logic
* **Ranked Availability:** Responders must be ranked by proximity and filtered by active status (`is_active: true`, `has_open_incident: false`)[cite: 1].
* **Fixed Association:** Dispatch targets the pre-linked BHU associated with the village group[cite: 1].
* **Simultaneous Dispatch:** Tier 3 incidents must trigger notifications to the responder, BHU, and ambulance request concurrently[cite: 1].

### Module 5 & 6: Data, Outcomes, & Fraud Prevention
* **Verified Points Awarding:** Points are awarded only after an incident outcome is verified (confirmed by BHU or closed record), never on self-reported completion[cite: 1].
* **Data Privacy:** Encrypt health data and patient images at rest. Include an automated cleanup policy schema for temporary incident media[cite: 1].

---

## 4. CODE & REPOSITORY STANDARDS
* **Structured Outputs:** All AI triage, bot state updates, and dispatch payloads must conform to strict JSON schemas[cite: 1].
* **Seed Data over Complex Admin Panels:** For Modules 5 & 7 (Responder/BHU registries and onboarding), use database seeds and mock states rather than building full admin UIs[cite: 1].
* **Modular Code Structure:** Keep business logic, AI integrations, state machines, and API handlers strictly decoupled.