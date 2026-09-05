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
 *  2. NO ghost messages. The log starts empty; the session is opened only when
 *     the responder types a message, taps an emergency chip, or speaks.
 *
 * Quick-reply chips send their label VERBATIM — a chip never says one thing and
 * post another.
 */

import { useEffect, useMemo, useRef, useState } from 'react'

import { useCockpit, incidentResponderId } from '../state/CockpitContext'
import { resolveMediaUrl } from '../lib/api'
import { distanceKm, responderPosition, villageById } from '../lib/geography'
import {
  availabilityMeta,
  formatClock,
  humaniseFlag,
  outcomeLabel,
} from '../lib/urdu'
import type { AvailabilityStatus, IncidentRecord, Responder } from '../lib/types'
import { useSpeechToText } from '../hooks/useSpeechToText'
import { SituationMap } from '../components/SituationMap'
import { AccountabilityScorecard } from './BhuView'
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
import { ResponderBackground } from '../components/BackgroundMotifs'


/**
 * Quick-reply chips rendered above the live assistant input.
 */
const QUICK_REPLIES: {
  id: string
  label_ur: string
  label_en: string
  transcript: string
  tone: 'mint' | 'critical'
}[] = [
  {
    id: 'bleeding-not-stopping',
    label_ur: 'خون نہیں رک رہا',
    label_en: 'Bleeding not stopping',
    transcript: 'خون نہیں رک رہا',
    tone: 'critical',
  },
  {
    id: 'pulse-weakening',
    label_ur: 'نبض مدہم ہو رہی ہے',
    label_en: 'Pulse weakening',
    transcript: 'نبض مدہم ہو رہی ہے',
    tone: 'critical',
  },
  {
    id: 'losing-consciousness',
    label_ur: 'مریض بے ہوش ہو رہا ہے',
    label_en: 'Patient losing consciousness',
    transcript: 'مریض بے ہوش ہو رہا ہے',
    tone: 'critical',
  },
]

function matchesVillage(rVillage: string | undefined | null, targetVillage: string | undefined | null): boolean {
  if (!rVillage || !targetVillage) return false
  const rNorm = rVillage.toLowerCase().replace(/[\s-_]+/g, '')
  const tNorm = targetVillage.toLowerCase().replace(/[\s-_]+/g, '')
  if (rNorm === tNorm) return true

  const geo = villageById(targetVillage)
  if (geo) {
    if (rNorm === geo.village_id.toLowerCase().replace(/[\s-_]+/g, '')) return true
    if (rNorm === geo.label_en.toLowerCase().replace(/[\s-_]+/g, '')) return true
  }
  return false
}

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
    setResponderDutyStatus,
    adoptIncident,
    selectedVillage,
    activeResponderId,
    setActiveResponderId,
  } = useCockpit()

  const [acting, setActing] = useState<'accept' | 'decline' | 'arrived' | null>(null)
  const [activeTab, setActiveTab] = useState<'console' | 'scorecard' | 'history'>('console')
  const [pendingTurn, setPendingTurn] = useState<string | null>(null)
  const [audioSrc, setAudioSrc] = useState<string | null>(null)
  const [audioPlaying, setAudioPlaying] = useState(false)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  /** Index of the bubble whose Urdu audio is currently speaking (server wav or
   * the last-resort browser voice); null while silent. Drives سنیں/روکیں. */
  const [listeningIndex, setListeningIndex] = useState<number | null>(null)
  /** A user gesture asked to play the next committed `audioSrc`. Playback must
   * start only AFTER React commits the new src onto the <audio> element — a
   * play() in the same tick would start the PREVIOUS wav. */
  const wantPlayRef = useRef(false)
  const logRef = useRef<HTMLDivElement | null>(null)
  /** True only between an explicit user send and the bot line answering it. */
  const playNextBotTurnRef = useRef(false)

  const responderId = incidentResponderId(record, lastReport)

  const villageResponders = useMemo(() => {
    if (!selectedVillage) return responders
    const filtered = responders.filter((r) => matchesVillage(r.village, selectedVillage))
    return filtered.length > 0 ? filtered : responders
  }, [responders, selectedVillage])

  const [localResponderId, setLocalResponderId] = useState<string>(
    activeResponderId ?? responderId ?? villageResponders[0]?.responder_id ?? 'RESP-TAM-01',
  )

  const selectedResponderId = activeResponderId ?? localResponderId

  const handleSelectResponder = (id: string) => {
    setLocalResponderId(id)
    setActiveResponderId(id)
  }

  // When incident arrives with assigned responder, lock to that responder
  useEffect(() => {
    if (responderId) {
      setLocalResponderId(responderId)
      setActiveResponderId(responderId)
    }
  }, [responderId, setActiveResponderId])

  // When selectedVillage changes, auto-select first available responder from that newly selected village
  useEffect(() => {
    if (!responderId && villageResponders.length > 0) {
      const isCurrentInVillage = villageResponders.some(
        (r) => r.responder_id === selectedResponderId,
      )
      if (!isCurrentInVillage) {
        const firstAvailable =
          villageResponders.find((r) => r.current_availability_status === 'available')?.responder_id ??
          villageResponders[0]?.responder_id
        if (firstAvailable) {
          setLocalResponderId(firstAvailable)
          setActiveResponderId(firstAvailable)
        }
      }
    }
  }, [selectedVillage, villageResponders, responderId, selectedResponderId, setActiveResponderId])

  const activeResponder =
    responders.find((r) => r.responder_id === selectedResponderId) ?? villageResponders[0] ?? responders[0] ?? null
  const responder = activeResponder
  const village = incident?.gps_location?.village_id
    ? villageById(incident.gps_location.village_id)
    : villageById(activeResponder?.village ?? selectedVillage ?? 'TAMMAN')

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
    // A new bot line supersedes whatever was being spoken.
    if ('speechSynthesis' in window) window.speechSynthesis.cancel()
    setListeningIndex(null)
    const url = resolveMediaUrl(last.audioUrl)
    const gated = playNextBotTurnRef.current
    playNextBotTurnRef.current = false
    if (!url) {
      setAudioSrc(url)
      return
    }
    if (url === audioSrc) {
      // Player already carries this wav — play now if a gesture asked for it.
      if (gated) void audioRef.current?.play().catch(() => setAudioPlaying(false))
      return
    }
    setAudioSrc(url)
    wantPlayRef.current = gated
  }, [botTurns, audioSrc])

  /** Starts playback once React has committed the new src to the <audio>
   *  element; playing in the same tick as setAudioSrc plays the old wav. */
  useEffect(() => {
    if (!wantPlayRef.current || !audioSrc) return
    wantPlayRef.current = false
    void audioRef.current?.play().catch(() => {
      // Autoplay policy refused it — the native controls remain available.
      setAudioPlaying(false)
      setListeningIndex(null)
    })
  }, [audioSrc])

  /**
   * سنیں button — plays the turn's SERVER-RENDERED Urdu wav through the shared
   * player. The browser's own speechSynthesis is only a last-resort fallback
   * for when the backend could not render audio: desktop machines ship no
   * Urdu voice, so its default English voice reads embedded English words and
   * vocalises markdown symbols ("asterisk asterisk") instead of the guidance.
   */
  function toggleListen(
    index: number,
    turn: { audioUrl?: string | null; text: string },
  ) {
    const url = resolveMediaUrl(turn.audioUrl)
    if (url) {
      if ('speechSynthesis' in window) window.speechSynthesis.cancel()
      if (listeningIndex === index && audioRef.current && !audioRef.current.paused) {
        audioRef.current.pause() // onPause clears listeningIndex
        return
      }
      setListeningIndex(index)
      if (url === audioSrc) {
        void audioRef.current?.play().catch(() => setListeningIndex(null))
        return
      }
      wantPlayRef.current = true
      setAudioSrc(url)
      return
    }
    // No server audio (TTS outage): sanitised browser voice, never raw markdown.
    if (!('speechSynthesis' in window)) return
    if (listeningIndex === index) {
      window.speechSynthesis.cancel()
      setListeningIndex(null)
      return
    }
    audioRef.current?.pause()
    window.speechSynthesis.cancel()
    const utterance = new SpeechSynthesisUtterance(speakableText(turn.text))
    utterance.lang = 'ur-PK'
    utterance.rate = 0.95
    utterance.onend = () => setListeningIndex((cur) => (cur === index ? null : cur))
    utterance.onerror = () => setListeningIndex((cur) => (cur === index ? null : cur))
    setListeningIndex(index)
    window.speechSynthesis.speak(utterance)
  }

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

  // -------------------------------------------------------------------------
  // Render — Role-isolated focused card layout
  // -------------------------------------------------------------------------
  const dutyStatus = activeResponder?.current_availability_status ?? 'available'

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-5">
      <ResponderBackground />
      {/* ---------------- Top Duty Availability & Navigation Bar ---------------- */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-800 bg-surface px-5 py-3 text-xs">
        <div className="flex flex-wrap items-center gap-3">
          <select
            aria-label="Responder profile"
            className="field-select max-w-[220px] py-1 text-xs font-medium"
            value={selectedResponderId}
            onChange={(e) => handleSelectResponder(e.target.value)}
          >
            {villageResponders.map((r) => {
              const statusDot =
                r.current_availability_status === 'available'
                  ? '🟢'
                  : r.current_availability_status === 'busy'
                    ? '🟡'
                    : '⚪'
              const statusLabel =
                r.current_availability_status === 'available'
                  ? 'دستیاب'
                  : r.current_availability_status === 'busy'
                    ? 'مصروف'
                    : 'آف لائن'
              return (
                <option key={r.responder_id} value={r.responder_id}>
                  {statusDot} {r.name} ({statusLabel})
                </option>
              )
            })}
          </select>

          <div className="flex items-center gap-1 rounded-full border border-slate-800 bg-sunken p-0.5">
            {(['available', 'busy', 'offline'] as AvailabilityStatus[]).map((st) => {
              const isCur = dutyStatus === st
              return (
                <button
                  key={st}
                  type="button"
                  onClick={() => setResponderDutyStatus(selectedResponderId, st)}
                  className={`rounded-full px-2.5 py-0.5 text-[10px] font-bold uppercase transition-colors ${
                    isCur
                      ? st === 'available'
                        ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                        : st === 'busy'
                          ? 'bg-rose-500/20 text-rose-300 border border-rose-500/40'
                          : 'bg-slate-700 text-slate-300 border border-slate-600'
                      : 'text-ink-muted hover:text-ink'
                  }`}
                >
                  {st}
                </button>
              )
            })}
          </div>
        </div>

        <div className="flex items-center gap-1 rounded-full border border-slate-700 bg-sunken p-1">
          <button
            type="button"
            onClick={() => setActiveTab('console')}
            className={`rounded-full px-3 py-1 text-xs font-semibold transition-colors ${
              activeTab === 'console'
                ? 'bg-accent text-white shadow-sm'
                : 'text-ink-muted hover:text-ink'
            }`}
          >
            {lang === 'ur' ? '⚡ الرٹ و رہنمائی' : '⚡ Alert & Guidance'}
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('scorecard')}
            className={`rounded-full px-3 py-1 text-xs font-semibold transition-colors ${
              activeTab === 'scorecard'
                ? 'bg-accent text-white shadow-sm'
                : 'text-ink-muted hover:text-ink'
            }`}
          >
            {lang === 'ur' ? '📊 کارکردگی' : '📊 Scorecard'}
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
            {lang === 'ur' ? '📜 سابقہ سروس' : '📜 History'}
          </button>
        </div>
      </div>

      {activeTab === 'scorecard' ? (
        <AccountabilityScorecard
          responders={responders}
          defaultResponderId={selectedResponderId}
          refreshKey={incident?.incident_closed_timestamp ?? null}
        />
      ) : activeTab === 'history' ? (
        <ResponderHistoryView
          responderId={selectedResponderId}
          lang={lang}
          onSelectIncident={(id) => {
            adoptIncident(id)
            setActiveTab('console')
          }}
          onBack={() => setActiveTab('console')}
        />
      ) : !incidentId || !incident ? (
        <div className="flex flex-col gap-5">
          {/* Duty Readiness Dashboard Card */}
          <div className="card-panel p-6 sm:p-8 animate-fade-rise">
            <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 pb-5">
              <div>
                <p className="text-xs text-ink-muted">
                  {lang === 'ur' ? 'خوش آمدید' : 'Welcome'}
                </p>
                <h2 className="text-2xl font-extrabold tracking-tight text-ink">
                  {activeResponder?.name ?? 'Responder'}
                </h2>
                <p className="text-xs text-sky-400 font-medium mt-0.5">
                  {village?.label_en ?? 'Local coverage'} · {village?.linked_bhu_id ?? activeResponder?.linked_bhu_id}
                </p>
              </div>

              <span
                className={`inline-flex items-center gap-2 rounded-full border px-3.5 py-1.5 text-xs font-bold ${
                  dutyStatus === 'available'
                    ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-300'
                    : dutyStatus === 'busy'
                      ? 'border-rose-500/40 bg-rose-500/15 text-rose-300'
                      : 'border-slate-700 bg-slate-800 text-slate-400'
                }`}
              >
                <StatusDot tone={dutyStatus === 'available' ? 'mint' : dutyStatus === 'busy' ? 'critical' : 'ash'} pulse={dutyStatus === 'available'} />
                {dutyStatus === 'available'
                  ? (lang === 'ur' ? 'دستیاب — الرٹ تیار' : 'AVAILABLE — Ready on Duty')
                  : dutyStatus === 'busy'
                    ? (lang === 'ur' ? 'مصروف' : 'BUSY')
                    : (lang === 'ur' ? 'آف لائن' : 'OFFLINE')}
              </span>
            </div>

            <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3">
              <div className="well p-4">
                <p className="label">{lang === 'ur' ? 'تصدیق شدہ پوائنٹس' : 'Verified Points'}</p>
                <p className="mt-1 font-mono text-2xl font-extrabold text-emerald-400">
                  {activeResponder?.points_total ?? 0}
                </p>
              </div>
              <div className="well p-4">
                <p className="label">{lang === 'ur' ? 'تصدیقی حیثیت' : 'Verification'}</p>
                <p className="mt-1 text-sm font-bold text-sky-300">
                  {activeResponder?.is_verified ? 'Verified Active' : 'Pending'}
                </p>
              </div>
              <div className="well p-4 col-span-2 sm:col-span-1">
                <p className="label">{lang === 'ur' ? 'تربیت دہندہ ادارہ' : 'Training Org'}</p>
                <p className="mt-1 text-xs font-semibold text-ink-muted truncate">
                  {activeResponder?.training_org ?? 'Red Crescent'}
                </p>
              </div>
            </div>

            <p className="mt-5 text-xs text-ink-dim leading-relaxed">
              {lang === 'ur'
                ? 'جیسے ہی آپ کے گاؤں یا قریبی علاقے سے کوئی ایمرجنسی رپورٹ ہو گی، خودکار آواز اور نقشے کی رہنمائی اسکرین پر ظاہر ہو جائے گی۔'
                : 'As soon as an emergency is reported in your vicinity, this console will alert you with immediate audio and routing instructions.'}
            </p>
          </div>

          <ResponderRoster responders={villageResponders} lang={lang} activeResponderId={selectedResponderId} />
        </div>
      ) : !accepted && !isClosed ? (
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
          title="Live Emergency Assistant Chat"
          titleUr="طبی اے آئی کوپائلٹ"
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
            <SituationMap heightClass="h-[280px] sm:h-[360px]" />
            {/* ---- Response Completed Card (when closed) ---- */}
            {isClosed && (
              <div className="rounded-2xl border border-emerald-500/40 bg-emerald-500/15 p-5 shadow-glow">
                <div className="flex items-center gap-3">
                  <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full border border-emerald-500/50 bg-emerald-500/20 text-xl">
                    ✅
                  </span>
                  <div className="min-w-0 flex-1">
                    <h4 className="text-sm font-bold text-emerald-200">
                      {lang === 'ur' ? 'ایمرجنسی رسپانس کامیابی سے مکمل' : 'Response Completed Successfully'}
                    </h4>
                    <p className="text-[11px] text-emerald-300/80">
                      {lang === 'ur'
                        ? 'مرکزِ صحت نے مریض کی آمد کی تصدیق کر دی ہے۔ آپ کے اکاؤنٹ میں +20 پوائنٹس شامل کر دیے گئے ہیں۔'
                        : 'BHU signed off on patient arrival. +20 verified points credited.'}
                    </p>
                  </div>
                  <span className="font-mono text-xs font-bold text-emerald-300 border border-emerald-500/40 bg-emerald-500/20 px-2.5 py-1 rounded-full">
                    +20 PTS
                  </span>
                </div>
              </div>
            )}

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
                  {audioSrc ? 'Audio instructions ready' : 'Tap play, use speaker icons on bubbles, or ask below'}
                </p>
              </div>
              <audio
                ref={audioRef}
                src={audioSrc ?? undefined}
                controls
                preload="auto"
                className="h-9 max-w-[280px] flex-1"
                onPlay={() => setAudioPlaying(true)}
                onPause={() => {
                  setAudioPlaying(false)
                  setListeningIndex(null)
                }}
                onEnded={() => {
                  setAudioPlaying(false)
                  setListeningIndex(null)
                }}
                onError={() => {
                  setAudioPlaying(false)
                  setListeningIndex(null)
                }}
              />
            </div>

            {/* ---- Conversation log ---- */}
            <div
              ref={logRef}
              className="flex max-h-[420px] min-h-[220px] flex-col gap-3 overflow-y-auto rounded-2xl border border-slate-800 bg-sunken p-4"
            >
              {botTurns.length === 0 ? (
                <div className="m-auto flex flex-col items-center justify-center gap-2 py-8 text-center text-ink-muted">
                  <div className="grid h-12 w-12 place-items-center rounded-2xl border border-slate-700/60 bg-slate-800/40 text-2xl mb-1 shadow-sm">
                    🩺
                  </div>
                  <p dir="rtl" className="font-urdu text-[16px] font-bold leading-8 text-slate-100">
                    طبی اے آئی کوپائلٹ تیار ہے
                  </p>
                  <p dir="rtl" className="font-urdu text-[14px] leading-6 text-slate-300">
                    رہنمائی حاصل کرنے کے لیے نیچے سوال لکھیں، مائیک سے بولیں، یا ایمرجنسی بٹن دبائیں۔
                  </p>
                  <p className="text-xs text-ink-dim">
                    Type a question, speak (🎙️), or tap an emergency chip below to start the conversation.
                  </p>
                </div>
              ) : (
                botTurns.map((t, i) => (
                  <ChatBubble
                    key={i}
                    turn={t}
                    speaking={listeningIndex === i}
                    onToggleSpeech={() => toggleListen(i, t)}
                  />
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
function ResponderHistoryView({
  responderId,
  onSelectIncident,
  onBack,
  lang,
}: {
  responderId: string
  onSelectIncident: (id: string) => void
  onBack: () => void
  lang: 'ur' | 'en'
}) {
  const { fetchIncidents } = useCockpit()
  const [history, setHistory] = useState<IncidentRecord[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetchIncidents({ responder_id: responderId })
      .then((items) => setHistory(items))
      .finally(() => setLoading(false))
  }, [fetchIncidents, responderId])

  return (
    <Card title="Response Service History" titleUr="سروس کی تاریخچہ" panel>
      <div className="flex items-center justify-between border-b border-slate-800 pb-3 mb-4">
        <p className="text-xs text-ink-muted">
          All emergency dispatches assigned to {responderId}
        </p>
        <Pill variant="ghost" size="sm" onClick={onBack}>
          {lang === 'ur' ? '← واپس جائیں' : '← Back'}
        </Pill>
      </div>

      {loading ? (
        <div className="py-10 text-center text-xs text-ink-muted">
          <Spinner /> Loading response records…
        </div>
      ) : history.length === 0 ? (
        <EmptyState
          title="No responses recorded"
          titleUr="کوئی ریکارڈ موجود نہیں"
          message="When this responder accepts and completes incidents, they will appear here."
        />
      ) : (
        <div className="flex flex-col gap-2.5">
          {history.map((rec) => {
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
                      {inc.timestamp_reported ? new Date(inc.timestamp_reported).toLocaleDateString() : ''}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-ink-muted truncate font-urdu" dir="rtl">
                    {inc.voice_transcript || inc.injury_type_flags.join(', ') || 'Incident response'}
                  </p>
                  {inc.outcome && (
                    <p className="mt-1 text-[11px] text-emerald-400 font-medium">
                      Outcome: {lang === 'ur' ? outcomeLabel(inc.outcome).ur : outcomeLabel(inc.outcome).en}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <span
                    className={`px-2.5 py-0.5 text-[10px] font-bold rounded-full ${
                      isClosed
                        ? 'bg-emerald-500/10 text-emerald-300 border border-emerald-500/30'
                        : 'bg-rose-500/10 text-rose-300 border border-rose-500/30'
                    }`}
                  >
                    {isClosed ? 'Resolved' : 'In Progress'}
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

/**
 * Markdown-free, Urdu-only plain text for the last-resort browser voice.
 * The backend already sanitises before TTS; this covers only the offline
 * fallback so even that never vocalises "**" as "asterisk asterisk", never
 * reads parenthetical English glosses, and pauses on Urdu punctuation.
 */
function speakableText(text: string): string {
  return text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`#]+/g, ' ')
    .replace(/[\(\[][^)\]]*[A-Za-z][^)\]]*[\)\]]/g, ' ') // "(apply pressure)" glosses
    .replace(/[A-Za-z]+/g, ' ')                          // any leftover English words
    .replace(/:/g, '۔').replace(/;/g, '،').replace(/\//g, ' یا ')
    .replace(/(^|\n)\s*\d+\.\s*/g, '$1')
    .replace(/۔{2,}/g, '۔')
    .replace(/\s+/g, ' ')
    .trim()
}

function ChatBubble({
  turn,
  speaking,
  onToggleSpeech,
}: {
  turn: {
    speaker: 'responder' | 'bot'
    text: string
    at: number
    intent?: string
    audioUrl?: string | null
    escalated?: boolean
  }
  speaking: boolean
  onToggleSpeech: () => void
}) {
  const mine = turn.speaker === 'responder'

  return (
    <div className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[85%] rounded-2xl border p-3.5 ${
          mine
            ? 'rounded-br-sm border-sky-500/35 bg-sky-500/15'
            : turn.escalated
              ? 'rounded-bl-sm border-rose-500/45 bg-rose-500/12 shadow-rose'
              : 'rounded-bl-sm border-slate-700 bg-slate-800'
        }`}
      >
        <div className="flex items-center justify-between gap-2 mb-1.5">
          <p
            className={`text-[10px] font-bold uppercase tracking-wider ${
              mine ? 'text-sky-300/80' : turn.escalated ? 'text-rose-300/80' : 'text-ink-dim'
            }`}
          >
            {mine ? 'You (آپ)' : 'Clinical Copilot (طبی اے آئی کوپائلٹ)'}
            {turn.escalated ? ' · ESCALATION' : ''}
            <span
              className={`ml-2 font-mono font-normal normal-case ${
                mine ? 'text-sky-400/50' : 'text-ink-dim/70'
              }`}
            >
              {formatClock(new Date(turn.at).toISOString())}
            </span>
          </p>

          {!mine && (
            <button
              type="button"
              onClick={onToggleSpeech}
              className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium transition-colors ${
                speaking
                  ? 'bg-rose-500/20 text-rose-300 border border-rose-500/40 animate-pulse'
                  : 'bg-slate-700/80 text-sky-300 hover:bg-slate-700 border border-slate-600'
              }`}
              title={speaking ? 'Stop audio' : 'Listen hands-free in Urdu'}
            >
              <span>{speaking ? '⏹️' : '🔊'}</span>
              <span dir="rtl" className="font-urdu text-[11px]">
                {speaking ? 'روکیں' : 'سنیں'}
              </span>
            </button>
          )}
        </div>

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
      {/* 3 Quick-Tap Emergency Situational Chips */}
      <div className="flex flex-wrap gap-2 pb-3">
        {QUICK_REPLIES.map((q) => (
          <button
            key={q.id}
            type="button"
            disabled={sending}
            onClick={() => send(q.transcript)}
            className="pill px-3.5 py-2 text-xs font-semibold transition-all disabled:cursor-not-allowed disabled:opacity-45 border border-rose-500/40 bg-rose-500/10 text-rose-200 hover:bg-rose-500/20 shadow-sm"
            title={`Sends: ${q.transcript}`}
          >
            <span dir="rtl" className="font-urdu text-[14px] leading-6">
              {q.label_ur}
            </span>
            <span className="opacity-75 font-normal ml-1">({q.label_en})</span>
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
          placeholder="کوئی بھی سوال پوچھیں یا رہنمائی لیں... (Ask any question or get guidance...)"
          className="field min-w-[200px] flex-1 font-urdu text-[15px] leading-7"
          aria-label="Responder Urdu question input"
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

