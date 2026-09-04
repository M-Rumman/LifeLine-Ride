/**
 * Screen 0 — The Gateway (`/`).
 *
 * One job: let a visitor enter the system as the role they actually are.
 * Minimal navbar, high-impact hero, three large clean cards.
 *
 * The cards are wired to live state rather than being decorative: if an
 * incident is already open, the responder card names it and the reporter card
 * shows the tier it resolved to, so the gateway doubles as an honest status
 * board during a demo.
 *
 * Colour roles are respected — rose is the distress action itself, cyan is the
 * field responder's live work, emerald is the BHU's verification/sign-off.
 */

import type { ReactNode } from 'react'

import {
  ROUTE_FOR_ROLE,
  useCockpit,
  type Role,
} from '../state/CockpitContext'
import { BHUS, REPORTABLE_VILLAGES, VILLAGES } from '../lib/geography'
import { statusLabel } from '../lib/urdu'
import { StatusDot, TierBadge } from '../components/ui'

interface RoleCardCopy {
  role: Role
  step: number
  title_en: string
  title_ur: string
  audience_en: string
  audience_ur: string
  body_en: string
  body_ur: string
  cta_en: string
  cta_ur: string
  /** Solid rose for the distress action; tinted outline for the other two. */
  ctaClass: string
  ring: string
  icon: 'distress' | 'responder' | 'clinic'
}

const CARDS: RoleCardCopy[] = [
  {
    role: 'reporter',
    step: 1,
    title_en: 'Report Emergency',
    title_ur: 'رپورٹ کریں',
    audience_en: 'For bystanders & family',
    audience_ur: 'عینی شاہدین اور اہلِ خانہ کے لیے',
    body_en:
      'Speak or type in Urdu. AI triage reads the injury, then dispatches the nearest verified volunteer and the linked health unit at once.',
    body_ur:
      'اردو میں بولیں یا لکھیں۔ مصنوعی ذہانت حادثے کا جائزہ لیتی ہے اور قریبی تصدیق شدہ رضاکار اور منسلک مرکزِ صحت کو فوراً اطلاع دیتی ہے۔',
    cta_en: 'Report an Emergency',
    cta_ur: 'ایمرجنسی رپورٹ کریں',
    ctaClass: 'pill-solid-danger',
    ring: 'hover:border-rose-500/60',
    icon: 'distress',
  },
  {
    role: 'responder',
    step: 2,
    title_en: 'Field Responder',
    title_ur: 'فرسٹ رسپانڈر',
    audience_en: 'For registered village volunteers',
    audience_ur: 'رجسٹرڈ دیہی رضاکاروں کے لیے',
    body_en:
      'Open your active dispatch, accept the call-out, and follow hands-free Urdu audio first-aid guidance step by step until the patient is handed over.',
    body_ur:
      'اپنا فعال ڈسپیچ کھولیں، کال قبول کریں اور مریض کی منتقلی تک اردو آواز میں پہلی طبی امداد کی قدم بہ قدم رہنمائی حاصل کریں۔',
    cta_en: 'Open Active Dispatch',
    cta_ur: 'فعال ڈسپیچ کھولیں',
    ctaClass: 'pill-cyan',
    ring: 'hover:border-sky-500/60',
    icon: 'responder',
  },
  {
    role: 'bhu',
    step: 3,
    title_en: 'BHU Console',
    title_ur: 'بنیادی مرکز صحت',
    audience_en: 'For clinical staff & doctors',
    audience_ur: 'طبی عملے اور ڈاکٹرز کے لیے',
    body_en:
      'Live situation tracking, candidate equipment verification, and formal incident sign-off — the only closure that counts toward responder accountability.',
    body_ur:
      'براہِ راست صورتحال، امیدوار رضاکاروں کی تصدیق اور واقعے کی باقاعدہ منظوری — صرف یہی کلوزر احتسابی ریکارڈ میں شمار ہوتا ہے۔',
    cta_en: 'Open Clinical Console',
    cta_ur: 'کلینیکل کنسول کھولیں',
    ctaClass: 'pill-mint',
    ring: 'hover:border-emerald-500/60',
    icon: 'clinic',
  },
]

export function LandingView() {
  const { lang, navigate, incident, incidentId, timeline, responders } = useCockpit()

  const status = statusLabel(timeline?.status ?? null)
  const tier = incident?.severity_tier ?? timeline?.severity_tier ?? null
  const isOpen = Boolean(incidentId) && timeline?.status !== 'closed'

  // Live registry figures — derived, never hardcoded, so the strip cannot
  // drift from what the backend actually has.
  const verifiedAvailable = responders.filter(
    (r) => r.is_verified && r.current_availability_status === 'available',
  ).length
  const pendingVerification = responders.filter((r) => !r.is_verified).length

  /** One entry point per card — `navigate` also keeps `role` in step. */
  function enter(role: Role) {
    navigate(ROUTE_FOR_ROLE[role])
  }

  return (
    <div className="mx-auto w-full max-w-6xl px-4 pb-14 pt-10 sm:px-6 sm:pt-16">
      {/* ---------------- Hero ---------------- */}
      <div className="mx-auto max-w-3xl text-center">
        <span className="inline-flex items-center gap-2 rounded-full border border-slate-800 bg-surface px-3.5 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-muted">
          <StatusDot tone="cyan" pulse />
          {lang === 'ur' ? 'دیہی ایمرجنسی رسپانس نیٹ ورک' : 'Village Emergency Response Network'}
        </span>

        <h1 className="mt-6 text-balance text-4xl font-extrabold leading-[1.1] tracking-tighter text-ink sm:text-5xl">
          {lang === 'ur' ? (
            <span dir="rtl" className="block font-urdu text-[34px] leading-[2.4] sm:text-[42px]">
              دیہی علاقوں میں ایمرجنسی طبی امداد کا خودکار نظام
            </span>
          ) : (
            <>
              Seconds Save Lives{' '}
              <span className="text-sky-400">in Rural Trauma.</span>
            </>
          )}
        </h1>

        <p className="mt-5 text-balance text-[15px] leading-7 text-ink-muted sm:text-base">
          {lang === 'ur' ? (
            <span dir="rtl" className="font-urdu text-[16px] leading-9">
              ایک اردو رپورٹ سے ٹرائی ایج، رضاکار کی روانگی اور پہلی طبی امداد کی رہنمائی —
              سب کچھ ایک ہی منٹ میں۔
            </span>
          ) : (
            <>
              One Urdu voice note triggers AI triage, ranked responder dispatch and
              hands-free first-aid guidance — before an ambulance could be reached by phone.
            </>
          )}
        </p>
      </div>

      {/* ---------------- Live incident ribbon ---------------- */}
      {incidentId && (
        <div
          className={`mx-auto mt-9 flex max-w-3xl flex-wrap items-center justify-center gap-x-3 gap-y-2 rounded-2xl border px-5 py-3 text-xs ${
            isOpen && tier === 'critical'
              ? 'border-rose-500/40 bg-rose-500/10 text-rose-200'
              : 'border-slate-800 bg-surface text-ink-muted'
          }`}
        >
          <StatusDot tone={isOpen ? (tier === 'critical' ? 'critical' : 'cyan') : 'mint'} pulse={isOpen} />
          <span className="font-mono font-bold text-ink">{incidentId}</span>
          <span>·</span>
          <span className="font-semibold">
            {lang === 'ur' ? status.ur : status.en}
          </span>
          <span className="font-urdu text-[12px] opacity-80" dir="rtl">
            {lang === 'ur' ? status.en : status.ur}
          </span>
          {tier && <TierBadge tier={tier} size="sm" />}
        </div>
      )}

      {/* ---------------- Role selection cards ---------------- */}
      <div className="mt-10 grid gap-5 md:grid-cols-3">
        {CARDS.map((c) => (
          <RoleCard
            key={c.role}
            copy={c}
            lang={lang}
            onEnter={() => enter(c.role)}
            liveSlot={<LiveCardState role={c.role} />}
          />
        ))}
      </div>

      {/* ---------------- Stat strip ---------------- */}
      <div className="mt-10 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat
          value={REPORTABLE_VILLAGES.length}
          labelEn="reportable villages"
          labelUr="رپورٹ کے قابل گاؤں"
          hint={`${VILLAGES.length} registered`}
        />
        <Stat
          value={verifiedAvailable}
          labelEn="responders available"
          labelUr="دستیاب رضاکار"
          tone="cyan"
          hint={`${responders.length} on the registry`}
        />
        <Stat
          value={BHUS.length}
          labelEn="linked health units"
          labelUr="منسلک مراکزِ صحت"
          tone="mint"
          hint={pendingVerification > 0 ? `${pendingVerification} awaiting verification` : 'all verified'}
        />
        <Stat
          value={3}
          labelEn="simultaneous alerts"
          labelUr="بیک وقت اطلاعات"
          hint="responder · BHU · ambulance"
        />
      </div>

      {/* ---------------- Healthcare guardrail ---------------- */}
      <p className="mx-auto mt-10 max-w-2xl text-center text-[11px] leading-6 text-ink-dim">
        {lang === 'ur' ? (
          <span dir="rtl" className="font-urdu text-[13px] leading-8">
            یہ نظام مدد فراہم کرتا ہے، تشخیص نہیں۔ ٹرائی ایج کا درجہ ہمیشہ ایک شفاف
            JSON فیصلے کے طور پر دکھایا جاتا ہے اور حتمی طبی رائے مرکزِ صحت کی ہوتی ہے۔
          </span>
        ) : (
          <>
            This system assists — it does not diagnose. Every triage tier is shown as a
            transparent, inspectable decision with its reasoning flags, and final medical
            judgement always rests with the Basic Health Unit.
          </>
        )}
      </p>
    </div>
  )
}

// ===========================================================================
// Card
// ===========================================================================

function RoleCard({
  copy,
  lang,
  onEnter,
  liveSlot,
}: {
  copy: RoleCardCopy
  lang: 'ur' | 'en'
  onEnter: () => void
  liveSlot: ReactNode
}) {
  const title = lang === 'ur' ? copy.title_ur : copy.title_en
  const secondary = lang === 'ur' ? copy.title_en : copy.title_ur
  const audience = lang === 'ur' ? copy.audience_ur : copy.audience_en
  const body = lang === 'ur' ? copy.body_ur : copy.body_en
  const cta = lang === 'ur' ? copy.cta_ur : copy.cta_en
  const ctaSecondary = lang === 'ur' ? copy.cta_en : copy.cta_ur

  return (
    <div
      className={`card flex flex-col rounded-2xl border-slate-800/80 p-7 transition-colors ${copy.ring}`}
    >
      <div className="flex items-center justify-between gap-3">
        <span className="grid h-11 w-11 place-items-center rounded-2xl border border-slate-800 bg-sunken">
          <CardIcon kind={copy.icon} />
        </span>
        <span className="font-mono text-[10px] font-bold uppercase tracking-widest text-ink-dim">
          Step {copy.step}
        </span>
      </div>

      <h2 className="mt-5 text-[19px] font-bold tracking-tight text-ink">
        <span className={lang === 'ur' ? 'font-urdu text-[21px] leading-10' : ''}>{title}</span>
        <span
          className={`mt-0.5 block text-[11px] font-medium ${lang === 'ur' ? '' : 'font-urdu text-[12px]'}`}
          dir={lang === 'ur' ? 'ltr' : 'rtl'}
        >
          <span className="text-ink-dim">{secondary}</span>
        </span>
      </h2>

      <p className="mt-1 text-[11px] font-semibold uppercase tracking-wider text-ink-muted">
        {lang === 'ur' ? (
          <span dir="rtl" className="font-urdu text-[12px] normal-case tracking-normal">
            {audience}
          </span>
        ) : (
          audience
        )}
      </p>

      <p
        className={`mt-4 flex-1 text-[13px] leading-6 text-ink-muted ${
          lang === 'ur' ? 'font-urdu text-[14px] leading-9' : ''
        }`}
        dir={lang === 'ur' ? 'rtl' : 'ltr'}
      >
        {body}
      </p>

      <div className="mt-5 min-h-[26px]">{liveSlot}</div>

      <button
        type="button"
        onClick={onEnter}
        className={`${copy.ctaClass} mt-4 w-full px-5 py-3.5 text-sm`}
      >
        <span className={lang === 'ur' ? 'font-urdu text-[16px] leading-7' : ''}>{cta}</span>
        <span className="text-[11px] opacity-70" dir={lang === 'ur' ? 'ltr' : 'rtl'}>
          {ctaSecondary}
        </span>
      </button>
    </div>
  )
}

/**
 * Per-card live state. Deliberately honest: the responder card only claims an
 * "active dispatch" when an incident is genuinely open, otherwise it says so.
 */
function LiveCardState({ role }: { role: Role }) {
  const { incidentId, timeline, incident, responders, lang } = useCockpit()
  const isOpen = Boolean(incidentId) && timeline?.status !== 'closed'

  if (role === 'reporter') {
    if (!isOpen) {
      return (
        <span className="inline-flex items-center gap-2 rounded-full border border-rose-500/35 bg-rose-500/10 px-3 py-1 text-[11px] font-semibold text-rose-300">
          <StatusDot tone="critical" />
          {lang === 'ur' ? 'کوئی فعال ایمرجنسی نہیں' : 'No active emergency'}
        </span>
      )
    }
    return (
      <span className="inline-flex items-center gap-2 rounded-full border border-slate-700 bg-raised/60 px-3 py-1 text-[11px] font-semibold text-slate-300">
        <span className="font-mono">{incidentId}</span>
        {incident?.gps_location.village_id}
      </span>
    )
  }

  if (role === 'responder') {
    if (!isOpen) {
      return (
        <span className="inline-flex items-center gap-2 rounded-full border border-slate-800 bg-sunken px-3 py-1 text-[11px] font-medium text-ink-dim">
          <StatusDot tone="ash" />
          {lang === 'ur' ? 'فی الحال کوئی ڈسپیچ نہیں' : 'No dispatch to open right now'}
        </span>
      )
    }
    const assigned = incident?.responder_assigned_id ?? timeline?.assigned_responder ?? null
    const name = responders.find((r) => r.responder_id === assigned)?.name
    return (
      <span className="inline-flex items-center gap-2 rounded-full border border-sky-500/35 bg-sky-500/10 px-3 py-1 text-[11px] font-semibold text-sky-300">
        <StatusDot tone="cyan" pulse />
        {lang === 'ur' ? 'فعال ڈسپیچ' : 'Active dispatch'}
        <span className="font-mono">{incidentId}</span>
        {name && <span className="opacity-80">· {name}</span>}
      </span>
    )
  }

  // bhu
  return (
    <span
      className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-[11px] font-semibold ${
        isOpen
          ? 'border-emerald-500/35 bg-emerald-500/10 text-emerald-300'
          : 'border-slate-800 bg-sunken text-ink-dim'
      }`}
    >
      <StatusDot tone={isOpen ? 'mint' : 'ash'} />
      {isOpen
        ? lang === 'ur'
          ? 'تصديق کے لیے کھلا واقعہ'
          : 'Open incident awaiting sign-off'
        : lang === 'ur'
          ? 'رجسٹری اور آڈٹ تیار ہے'
          : 'Registry & audit ready'}
    </span>
  )
}

function Stat({
  value,
  labelEn,
  labelUr,
  hint,
  tone = 'pearl',
}: {
  value: number
  labelEn: string
  labelUr: string
  hint?: string
  tone?: 'pearl' | 'cyan' | 'mint'
}) {
  const { lang } = useCockpit()
  const tones: Record<string, string> = {
    pearl: 'text-ink',
    cyan: 'text-sky-400',
    mint: 'text-emerald-400',
  }
  return (
    <div className="rounded-2xl border border-slate-800/80 bg-surface px-4 py-3.5 text-center">
      <p className={`text-2xl font-bold tracking-tighter tabular-nums ${tones[tone]}`}>{value}</p>
      <p className="mt-0.5 text-[11px] font-semibold text-ink-muted">
        {lang === 'ur' ? (
          <span dir="rtl" className="font-urdu text-[12px]">{labelUr}</span>
        ) : (
          labelEn
        )}
      </p>
      {hint && <p className="mt-0.5 text-[10px] text-ink-dim">{hint}</p>}
    </div>
  )
}

function CardIcon({ kind }: { kind: 'distress' | 'responder' | 'clinic' }) {
  if (kind === 'distress') {
    return (
      <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" aria-hidden="true">
        <path
          d="M3 12h3.5l2-5 3.5 10 2.5-6 1.8 3H21"
          stroke="#ef4444"
          strokeWidth="1.9"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    )
  }
  if (kind === 'responder') {
    return (
      <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" aria-hidden="true">
        <path
          d="M12 21s7-5.2 7-11a7 7 0 1 0-14 0c0 5.8 7 11 7 11Z"
          stroke="#0ea5e9"
          strokeWidth="1.8"
          strokeLinejoin="round"
        />
        <circle cx="12" cy="10" r="2.4" stroke="#0ea5e9" strokeWidth="1.8" />
      </svg>
    )
  }
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" aria-hidden="true">
      <path
        d="M12 5v14M5 12h14"
        stroke="#10b981"
        strokeWidth="2.1"
        strokeLinecap="round"
      />
      <rect
        x="3.2"
        y="3.2"
        width="17.6"
        height="17.6"
        rx="4.5"
        stroke="#10b981"
        strokeWidth="1.6"
        opacity=".55"
      />
    </svg>
  )
}
