/**
 * View 2 — Field Responder panel of the three-panel demo cockpit.
 *
 * Single focus: accept the dispatch, navigate in, and follow hands-free Urdu
 * audio first-aid guidance. Also hosts the live responder registry roster
 * (green = available, red = on incident, grey = offline) that the demo script
 * watches flip when a dispatch lands and again when the incident closes.
 *
 * Two invariants carried over from the help-bot hardening pass and deliberately
 * preserved through the redesign — they are behavioural, not cosmetic:
 *
 *  1. NO auto-play. `botTurns` lives in CockpitContext and therefore survives a
 *     role switch, so an unconditional `play()` on mount used to fire unrequested
 *     "ghost" audio every time the responder tab was opened. Playback is gated on
 *     `playNextBotTurnRef`, which is only set by an explicit user gesture.
 *  2. NO ghost messages. The log starts empty; the session is opened by the
 *     responder pressing Start Guidance, tapping a chip, or speaking.
 *
 * Quick-reply chips send their label VERBATIM — a chip never says one thing and
 * post another.
 */

import { useEffect, useMemo, useRef, useState } from 'react'

import { useCockpit, incidentResponderId, type Role } from '../state/CockpitContext'
import { PANEL_ANCHOR } from '../components/Header'
import { resolveMediaUrl } from '../lib/api'
import { distanceKm, responderPosition, villageById } from '../lib/geography'
import {
  availabilityMeta,
  formatClock,
  humaniseFlag,
} from '../lib/urdu'
import type { Responder } from '../lib/types'
import { useSpeechToText } from '../hooks/useSpeechToText'
import {
  AudioWave,
  Card,
  EmptyState,
  Pill,
  Spinner,
  StatusDot,
  Tag,
  TierBadge,
} from '../components/ui'

/**
 * All three cockpit panels are on screen at once, so "go to another view" is a
 * scroll to that panel — not a route change.
 */
function focusPanel(role: Role) {
  document.getElementById(PANEL_ANCHOR[role])?.scrollIntoView({
    behavior: 'smooth',
    block: 'start',
    inline: 'start',
  })
}

/**
 * Quick-reply chips rendered above the help-bot input.
 */
const QUICK_REPLIES: {
  id: string
  label_ur: string
  label_en: string
  transcript: string
  tone: 'mint' | 'critical'
}[] = [
  {
    id: 'next-step',
    label_ur: 'اگلا قدم بتائیں',
    label_en: 'Next Step',
    transcript: 'اگلا قدم بتائیں',
    tone: 'mint',
  },
  {
    id: 'bleeding-not-stopping',
    label_ur: 'خون نہیں رک رہا',
    label_en: 'Bleeding Not Stopping',
    transcript: 'خون نہیں رک رہا',
    tone: 'critical',
  },
  {
    id: 'unconscious',
    label_ur: 'مریض بے ہوش ہے',
    label_en: 'Patient Unconscious',
    transcript: 'مریض بے ہوش ہے',
    tone: 'critical',
  },
]

/** Utterance that opens a session, sent only when the responder presses the
 *  explicit "Start Guidance" button. */
const START_GUIDANCE_UR =
  'سلام، میں جائے وقوعہ پر پہنچ گیا ہوں، پہلی طبی امداد کی رہنمائی فرمائیں'

export function ResponderView() {
  const {
    incident,
    record,
    lastReport,
    timeline,
    responders,
    respond,
    markArrived,
    sendHelpBotTurn,
    botTurns,
    incidentId,
    lang,
  } = useCockpit()

  const [acting, setActing] = useState<'accept' | 'decline' | 'arrived' | null>(null)
  const [pendingTurn, setPendingTurn] = useState<string | null>(null)
  const [audioSrc, setAudioSrc] = useState<string | null>(null)
  const [audioPlaying, setAudioPlaying] = useState(false)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const logRef = useRef<HTMLDivElement | null>(null)
  /** True only between an explicit user send and the bot line answering it. */
  const playNextBotTurnRef = useRef(false)

  const responderId = incidentResponderId(record, lastReport)
  const responder = responders.find((r) => r.responder_id === responderId) ?? null

  const tier = incident?.severity_tier ?? timeline?.severity_tier ?? null
  const status = timeline?.status ?? null
  const isClosed = status === 'closed'
  const arrived = Boolean(incident?.responder_arrived_timestamp) || status === 'responder_arrived' || status === 'arrived'
  const accepted = useMemo(() => {
    const events = incident?.dispatch_events ?? []
    const acknowledged = events.some((e) => {
      const name = String(e.event ?? e.type ?? '').toLowerCase()
      return name.includes('ack') || name.includes('accept') || name.includes('en_route')
    })
    const enRoute = (timeline?.updates ?? []).some(
      (u) => u.stage === 'responder_en_route',
    )
    return acknowledged || enRoute || status === 'responder_en_route' || arrived
  }, [incident, timeline, arrived, status])

  const isEnRoute = accepted && !arrived && !isClosed

  // Smooth interpolation progress for distance countdown matching situation map
  const [routeProgress, setRouteProgress] = useState(0)

  useEffect(() => {
    if (!isEnRoute) {
      setRouteProgress(0)
      return
    }
    const durationMs = 18_000
    const start = performance.now()
    let frameId: number
    const tick = (now: number) => {
      const elapsed = (now - start) % durationMs
      setRouteProgress(elapsed / durationMs)
      frameId = requestAnimationFrame(tick)
    }
    frameId = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frameId)
  }, [isEnRoute])

  /** Distance the responder has to cover — derived from the village registry. */
  const distance = useMemo(() => {
    if (!incident?.gps_location || !responderId) return null
    const from = responderPosition(
      responderId,
      responder?.village ?? incident.gps_location.village_id,
    )
    if (!from) return null
    return distanceKm(from, {
      lat: incident.gps_location.latitude,
      lng: incident.gps_location.longitude,
    })
  }, [incident, responderId, responder])

  const displayDistance = useMemo(() => {
    if (arrived || isClosed) {
      return lang === 'en' ? '0.0 km (Arrived)' : '0.0 km (پہنچ چکے ہیں)'
    }
    if (distance === null) return '—'
    if (!isEnRoute) {
      return `${distance.toFixed(1)} km`
    }
    // Interpolate progress along route countdown
    const fraction = Math.min(Math.max(routeProgress * 0.9 + 0.05, 0), 0.95)
    const dynamicKm = Math.max(distance * (1 - fraction), 0.1)
    return `${dynamicKm.toFixed(1)} km`
  }, [arrived, isClosed, distance, isEnRoute, routeProgress, lang])

  // Keep the transcript scrolled to the newest turn.
  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [botTurns.length, pendingTurn])

  /**
   * Bind the newest bot line to the player, and start playback ONLY when that
   * line answers an explicit user turn.
   *
   * `botTurns` lives in CockpitContext, so it survives a role switch: an
   * unconditional play() here fired on mount and was the source of the
   * unrequested "ghost" audio. Gating on `playNextBotTurnRef` means audio
   * starts after the responder presses a chip, sends text or speaks — never on
   * tab load. There is no `autoPlay` attribute and no unguarded play() call.
   */
  useEffect(() => {
    const last = botTurns[botTurns.length - 1]
    if (!last || last.speaker !== 'bot') return
    const url = resolveMediaUrl(last.audioUrl)
    setAudioSrc(url)
    if (!url || !playNextBotTurnRef.current) return
    playNextBotTurnRef.current = false
    void audioRef.current?.play().catch(() => {
      // Autoplay policy refused it — the native controls remain available.
      setAudioPlaying(false)
    })
  }, [botTurns])

  async function handleRespond(action: 'accept' | 'decline') {
    setActing(action)
    await respond(action, action === 'decline' ? 'declined_from_cockpit' : undefined)
    setActing(null)
  }

  async function handleArrived() {
    setActing('arrived')
    await markArrived()
    setActing(null)
  }

  async function handleTurn(transcript: string) {
    const text = transcript.trim()
    // Re-entrancy guard: a double-clicked chip or an Enter held down must not
    // post two turns for one gesture.
    if (!text || pendingTurn !== null) return
    setPendingTurn(text)
    // An explicit user gesture — the bot line answering it may start playing.
    playNextBotTurnRef.current = true
    await sendHelpBotTurn(text)
    setPendingTurn(null)
  }

  /**
   * Explicit, user-initiated session opener — replaces the removed
   * auto-injected greeting. The transcript log stays clean and empty until the
   * responder presses this, taps a quick reply, or speaks.
   */
  async function startGuidance() {
    await handleTurn(START_GUIDANCE_UR)
  }

  // -------------------------------------------------------------------------
  // No incident yet
  // -------------------------------------------------------------------------

  if (!incidentId || !incident) {
    return (
      <div className="flex flex-col gap-5">
        <Card title="Field Responder Terminal" titleUr="فرسٹ رسپانڈر ٹرمینل" panel>
          <EmptyState
            title="No active dispatch"
            titleUr="کوئی فعال ڈسپیچ نہیں"
            message="Report an emergency from the gateway. The alert card below appears the moment dispatch assigns a responder."
            action={
              <Pill variant="primary" onClick={() => focusPanel('reporter')}>
                ← Go to Report Emergency
              </Pill>
            }
          />
        </Card>
        <ResponderRoster responders={responders} lang={lang} activeResponderId={null} />
      </div>
    )
  }

  const village = villageById(incident.gps_location.village_id)

  // -------------------------------------------------------------------------
  // Render — Role-isolated focused card layout
  // -------------------------------------------------------------------------

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      {!accepted && !isClosed ? (
        /* ================= Screen 1: Incoming dispatch alert ================= */
        <Card
          title="Incoming Dispatch Alert"
          titleUr="آمدہ الرٹ"
          right={<TierBadge tier={tier} />}
          panel
          className={
            tier === 'critical'
              ? 'border-rose-500/50 shadow-rose'
              : 'border-sky-500/50 shadow-glow'
          }
        >
          <div className="flex flex-col gap-5">
            {/* ---- Distance & Injury Facts ---- */}
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="well p-5">
                <p className="label">Distance to patient</p>
                <p className="mt-1 text-3xl font-extrabold tracking-tighter text-sky-400 tabular-nums">
                  {displayDistance}
                </p>
                <div className="mt-2 flex items-center gap-1.5">
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-sky-500/30 bg-sky-500/10 px-2.5 py-0.5 text-xs font-semibold text-sky-300">
                    <StatusDot tone="cyan" pulse />
                    {village?.label_en ?? 'Local Village'}
                  </span>
                </div>
              </div>

              <div className="well p-5">
                <p className="label">Injury Classification</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {incident.injury_type_flags.length === 0 ? (
                    <Tag tone="ash">General Emergency</Tag>
                  ) : (
                    incident.injury_type_flags.map((f) => (
                      <span
                        key={f}
                        className="inline-flex items-center rounded-full border border-sky-500/35 bg-sky-500/10 px-3 py-1.5 text-xs font-semibold text-sky-200"
                      >
                        {humaniseFlag(f)}
                      </span>
                    ))
                  )}
                </div>
              </div>
            </div>

            {/* ---- Reporter's own words ---- */}
            {incident.voice_transcript && (
              <div className="well px-5 py-4">
                <p className="label mb-1">What the reporter said</p>
                <p dir="rtl" className="text-[15px] leading-8 text-slate-200 font-urdu">
                  {incident.voice_transcript}
                </p>
              </div>
            )}

            {/* ---- Escalation banner ---- */}
            {(incident.mid_incident_escalated || incident.ambulance_requested) && (
              <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-rose-500/50 bg-rose-500/15 p-4 shadow-rose">
                <StatusDot tone="critical" pulse />
                <Tag tone="critical">Severity Upgraded</Tag>
                {incident.ambulance_requested && <Tag tone="critical">Ambulance Requested</Tag>}
                <span
                  dir="rtl"
                  className="ml-auto font-urdu text-[14px] font-semibold leading-7 text-rose-100"
                >
                  مریض کی حالت بگڑ گئی — فوری مدد درکار ہے
                </span>
              </div>
            )}

            {/* ---- Accept / Decline Actions ---- */}
            <div className="flex flex-wrap items-center gap-3 border-t border-slate-800 pt-4">
              <Pill
                variant="primary"
                size="lg"
                loading={acting === 'accept'}
                onClick={() => handleRespond('accept')}
                disabled={acting !== null}
                className="flex-1"
              >
                {acting !== 'accept' && (
                  <>
                    <span dir="rtl" className="font-urdu text-[17px] leading-7">
                      قبول کریں
                    </span>
                    <span className="opacity-80">(Accept Dispatch)</span>
                  </>
                )}
              </Pill>

              <Pill
                variant="danger"
                size="lg"
                loading={acting === 'decline'}
                onClick={() => handleRespond('decline')}
                disabled={acting !== null}
              >
                {acting !== 'decline' && (
                  <>
                    <span dir="rtl" className="font-urdu text-[17px] leading-7">
                      انکار کریں
                    </span>
                    <span className="opacity-80">(Decline)</span>
                  </>
                )}
              </Pill>
            </div>
          </div>
        </Card>
      ) : (
        /* ================= Screen 2: Step-by-step guidance interface ================= */
        <Card
          title="Responder Guidance Console"
          titleUr="فرسٹ رسپانڈر رہنمائی"
          right={
            <div className="flex items-center gap-2">
              <span
                className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-bold ${
                  arrived
                    ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-300'
                    : 'border-sky-500/40 bg-sky-500/15 text-sky-300'
                }`}
              >
                <StatusDot tone={arrived ? 'mint' : 'cyan'} pulse={!arrived} />
                {arrived ? 'On Scene' : 'En Route'}
              </span>
            </div>
          }
          panel
        >
          <div className="flex flex-col gap-4">
            {/* ---- Arrival Action Pill (when En Route) ---- */}
            {!arrived && !isClosed && (
              <div className="flex items-center justify-between rounded-2xl border border-sky-500/30 bg-sky-500/10 p-4 shadow-glow">
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-sky-200">
                    {lang === 'ur' ? 'راستے میں ہیں' : 'Currently Navigating to Scene'}
                  </p>
                  <p className="text-[11px] text-ink-dim">
                    {village?.label_en} · {displayDistance} away
                  </p>
                </div>
                <Pill
                  variant="cyan"
                  size="md"
                  loading={acting === 'arrived'}
                  onClick={handleArrived}
                  disabled={acting !== null || isClosed}
                >
                  {acting !== 'arrived' && (
                    <>
                      <span dir="rtl" className="font-urdu text-[15px] leading-6">
                        میں پہنچ گیا ہوں
                      </span>
                      <span className="opacity-85">(Mark Arrived)</span>
                    </>
                  )}
                </Pill>
              </div>
            )}

            {/* ---- Spoken guidance player ---- */}
            <div className="well flex flex-wrap items-center gap-3 p-4">
              <AudioWave active={audioPlaying} />
              <div className="min-w-0 flex-1">
                <p className="text-[11px] font-bold uppercase tracking-wider text-ink-muted">
                  Spoken Guidance (Urdu Audio)
                </p>
                <p className="truncate font-mono text-[10px] text-ink-dim">
                  {audioSrc ? 'Audio instructions ready' : 'Tap play or start guidance below'}
                </p>
              </div>
              <audio
                ref={audioRef}
                src={audioSrc ?? undefined}
                controls
                preload="auto"
                className="h-9 max-w-[280px] flex-1"
                onPlay={() => setAudioPlaying(true)}
                onPause={() => setAudioPlaying(false)}
                onEnded={() => setAudioPlaying(false)}
                onError={() => setAudioPlaying(false)}
              />
            </div>

            {/* ---- Conversation log ---- */}
            <div
              ref={logRef}
              className="flex max-h-[420px] min-h-[220px] flex-col gap-3 overflow-y-auto rounded-2xl border border-slate-800 bg-sunken p-4"
            >
              {botTurns.length === 0 ? (
                <div className="m-auto flex flex-col items-center gap-3 py-6 text-center">
                  <p dir="rtl" className="font-urdu text-[16px] font-bold leading-8 text-slate-100">
                    رہنمائی تیار ہے — بولیں، لکھیں یا نیچے دیے گئے بٹن میں سے کوئی منتخب کریں
                  </p>
                  <Pill
                    variant="primary"
                    size="lg"
                    loading={pendingTurn !== null}
                    onClick={startGuidance}
                    disabled={pendingTurn !== null || isClosed}
                  >
                    {pendingTurn === null && (
                      <>
                        <span dir="rtl" className="font-urdu text-[16px] leading-7">
                          رہنمائی شروع کریں
                        </span>
                        <span className="opacity-80">(Start Guidance)</span>
                      </>
                    )}
                  </Pill>
                </div>
              ) : (
                botTurns.map((t, i) => (
                  <ChatBubble key={i} turn={t} />
                ))
              )}

              {pendingTurn && (
                <div className="flex justify-start">
                  <span className="inline-flex items-center gap-2 rounded-2xl rounded-bl-sm border border-slate-700 bg-slate-800 px-3.5 py-2 text-[11px] font-medium text-sky-300">
                    <Spinner className="h-3 w-3" /> processing guidance…
                  </span>
                </div>
              )}
            </div>

            {/* ---- Composer bar ---- */}
            <FreeTextInput sending={pendingTurn !== null} closed={isClosed} onSend={handleTurn} />

            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-800 pt-4">
              <Pill variant="cyan" onClick={() => focusPanel('bhu')}>
                Continue to BHU Console →
              </Pill>
              <Pill variant="ghost" onClick={() => focusPanel('reporter')}>
                ← Report Emergency
              </Pill>
            </div>
          </div>
        </Card>
      )}
    </div>
  )
}

// ===========================================================================
// Chat bubble
// ===========================================================================

/**
 * One conversation turn.
 *
 * Responder bubbles are slate-blue and right-aligned; clinical-bot bubbles are
 * slate-800 and left-aligned. An escalated bot turn is the one case where the
 * bubble goes rose — it IS an escalation banner, which is what rose is reserved
 * for.
 */
/**
 * Live registry roster (View 2 requirement): every responder served by
 * `GET /api/v1/responders`, polled by the shared context, with availability
 * colour-coded — green = available, rose = busy on an incident, grey = offline.
 * The responder currently assigned to the active incident is highlighted, so
 * the green → red → green flip the demo narrates is visible right here.
 */
function ResponderRoster({
  responders,
  lang,
  activeResponderId,
}: {
  responders: Responder[]
  lang: 'ur' | 'en'
  activeResponderId: string | null
}) {
  return (
    <Card title="Responder Registry" titleUr="رسپانڈر رجسٹری" panel>
      {responders.length === 0 ? (
        <p className="text-[12px] text-ink-dim">Loading…</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {responders.map((r) => {
            const meta = availabilityMeta(r.current_availability_status)
            const isActive = r.responder_id === activeResponderId
            return (
              <li
                key={r.responder_id}
                className={`flex items-center gap-3 rounded-card border px-3 py-2 ${
                  isActive
                    ? 'border-accent/50 bg-accent/10'
                    : 'border-slate-800 bg-sunken'
                }`}
              >
                <StatusDot
                  tone={
                    r.current_availability_status === 'available'
                      ? 'mint'
                      : r.current_availability_status === 'busy'
                        ? 'critical'
                        : 'ash'
                  }
                  pulse={isActive}
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-semibold text-ink">
                    {r.name}
                    <span className="ml-2 font-mono text-[10px] text-ink-dim">
                      {r.responder_id}
                    </span>
                  </p>
                  <p className="truncate text-[11px] text-ink-muted">{r.village}</p>
                </div>
                <span
                  className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-bold ${meta.text} ${meta.bg} ${meta.border}`}
                >
                  {lang === 'ur' ? meta.ur : meta.en}
                </span>
              </li>
            )
          })}
        </ul>
      )}
    </Card>
  )
}

function ChatBubble({ turn }: { turn: { speaker: 'responder' | 'bot'; text: string; at: number; intent?: string; escalated?: boolean } }) {
  const mine = turn.speaker === 'responder'

  return (
    <div className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[85%] rounded-2xl border p-3.5 ${
          mine
            ? 'rounded-br-sm border-sky-500/35 bg-sky-500/15'
            : turn.escalated
              ? 'rounded-bl-sm border-rose-500/45 bg-rose-500/12'
              : 'rounded-bl-sm border-slate-700 bg-slate-800'
        }`}
      >
        <p
          className={`mb-1.5 text-[10px] font-bold uppercase tracking-wider ${
            mine ? 'text-sky-300/80' : turn.escalated ? 'text-rose-300/80' : 'text-ink-dim'
          }`}
        >
          {mine ? 'You (آپ)' : 'Clinical Bot (رہنما)'}
          {turn.intent ? ` · ${turn.intent}` : ''}
          {turn.escalated ? ' · ESCALATION' : ''}
          <span
            className={`ml-2 font-mono font-normal normal-case ${
              mine ? 'text-sky-400/50' : 'text-ink-dim/70'
            }`}
          >
            {formatClock(new Date(turn.at).toISOString())}
          </span>
        </p>
        <p
          dir="rtl"
          className={`font-urdu text-[15px] leading-8 ${
            turn.escalated ? 'font-semibold text-rose-100' : mine ? 'text-sky-50' : 'text-slate-100'
          }`}
        >
          {turn.text}
        </p>
      </div>
    </div>
  )
}

// ===========================================================================
// Composer bar — quick-reply chips above the input row
// ===========================================================================

function FreeTextInput({
  onSend,
  sending,
  closed,
}: {
  onSend: (text: string) => void
  /** A turn is in flight — chips and Send dim, but the box stays editable. */
  sending: boolean
  closed: boolean
}) {
  const [value, setValue] = useState('')

  // Web Speech API voice input (ur-PK -> ur -> en-US, then manual typing)
  const { isListening, isSupported, degraded, toggleListening } = useSpeechToText({
    lang: 'ur-PK',
    fallbackLang: 'ur',
    retryLangs: ['en-US'],
    continuous: false,
    interimResults: true,
    // The hook emits the whole utterance so far, so replace rather than append.
    onTranscript: (spokenText) => {
      setValue(spokenText)
    },
  })

  function send(text: string) {
    const trimmed = text.trim()
    if (!trimmed || sending) return
    onSend(trimmed)
    setValue('')
  }

  return (
    <div className="rounded-2xl border border-slate-700 bg-raised/50 p-3.5">
      {/* One tap posts the turn to POST /api/v1/helpbot/step. The chip's label
          and its payload are the same string, so what the responder reads is
          exactly what the classifier receives. */}
      <div className="flex flex-wrap gap-2 pb-3">
        {QUICK_REPLIES.map((q) => (
          <button
            key={q.id}
            type="button"
            disabled={sending}
            onClick={() => send(q.transcript)}
            className={`pill px-3.5 py-2 text-xs font-semibold transition-all disabled:cursor-not-allowed disabled:opacity-45 ${
              q.tone === 'critical'
                ? 'border border-rose-500/40 bg-rose-500/10 text-rose-200 hover:bg-rose-500/20'
                : 'border border-emerald-500/40 bg-emerald-500/10 text-emerald-200 hover:bg-emerald-500/20'
            }`}
            title={`Sends: ${q.transcript}`}
          >
            <span dir="rtl" className="font-urdu text-[14px] leading-6">
              {q.label_ur}
            </span>
            <span className="opacity-70">({q.label_en})</span>
          </button>
        ))}
      </div>

      <form
        className="flex flex-wrap items-center gap-2.5 border-t border-slate-700/70 pt-3"
        onSubmit={(e) => {
          e.preventDefault()
          send(value)
        }}
      >
        {/* Voice-in. Listening uses the cyan pulse rather than rose: recording
            is an active input state, not a critical emergency. */}
        {isSupported && (
          <button
            type="button"
            onClick={toggleListening}
            aria-pressed={isListening}
            className={`pill shrink-0 px-4 py-2.5 text-xs font-semibold transition-all ${
              isListening
                ? 'animate-pulse border border-sky-400 bg-sky-500 text-white shadow-glow'
                : 'border border-accent bg-accent text-white shadow-sm hover:bg-accent-bright'
            }`}
            title="Speak in Urdu"
          >
            {isListening
              ? '🔴 سن رہا ہے… (Listening — tap to stop)'
              : '🎙️ بولیں (Speak)'}
          </button>
        )}

        {/* NEVER disabled: the responder can always type — even while a turn is
            in flight or after the incident closed — so a stuck state can't lock
            the input and stall conversational testing. */}
        <input
          dir="rtl"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="…یہاں اردو میں بولیں یا لکھیں"
          className="field min-w-[180px] flex-1 font-urdu text-[15px] leading-7"
          aria-label="Responder Urdu transcript"
        />

        <Pill
          variant="primary"
          type="submit"
          loading={sending}
          disabled={sending || !value.trim()}
        >
          {!sending && (
            <>
              <span dir="rtl" className="font-urdu text-[14px] leading-6">
                بھیجیں
              </span>
              <span className="opacity-80">(Send)</span>
            </>
          )}
        </Pill>
      </form>

      {degraded && (
        <p className="pt-2.5 text-[11px] leading-5 text-amber-300">
          Speech service unreachable after automatic retries (ur-PK → ur → en-US) —
          the quick replies above and the text box both work without the microphone.
        </p>
      )}

      {closed && (
        <p className="pt-2.5 text-[11px] leading-5 text-ink-dim">
          This incident is closed. Turns are refused server-side with
          <span className="font-mono text-ink-muted"> 409 INCIDENT_CLOSED</span>.
        </p>
      )}
    </div>
  )
}
