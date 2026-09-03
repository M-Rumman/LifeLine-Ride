/**
 * View 2 — Field Responder (first aid + Urdu audio guidance).
 *
 * Wiring notes where the brief and the backend differ:
 *   - Accept/Decline call POST /responder/respond with
 *     `action: "accept" | "decline"` (the backend's literal), not
 *     `status: "accepted"`.
 *   - Help-bot audio is NOT served from `/api/v1/media/tts?file=...`; the step
 *     reply carries a relative `/media/helpbot/tts_cache/<sha1>.wav` URL from
 *     the StaticFiles mount, which resolveMediaUrl() turns absolute.
 *   - Decline runs the Module 8 fallback walker server-side and returns the
 *     newly assigned responder, so the alert card re-targets itself.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import { useCockpit, incidentResponderId } from '../state/CockpitContext'
import { resolveMediaUrl } from '../lib/api'
import { distanceKm, responderPosition, villageById } from '../lib/geography'
import { quickRepliesFor, type QuickReply } from '../lib/scenarios'
import {
  availabilityMeta,
  formatClock,
  humaniseFlag,
  secondsSince,
  tierMeta,
} from '../lib/urdu'
import type { HelpBotBranch } from '../lib/types'
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
  const [autoPlay, setAutoPlay] = useState(true)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const logRef = useRef<HTMLDivElement | null>(null)

  const responderId = incidentResponderId(record, lastReport)
  const responder = responders.find((r) => r.responder_id === responderId) ?? null

  const tier = incident?.severity_tier ?? timeline?.severity_tier ?? null
  const meta = tierMeta(tier)
  const status = timeline?.status ?? null
  const isClosed = status === 'closed'
  const arrived = Boolean(incident?.responder_arrived_timestamp)
  const accepted = useMemo(() => {
    const events = incident?.dispatch_events ?? []
    const acknowledged = events.some((e) => {
      const name = String(e.event ?? e.type ?? '').toLowerCase()
      return name.includes('ack') || name.includes('accept') || name.includes('en_route')
    })
    // The lifecycle record polls at twice the timeline interval, so also read
    // the faster feed — it carries responder_en_route the moment the ack lands,
    // which is what flips Accept/Decline into Mark Arrived without a visible lag.
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

  const replies = useMemo(() => quickRepliesFor(branchId), [branchId])

  // Keep the transcript scrolled to the newest turn.
  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [botTurns.length])

  // Stream the newest bot line as soon as it lands.
  useEffect(() => {
    const last = botTurns[botTurns.length - 1]
    if (!last || last.speaker !== 'bot') return
    const url = resolveMediaUrl(last.audioUrl)
    if (!url) {
      setAudioSrc(null)
      return
    }
    setAudioSrc(url)
    if (autoPlay) {
      // Autoplay can be refused before any user gesture; the manual play button
      // below is the fallback, so a rejection is not an error worth surfacing.
      window.setTimeout(() => {
        void audioRef.current?.play().catch(() => setAudioPlaying(false))
      }, 60)
    }
  }, [botTurns, autoPlay])

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
            ? 'border-clinical-cyan/70 shadow-glow animate-fade-rise'
            : ''
        }
      >
        <div className="flex flex-col gap-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <InfoTile label="Responder">
              <span className="text-pearl">{responder?.name ?? responderId ?? '—'}</span>
              <span className="ml-1.5 font-mono text-[10px] text-ash">
                {responderId ?? ''}
              </span>
            </InfoTile>

            <InfoTile label="Distance to patient">
              <span className="text-clinical-cyan tabular-nums">
                {distance !== null ? `${distance.toFixed(1)} km` : '—'}
              </span>
              <span className="ml-1.5 text-[10px] text-ash/70">village-derived</span>
            </InfoTile>

            <InfoTile label="Availability">
              <span className={`inline-flex items-center gap-1.5 ${avMeta.text}`}>
                <StatusDot
                  tone={
                    responder?.current_availability_status === 'available'
                      ? 'mint'
                      : responder?.current_availability_status === 'busy'
                        ? 'cyan'
                        : 'ash'
                  }
                  pulse={responder?.current_availability_status === 'busy'}
                />
                {avMeta.en}
              </span>
            </InfoTile>

            <InfoTile label="Dispatched at">
              <span className="font-mono text-xs text-pearl tabular-nums">
                {formatClock(incident.responder_dispatch_timestamp)}
              </span>
              {incident.responder_dispatch_timestamp && !isClosed && (
                <span className="ml-1.5 text-[10px] text-ash/70 tabular-nums">
                  +{secondsSince(incident.responder_dispatch_timestamp) ?? 0}s
                </span>
              )}
            </InfoTile>
          </div>

          {/* Injury summary */}
          <div className="rounded-card border border-iris-border bg-iris-canvas/45 px-4 py-3">
            <p className="label mb-2">Injury summary</p>
            <div className="flex flex-wrap gap-2">
              {incident.injury_type_flags.map((f) => (
                <span
                  key={f}
                  className={`tag normal-case tracking-normal ${meta.border} ${meta.bg} ${meta.text}`}
                >
                  {humaniseFlag(f)}
                </span>
              ))}
            </div>
            {incident.voice_transcript && (
              <p
                dir="rtl"
                className="mt-2.5 text-[14px] leading-7 text-ash font-urdu"
              >
                {incident.voice_transcript}
              </p>
            )}
          </div>

          {/* Escalation state — live feedback from the polled record */}
          {(incident.mid_incident_escalated || incident.ambulance_requested) && (
            <div className="flex flex-wrap items-center gap-2 rounded-card border border-tier-critical/55 bg-tier-critical/12 px-4 py-3">
              <Tag tone="critical">severity upgraded</Tag>
              {incident.ambulance_requested && (
                <Tag tone="critical">ambulance requested</Tag>
              )}
              {incident.mid_incident_escalated && (
                <Tag tone="critical">mid_incident_escalated</Tag>
              )}
              {incident.bhu_notified && <Tag tone="cyan">BHU notified</Tag>}
              <span dir="rtl" className="ml-auto text-[14px] text-tier-critical font-urdu leading-7">
                مریض کی حالت بگڑ گئی — ایمرجنسی بڑھا دی گئی ہے
              </span>
            </div>
          )}

          {/* Actions */}
          <div className="flex flex-wrap items-center gap-3">
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

                <span className="text-[11px] text-ash/70">
                  Declining immediately runs the Module 8 fallback walker and
                  re-targets the next ranked responder.
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
              <span className="inline-flex items-center gap-2 rounded-full border border-mint-vital/55 bg-mint-vital/12 px-4 py-2 text-xs text-mint-vital">
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
        subtitle={`Deterministic state machine · branch "${branchId}" · hands-free voice-in / voice-out`}
        right={
          <div className="flex items-center gap-2">
            <Tag tone="cyan">Module 2</Tag>
            <label className="flex cursor-pointer items-center gap-1.5 text-[10px] uppercase tracking-wider text-ash">
              <input
                type="checkbox"
                checked={autoPlay}
                onChange={(e) => setAutoPlay(e.target.checked)}
                className="h-3 w-3 accent-clinical-cyan"
              />
              autoplay
            </label>
          </div>
        }
        panel
      >
        <div className="flex flex-col gap-4">
          {/* Audio player streaming the cached Urdu TTS wav */}
          <div className="flex flex-wrap items-center gap-3 rounded-card border border-iris-border bg-iris-canvas/45 px-4 py-3">
            <AudioWave active={audioPlaying} />
            <div className="min-w-0 flex-1">
              <p className="text-[11px] uppercase tracking-wider text-ash">
                Spoken guidance (Urdu TTS)
              </p>
              <p className="truncate font-mono text-[10px] text-ash/65">
                {audioSrc ?? 'no audio for the last turn'}
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
            className="flex max-h-[340px] min-h-[180px] flex-col gap-2.5 overflow-y-auto rounded-card border border-iris-border bg-iris-canvas/35 px-4 py-3.5"
          >
            {botTurns.length === 0 ? (
              <p className="m-auto max-w-sm text-center text-xs text-ash/80">
                Send a quick reply below to open the guidance session. The backend
                routes the incident's injury flags to a branch and speaks step 1.
              </p>
            ) : (
              botTurns.map((t, i) => (
                <div
                  key={i}
                  className={`flex ${t.speaker === 'responder' ? 'justify-end' : 'justify-start'}`}
                >
                  <div
                    className={`max-w-[85%] rounded-card border px-3.5 py-2.5 ${
                      t.speaker === 'responder'
                        ? 'border-iris-glow bg-iris-pulse/25'
                        : t.escalated
                          ? 'border-tier-critical/60 bg-tier-critical/12'
                          : 'border-iris-border bg-iris-shadow'
                    }`}
                  >
                    <p className="mb-1 text-[9px] uppercase tracking-wider text-ash">
                      {t.speaker === 'responder' ? 'You' : 'Help Bot'}
                      {t.intent ? ` · ${t.intent}` : ''}
                      {t.escalated ? ' · ESCALATION' : ''}
                      <span className="ml-2 font-mono normal-case">
                        {formatClock(new Date(t.at).toISOString())}
                      </span>
                    </p>
                    <p
                      dir="rtl"
                      className={`text-[15px] leading-8 font-urdu ${
                        t.escalated ? 'text-tier-critical' : 'text-pearl'
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
                <span className="inline-flex items-center gap-2 rounded-full border border-iris-border bg-iris-shadow px-3.5 py-2 text-[11px] text-clinical-cyan">
                  <Spinner className="h-3 w-3" /> classifying intent…
                </span>
              </div>
            )}
          </div>

          {/* Quick-response action pills */}
          <div>
            <p className="label">Quick responses</p>
            <div className="flex flex-wrap gap-2">
              {replies.map((r: QuickReply) => (
                <button
                  key={r.id}
                  type="button"
                  disabled={pendingTurn !== null || isClosed}
                  onClick={() => handleTurn(r.transcript_ur)}
                  className={`pill border px-4 py-2 text-xs disabled:opacity-45 ${
                    r.tone === 'critical'
                      ? 'border-tier-critical/55 bg-tier-critical/12 text-tier-critical hover:bg-tier-critical/22'
                      : r.tone === 'mint'
                        ? 'border-mint-vital/50 bg-mint-vital/12 text-mint-vital hover:bg-mint-vital/22'
                        : 'border-clinical-cyan/50 bg-clinical-cyan/12 text-clinical-cyan hover:bg-clinical-cyan/22'
                  }`}
                  title={r.transcript_ur}
                >
                  <span dir="rtl" className="font-urdu text-[14px] leading-6">
                    {r.transcript_ur}
                  </span>
                  <span className="opacity-70">· {r.label_en}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Free-text Urdu input */}
          <FreeTextInput
            disabled={pendingTurn !== null || isClosed}
            onSend={handleTurn}
          />

          <p className="text-[11px] text-ash/70">
            Any deterioration reported here upgrades severity and fires Module 8
            escalation server-side — the badges above and the reporter's live feed
            both update on the next 2.5s poll.
          </p>

          <div className="flex flex-wrap gap-2">
            <Pill variant="cyan" onClick={() => setRole('bhu')}>
              Continue to BHU View →
            </Pill>
            <Pill variant="ghost" onClick={() => setRole('reporter')}>
              ← Reporter View
            </Pill>
            {villageById(incident.gps_location.village_id) && (
              <span className="self-center text-[11px] text-ash/70">
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
    <div className="rounded-card border border-iris-border bg-iris-canvas/45 px-3.5 py-2.5">
      <p className="text-[10px] uppercase tracking-wider text-ash">{label}</p>
      <p className="mt-0.5 text-sm font-medium tracking-tight">{children}</p>
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
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault()
        const text = value.trim()
        if (!text || disabled) return
        onSend(text)
        setValue('')
      }}
    >
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
