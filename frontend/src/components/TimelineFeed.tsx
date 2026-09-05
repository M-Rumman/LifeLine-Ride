/**
 * Live Urdu status feed.
 *
 * Renders the `updates` array from GET /api/v1/emergency/incident/{id}/timeline.
 * Mounted by the reporter's post-submit tracker and the BHU console — it is no
 * longer a persistent sidebar widget, because the reporter screen is now
 * deliberately map-free and single-column.
 *
 * Backend-localised `message_urdu` always wins; `lib/urdu.ts` only supplies
 * fallbacks for stages the backend has not localised yet.
 */

import { useCockpit } from '../state/CockpitContext'
import { formatClock, stageMeta, statusLabel } from '../lib/urdu'
import type { ReporterUpdate } from '../lib/types'
import { EmptyState, StatusDot, Tag } from './ui'

export function TimelineFeed() {
  const { timeline, incidentId, incident, polling, backendOnline, lang } = useCockpit()

  const updates = [...(timeline?.updates ?? [])].sort((a, b) => {
    const byTime = new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    if (byTime !== 0) return byTime
    return stageMeta(a.stage).order - stageMeta(b.stage).order
  })

  const coverageGap = timeline?.coverage_gap ?? incident?.coverage_gap ?? false
  const escalated =
    timeline?.mid_incident_escalated ?? incident?.mid_incident_escalated ?? false
  const ambulance = incident?.ambulance_requested ?? false
  const status = statusLabel(timeline?.status ?? null)
  const isClosed = timeline?.status === 'closed'

  return (
    <div className="card flex min-h-[280px] flex-1 flex-col overflow-hidden">
      {/* ---------------- Live status header ---------------- */}
      <header className="flex items-start justify-between gap-3 border-b border-slate-800 px-5 pt-4 pb-3.5">
        <div className="min-w-0">
          <h2 className="text-[15px] font-bold tracking-tight text-ink">
            {lang === 'ur' ? 'براہِ راست صورتحال' : 'Live Status'}
            <span
              dir="rtl"
              className="ml-2 font-urdu text-[13px] font-medium text-ink-muted"
            >
              {lang === 'ur' ? 'Live Status' : 'براہِ راست صورتحال'}
            </span>
          </h2>
          <p className="mt-0.5 text-xs text-ink-muted">
            {incidentId ? (
              <>
                <span className="font-mono font-bold text-ink">{incidentId}</span>
                {' · '}
                <span className="font-medium text-slate-200">
                  {lang === 'ur' ? status.ur : status.en}
                </span>
                <span dir="rtl" className="ml-1.5 font-urdu text-ink-muted">
                  ({lang === 'ur' ? status.en : status.ur})
                </span>
              </>
            ) : (
              <span>
                {lang === 'ur'
                  ? 'کوئی فعال ایمرجنسی زیرِ نگرانی نہیں'
                  : 'No incident being tracked'}
              </span>
            )}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {polling && (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-sky-500/40 bg-sky-500/10 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-sky-300">
              <StatusDot tone="cyan" pulse /> live
            </span>
          )}
          {!backendOnline && <Tag tone="critical">feed stalled</Tag>}
        </div>
      </header>

      {/* ---------------- Real-time condition badges ---------------- */}
      {(coverageGap || escalated || ambulance) && (
        <div className="flex flex-wrap gap-2 border-b border-slate-800 bg-sunken px-5 py-2.5">
          {/* Rose is legitimate on all three: each is an active escalation. */}
          {coverageGap && (
            <span className="tag border-rose-500/40 bg-rose-500/10 font-semibold normal-case tracking-normal text-rose-200">
              <StatusDot tone="critical" pulse />
              Coverage Gap
              <span dir="rtl" className="font-urdu text-[12px] normal-case">
                کوریج کا خلا
              </span>
            </span>
          )}
          {escalated && (
            <span className="tag border-rose-500/45 bg-rose-500/15 font-semibold normal-case tracking-normal text-rose-200">
              <StatusDot tone="critical" pulse />
              Mid-Incident Escalated
              <span dir="rtl" className="font-urdu text-[12px] normal-case">
                حالت بگڑ گئی
              </span>
            </span>
          )}
          {ambulance && (
            <span className="tag border-amber-500/40 bg-amber-500/10 font-semibold normal-case tracking-normal text-amber-200">
              <AmbulanceIcon />
              Ambulance Requested
              <span dir="rtl" className="font-urdu text-[12px] normal-case">
                ایمبولینس طلب
              </span>
            </span>
          )}
        </div>
      )}

      {/* ---------------- Feed body ---------------- */}
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {!incidentId ? (
          <EmptyState
            title="Waiting for a report"
            titleUr="رپورٹ کا انتظار"
            message="Submit an emergency from the report screen. This feed then updates every 2.5 seconds without a page refresh."
          />
        ) : updates.length === 0 ? (
          <EmptyState
            title="No status updates yet"
            titleUr="ابھی کوئی اطلاع نہیں"
            message={
              backendOnline
                ? 'The incident is registered; the first localised update lands as soon as dispatch progresses.'
                : 'Backend unreachable — the feed cannot poll. Check the connection indicator in the header.'
            }
          />
        ) : (
          <ol className="relative pl-1">
            {/* Vertical progress rail */}
            <span
              aria-hidden="true"
              className="absolute bottom-2 left-[8px] top-2 w-0.5 bg-slate-800"
            />
            {updates.map((u, i) => (
              <TimelineRow key={u.update_id ?? `${u.stage}-${i}`} update={u} />
            ))}

            {/* Pending next-step placeholder */}
            {!isClosed && (
              <li className="relative flex gap-3.5 pb-1 pl-0">
                <span className="relative z-10 mt-1.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border border-slate-700 bg-sunken">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-sky-500" />
                </span>
                <p className="pt-0.5 text-[11px] italic text-ink-dim">
                  Polling for the next update…
                </p>
              </li>
            )}
          </ol>
        )}
      </div>
    </div>
  )
}

function TimelineRow({ update }: { update: ReporterUpdate }) {
  const meta = stageMeta(update.stage)
  const tone = meta.tone

  // Backend-localised message wins; the local table is only a fallback.
  const message = update.message_urdu?.trim() || meta.fallback_ur

  return (
    <li className="relative flex animate-fade-rise gap-3.5 pb-4">
      <span
        className={`relative z-10 mt-1 h-3.5 w-3.5 shrink-0 rounded-full border-2 ${
          tone === 'mint'
            ? 'border-emerald-500 bg-emerald-500/25'
            : tone === 'critical'
              ? 'border-rose-500 bg-rose-500/25'
              : tone === 'ash'
                ? 'border-slate-600 bg-slate-700/40'
                : 'border-sky-500 bg-sky-500/25'
        }`}
      />

      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-[10px] font-bold uppercase tracking-wider text-ink-muted">
            {meta.label_en}
          </span>
          <time
            className="shrink-0 font-mono text-[10px] tabular-nums text-ink-dim"
            dateTime={update.timestamp}
          >
            {formatClock(update.timestamp)}
          </time>
        </div>

        {/* High-contrast Urdu message */}
        <p
          dir="rtl"
          className={`mt-1 font-urdu text-[15px] leading-8 ${
            tone === 'critical'
              ? 'font-bold text-rose-200'
              : tone === 'mint'
                ? 'font-semibold text-emerald-200'
                : 'font-medium text-slate-100'
          }`}
        >
          {message}
        </p>

        {update.update_id && (
          <p className="mt-0.5 font-mono text-[10px] text-ink-dim">
            {update.update_id}
            {update.severity_tier ? ` · ${update.severity_tier}` : ''}
          </p>
        )}
      </div>
    </li>
  )
}

function AmbulanceIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-3 w-3" fill="currentColor" aria-hidden="true">
      <path d="M3 6h11v9H3zM14 9h3.6l2.4 3v3h-6z" opacity=".9" />
      <circle cx="7" cy="17.5" r="1.8" />
      <circle cx="17" cy="17.5" r="1.8" />
    </svg>
  )
}
