/**
 * View 3 — Dispatch & BHU panel of the three-panel demo cockpit.
 *
 * Layout for the demo directive:
 *   top    -> full-width Leaflet situation map (incident pin, responder and
 *             ambulance route vectors, village markers)
 *   below  -> live dispatch facts + formal closure + performance scorecard
 *
 * The Module 7 candidate-verification gate is deliberately NOT mounted here:
 * the demo directive excludes registration/verification UI, so Module 7 stays
 * backend-only. `VerificationGate` remains in this file, exported and
 * type-checked, for non-demo surfaces.
 *
 * Contract notes (unchanged by the redesign — these are backend facts):
 *   - POST /responders/{id}/verify needs { verified_by, equipment_checklist }
 *     with a NON-EMPTY checklist, else 400 INVALID_VERIFICATION.
 *   - POST /emergency/incident/{id}/close needs { outcome, confirmed_by,
 *     closed_by_id }. `confirmed_by` is restricted to lifecycle.VALID_CONFIRMERS
 *     = "bhu_staff" | "responder"; the actor identity from the brief
 *     (`bhu_staff_01`) belongs in the separate free-text `closed_by_id`.
 *   - Accountability metrics are awarded ONLY when confirmed_by === "bhu_staff".
 *     That fraud gate is surfaced in the UI rather than hidden, per the project's
 *     inspectable-decisions rule.
 *   - `bhu_urgency` is only present on the POST /emergency/report response
 *     (`dispatch.bhu_urgency`) — the incident record itself carries just the
 *     boolean `bhu_notified`.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'

import { useCockpit, incidentResponderId } from '../state/CockpitContext'
import {
  clearPendingResponders,
  deleteResponder,
  getPointTransactions,
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
  statusLabel,
} from '../lib/urdu'
import type {
  IncidentRecord,
  OutcomeConfirmer,
  OutcomeType,
  PerformanceRecord,
  PointTransaction,
  ReportResponse,
  Responder,
} from '../lib/types'
import { SituationMap } from '../components/SituationMap'
import { villageById } from '../lib/geography'
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
import { BhuBackground } from '../components/BackgroundMotifs'

function villageDisplay(id: string | null | undefined): string {
  return villageById(id)?.label_en ?? id ?? 'Local village'
}

const DEFAULT_ACTOR = 'bhu_staff_01'
const DEFAULT_VERIFIER = 'BHU-001-STAFF'

export function BhuView() {
  const {
    incident,
    record,
    lastReport,
    responders,
    timeline,
    closeActiveIncident,
    verifyCandidate,
    incidentId,
    lang,
    adoptIncident,
  } = useCockpit()

  const [activeTab, setActiveTab] = useState<'live' | 'candidates' | 'history'>('live')
  const assignedResponderId = incidentResponderId(record, lastReport)

  const isClosed = Boolean(incident?.incident_closed_timestamp)
  const isCritical = incident?.severity_tier === 'critical'
  const isEnRoute = (timeline?.updates ?? []).some((u) => u.stage === 'responder_en_route') && !isClosed

  return (
    <div className="flex flex-col gap-5">
      <BhuBackground />
      {/* ================= Clinical Facility Status & Tabs ================= */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-800 bg-surface px-5 py-3 text-xs">
        <div className="flex flex-wrap items-center gap-3">
          <span className="flex items-center gap-1.5 font-semibold text-ink">
            <span className="text-base" aria-hidden="true">🏥</span>
            {lang === 'ur' ? 'مرکزِ صحت کنٹرول' : 'BHU Command'}
          </span>
          <span className="text-ink-dim">·</span>
          <span className="flex items-center gap-1 text-sky-300">
            <StatusDot tone={isCritical ? 'critical' : 'mint'} pulse={isCritical} />
            {isCritical
              ? (lang === 'ur' ? '1 ہنگامی ایمرجنسی زیرِ عمل' : '1 Critical Incident Active')
              : (lang === 'ur' ? 'معمول کی نگرانی' : 'Standby / Normal Operations')}
          </span>
          {isEnRoute && (
            <span className="rounded-full border border-sky-500/30 bg-sky-500/10 px-2.5 py-0.5 text-[11px] font-bold text-sky-300">
              {lang === 'ur' ? 'رسپانڈر کو اطلاع' : 'Responder En Route'}
            </span>
          )}
        </div>

        <div className="flex items-center gap-1 rounded-full border border-slate-700 bg-sunken p-1">
          <button
            type="button"
            onClick={() => setActiveTab('live')}
            className={`rounded-full px-3 py-1 text-xs font-semibold transition-colors ${
              activeTab === 'live'
                ? 'bg-accent text-white shadow-sm'
                : 'text-ink-muted hover:text-ink'
            }`}
          >
            {lang === 'ur' ? '🗺️ لائیو صورتحال' : '🗺️ Live Situation'}
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('candidates')}
            className={`rounded-full px-3 py-1 text-xs font-semibold transition-colors ${
              activeTab === 'candidates'
                ? 'bg-accent text-white shadow-sm'
                : 'text-ink-muted hover:text-ink'
            }`}
          >
            {lang === 'ur' ? '📋 رضاکار تصدیق' : '📋 Verifications (M7)'}
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('history')}
            className={`rounded-full px-3 py-1 text-xs font-semibold transition-colors ${
              activeTab === 'history'
                ? 'bg-accent text-white shadow-sm'
                : 'text-ink-muted hover:text-ink'
            }`}
          >
            {lang === 'ur' ? '📜 تمام کیسز' : '📜 Cases History'}
          </button>
        </div>
      </div>

      {activeTab === 'candidates' ? (
        <VerificationGate onVerified={verifyCandidate} />
      ) : activeTab === 'history' ? (
        <BhuCaseHistoryView
          lang={lang}
          onSelectIncident={(id) => {
            adoptIncident(id)
            setActiveTab('live')
          }}
          onBack={() => setActiveTab('live')}
        />
      ) : (
        <>
          {/* ================= Top half — situation map ================= */}
          <SituationMap heightClass="h-[320px] xl:h-[440px]" />

          {/* ================= Bottom half — closure + scorecard ================= */}
          <div className="flex flex-col gap-5">
            <ClosureGate
              incidentId={incidentId}
              onClose={closeActiveIncident}
              closed={Boolean(incident?.incident_closed_timestamp)}
              incident={incident}
              responders={responders}
              assignedResponderId={assignedResponderId}
              dispatch={lastReport?.dispatch ?? null}
              status={timeline?.status ?? null}
            />

            <AccountabilityScorecard
              responders={responders}
              defaultResponderId={assignedResponderId}
              refreshKey={incident?.incident_closed_timestamp ?? null}
            />
          </div>
        </>
      )}
    </div>
  )
}

// ===========================================================================
// Candidate responder verification
// ===========================================================================

/**
 * Retained but NOT mounted in the demo cockpit: the demo directive excludes
 * registration/verification UI (Module 7 stays backend-only). Exported so the
 * component remains reachable for non-demo surfaces and type-checked.
 */
export function VerificationGate({
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
        village: 'TAMMAN',
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
      setFailure('A verifying supervisor id is required.')
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
      title="Candidate Verification Gate"
      titleUr="امیدوار کی تصدیق"
      right={<Tag tone={pending.length > 0 ? 'cyan' : 'mint'}>{pending.length} pending</Tag>}
      panel
    >
      <div className="flex flex-col gap-4">
        {/* ---- Toolbar ---- */}
        <div className="flex flex-wrap items-center gap-2">
          <Pill
            variant="primary"
            size="sm"
            loading={seeding}
            onClick={handleSeedCandidate}
            disabled={seeding || clearing}
            title="Register an unverified candidate so the verification gate can be demonstrated"
          >
            {!seeding && '+ Seed Candidate'}
          </Pill>
          {pending.length > 0 && (
            <Pill
              variant="danger"
              size="sm"
              loading={clearing}
              onClick={handleClearPending}
              disabled={clearing || seeding}
              title="Clear all pending unverified candidates"
            >
              {!clearing && 'Clear Pending'}
            </Pill>
          )}
          <Pill
            variant="ghost"
            size="sm"
            onClick={() => void pendingPoll.refresh()}
            disabled={!pendingPoll.loaded && pendingPoll.error === null}
          >
            Refresh
          </Pill>
        </div>

        {/* ---- Verifying supervisor ---- */}
        <div className="well flex flex-wrap items-end gap-x-4 gap-y-3 p-4">
          <div>
            <label className="label" htmlFor="verifier">
              Verifying supervisor ID
            </label>
            <input
              id="verifier"
              className="field w-52 font-mono text-xs"
              value={verifier}
              onChange={(e) => setVerifier(e.target.value)}
            />
          </div>
          <p className="max-w-xs text-[11px] leading-5 text-ink-muted">
            Recorded as{' '}
            <span className="font-mono font-semibold text-slate-300">verified_by</span> on the
            responder and stamped with the sign-off timestamp.
          </p>
        </div>

        {failure && <ErrorNote code="VERIFICATION_ALERT" message={failure} />}

        {/* ---- Candidate checklist table ---- */}
        {!pendingPoll.loaded && pendingPoll.error === null ? (
          <div className="flex items-center gap-2 py-6 text-xs text-ink-muted">
            <Spinner /> Loading candidate registry…
          </div>
        ) : pending.length === 0 ? (
          <EmptyState
            title="No candidates awaiting verification"
            titleUr="تصدیق کے لیے کوئی امیدوار نہیں"
            message="Every registered responder is currently verified. Seed a candidate above to exercise the verification gate."
            action={
              <Pill
                variant="cyan"
                size="sm"
                loading={seeding}
                onClick={handleSeedCandidate}
                disabled={seeding}
              >
                {!seeding && '+ Seed Candidate'}
              </Pill>
            }
          />
        ) : (
          <div className="overflow-x-auto rounded-2xl border border-slate-800">
            <table className="w-full min-w-[620px] border-collapse bg-surface text-left">
              <thead>
                <tr className="border-b border-slate-800 bg-sunken">
                  {['Responder', 'Village / BHU', 'Training', 'Kit inspection', 'Action'].map(
                    (h) => (
                      <th
                        key={h}
                        className="px-3 py-2.5 text-[10px] font-bold uppercase tracking-wider text-ink-muted"
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
                      className="border-b border-slate-800/70 transition-colors last:border-0 hover:bg-sunken/60"
                    >
                      <td className="px-3 py-3 align-top">
                        <p className="text-sm font-bold tracking-tight text-ink">{r.name}</p>
                        <p className="font-mono text-[10px] text-ink-dim">{r.responder_id}</p>
                        <span className="mt-1 inline-flex items-center gap-1.5 rounded-full border border-slate-700 bg-slate-800/60 px-2 py-0.5 text-[10px] font-semibold text-slate-300">
                          {avMeta.en}
                        </span>
                      </td>
                      <td className="px-3 py-3 align-top">
                        <p className="text-xs font-semibold text-slate-200">{villageDisplay(r.village)}</p>
                        <p className="font-mono text-[10px] text-ink-dim">{r.linked_bhu_id}</p>
                        {r.phone_number && (
                          <p className="font-mono text-[10px] text-ink-dim">{r.phone_number}</p>
                        )}
                      </td>
                      <td className="px-3 py-3 align-top">
                        <p className="text-xs font-semibold text-slate-200">
                          {r.training_completed ? 'Completed' : 'Not recorded'}
                        </p>
                        {r.training_org && (
                          <p className="text-[10px] leading-4 text-ink-dim">{r.training_org}</p>
                        )}
                      </td>
                      <td className="px-3 py-3 align-top">
                        {/* Kit inspection pills — emerald means "inspected and
                            present", which is exactly what emerald is reserved
                            for. Unchecked pills stay inert slate. */}
                        <div className="flex flex-wrap gap-1.5">
                          {EQUIPMENT_ITEMS.map((item) => {
                            const checked = selected.includes(item.value)
                            return (
                              <button
                                key={item.value}
                                type="button"
                                onClick={() => toggle(r.responder_id, item.value)}
                                aria-pressed={checked}
                                title={`${item.label_en} · ${item.label_ur}`}
                                className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-semibold transition-colors ${
                                  checked
                                    ? 'border-emerald-500/50 bg-emerald-500/15 text-emerald-200'
                                    : 'border-slate-700 bg-sunken text-ink-dim hover:border-slate-600 hover:text-ink-muted'
                                }`}
                              >
                                <span aria-hidden="true">{checked ? '✓' : '○'}</span>
                                {item.label_en}
                              </button>
                            )
                          })}
                        </div>
                        <p className="mt-1.5 text-[10px] tabular-nums text-ink-dim">
                          {selected.length}/{EQUIPMENT_ITEMS.length} inspected
                        </p>
                      </td>
                      <td className="px-3 py-3 align-top">
                        <div className="flex flex-col items-start gap-1.5">
                          <Pill
                            variant="mint"
                            size="sm"
                            loading={busyId === r.responder_id}
                            onClick={() => void verify(r.responder_id)}
                            disabled={busyId !== null}
                            className="whitespace-nowrap"
                          >
                            {busyId !== r.responder_id && 'Verify & Activate'}
                          </Pill>
                          <button
                            type="button"
                            onClick={() => void handleDeleteCandidate(r.responder_id)}
                            disabled={busyId !== null}
                            className="inline-flex items-center justify-center gap-1 rounded-full border border-rose-500/35 bg-rose-500/10 px-2.5 py-1 text-[11px] font-medium text-rose-200 transition-colors hover:bg-rose-500/20 disabled:cursor-not-allowed disabled:opacity-45"
                            title="Remove this candidate"
                          >
                            <span aria-hidden="true">✕</span>
                            <span>Remove</span>
                          </button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Card>
  )
}

// ===========================================================================
// Incident closure & fraud-prevention gate
// ===========================================================================

/** One read-only dispatch fact in the View 3 incident header. */
function FactCell({
  labelEn,
  labelUr,
  value,
  mono,
  tone,
}: {
  labelEn: string
  labelUr: string
  value: string
  mono?: string
  tone: 'mint' | 'cyan' | 'critical' | 'ash'
}) {
  const toneClass =
    tone === 'mint'
      ? 'border-emerald-500/35 bg-emerald-500/10 text-emerald-200'
      : tone === 'cyan'
        ? 'border-sky-500/35 bg-sky-500/10 text-sky-200'
        : tone === 'critical'
          ? 'border-rose-500/40 bg-rose-500/10 text-rose-200'
          : 'border-slate-700 bg-slate-800/60 text-slate-300'
  return (
    <div className={`min-w-0 rounded-xl border px-3 py-2 ${toneClass}`}>
      <dt className="text-[10px] font-semibold uppercase tracking-wide opacity-80">
        {labelEn}
        <span dir="rtl" className="ml-1 font-urdu normal-case tracking-normal opacity-70">
          {labelUr}
        </span>
      </dt>
      <dd className="mt-0.5 truncate text-[13px] font-bold" title={value}>
        {value}
      </dd>
      {mono && <dd className="truncate font-mono text-[10px] opacity-70">{mono}</dd>}
    </div>
  )
}

function ClosureGate({
  incidentId,
  incident,
  closed,
  onClose,
  responders,
  assignedResponderId,
  dispatch,
  status,
}: {
  incidentId: string | null
  incident: ReturnType<typeof useCockpit>['incident']
  closed: boolean
  onClose: (p: {
    outcome: OutcomeType
    confirmed_by: OutcomeConfirmer
    closed_by_id?: string
  }) => Promise<unknown | null>
  responders: Responder[]
  assignedResponderId: string | null
  /** From the report response — the only place the backend exposes BHU urgency. */
  dispatch: ReportResponse['dispatch'] | null
  /** Live lifecycle stage from GET /incident/{id}/timeline. */
  status: string | null
}) {
  const [outcome, setOutcome] = useState<OutcomeType>('taken_to_bhu')
  const [confirmer, setConfirmer] = useState<OutcomeConfirmer>('bhu_staff')
  const [actor, setActor] = useState(DEFAULT_ACTOR)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ counted: boolean } | null>(null)

  const countsTowardMetrics = confirmer === 'bhu_staff'

  const assignedResponder = assignedResponderId
    ? responders.find((r) => r.responder_id === assignedResponderId) ?? null
    : null

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
      <Card title="Formal Closure" titleUr="واقعہ بند کرنا" panel>
        <EmptyState
          title="No active incident to close"
          titleUr="بند کرنے کے لیے کوئی واقعہ نہیں"
          message="Report an emergency first. Closure writes the outcome, releases the responder back to available, and — only for BHU-verified sign-off — contributes to accountability metrics."
        />
      </Card>
    )
  }

  const isCritical = incident.severity_tier === 'critical'

  return (
    <Card
      title="Formal Closure & Audit"
      titleUr="واقعہ بند کریں اور آڈٹ ریکارڈ کریں"
      right={<TierBadge tier={incident.severity_tier} size="sm" />}
      className={isCritical && !closed ? 'border-rose-500/40' : ''}
      panel
    >
      <div className="flex flex-col gap-4">
        {/* ---- Active incident detail ---- */}
        <div
          className={`rounded-2xl border p-4 ${
            isCritical
              ? 'border-rose-500/40 bg-rose-500/10'
              : 'border-sky-500/35 bg-sky-500/10'
          }`}
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="font-mono text-xs font-semibold text-ink-muted">
                {incident.incident_id}
              </p>
              <p className="mt-0.5 text-sm font-bold tracking-tight text-ink">
                {villageDisplay(incident.gps_location.village_id)} · reported{' '}
                {formatClock(incident.timestamp_reported)}
              </p>
            </div>
            <div className="flex flex-wrap justify-end gap-2">
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

          <div className="mt-3 flex flex-wrap gap-1.5">
            {incident.injury_type_flags.length === 0 ? (
              <span className="tag border-slate-700 bg-slate-800/60 text-slate-300 normal-case tracking-normal">
                no injury flags
              </span>
            ) : (
              incident.injury_type_flags.map((f) => (
                <span
                  key={f}
                  className="tag border-slate-700 bg-slate-800/60 text-slate-300 normal-case tracking-normal"
                >
                  {humaniseFlag(f)}
                </span>
              ))
            )}
          </div>

          {incident.coverage_gap && (
            <div className="mt-3 rounded-xl border border-amber-500/40 bg-amber-950/30 p-3.5">
              <p className="font-urdu text-[15px] leading-7 font-bold text-amber-300" dir="rtl">
                علاقے میں کوئی رضاکار دستیاب نہیں — براہ راست بنیادی مرکز صحت (BHU) کو ایمرجنسی بھیج دی گئی ہے۔
              </p>
              <p className="mt-0.5 text-xs text-amber-200/80 font-sans">
                (No local responder available — incident escalated directly to BHU).
              </p>
            </div>
          )}

          {/* ---- Live dispatch facts (View 3 of the demo brief) ----
              Assigned responder, BHU notification + urgency, ambulance and the
              live lifecycle stage — every value read from the polled API.
              bhu_urgency only exists on the report response, which is why it
              comes from `dispatch` and not from `incident`. */}
          <dl className="mt-3 grid grid-cols-2 gap-2 lg:grid-cols-4">
            <FactCell
              labelEn="Assigned responder"
              labelUr="مددگار"
              value={assignedResponder?.name ?? 'unassigned'}
              mono={assignedResponderId ?? undefined}
              tone={assignedResponderId ? 'mint' : 'ash'}
            />
            <FactCell
              labelEn="BHU notified"
              labelUr="مرکزِ صحت کو اطلاع"
              value={
                incident.bhu_notified
                  ? dispatch?.bhu?.name ?? 'yes'
                  : 'no'
              }
              mono={
                incident.bhu_notified
                  ? `urgency=${dispatch?.bhu_urgency ?? 'unknown'}`
                  : undefined
              }
              tone={
                !incident.bhu_notified
                  ? 'ash'
                  : dispatch?.bhu_urgency === 'urgent'
                    ? 'critical'
                    : 'cyan'
              }
            />
            <FactCell
              labelEn="Ambulance"
              labelUr="ایمبولینس"
              value={incident.ambulance_requested ? 'requested' : 'not requested'}
              tone={incident.ambulance_requested ? 'critical' : 'ash'}
            />
            <FactCell
              labelEn="Status"
              labelUr="حالت"
              value={statusLabel(status).en}
              mono={status ?? undefined}
              tone={status === 'closed' ? 'mint' : 'cyan'}
            />
          </dl>

          {incident.outcome && (
            <p className="mt-3 text-xs font-semibold text-slate-200">
              Recorded outcome:{' '}
              <span className="font-bold text-emerald-300">
                {outcomeLabel(incident.outcome).en}
              </span>
              <span dir="rtl" className="ml-2 font-urdu text-ink-muted">
                {outcomeLabel(incident.outcome).ur}
              </span>
              <span className="ml-2 font-mono text-[10px] text-ink-dim">
                confirmed_by={incident.outcome_confirmed_by ?? '—'}
              </span>
            </p>
          )}
        </div>

        {/* ---- Closure controls ---- */}
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
            <p dir="rtl" className="mt-1 font-urdu text-[12px] leading-6 text-ink-muted">
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
              className={`mt-1 text-[10px] font-medium leading-4 ${
                countsTowardMetrics ? 'text-emerald-300' : 'text-rose-300'
              }`}
            >
              {CONFIRMER_OPTIONS.find((c) => c.value === confirmer)?.note}
            </p>
          </div>

          <div>
            <label className="label" htmlFor="actor">
              Verifying supervisor ID
            </label>
            <input
              id="actor"
              className="field font-mono text-xs"
              value={actor}
              disabled={closed}
              onChange={(e) => setActor(e.target.value)}
            />
            <p className="mt-1 text-[10px] leading-4 text-ink-dim">
              Sent as <span className="font-mono font-semibold text-ink-muted">closed_by_id</span>{' '}
              for the audit trail.
            </p>
          </div>
        </div>

        {/* ---- Sign-off ---- */}
        <div className="flex flex-wrap items-center gap-3 border-t border-slate-800 pt-4">
          <Pill
            variant={countsTowardMetrics ? 'mint' : 'danger'}
            size="lg"
            loading={busy}
            onClick={submit}
            disabled={busy || closed}
          >
            {!busy && (
              <>
                <span dir="rtl" className="font-urdu text-[15px] leading-7">
                  واقعہ بند کریں اور آڈٹ ریکارڈ کریں
                </span>
                <span className="opacity-80">(Close Incident & Record Audit)</span>
              </>
            )}
          </Pill>

          {closed && (
            <span className="inline-flex items-center gap-2 text-xs font-semibold text-emerald-300">
              <StatusDot tone="mint" /> Record is immutable — closure already signed off.
            </span>
          )}
        </div>

        {/* ---- Fraud-gate verdict, surfaced rather than hidden ---- */}
        {result && !closed && (
          <div
            className={`rounded-2xl border p-3.5 text-xs font-medium leading-5 ${
              result.counted
                ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200'
                : 'border-rose-500/40 bg-rose-500/10 text-rose-200'
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

export function AccountabilityScorecard({
  responders,
  defaultResponderId,
  refreshKey,
}: {
  responders: Responder[]
  defaultResponderId: string | null
  /**
   * Changes the moment the active incident closes (the closure timestamp), so
   * the scorecard refetches immediately instead of waiting for a manual
   * Reload — the demo needs the updated metrics on screen the instant the
   * BHU signs off.
   */
  refreshKey?: string | null
}) {
  const [selectedId, setSelectedId] = useState<string>(
    defaultResponderId ?? responders[0]?.responder_id ?? '',
  )
  const [perf, setPerf] = useState<PerformanceRecord | null>(null)
  const [txs, setTxs] = useState<PointTransaction[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (defaultResponderId) setSelectedId(defaultResponderId)
  }, [defaultResponderId])

  useEffect(() => {
    if (!selectedId) return
    getPointTransactions(selectedId)
      .then((res) => setTxs(res.transactions))
      .catch(() => setTxs([]))
  }, [selectedId, refreshKey])

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
  }, [selectedId, refreshKey])

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
      title="Live Performance Scorecard"
      titleUr="کارکردگی ریکارڈ"
      right={
        <div className="flex items-center gap-2">
          <select
            aria-label="Responder"
            className="field-select max-w-[190px] py-1.5 text-xs"
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
          <Pill variant="ghost" size="sm" loading={loading} onClick={reload} disabled={loading}>
            {!loading && 'Reload'}
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
                  ? 'border-emerald-500/45 bg-emerald-500/12 text-emerald-200'
                  : flagTone === 'critical'
                    ? 'border-rose-500/45 bg-rose-500/12 text-rose-200'
                    : 'border-sky-500/45 bg-sky-500/12 text-sky-200'
              }`}
            >
              <StatusDot tone={flagTone} />
              reliability flag: {perf.status_flag}
            </span>
            <span className="font-mono text-xs font-semibold text-ink-dim">
              {perf.responder_id}
            </span>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
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
            <div className="well p-4">
              <p className="label">Verified incidents responded to</p>
              <p className="metric-value">{perf.incidents_responded_to}</p>
              <p className="mt-1 text-[10px] leading-4 text-ink-dim">
                BHU-confirmed closures only — self-reported completions are excluded.
              </p>
            </div>

            <div className="well p-4">
              <p className="label">Incidents by outcome</p>
              {outcomeBreakdown.length === 0 ? (
                <p className="text-xs text-ink-muted">No verified outcomes yet.</p>
              ) : (
                <div className="mt-1 flex flex-wrap gap-2">
                  {outcomeBreakdown.map(([key, count]) => (
                    <span
                      key={key}
                      className="tag border-slate-700 bg-slate-800/60 text-slate-300 normal-case tracking-normal"
                    >
                      {outcomeLabel(key).en}
                      <span className="ml-1 font-bold tabular-nums text-ink">
                        {count as number}
                      </span>
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Verified points ledger (fraud-prevention accountability audit) */}
          <div className="well p-4">
            <div className="flex items-center justify-between mb-2">
              <div>
                <p className="label">Verified Points Ledger</p>
                <p className="text-[10px] text-ink-dim">
                  Points credited only upon BHU-confirmed closure
                </p>
              </div>
              <span className="text-sm font-extrabold text-emerald-400">
                {txs.reduce((sum, t) => sum + (t.points_awarded || 0), 0)} pts total
              </span>
            </div>
            {txs.length === 0 ? (
              <p className="text-xs text-ink-muted py-2">
                No verified point transactions for this responder yet.
              </p>
            ) : (
              <div className="space-y-1.5 max-h-40 overflow-y-auto">
                {txs.map((t) => (
                  <div
                    key={t.transaction_id}
                    className="flex items-center justify-between text-xs py-1 px-2 rounded-lg bg-surface border border-slate-800/80"
                  >
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-[11px] text-sky-400 font-bold">{t.incident_id}</span>
                      <span className="text-[10px] text-ink-muted">{outcomeLabel(t.outcome).en}</span>
                    </div>
                    <span className="font-mono font-bold text-emerald-300">+{t.points_awarded} pts</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </Card>
  )
}

function BhuCaseHistoryView({
  onSelectIncident,
  onBack,
  lang,
}: {
  onSelectIncident: (id: string) => void
  onBack: () => void
  lang: 'ur' | 'en'
}) {
  const { fetchIncidents } = useCockpit()
  const [cases, setCases] = useState<IncidentRecord[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetchIncidents()
      .then((items) => setCases(items))
      .finally(() => setLoading(false))
  }, [fetchIncidents])

  return (
    <Card title="BHU Clinical Case Registry" titleUr="مرکزِ صحت کا ریکارڈ" panel>
      <div className="flex items-center justify-between border-b border-slate-800 pb-3 mb-4">
        <p className="text-xs text-ink-muted">
          All emergency admissions, responder transfers, and verified closure outcomes
        </p>
        <Pill variant="ghost" size="sm" onClick={onBack}>
          {lang === 'ur' ? '← واپس جائیں' : '← Back'}
        </Pill>
      </div>

      {loading ? (
        <div className="py-10 text-center text-xs text-ink-muted">
          <Spinner /> Loading case records…
        </div>
      ) : cases.length === 0 ? (
        <EmptyState
          title="No clinical cases recorded"
          titleUr="کوئی کیس ریکارڈ نہیں"
          message="Emergency cases handled by the facility will be logged here."
        />
      ) : (
        <div className="flex flex-col gap-2.5">
          {cases.map((rec) => {
            const inc = rec.incident
            const isClosed = Boolean(inc.incident_closed_timestamp)
            return (
              <div
                key={inc.incident_id}
                onClick={() => onSelectIncident(inc.incident_id)}
                className="flex flex-wrap items-center justify-between gap-3 p-3.5 rounded-2xl border border-slate-800 bg-surface hover:border-slate-700 cursor-pointer transition-colors"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs font-bold text-sky-400">{inc.incident_id}</span>
                    <TierBadge tier={inc.severity_tier} size="sm" />
                    <span className="text-[11px] text-ink-dim">
                      {villageDisplay(inc.gps_location?.village_id)}
                    </span>
                    <span className="text-[11px] text-ink-dim">·</span>
                    <span className="text-[11px] text-ink-dim">
                      {inc.timestamp_reported ? new Date(inc.timestamp_reported).toLocaleTimeString() : ''}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-ink-muted truncate font-urdu" dir="rtl">
                    {inc.voice_transcript || inc.injury_type_flags.join(', ') || 'Clinical case'}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {inc.outcome && (
                    <span className="tag border-slate-700 bg-raised text-[10px]">
                      {outcomeLabel(inc.outcome).en}
                    </span>
                  )}
                  <span
                    className={`px-2.5 py-0.5 text-[10px] font-bold rounded-full ${
                      isClosed
                        ? 'bg-emerald-500/10 text-emerald-300 border border-emerald-500/30'
                        : 'bg-rose-500/10 text-rose-300 border border-rose-500/30'
                    }`}
                  >
                    {isClosed ? 'Closed' : 'Active'}
                  </span>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </Card>
  )
}
