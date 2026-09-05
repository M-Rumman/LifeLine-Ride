/**
 * LifeLine Ride geography catalog.
 *
 * The product is anchored around Tamman / Talagang instead of synthetic
 * "Village A/B/C" locations. Legacy backend village ids remain supported so
 * the existing regression suite and seeded responders continue to work, while
 * the user-facing product sends real locality ids.
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
  default_report_gps: LatLng
  linked_bhu_id: string
  coverage_village_id: string
  region: 'near-tamman' | 'talagang'
}

export interface BhuGeo {
  bhu_id: string
  name: string
  name_ur: string
  union_council: string
  linked_village_ids: string[]
  location: LatLng
  approximate_location?: boolean
}

/**
 * Real localities around Tamman, using mapped locality coordinates. The exact
 * facility pin is marked approximate when only the locality coordinate is
 * available; this prevents the UI from pretending we have a precise facility
 * GPS position when we do not.
 */
export const VILLAGES: VillageGeo[] = [
  {
    village_id: 'TAMMAN',
    label_en: 'Tamman',
    label_ur: 'ٹمن',
    center: { lat: 33.00401, lng: 72.11048 },
    default_report_gps: { lat: 33.00401, lng: 72.11048 },
    linked_bhu_id: 'BHU-001',
    coverage_village_id: 'VILLAGE-A',
    region: 'near-tamman',
  },
  {
    village_id: 'DHERMOND',
    label_en: 'Dhermond',
    label_ur: 'ڈھیرمونڈ',
    center: { lat: 32.94397, lng: 72.16870 },
    default_report_gps: { lat: 32.94397, lng: 72.16870 },
    linked_bhu_id: 'BHU-003',
    coverage_village_id: 'VILLAGE-A',
    region: 'near-tamman',
  },
  {
    village_id: 'MULTAN-KHURD',
    label_en: 'Multan Khurd',
    label_ur: 'ملتان خورد',
    center: { lat: 33.03671, lng: 72.01418 },
    default_report_gps: { lat: 33.03671, lng: 72.01418 },
    linked_bhu_id: 'BHU-004',
    coverage_village_id: 'VILLAGE-B',
    region: 'near-tamman',
  },
  {
    village_id: 'PATWALI',
    label_en: 'Patwali',
    label_ur: 'پٹوالی',
    center: { lat: 33.04632, lng: 72.18192 },
    default_report_gps: { lat: 33.04632, lng: 72.18192 },
    linked_bhu_id: 'BHU-005',
    coverage_village_id: 'VILLAGE-A',
    region: 'near-tamman',
  },
  {
    village_id: 'SANGWALA',
    label_en: 'Sangwala',
    label_ur: 'سانگوالہ',
    center: { lat: 32.97588, lng: 72.23452 },
    default_report_gps: { lat: 32.97588, lng: 72.23452 },
    linked_bhu_id: 'BHU-003',
    coverage_village_id: 'VILLAGE-A',
    region: 'near-tamman',
  },
  {
    village_id: 'DAROT',
    label_en: 'Darot',
    label_ur: 'ڈاروت',
    center: { lat: 32.91573, lng: 72.18463 },
    default_report_gps: { lat: 32.91573, lng: 72.18463 },
    linked_bhu_id: 'BHU-003',
    coverage_village_id: 'VILLAGE-A',
    region: 'near-tamman',
  },
  {
    village_id: 'BEDHAR',
    label_en: 'Bedhar',
    label_ur: 'بیدھر',
    center: { lat: 32.88675, lng: 72.18538 },
    default_report_gps: { lat: 32.88675, lng: 72.18538 },
    linked_bhu_id: 'BHU-003',
    coverage_village_id: 'VILLAGE-A',
    region: 'talagang',
  },
  {
    village_id: 'WANHAR',
    label_en: 'Wanhar',
    label_ur: 'ونہار',
    center: { lat: 32.89323, lng: 72.17888 },
    default_report_gps: { lat: 32.89323, lng: 72.17888 },
    linked_bhu_id: 'BHU-003',
    coverage_village_id: 'VILLAGE-A',
    region: 'near-tamman',
  },
  {
    village_id: 'SAGHAR',
    label_en: 'Saghar',
    label_ur: 'ساغر',
    center: { lat: 32.93975, lng: 72.27128 },
    default_report_gps: { lat: 32.93975, lng: 72.27128 },
    linked_bhu_id: 'BHU-003',
    coverage_village_id: 'VILLAGE-A',
    region: 'near-tamman',
  },
  {
    village_id: 'BUDHIAL',
    label_en: 'Budhial',
    label_ur: 'بودیال',
    center: { lat: 32.99392, lng: 72.18603 },
    default_report_gps: { lat: 32.99392, lng: 72.18603 },
    linked_bhu_id: 'BHU-005',
    coverage_village_id: 'VILLAGE-A',
    region: 'near-tamman',
  },
  {
    village_id: 'JASIAL',
    label_en: 'Jasial',
    label_ur: 'جاسیا ل',
    center: { lat: 32.99784, lng: 72.39200 },
    default_report_gps: { lat: 32.99784, lng: 72.39200 },
    linked_bhu_id: 'BHU-005',
    coverage_village_id: 'VILLAGE-B',
    region: 'talagang',
  },
  {
    village_id: 'KOT-SARANG',
    label_en: 'Kot Sarang',
    label_ur: 'کوٹ سارنگ',
    center: { lat: 33.03652, lng: 72.38243 },
    default_report_gps: { lat: 33.03652, lng: 72.38243 },
    linked_bhu_id: 'BHU-005',
    coverage_village_id: 'VILLAGE-B',
    region: 'talagang',
  },
  {
    village_id: 'JHATLA',
    label_en: 'Jhatla',
    label_ur: 'جھٹلہ',
    center: { lat: 32.82310, lng: 72.38049 },
    default_report_gps: { lat: 32.82310, lng: 72.38049 },
    linked_bhu_id: 'BHU-005',
    coverage_village_id: 'VILLAGE-B',
    region: 'talagang',
  },
]

export const BHUS: BhuGeo[] = [
  {
    bhu_id: 'BHU-001',
    name: 'THQ Hospital / Regional Trauma Center (Tamman Sector)',
    name_ur: 'تحصیل ہیڈ کوارٹر ہسپتال / ایمبولینس مرکز',
    union_council: 'Talagang Regional Hub',
    linked_village_ids: ['TAMMAN', 'VILLAGE-A'],
    location: { lat: 32.9280, lng: 72.4180 }, // ~28.5 km from Tamman
    approximate_location: false,
  },
  {
    bhu_id: 'BHU-003',
    name: 'DHQ Main Emergency Hub (Dhermond / Wanhar Sector)',
    name_ur: 'ڈسٹرکٹ ٹراما و ایمرجنسی مرکز',
    union_council: 'Talagang South',
    linked_village_ids: ['DHERMOND', 'SANGWALA', 'DAROT', 'BEDHAR', 'WANHAR', 'SAGHAR'],
    location: { lat: 32.8340, lng: 72.3950 }, // ~26.0 km from Dhermond
    approximate_location: false,
  },
  {
    bhu_id: 'BHU-004',
    name: 'Regional Emergency Ambulance Center (Multan Khurd Sector)',
    name_ur: 'ریجنل ایمرجنسی و ایمبولینس مرکز',
    union_council: 'Multan Khurd / Talagang West',
    linked_village_ids: ['MULTAN-KHURD', 'VILLAGE-B'],
    location: { lat: 32.9150, lng: 72.3850 }, // ~36.8 km from Multan Khurd
    approximate_location: false,
  },
  {
    bhu_id: 'BHU-005',
    name: 'THQ Emergency Hospital (Patwali / Kot Sarang Sector)',
    name_ur: 'ٹی ایچ کیو ایمرجنسی ہسپتال',
    union_council: 'Patwali / Kot Sarang Hub',
    linked_village_ids: [
      'PATWALI',
      'BUDHIAL',
      'JASIAL',
      'KOT-SARANG',
      'JHATLA',
    ],
    location: { lat: 32.9180, lng: 72.4250 }, // ~26.5 km from Patwali
    approximate_location: false,
  },
]

/** Reporter-facing village selector. Nearby Tamman coverage is first. */
export const REPORTABLE_VILLAGES = VILLAGES.filter((v) => v.region === 'near-tamman')

/** All mapped localities for operations / discovery screens. */
export const TALAGANG_VILLAGES = [...VILLAGES]

const LEGACY_ALIASES: Record<string, VillageGeo> = {
  'VILLAGE-A': VILLAGES[0],
  'VILLAGE-B': VILLAGES[2],
  'VILLAGE-C': VILLAGES[0],
}

export function villageById(id: string | null | undefined): VillageGeo | undefined {
  if (!id) return undefined
  return VILLAGES.find((v) => v.village_id === id) ?? LEGACY_ALIASES[id]
}

export function bhuById(id: string | null | undefined): BhuGeo | undefined {
  if (!id) return undefined
  return BHUS.find((b) => b.bhu_id === id)
}

export function coverageVillageId(id: string | null | undefined): string | undefined {
  if (!id) return undefined
  return villageById(id)?.coverage_village_id ?? id
}

/** Deterministic fallback position for responders (always 1.2 km to 1.8 km from village center). */
export function responderPosition(responderId: string, villageId: string): LatLng | null {
  const village = villageById(villageId)
  if (!village) return null

  let hash = 0
  for (let i = 0; i < responderId.length; i += 1) {
    hash = (hash * 31 + responderId.charCodeAt(i)) >>> 0
  }
  // Deterministic angle & distance (1.2 km to 1.8 km)
  const angle = ((hash % 360) * Math.PI) / 180
  const radiusKm = 1.2 + ((hash >> 3) % 7) * 0.1 // 1.2 to 1.8 km
  const dLat = (radiusKm / 111.0) * Math.sin(angle)
  const dLng = (radiusKm / (111.0 * Math.cos((village.center.lat * Math.PI) / 180))) * Math.cos(angle)

  return { lat: village.center.lat + dLat, lng: village.center.lng + dLng }
}

/** Great-circle distance in kilometres. */
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

export const DEFAULT_SEED_RESPONDERS: import('./types').Responder[] = [
  // Tamman
  { responder_id: 'RESP-TAM-01', name: 'Tariq Mahmood', village: 'TAMMAN', linked_bhu_id: 'BHU-001', current_availability_status: 'available', is_verified: true },
  { responder_id: 'RESP-TAM-02', name: 'Farhan Ali', village: 'TAMMAN', linked_bhu_id: 'BHU-001', current_availability_status: 'available', is_verified: true },
  { responder_id: 'RESP-TAM-03', name: 'Zubair Khan', village: 'TAMMAN', linked_bhu_id: 'BHU-001', current_availability_status: 'available', is_verified: true },
  // Dhermond
  { responder_id: 'RESP-DHR-01', name: 'Malik Aslam', village: 'DHERMOND', linked_bhu_id: 'BHU-003', current_availability_status: 'available', is_verified: true },
  { responder_id: 'RESP-DHR-02', name: 'Hamza Rasheed', village: 'DHERMOND', linked_bhu_id: 'BHU-003', current_availability_status: 'available', is_verified: true },
  { responder_id: 'RESP-DHR-03', name: 'Usman Qureshi', village: 'DHERMOND', linked_bhu_id: 'BHU-003', current_availability_status: 'available', is_verified: true },
  // Multan Khurd
  { responder_id: 'RESP-MLT-01', name: 'Bilal Shah', village: 'MULTAN-KHURD', linked_bhu_id: 'BHU-004', current_availability_status: 'available', is_verified: true },
  { responder_id: 'RESP-MLT-02', name: 'Kashif Nadeem', village: 'MULTAN-KHURD', linked_bhu_id: 'BHU-004', current_availability_status: 'available', is_verified: true },
  { responder_id: 'RESP-MLT-03', name: 'Waqas Ahmed', village: 'MULTAN-KHURD', linked_bhu_id: 'BHU-004', current_availability_status: 'available', is_verified: true },
  // Patwali
  { responder_id: 'RESP-PAT-01', name: 'Adnan Siddiqui', village: 'PATWALI', linked_bhu_id: 'BHU-005', current_availability_status: 'available', is_verified: true },
  { responder_id: 'RESP-PAT-02', name: 'Naveed Iqbal', village: 'PATWALI', linked_bhu_id: 'BHU-005', current_availability_status: 'available', is_verified: true },
  { responder_id: 'RESP-PAT-03', name: 'Sohail Abbas', village: 'PATWALI', linked_bhu_id: 'BHU-005', current_availability_status: 'available', is_verified: true },
  // Sangwala
  { responder_id: 'RESP-SNG-01', name: 'Mohsin Raza', village: 'SANGWALA', linked_bhu_id: 'BHU-003', current_availability_status: 'available', is_verified: true },
  { responder_id: 'RESP-SNG-02', name: 'Arslan Javed', village: 'SANGWALA', linked_bhu_id: 'BHU-003', current_availability_status: 'available', is_verified: true },
  { responder_id: 'RESP-SNG-03', name: 'Babar Azam', village: 'SANGWALA', linked_bhu_id: 'BHU-003', current_availability_status: 'available', is_verified: true },
  // Darot
  { responder_id: 'RESP-DRT-01', name: 'Kamran Akmal', village: 'DAROT', linked_bhu_id: 'BHU-003', current_availability_status: 'available', is_verified: true },
  { responder_id: 'RESP-DRT-02', name: 'Faisal Masood', village: 'DAROT', linked_bhu_id: 'BHU-003', current_availability_status: 'available', is_verified: true },
  { responder_id: 'RESP-DRT-03', name: 'Zahid Hussain', village: 'DAROT', linked_bhu_id: 'BHU-003', current_availability_status: 'available', is_verified: true },
  // Wanhar
  { responder_id: 'RESP-WNH-01', name: 'Sajid Mehmood', village: 'WANHAR', linked_bhu_id: 'BHU-003', current_availability_status: 'available', is_verified: true },
  { responder_id: 'RESP-WNH-02', name: 'Tanveer Shah', village: 'WANHAR', linked_bhu_id: 'BHU-003', current_availability_status: 'available', is_verified: true },
  { responder_id: 'RESP-WNH-03', name: 'Qasim Ali', village: 'WANHAR', linked_bhu_id: 'BHU-003', current_availability_status: 'available', is_verified: true },
  // Saghar
  { responder_id: 'RESP-SGH-01', name: 'Rashid Minhas', village: 'SAGHAR', linked_bhu_id: 'BHU-003', current_availability_status: 'available', is_verified: true },
  { responder_id: 'RESP-SGH-02', name: 'Irfan Haider', village: 'SAGHAR', linked_bhu_id: 'BHU-003', current_availability_status: 'available', is_verified: true },
  { responder_id: 'RESP-SGH-03', name: 'Shahid Afridi', village: 'SAGHAR', linked_bhu_id: 'BHU-003', current_availability_status: 'available', is_verified: true },
  // Budhial
  { responder_id: 'RESP-BDH-01', name: 'Haris Rauf', village: 'BUDHIAL', linked_bhu_id: 'BHU-005', current_availability_status: 'available', is_verified: true },
  { responder_id: 'RESP-BDH-02', name: 'Shoaib Akhtar', village: 'BUDHIAL', linked_bhu_id: 'BHU-005', current_availability_status: 'available', is_verified: true },
  { responder_id: 'RESP-BDH-03', name: 'Imran Nazir', village: 'BUDHIAL', linked_bhu_id: 'BHU-005', current_availability_status: 'available', is_verified: true },
]
