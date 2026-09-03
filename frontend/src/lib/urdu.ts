/**
 * Urdu-first copy layer.
 *
 * The backend already emits localised `message_urdu` strings inside
 * `incident.reporter_updates`, and those are authoritative — this module only
 * supplies (a) fallbacks for stages the backend has not localised yet,
 * (b) English glosses for the presenter, and (c) label/colour metadata for
 * tiers, statuses and outcomes.
 */

import type { AvailabilityStatus, OutcomeType, SeverityTier } from './types'

// ---------------------------------------------------------------------------
// Timeline stages
// ---------------------------------------------------------------------------

export interface StageMeta {
  label_en: string
  /** Fallback only — prefer update.message_urdu from the backend. */
  fallback_ur: string
  /** Step order used to render the vertical progress bar. */
  order: number
  tone: 'cyan' | 'mint' | 'critical' | 'ash'
}

export const STAGE_META: Record<string, StageMeta> = {
  reported: {
    label_en: 'Report received',
    fallback_ur:
      'آپ کی ایمرجنسی کی اطلاع موصول ہو چکی ہے۔ سسٹم قریبی رضاکار تلاش کر رہا ہے۔',
    order: 1,
    tone: 'cyan',
  },
  responder_notified: {
    label_en: 'Responder notified',
    fallback_ur: 'قریبی مددگار کو اطلاع بھیج دی گئی ہے۔',
    order: 2,
    tone: 'cyan',
  },
  responder_en_route: {
    label_en: 'Responder en route',
    fallback_ur:
      'مددگار نے الرٹ قبول کر لیا ہے اور وہ جائے وقوعہ کی طرف روانہ ہیں۔',
    order: 3,
    tone: 'cyan',
  },
  responder_arrived: {
    label_en: 'Responder on scene',
    fallback_ur: 'مددگار جائے وقوعہ پر پہنچ چکے ہیں۔',
    order: 4,
    tone: 'mint',
  },
  bhu_notified: {
    label_en: 'BHU notified',
    fallback_ur: 'بنیادی مرکزِ صحت کو اطلاع دے دی گئی ہے۔',
    order: 5,
    tone: 'cyan',
  },
  ambulance_en_route: {
    label_en: 'Ambulance requested',
    fallback_ur: 'ایمبولینس طلب کر لی گئی ہے۔',
    order: 6,
    tone: 'critical',
  },
  closed: {
    label_en: 'Incident closed',
    fallback_ur: 'مریض کو بحفاظت بنیادی مرکزِ صحت منتقل کر دیا گیا ہے۔',
    order: 7,
    tone: 'mint',
  },
}

export function stageMeta(stage: string): StageMeta {
  return (
    STAGE_META[stage] ?? {
      label_en: stage,
      fallback_ur: stage,
      order: 99,
      tone: 'ash',
    }
  )
}

// ---------------------------------------------------------------------------
// Severity tiers — always an explicit, inspectable label (never opaque)
// ---------------------------------------------------------------------------

export interface TierMeta {
  label_en: string
  label_ur: string
  /** Module number from the spec's Tier 1/2/3 vocabulary. */
  tier_no: string
  text: string
  bg: string
  border: string
  dot: string
  pulse: string
}

export const TIER_META: Record<SeverityTier, TierMeta> = {
  critical: {
    label_en: 'Critical',
    label_ur: 'نازک',
    tier_no: 'Tier 3',
    text: 'text-tier-critical',
    bg: 'bg-tier-critical/15',
    border: 'border-tier-critical/60',
    dot: 'bg-tier-critical',
    pulse: 'animate-pulse-ring-critical',
  },
  moderate: {
    label_en: 'Moderate',
    label_ur: 'درمیانہ',
    tier_no: 'Tier 2',
    text: 'text-clinical-cyan',
    bg: 'bg-clinical-cyan/12',
    border: 'border-clinical-cyan/55',
    dot: 'bg-clinical-cyan',
    pulse: 'animate-pulse-ring',
  },
  minor: {
    label_en: 'Minor',
    label_ur: 'معمولی',
    tier_no: 'Tier 1',
    text: 'text-tier-minor',
    bg: 'bg-tier-minor/12',
    border: 'border-tier-minor/45',
    dot: 'bg-tier-minor',
    pulse: '',
  },
}

export function tierMeta(tier: SeverityTier | null | undefined): TierMeta {
  return TIER_META[tier ?? 'moderate']
}

// ---------------------------------------------------------------------------
// Lifecycle / dispatch status
// ---------------------------------------------------------------------------

export const STATUS_URDU: Record<string, { en: string; ur: string }> = {
  open: { en: 'Open', ur: 'کھلا' },
  dispatched: { en: 'Dispatched', ur: 'مددگار بھیج دیا گیا' },
  escalated_bhu_only: { en: 'BHU only', ur: 'صرف مرکزِ صحت' },
  no_responders_available: { en: 'No responders', ur: 'کوئی مددگار دستیاب نہیں' },
  no_resources: { en: 'No resources', ur: 'وسائل دستیاب نہیں' },
  closed: { en: 'Closed', ur: 'بند' },
  acknowledged: { en: 'Acknowledged', ur: 'تصدیق شدہ' },
}

export function statusLabel(status: string | null | undefined): {
  en: string
  ur: string
} {
  if (!status) return { en: 'Unknown', ur: 'نامعلوم' }
  return STATUS_URDU[status] ?? { en: status, ur: status }
}

// ---------------------------------------------------------------------------
// Responder availability
// ---------------------------------------------------------------------------

export const AVAILABILITY_META: Record<
  AvailabilityStatus,
  { en: string; ur: string; text: string; bg: string; border: string }
> = {
  available: {
    en: 'Available',
    ur: 'دستیاب',
    text: 'text-mint-vital',
    bg: 'bg-mint-vital/12',
    border: 'border-mint-vital/50',
  },
  busy: {
    en: 'On incident',
    ur: 'مصروف',
    text: 'text-clinical-cyan',
    bg: 'bg-clinical-cyan/12',
    border: 'border-clinical-cyan/50',
  },
  offline: {
    en: 'Offline',
    ur: 'آف لائن',
    text: 'text-ash',
    bg: 'bg-ash/10',
    border: 'border-iris-border',
  },
  unverified: {
    en: 'Unverified',
    ur: 'غیر تصدیق شدہ',
    text: 'text-tier-minor',
    bg: 'bg-tier-minor/10',
    border: 'border-tier-minor/40',
  },
}

export function availabilityMeta(status: string | null | undefined) {
  return (
    AVAILABILITY_META[(status ?? 'offline') as AvailabilityStatus] ??
    AVAILABILITY_META.offline
  )
}

// ---------------------------------------------------------------------------
// Outcomes — literals must match lifecycle.VALID_OUTCOMES exactly
// ---------------------------------------------------------------------------

export const OUTCOME_OPTIONS: {
  value: OutcomeType
  label_en: string
  label_ur: string
}[] = [
  {
    value: 'taken_to_bhu',
    label_en: 'Taken to BHU',
    label_ur: 'بنیادی مرکزِ صحت منتقل',
  },
  {
    value: 'self-resolved',
    label_en: 'Self resolved',
    label_ur: 'موقع پر حل',
  },
  {
    value: 'referred_to_hospital',
    label_en: 'Referred to hospital',
    label_ur: 'ہسپتال بھیجا گیا',
  },
  {
    value: 'unresolved',
    label_en: 'Unresolved',
    label_ur: 'غیر حل شدہ',
  },
]

export function outcomeLabel(value: string | null | undefined) {
  if (!value) return { en: '—', ur: '—' }
  const hit = OUTCOME_OPTIONS.find((o) => o.value === value)
  return hit
    ? { en: hit.label_en, ur: hit.label_ur }
    : { en: value, ur: value }
}

/** lifecycle.VALID_CONFIRMERS — only these two close an incident. */
export const CONFIRMER_OPTIONS: {
  value: 'bhu_staff' | 'responder'
  label_en: string
  label_ur: string
  note: string
}[] = [
  {
    value: 'bhu_staff',
    label_en: 'BHU staff (verified)',
    label_ur: 'مرکزِ صحت عملہ (تصدیق شدہ)',
    note: 'Counts toward Module 5 accountability metrics.',
  },
  {
    value: 'responder',
    label_en: 'Responder (self-reported)',
    label_ur: 'مددگار (خود رپورٹ)',
    note: 'Fraud gate: self-reported closures are never counted.',
  },
]

// ---------------------------------------------------------------------------
// Equipment inspection checklist (Module 7 sign-off)
// ---------------------------------------------------------------------------

export const EQUIPMENT_ITEMS: { value: string; label_en: string; label_ur: string }[] = [
  { value: 'tourniquet', label_en: 'Tourniquet', label_ur: 'ٹورنیکٹ' },
  { value: 'pressure_bandages', label_en: 'Pressure bandages', label_ur: 'پٹیاں' },
  { value: 'splints', label_en: 'Splints', label_ur: 'سپلنٹ' },
  { value: 'antiseptic', label_en: 'Antiseptic', label_ur: 'جراثیم کش' },
]

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** Clock time for timeline rows. Falls back to the raw string on bad input. */
export function formatClock(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
}

/** Seconds elapsed since an ISO timestamp — used for live response timing. */
export function secondsSince(iso: string | null | undefined): number | null {
  if (!iso) return null
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return null
  return Math.max(0, Math.round((Date.now() - t) / 1000))
}

/** Humanised duration for the accountability scorecard. */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || Number.isNaN(seconds)) return '—'
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`
  const m = Math.floor(seconds / 60)
  const s = Math.round(seconds % 60)
  return `${m}m ${s}s`
}

/** Title-case a snake_case injury flag for display. */
export function humaniseFlag(flag: string): string {
  return flag
    .split('_')
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ')
}
