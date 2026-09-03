/**
 * Impilo Clinical Observatory primitives.
 *
 * Every interactive element is pill-geometry (rounded-full); every container is
 * a 24px or 32px-radius iris-shadow card bounded by a 1px iris hairline.
 */

import type { ButtonHTMLAttributes, ReactNode } from 'react'

import { TIER_META, type TierMeta } from '../lib/urdu'
import type { SeverityTier } from '../lib/types'

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------

export function Card({
  children,
  title,
  titleUr,
  subtitle,
  right,
  className = '',
  panel = false,
}: {
  children?: ReactNode
  title?: string
  titleUr?: string
  subtitle?: string
  right?: ReactNode
  className?: string
  /** 32px radius instead of 24px for top-level containers. */
  panel?: boolean
}) {
  return (
    <section className={`${panel ? 'card-panel' : 'card'} ${className}`}>
      {(title || right) && (
        <header className="flex items-start justify-between gap-4 px-5 pt-4 pb-3">
          <div className="min-w-0">
            {title && (
              <h2 className="text-[15px] font-semibold tracking-tight text-pearl truncate">
                {title}
              </h2>
            )}
            {titleUr && (
              <p dir="rtl" className="text-[13px] text-ash leading-7">
                {titleUr}
              </p>
            )}
            {subtitle && (
              <p className="text-xs text-ash/85 mt-0.5">{subtitle}</p>
            )}
          </div>
          {right && <div className="shrink-0 flex items-center gap-2">{right}</div>}
        </header>
      )}
      <div className={title || right ? 'px-5 pb-5' : 'p-5'}>{children}</div>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Buttons — always pill geometry
// ---------------------------------------------------------------------------

type PillVariant = 'primary' | 'cyan' | 'mint' | 'danger' | 'ghost'

const VARIANT_CLASS: Record<PillVariant, string> = {
  primary: 'pill-primary',
  cyan: 'pill-cyan',
  mint: 'pill-mint',
  danger: 'pill-danger',
  ghost: 'pill-ghost',
}

export function Pill({
  children,
  variant = 'primary',
  size = 'md',
  className = '',
  loading = false,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: PillVariant
  size?: 'sm' | 'md' | 'lg'
  loading?: boolean
}) {
  const sizing =
    size === 'lg'
      ? 'px-7 py-3.5 text-[15px]'
      : size === 'sm'
        ? 'px-3.5 py-1.5 text-xs'
        : 'px-5 py-2.5 text-sm'

  return (
    <button
      type="button"
      className={`${VARIANT_CLASS[variant]} ${sizing} ${className}`}
      disabled={rest.disabled || loading}
      {...rest}
    >
      {loading && <Spinner className="h-3.5 w-3.5" />}
      {children}
    </button>
  )
}

// ---------------------------------------------------------------------------
// Tags & badges
// ---------------------------------------------------------------------------

export function Tag({
  children,
  tone = 'ash',
  className = '',
}: {
  children: ReactNode
  tone?: 'cyan' | 'mint' | 'critical' | 'ash' | 'pulse'
  className?: string
}) {
  const tones: Record<string, string> = {
    cyan: 'text-clinical-cyan border-clinical-cyan/45 bg-clinical-cyan/10',
    mint: 'text-mint-vital border-mint-vital/45 bg-mint-vital/10',
    critical: 'text-tier-critical border-tier-critical/45 bg-tier-critical/10',
    ash: 'text-ash border-iris-border bg-iris-canvas/50',
    pulse:
      'text-clinical-cyan border-clinical-cyan/60 bg-clinical-cyan/15 animate-pulse-ring',
  }
  return <span className={`tag ${tones[tone]} ${className}`}>{children}</span>
}

/** Severity tier badge — explicit and inspectable, per the project guardrail. */
export function TierBadge({
  tier,
  size = 'md',
  showTierNo = true,
}: {
  tier: SeverityTier | null | undefined
  size?: 'sm' | 'md' | 'lg'
  showTierNo?: boolean
}) {
  const meta: TierMeta = TIER_META[tier ?? 'moderate']
  const sizing =
    size === 'lg' ? 'px-4 py-2 text-sm' : size === 'sm' ? 'px-2.5 py-1 text-[10px]' : 'px-3.5 py-1.5 text-xs'

  return (
    <span
      className={`inline-flex items-center gap-2 rounded-full border font-semibold uppercase tracking-wider ${meta.bg} ${meta.border} ${meta.text} ${sizing}`}
    >
      <span className={`h-2 w-2 rounded-full ${meta.dot} ${meta.pulse}`} />
      {meta.label_en}
      {showTierNo && (
        <span className="font-medium opacity-70 normal-case tracking-normal">
          · {meta.tier_no}
        </span>
      )}
    </span>
  )
}

/** Small Urdu chip rendered RTL next to an English label. */
export function UrduChip({ children }: { children: ReactNode }) {
  return (
    <span
      dir="rtl"
      className="inline-block rounded-full border border-iris-border bg-iris-canvas/60 px-3 py-1 text-[13px] text-pearl font-urdu leading-6"
    >
      {children}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Status dot / spinner / wave
// ---------------------------------------------------------------------------

export function StatusDot({
  tone,
  pulse = false,
  className = '',
}: {
  tone: 'mint' | 'cyan' | 'critical' | 'ash'
  pulse?: boolean
  className?: string
}) {
  const tones: Record<string, string> = {
    mint: 'bg-mint-vital',
    cyan: 'bg-clinical-cyan',
    critical: 'bg-tier-critical',
    ash: 'bg-ash',
  }
  const pulses: Record<string, string> = {
    mint: 'animate-pulse-ring-mint',
    cyan: 'animate-pulse-ring',
    critical: 'animate-pulse-ring-critical',
    ash: '',
  }
  return (
    <span
      className={`inline-block h-2.5 w-2.5 rounded-full ${tones[tone]} ${
        pulse ? pulses[tone] : ''
      } ${className}`}
    />
  )
}

export function Spinner({ className = 'h-4 w-4' }: { className?: string }) {
  return (
    <svg className={`animate-spin ${className}`} viewBox="0 0 24 24" fill="none">
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="3"
      />
      <path
        className="opacity-90"
        fill="currentColor"
        d="M12 2a10 10 0 0 1 10 10h-3a7 7 0 0 0-7-7V2z"
      />
    </svg>
  )
}

/** Clinical-cyan audio wave shown while the help-bot line is playing. */
export function AudioWave({ active = true }: { active?: boolean }) {
  return (
    <span className="inline-flex h-4 items-end gap-[3px]" aria-hidden="true">
      {[0, 1, 2, 3, 4].map((i) => (
        <span
          key={i}
          className="wave-bar h-full"
          style={{
            animationDelay: `${i * 0.11}s`,
            opacity: active ? 1 : 0.28,
            animationPlayState: active ? 'running' : 'paused',
          }}
        />
      ))}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

export function Metric({
  label,
  value,
  unit,
  tone = 'cyan',
  hint,
}: {
  label: string
  value: ReactNode
  unit?: string
  tone?: 'cyan' | 'mint' | 'critical' | 'pearl'
  hint?: string
}) {
  const tones: Record<string, string> = {
    cyan: 'text-clinical-cyan',
    mint: 'text-mint-vital',
    critical: 'text-tier-critical',
    pearl: 'text-pearl',
  }
  return (
    <div className="rounded-full border border-iris-border bg-iris-canvas/45 px-4 py-2.5">
      <div className="text-[10px] uppercase tracking-wider text-ash">{label}</div>
      <div
        className={`text-lg font-semibold tracking-tighter tabular-nums ${tones[tone]}`}
      >
        {value}
        {unit && <span className="ml-0.5 text-xs font-medium opacity-70">{unit}</span>}
      </div>
      {hint && <div className="text-[10px] text-ash/75">{hint}</div>}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Empty / error states
// ---------------------------------------------------------------------------

export function EmptyState({
  title,
  titleUr,
  message,
  action,
}: {
  title: string
  titleUr?: string
  message?: string
  action?: ReactNode
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-card border border-dashed border-iris-border bg-iris-canvas/35 px-6 py-10 text-center">
      <div>
        <p className="text-sm font-semibold tracking-tight text-pearl">{title}</p>
        {titleUr && (
          <p dir="rtl" className="text-[13px] text-ash font-urdu leading-7">
            {titleUr}
          </p>
        )}
      </div>
      {message && <p className="max-w-sm text-xs text-ash/85">{message}</p>}
      {action}
    </div>
  )
}

export function ErrorNote({
  code,
  message,
}: {
  code?: string
  message: string
}) {
  return (
    <div className="rounded-card border border-tier-critical/45 bg-tier-critical/10 px-4 py-3">
      <p className="text-xs font-semibold text-tier-critical">
        {code ? `${code} — ` : ''}
        {message}
      </p>
    </div>
  )
}
