/**
 * View 3 — BHU & Audit (verification gate + outcome sign-off).
 *
 * Contract notes:
 *   - POST /responders/{id}/verify needs { verified_by, equipment_checklist }
 *     with a NON-EMPTY checklist, else 400 INVALID_VERIFICATION.
 *   - POST /emergency/incident/{id}/close needs { outcome, confirmed_by,
 *     closed_by_id }. `confirmed_by` is restricted to lifecycle.VALID_CONFIRMERS
 *     = "bhu_staff" | "responder"; the actor identity from the brief
 *     (`bhu_staff_01`) belongs in the separate free-text `closed_by_id`.
 *   - Accountability metrics are awarded ONLY when confirmed_by === "bhu_staff".
 *   - Seed Unverified Candidate button for instant on-demand demo verification.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'

import { useCockpit, incidentResponderId } from '../state/CockpitContext'
import {
  clearPendingResponders,
  deleteResponder,
  getResponderPerformance,
  listPendingResponders,
  registerCandidateResponder,
} from '../lib/api'
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
  const [seeding, setSeeding] = useState(false)
  const [clearing, setClearing] = useState(false)
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

  async function handleSeedCandidate() {
    setSeeding(true)
    setFailure(null)
    try {
      const seedNum = Math.floor(100 + Math.random() * 900)
      const names = [
        'Hamza Tariq (حمزہ طارق)',
        'Bilal Ahmed (بلال احمد)',
        'Fatima Noor (فاطمہ نور)',
        'Usman Ghani (عثمان غنی)',
      ]
      const randomName = names[Math.floor(Math.random() * names.length)]
      await registerCandidateResponder({
        name: randomName,
        village: 'VILLAGE-A',
        phone_number: `+92 300 555${seedNum}`,
        linked_bhu_id: 'BHU-001',
        training_completed: true,
        training_org: 'Punjab Emergency Services (Rescue 1122)',
      })
      await pendingPoll.refresh()
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      setFailure(`Failed to seed candidate: ${message}`)
    } finally {
      setSeeding(false)
    }
  }

  async function handleClearPending() {
    setClearing(true)
    setFailure(null)
    try {
      await clearPendingResponders()
      setChecks({})
      await pendingPoll.refresh()
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      setFailure(`Failed to clear candidates: ${message}`)
    } finally {
      setClearing(false)
    }
  }

  async function handleDeleteCandidate(responderId: string) {
    setBusyId(responderId)
    setFailure(null)
    try {
      await deleteResponder(responderId)
      await pendingPoll.refresh()
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      setFailure(`Failed to delete candidate: ${message}`)
    } finally {
      setBusyId(null)
    }
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
      subtitle="Candidate verification gate — volunteers require BHU staff sign-off and equipment inspection before activation."
      right={
        <div className="flex items-center gap-2">
          <Pill
            variant="cyan"
            size="sm"
            onClick={handleSeedCandidate}
            disabled={seeding || clearing}
            title="Populate an unverified candidate for demo verification"
          >
            {seeding ? <Spinner className="h-3 w-3" /> : '➕ Seed Unverified Candidate'}
          </Pill>
          {pending.length > 0 && (
            <Pill
              variant="danger"
              size="sm"
              onClick={handleClearPending}
              disabled={clearing || seeding}
              title="Clear all pending unverified candidates"
            >
              {clearing ? <Spinner className="h-3 w-3" /> : '🗑️ Clear Pending Candidates'}
            </Pill>
          )}
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
      <div className="mb-4 flex flex-wrap items-end gap-3 rounded-2xl border border-slate-200 bg-slate-50/70 p-3.5">
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
        <p className="max-w-md text-[11px] text-slate-500">
          Recorded as <span className="font-mono font-semibold text-slate-700">verified_by</span> on the
          responder and stamped with the sign-off timestamp.
        </p>
      </div>

      {failure && (
        <div className="mb-3">
          <ErrorNote code="VERIFICATION_ALERT" message={failure} />
        </div>
      )}

      {!pendingPoll.loaded && pendingPoll.error === null ? (
        <div className="flex items-center gap-2 py-6 text-xs text-slate-500">
          <Spinner /> Loading candidate registry…
        </div>
      ) : pending.length === 0 ? (
        <EmptyState
          title="No candidates awaiting verification"
          titleUr="تصدیق کے لیے کوئی امیدوار نہیں"
          message="Every registered responder is currently verified. Click 'Seed Unverified Candidate' above to test the candidate verification gate."
          action={
            <Pill variant="cyan" size="sm" onClick={handleSeedCandidate} disabled={seeding}>
              ➕ Seed Unverified Candidate
            </Pill>
          }
        />
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-slate-200">
          <table className="w-full min-w-[720px] border-collapse text-left bg-white">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50">
                {['Responder', 'Village / BHU', 'Training', 'Equipment inspection', 'Action'].map(
                  (h) => (
                    <th
                      key={h}
                      className="px-4 py-2.5 text-[10px] font-bold uppercase tracking-wider text-slate-600"
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
                    className="border-b border-slate-100 last:border-0 hover:bg-slate-50/50 transition-colors"
                  >
                    <td className="px-4 py-3 align-top">
                      <p className="text-sm font-bold tracking-tight text-slate-900">
                        {r.name}
                      </p>
                      <p className="font-mono text-[10px] text-slate-500">
                        {r.responder_id}
                      </p>
                      <span
                        className="mt-1 inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-700"
                      >
                        {avMeta.en}
                      </span>
                    </td>
                    <td className="px-4 py-3 align-top">
                      <p className="text-xs font-semibold text-slate-800">{r.village}</p>
                      <p className="font-mono text-[10px] text-slate-500">
                        {r.linked_bhu_id}
                      </p>
                      {r.phone_number && (
                        <p className="font-mono text-[10px] text-slate-500">
                          {r.phone_number}
                        </p>
                      )}
                    </td>
                    <td className="px-4 py-3 align-top">
                      <p className="text-xs font-semibold text-slate-800">
                        {r.training_completed ? 'Completed' : 'Not recorded'}
                      </p>
                      {r.training_org && (
                        <p className="text-[10px] text-slate-500">{r.training_org}</p>
                      )}
                    </td>
                    <td className="px-4 py-3 align-top">
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
                                className="h-3.5 w-3.5 rounded-full accent-emerald-600"
                              />
                              <span className={checked ? 'text-emerald-700 font-semibold' : 'text-slate-600'}>
                                {item.label_en}
                              </span>
                              <span dir="rtl" className="font-urdu text-[12px] text-slate-400">
                                {item.label_ur}
                              </span>
                            </label>
                          )
                        })}
                      </div>
                    </td>
                    <td className="px-4 py-3 align-top">
                      <div className="flex flex-col gap-1.5">
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
                            'Verify & Activate'
                          )}
                        </Pill>
                        <button
                          type="button"
                          onClick={() => void handleDeleteCandidate(r.responder_id)}
                          disabled={busyId === r.responder_id}
                          className="inline-flex items-center justify-center gap-1 rounded-full border border-rose-200 bg-rose-50/80 px-2.5 py-1 text-[11px] font-medium text-rose-700 hover:bg-rose-100 transition-colors"
                          title="Remove this candidate"
                        >
                          <span>✕</span>
                          <span>Remove</span>
                          <span dir="rtl" className="font-urdu text-[11px]">(حذف کریں)</span>
                        </button>
                      </div>
                      <p className="mt-1 text-[10px] text-slate-500 tabular-nums">
                        {selected.length}/{EQUIPMENT_ITEMS.length} items checked
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
          message="Report an emergency first. Closure writes the outcome, releases the responder back to available, and — only for BHU-verified sign-off — contributes to accountability metrics."
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
          className={`rounded-2xl border p-4 ${
            incident.severity_tier === 'critical'
              ? 'border-rose-200 bg-rose-50/70 text-rose-950'
              : 'border-sky-200 bg-sky-50/70 text-sky-950'
          }`}
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="font-mono text-xs font-semibold opacity-70">{incident.incident_id}</p>
              <p className="mt-0.5 text-sm font-bold tracking-tight">
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
              <span key={f} className="tag normal-case tracking-normal border-slate-200 bg-white text-slate-700">
                {humaniseFlag(f)}
              </span>
            ))}
          </div>

          {incident.outcome && (
            <p className="mt-2.5 text-xs font-semibold text-slate-800">
              Recorded outcome:{' '}
              <span className="text-emerald-700 font-bold">{outcomeLabel(incident.outcome).en}</span>
              <span dir="rtl" className="ml-2 font-urdu text-slate-600">
                {outcomeLabel(incident.outcome).ur}
              </span>
              <span className="ml-2 font-mono text-[10px] text-slate-500">
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
            <p dir="rtl" className="mt-1 text-[12px] text-slate-500 font-urdu leading-6">
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
              className={`mt-1 text-[10px] font-medium ${countsTowardMetrics ? 'text-emerald-700' : 'text-rose-700'}`}
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
            <p className="mt-1 text-[10px] text-slate-500">
              Sent as <span className="font-mono font-semibold">closed_by_id</span> for the audit trail.
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3 pt-1">
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
            <span className="inline-flex items-center gap-2 text-xs font-semibold text-emerald-700">
              <StatusDot tone="mint" /> Record is immutable — closure already signed off.
            </span>
          )}
        </div>

        {result && !closed && (
          <div
            className={`rounded-2xl border p-3 text-xs font-medium ${
              result.counted
                ? 'border-emerald-300 bg-emerald-50 text-emerald-800'
                : 'border-rose-300 bg-rose-50 text-rose-800'
            }`}
          >
            {result.counted
              ? 'Accountability system recorded this outcome — verified only on BHU staff closure.'
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
      subtitle="Operational reliability metrics and response history."
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
              ? 'Fetching the performance record…'
              : 'Select a responder above. Metrics are recomputed from BHU-confirmed closures and the dispatch audit trail.'
          }
        />
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-3">
            <span
              className={`inline-flex items-center gap-2 rounded-full border px-4 py-2 text-sm font-bold tracking-tight ${
                flagTone === 'mint'
                  ? 'border-emerald-300 bg-emerald-50 text-emerald-800'
                  : flagTone === 'critical'
                    ? 'border-rose-300 bg-rose-50 text-rose-800'
                    : 'border-sky-300 bg-sky-50 text-sky-800'
              }`}
            >
              <StatusDot tone={flagTone} />
              reliability flag: {perf.status_flag}
            </span>
            <span className="font-mono text-xs font-semibold text-slate-500">{perf.responder_id}</span>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
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
            <div className="rounded-2xl border border-slate-200 bg-slate-50/80 p-4">
              <p className="label">Verified incidents responded to</p>
              <p className="metric-value">{perf.incidents_responded_to}</p>
              <p className="mt-1 text-[10px] text-slate-500">
                BHU-confirmed closures only — self-reported completions are excluded.
              </p>
            </div>

            <div className="rounded-2xl border border-slate-200 bg-slate-50/80 p-4">
              <p className="label">Incidents by outcome</p>
              {outcomeBreakdown.length === 0 ? (
                <p className="text-xs text-slate-500">No verified outcomes yet.</p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {outcomeBreakdown.map(([key, count]) => (
                    <span
                      key={key}
                      className="tag normal-case tracking-normal border-slate-200 bg-white text-slate-700"
                    >
                      {outcomeLabel(key).en}
                      <span className="ml-1 font-bold text-slate-900 tabular-nums">
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
