/**
 * Typed HTTP client for the LifeLine Ride FastAPI backend.
 *
 * BRIEF vs REALITY — the design directive listed several contracts that do not
 * match the implemented backend. This module is the single place where those
 * gaps are reconciled, so views never carry workarounds:
 *
 *  1. POST /emergency/report is FORM-ENCODED (six `Form(...)` fields), not
 *     JSON. Sending JSON yields 400 VALIDATION_ERROR.
 *  2. POST /responder/respond takes `action: "accept" | "decline"`, not
 *     `status: "accepted"`.
 *  3. Help-bot audio is served from the static mount at
 *     `/media/helpbot/tts_cache/<sha1>.wav`. There is no
 *     `/api/v1/media/tts?file=` endpoint — the step reply already carries the
 *     relative `audio_url`, which we prefix with the API origin.
 *  4. Closure outcome literals are "self-resolved" (hyphen), "taken_to_bhu",
 *     "referred_to_hospital", "unresolved".
 *  5. `confirmed_by` accepts only "responder" | "bhu_staff". The actor id from
 *     the brief (`bhu_staff_01`) belongs in the separate `closed_by_id` field.
 *  6. Acceptance rate lives at `dispatch_metrics.acceptance_rate_pct`.
 *  7. `/health` is mounted at the app root, not under `/api/v1`.
 *  8. The backend's real port is 5050 (repo-root `.env` PORT), not the 5000
 *     the design brief assumed. Rather than hardcode either, requests are
 *     SAME-ORIGIN by default and vite.config.ts proxies `/api`, `/health` and
 *     `/media` to whatever port `.env` declares — so there is no CORS
 *     preflight to fail mid-demo and no port to keep in sync by hand. Set
 *     VITE_API_URL to an absolute origin to go back to direct cross-origin
 *     calls (backend/main.py whitelists :3000, :5173 and :4173).
 */

import type {
  ApiErrorBody,
  ArrivedResponse,
  AvailabilityStatus,
  CloseResponse,
  HealthResponse,
  HelpBotStepResponse,
  IncidentRecord,
  IncidentsListResponse,
  MediaUploadResponse,
  OutcomeConfirmer,
  OutcomeType,
  PendingRespondersResponse,
  PerformanceRecord,
  PointTransactionsResponse,
  ReportResponse,
  RespondResponse,
  Responder,
  RespondersListResponse,
  SeverityTier,
  TimelineResponse,
  TriageAnalysisResponse,
  UpdateResponderStatusResponse,
} from './types'

/**
 * Empty string = same-origin, i.e. every request is relative and served
 * through the Vite proxy. An absolute VITE_API_URL switches to direct mode.
 */
export const API_BASE: string = (
  import.meta.env.VITE_API_URL ?? ''
).replace(/\/+$/, '')

/** What the status bar and error toasts should call the backend. */
export const API_LABEL: string =
  API_BASE || `${window.location.origin} → proxy`

const API_V1 = `${API_BASE}/api/v1`

// ---------------------------------------------------------------------------
// Error contract
// ---------------------------------------------------------------------------

/**
 * Every backend failure path returns JSON {"code": <string>, "message": ...}
 * (install_error_handlers). Transport-level failures are normalised into the
 * same shape so callers have exactly one thing to handle.
 */
export class ApiRequestError extends Error {
  readonly code: string
  readonly status: number

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'ApiRequestError'
    this.status = status
    this.code = code
  }
}

export const BACKEND_UNREACHABLE = 'BACKEND_UNREACHABLE'

async function parseError(res: Response): Promise<ApiRequestError> {
  let body: Partial<ApiErrorBody> = {}
  try {
    body = (await res.json()) as Partial<ApiErrorBody>
  } catch {
    // Non-JSON body (proxy error page, empty 500) — fall through to defaults.
  }
  return new ApiRequestError(
    res.status,
    body.code ?? `HTTP_${res.status}`,
    body.message ?? res.statusText ?? 'Request failed',
  )
}

function transportError(cause: unknown): ApiRequestError {
  const detail = cause instanceof Error ? cause.message : String(cause)
  return new ApiRequestError(
    0,
    BACKEND_UNREACHABLE,
    `Cannot reach the LifeLine backend at ${API_LABEL}. ${detail}`,
  )
}

// ---------------------------------------------------------------------------
// Transport primitives
// ---------------------------------------------------------------------------

const REQUEST_TIMEOUT_MS = 90_000 // triage + intent detection call Gemini

async function request<T>(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<T> {
  const { timeoutMs = REQUEST_TIMEOUT_MS, ...rest } = init
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  let res: Response
  try {
    res = await fetch(url, { ...rest, signal: controller.signal })
  } catch (cause) {
    // Abort surfaces as a transport failure too; distinguish it so the UI can
    // say "slow" rather than "down".
    if (cause instanceof DOMException && cause.name === 'AbortError') {
      throw new ApiRequestError(
        0,
        'REQUEST_TIMEOUT',
        `Request to ${url} timed out after ${Math.round(timeoutMs / 1000)}s.`,
      )
    }
    throw transportError(cause)
  } finally {
    clearTimeout(timer)
  }

  if (!res.ok) throw await parseError(res)
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

function json<T>(
  url: string,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  body?: unknown,
): Promise<T> {
  return request<T>(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

// ---------------------------------------------------------------------------
// Media helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a backend-relative media path (e.g. the help-bot `audio_url`) into
 * an absolute URL the <audio> element can stream. Already-absolute and data:
 * URLs pass through untouched.
 */
export function resolveMediaUrl(ref: string | null | undefined): string | null {
  if (!ref) return null
  if (/^(https?:|data:|blob:)/i.test(ref)) return ref
  return `${API_BASE}${ref.startsWith('/') ? '' : '/'}${ref}`
}

// ---------------------------------------------------------------------------
// Module 1 + 3 — report, retrieve, timeline, multimodal media & triage
// ---------------------------------------------------------------------------

export async function uploadEmergencyMedia(
  file: File | Blob,
  filename?: string,
  mediaType?: 'image' | 'audio',
): Promise<MediaUploadResponse> {
  const formData = new FormData()
  const actualName =
    filename ||
    (file instanceof File
      ? file.name
      : mediaType === 'audio'
        ? 'voice_recording.wav'
        : 'incident_photo.png')
  formData.append('file', file, actualName)
  if (mediaType) {
    formData.append('media_type', mediaType)
  }

  const res = await fetch(`${API_V1}/emergency/upload`, {
    method: 'POST',
    body: formData,
  })
  if (!res.ok) throw await parseError(res)
  return (await res.json()) as MediaUploadResponse
}

export interface TriageAnalyzeParams {
  transcript?: string
  voice_ref?: string
  photo_ref?: string
  audio_file?: File | Blob
  photo_file?: File | Blob
}

export async function analyzeTriage(
  params: TriageAnalyzeParams,
): Promise<TriageAnalysisResponse> {
  const formData = new FormData()
  if (params.transcript) formData.append('transcript', params.transcript)
  if (params.voice_ref) formData.append('voice_ref', params.voice_ref)
  if (params.photo_ref) formData.append('photo_ref', params.photo_ref)
  if (params.audio_file) {
    const audioName =
      params.audio_file instanceof File
        ? params.audio_file.name
        : 'voice_note.wav'
    formData.append('audio_file', params.audio_file, audioName)
  }
  if (params.photo_file) {
    const photoName =
      params.photo_file instanceof File ? params.photo_file.name : 'incident.png'
    formData.append('photo_file', params.photo_file, photoName)
  }

  const res = await fetch(`${API_V1}/emergency/triage/analyze`, {
    method: 'POST',
    body: formData,
  })
  if (!res.ok) throw await parseError(res)
  return (await res.json()) as TriageAnalysisResponse
}

export interface ReportInput {
  latitude: number
  longitude: number
  village_id: string
  reporter_id?: string
  photo_ref?: string
  voice_ref?: string
  voice_transcript?: string
  text_description?: string
  detected_emergency?: string
  anticipated_condition?: string
  severity_tier?: SeverityTier
  first_aid_guidance?: string[]
  voice_file?: File | Blob
  photo_file?: File | Blob
}

/**
 * Register + triage + dispatch one emergency.
 * Supports multipart/form-data for direct file uploads or form-encoded for references.
 */
export async function reportEmergency(input: ReportInput): Promise<ReportResponse> {
  const hasFile = Boolean(input.voice_file || input.photo_file)

  if (hasFile) {
    const formData = new FormData()
    formData.append('latitude', String(input.latitude))
    formData.append('longitude', String(input.longitude))
    formData.append('village_id', input.village_id)
    formData.append('reporter_id', input.reporter_id ?? 'REP-USER-001')
    if (input.photo_ref) formData.append('photo_ref', input.photo_ref)
    if (input.voice_ref) formData.append('voice_ref', input.voice_ref)
    if (input.voice_transcript) formData.append('voice_transcript', input.voice_transcript)
    if (input.text_description) formData.append('text_description', input.text_description)
    if (input.detected_emergency) formData.append('detected_emergency', input.detected_emergency)
    if (input.anticipated_condition) formData.append('anticipated_condition', input.anticipated_condition)
    if (input.severity_tier) formData.append('severity_tier', input.severity_tier)
    if (input.first_aid_guidance && input.first_aid_guidance.length > 0) {
      formData.append('first_aid_guidance', JSON.stringify(input.first_aid_guidance))
    }
    if (input.voice_file) {
      const fileName = input.voice_file instanceof File ? input.voice_file.name : 'voice_note.webm'
      formData.append('voice_file', input.voice_file, fileName)
    }
    if (input.photo_file) {
      const fileName = input.photo_file instanceof File ? input.photo_file.name : 'incident_photo.png'
      formData.append('photo_file', input.photo_file, fileName)
    }

    const res = await fetch(`${API_V1}/emergency/report`, {
      method: 'POST',
      body: formData,
    })
    if (!res.ok) throw await parseError(res)
    return (await res.json()) as ReportResponse
  }

  const form = new URLSearchParams()
  form.set('latitude', String(input.latitude))
  form.set('longitude', String(input.longitude))
  form.set('village_id', input.village_id)
  form.set('reporter_id', input.reporter_id ?? 'REP-USER-001')
  if (input.photo_ref) form.set('photo_ref', input.photo_ref)
  if (input.voice_ref) form.set('voice_ref', input.voice_ref)
  if (input.voice_transcript) form.set('voice_transcript', input.voice_transcript)
  if (input.text_description) form.set('text_description', input.text_description)
  if (input.detected_emergency) form.set('detected_emergency', input.detected_emergency)
  if (input.anticipated_condition) form.set('anticipated_condition', input.anticipated_condition)
  if (input.severity_tier) form.set('severity_tier', input.severity_tier)
  if (input.first_aid_guidance && input.first_aid_guidance.length > 0) {
    form.set('first_aid_guidance', JSON.stringify(input.first_aid_guidance))
  }

  return request<ReportResponse>(`${API_V1}/emergency/report`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  })
}

export function getIncident(incidentId: string): Promise<IncidentRecord> {
  return json<IncidentRecord>(
    `${API_V1}/emergency/incident/${encodeURIComponent(incidentId)}`,
    'GET',
  )
}

/** Polled every 2.5s by the cockpit to drive the Urdu status feed. */
export function getIncidentTimeline(incidentId: string): Promise<TimelineResponse> {
  return request<TimelineResponse>(
    `${API_V1}/emergency/incident/${encodeURIComponent(incidentId)}/timeline`,
    // Tight timeout: a hung poll must never stack up behind the next tick.
    { method: 'GET', timeoutMs: 8_000 },
  )
}

// ---------------------------------------------------------------------------
// Module 3 + 9 — responder acknowledgement and arrival
// ---------------------------------------------------------------------------

export function responderRespond(params: {
  incident_id: string
  responder_id: string
  action: 'accept' | 'decline'
  reason?: string
}): Promise<RespondResponse> {
  return json<RespondResponse>(`${API_V1}/responder/respond`, 'POST', params)
}

export function responderArrived(params: {
  incident_id: string
  responder_id: string
}): Promise<ArrivedResponse> {
  return json<ArrivedResponse>(`${API_V1}/responder/arrived`, 'POST', params)
}

// ---------------------------------------------------------------------------
// Module 2 — help-bot guidance session
// ---------------------------------------------------------------------------

/**
 * Advance the stateful per-incident guidance session one turn.
 * Sessions live in-process on the backend keyed by incident_id, so step index
 * and turn history persist across calls with no client-side session token.
 */
export function helpBotStep(params: {
  incident_id: string
  responder_transcript: string
}): Promise<HelpBotStepResponse> {
  return json<HelpBotStepResponse>(`${API_V1}/helpbot/step`, 'POST', params)
}

// ---------------------------------------------------------------------------
// Module 6 + 5 — closure and accountability
// ---------------------------------------------------------------------------

export function closeIncident(
  incidentId: string,
  params: {
    outcome: OutcomeType
    confirmed_by: OutcomeConfirmer
    closed_by_id?: string
  },
): Promise<CloseResponse> {
  return json<CloseResponse>(
    `${API_V1}/emergency/incident/${encodeURIComponent(incidentId)}/close`,
    'POST',
    params,
  )
}

export function getResponderPerformance(
  responderId: string,
): Promise<PerformanceRecord> {
  return request<PerformanceRecord>(
    `${API_V1}/accountability/responder/${encodeURIComponent(responderId)}/performance`,
    { method: 'GET', timeoutMs: 15_000 },
  )
}

// ---------------------------------------------------------------------------
// Module 7 — registry and verification
// ---------------------------------------------------------------------------

export function listResponders(params?: {
  village_id?: string
  verified?: boolean
}): Promise<RespondersListResponse> {
  const qs = new URLSearchParams()
  if (params?.village_id) qs.set('village_id', params.village_id)
  if (params?.verified !== undefined) qs.set('verified', String(params.verified))
  const suffix = qs.toString() ? `?${qs.toString()}` : ''
  return request<RespondersListResponse>(`${API_V1}/responders${suffix}`, {
    method: 'GET',
    timeoutMs: 15_000,
  })
}

export function listPendingResponders(
  villageId?: string,
): Promise<PendingRespondersResponse> {
  const suffix = villageId ? `?village_id=${encodeURIComponent(villageId)}` : ''
  return request<PendingRespondersResponse>(
    `${API_V1}/responders/pending${suffix}`,
    { method: 'GET', timeoutMs: 15_000 },
  )
}

export function verifyResponder(
  responderId: string,
  params: { verified_by: string; equipment_checklist: string[] },
): Promise<Responder> {
  return json<Responder>(
    `${API_V1}/responders/${encodeURIComponent(responderId)}/verify`,
    'POST',
    params,
  )
}

export function registerCandidateResponder(params: {
  name: string
  village: string
  phone_number: string
  linked_bhu_id: string
  responder_id?: string
  training_completed?: boolean
  training_org?: string
  equipment_checklist?: string[]
}): Promise<Responder> {
  return json<Responder>(`${API_V1}/responders/register`, 'POST', params)
}

export function clearPendingResponders(): Promise<{ status: string; cleared_count: number }> {
  return request<{ status: string; cleared_count: number }>(
    `${API_V1}/responders/pending/clear`,
    { method: 'DELETE' },
  )
}

export function deleteResponder(responderId: string): Promise<{ status: string; responder_id: string }> {
  return request<{ status: string; responder_id: string }>(
    `${API_V1}/responders/${encodeURIComponent(responderId)}`,
    { method: 'DELETE' },
  )
}

export function listIncidents(params?: {
  reporter_id?: string
  responder_id?: string
  status?: string
  limit?: number
}): Promise<IncidentsListResponse> {
  const qs = new URLSearchParams()
  if (params?.reporter_id) qs.set('reporter_id', params.reporter_id)
  if (params?.responder_id) qs.set('responder_id', params.responder_id)
  if (params?.status) qs.set('status', params.status)
  if (params?.limit) qs.set('limit', String(params.limit))
  const suffix = qs.toString() ? `?${qs.toString()}` : ''
  return request<IncidentsListResponse>(`${API_V1}/emergency/incidents${suffix}`, {
    method: 'GET',
    timeoutMs: 15_000,
  })
}

export function updateResponderStatus(
  responderId: string,
  status: AvailabilityStatus,
): Promise<UpdateResponderStatusResponse> {
  return json<UpdateResponderStatusResponse>(
    `${API_V1}/responders/${encodeURIComponent(responderId)}/status`,
    'PUT',
    { status },
  )
}

export function getPointTransactions(
  responderId: string,
): Promise<PointTransactionsResponse> {
  return request<PointTransactionsResponse>(
    `${API_V1}/accountability/responder/${encodeURIComponent(responderId)}/transactions`,
    {
      method: 'GET',
      timeoutMs: 15_000,
    },
  )
}

// ---------------------------------------------------------------------------
// Liveness
// ---------------------------------------------------------------------------

/** Root-mounted (NOT /api/v1) — short timeout so the header dot stays honest. */
export function getHealth(): Promise<HealthResponse> {
  return request<HealthResponse>(`${API_BASE}/health`, {
    method: 'GET',
    timeoutMs: 6_000,
  })
}
