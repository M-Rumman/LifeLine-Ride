/**
 * Live Polling Urdu Feed — persistent right-panel widget.
 *
 * Renders the `updates` array from GET /api/v1/emergency/incident/{id}/timeline
 * with pure high-contrast Cloud White (#ffffff) headline and Pearl (#f4f4f6 / text-slate-200) subtext.
 */

import { useCockpit } from '../state/CockpitContext'
import { formatClock, stageMeta, statusLabel } from '../lib/urdu'
import type { ReporterUpdate } from '../lib/types'
import { EmptyState, StatusDot, Tag } from './ui'

export function TimelineFeed() {
  const { timeline, incidentId, incident, polling, backendOnline } = useCockpit()

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
    <div className="card flex min-h-0 flex-1 flex-col overflow-hidden">
      {/* ---------------- High-Contrast Live Status Header ---------------- */}
      <header className="flex items-start justify-between gap-3 px-5 pt-4 pb-3.5 border-b border-slate-700/60 bg-[#16165c]">
        <div className="min-w-0">
          <h2 className="text-[15px] font-bold tracking-tight text-white">
            Live Status
            <span dir="rtl" className="ml-2 text-[13px] font-medium text-white font-urdu">
              براہِ راست صورتحال
            </span>
          </h2>
          <p className="mt-0.5 text-xs text-slate-200">
            {incidentId ? (
              <>
                <span className="font-mono font-bold text-white">{incidentId}</span>
                {' · '}
                <span className="text-slate-100 font-medium">{status.en}</span>
                <span dir="rtl" className="ml-1.5 font-urdu text-slate-200">
                  {status.ur}
                </span>
              </>
            ) : (
              <span className="text-slate-200">No incident being tracked</span>
            )}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {polling && (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-sky-400/50 bg-sky-950/60 px-2.5 py-1 text-[10px] uppercase font-bold tracking-wider text-sky-300">
              <StatusDot tone="cyan" /> live
            </span>
          )}
          {!backendOnline && <Tag tone="critical">feed stalled</Tag>}
        </div>
      </header>

      {/* Real-time condition badges */}
      {(coverageGap || escalated || ambulance) && (
        <div className="flex flex-wrap gap-2 px-5 py-2.5 bg-slate-50 border-b border-slate-200">
          {coverageGap && (
            <span className="tag border-rose-200 bg-rose-50 text-rose-700 normal-case tracking-normal font-semibold">
              <StatusDot tone="critical" />
              Coverage Gap
              <span dir="rtl" className="font-urdu text-[12px] normal-case">
                کوریج کا خلا
              </span>
            </span>
          )}
          {escalated && (
            <span className="tag border-rose-300 bg-rose-100 text-rose-800 font-semibold normal-case tracking-normal">
              <StatusDot tone="critical" />
              Mid-Incident Escalated
              <span dir="rtl" className="font-urdu text-[12px] normal-case">
                حالت بگڑ گئی
              </span>
            </span>
          )}
          {ambulance && (
            <span className="tag border-sky-300 bg-sky-100 text-sky-800 font-semibold normal-case tracking-normal">
              <AmbulanceIcon />
              Ambulance Requested
              <span dir="rtl" className="font-urdu text-[12px] normal-case">
                ایمبولینس طلب
              </span>
            </span>
          )}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 bg-white">
        {!incidentId ? (
          <EmptyState
            title="Waiting for a report"
            titleUr="رپورٹ کا انتظار"
            message="Submit an emergency in the Reporter View. This feed then updates every 2.5 seconds without a page refresh."
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
              className="absolute left-[8px] top-2 bottom-2 w-0.5 bg-slate-200"
            />
            {updates.map((u, i) => (
              <TimelineRow
                key={u.update_id ?? `${u.stage}-${i}`}
                update={u}
              />
            ))}

            {/* Pending next-step placeholder */}
            {!isClosed && (
              <li className="relative flex gap-3.5 pb-1 pl-0">
                <span className="relative z-10 mt-1.5 h-3.5 w-3.5 shrink-0 rounded-full border border-slate-300 bg-slate-100 flex items-center justify-center">
                  <span className="h-1.5 w-1.5 rounded-full bg-sky-500 opacity-80" />
                </span>
                <p className="pt-0.5 text-[11px] italic text-slate-500">
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

function TimelineRow({
  update,
}: {
  update: ReporterUpdate
}) {
  const meta = stageMeta(update.stage)
  const tone = meta.tone

  // Backend-localised message wins; the local table is only a fallback.
  const message = update.message_urdu?.trim() || meta.fallback_ur

  return (
    <li className="relative flex gap-3.5 pb-4 animate-fade-rise">
      <span
        className={`relative z-10 mt-1 h-3.5 w-3.5 shrink-0 rounded-full border-2 ${
          tone === 'mint'
            ? 'border-emerald-500 bg-emerald-100'
            : tone === 'critical'
              ? 'border-rose-500 bg-rose-100'
              : 'border-sky-500 bg-sky-100'
        }`}
      />

      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
            {meta.label_en}
          </span>
          <time
            className="shrink-0 font-mono text-[10px] tabular-nums text-slate-400"
            dateTime={update.timestamp}
          >
            {formatClock(update.timestamp)}
          </time>
        </div>

        {/* High-contrast Urdu message */}
        <p
          dir="rtl"
          className={`mt-1 text-[15px] leading-7 font-urdu ${
            tone === 'critical'
              ? 'text-rose-700 font-bold'
              : tone === 'mint'
                ? 'text-emerald-700 font-semibold'
                : 'text-slate-800 font-medium'
          }`}
        >
          {message}
        </p>

        {update.update_id && (
          <p className="mt-0.5 font-mono text-[10px] text-slate-400">
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
