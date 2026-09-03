/**
 * View 3 — BHU Clinic & Audit (verification gate + outcome sign-off).
 *
 * Contract notes:
 *   - POST /responders/{id}/verify needs { verified_by, equipment_checklist }
 *     with a NON-EMPTY checklist, else 400 INVALID_VERIFICATION.
 *   - POST /emergency/incident/{id}/close needs { outcome, confirmed_by,
 *     closed_by_id }. `confirmed_by` is restricted to lifecycle.VALID_CONFIRMERS
 *     = "bhu_staff" | "responder"; the actor identity from the brief
 *     (`bhu_staff_01`) belongs in the separate free-text `closed_by_id`.
 *   - Module 5 metrics are awarded ONLY when confirmed_by === "bhu_staff".
 *     Selecting "responder" is kept available precisely to demonstrate that the
 *     fraud gate refuses to count a self-reported closure.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'

import { useCockpit, incidentResponderId } from '../state/CockpitContext'
import { getResponderPerformance, listPendingResponders } from '../lib/api'
import { usePoll } from '../hooks/usePoll'
import {
  availabilityMeta,
  CONFIRMER_OPTIONS,
  EQUIPMENT_ITEMS,
  formatClock,
  formatDuration,
  humaniseFlag,
  OUTCOME_OPTIONS,
  outcomeLabel,
  tierMeta,
} from '../lib/urdu'
import type { OutcomeConfirmer, OutcomeType, PerformanceRecord, Responder } from '../lib/types'
import {
  Card,
  EmptyState,
  ErrorNote,
  Metric,
  Pill,
  Spinner,
  StatusDot,
  Tag,
  TierBadge,
} from '../components/ui'

const DEFAULT_ACTOR = 'bhu_staff_01'
const DEFAULT_VERIFIER = 'BHU-001-STAFF'

export function BhuView() {
  const {
    incident,
    record,
    lastReport,
    responders,
    closeActiveIncident,
    verifyCandidate,
    incidentId,
    setRole,
  } = useCockpit()

  const assignedResponderId = incidentResponderId(record, lastReport)

  return (
    <div className="flex flex-col gap-4">
      <VerificationGate onVerified={verifyCandidate} />

      <ClosureGate
        incidentId={incidentId}
        onClose={closeActiveIncident}
        closed={Boolean(incident?.incident_closed_timestamp)}
        incident={incident}
      />

      <AccountabilityScorecard
        responders={responders}
        defaultResponderId={assignedResponderId}
      />

      <div className="flex flex-wrap gap-2 px-1">
        <Pill variant="ghost" onClick={() => setRole('reporter')}>
          ← Reporter View
        </Pill>
        <Pill variant="ghost" onClick={() => setRole('responder')}>
          ← Responder View
        </Pill>
      </div>
    </div>
  )
}

// ===========================================================================
// Candidate responder verification
// ===========================================================================

function VerificationGate({
  onVerified,
}: {
  onVerified: (p: {
    responderId: string
    verified_by: string
    equipment_checklist: string[]
  }) => Promise<Responder | null>
}) {
  const pendingPoll = usePoll(
    async () => (await listPendingResponders()).pending_responders,
    [],
    { intervalMs: 12_000 },
  )

  const [checks, setChecks] = useState<Record<string, string[]>>({})
  const [verifier, setVerifier] = useState(DEFAULT_VERIFIER)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)

  const pending = pendingPoll.data ?? []

  function toggle(responderId: string, item: string) {
    setChecks((prev) => {
      const current = prev[responderId] ?? []
      const next = current.includes(item)
        ? current.filter((x) => x !== item)
        : [...current, item]
      return { ...prev, [responderId]: next }
    })
  }

  async function verify(responderId: string) {
    const checklist = checks[responderId] ?? []
    if (checklist.length === 0) {
      setFailure(
        'Inspect at least one equipment item before signing off — the backend rejects an empty checklist with INVALID_VERIFICATION.',
      )
      return
    }
    if (!verifier.trim()) {
      setFailure('A verifying actor id is required.')
      return
    }
    setFailure(null)
    setBusyId(responderId)
    await onVerified({
      responderId,
      verified_by: verifier.trim(),
      equipment_checklist: checklist,
    })
    setBusyId(null)
    void pendingPoll.refresh()
  }

  return (
    <Card
      title="Candidate Responder Verification"
      titleUr="امیدوار کی تصدیق"
      subtitle="Module 7 gate — a candidate is not dispatch-eligible until a trainer or BHU signs off the equipment inspection."
      right={
        <div className="flex items-center gap-2">
          <Tag tone={pending.length > 0 ? 'cyan' : 'mint'}>
            {pending.length} pending
          </Tag>
          <Pill variant="ghost" size="sm" onClick={() => void pendingPoll.refresh()}>
            Refresh
          </Pill>
        </div>
      }
      panel
    >
      <div className="mb-3 flex flex-wrap items-end gap-3">
        <div>
          <label className="label" htmlFor="verifier">
            Verifying actor
          </label>
          <input
            id="verifier"
            className="field w-56 font-mono text-xs"
            value={verifier}
            onChange={(e) => setVerifier(e.target.value)}
          />
        </div>
        <p className="max-w-md text-[11px] text-ash/75">
          Recorded as <span className="font-mono text-ash">verified_by</span> on the
          responder and stamped with the current time.
        </p>
      </div>

      {failure && (
        <div className="mb-3">
          <ErrorNote code="INVALID_VERIFICATION" message={failure} />
        </div>
      )}

      {!pendingPoll.loaded && pendingPoll.error === null ? (
        <div className="flex items-center gap-2 py-6 text-xs text-ash">
          <Spinner /> Loading candidate registry…
        </div>
      ) : pending.length === 0 ? (
        <EmptyState
          title="No candidates awaiting verification"
          titleUr="تصدیق کے لیے کوئی امیدوار نہیں"
          message={
            pendingPoll.error
              ? `Registry query failed: ${pendingPoll.error.code} — ${pendingPoll.error.message}`
              : 'Every registered responder is already verified. Register a candidate via POST /api/v1/responders/register to exercise this gate.'
          }
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] border-collapse text-left">
            <thead>
              <tr className="border-b border-iris-border">
                {['Responder', 'Village', 'Training', 'Equipment inspection', ''].map(
                  (h) => (
                    <th
                      key={h}
                      className="px-3 py-2 text-[10px] font-medium uppercase tracking-wider text-ash"
                    >
                      {h}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {pending.map((r) => {
                const selected = checks[r.responder_id] ?? []
                const avMeta = availabilityMeta(r.current_availability_status)
                return (
                  <tr
                    key={r.responder_id}
                    className="border-b border-iris-border/55 last:border-0"
                  >
                    <td className="px-3 py-3 align-top">
                      <p className="text-sm font-medium tracking-tight text-pearl">
                        {r.name}
                      </p>
                      <p className="font-mono text-[10px] text-ash">
                        {r.responder_id}
                      </p>
                      <span
                        className={`mt-1 inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] ${avMeta.bg} ${avMeta.border} ${avMeta.text}`}
                      >
                        {avMeta.en}
                      </span>
                    </td>
                    <td className="px-3 py-3 align-top">
                      <p className="text-xs text-pearl">{r.village}</p>
                      <p className="font-mono text-[10px] text-ash">
                        {r.linked_bhu_id}
                      </p>
                      {r.phone_number && (
                        <p className="font-mono text-[10px] text-ash/75">
                          {r.phone_number}
                        </p>
                      )}
                    </td>
                    <td className="px-3 py-3 align-top">
                      <p className="text-xs text-pearl">
                        {r.training_completed ? 'Completed' : 'Not recorded'}
                      </p>
                      {r.training_org && (
                        <p className="text-[10px] text-ash">{r.training_org}</p>
                      )}
                    </td>
                    <td className="px-3 py-3 align-top">
                      <div className="flex flex-col gap-1.5">
                        {EQUIPMENT_ITEMS.map((item) => {
                          const checked = selected.includes(item.value)
                          return (
                            <label
                              key={item.value}
                              className="flex cursor-pointer items-center gap-2 text-[11px]"
                            >
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() => toggle(r.responder_id, item.value)}
                                className="h-3.5 w-3.5 rounded-full accent-mint-vital"
                              />
                              <span className={checked ? 'text-mint-vital' : 'text-ash'}>
                                {item.label_en}
                              </span>
                              <span dir="rtl" className="font-urdu text-[12px] text-ash/70">
                                {item.label_ur}
                              </span>
                            </label>
                          )
                        })}
                      </div>
                    </td>
                    <td className="px-3 py-3 align-top">
                      <Pill
                        variant="mint"
                        size="sm"
                        onClick={() => void verify(r.responder_id)}
                        disabled={busyId === r.responder_id}
                        className="whitespace-nowrap"
                      >
                        {busyId === r.responder_id ? (
                          <Spinner className="h-3 w-3" />
                        ) : (
                          'Verify & Activate Responder'
                        )}
                      </Pill>
                      <p className="mt-1 text-[10px] text-ash/65 tabular-nums">
                        {selected.length}/{EQUIPMENT_ITEMS.length} checked
                      </p>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}

// ===========================================================================
// Incident closure & fraud-prevention gate
// ===========================================================================

function ClosureGate({
  incidentId,
  incident,
  closed,
  onClose,
}: {
  incidentId: string | null
  incident: ReturnType<typeof useCockpit>['incident']
  closed: boolean
  onClose: (p: {
    outcome: OutcomeType
    confirmed_by: OutcomeConfirmer
    closed_by_id?: string
  }) => Promise<unknown | null>
}) {
  const [outcome, setOutcome] = useState<OutcomeType>('taken_to_bhu')
  const [confirmer, setConfirmer] = useState<OutcomeConfirmer>('bhu_staff')
  const [actor, setActor] = useState(DEFAULT_ACTOR)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ counted: boolean } | null>(null)

  const meta = tierMeta(incident?.severity_tier ?? null)
  const countsTowardMetrics = confirmer === 'bhu_staff'

  async function submit() {
    if (!incidentId) return
    setBusy(true)
    const res = await onClose({
      outcome,
      confirmed_by: confirmer,
      closed_by_id: actor.trim() || undefined,
    })
    setBusy(false)
    // outcome_recorded is null exactly when the fraud gate refused to count it.
    setResult(
      res ? { counted: (res as { outcome_recorded?: unknown }).outcome_recorded != null } : null,
    )
  }

  if (!incidentId || !incident) {
    return (
      <Card title="Incident Closure & Audit" titleUr="واقعہ بند کرنا اور آڈٹ" panel>
        <EmptyState
          title="No active incident to close"
          titleUr="بند کرنے کے لیے کوئی واقعہ نہیں"
          message="Report an emergency first. Closure writes the outcome, releases the responder back to available, and — only for BHU-verified sign-off — contributes Module 5 metrics."
        />
      </Card>
    )
  }

  return (
    <Card
      title="Incident Closure & Fraud Prevention Gate"
      titleUr="واقعہ بند کریں اور آڈٹ ریکارڈ کریں"
      subtitle="Closed records are immutable — a second close attempt returns 409 ALREADY_CLOSED."
      right={<TierBadge tier={incident.severity_tier} size="sm" />}
      panel
    >
      <div className="flex flex-col gap-4">
        {/* Active incident detail */}
        <div
          className={`rounded-card border px-4 py-3 ${meta.bg} ${meta.border}`}
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="font-mono text-xs text-ash">{incident.incident_id}</p>
              <p className="mt-0.5 text-sm font-semibold tracking-tight text-pearl">
                {incident.gps_location.village_id} · reported{' '}
                {formatClock(incident.timestamp_reported)}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {closed ? (
                <Tag tone="mint">closed {formatClock(incident.incident_closed_timestamp)}</Tag>
              ) : (
                <Tag tone="cyan">open</Tag>
              )}
              {incident.ambulance_requested && <Tag tone="critical">ambulance</Tag>}
              {incident.coverage_gap && <Tag tone="critical">coverage gap</Tag>}
              {incident.mid_incident_escalated && <Tag tone="critical">escalated</Tag>}
              <Tag tone="ash">fallbacks: {incident.dispatch_fallback_count}</Tag>
            </div>
          </div>

          <div className="mt-2.5 flex flex-wrap gap-1.5">
            {incident.injury_type_flags.map((f) => (
              <span key={f} className="tag normal-case tracking-normal border-iris-border bg-iris-canvas/50 text-ash">
                {humaniseFlag(f)}
              </span>
            ))}
          </div>

          {incident.outcome && (
            <p className="mt-2.5 text-xs text-pearl">
              Recorded outcome:{' '}
              <span className="text-mint-vital">{outcomeLabel(incident.outcome).en}</span>
              <span dir="rtl" className="ml-2 font-urdu text-ash">
                {outcomeLabel(incident.outcome).ur}
              </span>
              <span className="ml-2 font-mono text-[10px] text-ash">
                confirmed_by={incident.outcome_confirmed_by ?? '—'}
              </span>
            </p>
          )}
        </div>

        {/* Closure controls */}
        <div className="grid gap-4 sm:grid-cols-3">
          <div>
            <label className="label" htmlFor="outcome">
              Outcome
            </label>
            <select
              id="outcome"
              className="field-select"
              value={outcome}
              disabled={closed}
              onChange={(e) => setOutcome(e.target.value as OutcomeType)}
            >
              {OUTCOME_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label_en} ({o.value})
                </option>
              ))}
            </select>
            <p dir="rtl" className="mt-1 text-[12px] text-ash font-urdu leading-6">
              {outcomeLabel(outcome).ur}
            </p>
          </div>

          <div>
            <label className="label" htmlFor="confirmer">
              Confirmed by
            </label>
            <select
              id="confirmer"
              className="field-select"
              value={confirmer}
              disabled={closed}
              onChange={(e) => setConfirmer(e.target.value as OutcomeConfirmer)}
            >
              {CONFIRMER_OPTIONS.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label_en}
                </option>
              ))}
            </select>
            <p
              className={`mt-1 text-[10px] ${countsTowardMetrics ? 'text-mint-vital' : 'text-tier-critical'}`}
            >
              {CONFIRMER_OPTIONS.find((c) => c.value === confirmer)?.note}
            </p>
          </div>

          <div>
            <label className="label" htmlFor="actor">
              Sign-off actor
            </label>
            <input
              id="actor"
              className="field font-mono text-xs"
              value={actor}
              disabled={closed}
              onChange={(e) => setActor(e.target.value)}
            />
            <p className="mt-1 text-[10px] text-ash/70">
              Sent as <span className="font-mono">closed_by_id</span> — the audit
              trail identity, distinct from the confirmer role above.
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Pill
            variant={countsTowardMetrics ? 'mint' : 'danger'}
            size="lg"
            onClick={submit}
            disabled={busy || closed}
          >
            {busy ? (
              <Spinner />
            ) : (
              <>
                <span dir="rtl" className="font-urdu text-[15px] leading-7">
                  واقعہ بند کریں اور آڈٹ ریکارڈ کریں
                </span>
                <span className="opacity-80">(Close Incident & Record Audit)</span>
              </>
            )}
          </Pill>

          {closed && (
            <span className="inline-flex items-center gap-2 text-xs text-mint-vital">
              <StatusDot tone="mint" /> Record is immutable — closure already signed off.
            </span>
          )}
        </div>

        {result && !closed && (
          <div
            className={`rounded-card border px-4 py-2.5 text-xs ${
              result.counted
                ? 'border-mint-vital/50 bg-mint-vital/10 text-mint-vital'
                : 'border-tier-critical/50 bg-tier-critical/10 text-tier-critical'
            }`}
          >
            {result.counted
              ? 'Module 5 recorded this outcome — points/metrics awarded only on BHU-verified closure.'
              : 'Fraud gate held: outcome_recorded is null, so this closure contributes nothing to accountability metrics.'}
          </div>
        )}
      </div>
    </Card>
  )
}

// ===========================================================================
// Live accountability scorecard
// ===========================================================================

function AccountabilityScorecard({
  responders,
  defaultResponderId,
}: {
  responders: Responder[]
  defaultResponderId: string | null
}) {
  const [selectedId, setSelectedId] = useState<string>(
    defaultResponderId ?? responders[0]?.responder_id ?? '',
  )
  const [perf, setPerf] = useState<PerformanceRecord | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  // Adopt the incident's assigned responder as soon as one exists.
  useEffect(() => {
    if (defaultResponderId) setSelectedId(defaultResponderId)
  }, [defaultResponderId])

  useEffect(() => {
    if (!selectedId) return
    let cancelled = false
    setLoading(true)
    getResponderPerformance(selectedId)
      .then((res) => {
        if (cancelled) return
        setPerf(res)
        setError(null)
      })
      .catch((cause: unknown) => {
        if (cancelled) return
        setPerf(null)
        setError(
          cause instanceof Error ? cause.message : 'Performance record unavailable.',
        )
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [selectedId])

  const reload = useCallback(() => {
    if (!selectedId) return
    setLoading(true)
    getResponderPerformance(selectedId)
      .then((res) => {
        setPerf(res)
        setError(null)
      })
      .catch(() => setError('Performance record unavailable.'))
      .finally(() => setLoading(false))
  }, [selectedId])

  const statusFlag = perf?.status_flag ?? null
  const flagTone =
    statusFlag === 'active' ? 'mint' : statusFlag === 'under_review' ? 'critical' : 'cyan'

  const outcomeBreakdown = useMemo(
    () => Object.entries(perf?.incidents_by_outcome ?? {}),
    [perf],
  )

  return (
    <Card
      title="Live Accountability Scorecard"
      titleUr="کارکردگی ریکارڈ"
      subtitle="Module 5 — factual operational metrics only. No composite score, no tier, no ranking: scoring well must never outrank helping."
      right={
        <div className="flex items-center gap-2">
          <select
            aria-label="Responder"
            className="field-select py-1.5 text-xs"
            value={selectedId}
            onChange={(e) => setSelectedId(e.target.value)}
          >
            {responders.length === 0 && <option value="">no responders loaded</option>}
            {responders.map((r) => (
              <option key={r.responder_id} value={r.responder_id}>
                {r.name} ({r.responder_id})
              </option>
            ))}
          </select>
          <Pill variant="ghost" size="sm" onClick={reload} disabled={loading}>
            {loading ? <Spinner className="h-3 w-3" /> : 'Reload'}
          </Pill>
        </div>
      }
      panel
    >
      {error && (
        <div className="mb-3">
          <ErrorNote code="PERFORMANCE_UNAVAILABLE" message={error} />
        </div>
      )}

      {!perf ? (
        <EmptyState
          title="No performance record loaded"
          titleUr="کارکردگی ریکارڈ دستیاب نہیں"
          message={
            loading
              ? 'Fetching the Module 5 record…'
              : 'Select a responder above. Metrics are recomputed from BHU-confirmed closures and the Module 3 dispatch audit trail.'
          }
        />
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-3">
            <span
              className={`inline-flex items-center gap-2 rounded-full border px-4 py-2 text-sm font-semibold tracking-tight ${
                flagTone === 'mint'
                  ? 'border-mint-vital/55 bg-mint-vital/12 text-mint-vital animate-pulse-ring-mint'
                  : flagTone === 'critical'
                    ? 'border-tier-critical/55 bg-tier-critical/12 text-tier-critical'
                    : 'border-clinical-cyan/55 bg-clinical-cyan/12 text-clinical-cyan'
              }`}
            >
              <StatusDot tone={flagTone} pulse={flagTone === 'mint'} />
              reliability flag: {perf.status_flag}
            </span>
            <span className="font-mono text-xs text-ash">{perf.responder_id}</span>
          </div>

          <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
            <Metric
              label="Acceptance rate"
              value={perf.dispatch_metrics.acceptance_rate_pct.toFixed(1)}
              unit="%"
              tone="cyan"
              hint={`${perf.dispatch_metrics.completed}/${perf.dispatch_metrics.total_assigned} assigned completed`}
            />
            <Metric
              label="Avg response time"
              value={perf.average_response_time_seconds.toFixed(1)}
              unit="s"
              tone="cyan"
              hint={formatDuration(perf.average_response_time_seconds)}
            />
            <Metric
              label="Timeouts"
              value={perf.timeout_count}
              tone={perf.timeout_count > 0 ? 'critical' : 'mint'}
              hint="ack window exceeded"
            />
            <Metric
              label="Declines"
              value={perf.decline_count}
              tone={perf.decline_count > 0 ? 'critical' : 'mint'}
              hint="fallback walker triggered"
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-card border border-iris-border bg-iris-canvas/45 px-4 py-3">
              <p className="label">Verified incidents responded to</p>
              <p className="metric-value">{perf.incidents_responded_to}</p>
              <p className="mt-1 text-[10px] text-ash/70">
                BHU-confirmed closures only — self-reported completions are excluded.
              </p>
            </div>

            <div className="rounded-card border border-iris-border bg-iris-canvas/45 px-4 py-3">
              <p className="label">Incidents by outcome</p>
              {outcomeBreakdown.length === 0 ? (
                <p className="text-xs text-ash/70">No verified outcomes yet.</p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {outcomeBreakdown.map(([key, count]) => (
                    <span
                      key={key}
                      className="tag normal-case tracking-normal border-iris-border bg-iris-shadow text-ash"
                    >
                      {outcomeLabel(key).en}
                      <span className="ml-1 font-semibold text-pearl tabular-nums">
                        {count as number}
                      </span>
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </Card>
  )
}
