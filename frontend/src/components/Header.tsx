/**
 * Product shell header.
 *
 * Normal users stay inside their role. Cross-role navigation and demo controls
 * are intentionally confined to the Operations view.
 */

import { useState } from 'react'
import { useCockpit, ROLES, ROUTE_FOR_ROLE, type Role, type Route } from '../state/CockpitContext'
import { Pill, StatusDot } from './ui'
import { API_LABEL } from '../lib/api'

export const PANEL_ANCHOR: Record<Role, string> = {
  reporter: 'panel-reporter',
  responder: 'panel-responder',
  bhu: 'panel-bhu',
}

const ROLE_META: Record<Role, { en: string; ur: string; icon: string }> = {
  reporter: { en: 'Reporter', ur: 'رپورٹر', icon: '🚨' },
  responder: { en: 'Responder', ur: 'رسپانڈر', icon: '🛵' },
  bhu: { en: 'BHU', ur: 'مرکزِ صحت', icon: '🏥' },
}

export function Header() {
  const {
    lang,
    setLang,
    route,
    navigate,
    role,
    incidentId,
    signOut,
    health,
    backendOnline,
    backendError,
    polling,
    resetDemo,
    adoptIncident,
  } = useCockpit()

  const isOperations = route === '/operations'
  const isLanding = route === '/'
  const [adoptValue, setAdoptValue] = useState('')
  const [showAdopt, setShowAdopt] = useState(false)

  return (
    <header className="sticky top-0 z-40 border-b border-slate-800/80 bg-canvas/90 backdrop-blur-xl">
      <div className="mx-auto flex min-h-[68px] w-full max-w-[1500px] items-center gap-4 px-4 py-3 sm:px-6">
        <button
          type="button"
          onClick={() => (isLanding ? undefined : navigate(isOperations ? '/' : ROUTE_FOR_ROLE[role]))}
          className="flex min-w-0 items-center gap-3 rounded-2xl text-left transition-opacity hover:opacity-90"
          aria-label={isLanding ? 'LifeLine Ride' : 'Open role home'}
        >
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl border border-accent/35 bg-accent/10">
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" aria-hidden="true">
              <path d="M3 12h3.5l2-5 3.5 10 2.5-6 1.8 3H21" stroke="currentColor" className="text-sky-400" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
          <span className="hidden min-w-0 leading-tight xs:block">
            <span className="block truncate text-[16px] font-bold tracking-tight text-ink">LifeLine Ride</span>
            <span dir="rtl" className="block truncate font-urdu text-[11px] leading-6 text-ink-muted">دیہی ایمرجنسی رسپانس نیٹ ورک</span>
          </span>
        </button>

        {!isLanding && !isOperations && (
          <span className="hidden h-7 w-px bg-slate-800 sm:block" />
        )}

        {!isLanding && !isOperations && (
          <div className="flex min-w-0 items-center gap-2">
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-surface text-sm" aria-hidden="true">
              {ROLE_META[role].icon}
            </span>
            <span className="min-w-0">
              <span className="block truncate text-xs font-bold text-ink">{ROLE_META[role].en}</span>
              <span dir="rtl" className="block truncate font-urdu text-[11px] leading-5 text-ink-muted">{ROLE_META[role].ur}</span>
            </span>
          </div>
        )}

        <div className="ml-auto flex items-center gap-2">
          {!isLanding && (
            <HealthChip online={backendOnline} error={backendError} health={health} polling={polling} />
          )}

          {isOperations && (
            <OperationsNav lang={lang} navigate={navigate} />
          )}

          {isOperations && (
            <>
              {showAdopt && (
                <form
                  className="hidden items-center gap-1.5 lg:flex"
                  onSubmit={(e) => {
                    e.preventDefault()
                    if (!adoptValue.trim()) return
                    adoptIncident(adoptValue)
                    setAdoptValue('')
                    setShowAdopt(false)
                  }}
                >
                  <input value={adoptValue} onChange={(e) => setAdoptValue(e.target.value)} placeholder="INC-XXXXXX" aria-label="Incident id" className="field w-32 py-1.5 font-mono text-xs" />
                  <Pill variant="cyan" size="sm" type="submit">Track</Pill>
                </form>
              )}
              <Pill variant="ghost" size="sm" onClick={() => setShowAdopt((v) => !v)}>Adopt</Pill>
              <Pill variant="ghost" size="sm" onClick={resetDemo} disabled={!incidentId}>Reset</Pill>
            </>
          )}

          <DemoRoleSwitcher />
          <LangSwitcher lang={lang} setLang={setLang} />

          {!isLanding && !isOperations && (
            <button
              type="button"
              onClick={signOut}
              className="rounded-full border border-slate-700 bg-surface px-3.5 py-2 text-xs font-semibold text-ink-muted transition hover:border-slate-600 hover:text-ink"
            >
              {lang === 'ur' ? 'خارج ہوں' : 'Sign out'}
            </button>
          )}
        </div>
      </div>
    </header>
  )
}

function DemoRoleSwitcher() {
  const { lang, route, currentRole, sessionRole, enterRole } = useCockpit()
  const activeRole = route === '/' || route === '/operations' ? null : (currentRole ?? sessionRole)

  const roles: { id: Role; label_en: string; label_ur: string; icon: string }[] = [
    { id: 'reporter', label_en: 'Reporter', label_ur: 'رپورٹر', icon: '🚨' },
    { id: 'responder', label_en: 'Responder', label_ur: 'رسپانڈر', icon: '🩺' },
    { id: 'bhu', label_en: 'BHU / Audit', label_ur: 'بی ایچ یو / آڈٹ', icon: '🏥' },
  ]

  return (
    <div
      role="group"
      aria-label="Demo role switcher"
      className="flex items-center gap-1 rounded-full border border-slate-800 bg-surface p-1"
    >
      {roles.map((r) => {
        const isActive = activeRole === r.id
        return (
          <button
            key={r.id}
            type="button"
            onClick={() => enterRole(r.id)}
            aria-pressed={isActive}
            className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold transition-all ${
              isActive
                ? 'bg-sky-600 font-medium text-white shadow-sm'
                : 'text-slate-400 hover:bg-raised hover:text-white'
            }`}
          >
            <span aria-hidden="true">{r.icon}</span>
            <span>{lang === 'ur' ? r.label_ur : r.label_en}</span>
          </button>
        )
      })}
    </div>
  )
}

function OperationsNav({ lang, navigate }: { lang: 'ur' | 'en'; navigate: (r: Route) => void }) {
  return (
    <nav aria-label="Operations views" className="hidden items-center gap-1 rounded-full border border-slate-800 bg-surface p-1 md:flex">
      {ROLES.map((r) => {
        const target = ROUTE_FOR_ROLE[r.id]
        return (
          <button key={r.id} type="button" onClick={() => navigate(target)} className="rounded-full px-3 py-1.5 text-xs font-semibold text-ink-muted hover:bg-raised hover:text-ink">
            {lang === 'ur' ? r.label_ur : r.label_en}
          </button>
        )
      })}
      <button type="button" onClick={() => navigate('/operations')} className="rounded-full bg-accent/15 px-3 py-1.5 text-xs font-semibold text-sky-300">
        {lang === 'ur' ? 'آپریشنز' : 'Operations'}
      </button>
    </nav>
  )
}

function LangSwitcher({ lang, setLang }: { lang: 'ur' | 'en'; setLang: (lang: 'ur' | 'en') => void }) {
  return (
    <div role="group" aria-label="Interface language" className="flex items-center gap-0.5 rounded-full border border-slate-800 bg-surface p-1">
      <button type="button" onClick={() => setLang('en')} aria-pressed={lang === 'en'} className={`rounded-full px-2.5 py-1 text-[11px] font-semibold transition-colors ${lang === 'en' ? 'bg-accent text-white' : 'text-ink-muted hover:text-ink'}`}>EN</button>
      <button type="button" onClick={() => setLang('ur')} aria-pressed={lang === 'ur'} className={`rounded-full px-3 py-1 font-urdu text-[13px] font-semibold leading-5 transition-colors ${lang === 'ur' ? 'bg-accent text-white' : 'text-ink-muted hover:text-ink'}`} dir="rtl">اردو</button>
    </div>
  )
}

function HealthChip({ online, error, health, polling }: { online: boolean; error: { code: string; message: string } | null; health: { db_reachable?: boolean } | null; polling: boolean }) {
  const isLive = online && Boolean(health?.db_reachable)
  return (
    <div className="hidden items-center gap-2 rounded-full border border-slate-800 bg-surface px-3 py-1.5 sm:flex" title={isLive ? `Backend and database healthy at ${API_LABEL}` : `${error?.code ?? 'Backend unavailable'}`}>
      <StatusDot tone={isLive ? 'mint' : 'critical'} pulse={!isLive} />
      <span className={`text-[11px] font-bold ${isLive ? 'text-emerald-400' : 'text-rose-400'}`}>{isLive ? 'Live' : 'Offline'}</span>
      {polling && <span className="h-1.5 w-1.5 rounded-full bg-accent" />}
    </div>
  )
}

