/**
 * Global navbar (Rozgaar pattern — fixed at top, deliberately minimal).
 *
 * Contents, in order:
 *   brand wordmark (click -> gateway) · live backend/DB badge ·
 *   active-incident chip · role nav (hidden on the gateway) ·
 *   segmented English | اردو pill.
 *
 * The bilingual switcher changes STRING TRANSLATIONS ONLY. It never flips
 * `dir` on the shell, so the page structure does not mirror or reverse when
 * the language changes — Urdu runs are marked RTL individually instead.
 */

import { useState } from 'react'

import { useCockpit, ROLES, type Role } from '../state/CockpitContext'
import { statusLabel } from '../lib/urdu'
import { Pill, StatusDot } from './ui'
import { API_LABEL } from '../lib/api'

/**
 * DOM ids of the three cockpit panels, owned here because the role tabs are
 * what scroll to them. `App.tsx` imports this table so a panel and its anchor
 * cannot drift apart.
 */
export const PANEL_ANCHOR: Record<Role, string> = {
  reporter: 'panel-reporter',
  responder: 'panel-responder',
  bhu: 'panel-bhu',
}

export function Header() {
  const {
    lang,
    setLang,
    incidentId,
    incident,
    timeline,
    health,
    backendOnline,
    backendError,
    polling,
    resetDemo,
    adoptIncident,
    runQuickDemo,
  } = useCockpit()

  const [adoptValue, setAdoptValue] = useState('')
  const [showAdopt, setShowAdopt] = useState(false)
  /** Which panel the role tabs last jumped to. A scroll affordance, not a view. */
  const [focused, setFocused] = useState<Role>('reporter')

  const tier = incident?.severity_tier ?? timeline?.severity_tier ?? null
  const status = timeline?.status ?? null
  const statusText = statusLabel(status)
  const isCritical = tier === 'critical' && timeline?.status !== 'closed'

  /**
   * All three panels are on screen at once, so the role tabs JUMP to a panel
   * instead of swapping the view — a routed shell would hide the very state
   * change the judge is meant to watch.
   */
  const focusPanel = (next: Role) => {
    setFocused(next)
    document.getElementById(PANEL_ANCHOR[next])?.scrollIntoView({
      behavior: 'smooth',
      block: 'start',
      inline: 'start',
    })
  }

  return (
    <header className="sticky top-0 z-40 border-b border-slate-800 bg-canvas/90 backdrop-blur-xl">
      <div className="mx-auto flex w-full max-w-[1900px] flex-wrap items-center gap-x-4 gap-y-3 px-4 py-3 sm:px-6">
        {/* ---------------- Brand ---------------- */}
        <button
          type="button"
          onClick={() => focusPanel('reporter')}
          className="flex items-center gap-3 rounded-2xl text-left transition-opacity hover:opacity-85"
          title={lang === 'ur' ? 'رپورٹر پینل پر جائیں' : 'Jump to the reporter panel'}
        >
          <span className="grid h-10 w-10 place-items-center rounded-2xl border border-accent/35 bg-accent/10">
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" aria-hidden="true">
              <path
                d="M3 12h3.5l2-5 3.5 10 2.5-6 1.8 3H21"
                stroke="#0ea5e9"
                strokeWidth="1.9"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
          <span className="leading-tight">
            <span className="block text-[16px] font-bold tracking-tight text-ink">
              LifeLine Ride
            </span>
            <span
              dir="rtl"
              className="block font-urdu text-[11px] leading-6 text-ink-muted"
            >
              دیہی ایمرجنسی رسپانس نیٹ ورک
            </span>
          </span>
        </button>

        {/* ---------------- Live backend / database badge ---------------- */}
        <HealthChip
          online={backendOnline}
          error={backendError}
          health={health}
          polling={polling}
        />

        {/* ---------------- Active incident chip ---------------- */}
        {incidentId && (
          <div
            className={`flex items-center gap-2 rounded-full border px-3.5 py-1.5 ${
              isCritical
                ? 'border-rose-500/45 bg-rose-500/10'
                : 'border-slate-800 bg-surface'
            }`}
          >
            <StatusDot
              tone={status === 'closed' ? 'mint' : isCritical ? 'critical' : 'cyan'}
              pulse={status !== 'closed'}
            />
            <span className="font-mono text-xs font-bold text-ink">{incidentId}</span>
            <span className="hidden text-[11px] text-ink-muted sm:inline">
              {lang === 'ur' ? statusText.ur : statusText.en}
            </span>
          </div>
        )}

        {/* ---------------- Right cluster ---------------- */}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {/* Panel jump nav. Every panel is already on screen, so these move
              the eye rather than change the view. */}
          <nav
            aria-label="Panels"
            className="flex items-center gap-1 rounded-full border border-slate-800 bg-surface p-1"
          >
            {ROLES.map((r) => (
              <RoleTab
                key={r.id}
                step={r.step}
                labelEn={r.label_en}
                labelUr={r.label_ur}
                active={focused === r.id}
                lang={lang}
                onClick={() => focusPanel(r.id as Role)}
              />
            ))}
          </nav>

          {/* Always on: `runQuickDemo` signals ReporterView, which owns the
              village/evidence-pair state this needs to drive. Stays enabled
              after a report so "show me again" re-runs the whole loop in one
              click — a fresh report simply supersedes the previous incident. */}
          <Pill
            variant="cyan"
            size="sm"
            onClick={runQuickDemo}
            title="Stage the cached finger/machine-injury fixture — VILLAGE-A, PhotoshopExtension_Image (1).png + ungli.mp3 — and submit it. Served from .triage_cache, so it burns zero AI quota. Tier 3, so it exercises simultaneous responder + BHU + ambulance dispatch."
          >
            {lang === 'ur' ? 'فوری ڈیمو' : 'Quick Demo'}
          </Pill>

          {showAdopt && (
            <form
              className="flex items-center gap-1.5"
              onSubmit={(e) => {
                e.preventDefault()
                if (adoptValue.trim()) {
                  adoptIncident(adoptValue)
                  setAdoptValue('')
                  setShowAdopt(false)
                }
              }}
            >
              <input
                autoFocus
                value={adoptValue}
                onChange={(e) => setAdoptValue(e.target.value)}
                placeholder="INC-XXXXXX"
                aria-label="Adopt an existing incident id"
                className="field w-36 py-1.5 font-mono text-xs"
              />
              <Pill variant="cyan" size="sm" type="submit">
                Track
              </Pill>
            </form>
          )}

          <Pill
            variant="ghost"
            size="sm"
            onClick={() => setShowAdopt((v) => !v)}
            title="Track an incident id that already exists on the backend"
          >
            {lang === 'ur' ? 'اڈاپٹ' : 'Adopt'}
          </Pill>
          <Pill
            variant="ghost"
            size="sm"
            onClick={resetDemo}
            disabled={!incidentId}
            title="Clear the active incident from the cockpit"
          >
            {lang === 'ur' ? 'ری سیٹ' : 'Reset'}
          </Pill>

          <LangSwitcher lang={lang} setLang={setLang} />
        </div>
      </div>
    </header>
  )
}

/**
 * Persistent segmented pill: `English | اردو`. Both segments are real buttons
 * so either language is one click away and the active one is unambiguous —
 * a single toggle button cannot show which side you are on at a glance.
 */
function LangSwitcher({
  lang,
  setLang,
}: {
  lang: 'ur' | 'en'
  setLang: (lang: 'ur' | 'en') => void
}) {
  return (
    <div
      role="group"
      aria-label="Interface language"
      className="flex items-center gap-0.5 rounded-full border border-slate-800 bg-surface p-1"
    >
      <button
        type="button"
        onClick={() => setLang('en')}
        aria-pressed={lang === 'en'}
        className={`rounded-full px-3 py-1 text-[11px] font-semibold transition-colors ${
          lang === 'en'
            ? 'bg-accent text-white shadow-sm'
            : 'text-ink-muted hover:text-ink'
        }`}
      >
        English
      </button>
      <button
        type="button"
        onClick={() => setLang('ur')}
        aria-pressed={lang === 'ur'}
        className={`rounded-full px-3 py-1 font-urdu text-[13px] leading-5 font-semibold transition-colors ${
          lang === 'ur'
            ? 'bg-accent text-white shadow-sm'
            : 'text-ink-muted hover:text-ink'
        }`}
        dir="rtl"
      >
        اردو
      </button>
    </div>
  )
}

function RoleTab({
  step,
  labelEn,
  labelUr,
  active,
  lang,
  onClick,
}: {
  step: number
  labelEn: string
  labelUr: string
  active: boolean
  lang: 'ur' | 'en'
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={`pill px-3 py-1.5 text-xs transition-colors ${
        active
          ? 'bg-accent/15 text-sky-300 border border-accent/40 font-semibold'
          : 'border border-transparent text-ink-muted hover:text-ink hover:bg-raised/60'
      }`}
    >
      <span
        className={`grid h-[18px] w-[18px] place-items-center rounded-full text-[10px] font-bold tabular-nums ${
          active ? 'bg-accent/25 text-sky-200' : 'bg-raised text-ink-dim'
        }`}
      >
        {step}
      </span>
      {lang === 'ur' ? (
        <span dir="rtl" className="font-urdu text-[13px] leading-5">
          {labelUr}
        </span>
      ) : (
        <span className="font-medium tracking-tight">{labelEn}</span>
      )}
    </button>
  )
}

/**
 * Live badge: green only when the backend answers AND PostgreSQL is reachable.
 * Anything less is a red "Not Live" — a half-working backend must never read
 * as healthy during a demo.
 *
 * Also surfaces the active AI provider straight from `/health`, so a presenter
 * can see at a glance whether the next report will burn live Gemini quota or be
 * served from `.triage_cache`.
 */
function HealthChip({
  online,
  error,
  health,
  polling,
}: {
  online: boolean
  error: { code: string; message: string } | null
  health: {
    db_reachable?: boolean
    responders_loaded?: number
    helpbot_sessions?: number
    ai_provider?: string
  } | null
  polling: boolean
}) {
  const isLive = online && Boolean(health?.db_reachable)

  return (
    <div
      className="flex items-center gap-2 rounded-full border border-slate-800 bg-surface px-3.5 py-1.5"
      title={
        isLive
          ? `Backend and database healthy at ${API_LABEL}`
          : `Backend or database issue at ${API_LABEL}: ${
              error?.code ?? (online ? 'DB_UNREACHABLE' : 'NO_RESPONSE')
            } — ${error?.message ?? (online ? 'PostgreSQL unreachable' : 'Backend offline')}`
      }
    >
      <StatusDot tone={isLive ? 'mint' : 'critical'} pulse={!isLive} />
      <span
        className={`text-[12px] font-bold tracking-wide ${
          isLive ? 'text-emerald-400' : 'text-rose-400'
        }`}
      >
        {isLive ? 'Live' : 'Not Live'}
      </span>
      {polling && <span className="h-1.5 w-1.5 rounded-full bg-accent opacity-80" />}
    </div>
  )
}
