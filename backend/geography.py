"""User-facing geography registry for the Tamman/Talagang pilot area.

Legacy VILLAGE-A/B/C ids are retained as compatibility groups for the existing
seeded responders and regression suite. New reports may use the real locality
ids below; dispatch resolves them to the corresponding current response group
and linked BHU without changing the stored incident locality.
"""

from __future__ import annotations

# Real locality -> existing seeded responder coverage group.
# This is deliberately a compatibility layer until responder GPS locations are
# stored as first-class fields in the database.
COVERAGE_VILLAGE: dict[str, str] = {
    "TAMMAN": "VILLAGE-A",
    "DHERMOND": "VILLAGE-A",
    "MULTAN-KHURD": "VILLAGE-B",
    "PATWALI": "VILLAGE-A",
    "SANGWALA": "VILLAGE-A",
    "DAROT": "VILLAGE-A",
    "BEDHAR": "VILLAGE-A",
    "WANHAR": "VILLAGE-A",
    "SAGHAR": "VILLAGE-A",
    "BUDHIAL": "VILLAGE-A",
    "JASIAL": "VILLAGE-B",
    "KOT-SARANG": "VILLAGE-B",
    "JHATLA": "VILLAGE-B",
}

LOCALITY_BHU: dict[str, str] = {
    "TAMMAN": "BHU-001",
    "DHERMOND": "BHU-003",
    "MULTAN-KHURD": "BHU-004",
    "PATWALI": "BHU-005",
    "SANGWALA": "BHU-003",
    "DAROT": "BHU-003",
    "BEDHAR": "BHU-003",
    "WANHAR": "BHU-003",
    "SAGHAR": "BHU-003",
    "BUDHIAL": "BHU-005",
    "JASIAL": "BHU-005",
    "KOT-SARANG": "BHU-005",
    "JHATLA": "BHU-005",
}


def coverage_village_id(village_id: str) -> str:
    """Resolve real locality ids to the current seeded responder group."""
    return COVERAGE_VILLAGE.get(village_id, village_id)


def bhu_id_for_village(village_id: str) -> str | None:
    """Return the user-facing locality's linked health facility, if known."""
    return LOCALITY_BHU.get(village_id)
