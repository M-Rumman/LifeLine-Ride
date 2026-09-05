---
kind: external_dependency
name: Alibaba Cloud DashScope / Model Studio — AI model serving layer
slug: alibaba-cloud-dashscope-model-studio
category: external_dependency
category_hints:
    - vendor_identity
    - sdk_real_api
scope:
    - '**'
---

### Role in this project
- Serves the Qwen family models used across Modules 1–3: `qwen-vl-max` for vision injury classification, `qwen-plus` for severity-tier triage classification, and `qwen-turbo` for intent matching.

### Integration shape
- The backend calls DashScope as a remote model API; incident media (photos) are uploaded to Alibaba Cloud OSS first, then referenced by the vision model call.
- Triage output must be an explicit, inspectable severity tier (Tier 1/2/3) plus reasoning flags — not buried logic — because downstream modules (dispatch, escalation, outcome tracking) depend on it.

### Durable usage notes
- Vision + STT + triage is a two-step pipeline (transcribe Urdu voice → classify photo → combine into tier); do not collapse into a single model call.
- Confirm exact method/params against official DashScope docs when wiring new model calls.