/**
 * Domain types mirroring the backend Pydantic contracts.
 *
 * Every shape here is transcribed from the real FastAPI responses, not from
 * the design brief:
 *   - Incident / Responder / BHU / GPSLocation  <- backend/slice_runner.py
 *   - DispatchDecision                          <- services/dispatch_service.py
 *   - TimelineResponse / ReporterUpdate         <- routes/emergency.py + services/incident_lifecycle_service.py
 *   - PerformanceRecord                         <- services/accountability_service.py
 *
 * Where the brief and the backend disagreed, the backend won (see lib/api.ts
 * for the full reconciliation table).
 */

// ---------------------------------------------------------------------------
// Enumerations (backend Literal types)
// ---------------------------------------------------------------------------

export type SeverityTier = 'minor' | 'moderate' | 'critical'

/** NOTE: the backend literal is "self-resolved" with a HYPHEN. */
export type OutcomeType =
  | 'self-resolved'
  | 'taken_to_bhu'
  | 'referred_to_hospital'
  | 'unresolved'

export type AvailabilityStatus = 'unverified' | 'available' | 'busy' | 'offline'

/** lifecycle.VALID_CONFIRMERS — the fraud-prevention gate. */
export type OutcomeConfirmer = 'responder' | 'bhu_staff'

/** The `stage` vocabulary actually emitted into incident.reporter_updates. */
export type TimelineStage =
  | 'reported'
  | 'responder_notified'
  | 'responder_en_route'
  | 'responder_arrived'
  | 'bhu_notified'
  | 'ambulance_en_route'
  | 'closed'

/** dispatch_service.DispatchDecision.status (+ legacy slice_runner values). */
export type DispatchStatus =
  | 'dispatched'
  | 'escalated_bhu_only'
  | 'no_responders_available'
  | 'no_resources'

/** help_bot_service branch ids resolved from injury_type_flags. */
export type HelpBotBranch = 'snakebite' | 'fracture_crush' | 'heavy_bleeding'

/** detectResponderIntent classification labels. */
export type HelpBotIntent =
  | 'step_done'
  | 'in_scope_question'
  | 'out_of_scope'
  | 'escalation'
  | 'unclear'

export type StatusFlag = 'active' | 'needs_follow_up' | 'under_review'

// ---------------------------------------------------------------------------
// Core records
// ---------------------------------------------------------------------------

export interface GPSLocation {
  latitude: number
  longitude: number
  village_id: string
}

export interface ReporterUpdate {
  update_id: string
  timestamp: string
  stage: TimelineStage | string
  message_urdu: string
  severity_tier?: SeverityTier
}

export interface DispatchEvent {
  timestamp?: string
  event?: string
  [key: string]: unknown
}

export interface HelpBotTransition {
  timestamp: string
  branch: string
  from_state: string
  to_state: string
  trigger_type: string
  detail: string
}

export interface Incident {
  incident_id: string
  timestamp_reported: string
  reporter_id: string
  gps_location: GPSLocation
  photo_ref: string
  voice_ref?: string
  voice_transcript: string
  severity_tier: SeverityTier
  injury_type_flags: string[]
  responder_assigned_id: string | null
  responder_dispatch_timestamp: string | null
  bhu_notified: boolean
  bhu_notify_timestamp: string | null
  ambulance_requested: boolean
  outcome: OutcomeType | null
  outcome_confirmed_by: OutcomeConfirmer | null
  incident_closed_timestamp: string | null
  help_bot_transitions: HelpBotTransition[]
  dispatch_events: DispatchEvent[]
  dispatch_fallback_count: number
  coverage_gap: boolean
  mid_incident_escalated: boolean
  responder_arrived_timestamp: string | null
  reporter_updates: ReporterUpdate[]
  detected_emergency?: string | null
  anticipated_condition?: string | null
  first_aid_guidance?: string[] | null
  clinical_condition?: string | null
  clinical_category?: 'CATEGORY_A' | 'CATEGORY_B' | 'CATEGORY_C' | null
  dispatch_responder?: boolean
}

export interface TriageAnalysisResponse {
  status: string
  detected_emergency: string
  anticipated_condition: string
  severity_tier: SeverityTier
  injury_type_flags: string[]
  clinical_category?: 'CATEGORY_A' | 'CATEGORY_B' | 'CATEGORY_C' | null
  clinical_condition?: string | null
  dispatch_responder?: boolean
  request_ambulance?: boolean
  escalate_bhu?: boolean
  voice_signals?: string
  image_signals?: string
  confidence?: number
  first_aid_guidance: string[]
  first_aid_guidance_ur: string[]
  voice_transcript?: string
  photo_ref?: string
  voice_ref?: string
}

export interface MediaUploadResponse {
  filename: string
  file_url: string
  file_path: string
  media_type: 'image' | 'audio'
  size_bytes: number
}

export interface Responder {
  responder_id: string
  name: string
  village: string
  linked_bhu_id: string
  current_availability_status: AvailabilityStatus
  points_total?: number
  phone_number?: string | null
  is_verified?: boolean
  verified_by?: string | null
  verified_at?: string | null
  training_completed?: boolean
  training_org?: string | null
  equipment_checklist?: string[] | null
}

export interface BHU {
  bhu_id: string
  name: string
  union_council: string
  linked_village_ids: string[]
}

// ---------------------------------------------------------------------------
// Endpoint payloads
// ---------------------------------------------------------------------------

/** POST /emergency/report -> 201 */
export interface ReportResponse {
  incident: Incident
  dispatch: {
    status: DispatchStatus | string
    responder: Responder | null
    bhu: BHU | null
    notify_bhu: boolean
    bhu_urgency: 'standby' | 'urgent' | null
    ambulance_requested: boolean
    dispatch_responder?: boolean
    clinical_category?: 'CATEGORY_A' | 'CATEGORY_B' | 'CATEGORY_C' | null
    clinical_condition?: string | null
    reasoning: string
  }
  db_persisted: boolean
}

/** GET /emergency/incident/{id} -> Module 6.5 lifecycle record */
export interface IncidentRecord {
  incident: Incident
  dispatch_status: DispatchStatus | string | null
  logged_at: string
}

/** GET /emergency/incident/{id}/timeline -> lightweight Module 9 feed */
export interface TimelineResponse {
  incident_id: string
  status: string
  severity_tier: SeverityTier | null
  assigned_responder: string | null
  coverage_gap: boolean
  mid_incident_escalated: boolean
  updates: ReporterUpdate[]
}

/** POST /responder/respond -> Module 3 ack / decline */
export interface RespondResponse {
  incident_id: string
  action: 'accept' | 'decline'
  reason: string | null
  responder_id: string
  responder_assigned_id: string | null
  dispatch_events: DispatchEvent[]
  responder_status_after: AvailabilityStatus | null
}

/** POST /responder/arrived -> Module 9 check-in */
export interface ArrivedResponse {
  status: 'ok'
  incident_id: string
  arrival_update: ReporterUpdate
}

export interface ResponderChatMessage {
  role: 'user' | 'assistant'
  content: string
}

/** POST /responder/chat -> Conversational AI Copilot */
export interface ResponderChatRequest {
  incident_id: string
  responder_id: string
  message: string
  chat_history?: ResponderChatMessage[]
}

export interface ResponderChatResponse {
  incident_id: string
  responder_id: string
  reply: string
  audio_url?: string | null
  escalated?: boolean
  steps?: string[]
}

/** POST /helpbot/step -> Module 2 guidance turn */
export interface HelpBotStepResponse {
  incident_id: string
  branch_id: HelpBotBranch | string
  state: string
  intent: HelpBotIntent | string
  qa_entry_id: string | null
  escalation_signal: string | null
  escalated: boolean
  escalation_snapshot: Record<string, unknown> | null
  spoken_text_urdu: string
  step_index: number
  step_id: string | null
  turn_count: number
  /** Relative URL: /media/helpbot/tts_cache/<sha1>.wav — prefix with API base. */
  audio_url: string | null
  audio_cached: boolean
}

/** POST /emergency/incident/{id}/close -> Module 6 + Module 5 */
export interface CloseResponse {
  incident: Incident
  /** Present only when confirmed_by === 'bhu_staff' (the fraud gate). */
  outcome_recorded: Record<string, unknown> | null
  closed_by_id: string | null
}

/** GET /accountability/responder/{id}/performance -> Module 5 factual record */
export interface PerformanceRecord {
  responder_id: string
  incidents_responded_to: number
  incidents_by_outcome: Record<string, number>
  average_response_time_seconds: number
  timeout_count: number
  decline_count: number
  dispatch_metrics: {
    total_assigned: number
    completed: number
    acceptance_rate_pct: number
  }
  status_flag: StatusFlag | string
}

export interface RespondersListResponse {
  responders: Responder[]
}

export interface PendingRespondersResponse {
  pending_responders: Responder[]
  count: number
}

export interface PointTransaction {
  transaction_id: string
  responder_id: string
  incident_id: string
  points_awarded: number
  outcome: OutcomeType | string
  awarded_at: string
}

export interface PointTransactionsResponse {
  responder_id: string
  transactions: PointTransaction[]
}

export interface IncidentsListResponse {
  incidents: IncidentRecord[]
  total: number
}

export interface UpdateResponderStatusResponse {
  status: string
  responder_id: string
  current_availability_status: AvailabilityStatus
}

/** GET /health (app root, NOT under /api/v1) */
export interface HealthResponse {
  status: string
  version: string
  db_reachable: boolean
  responders_loaded: number
  incidents_in_memory: number
  helpbot_sessions: number
  cors_origins?: string[]
  /** main.py ai_provider_snapshot(): TRIAGE_AI_PROVIDER, default "gemini". */
  ai_provider?: string
  /** Per-step model names behind that provider (stt / vision / classifier). */
  ai_models?: { stt?: string; vision?: string; classifier?: string }
  /** PORT from the repo-root .env — the backend's real listen port. */
  port?: number
}

/** The project-wide error contract installed by install_error_handlers(). */
export interface ApiErrorBody {
  code: string
  message: string
}
