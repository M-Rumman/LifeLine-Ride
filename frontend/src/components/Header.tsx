/**
 * Global header: brand wordmark, backend health ping (Live / Not Live),
 * active incident indicator, and the three-stage Role Switcher.
 */

import { useState } from 'react'

import { useCockpit, ROLES, type Role } from '../state/CockpitContext'
import { statusLabel, tierMeta } from '../lib/urdu'
import { Pill, StatusDot } from './ui'
import { API_BASE } from '../lib/api'

export function Header() {
  const {
    role,
    setRole,
    incidentId,
    incident,
    timeline,
    health,
    backendOnline,
    backendError,
    polling,
    resetDemo,
    adoptIncident,
  } = useCockpit()

  const [adoptValue, setAdoptValue] = useState('')
  const [showAdopt, setShowAdopt] = useState(false)

  const tier = incident?.severity_tier ?? timeline?.severity_tier ?? null
  const status = timeline?.status ?? null
  const statusText = statusLabel(status)

  return (
    <header className="sticky top-0 z-40 border-b border-iris-border bg-[#16165c]/95 backdrop-blur-xl">
      <div className="mx-auto flex max-w-[1800px] flex-wrap items-center gap-x-5 gap-y-3 px-5 py-3">
        {/* ---------------- Brand ---------------- */}
        <div className="flex items-center gap-3">
          <div className="relative grid h-10 w-10 place-items-center rounded-full border border-clinical-cyan/60 bg-clinical-cyan/12">
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none">
              <path
                d="M3 12h3.5l2-5 3.5 10 2.5-6 1.8 3H21"
                stroke="#00b1ff"
                strokeWidth="1.9"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
          <div className="leading-tight">
            <h1 className="text-[17px] font-bold tracking-tight text-white">
              LifeLine Ride
            </h1>
            <p dir="rtl" className="text-[12px] text-slate-300 font-urdu leading-5">
              دیہی ایمرجنسی رسپانس نیٹ ورک
            </p>
          </div>
        </div>

        <span className="hidden h-8 w-px bg-slate-600/50 lg:block" />

        {/* ---------------- Server status refactor (Live / Not Live) ---------------- */}
        <HealthChip
          online={backendOnline}
          error={backendError}
          health={health}
          polling={polling}
        />

        {/* ---------------- Active incident indicator (High-Contrast) ---------------- */}
        <div className="flex items-center gap-2">
          {incidentId ? (
            <div className="flex items-center justify-between gap-2.5 rounded-full border border-slate-600/70 bg-[#1e1d68] px-4 py-2 shadow-inner">
              <div className="flex items-center gap-2">
                <StatusDot tone={status === 'closed' ? 'mint' : 'cyan'} />
                <span className="font-mono text-xs font-bold text-white">{incidentId}</span>
                {tier && (
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${tierMeta(tier).dot}`}
                  />
                )}
              </div>
              <div className="flex items-center gap-1.5 text-[11px]">
                <span className="font-semibold text-white">{statusText.en}</span>
                <span dir="rtl" className="font-urdu text-[12px] leading-none text-slate-200">
                  ({statusText.ur})
                </span>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-2 rounded-full border border-slate-600/70 bg-[#1e1d68] px-4 py-2 text-xs">
              <StatusDot tone="ash" />
              <span className="text-slate-200 font-medium">No active incident</span>
            </div>
          )}
        </div>

        <div className="ml-auto flex items-center gap-2">
          {/* ---------------- Role Switcher ---------------- */}
          <nav
            aria-label="Role stepper"
            className="flex items-center gap-1 rounded-full border border-slate-600/60 bg-[#16165c] p-1"
          >
            {ROLES.map((r) => (
              <RoleTab
                key={r.id}
                step={r.step}
                labelEn={r.label_en}
                labelUr={r.label_ur}
                active={role === r.id}
                onClick={() => setRole(r.id as Role)}
              />
            ))}
          </nav>

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
                className="field w-40 py-1.5 font-mono text-xs"
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
            Adopt
          </Pill>

          <Pill
            variant="ghost"
            size="sm"
            onClick={resetDemo}
            disabled={!incidentId}
            title="Clear the active incident from the cockpit"
          >
            Reset
          </Pill>
        </div>
      </div>
    </header>
  )
}

function RoleTab({
  step,
  labelEn,
  labelUr,
  active,
  onClick,
}: {
  step: number
  labelEn: string
  labelUr: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'step' : undefined}
      className={`pill px-4 py-2 text-xs transition-colors ${
        active
          ? 'bg-sky-600 text-white font-semibold shadow-md'
          : 'border border-transparent text-slate-300 hover:text-white hover:bg-white/10'
      }`}
    >
      <span
        className={`grid place-items-center rounded-full text-[10px] font-bold ${
          active ? 'bg-white/20 text-white' : 'bg-slate-700/60 text-slate-300'
        }`}
        style={{ height: '18px', width: '18px' }}
      >
        {step}
      </span>
      <span className="font-medium tracking-tight">{labelEn}</span>
      <span dir="rtl" className="font-urdu text-[13px] opacity-90">
        {labelUr}
      </span>
    </button>
  )
}

/**
 * Server Status Chip: Displays concise dynamic "Live" (green) or "Not Live" (red)
 * with static circular status dot.
 */
function HealthChip({
  online,
  error,
  health,
  polling,
}: {
  online: boolean
  error: { code: string; message: string } | null
  health: { db_reachable?: boolean; responders_loaded?: number; helpbot_sessions?: number } | null
  polling: boolean
}) {
  const isLive = online && Boolean(health?.db_reachable)
  const tone = isLive ? 'mint' : 'critical'

  return (
    <div
      className="flex items-center gap-2 rounded-full border border-slate-600/70 bg-[#1e1d68] px-3.5 py-1.5"
      title={
        isLive
          ? `Backend and database healthy at ${API_BASE}`
          : `Backend or database issue at ${API_BASE}: ${error?.code ?? (online ? 'DB_UNREACHABLE' : 'NO_RESPONSE')} — ${
              error?.message ?? (online ? 'PostgreSQL unreachable' : 'Backend offline')
            }`
      }
    >
      <StatusDot tone={tone} />
      <span className={`text-[12px] font-bold tracking-wide ${isLive ? 'text-emerald-400' : 'text-rose-400'}`}>
        {isLive ? 'Live' : 'Not Live'}
      </span>
      {online && health && (
        <span className="hidden items-center gap-2 text-[10px] text-slate-300 xl:flex">
          <span className="tabular-nums font-mono text-slate-200">
            {health.responders_loaded ?? 0} resp
          </span>
          <span className="h-3 w-px bg-slate-600/50" />
          <span className="tabular-nums font-mono text-slate-200">
            {health.helpbot_sessions ?? 0} bot
          </span>
          <span className="h-3 w-px bg-slate-600/50" />
          <span className={health.db_reachable ? 'text-emerald-400 font-semibold' : 'text-rose-400 font-semibold'}>
            {health.db_reachable ? 'DB ok' : 'DB down'}
          </span>
        </span>
      )}
      {polling && (
        <span className="h-1.5 w-1.5 rounded-full bg-clinical-cyan opacity-80" />
      )}
    </div>
  )
}
