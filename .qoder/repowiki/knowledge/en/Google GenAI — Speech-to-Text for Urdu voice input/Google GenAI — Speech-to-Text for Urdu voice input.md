---
kind: external_dependency
name: Google GenAI — Speech-to-Text for Urdu voice input
slug: google-genai
category: external_dependency
category_hints:
    - vendor_identity
    - sdk_real_api
scope:
    - '**'
source_files:
    - backend/requirements.txt
---

### Role in this project
- Provides speech-to-text transcription of Urdu voice notes submitted by reporters in Module 1, including handling regional accents (Punjabi/Pashto/Seraiki inflection).

### Integration shape
- Used after capturing a voice recording from the reporter's device; transcription feeds the triage classifier alongside vision output.
- If transcription fails or is too short/inaudible, the system must NOT block dispatch — default to Tier 2 with a low-confidence flag.

### Durable usage notes
- Confirm exact method/params against official Google GenAI docs when implementing or replacing the STT call.