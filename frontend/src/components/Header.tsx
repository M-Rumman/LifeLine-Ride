/**
 * Global header: brand wordmark, backend health ping, active incident
 * indicator, and the three-stage Role Switcher / Scenario Stepper.
 *
 * The stepper changes role ONLY — it never touches the active incident id, so
 * all three views keep inspecting the same live record.
 */

import { useState } from 'react'

import { useCockpit, ROLES, type Role } from '../state/CockpitContext'
import { statusLabel, tierMeta } from '../lib/urdu'
import { Pill, StatusDot, Tag } from './ui'
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
    <header className="sticky top-0 z-40 border-b border-iris-border bg-iris-canvas/88 backdrop-blur-xl">
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
            <span className="absolute inset-0 rounded-full animate-pulse-ring" />
          </div>
          <div className="leading-tight">
            <h1 className="text-[17px] font-semibold tracking-tighter text-pearl">
              LifeLine Ride
            </h1>
            <p dir="rtl" className="text-[12px] text-ash font-urdu leading-5">
              دیہی ایمرجنسی رسپانس نیٹ ورک
            </p>
          </div>
        </div>

        <span className="hidden h-8 w-px bg-iris-border lg:block" />

        {/* ---------------- Backend health ping ---------------- */}
        <HealthChip
          online={backendOnline}
          error={backendError}
          health={health}
          polling={polling}
        />

        {/* ---------------- Active incident indicator ---------------- */}
        <div className="flex items-center gap-2">
          {incidentId ? (
            <div className="flex items-center gap-2 rounded-full border border-iris-border bg-iris-shadow px-3.5 py-1.5">
              <StatusDot
                tone={status === 'closed' ? 'mint' : 'cyan'}
                pulse={status !== 'closed'}
              />
              <span className="font-mono text-xs text-pearl">{incidentId}</span>
              {tier && (
                <span
                  className={`h-1.5 w-1.5 rounded-full ${tierMeta(tier).dot}`}
                />
              )}
              <span className="text-[11px] text-ash">
                {statusText.en}
                <span dir="rtl" className="ml-1.5 font-urdu">
                  {statusText.ur}
                </span>
              </span>
            </div>
          ) : (
            <Tag tone="ash">No active incident</Tag>
          )}
        </div>

        <div className="ml-auto flex items-center gap-2">
          {/* ---------------- Role Switcher / Scenario Stepper ---------------- */}
          <nav
            aria-label="Role stepper"
            className="flex items-center gap-1 rounded-full border border-iris-border bg-iris-shadow p-1"
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
          ? 'bg-iris-pulse text-pearl border border-iris-glow shadow-glow'
          : 'border border-transparent text-ash hover:text-pearl hover:bg-iris-pulse/25'
      }`}
    >
      <span
        className={`grid place-items-center rounded-full text-[10px] font-semibold ${
          active ? 'bg-pearl/20 text-pearl' : 'bg-iris-canvas text-ash'
        }`}
        style={{ height: '18px', width: '18px' }}
      >
        {step}
      </span>
      <span className="font-medium tracking-tight">{labelEn}</span>
      <span dir="rtl" className="font-urdu text-[13px] opacity-85">
        {labelUr}
      </span>
    </button>
  )
}

/**
 * Discrete connection indicator. Collapses to a single amber/red dot plus a
 * tooltip when the backend is unreachable so the header never turns into an
 * error banner mid-demo.
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
  const tone = online ? (health?.db_reachable ? 'mint' : 'cyan') : 'critical'

  return (
    <div
      className="flex items-center gap-2 rounded-full border border-iris-border bg-iris-shadow px-3.5 py-1.5"
      title={
        online
          ? `Backend healthy at ${API_BASE}${
              health?.db_reachable ? '' : ' (PostgreSQL unreachable — serving seed data)'
            }`
          : `Backend unreachable at ${API_BASE}: ${error?.code ?? 'NO_RESPONSE'} — ${
              error?.message ?? 'no detail'
            }`
      }
    >
      <StatusDot tone={tone} pulse={online} />
      <span className="text-[11px] font-medium text-pearl">
        {online ? 'Backend live' : 'Backend offline'}
      </span>
      {online && health && (
        <span className="hidden items-center gap-2 text-[10px] text-ash xl:flex">
          <span className="tabular-nums">
            {health.responders_loaded ?? 0} resp
          </span>
          <span className="h-3 w-px bg-iris-border" />
          <span className="tabular-nums">
            {health.helpbot_sessions ?? 0} bot
          </span>
          <span className="h-3 w-px bg-iris-border" />
          <span className={health.db_reachable ? 'text-mint-vital' : 'text-tier-critical'}>
            {health.db_reachable ? 'DB ok' : 'DB down'}
          </span>
        </span>
      )}
      {polling && (
        <span className="h-1.5 w-1.5 rounded-full bg-clinical-cyan animate-pulse" />
      )}
    </div>
  )
}
