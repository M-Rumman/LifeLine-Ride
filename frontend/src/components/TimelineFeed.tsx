/**
 * Live Polling Urdu Feed — persistent right-panel widget.
 *
 * Renders the `updates` array from
 * GET /api/v1/emergency/incident/{id}/timeline (polled every 2.5s by the
 * cockpit) as a vertical step progress bar. The backend already localises each
 * update into `message_urdu`, so that string is authoritative; STAGE_META only
 * supplies the English gloss and a fallback for unlocalised stages.
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
    <div className="card flex min-h-0 flex-1 flex-col">
      <header className="flex items-start justify-between gap-3 px-5 pt-4 pb-3">
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold tracking-tight text-pearl">
            Live Status
            <span dir="rtl" className="ml-2 text-[13px] font-normal text-ash font-urdu">
              براہِ راست صورتحال
            </span>
          </h2>
          <p className="mt-0.5 text-xs text-ash/85">
            {incidentId ? (
              <>
                <span className="font-mono text-pearl">{incidentId}</span>
                {' · '}
                {status.en}
                <span dir="rtl" className="ml-1.5 font-urdu">
                  {status.ur}
                </span>
              </>
            ) : (
              'No incident being tracked'
            )}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {polling && (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-clinical-cyan/45 bg-clinical-cyan/10 px-2.5 py-1 text-[10px] uppercase tracking-wider text-clinical-cyan">
              <StatusDot tone="cyan" pulse /> live
            </span>
          )}
          {!backendOnline && <Tag tone="critical">feed stalled</Tag>}
        </div>
      </header>

      {/* Real-time condition badges */}
      {(coverageGap || escalated || ambulance) && (
        <div className="flex flex-wrap gap-2 px-5 pb-3">
          {coverageGap && (
            <span className="tag border-iris-glow bg-iris-pulse/25 text-pearl shadow-glow normal-case tracking-normal">
              <StatusDot tone="critical" pulse />
              Coverage Gap
              <span dir="rtl" className="font-urdu text-[12px] normal-case">
                کوریج کا خلا
              </span>
            </span>
          )}
          {escalated && (
            <span className="tag border-tier-critical/60 bg-tier-critical/15 text-tier-critical normal-case tracking-normal animate-pulse-ring-critical">
              Mid-Incident Escalated
              <span dir="rtl" className="font-urdu text-[12px] normal-case">
                حالت بگڑ گئی
              </span>
            </span>
          )}
          {ambulance && (
            <span className="tag border-clinical-cyan/60 bg-clinical-cyan/15 text-clinical-cyan normal-case tracking-normal">
              <AmbulanceIcon />
              Ambulance Requested
              <span dir="rtl" className="font-urdu text-[12px] normal-case">
                ایمبولینس طلب
              </span>
            </span>
          )}
        </div>
      )}

      <div className="hairline-top min-h-0 flex-1 overflow-y-auto px-5 py-4">
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
          <ol className="relative">
            {/* Vertical progress rail */}
            <span
              aria-hidden="true"
              className="absolute left-[7px] top-2 bottom-2 w-px bg-iris-border"
            />
            {updates.map((u, i) => (
              <TimelineRow
                key={u.update_id ?? `${u.stage}-${i}`}
                update={u}
                isLast={i === updates.length - 1}
                closed={isClosed}
              />
            ))}

            {/* Pending next-step placeholder keeps the rail visually alive. */}
            {!isClosed && (
              <li className="relative flex gap-3.5 pb-1 pl-0">
                <span className="relative z-10 mt-1.5 h-3.5 w-3.5 shrink-0 rounded-full border border-iris-border bg-iris-canvas">
                  <span className="absolute inset-[3px] rounded-full bg-clinical-cyan/60 animate-pulse" />
                </span>
                <p className="pt-1 text-[11px] italic text-ash/70">
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
  isLast,
  closed,
}: {
  update: ReporterUpdate
  isLast: boolean
  closed: boolean
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
            ? 'border-mint-vital bg-mint-vital/25'
            : tone === 'critical'
              ? 'border-tier-critical bg-tier-critical/25'
              : 'border-clinical-cyan bg-clinical-cyan/25'
        }`}
      >
        {(isLast && !closed) || tone === 'critical' ? (
          <span
            className={`absolute -inset-1 rounded-full ${
              tone === 'critical'
                ? 'animate-pulse-ring-critical'
                : 'animate-pulse-ring'
            }`}
          />
        ) : null}
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-[10px] font-medium uppercase tracking-wider text-ash">
            {meta.label_en}
          </span>
          <time
            className="shrink-0 font-mono text-[10px] tabular-nums text-ash/80"
            dateTime={update.timestamp}
          >
            {formatClock(update.timestamp)}
          </time>
        </div>

        {/* High-contrast Urdu message — the primary content of the feed. */}
        <p
          dir="rtl"
          className={`mt-1 text-[15px] leading-8 font-urdu ${
            tone === 'critical'
              ? 'text-tier-critical'
              : tone === 'mint'
                ? 'text-mint-vital'
                : 'text-pearl'
          }`}
        >
          {message}
        </p>

        {update.update_id && (
          <p className="mt-0.5 font-mono text-[10px] text-ash/55">
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
