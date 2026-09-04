"""Release responders held by stale open incidents before a demo run.

Prior test/demo runs left incidents open, so their assigned responders stayed
`busy` in PostgreSQL and the reconciliation on startup kept them busy. With
both VILLAGE-A responders stuck, a fresh VILLAGE-A report has nobody to
dispatch to and the demo dead-ends in a coverage gap.

Reads the persisted incident list straight from PostgreSQL, then closes every
still-open one THROUGH THE LIVE HTTP API (so the running server's in-memory
INCIDENT_STORE, responder availability and the DB all agree). Closures use
confirmed_by="responder", which Module 5's fraud gate deliberately does NOT
count toward accountability metrics — cleaning up test residue must not inflate
anyone's scorecard.
"""
import sys
from pathlib import Path

import requests

BACKEND = Path(__file__).resolve().parent / "backend"
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:  # noqa: BLE001
    pass

from models.incident_model import get_all_incidents_from_db  # noqa: E402

V1 = "http://localhost:5050/api/v1"

records = get_all_incidents_from_db()
open_records = [
    r for r in records
    if r.get("incident", {}).get("incident_closed_timestamp") is None
]
print(f"persisted incidents={len(records)}  still open={len(open_records)}")

for r in open_records:
    inc = r["incident"]
    iid = inc.get("incident_id")
    assigned = inc.get("responder_assigned_id")
    print(f"\n  closing {iid} (assigned={assigned})")
    resp = requests.post(
        f"{V1}/emergency/incident/{iid}/close",
        json={"outcome": "unresolved", "confirmed_by": "responder"},
        timeout=30,
    )
    print(f"    -> {resp.status_code} {resp.text[:200]}")

after = requests.get(f"{V1}/responders", timeout=10).json()
print("\nroster after cleanup:")
for x in after.get("responders", []):
    print(f"  {x.get('responder_id')}  {str(x.get('name')):<24} "
          f"{str(x.get('village')):<12} {x.get('current_availability_status')}")
