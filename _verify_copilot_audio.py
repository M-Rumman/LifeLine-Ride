# -*- coding: utf-8 -*-
"""Live check: copilot reply (long, markdown-heavy) carries Urdu TTS audio.

Runs against the Vite proxy (:3000) exactly like the browser does.
"""
import json
import sys
import urllib.request

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

PAYLOAD = {
    "incident_id": "INC-DEMO-ACTIVE",
    "responder_id": "RESP-TAM-01",
    "message": "میں مریض کے پاس پہنچ گیا ہوں مجھے کیا کرنا چاہیے",
    "chat_history": [],
}

req = urllib.request.Request(
    "http://localhost:3000/api/v1/responder/chat",
    data=json.dumps(PAYLOAD).encode("utf-8"),
    headers={"Content-Type": "application/json; charset=utf-8"},
    method="POST",
)
with urllib.request.urlopen(req, timeout=120) as res:
    body = json.loads(res.read().decode("utf-8"))

print("HTTP 200 via proxy")
print("reply length:", len(body.get("reply", "")))
print("audio_url:", body.get("audio_url"))
assert body.get("audio_url"), "FAIL: no audio_url on copilot reply"

with urllib.request.urlopen(
    "http://localhost:3000" + body["audio_url"], timeout=30
) as wav:
    data = wav.read(64)
print("audio header:", data[:4])
assert data[:4] == b"RIFF" or data[:3] == b"ID3" or data[:1] == b"\xff", \
    "FAIL: audio_url did not serve WAV/MP3 audio"

manifest = json.loads(
    open(r"d:\LifeLine-Ride\mockdata\helpbot\tts_cache\manifest.json",
         encoding="utf-8").read()
)
entry = manifest.get(body["audio_url"].rsplit("/", 1)[-1], {})
spoken = entry.get("text") or ""
import re
latin = re.findall(r"[A-Za-z]+", spoken)
print("manifest text length:", len(spoken))
print("latin tokens in spoken form:", latin)
assert "**" not in spoken, "FAIL: markdown reached TTS cache"
assert not latin, f"FAIL: English words would be spoken: {latin}"
print("PASS: copilot reply carries markdown-free, Urdu-only TTS audio")
