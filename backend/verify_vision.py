"""Phase 2 verification: injury classification through the real pipeline.

Uses slice_runner.classify_injury_photo (active provider from TRIAGE_AI_PROVIDER,
default gemini; dashscope/qwen-vl-max implementation present for swap-back).
Prints classification + latency per photo.

Usage:  python verify_vision.py
Exit:   0 = all photos classified (one or more may report image_usable=false)
        2 = one or more API errors
"""
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import slice_runner  # noqa: E402

PHOTO_DIR = Path(__file__).resolve().parent.parent / "mockdata" / "media" / "photos"
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}


def main() -> int:
    provider = slice_runner._ai_provider()
    photos = sorted(p for p in PHOTO_DIR.iterdir() if p.suffix.lower() in IMAGE_EXTS)
    if not photos:
        print(f"No photos found in {PHOTO_DIR}")
        return 2

    print("=" * 72)
    print(f"INJURY CLASSIFICATION VERIFICATION via pipeline (provider={provider})")
    print("=" * 72)
    failures = 0
    for photo in photos:
        print(f"\n--- {photo.name} ---")
        started = time.time()
        out = slice_runner.classify_injury_photo(str(photo))
        latency = round(time.time() - started, 1)
        if out.get("status") == "failed":
            failures += 1
            print("  ERROR: classification call failed (see TRIAGE WARN above)")
            continue
        print(f"  Classification: {out.get('injury_classification')} | "
              f"Severity: {out.get('apparent_severity')} | "
              f"Confidence: {out.get('confidence')} | Usable: {out.get('image_usable')}")
        print(f"  Signals       : {out.get('visible_signals')}")
        print(f"  Latency       : {latency}s")
    print("\n" + "=" * 72)
    print(f"DONE: {len(photos) - failures}/{len(photos)} photos classified successfully.")
    return 0 if failures == 0 else 2


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    sys.exit(main())
