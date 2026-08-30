# LifeLine Ride — Project Overview

## 1. Problem Statement & Mission
- **Context:** Rural emergency triage and rapid first-responder coordination in Pakistan[cite: 1].
- **Target Users:** Rural bystanders/families (Reporters), non-professional first-responders, and Basic Health Units (BHUs)[cite: 1].
- **Core Value:** Reduces reporting time to under 30 seconds via Urdu voice + photo triage, eliminating typing and complex forms[cite: 1].

## 2. System Architecture & Modules
- **Module 1 (Registration & AI Triage):** Speech-to-Text (Urdu) + Qwen-VL Vision + Qwen-Plus Tier Classifier[cite: 1].
- **Module 2 (Responder Help Bot):** Hands-free Urdu voice state machine guiding first aid with condition-escalation triggers[cite: 1].
- **Module 3 (Matching & Dispatch Engine):** Ranked GPS proximity matching with linked village-BHU associations[cite: 1].
- **Module 4 (Localization):** Global Urdu-first UI and audio workflows[cite: 1].
- **Modules 5 & 6 (Registry & Outcome Tracking):** Verified responder points, fraud-prevention outcome confirmations, and coverage-gap tracking[cite: 1].
- **Module 8 (Escalation):** Automatic timeout re-routing and mid-incident condition escalation[cite: 1].
- **Module 9 (Reporter Updates):** Async Urdu status notifications[cite: 1].

## 3. Alibaba Cloud Tech Stack
- **AI Models (DashScope / Model Studio):** `qwen-vl-max` (Vision), `qwen-plus` (Triage), `qwen-turbo` (Intent matching)[cite: 1].
- **Compute & Storage:** Function Compute 3.0 (Serverless API), OSS (Encrypted temporary incident media)[cite: 1].
- **Database:** PostgreSQL / PolarDB with spatial lookup support[cite: 1].