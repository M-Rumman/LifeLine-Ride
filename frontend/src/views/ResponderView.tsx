/**
 * View 2 — Field Responder (first aid + Urdu audio guidance).
 *
 * Streamlined Help-Bot Interface with Web Speech STT, automatic guidance trigger,
 * clean conversation list, and inverted white card surfaces.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import { useCockpit, incidentResponderId } from '../state/CockpitContext'
import { resolveMediaUrl } from '../lib/api'
import { distanceKm, responderPosition, villageById } from '../lib/geography'
import {
  availabilityMeta,
  formatClock,
  humaniseFlag,
  secondsSince,
} from '../lib/urdu'
import type { HelpBotBranch } from '../lib/types'
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
    setRole,
  } = useCockpit()

  const [acting, setActing] = useState<'accept' | 'decline' | 'arrived' | null>(null)
  const [pendingTurn, setPendingTurn] = useState<string | null>(null)
  const [branchId, setBranchId] = useState<HelpBotBranch | string>('heavy_bleeding')
  const [audioSrc, setAudioSrc] = useState<string | null>(null)
  const [audioPlaying, setAudioPlaying] = useState(false)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const logRef = useRef<HTMLDivElement | null>(null)
  const initialTriggered = useRef(false)

  const responderId = incidentResponderId(record, lastReport)
  const responder = responders.find((r) => r.responder_id === responderId) ?? null

  const tier = incident?.severity_tier ?? timeline?.severity_tier ?? null
  const status = timeline?.status ?? null
  const isClosed = status === 'closed'
  const arrived = Boolean(incident?.responder_arrived_timestamp)
  const accepted = useMemo(() => {
    const events = incident?.dispatch_events ?? []
    const acknowledged = events.some((e) => {
      const name = String(e.event ?? e.type ?? '').toLowerCase()
      return name.includes('ack') || name.includes('accept') || name.includes('en_route')
    })
    const enRoute = (timeline?.updates ?? []).some(
      (u) => u.stage === 'responder_en_route',
    )
    return acknowledged || enRoute || arrived
  }, [incident, timeline, arrived])

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

  // Keep the transcript scrolled to the newest turn.
  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [botTurns.length])

  // Stream the newest bot line as soon as it lands
  useEffect(() => {
    const last = botTurns[botTurns.length - 1]
    if (!last || last.speaker !== 'bot') return
    const url = resolveMediaUrl(last.audioUrl)
    if (!url) {
      setAudioSrc(null)
      return
    }
    setAudioSrc(url)
    window.setTimeout(() => {
      void audioRef.current?.play().catch(() => setAudioPlaying(false))
    }, 80)
  }, [botTurns])

  // Automatically start / trigger voice bot guidance when navigating to Field Responder view
  useEffect(() => {
    if (incidentId && botTurns.length === 0 && !initialTriggered.current && !isClosed) {
      initialTriggered.current = true
      void sendHelpBotTurn('سلام، میں جائے وقوعہ پر پہنچ رہا ہوں، پہلی طبی امداد کی رہنمائی فرمائیں')
    }
  }, [incidentId, botTurns.length, isClosed, sendHelpBotTurn])

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
    setPendingTurn(transcript)
    const res = await sendHelpBotTurn(transcript)
    if (res?.branch_id) setBranchId(res.branch_id)
    setPendingTurn(null)
  }

  // -------------------------------------------------------------------------
  // No incident yet
  // -------------------------------------------------------------------------

  if (!incidentId || !incident) {
    return (
      <div className="flex flex-col gap-4">
        <Card title="Field Responder" titleUr="مددگار" panel>
          <EmptyState
            title="No active incident"
            titleUr="کوئی فعال ایمرجنسی نہیں"
            message="Report an emergency in the Reporter View. The alert card below appears the moment dispatch assigns a responder."
            action={
              <Pill variant="primary" onClick={() => setRole('reporter')}>
                ← Go to Reporter View
              </Pill>
            }
          />
        </Card>
      </div>
    )
  }

  const avMeta = availabilityMeta(responder?.current_availability_status ?? null)

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <div className="flex flex-col gap-4">
      {/* ---------------- Incoming alert card ---------------- */}
      <Card
        title="Incoming Dispatch Alert"
        titleUr="آمدہ الرٹ"
        subtitle={
          status === 'dispatched'
            ? 'Assigned to you — acknowledge before the timeout walker re-routes the case.'
            : `Current dispatch status: ${status ?? 'unknown'}`
        }
        right={<TierBadge tier={tier} />}
        className={
          status === 'dispatched' && !accepted
            ? 'border-sky-400 ring-2 ring-sky-200'
            : ''
        }
      >
        <div className="flex flex-col gap-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <InfoTile label="Responder">
              <span className="font-bold text-slate-900">{responder?.name ?? responderId ?? '—'}</span>
              <span className="ml-1.5 font-mono text-[10px] text-slate-500">
                {responderId ?? ''}
              </span>
            </InfoTile>

            <InfoTile label="Distance to patient">
              <span className="font-bold text-sky-700 tabular-nums">
                {distance !== null ? `${distance.toFixed(1)} km` : '—'}
              </span>
              <span className="ml-1.5 text-[10px] text-slate-500">village-derived</span>
            </InfoTile>

            <InfoTile label="Availability">
              <span className="inline-flex items-center gap-1.5 font-semibold text-slate-800">
                <StatusDot
                  tone={
                    responder?.current_availability_status === 'available'
                      ? 'mint'
                      : responder?.current_availability_status === 'busy'
                        ? 'cyan'
                        : 'ash'
                  }
                />
                {avMeta.en}
              </span>
            </InfoTile>

            <InfoTile label="Dispatched at">
              <span className="font-mono text-xs font-semibold text-slate-800 tabular-nums">
                {formatClock(incident.responder_dispatch_timestamp)}
              </span>
              {incident.responder_dispatch_timestamp && !isClosed && (
                <span className="ml-1.5 text-[10px] text-slate-500 tabular-nums">
                  +{secondsSince(incident.responder_dispatch_timestamp) ?? 0}s
                </span>
              )}
            </InfoTile>
          </div>

          {/* Injury summary */}
          <div className="rounded-2xl border border-slate-200 bg-slate-50/70 p-4">
            <p className="label mb-2">Injury summary</p>
            <div className="flex flex-wrap gap-2">
              {incident.injury_type_flags.map((f) => (
                <span
                  key={f}
                  className="tag normal-case tracking-normal border-slate-200 bg-white text-slate-800"
                >
                  {humaniseFlag(f)}
                </span>
              ))}
            </div>
            {incident.voice_transcript && (
              <p
                dir="rtl"
                className="mt-2.5 text-[14px] leading-7 text-slate-700 font-urdu"
              >
                {incident.voice_transcript}
              </p>
            )}
          </div>

          {/* Escalation state — live feedback from the polled record */}
          {(incident.mid_incident_escalated || incident.ambulance_requested) && (
            <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-rose-300 bg-rose-50 p-4">
              <Tag tone="critical">severity upgraded</Tag>
              {incident.ambulance_requested && (
                <Tag tone="critical">ambulance requested</Tag>
              )}
              {incident.mid_incident_escalated && (
                <Tag tone="critical">mid_incident_escalated</Tag>
              )}
              {incident.bhu_notified && <Tag tone="cyan">BHU notified</Tag>}
              <span dir="rtl" className="ml-auto text-[14px] text-rose-800 font-urdu font-semibold leading-7">
                مریض کی حالت بگڑ گئی — ایمرجنسی بڑھا دی گئی ہے
              </span>
            </div>
          )}

          {/* Actions */}
          <div className="flex flex-wrap items-center gap-3 pt-1">
            {!accepted && !isClosed && (
              <>
                <Pill
                  variant="mint"
                  size="lg"
                  onClick={() => handleRespond('accept')}
                  disabled={acting !== null}
                >
                  {acting === 'accept' ? (
                    <Spinner />
                  ) : (
                    <span dir="rtl" className="font-urdu text-[15px] leading-7">
                      قبول کریں
                    </span>
                  )}
                  <span className="opacity-80">(Accept)</span>
                </Pill>

                <Pill
                  variant="danger"
                  size="lg"
                  onClick={() => handleRespond('decline')}
                  disabled={acting !== null}
                >
                  {acting === 'decline' ? (
                    <Spinner />
                  ) : (
                    <span dir="rtl" className="font-urdu text-[15px] leading-7">
                      انکار کریں
                    </span>
                  )}
                  <span className="opacity-80">(Decline)</span>
                </Pill>

                <span className="text-[11px] text-slate-500">
                  Declining triggers automatic fallback and re-targets the next available responder.
                </span>
              </>
            )}

            {(accepted || isClosed) && !arrived && (
              <Pill
                variant="cyan"
                size="lg"
                onClick={handleArrived}
                disabled={acting !== null || isClosed}
              >
                {acting === 'arrived' ? (
                  <Spinner />
                ) : (
                  <span dir="rtl" className="font-urdu text-[15px] leading-7">
                    میں جائے وقوعہ پر پہنچ گیا ہوں
                  </span>
                )}
                <span className="opacity-80">(Mark Arrived)</span>
              </Pill>
            )}

            {arrived && (
              <span className="inline-flex items-center gap-2 rounded-full border border-emerald-300 bg-emerald-50 px-4 py-2 text-xs font-semibold text-emerald-800">
                <StatusDot tone="mint" />
                On scene since {formatClock(incident.responder_arrived_timestamp)}
              </span>
            )}

            {isClosed && <Tag tone="mint">incident closed</Tag>}
          </div>
        </div>
      </Card>

      {/* ---------------- Interactive Urdu help-bot ---------------- */}
      <Card
        title="Responder Help Bot"
        titleUr="مددگار بوٹ — اردو رہنمائی"
        subtitle={`Branch "${branchId}" · turn-by-turn conversational audio guidance`}
        right={<Tag tone="cyan">AI Guidance</Tag>}
        panel
      >
        <div className="flex flex-col gap-4">
          {/* Audio player streaming the cached Urdu TTS wav */}
          <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-slate-200 bg-slate-50 p-3.5">
            <AudioWave active={audioPlaying} />
            <div className="min-w-0 flex-1">
              <p className="text-[11px] font-bold uppercase tracking-wider text-slate-600">
                Spoken guidance (Urdu TTS)
              </p>
              <p className="truncate font-mono text-[10px] text-slate-400">
                {audioSrc ?? 'audio streaming ready'}
              </p>
            </div>
            <audio
              ref={audioRef}
              src={audioSrc ?? undefined}
              controls
              preload="none"
              className="h-9 max-w-[300px] flex-1"
              onPlay={() => setAudioPlaying(true)}
              onPause={() => setAudioPlaying(false)}
              onEnded={() => setAudioPlaying(false)}
              onError={() => setAudioPlaying(false)}
            />
          </div>

          {/* Conversation log */}
          <div
            ref={logRef}
            className="flex max-h-[380px] min-h-[200px] flex-col gap-3 overflow-y-auto rounded-2xl border border-slate-200 bg-slate-50/50 p-4"
          >
            {botTurns.length === 0 ? (
              <div className="m-auto flex flex-col items-center gap-2 py-6 text-center text-xs text-slate-500">
                <Spinner className="h-4 w-4" />
                <span>رہنمائی شروع ہو رہی ہے… (Starting guidance session)</span>
              </div>
            ) : (
              botTurns.map((t, i) => (
                <div
                  key={i}
                  className={`flex ${t.speaker === 'responder' ? 'justify-end' : 'justify-start'}`}
                >
                  <div
                    className={`max-w-[85%] rounded-2xl border p-3.5 shadow-sm ${
                      t.speaker === 'responder'
                        ? 'border-sky-300 bg-sky-50 text-sky-950'
                        : t.escalated
                          ? 'border-rose-300 bg-rose-50 text-rose-950'
                          : 'border-slate-200 bg-white text-slate-900'
                    }`}
                  >
                    <p className="mb-1 text-[10px] font-bold uppercase tracking-wider text-slate-500">
                      {t.speaker === 'responder' ? 'You (آپ)' : 'Help Bot (رہنما)'}
                      {t.intent ? ` · ${t.intent}` : ''}
                      {t.escalated ? ' · ESCALATION' : ''}
                      <span className="ml-2 font-mono font-normal normal-case text-slate-400">
                        {formatClock(new Date(t.at).toISOString())}
                      </span>
                    </p>
                    <p
                      dir="rtl"
                      className={`text-[15px] leading-8 font-urdu ${
                        t.escalated ? 'text-rose-900 font-semibold' : 'text-slate-900'
                      }`}
                    >
                      {t.text}
                    </p>
                  </div>
                </div>
              ))
            )}
            {pendingTurn && (
              <div className="flex justify-start">
                <span className="inline-flex items-center gap-2 rounded-full border border-sky-200 bg-white px-3.5 py-2 text-[11px] font-medium text-sky-700 shadow-sm">
                  <Spinner className="h-3 w-3" /> classifying intent…
                </span>
              </div>
            )}
          </div>

          {/* Direct Urdu Voice & Text input */}
          <FreeTextInput
            disabled={pendingTurn !== null || isClosed}
            onSend={handleTurn}
          />

          <p className="text-[11px] text-slate-500">
            Deterioration reported here immediately upgrades severity and triggers emergency
            escalation server-side.
          </p>

          <div className="flex flex-wrap gap-2 pt-1">
            <Pill variant="cyan" onClick={() => setRole('bhu')}>
              Continue to BHU View →
            </Pill>
            <Pill variant="ghost" onClick={() => setRole('reporter')}>
              ← Reporter View
            </Pill>
            {villageById(incident.gps_location.village_id) && (
              <span className="self-center text-[11px] text-slate-500">
                {villageById(incident.gps_location.village_id)?.label_en} · linked BHU{' '}
                {villageById(incident.gps_location.village_id)?.linked_bhu_id}
              </span>
            )}
          </div>
        </div>
      </Card>
    </div>
  )
}

function InfoTile({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-slate-50/80 px-4 py-3">
      <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">{label}</p>
      <p className="mt-0.5 text-sm font-semibold tracking-tight text-slate-800">{children}</p>
    </div>
  )
}

function FreeTextInput({
  onSend,
  disabled,
}: {
  onSend: (text: string) => void
  disabled: boolean
}) {
  const [value, setValue] = useState('')

  // Web Speech API Voice Input
  const { isListening, isSupported, toggleListening } = useSpeechToText({
    lang: 'ur-PK',
    fallbackLang: 'ur',
    onTranscript: (spokenText) => {
      setValue(spokenText)
    },
  })

  return (
    <form
      className="flex flex-wrap items-center gap-2.5"
      onSubmit={(e) => {
        e.preventDefault()
        const text = value.trim()
        if (!text || disabled) return
        onSend(text)
        setValue('')
      }}
    >
      {/* Microphone pill button */}
      {isSupported && (
        <button
          type="button"
          disabled={disabled}
          onClick={toggleListening}
          className={`pill px-4 py-2.5 text-xs font-semibold transition-all ${
            isListening
              ? 'bg-rose-600 hover:bg-rose-700 text-white animate-pulse border-2 border-rose-400 shadow-md ring-2 ring-rose-300'
              : 'bg-sky-600 hover:bg-sky-700 text-white shadow-sm'
          }`}
          title="Speak in Urdu"
        >
          <span className="text-sm">{isListening ? '🛑' : '🎙️'}</span>
          <span>{isListening ? '🛑 سن رہا ہے... (Listening - Click to Stop)' : '🎙️ بولیں (Speak)'}</span>
        </button>
      )}

      <input
        dir="rtl"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="…یہاں اردو میں بولیں یا لکھیں"
        disabled={disabled}
        className="field flex-1 font-urdu text-[15px] leading-7"
        aria-label="Responder Urdu transcript"
      />

      <Pill variant="primary" type="submit" disabled={disabled || !value.trim()}>
        <span dir="rtl" className="font-urdu text-[14px] leading-6">
          بھیجیں
        </span>
        <span className="opacity-80">(Send)</span>
      </Pill>
    </form>
  )
}
