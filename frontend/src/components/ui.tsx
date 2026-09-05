/**
 * LifeLine Ride UI primitives — Rozgaar-pattern dark utility theme.
 *
 * Surface rules:
 *   canvas #0a0f1d  ->  card #111827  ->  sunken well #0d1424
 * Each step DOWN in that stack means "further from the viewer", so inputs,
 * feeds and the chat log all sit in `.well` rather than on a lighter tile.
 *
 * Accent discipline: rose (#ef4444) is reserved for active critical
 * emergencies and escalation banners; emerald (#10b981) is reserved for
 * verified status and resolved incidents. Neither is used decoratively.
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
  /** 20px radius instead of 16px for top-level containers. */
  panel?: boolean
}) {
  return (
    <section className={`${panel ? 'card-panel' : 'card'} ${className}`}>
      {(title || right) && (
        <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3 border-b border-slate-800 px-5 pt-6 pb-4 sm:px-8">
          <div className="min-w-0">
            {title && (
              <h2 className="truncate text-[15px] font-bold tracking-tight text-ink">
                {title}
              </h2>
            )}
            {titleUr && (
              <p dir="rtl" className="font-urdu text-[13px] leading-7 text-ink-muted">
                {titleUr}
              </p>
            )}
            {subtitle && <p className="mt-1 text-xs leading-5 text-ink-muted">{subtitle}</p>}
          </div>
          {/* `min-w-0` + wrap, not `shrink-0`: a header with three or four
              controls must fold instead of overflowing a half-width column. */}
          {right && <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">{right}</div>}
        </header>
      )}
      <div className={title || right ? 'p-5 pt-4 sm:p-8 sm:pt-6' : 'p-5 sm:p-8'}>
        {children}
      </div>
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
    cyan: 'text-sky-300 border-sky-500/35 bg-sky-500/10',
    mint: 'text-emerald-300 border-emerald-500/35 bg-emerald-500/10',
    critical: 'text-rose-300 border-rose-500/35 bg-rose-500/10',
    ash: 'text-slate-300 border-slate-700 bg-slate-800/60',
    pulse: 'text-sky-300 border-sky-400/50 bg-sky-500/10',
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

  const tierStyles: Record<string, { bg: string; border: string; text: string; dot: string }> = {
    critical: {
      bg: 'bg-rose-500/12',
      border: 'border-rose-500/40',
      text: 'text-rose-300',
      dot: 'bg-rose-500',
    },
    moderate: {
      bg: 'bg-sky-500/12',
      border: 'border-sky-500/40',
      text: 'text-sky-300',
      dot: 'bg-sky-500',
    },
    minor: {
      bg: 'bg-slate-800/70',
      border: 'border-slate-700',
      text: 'text-slate-300',
      dot: 'bg-slate-500',
    },
  }

  const currentStyle = tierStyles[tier ?? 'moderate'] ?? tierStyles.moderate

  return (
    <span
      className={`inline-flex items-center gap-2 rounded-full border font-semibold uppercase tracking-wider ${currentStyle.bg} ${currentStyle.border} ${currentStyle.text} ${sizing}`}
    >
      <span className={`h-2 w-2 rounded-full ${currentStyle.dot}`} />
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
      className="inline-block rounded-full border border-slate-700 bg-slate-800/60 px-3 py-1 text-[13px] text-slate-200 font-urdu leading-6"
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
  /** Breathing opacity for live indicators. Was declared-but-inert, which is
   *  why callers reached for `className="animate-pulse"` instead. */
  pulse?: boolean
  className?: string
}) {
  const tones: Record<string, string> = {
    mint: 'bg-emerald-500',
    cyan: 'bg-sky-500',
    critical: 'bg-rose-500',
    ash: 'bg-slate-500',
  }
  return (
    <span
      className={`inline-block h-2.5 w-2.5 rounded-full shrink-0 ${tones[tone]} ${
        pulse ? 'animate-pulse' : ''
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

/** Cyan audio wave shown while the help-bot line is playing. */
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
    cyan: 'text-sky-400',
    mint: 'text-emerald-400',
    critical: 'text-rose-400',
    pearl: 'text-slate-100',
  }
  return (
    <div className="rounded-2xl border border-slate-800 bg-sunken px-4 py-3">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted">{label}</div>
      <div
        className={`text-lg font-bold tracking-tighter tabular-nums ${tones[tone]}`}
      >
        {value}
        {unit && <span className="ml-0.5 text-xs font-medium opacity-70">{unit}</span>}
      </div>
      {hint && <div className="text-[10px] text-ink-dim">{hint}</div>}
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
    <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-slate-700 bg-sunken/60 px-6 py-10 text-center">
      <div>
        <p className="text-sm font-bold tracking-tight text-ink">{title}</p>
        {titleUr && (
          <p dir="rtl" className="text-[13px] text-ink-muted font-urdu leading-7">
            {titleUr}
          </p>
        )}
      </div>
      {message && <p className="max-w-sm text-xs text-ink-muted">{message}</p>}
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
    <div className="rounded-2xl border border-rose-500/35 bg-rose-500/10 px-4 py-3">
      <p className="text-xs font-semibold text-rose-300">
        {code ? `${code} — ` : ''}
        {message}
      </p>
    </div>
  )
}
