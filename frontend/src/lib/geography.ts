/**
 * Village / BHU geography for the Live Situation Map.
 *
 * HONESTY NOTE: the backend streams the reporter's real GPS
 * (`incident.gps_location`) but does NOT expose live responder or BHU
 * coordinates. Responder and clinic markers are therefore derived from the
 * seed registry's village association (backend/slice_runner.py SEED_RESPONDERS
 * / SEED_BHUS) with a deterministic per-id offset so overlapping markers stay
 * distinguishable. The map caption states this in the UI.
 */

export interface LatLng {
  lat: number
  lng: number
}

export interface VillageGeo {
  village_id: string
  label_en: string
  label_ur: string
  center: LatLng
  /** Default reporter GPS pre-filled by the Reporter View. */
  default_report_gps: LatLng
  linked_bhu_id: string
}

export interface BhuGeo {
  bhu_id: string
  name: string
  union_council: string
  linked_village_ids: string[]
  location: LatLng
}

// Rural Punjab reference frame (the live API test uses 31.5204, 74.3587).
export const VILLAGES: VillageGeo[] = [
  {
    village_id: 'VILLAGE-A',
    label_en: 'Village A — Chak 45',
    label_ur: 'گاؤں اے — چک ۴۵',
    center: { lat: 31.5204, lng: 74.3587 },
    default_report_gps: { lat: 31.5204, lng: 74.3587 },
    linked_bhu_id: 'BHU-001',
  },
  {
    village_id: 'VILLAGE-B',
    label_en: 'Village B — Chak 51',
    label_ur: 'گاؤں بی — چک ۵۱',
    center: { lat: 31.5662, lng: 74.3121 },
    default_report_gps: { lat: 31.5662, lng: 74.3121 },
    linked_bhu_id: 'BHU-001',
  },
  {
    village_id: 'VILLAGE-C',
    label_en: 'Village C — Dera Ghazi',
    label_ur: 'گاؤں سی — ڈیرہ غازی',
    center: { lat: 30.0501, lng: 70.6449 },
    default_report_gps: { lat: 30.0501, lng: 70.6449 },
    linked_bhu_id: 'BHU-002',
  },
]

export const BHUS: BhuGeo[] = [
  {
    bhu_id: 'BHU-001',
    name: 'Chak 45 Basic Health Unit',
    union_council: 'UC-7 North',
    linked_village_ids: ['VILLAGE-A', 'VILLAGE-B'],
    location: { lat: 31.5437, lng: 74.3372 },
  },
  {
    bhu_id: 'BHU-002',
    name: 'Dera Ghazi Union Health Center',
    union_council: 'UC-12 South',
    linked_village_ids: ['VILLAGE-C'],
    location: { lat: 30.0612, lng: 70.6318 },
  },
]

/** Villages the Reporter View offers in its dropdown (per the brief). */
export const REPORTABLE_VILLAGES = VILLAGES.filter((v) =>
  ['VILLAGE-A', 'VILLAGE-B'].includes(v.village_id),
)

export function villageById(id: string | null | undefined): VillageGeo | undefined {
  if (!id) return undefined
  return VILLAGES.find((v) => v.village_id === id)
}

export function bhuById(id: string | null | undefined): BhuGeo | undefined {
  if (!id) return undefined
  return BHUS.find((b) => b.bhu_id === id)
}

/**
 * Deterministic small offset so several responders from the same village do not
 * render as one indistinguishable dot. Stable across renders (hash of the id),
 * never random — the map must not jitter on every 2.5s poll.
 */
export function responderPosition(
  responderId: string,
  villageId: string,
): LatLng | null {
  const village = villageById(villageId)
  if (!village) return null

  let hash = 0
  for (let i = 0; i < responderId.length; i += 1) {
    hash = (hash * 31 + responderId.charCodeAt(i)) >>> 0
  }
  // +/- ~700m scatter, quantised so it stays visually sane.
  const dLat = (((hash % 13) - 6) / 6) * 0.0063
  const dLng = ((((hash >> 4) % 13) - 6) / 6) * 0.0075

  return { lat: village.center.lat + dLat, lng: village.center.lng + dLng }
}

/** Great-circle distance in kilometres (haversine) for the alert card. */
export function distanceKm(a: LatLng, b: LatLng): number {
  const R = 6371
  const toRad = (deg: number) => (deg * Math.PI) / 180
  const dLat = toRad(b.lat - a.lat)
  const dLng = toRad(b.lng - a.lng)
  const lat1 = toRad(a.lat)
  const lat2 = toRad(b.lat)

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)))
}
