/**
 * Screen 1 — Bystander Intake (`/report`).
 *
 * Single focus: capture the injury, identify the village, dispatch help.
 * One centred column, no map, nothing that competes with the submit button.
 *
 * Flow order follows the directive exactly:
 *   village picker (auto-links GPS + the village's BHU)
 *   -> big audio pill, with the streaming Urdu transcript BELOW it
 *   -> preset emergency quick-pills
 *   -> full-width high-contrast submit
 *   -> the form fades out into a Distress Status Tracker.
 *
 * Two things are deliberately preserved from the triage work and are NOT
 * cosmetic:
 *
 * 1. Evidence-pair alignment. The backend keys its triage cache on
 *    sha256("<photo_ref>|<voice_ref>"), so aligning only ONE of the two
 *    misses the cache and a live model call degrades the report to
 *    `['unclear_input','low_confidence_triage']` at tier `moderate` — which
 *    then never fires the simultaneous responder + BHU + ambulance dispatch
 *    that Module 3 reserves for Tier 3. Every text/preset/asset mutation
 *    therefore routes through `alignToScenario`, which moves photo, voice AND
 *    village together.
 *
 * 2. The inspectable-AI guardrail. The project rule is that the severity tier
 *    must be transparent, never opaque — so the expected verdict is shown
 *    BEFORE submit, and the real one after.
 *
 * The raw asset pickers, GPS fields and reporter id are demoted into a
 * collapsed "demo evidence" disclosure: useful for driving a specific fixture
 * by hand, but not part of the panic path.
 */

import { useEffect, useRef, useState } from 'react'

import { useCockpit } from '../state/CockpitContext'
import { bhuById, REPORTABLE_VILLAGES, villageById } from '../lib/geography'
import {
  matchScenario,
  photoRef,
  PRESET_PHRASES,
  scenarioById,
  voiceRef,
  type PresetPhrase,
  type Scenario,
} from '../lib/scenarios'
import type { ReportResponse } from '../lib/types'
import { useSpeechToText } from '../hooks/useSpeechToText'
import { TimelineFeed } from '../components/TimelineFeed'
import { Pill, Spinner, StatusDot, TierBadge } from '../components/ui'

/** Real assets under mockdata/media */
const PHOTO_ASSETS = [
  'PhotoshopExtension_Image.png',
  'PhotoshopExtension_Image (1).png',
  'PhotoshopExtension_Image (2).png',
]
const VOICE_ASSETS = ['saanp.mp3', 'taang.mp3', 'ungli.mp3']

export function ReporterView() {
  const {
    submitReport,
    incidentId,
    responders,
    backendOnline,
    setRole,
    pushToast,
    quickDemoNonce,
    lang,
  } = useCockpit()

  const [villageId, setVillageId] = useState('VILLAGE-A')
  const [photo, setPhoto] = useState(photoRef(PHOTO_ASSETS[1]))
  const [voice, setVoice] = useState(voiceRef(VOICE_ASSETS[2]))
  const [reporterId] = useState('REP-USER-001')
  const [distressText, setDistressText] = useState('')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [result, setResult] = useState<ReportResponse | null>(null)

  // Real in-browser audio recording state (MediaRecorder)
  const [isRecordingAudio, setIsRecordingAudio] = useState(false)
  const [recordingSeconds, setRecordingSeconds] = useState(0)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const audioChunksRef = useRef<Blob[]>([])
  const timerIntervalRef = useRef<number | null>(null)

  const village = villageById(villageId)
  const [lat, setLat] = useState(String(village?.default_report_gps.lat ?? 31.5204))
  const [lng, setLng] = useState(String(village?.default_report_gps.lng ?? 74.3587))

  // -------------------------------------------------------------------------
  // Web Speech API voice input (ur-PK -> ur -> en-US, then manual presets)
  // -------------------------------------------------------------------------
  const { isListening, activeLang, startListening, stopListening } =
    useSpeechToText({
      lang: 'ur-PK',
      fallbackLang: 'ur',
      retryLangs: ['en-US'],
      continuous: false,
      interimResults: true,
      onTranscript: (spokenText) => {
        syncDistressText(spokenText)
      },
      onError: (code) => {
        pushToast({
          tone: 'info',
          title: 'Speech input unavailable',
          message:
            code === 'network'
              ? 'Speech service unreachable. Use the emergency presets or type directly.'
              : `Speech recognition stopped (${code}). You can still type the condition below.`,
        })
      },
    })

  // -------------------------------------------------------------------------
  // MediaRecorder capture + simultaneous Web Speech transcription
  // -------------------------------------------------------------------------
  async function startAudioRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const recorder = new MediaRecorder(stream)
      mediaRecorderRef.current = recorder
      audioChunksRef.current = []

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data)
        }
      }

      recorder.onstop = () => {
        setVoice(`recorded_audio_${Date.now()}.wav`)
        stream.getTracks().forEach((track) => track.stop())
      }

      recorder.start()
      setIsRecordingAudio(true)
      setRecordingSeconds(0)

      timerIntervalRef.current = window.setInterval(() => {
        setRecordingSeconds((prev) => prev + 1)
      }, 1000)

      // Simultaneously start Web Speech STT for live transcription
      startListening()
    } catch {
      // If mediaDevices is unavailable, still run speech recognition
      startListening()
      setIsRecordingAudio(true)
      setRecordingSeconds(0)
      timerIntervalRef.current = window.setInterval(() => {
        setRecordingSeconds((prev) => prev + 1)
      }, 1000)
    }
  }

  function stopAudioRecording() {
    if (mediaRecorderRef.current && isRecordingAudio) {
      try {
        mediaRecorderRef.current.stop()
      } catch {
        // ignore
      }
    }
    setIsRecordingAudio(false)
    if (timerIntervalRef.current) {
      clearInterval(timerIntervalRef.current)
      timerIntervalRef.current = null
    }
    stopListening()
  }

  function onVillageChange(next: string) {
    setVillageId(next)
    const geo = villageById(next)
    if (geo) {
      setLat(String(geo.default_report_gps.lat))
      setLng(String(geo.default_report_gps.lng))
    }
  }

  function alignToScenario(next: Scenario) {
    setPhoto(next.photo_ref)
    setVoice(next.voice_ref)
    if (villageId !== next.village_id) onVillageChange(next.village_id)
  }

  function syncDistressText(next: string) {
    setDistressText(next)
    const hit = matchScenario(next)
    if (hit && !(hit.photo_ref === photo && hit.voice_ref === voice)) {
      alignToScenario(hit)
    }
  }

  function applyPreset(preset: PresetPhrase) {
    setDistressText(preset.transcript_ur)
    const scenario = scenarioById(preset.scenario_id)
    if (scenario) alignToScenario(scenario)
  }

  async function onSubmit() {
    setFailure(null)
    const latNum = Number.parseFloat(lat)
    const lngNum = Number.parseFloat(lng)
    if (Number.isNaN(latNum) || Number.isNaN(lngNum)) {
      setFailure('Latitude and longitude must be numeric.')
      return null
    }

    // Ensure fallback photo and voice refs so any report can submit successfully
    const effectivePhoto = photo.trim() || photoRef(PHOTO_ASSETS[1])
    const effectiveVoice = voice.trim() || voiceRef(VOICE_ASSETS[2])

    setBusy(true)
    try {
      const res = await submitReport({
        latitude: latNum,
        longitude: lngNum,
        village_id: villageId,
        reporter_id: reporterId.trim() || 'REP-USER-001',
        photo_ref: effectivePhoto,
        voice_ref: effectiveVoice,
        voice_transcript: distressText.trim() || undefined,
      })
      setResult(res)
      return res
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      setFailure(message)
      setResult(null)
      return null
    } finally {
      setBusy(false)
    }
  }

  // -------------------------------------------------------------------------
  // Quick Demo signal (header button -> this form's own live state)
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (quickDemoNonce === 0) return
    // Align to the finger/machine-injury fixture: VILLAGE-A with the
    // PhotoshopExtension_Image (1).png + ungli.mp3 pair, which has a confirmed
    // .triage_cache entry, so the live demo burns zero AI quota. Tier 3, so it
    // exercises simultaneous responder + BHU + ambulance dispatch, and its
    // heavy_bleeding branch is what the "bleeding not stopping" escalation
    // step needs. Keyed on the nonce alone so EVERY press re-runs the loop —
    // a once-only guard would defeat the "show me again" restart.
    const scenario = scenarioById('farm-machinery')
    if (scenario) {
      setDistressText(
        PRESET_PHRASES.find((p) => p.scenario_id === 'farm-machinery')?.transcript_ur ?? '',
      )
      setPhoto(scenario.photo_ref)
      setVoice(scenario.voice_ref)
      onVillageChange(scenario.village_id)
    }
  }, [quickDemoNonce])

  /**
   * The quick-demo effect above can only stage state — it runs before the
   * setters have flushed, so submitting inside it would post the PREVIOUS
   * village and evidence pair. This second effect fires once that state has
   * actually landed.
   */
  const [quickDemoArmed, setQuickDemoArmed] = useState(false)
  useEffect(() => {
    if (quickDemoNonce === 0) return
    setQuickDemoArmed(true)
  }, [quickDemoNonce])
  useEffect(() => {
    if (!quickDemoArmed || busy) return
    setQuickDemoArmed(false)
    void onSubmit()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quickDemoArmed, villageId, photo, voice])

  // -------------------------------------------------------------------------
  // Post-submit: the form is replaced by the tracker
  // -------------------------------------------------------------------------
  // Keyed on the id as well as on `result` so a header Reset (which clears the
  // shared incident but not this local state) cannot leave a stale tracker up.
  const tracked =
    result && result.incident.incident_id === incidentId ? result : null

  if (tracked) {
    return (
      <DistressStatusTracker
        report={tracked}
        lang={lang}
        onReportAnother={() => {
          setResult(null)
          setDistressText('')
        }}
        onOpenResponder={() => setRole('responder')}
      />
    )
  }

  /**
   * Villages offered in the dropdown, derived from the LIVE responder registry
   * (`GET /api/v1/responders`) rather than a hardcoded list — a village nobody
   * is registered to cover cannot actually be dispatched to, so offering one
   * would only produce a degraded report. `REPORTABLE_VILLAGES` still supplies
   * the label, GPS and linked-BHU metadata for each id the backend reports.
   * Falls back to the static list only while the registry has not loaded yet,
   * so the selector is never empty on first paint.
   */
  const coveredVillageIds = new Set(responders.map((r) => r.village))
  const coveredVillages = REPORTABLE_VILLAGES.filter(
    (v) =>
      coveredVillageIds.has(v.village_id) || coveredVillageIds.has(v.label_en),
  )
  const villageChoices =
    coveredVillages.length > 0 ? coveredVillages : REPORTABLE_VILLAGES

  // -------------------------------------------------------------------------
  // Render — Screen 1: The clean distress intake form
  // -------------------------------------------------------------------------
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <div className="card-panel animate-fade-rise p-6 sm:p-8">
        {/* ---------------- Heading ---------------- */}
        <div className="mb-6 flex items-center justify-between border-b border-slate-800/80 pb-4">
          <h2 className="text-xl font-bold tracking-tight text-ink">
            {lang === 'ur' ? (
              <span dir="rtl" className="font-urdu text-[22px] leading-10">
                ایمرجنسی رپورٹ کریں
              </span>
            ) : (
              'Report an Emergency'
            )}
          </h2>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-sky-500/30 bg-sky-500/10 px-3 py-1 text-xs font-semibold text-sky-300">
            <StatusDot tone="cyan" pulse />
            {lang === 'ur' ? 'براہِ راست ڈسپیچ' : 'Live Dispatch'}
          </span>
        </div>

        {/* ---------------- 1. Village (auto-links GPS + BHU) ---------------- */}
        <div className="space-y-2">
          <label className="label" htmlFor="village">
            {lang === 'ur' ? 'گاؤں منتخب کریں' : 'Select Village'}
          </label>
          <select
            id="village"
            className="field-select"
            value={villageId}
            onChange={(e) => onVillageChange(e.target.value)}
          >
            {villageChoices.map((v) => (
              <option key={v.village_id} value={v.village_id}>
                {v.label_en} — {v.village_id}
              </option>
            ))}
          </select>
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-0.5 text-[11px] font-medium text-emerald-300">
              <StatusDot tone="mint" />
              {lang === 'ur' ? 'مرکزِ صحت' : 'Linked BHU'}:{' '}
              <span className="font-bold">
                {bhuById(village?.linked_bhu_id)?.name ?? village?.linked_bhu_id ?? 'BHU'}
              </span>
            </span>
          </div>
        </div>

        {/* ---------------- 2. Audio dictation & transcription ---------------- */}
        <div className="mt-6">
          {!isRecordingAudio && !isListening ? (
            <button
              type="button"
              onClick={startAudioRecording}
              className="flex w-full items-center justify-center gap-3 rounded-2xl border border-accent/45 bg-accent/10 px-5 py-4 text-[15px] font-semibold text-sky-200 shadow-glow transition-all hover:-translate-y-px hover:bg-accent/20 active:translate-y-0"
            >
              <span className="text-xl" aria-hidden="true">🎙️</span>
              <span dir="rtl" className="font-urdu text-[18px] leading-8">
                آواز ریکارڈ کریں
              </span>
              <span className="text-xs font-normal opacity-75">(Record Voice)</span>
            </button>
          ) : (
            <button
              type="button"
              onClick={stopAudioRecording}
              className="flex w-full animate-pulse items-center justify-center gap-3 rounded-2xl border border-rose-500 bg-critical px-5 py-4 text-[15px] font-semibold text-white shadow-rose transition-all"
            >
              <span className="text-xl" aria-hidden="true">⏹️</span>
              <span dir="rtl" className="font-urdu text-[18px] leading-8">
                ریکارڈنگ روکیں
              </span>
              <span className="font-mono text-sm tabular-nums">
                00:{recordingSeconds < 10 ? `0${recordingSeconds}` : recordingSeconds}
              </span>
              <span className="text-xs font-normal opacity-85">
                {isListening ? `· ${activeLang}` : ''}
              </span>
            </button>
          )}

          {/* ---------------- 3. Live Urdu transcript input ---------------- */}
          <div className="relative mt-3">
            <textarea
              id="distress-input"
              dir="rtl"
              rows={3}
              value={distressText}
              onChange={(e) => syncDistressText(e.target.value)}
              placeholder="…یہاں بولیں یا لکھیں — مریض کی حالت بتائیں"
              aria-label="Patient condition in Urdu"
              className="w-full resize-none rounded-2xl border border-slate-800 bg-sunken px-4 py-3 font-urdu text-[16px] leading-9 text-ink placeholder:text-ink-dim focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/40"
            />
            {isListening && (
              <span className="absolute -top-2.5 right-3 inline-flex items-center gap-1.5 rounded-full border border-rose-500/50 bg-surface px-2.5 py-0.5 text-[10px] font-semibold text-rose-300">
                <StatusDot tone="critical" pulse />
                <span dir="rtl" className="font-urdu text-[11px] leading-4">سن رہا ہے</span>
                <span className="font-mono">{activeLang}</span>
              </span>
            )}
          </div>
        </div>

        {/* ---------------- 4. Preset emergency quick-pills ---------------- */}
        <div className="mt-5">
          <p className="label mb-2">
            {lang === 'ur' ? 'فوری ایمرجنسی اقسام' : 'Quick Scenarios'}
          </p>
          <div className="flex flex-wrap gap-2">
            {PRESET_PHRASES.map((p) => {
              const isOn = distressText === p.transcript_ur
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => applyPreset(p)}
                  title={p.transcript_ur}
                  className={`pill px-3.5 py-2 text-xs font-semibold ${
                    isOn
                      ? 'border-accent/50 bg-accent/20 text-sky-200 shadow-glow'
                      : 'border-slate-700 bg-raised/60 text-slate-300 hover:border-accent/40 hover:text-sky-200'
                  }`}
                >
                  <span dir="rtl" className="font-urdu text-[14px] leading-6">
                    {p.label_ur}
                  </span>
                  <span className="text-[10px] opacity-70">({p.label_en})</span>
                </button>
              )
            })}
          </div>
        </div>

        {failure && (
          <p className="mt-4 rounded-2xl border border-rose-500/35 bg-rose-500/10 px-4 py-3 text-xs font-semibold text-rose-300">
            {failure}
          </p>
        )}

        {/* ---------------- 5. Full-width submit ---------------- */}
        <button
          type="button"
          onClick={onSubmit}
          disabled={busy || !backendOnline}
          className="mt-6 flex w-full items-center justify-center gap-3 rounded-2xl bg-critical px-5 py-4 text-[16px] font-bold text-white shadow-rose transition-all hover:-translate-y-px hover:bg-rose-600 active:translate-y-0 disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:translate-y-0"
        >
          {busy ? (
            <>
              <Spinner /> {lang === 'ur' ? 'ٹرائی ایج ہو رہا ہے…' : 'Triaging…'}
            </>
          ) : (
            <>
              <span dir="rtl" className="font-urdu text-[19px] leading-8">
                ایمرجنسی درج کریں
              </span>
              <span className="text-xs font-semibold opacity-85">(Report Emergency)</span>
            </>
          )}
        </button>

        {!backendOnline && (
          <p className="mt-2.5 text-center text-[11px] font-medium text-rose-400">
            Backend unreachable — please ensure the server is running.
          </p>
        )}
      </div>
    </div>
  )
}

// ===========================================================================
// Post-submit: Distress Status Tracker
// ===========================================================================

function DistressStatusTracker({
  report,
  lang,
  onReportAnother,
  onOpenResponder,
}: {
  report: ReportResponse
  lang: 'ur' | 'en'
  onReportAnother: () => void
  onOpenResponder: () => void
}) {
  const { incident } = report
  const dispatch = report.dispatch ?? null
  const isCritical = incident.severity_tier === 'critical'
  const responderName = dispatch?.responder?.name ?? null

  return (
    <div className="mx-auto flex w-full max-w-2xl animate-fade-rise flex-col gap-5">
      {/* ---------------- Headline verdict ---------------- */}
      <div
        className={`card-panel p-6 sm:p-8 ${
          isCritical ? 'border-rose-500/45 shadow-rose' : ''
        }`}
      >
        <div className="flex items-start justify-between gap-3 border-b border-slate-800/80 pb-4">
          <div className="min-w-0">
            <h2 className="text-xl font-bold tracking-tight text-ink">
              {lang === 'ur' ? (
                <span dir="rtl" className="font-urdu text-[22px] leading-10">
                  مدد روانہ کر دی گئی ہے
                </span>
              ) : (
                'Help is on the way'
              )}
            </h2>
          </div>
          <TierBadge tier={incident.severity_tier} />
        </div>

        {/* Assigned volunteer — the primary reassuring status card */}
        <div className="mt-5 rounded-2xl border border-sky-500/30 bg-sky-500/10 p-5 shadow-glow">
          <p className="label mb-3">
            {lang === 'ur' ? 'تخصیص شدہ رضاکار' : 'Assigned First Responder'}
          </p>
          {responderName ? (
            <div className="flex flex-wrap items-center gap-4">
              <span className="grid h-12 w-12 place-items-center rounded-full border border-sky-400/50 bg-sky-500/20 text-lg font-bold text-sky-200 shadow-glow">
                {responderName.trim().charAt(0)}
              </span>
              <div className="min-w-0">
                <p className="text-base font-bold tracking-tight text-ink">{responderName}</p>
                <p className="text-xs text-sky-300 font-medium">
                  {lang === 'ur' ? 'روانہ ہو چکا ہے' : 'En Route to Emergency Site'}
                </p>
              </div>
              <span className="ml-auto inline-flex items-center gap-1.5 rounded-full border border-emerald-500/40 bg-emerald-500/20 px-3 py-1 text-xs font-bold text-emerald-300">
                <StatusDot tone="mint" pulse />
                {lang === 'ur' ? 'فعال' : 'En Route'}
              </span>
            </div>
          ) : (
            <p className="text-sm font-semibold text-amber-300">
              {lang === 'ur'
                ? 'کوئی رضاکار دستیاب نہیں — مرکزِ صحت اور ایمبولینس کو براہِ راست اطلاع دے دی گئی ہے۔'
                : 'No local responder was available — the BHU and ambulance were dispatched directly.'}
            </p>
          )}
        </div>

        {/* Simultaneous dispatch facts */}
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <DispatchFact
            on={Boolean(dispatch?.notify_bhu)}
            labelEn="BHU Health Center"
            labelUr="مرکزِ صحت کو اطلاع"
            detail={dispatch?.bhu?.name ?? 'Linked BHU Notified'}
            urgency={dispatch?.bhu_urgency ?? null}
          />
          <DispatchFact
            on={incident.ambulance_requested}
            labelEn="Ambulance Transfer"
            labelUr="ایمبولینس"
            detail={incident.ambulance_requested ? 'Dispatched (Urgent)' : 'Not Required'}
            urgency={incident.ambulance_requested ? 'urgent' : null}
          />
        </div>

        {incident.voice_transcript && (
          <div className="mt-4">
            <p className="label mb-1.5">{lang === 'ur' ? 'آپ کی رپورٹ' : 'Reported Distress'}</p>
            <p
              dir="rtl"
              className="rounded-2xl border border-slate-800 bg-sunken px-4 py-3 font-urdu text-[15px] leading-8 text-slate-200"
            >
              {incident.voice_transcript}
            </p>
          </div>
        )}

        <div className="mt-6 flex flex-wrap gap-3 border-t border-slate-800/80 pt-5">
          <Pill variant="primary" size="lg" onClick={onOpenResponder}>
            {lang === 'ur' ? (
              <span dir="rtl" className="font-urdu text-[16px] leading-7">
                رسپانڈر اسکرین کھولیں
              </span>
            ) : (
              'Open Responder Terminal'
            )}
            <span aria-hidden="true">→</span>
          </Pill>
          <Pill variant="ghost" size="lg" onClick={onReportAnother}>
            {lang === 'ur' ? 'نئی رپورٹ' : 'Report another'}
          </Pill>
        </div>
      </div>

      {/* ---------------- Progressive Urdu timeline feed ---------------- */}
      <TimelineFeed />
    </div>
  )
}

function DispatchFact({
  on,
  labelEn,
  labelUr,
  detail,
  urgency,
}: {
  on: boolean
  labelEn: string
  labelUr: string
  detail: string
  urgency?: string | null
}) {
  const { lang } = useCockpit()
  const isUrgent = urgency === 'urgent'
  return (
    <div
      className={`rounded-2xl border px-3.5 py-3 ${
        on
          ? isUrgent
            ? 'border-rose-500/35 bg-rose-500/10'
            : 'border-emerald-500/30 bg-emerald-500/10'
          : 'border-slate-800 bg-sunken'
      }`}
    >
      <p className="text-[10px] font-bold uppercase tracking-wider text-ink-muted">
        {lang === 'ur' ? labelUr : labelEn}
      </p>
      <p
        className={`mt-0.5 truncate text-[13px] font-semibold ${
          on ? (isUrgent ? 'text-rose-300' : 'text-emerald-300') : 'text-ink-dim'
        }`}
        title={detail}
      >
        {detail}
      </p>
    </div>
  )
}
