/**
 * View 1 — Reporter View (Urdu distress reporting & AI Triage).
 *
 * Streamlined ingestion with Web Speech STT voice input, real-time MediaRecorder
 * audio capture, clean empty placeholders, and high-contrast inverted white card surfaces.
 */

import { useRef, useState } from 'react'

import { useCockpit } from '../state/CockpitContext'
import {
  REPORTABLE_VILLAGES,
  villageById,
  VILLAGES,
} from '../lib/geography'
import { photoRef, voiceRef } from '../lib/scenarios'
import { humaniseFlag, tierMeta } from '../lib/urdu'
import type { ReportResponse } from '../lib/types'
import { API_BASE } from '../lib/api'
import { useSpeechToText } from '../hooks/useSpeechToText'
import {
  Card,
  EmptyState,
  ErrorNote,
  Pill,
  Spinner,
  Tag,
  TierBadge,
} from '../components/ui'

/** Real assets under mockdata/media */
const PHOTO_ASSETS = [
  'PhotoshopExtension_Image.png',
  'PhotoshopExtension_Image (1).png',
  'PhotoshopExtension_Image (2).png',
]
const VOICE_ASSETS = ['saanp.mp3', 'taang.mp3', 'ungli.mp3']

export function ReporterView() {
  const { submitReport, incident, lastReport, backendOnline, setRole } = useCockpit()

  const [villageId, setVillageId] = useState('VILLAGE-A')
  const [photo, setPhoto] = useState(photoRef(PHOTO_ASSETS[1]))
  const [voice, setVoice] = useState(voiceRef(VOICE_ASSETS[2]))
  const [photoPreview, setPhotoPreview] = useState<string | null>(null)
  const [voicePreview, setVoicePreview] = useState<string | null>(null)
  const [reporterId, setReporterId] = useState('REP-USER-001')
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
  // Web Speech API Voice Input (Urdu PK / UR fallback)
  // -------------------------------------------------------------------------
  const { isListening, isSupported, toggleListening } = useSpeechToText({
    lang: 'ur-PK',
    fallbackLang: 'ur',
    onTranscript: (spokenText) => {
      setDistressText(spokenText)
      // Pick appropriate voice ref asset based on spoken keywords if relevant
      if (spokenText.includes('سانپ') || spokenText.includes('کاٹا') || spokenText.includes('ڈس')) {
        setVoice(voiceRef('saanp.mp3'))
      } else if (spokenText.includes('ٹانگ') || spokenText.includes('ہڈی') || spokenText.includes('ٹوٹ')) {
        setVoice(voiceRef('taang.mp3'))
      } else if (spokenText.includes('انگلی') || spokenText.includes('زخم') || spokenText.includes('کٹ')) {
        setVoice(voiceRef('ungli.mp3'))
      }
    },
  })

  // -------------------------------------------------------------------------
  // MediaRecorder Real Audio Capture
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
        const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/wav' })
        const audioUrl = URL.createObjectURL(audioBlob)
        setVoicePreview(audioUrl)
        setVoice(`recorded_audio_${Date.now()}.wav`)
        stream.getTracks().forEach((track) => track.stop())
      }

      recorder.start()
      setIsRecordingAudio(true)
      setRecordingSeconds(0)

      timerIntervalRef.current = window.setInterval(() => {
        setRecordingSeconds((prev) => prev + 1)
      }, 1000)
    } catch (err) {
      setFailure('Microphone access denied or unavailable for audio recording.')
    }
  }

  function stopAudioRecording() {
    if (mediaRecorderRef.current && isRecordingAudio) {
      mediaRecorderRef.current.stop()
      setIsRecordingAudio(false)
      if (timerIntervalRef.current) {
        clearInterval(timerIntervalRef.current)
        timerIntervalRef.current = null
      }
    }
  }

  function onVillageChange(next: string) {
    setVillageId(next)
    const geo = villageById(next)
    if (geo) {
      setLat(String(geo.default_report_gps.lat))
      setLng(String(geo.default_report_gps.lng))
    }
  }

  async function onSubmit() {
    setFailure(null)
    const latNum = Number.parseFloat(lat)
    const lngNum = Number.parseFloat(lng)
    if (Number.isNaN(latNum) || Number.isNaN(lngNum)) {
      setFailure('Latitude and longitude must be numeric.')
      return
    }
    if (!photo.trim() || !voice.trim()) {
      setFailure('Both a photo ref and a voice ref are required for triage.')
      return
    }

    setBusy(true)
    try {
      const res = await submitReport({
        latitude: latNum,
        longitude: lngNum,
        village_id: villageId,
        reporter_id: reporterId.trim() || 'REP-USER-001',
        photo_ref: photo.trim(),
        voice_ref: voice.trim(),
        voice_transcript: distressText.trim() || undefined,
      })
      setResult(res)
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      setFailure(message)
      setResult(null)
    } finally {
      setBusy(false)
    }
  }

  const shownIncident = result?.incident ?? incident
  const shownDispatch = result?.dispatch ?? null
  const meta = tierMeta(shownIncident?.severity_tier ?? null)

  return (
    <div className="flex flex-col gap-4">
      {/* ---------------- Ingestion form ---------------- */}
      <Card
        title="Distress Emergency Report"
        titleUr="ایمرجنسی رپورٹ درج کریں"
        subtitle="Voice speech-to-text and injury photo ingestion for rapid AI Triage & Dispatch."
        panel
      >
        <div className="grid gap-5 lg:grid-cols-2">
          {/* Spoken / Written Distress Voice Description with Web Speech API */}
          <div className="flex flex-col gap-2.5 lg:col-span-2 rounded-2xl border border-slate-200 bg-slate-50/70 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <label className="text-xs font-bold uppercase tracking-wider text-slate-700" htmlFor="distress-input">
                🎙️ Patient Condition / Voice Distress Note (مریض کی صورتحال)
              </label>
              {isSupported && (
                <button
                  type="button"
                  onClick={toggleListening}
                  className={`pill px-4 py-2 text-xs font-semibold transition-all ${
                    isListening
                      ? 'bg-rose-600 hover:bg-rose-700 text-white animate-pulse border-2 border-rose-400 shadow-md ring-2 ring-rose-300'
                      : 'bg-sky-600 hover:bg-sky-700 text-white shadow-sm'
                  }`}
                >
                  <span className="text-sm">{isListening ? '🛑' : '🎙️'}</span>
                  <span>{isListening ? '🛑 سن رہا ہے... (Listening - Click to Stop)' : '🎙️ بولیں (Speak)'}</span>
                </button>
              )}
            </div>

            <div className="relative">
              <textarea
                id="distress-input"
                dir="rtl"
                rows={2}
                value={distressText}
                onChange={(e) => setDistressText(e.target.value)}
                placeholder=""
                className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-2.5 font-urdu text-[15px] leading-7 text-slate-900 focus:border-clinical-cyan focus:outline-none focus:ring-1 focus:ring-clinical-cyan"
                aria-label="Distress voice transcript input"
              />
            </div>
            <p className="text-[11px] text-slate-500">
              Click <strong className="text-slate-700">"بولیں (Speak)"</strong> to dictate in Urdu via speech recognition, or type directly into the box.
            </p>
          </div>

          {/* Photo evidence */}
          <div className="flex flex-col gap-2 rounded-2xl border border-slate-200 bg-slate-50/50 p-3.5">
            <label className="label" htmlFor="photo-asset">
              Patient photo evidence
            </label>
            <select
              id="photo-asset"
              className="field-select"
              value={PHOTO_ASSETS.includes(basename(photo)) ? basename(photo) : ''}
              onChange={(e) => {
                if (e.target.value) {
                  setPhoto(photoRef(e.target.value))
                  setPhotoPreview(null)
                }
              }}
            >
              <option value="">— choose a mockdata asset —</option>
              {PHOTO_ASSETS.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>

            <label className="pill-ghost cursor-pointer px-3.5 py-2 text-xs">
              <UploadIcon />
              Upload photo from device…
              <input
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  if (!f) return
                  setPhoto(f.name)
                  setPhotoPreview(URL.createObjectURL(f))
                }}
              />
            </label>

            {photoPreview ? (
              <img
                src={photoPreview}
                alt="Selected patient photo preview"
                className="h-28 w-full rounded-card border border-slate-200 object-cover"
              />
            ) : (
              <p className="truncate font-mono text-[10px] text-slate-400" title={photo}>
                ref: {photo}
              </p>
            )}
          </div>

          {/* Voice note asset with Live Recording & Upload */}
          <div className="flex flex-col gap-2 rounded-2xl border border-slate-200 bg-slate-50/50 p-3.5">
            <label className="label" htmlFor="voice-asset">
              Urdu voice note audio
            </label>
            <select
              id="voice-asset"
              className="field-select"
              value={VOICE_ASSETS.includes(basename(voice)) ? basename(voice) : ''}
              onChange={(e) => {
                if (e.target.value) {
                  setVoice(voiceRef(e.target.value))
                  setVoicePreview(null)
                }
              }}
            >
              <option value="">— choose a mockdata asset —</option>
              {VOICE_ASSETS.map((v) => (
                <option key={v} value={v}>
                  {v}
                  {v === 'saanp.mp3' ? ' (سانپ — snakebite)' : ''}
                  {v === 'taang.mp3' ? ' (ٹانگ — leg crush)' : ''}
                  {v === 'ungli.mp3' ? ' (انگلی — finger)' : ''}
                </option>
              ))}
            </select>

            <div className="flex flex-wrap items-center gap-2">
              {/* Real in-browser audio recording toggle */}
              {!isRecordingAudio ? (
                <button
                  type="button"
                  onClick={startAudioRecording}
                  className="pill-ghost px-3.5 py-2 text-xs font-semibold hover:border-sky-300 hover:text-sky-700"
                >
                  <span>🎙️</span>
                  <span>Record voice note</span>
                </button>
              ) : (
                <button
                  type="button"
                  onClick={stopAudioRecording}
                  className="pill bg-rose-600 text-white px-3.5 py-2 text-xs font-semibold animate-pulse border border-rose-400 shadow-sm"
                >
                  <span>⏹️</span>
                  <span>Stop Recording (00:{recordingSeconds < 10 ? `0${recordingSeconds}` : recordingSeconds})</span>
                </button>
              )}

              {/* Upload audio file */}
              <label className="pill-ghost cursor-pointer px-3.5 py-2 text-xs flex-1">
                <UploadIcon />
                Upload Audio...
                <input
                  type="file"
                  accept="audio/*"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0]
                    if (!f) return
                    setVoice(f.name)
                    setVoicePreview(URL.createObjectURL(f))
                  }}
                />
              </label>
            </div>

            {voicePreview ? (
              <audio src={voicePreview} controls className="w-full mt-1" />
            ) : (
              <p className="truncate font-mono text-[10px] text-slate-400" title={voice}>
                ref: {voice}
              </p>
            )}
          </div>
        </div>

        {/* Village + GPS */}
        <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <label className="label" htmlFor="village">
              Village
            </label>
            <select
              id="village"
              className="field-select"
              value={villageId}
              onChange={(e) => onVillageChange(e.target.value)}
            >
              {REPORTABLE_VILLAGES.map((v) => (
                <option key={v.village_id} value={v.village_id}>
                  {v.village_id} — {v.label_en}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="label" htmlFor="lat">
              Latitude
            </label>
            <input
              id="lat"
              className="field font-mono"
              value={lat}
              onChange={(e) => setLat(e.target.value)}
              inputMode="decimal"
            />
          </div>

          <div>
            <label className="label" htmlFor="lng">
              Longitude
            </label>
            <input
              id="lng"
              className="field font-mono"
              value={lng}
              onChange={(e) => setLng(e.target.value)}
              inputMode="decimal"
            />
          </div>

          <div>
            <label className="label" htmlFor="reporter">
              Reporter ID
            </label>
            <input
              id="reporter"
              className="field font-mono"
              value={reporterId}
              onChange={(e) => setReporterId(e.target.value)}
            />
          </div>
        </div>

        <p className="mt-3 text-[11px] text-slate-500">
          Linked BHU:{' '}
          <span className="font-semibold text-sky-700">
            {village?.linked_bhu_id ?? '—'}
          </span>{' '}
          · Dispatch targets the village group's pre-associated BHU.
        </p>

        {failure && (
          <div className="mt-4">
            <ErrorNote code="REPORT_FAILED" message={failure} />
          </div>
        )}

        <div className="mt-5 flex flex-wrap items-center gap-3">
          <Pill
            variant="primary"
            size="lg"
            onClick={onSubmit}
            disabled={busy || !backendOnline}
            className="min-w-[320px]"
          >
            {busy ? (
              <>
                <Spinner /> Triaging…
              </>
            ) : (
              <>
                <span dir="rtl" className="font-urdu text-[16px] leading-7">
                  ایمرجنسی درج کریں
                </span>
                <span className="opacity-80">(Report Emergency)</span>
              </>
            )}
          </Pill>

          {!backendOnline && (
            <span className="text-[11px] text-rose-600 font-medium">
              Backend unreachable at {API_BASE} — start it before reporting.
            </span>
          )}
        </div>
      </Card>

      {/* ---------------- Immediate triage display ---------------- */}
      <Card
        title="AI Triage Decision"
        titleUr="ٹرئیج کا نتیجہ"
        subtitle="Inspectable severity tier, injury flags and dispatch reasoning."
        right={shownIncident ? <TierBadge tier={shownIncident.severity_tier} /> : undefined}
      >
        {!shownIncident ? (
          <EmptyState
            title="No triage result yet"
            titleUr="ابھی کوئی نتیجہ نہیں"
            message="Report an emergency above to see the severity tier, extracted injury flags and the dispatch reasoning."
          />
        ) : (
          <div className="flex flex-col gap-4">
            <div
              className={`rounded-card border p-4 ${
                shownIncident.severity_tier === 'critical'
                  ? 'border-rose-200 bg-rose-50/70 text-rose-900'
                  : 'border-sky-200 bg-sky-50/70 text-sky-900'
              }`}
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="font-mono text-xs font-semibold opacity-70">
                    {shownIncident.incident_id}
                  </p>
                  <p className="mt-1 text-xl font-bold tracking-tight">
                    {meta.label_en}
                    <span className="ml-2 text-sm font-medium opacity-75">
                      {meta.tier_no}
                    </span>
                    <span dir="rtl" className="ml-2.5 text-[16px] font-urdu">
                      {meta.label_ur}
                    </span>
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {shownIncident.ambulance_requested && (
                    <Tag tone="critical">ambulance requested</Tag>
                  )}
                  {shownIncident.bhu_notified && <Tag tone="cyan">BHU notified</Tag>}
                  {shownIncident.injury_type_flags.includes('low_confidence_triage') && (
                    <Tag tone="ash">low_confidence_triage</Tag>
                  )}
                </div>
              </div>
            </div>

            <div>
              <p className="label">Extracted injury / symptom flags</p>
              <div className="flex flex-wrap gap-2">
                {shownIncident.injury_type_flags.map((f) => (
                  <span
                    key={f}
                    className="tag normal-case tracking-normal border-slate-200 bg-slate-100 text-slate-700"
                  >
                    {humaniseFlag(f)}
                  </span>
                ))}
              </div>
            </div>

            {shownIncident.voice_transcript && (
              <div>
                <p className="label">Urdu transcript (STT)</p>
                <p
                  dir="rtl"
                  className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-[15px] leading-8 text-slate-900 font-urdu"
                >
                  {shownIncident.voice_transcript}
                </p>
              </div>
            )}

            {shownDispatch && (
              <div>
                <p className="label">AI Dispatch reasoning</p>
                <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                  <p className="text-xs font-medium text-slate-800">{shownDispatch.reasoning}</p>
                  <div className="mt-2.5 flex flex-wrap gap-2">
                    <Tag tone="cyan">status: {shownDispatch.status}</Tag>
                    {shownDispatch.responder && (
                      <Tag tone="mint">
                        responder: {shownDispatch.responder.name} (
                        {shownDispatch.responder.responder_id})
                      </Tag>
                    )}
                    {shownDispatch.bhu && (
                      <Tag tone="cyan">BHU: {shownDispatch.bhu.name}</Tag>
                    )}
                    {shownDispatch.bhu_urgency && (
                      <Tag tone={shownDispatch.bhu_urgency === 'urgent' ? 'critical' : 'ash'}>
                        urgency: {shownDispatch.bhu_urgency}
                      </Tag>
                    )}
                    <Tag tone={shownDispatch.notify_bhu ? 'mint' : 'ash'}>
                      notify_BHU: {String(shownDispatch.notify_bhu)}
                    </Tag>
                  </div>
                </div>
              </div>
            )}

            {lastReport && (
              <p className="text-[11px] text-slate-500">
                PostgreSQL persistence:{' '}
                <span className={lastReport.db_persisted ? 'text-emerald-600 font-semibold' : 'text-rose-600 font-semibold'}>
                  {lastReport.db_persisted ? 'written' : 'failed (in-memory only)'}
                </span>
              </p>
            )}

            <div className="flex flex-wrap gap-2 pt-1">
              <Pill variant="cyan" onClick={() => setRole('responder')}>
                Continue to Responder View →
              </Pill>
            </div>
          </div>
        )}
      </Card>

      <p className="px-1 text-[10px] text-pearl/60">
        {VILLAGES.length} villages registered · media assets resolve against backend server paths.
      </p>
    </div>
  )
}

/** Last path segment of a Windows- or POSIX-style ref. */
function basename(ref: string): string {
  const parts = ref.split(/[\\/]/)
  return parts[parts.length - 1] ?? ref
}

function UploadIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" aria-hidden="true">
      <path
        d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5M4 17v2a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-2"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
