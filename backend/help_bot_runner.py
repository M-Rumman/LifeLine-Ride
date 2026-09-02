# -*- coding: utf-8 -*-
"""Module 2 — Responder AI Help Bot: console entrypoint (no UI, per brief).

Usage (run from the repo root or backend/):
  python backend/help_bot_runner.py --simulate heavy_bleeding --mode replay mockdata/helpbot/scripts/heavy_bleeding.json
  python backend/help_bot_runner.py --simulate snakebite --mode mic
  python backend/help_bot_runner.py --from-pipeline --photo "mockdata/media/photos/PhotoshopExtension_Image (1).png" --voice mockdata/media/voice/ungli.mp3 --village VILLAGE-A --mode replay mockdata/helpbot/scripts/heavy_bleeding.json
  python backend/help_bot_runner.py --verify-tts

--simulate      build a dispatched incident from seed data using the REAL
                injury flags Module 1 produced for that scenario (zero AI quota).
--from-pipeline run the full Module 1 pipeline on mock media first (triage
                cache makes repeat runs quota-free), then hand the incident
                to the help bot.
--mode mic      live hands-free loop (sounddevice mic + speaker, barge-in).
--mode replay   deterministic script of responder turns (the verification path).
                Auto-sets LIFELINE_REPLAY_MODE=1 so quota-exhausted AI calls
                fail fast (2s backoff) instead of stalling 45s/turn.
--verify-tts    spoken-Urdu check: TTS one guidance line per branch, then STT
                the generated audio back and print source vs transcript.
                Also auto-sets LIFELINE_REPLAY_MODE=1.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

_BACKEND_DIR = Path(__file__).resolve().parent
_REPO_ROOT = _BACKEND_DIR.parent
for _p in (str(_BACKEND_DIR), str(_REPO_ROOT)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

try:
    sys.stdout.reconfigure(encoding="utf-8")  # Urdu on Windows consoles
except Exception:
    pass

import slice_runner  # noqa: E402
from services.help_bot_service import (  # noqa: E402
    BRANCHES, HelpBotSession, speakGuidance, transcribeResponderInput,
    _tts_cache_path,
)
from services.help_bot_content import SHARED_LINES  # noqa: E402

# Real flags Module 1 produced for each mock scenario (see .triage_cache).
SIMULATED_FLAGS = {
    "heavy_bleeding": ["machine_entanglement", "heavy_bleeding", "traumatic_amputation"],
    "fracture_crush": ["heavy_bleeding", "major_trauma", "deep_open_wound"],
    "snakebite": ["venomous_snake_bite", "puncture_wounds"],
}
# Starting tiers. All three real Module 1 runs triaged critical, but
# fracture_crush is simulated at moderate so the live runs also exercise the
# escalation hook's tier-UPGRADE path (moderate -> critical), not just the
# already-critical path. This is a deliberate simulation choice, not a claim
# about the real taang.mp3 triage result.
SIMULATED_TIER = {
    "heavy_bleeding": "critical",
    "fracture_crush": "moderate",
    "snakebite": "critical",
}


def _dispatch_and_log(incident) -> None:
    """Reuse Module 1's matching/dispatch/logging untouched."""
    responder, bhu = slice_runner.matchResponderAndBHU(incident)
    result = slice_runner.dispatch(incident, responder, bhu)
    slice_runner.logIncident(incident, result)
    print(f"  [RUNNER] incident {incident.incident_id} dispatched "
          f"({result.status}); responder="
          f"{responder.name if responder else 'NONE'}")


def build_simulated_incident(branch_id: str):
    from datetime import datetime, timezone

    incident = slice_runner.Incident(
        incident_id=f"INC-SIM-{branch_id.upper().replace('_', '-')}",
        timestamp_reported=datetime.now(timezone.utc).isoformat(),
        reporter_id="REP-SIM",
        gps_location=slice_runner.GPSLocation(
            latitude=31.5204, longitude=74.3587, village_id="VILLAGE-A"),
        photo_ref="simulated",
        voice_transcript="(simulated incident for Module 2 help-bot run)",
        severity_tier=SIMULATED_TIER[branch_id],
        injury_type_flags=list(SIMULATED_FLAGS[branch_id]),
    )
    _dispatch_and_log(incident)
    return incident


def build_pipeline_incident(photo: str, voice: str, village: str):
    loc = slice_runner.GPSLocation(latitude=31.5204, longitude=74.3587,
                                   village_id=village)
    incident = slice_runner.registerIncident(photo, voice, loc)
    print(f"  [RUNNER] Module 1 triage: tier={incident.severity_tier} "
          f"flags={incident.injury_type_flags}")
    _dispatch_and_log(incident)
    return incident


def prewarm_tts() -> None:
    """Render every scripted line into the TTS cache, paced for the free-tier
    TTS rate limit (~10 requests per quota window observed). After prewarming,
    replay runs consume ZERO TTS quota (100% cache hits) and stay
    deterministic. Cached lines are skipped instantly."""
    lines = [SHARED_LINES[k] for k in ("failsafe_line", "out_of_scope_fallback",
                                       "check_in_line", "session_complete_line")]
    for branch in BRANCHES.values():
        lines += list(branch["initial_guidance"])
        lines += [s["line"] for s in branch["steps"]]
        lines += [e["answer"] for e in branch["qa_entries"]]
        lines += list(branch["escalated_guidance"])
    print(f"prewarming TTS cache: {len(lines)} scripted lines")
    rendered = skipped = 0
    for i, line in enumerate(lines, start=1):
        for attempt in (1, 2, 3):
            try:
                info = speakGuidance(line)
                break
            except Exception as exc:
                print(f"  line {i}: render failed (attempt {attempt}): {str(exc)[:100]}")
                if attempt == 3:
                    raise
                time.sleep(60)
        if info["cached"]:
            skipped += 1
        else:
            rendered += 1
            time.sleep(8)  # pace fresh renders under the rate limit
        print(f"  [{i}/{len(lines)}] {'cached' if info['cached'] else 'rendered'}: {line[:60]}")
    print(f"prewarm complete: {rendered} rendered, {skipped} already cached")


def verify_tts() -> dict:
    """Spoken-Urdu verification: TTS -> audio file -> STT round-trip."""
    print("=" * 70)
    print("SPOKEN-URDU VERIFICATION (TTS line -> STT round-trip per branch)")
    print("=" * 70)
    report = {}
    for branch_id, branch in BRANCHES.items():
        # prefer a branch-specific line whose audio is already rendered; if the
        # TTS quota ran out before this branch was prewarmed, fall back to the
        # shared fail-safe line and mark the gap explicitly.
        candidates = (list(branch["initial_guidance"])
                      + [s["line"] for s in branch["steps"]]
                      + [e["answer"] for e in branch["qa_entries"]]
                      + list(branch["escalated_guidance"]))
        line = next((l for l in candidates if _tts_cache_path(l).is_file()), None)
        note = None
        if line is None:
            line = SHARED_LINES["failsafe_line"]
            note = ("branch-specific audio not yet rendered (TTS quota); "
                    "round-trip done on the shared fail-safe line")
        info = speakGuidance(line)
        stt = transcribeResponderInput(info["wav_path"].read_bytes())
        report[branch_id] = {
            "source_line": line,
            "note": note,
            "wav": str(info["wav_path"]),
            "roundtrip_transcript": stt.get("text", ""),
            "stt_usable": stt.get("usable", False),
        }
        print(f"\n[{branch_id}]{('  NOTE: ' + note) if note else ''}")
        print(f"  source line : {line}")
        print(f"  STT of audio: {stt.get('text', '')}")
        print(f"  audio file  : {info['wav_path']} (listen to verify real spoken Urdu)")
    out = _REPO_ROOT / "mockdata" / "helpbot" / "test_runs" / "verify_tts.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\nverification report written: {out}")
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description="LifeLine Ride Module 2 - Responder AI Help Bot")
    src = parser.add_mutually_exclusive_group()
    src.add_argument("--simulate", choices=sorted(SIMULATED_FLAGS),
                     help="build a dispatched incident from seed data (no AI quota)")
    src.add_argument("--from-pipeline", action="store_true",
                     help="run Module 1 triage on mock media first")
    parser.add_argument("--photo", help="photo path for --from-pipeline")
    parser.add_argument("--voice", help="voice-note path for --from-pipeline")
    parser.add_argument("--village", default="VILLAGE-A")
    parser.add_argument("--mode", choices=["mic", "replay"], default="replay")
    parser.add_argument("script", nargs="?", help="replay script JSON (mode=replay)")
    parser.add_argument("--prewarm-tts", action="store_true",
                        help="render all scripted lines into the TTS cache and exit")
    parser.add_argument("--verify-tts", action="store_true",
                        help="run the spoken-Urdu round-trip check and exit")
    args = parser.parse_args()

    # Fail fast on quota exhaustion during deterministic test/replay paths so
    # a rate-limited Gemini call doesn't stall the terminal for 45s/turn
    # (default 15s + 30s backoff between 3 attempts). Mirrors the
    # DISPATCH_ACK_TIMEOUT_S=2 trick test_module3.py uses to speed up tests.
    # Live mic mode and --prewarm-tts are intentionally left on the default
    # backoff: a real user can wait, and prewarm benefits from a real retry
    # window so the cache actually gets filled.
    if args.mode == "replay" or args.verify_tts:
        os.environ["LIFELINE_REPLAY_MODE"] = "1"

    if args.prewarm_tts:
        prewarm_tts()
        return 0

    if args.verify_tts:
        verify_tts()
        return 0

    print("=" * 75)
    print("LIFELINE RIDE — MODULE 2: RESPONDER AI HELP BOT (Urdu voice guidance)")
    print("=" * 75)

    if args.from_pipeline:
        if not (args.photo and args.voice):
            parser.error("--from-pipeline needs --photo and --voice")
        photo = str((_REPO_ROOT / args.photo)) if not Path(args.photo).is_absolute() else args.photo
        voice = str((_REPO_ROOT / args.voice)) if not Path(args.voice).is_absolute() else args.voice
        incident = build_pipeline_incident(photo, voice, args.village)
    else:
        branch = args.simulate or "heavy_bleeding"
        incident = build_simulated_incident(branch)

    session = HelpBotSession(incident, mode=args.mode)
    print(f"  [RUNNER] branch routed: {session.branch_id} "
          f"(matched={session.branch_matched}) | mode={args.mode}")

    if args.mode == "replay":
        if not args.script:
            parser.error("--mode replay needs a script JSON path")
        script_path = Path(args.script)
        if not script_path.is_absolute():
            script_path = _REPO_ROOT / args.script
        script = json.loads(script_path.read_text(encoding="utf-8"))
        record = session.run_replay(script)
    else:
        record = session.run_mic()

    print("\n" + "=" * 75)
    print(f"SESSION COMPLETE: expectations {record['expectation_summary']} | "
          f"latency avg={record['latency_summary_ms']['avg']}ms | "
          f"final tier={record['final_incident']['severity_tier']} | "
          f"escalations={sum(1 for t in record['help_bot_transitions'] if t['trigger_type'] == 'escalateIncident')}")
    print("=" * 75)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
