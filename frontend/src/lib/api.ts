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
  CloseResponse,
  HealthResponse,
  HelpBotStepResponse,
  IncidentRecord,
  OutcomeConfirmer,
  OutcomeType,
  PendingRespondersResponse,
  PerformanceRecord,
  ReportResponse,
  RespondResponse,
  Responder,
  RespondersListResponse,
  TimelineResponse,
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

function json<T>(url: string, method: 'GET' | 'POST', body?: unknown): Promise<T> {
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
// Module 1 + 3 — report, retrieve, timeline
// ---------------------------------------------------------------------------

export interface ReportInput {
  latitude: number
  longitude: number
  village_id: string
  reporter_id?: string
  photo_ref: string
  voice_ref: string
  voice_transcript?: string
}

/**
 * Register + triage + dispatch one emergency.
 * Form-encoded on purpose: the backend declares six `Form(...)` parameters.
 */
export function reportEmergency(input: ReportInput): Promise<ReportResponse> {
  const form = new URLSearchParams()
  form.set('latitude', String(input.latitude))
  form.set('longitude', String(input.longitude))
  form.set('village_id', input.village_id)
  form.set('reporter_id', input.reporter_id ?? 'REP-USER-001')
  form.set('photo_ref', input.photo_ref)
  form.set('voice_ref', input.voice_ref)
  if (input.voice_transcript) {
    form.set('voice_transcript', input.voice_transcript)
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
