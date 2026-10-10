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


# Mapped canonical locality coordinates matching the front-end catalog.
VILLAGE_COORDINATES: dict[str, tuple[float, float]] = {
    "TAMMAN": (33.00401, 72.11048),
    "DHERMOND": (32.94397, 72.16870),
    "MULTAN-KHURD": (33.03671, 72.01418),
    "PATWALI": (33.04632, 72.18192),
    "SANGWALA": (32.97588, 72.23452),
    "DAROT": (32.91573, 72.18463),
    "BEDHAR": (32.88675, 72.18538),
    "WANHAR": (32.89323, 72.17888),
    "SAGHAR": (32.93975, 72.27128),
    "BUDHIAL": (32.99392, 72.18603),
    "JASIAL": (32.99784, 72.39200),
    "KOT-SARANG": (33.03652, 72.38243),
    "JHATLA": (32.82310, 72.38049),
    # Legacy compatibility aliases
    "VILLAGE-A": (33.00401, 72.11048),
    "VILLAGE-B": (33.03671, 72.01418),
    "VILLAGE-C": (33.00401, 72.11048),
}

import math

def village_center_coords(village_id: str) -> tuple[float, float]:
    """Retrieve canonical (lat, lon) for village, defaulting to Tamman if unknown."""
    return VILLAGE_COORDINATES.get(village_id, VILLAGE_COORDINATES["TAMMAN"])


def haversine_distance_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Calculate the great-circle distance between two GPS coordinates in kilometers."""
    R = 6371.0  # Earth's radius in km
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    delta_phi = math.radians(lat2 - lat1)
    delta_lambda = math.radians(lon2 - lon1)

    a = (math.sin(delta_phi / 2.0) ** 2 +
         math.cos(phi1) * math.cos(phi2) * math.sin(delta_lambda / 2.0) ** 2)
    c = 2.0 * math.atan2(math.sqrt(a), math.sqrt(max(0.0, 1.0 - a)))
    return round(R * c, 2)


def calculate_responder_coords(village_id: str, rank_offset: int = 0) -> tuple[float, float]:
    """Generate realistic, distinct responder coordinates relative to the village center.
    Rank 0: ~0.6 km offset
    Rank 1: ~1.4 km offset
    Rank 2: ~2.8 km offset
    """
    v_lat, v_lon = village_center_coords(village_id)
    # Target radii in km and angles for varied geographic spread
    offsets = [
        (0.6, 45.0),    # ~0.6 km NE
        (1.4, 160.0),   # ~1.4 km SSE
        (2.8, 250.0),   # ~2.8 km WSW
        (3.5, 315.0),   # ~3.5 km NW
        (4.2, 90.0),    # ~4.2 km E
    ]
    radius_km, angle_deg = offsets[rank_offset % len(offsets)]
    # 1 deg lat ~ 111 km, 1 deg lon ~ 111 km * cos(lat)
    angle_rad = math.radians(angle_deg)
    d_lat = (radius_km / 111.0) * math.sin(angle_rad)
    cos_lat = math.cos(math.radians(v_lat)) or 0.84
    d_lon = (radius_km / (111.0 * cos_lat)) * math.cos(angle_rad)

    return round(v_lat + d_lat, 5), round(v_lon + d_lon, 5)


def calculate_eta_minutes(distance_km: float) -> int:
    """Calculate realistic rural responder ETA in minutes (avg 20 km/h + 1 min prep)."""
    return max(2, int(round(distance_km * 2.5 + 1)))

