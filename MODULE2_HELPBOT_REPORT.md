# Module 2 — Responder AI Help Bot: Final Report

**Status:** Delivered. All code complete and verified; all three branches have live 5/5 test runs. One evidence item remains pending (snakebite branch-specific TTS audio, blocked by Gemini free-tier daily quota) — an automated task completes it at the next quota reset (see *Pending items*).

**First-aid content is DRAFT — it requires professional medical review before any use beyond the hackathon demo.** (Banner also present at the top of `backend/services/help_bot_content.py`.)

---

## 1. What was built

A hands-free, Urdu-only voice guidance bot that activates after Module 1 dispatch. It runs a continuous conversation loop:

```
mic capture (sounddevice, 16 kHz)
  → energy-based VAD segments the utterance (~1.2 s silence ends a turn)
  → Gemini STT (audio part, Urdu verbatim transcription)
  → intent classification (Gemini text model, STRICT JSON, classification ONLY)
  → pre-written hardcoded Urdu line selected from the branch script
  → Gemini TTS (voice "Kore", 24 kHz PCM → wav)
  → interruptible playback (responder speech above threshold = barge-in, playback stops immediately)
```

**The LLM never composes a single spoken sentence.** Every utterance the bot can speak lives as a fixed string in `help_bot_content.py`. The LLM is used exclusively for (a) speech-to-text and (b) classifying what the responder said. This satisfies the rulebook requirement: *decision tree, NOT freeform LLM chat* — and makes the bot's medical output 100% reviewable.

**Engine choice (as decided): chunked scripted loop, not the Gemini Live API.** True bidirectional streaming was ruled out entirely: freeform LLM phrasing conflicts directly with the no-improvised-medical-advice requirement. Honest measured latency is reported in §5.

### Files

| File | Change |
|---|---|
| `backend/services/help_bot_content.py` | NEW — all hardcoded Urdu content (3 branches + shared lines), DRAFT banner |
| `backend/services/help_bot_service.py` | NEW — engine: branch router, state machine, conversation loop, provider boundary, `escalateIncident`, mic/VAD/barge-in, TTS disk cache |
| `backend/help_bot_runner.py` | NEW — CLI entrypoint (`--simulate` / `--from-pipeline` × `--mode mic` / `--mode replay`, `--prewarm-tts`, `--verify-tts`) |
| `backend/slice_runner.py` | EDIT — **one additive field only**: `Incident.help_bot_transitions: List[dict] = []`. No other Module 1 code touched. |
| `backend/requirements.txt` | EDIT — added `sounddevice`, `soundfile` (only new deps) |
| `mockdata/helpbot/scripts/*.json` | NEW — 3 deterministic replay scripts (one per branch) |
| `mockdata/helpbot/tts_cache/` | NEW — rendered Urdu audio + `manifest.json` (model/voice provenance per line) |
| `mockdata/helpbot/test_runs/` | NEW — run records (full transcripts, transitions, per-turn latencies, expectations) |

## 2. Branches built — and why

Three branches, keyed directly to the **real injury flags Module 1 emits** for the existing mock media (verified against the triage cache JSONs, and by offline check against the exact flag lists):

| Branch | Module 1 flags that route here | Source scenario | Content |
|---|---|---|---|
| `heavy_bleeding` | `machine_entanglement, heavy_bleeding, traumatic_amputation` | `ungli.mp3` (machine hand injury) | Direct pressure, elevation, clean cloth; Q&A: cloth soaked through, how hard to press, how long, object stuck in wound; escalation: tourniquet-position + unconsciousness protocol |
| `fracture_crush` | `heavy_bleeding, major_trauma, deep_open_wound` | `taang.mp3` (crushed leg) | Immobilize as-found, never straighten, splint improvisation (healthy limb as splint), no food/water/painkillers; escalation: exposed-bone + consciousness protocol |
| `snakebite` | `venomous_snake_bite, puncture_wounds` | `saanp.mp3` | Keep still, limb below heart level, remove rings/watches, explicit do-NOTs (no cutting, no sucking, **no tourniquet**); Q&A incl. the tourniquet question (correct answer: NO); escalation: breathing-difficulty protocol |

Routing is a deterministic substring/synonym map (`snake|saanp|venom|zehr…` → snakebite, then `fracture|crush|major_trauma…` → fracture_crush, then `bleed|blood|amput…` → heavy_bleeding); unmatched flags fall back to `heavy_bleeding` (safest default) and log `branch_unmatched`. Each branch: 2 initial-guidance lines, 3 ordered steps, 3–4 Q&A entries, 3 escalated-guidance lines. Shared lines: fail-safe, honest out-of-scope fallback, check-in, session-complete.

## 3. Provider-swap parity with Module 1

- **Same single flag**: `TRIAGE_AI_PROVIDER` (`gemini` default, `dashscope` swap target) governs Module 2 exactly as Module 1 — no new mechanism.
- **Same per-step pattern**, `gemini_*` active / `dashscope_*` isolated:
  - `transcribeResponderInput` — Gemini: same audio-part pattern as Module 1's `gemini_transcribe_voice`. DashScope: SenseVoice-v1 (only Urdu ASR — same choice as Module 1).
  - `detectResponderIntent` — Gemini text model (`GEMINI_CLASSIFIER_MODEL`). DashScope: `qwen-plus` (the brief's named candidate).
  - `speakGuidance` — Gemini TTS (`GEMINI_TTS_MODEL`). DashScope: CosyVoice boundary exists but **intentionally raises** "Urdu voice support unverified" — verify-first discipline, per brief.
- **Same resilience plumbing, imported not duplicated**: `TRIAGE_CALL_TIMEOUT_S`, `_call_with_retry` (429 backoff, `TRIAGE_QUOTA_RETRIES`), `_parse_json_loose` — all imported from `slice_runner`.
- **Fail-safe**: any AI failure mid-session → pre-rendered Urdu fail-safe audio is spoken (rendered and cached at startup, so no network is needed at failure time), `[HELPBOT WARN]` logged, loop stays alive. Never silent, never hangs. This path was genuinely exercised under quota exhaustion — see §6.

## 4. Escalation hook — Module 3/8 integration point

`escalateIncident(incident_id, new_signals) -> dict` in `help_bot_service.py`:

- Upgrades `severity_tier` one or more levels, **never downgrades** (monotonicity covered by offline checks).
- Merges new injury flags; sets `ambulance_requested=True` when critical; sets BHU-notify flags.
- Appends a timestamped event (trigger, old→new tier, transcript excerpt) to `incident.help_bot_transitions`, and syncs the `INCIDENT_STORE` snapshot so existing `logIncident` dumps carry it (feeds Module 5 accountability later).
- Docstring states the contract: *wire Modules 3/8 by CALLING this function, not rewriting it.*

## 5. Test evidence (real pipeline: real intent classification, real TTS)

Deterministic replay scripts drove typed-Urdu responder turns through the live engine. Run records: `mockdata/helpbot/test_runs/`.

| Branch | Run record | Expectations | Escalation exercised | Audio |
|---|---|---|---|---|
| heavy_bleeding | `INC-SIM-HEAVY-BLEEDING_replay_1788077207.json` | **5/5** (2× step_done, in-scope Q `cloth_soaked`, out-of-scope Q, escalation) | `uncontrolled_bleeding_and_unconsciousness` → critical, ambulance requested | 10/10 lines real TTS |
| fracture_crush | `INC-SIM-FRACTURE-CRUSH_replay_1788079070.json` | **5/5** (step_done, 2× in-scope Q `no_splint` + `food_water`, out-of-scope Q, escalation) | `unconsciousness_breathing_difficulty` → **moderate → critical upgrade**, ambulance requested, flag merged | 9/10 real; 1 line failsafe-substituted (quota hit mid-run — recorded with `intended_line`) |
| snakebite | `INC-SIM-SNAKEBITE_replay_1788080732.json` | **5/5** (2× step_done, in-scope Q `tie_cloth` — answered with the NO-tourniquet line, out-of-scope Q, escalation) | `سانس لینے میں تکلیف` → critical, ambulance requested | 1/10 real; 9 failsafe-substituted (TTS daily quota exhausted — see Pending items) |

Every run: `branch_matched=True` on real Module 1 flags, 9 transitions logged to `help_bot_transitions` (branch entry → steps → questions → escalation → finalize).

### Honest latency (utterance end → response playback start)

| Run | min | avg | max |
|---|---|---|---|
| heavy_bleeding (clean) | 4721 ms | **5740 ms** | 6689 ms |
| fracture_crush (clean) | 4111 ms | **4392 ms** | 4971 ms |
| snakebite (degraded-audio run) | 2283 ms | 18407 ms | 41812 ms — *not representative: each uncached line first attempted a doomed TTS call against an exhausted daily quota before fail-safe substitution* |

Clean-run latency is **~4.4–5.7 s per turn**, dominated by intent classification (TTS lines were cache hits, adding ~0 s; a cold render adds ~5–15 s once per line — which is why `--prewarm-tts` exists). This is above the 2–4 s hope and is reported as-is: it is the honest price of a fully scripted, non-freeform Urdu pipeline on request-response APIs. In mic mode the perceived gap is partly masked because playback of multi-line responses streams line-by-line.

### Urdu intent-detection reliability

- **15/15 intents classified correctly** across all clean runs (10 on `gemini-3.5-flash`, 5 on `gemini-3.5-flash-lite`). Zero classification errors observed; every failure seen was an HTTP 429 quota event, never a logic error.
- Out-of-scope discipline held in all three branches (thirst/water, fever pill, cross-branch snakebite question): honest fallback spoken, **zero improvised medical advice**.
- Safety rails verified offline (24/24 checks): malformed/garbage model JSON → `unclear` → fail-safe line; `in_scope_question` with an invalid `qa_entry_id` → forced `out_of_scope` (the bot never guesses an answer); invalid tier values dropped.

### Spoken-Urdu confirmation (checked, not assumed)

Round-trip test — generated TTS audio fed back through the STT path (`--verify-tts`, report: `test_runs/verify_tts.json`):

- **fracture_crush** — byte-perfect verbatim round-trip.
- **heavy_bleeding** — near-verbatim (ہیلپ بوٹ→ہیلپ لائن، قدم بہ قدم→قدم ب قدم; orthographic variance only, meaning fully intact).
- **snakebite** — verbatim (minus punctuation) on the shared fail-safe line; branch-specific audio pending quota reset.
- All round-trips `stt_usable=True`. 26/39 scripted lines exist as real Urdu audio in `tts_cache/` (listen to verify). Audio files persist per line for manual review.

## 6. Quota findings (read before demo day)

Measured against this API key on 2026-08-30 (free tier):

- `gemini-3.5-flash`: **20 requests/day**, shared by Module 1 triage (vision+STT+classifier) AND Module 2 STT+intent. Exhausted during testing.
- Gemini TTS models: **10 requests/day per model** (confirmed via `GenerateRequestsPerDayPerProjectPerModel-FreeTier, quotaValue: 10`). `gemini-2.5-flash-preview-tts` and `gemini-3.1-flash-tts-preview` both exhausted; `gemini-2.5-pro-preview-tts` also capped.
- Retired (404) on this key: `gemini-2.5-flash`, `2.5-flash-lite`, `2.0-flash(-lite)`, `2.5-pro`. **`gemini-3.5-flash-lite` and `gemini-3.1-flash-lite` are alive** with separate budgets — overridable via `GEMINI_CLASSIFIER_MODEL` / `GEMINI_STT_MODEL` (the snakebite 5/5 run used the lite classifier).

**Demo-day recommendations:**
1. Run `python backend\help_bot_runner.py --prewarm-tts` before the demo → conversations then consume **zero TTS quota** (100% cache hits).
2. Budget ~6–8 STT/intent calls per conversation against the 20/day cap, or move the key to a paid tier.
3. Keep `TRIAGE_QUOTA_RETRIES=3` (default) so transient 429s ride out; the fail-safe line covers the rest.

## 7. Pending items (auto-completes at quota reset)

Gemini TTS daily quota resets at midnight Pacific (**12:00 PKT, 2026-08-31**). A scheduled task in this conversation fires at 12:10 PKT to:

1. `--prewarm-tts` — render the remaining 13 lines (fracture escalated-guidance #3 + 12 snakebite branch lines). If a model caps at 10, finish with `GEMINI_TTS_MODEL=gemini-2.5-flash-preview-tts`.
2. Rerun the snakebite replay for the clean full-audio record (expect 5/5, 0 fail-safe substitutions).
3. Rerun `--verify-tts` for the snakebite branch-specific round-trip.
4. Update this report's evidence table.

Manual equivalent (same three commands) if run by hand. Everything is cached/resumable; no work is redone.

## 8. How to run

```powershell
cd "d:\LifeLine Ride"
# deterministic evidence runs (typed Urdu turns, zero STT quota)
python backend\help_bot_runner.py --simulate heavy_bleeding  --mode replay mockdata\helpbot\scripts\heavy_bleeding.json
python backend\help_bot_runner.py --simulate fracture_crush  --mode replay mockdata\helpbot\scripts\fracture_crush.json
python backend\help_bot_runner.py --simulate snakebite       --mode replay mockdata\helpbot\scripts\snakebite.json
# live hands-free demo (mic + barge-in)
python backend\help_bot_runner.py --simulate snakebite --mode mic
# end-to-end from real Module 1 triage of mock media (photo: mockdata\media\photos\*.png)
python backend\help_bot_runner.py --from-pipeline --photo "mockdata\media\photos\PhotoshopExtension_Image.png" --voice mockdata\media\voice\ungli.mp3 --village VILLAGE-A --mode mic
# maintenance
python backend\help_bot_runner.py --prewarm-tts     # render all scripted lines into cache
python backend\help_bot_runner.py --verify-tts      # TTS->STT round-trip per branch
```

Mic mode: energy-based VAD segments speech; speaking over the bot (barge-in) stops playback immediately; after each response the bot resumes monitoring and issues a scripted check-in after N silent cycles. Known limitation: no acoustic echo cancellation — barge-in uses a raised energy threshold during playback (documented in `help_bot_service.py`).

## 9. Verification summary

- `python -m py_compile` clean on all new/edited files.
- **24/24 offline checks pass** (zero AI calls): branch routing against real Module 1 flag outputs (ungli/taang/saanp triage caches), malformed intent-JSON handling, `escalateIncident` monotonicity (never downgrades), store-snapshot sync, unknown-incident KeyError, Module 1 backward compatibility (Incident constructs without the new field; `run_test_suite`/`getTriageResultMOCK` untouched).
- Module 1 diff surface: exactly one additive dataclass field.
