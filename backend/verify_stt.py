"""Phase 1 verification gate: Urdu STT accuracy check through the real pipeline.

Uses slice_runner.transcribe_voice_note (active provider from TRIAGE_AI_PROVIDER,
default gemini; dashscope implementation present for swap-back). Prints the actual
transcription next to the ground truth (optional <clip>.txt sidecar) side by side.

Usage:  python verify_stt.py
Exit:   0 = all clips transcribed (quality judged by human review)
        2 = one or more clips failed / empty output
"""
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import slice_runner  # noqa: E402

VOICE_DIR = Path(__file__).resolve().parent.parent / "mockdata" / "media" / "voice"
AUDIO_EXTS = {".wav", ".mp3", ".m4a", ".ogg", ".opus", ".flac", ".aac", ".amr"}


def main() -> int:
    provider = slice_runner._ai_provider()
    clips = sorted(p for p in VOICE_DIR.iterdir() if p.suffix.lower() in AUDIO_EXTS)
    if not clips:
        print(f"No audio clips found in {VOICE_DIR}")
        return 2

    print("=" * 72)
    print(f"URDU STT VERIFICATION via pipeline (provider={provider})")
    print("=" * 72)
    failures = 0
    for clip in clips:
        sidecar = clip.with_suffix(".txt")
        ground_truth = (sidecar.read_text(encoding="utf-8").strip()
                        if sidecar.exists() else "(no ground-truth sidecar yet)")
        print(f"\n--- {clip.name} ---")
        print(f"  Ground truth : {ground_truth}")
        started = time.time()
        out = slice_runner.transcribe_voice_note(str(clip))
        latency = round(time.time() - started, 1)
        text = out.get("text", "")
        if out.get("status") == "failed" or not text:
            failures += 1
            print(f"  Transcription: <{'FAILED' if out.get('status') == 'failed' else 'EMPTY'}>")
        else:
            print(f"  Transcription: {text}")
        print(f"  Latency      : {latency}s")
    print("\n" + "=" * 72)
    print(f"DONE: {len(clips) - failures}/{len(clips)} clips transcribed.")
    print("Review side-by-side output above before wiring STT into the pipeline.")
    return 0 if failures == 0 else 2


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    sys.exit(main())
