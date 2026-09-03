/**
 * Cockpit state container.
 *
 * The one architectural rule that matters here: `role` and `incidentId` are
 * independent pieces of state. Switching the top stepper changes ONLY `role`,
 * so all three views keep inspecting the exact same active incident and the
 * end-to-end loop reads as one continuous story.
 *
 * `incidentId` is cleared only by an explicit reset action, never as a
 * side-effect of navigation.
 */

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react'

import {
  ApiRequestError,
  BACKEND_UNREACHABLE,
  closeIncident as apiCloseIncident,
  getHealth,
  getIncident,
  getIncidentTimeline,
  helpBotStep as apiHelpBotStep,
  listResponders,
  reportEmergency,
  responderArrived,
  responderRespond,
  verifyResponder as apiVerifyResponder,
  type ReportInput,
} from '../lib/api'
import { usePoll } from '../hooks/usePoll'
import type {
  CloseResponse,
  HealthResponse,
  HelpBotStepResponse,
  Incident,
  IncidentRecord,
  OutcomeConfirmer,
  OutcomeType,
  ReportResponse,
  Responder,
  TimelineResponse,
} from '../lib/types'

export type Role = 'reporter' | 'responder' | 'bhu'

export const ROLES: {
  id: Role
  step: number
  label_en: string
  label_ur: string
}[] = [
  { id: 'reporter', step: 1, label_en: 'Reporter View', label_ur: 'رپورٹر' },
  { id: 'responder', step: 2, label_en: 'Field Responder', label_ur: 'مددگار' },
  { id: 'bhu', step: 3, label_en: 'BHU Clinic & Audit', label_ur: 'مرکزِ صحت' },
]

const POLL_MS = Number(import.meta.env.VITE_POLL_MS ?? 2500)
/** Full lifecycle record is heavier than the timeline feed — poll it slower. */
const RECORD_POLL_MS = Math.max(POLL_MS * 2, 4000)

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------

export type ToastTone = 'info' | 'success' | 'error' | 'critical'

export interface Toast {
  id: number
  tone: ToastTone
  title: string
  message?: string
}

// ---------------------------------------------------------------------------
// Context shape
// ---------------------------------------------------------------------------

export interface CockpitValue {
  // Navigation
  role: Role
  setRole: (role: Role) => void

  // The single shared active incident
  incidentId: string | null
  incident: Incident | null
  record: IncidentRecord | null
  timeline: TimelineResponse | null
  lastReport: ReportResponse | null

  // Registry + liveness
  responders: Responder[]
  health: HealthResponse | null
  backendOnline: boolean
  backendError: ApiRequestError | null
  polling: boolean

  // Actions
  submitReport: (input: ReportInput) => Promise<ReportResponse>
  respond: (
    action: 'accept' | 'decline',
    reason?: string,
  ) => Promise<unknown | null>
  markArrived: () => Promise<unknown | null>
  sendHelpBotTurn: (transcript: string) => Promise<HelpBotStepResponse | null>
  closeActiveIncident: (params: {
    outcome: OutcomeType
    confirmed_by: OutcomeConfirmer
    closed_by_id?: string
  }) => Promise<CloseResponse | null>
  verifyCandidate: (params: {
    responderId: string
    verified_by: string
    equipment_checklist: string[]
  }) => Promise<Responder | null>
  adoptIncident: (incidentId: string) => void
  resetDemo: () => void
  refreshAll: () => Promise<void>

  // Help-bot transcript accumulated client-side for the conversation panel
  botTurns: BotTurn[]

  // Toasts
  toasts: Toast[]
  pushToast: (t: Omit<Toast, 'id'>) => void
  dismissToast: (id: number) => void
}

export interface BotTurn {
  speaker: 'responder' | 'bot'
  text: string
  at: number
  intent?: string
  audioUrl?: string | null
  escalated?: boolean
}

const CockpitContext = createContext<CockpitValue | null>(null)

export function useCockpit(): CockpitValue {
  const ctx = useContext(CockpitContext)
  if (!ctx) throw new Error('useCockpit must be used inside <CockpitProvider>')
  return ctx
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

let toastSeq = 0

export function CockpitProvider({ children }: { children: ReactNode }) {
  const [role, setRoleState] = useState<Role>('reporter')
  const [incidentId, setIncidentId] = useState<string | null>(null)
  const [lastReport, setLastReport] = useState<ReportResponse | null>(null)
  const [botTurns, setBotTurns] = useState<BotTurn[]>([])
  const [toasts, setToasts] = useState<Toast[]>([])

  const pushToast = useCallback((t: Omit<Toast, 'id'>) => {
    toastSeq += 1
    const id = toastSeq
    setToasts((prev) => [...prev.slice(-3), { ...t, id }])
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((x) => x.id !== id))
    }, 6500)
  }, [])

  const dismissToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((x) => x.id !== id))
  }, [])

  /** Normalise any failure into one toast so views stay free of try/catch. */
  const reportFailure = useCallback(
    (context: string, cause: unknown): ApiRequestError => {
      const err =
        cause instanceof ApiRequestError
          ? cause
          : new ApiRequestError(0, 'UNKNOWN', String(cause))
      pushToast({
        tone: err.code === BACKEND_UNREACHABLE ? 'error' : 'error',
        title: context,
        message: `${err.code} — ${err.message}`,
      })
      return err
    },
    [pushToast],
  )

  // -------------------------------------------------------------------------
  // Live polling
  // -------------------------------------------------------------------------

  const healthPoll = usePoll<HealthResponse>(() => getHealth(), [], {
    intervalMs: 10_000,
  })

  const respondersPoll = usePoll<Responder[]>(
    async () => (await listResponders()).responders,
    [],
    { intervalMs: 10_000 },
  )

  const timelinePoll = usePoll<TimelineResponse>(
    () => getIncidentTimeline(incidentId as string),
    [incidentId],
    { intervalMs: POLL_MS, enabled: Boolean(incidentId) },
  )

  const recordPoll = usePoll<IncidentRecord>(
    () => getIncident(incidentId as string),
    [incidentId],
    { intervalMs: RECORD_POLL_MS, enabled: Boolean(incidentId) },
  )

  const backendOnline =
    healthPoll.data?.status === 'ok' && healthPoll.error === null
  const backendError =
    healthPoll.error ?? (backendOnline ? null : timelinePoll.error)

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  const setRole = useCallback(
    (next: Role) => {
      // Role switch ONLY. incidentId is intentionally untouched.
      setRoleState(next)
    },
    [],
  )

  const submitReport = useCallback(
    async (input: ReportInput): Promise<ReportResponse> => {
      const res = await reportEmergency(input)
      // A brand-new report supersedes whatever was on screen.
      setLastReport(res)
      setIncidentId(res.incident.incident_id)
      setBotTurns([])
      pushToast({
        tone: res.incident.severity_tier === 'critical' ? 'critical' : 'success',
        title: 'Emergency registered',
        message: `${res.incident.incident_id} · triage ${res.incident.severity_tier} · dispatch ${res.dispatch.status}`,
      })
      // The two incident polls re-fire on their own: changing `incidentId`
      // alters their subject key, which triggers an immediate fetch. Calling
      // refresh() here would instead run their PREVIOUS closure — still bound
      // to a null id — and 404 on /incident/null/timeline.
      void respondersPoll.refresh()
      return res
    },
    [pushToast, respondersPoll],
  )

  const respond = useCallback(
    async (action: 'accept' | 'decline', reason?: string) => {
      const responderId = incidentResponderId(recordPoll.data, lastReport)
      if (!incidentId || !responderId) {
        pushToast({
          tone: 'error',
          title: 'No responder assigned',
          message: 'This incident has no assigned responder to acknowledge.',
        })
        return null
      }
      try {
        const res = await responderRespond({
          incident_id: incidentId,
          responder_id: responderId,
          action,
          reason,
        })
        pushToast({
          tone: action === 'accept' ? 'success' : 'info',
          title: action === 'accept' ? 'Alert accepted' : 'Alert declined',
          message:
            action === 'accept'
              ? `${responderId} is now en route.`
              : `Fallback walker engaged. Now assigned: ${res.responder_assigned_id ?? 'none'}.`,
        })
        await Promise.all([
          timelinePoll.refresh(),
          recordPoll.refresh(),
          respondersPoll.refresh(),
        ])
        return res
      } catch (cause) {
        reportFailure('Responder action failed', cause)
        return null
      }
    },
    [
      incidentId,
      lastReport,
      pushToast,
      recordPoll,
      reportFailure,
      respondersPoll,
      timelinePoll,
    ],
  )

  const markArrived = useCallback(async () => {
    if (!incidentId) return null
    const responderId = incidentResponderId(recordPoll.data, lastReport)
    if (!responderId) {
      pushToast({
        tone: 'error',
        title: 'Cannot check in',
        message: 'No responder is assigned to this incident yet.',
      })
      return null
    }
    try {
      const res = await responderArrived({
        incident_id: incidentId,
        responder_id: responderId,
      })
      pushToast({
        tone: 'success',
        title: 'Arrival recorded',
        message: res.arrival_update?.message_urdu ?? 'Responder is on scene.',
      })
      await Promise.all([timelinePoll.refresh(), recordPoll.refresh()])
      return res
    } catch (cause) {
      reportFailure('Arrival check-in failed', cause)
      return null
    }
  }, [
    incidentId,
    lastReport,
    pushToast,
    recordPoll,
    reportFailure,
    timelinePoll,
  ])

  const sendHelpBotTurn = useCallback(
    async (transcript: string): Promise<HelpBotStepResponse | null> => {
      if (!incidentId) {
        pushToast({
          tone: 'error',
          title: 'No active incident',
          message: 'Report an emergency before starting the help bot.',
        })
        return null
      }
      setBotTurns((prev) => [
        ...prev,
        { speaker: 'responder', text: transcript, at: Date.now() },
      ])
      try {
        const res = await apiHelpBotStep({
          incident_id: incidentId,
          responder_transcript: transcript,
        })
        setBotTurns((prev) => [
          ...prev,
          {
            speaker: 'bot',
            text: res.spoken_text_urdu,
            at: Date.now(),
            intent: res.intent,
            audioUrl: res.audio_url,
            escalated: res.escalated,
          },
        ])
        if (res.escalated) {
          pushToast({
            tone: 'critical',
            title: 'Mid-incident escalation triggered',
            message: `Signal: ${res.escalation_signal ?? 'condition_worsening'} — Module 8 fallback engaged, ambulance requested.`,
          })
        }
        await Promise.all([timelinePoll.refresh(), recordPoll.refresh()])
        return res
      } catch (cause) {
        setBotTurns((prev) => [
          ...prev,
          {
            speaker: 'bot',
            text: 'ہدایت حاصل نہیں ہو سکی۔ براہِ کرم دوبارہ کوشش کریں۔',
            at: Date.now(),
            intent: 'error',
          },
        ])
        reportFailure('Help-bot turn failed', cause)
        return null
      }
    },
    [incidentId, pushToast, recordPoll, reportFailure, timelinePoll],
  )

  const closeActiveIncident = useCallback(
    async (params: {
      outcome: OutcomeType
      confirmed_by: OutcomeConfirmer
      closed_by_id?: string
    }): Promise<CloseResponse | null> => {
      if (!incidentId) return null
      try {
        const res = await apiCloseIncident(incidentId, params)
        pushToast({
          tone: 'success',
          title: 'Incident closed & audited',
          message:
            params.confirmed_by === 'bhu_staff'
              ? 'BHU-verified closure — Module 5 metrics recorded.'
              : 'Self-reported closure — deliberately NOT counted toward metrics.',
        })
        await Promise.all([
          timelinePoll.refresh(),
          recordPoll.refresh(),
          respondersPoll.refresh(),
        ])
        return res
      } catch (cause) {
        reportFailure('Closure failed', cause)
        return null
      }
    },
    [
      incidentId,
      pushToast,
      recordPoll,
      reportFailure,
      respondersPoll,
      timelinePoll,
    ],
  )

  const verifyCandidate = useCallback(
    async (params: {
      responderId: string
      verified_by: string
      equipment_checklist: string[]
    }): Promise<Responder | null> => {
      try {
        const res = await apiVerifyResponder(params.responderId, {
          verified_by: params.verified_by,
          equipment_checklist: params.equipment_checklist,
        })
        pushToast({
          tone: 'success',
          title: 'Responder verified & activated',
          message: `${params.responderId} is now dispatch-eligible.`,
        })
        await respondersPoll.refresh()
        return res
      } catch (cause) {
        reportFailure('Verification failed', cause)
        return null
      }
    },
    [pushToast, reportFailure, respondersPoll],
  )

  const adoptIncident = useCallback(
    (id: string) => {
      const trimmed = id.trim()
      if (!trimmed) return
      setIncidentId(trimmed)
      setBotTurns([])
      setLastReport(null)
      pushToast({
        tone: 'info',
        title: 'Incident adopted',
        message: `Now tracking ${trimmed} across all three views.`,
      })
    },
    [pushToast],
  )

  const resetDemo = useCallback(() => {
    setIncidentId(null)
    setLastReport(null)
    setBotTurns([])
    pushToast({
      tone: 'info',
      title: 'Cockpit reset',
      message: 'Active incident cleared. Registry state on the backend is unchanged.',
    })
  }, [pushToast])

  const refreshAll = useCallback(async () => {
    await Promise.all([
      healthPoll.refresh(),
      respondersPoll.refresh(),
      timelinePoll.refresh(),
      recordPoll.refresh(),
    ])
  }, [healthPoll, recordPoll, respondersPoll, timelinePoll])

  // -------------------------------------------------------------------------
  // Derived
  // -------------------------------------------------------------------------

  const record = recordPoll.data
  const incident: Incident | null = useMemo(() => {
    if (record?.incident) return record.incident
    if (lastReport?.incident && lastReport.incident.incident_id === incidentId) {
      return lastReport.incident
    }
    return null
  }, [record, lastReport, incidentId])

  const value = useMemo<CockpitValue>(
    () => ({
      role,
      setRole,
      incidentId,
      incident,
      record,
      timeline: timelinePoll.data,
      lastReport,
      responders: respondersPoll.data ?? [],
      health: healthPoll.data,
      backendOnline,
      backendError,
      polling: timelinePoll.fetching || recordPoll.fetching,
      submitReport,
      respond,
      markArrived,
      sendHelpBotTurn,
      closeActiveIncident,
      verifyCandidate,
      adoptIncident,
      resetDemo,
      refreshAll,
      botTurns,
      toasts,
      pushToast,
      dismissToast,
    }),
    [
      role,
      setRole,
      incidentId,
      incident,
      record,
      timelinePoll.data,
      timelinePoll.fetching,
      recordPoll.fetching,
      lastReport,
      respondersPoll.data,
      healthPoll.data,
      backendOnline,
      backendError,
      submitReport,
      respond,
      markArrived,
      sendHelpBotTurn,
      closeActiveIncident,
      verifyCandidate,
      adoptIncident,
      resetDemo,
      refreshAll,
      botTurns,
      toasts,
      pushToast,
      dismissToast,
    ],
  )

  return (
    <CockpitContext.Provider value={value}>{children}</CockpitContext.Provider>
  )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * The assigned responder for the active incident, read from whichever source
 * is freshest: the polled lifecycle record, or the report response captured at
 * registration time (used before the first record poll lands).
 */
export function incidentResponderId(
  record: IncidentRecord | null,
  lastReport: ReportResponse | null,
): string | null {
  return (
    record?.incident?.responder_assigned_id ??
    lastReport?.dispatch?.responder?.responder_id ??
    lastReport?.incident?.responder_assigned_id ??
    null
  )
}
