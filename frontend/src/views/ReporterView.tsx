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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { useCockpit } from '../state/CockpitContext'
import { bhuById, REPORTABLE_VILLAGES, villageById } from '../lib/geography'
import {
  matchScenario,
  PRESET_PHRASES,
  scenarioById,
  type PresetPhrase,
  type Scenario,
} from '../lib/scenarios'


import type { IncidentRecord, ReportResponse, TriageAnalysisResponse } from '../lib/types'
import { analyzeTriage, uploadEmergencyMedia } from '../lib/api'
import { useSpeechToText } from '../hooks/useSpeechToText'
import { TimelineFeed } from '../components/TimelineFeed'
import { SituationMap } from '../components/SituationMap'
import { EmptyState, Pill, Spinner, StatusDot, TierBadge } from '../components/ui'
import { ReporterBackground } from '../components/BackgroundMotifs'

function getIncidentPhotoUrl(ref: string | null | undefined): string | null {
  if (!ref) return null
  if (/^(https?:|data:|blob:)/i.test(ref)) return ref
  const clean = ref.replace(/\\/g, '/')
  const filename = clean.split('/').pop() || ''
  if (clean.includes('/uploads/') || clean.includes('uploads/')) {
    return `/media/uploads/${filename}`
  }
  return `/media/photos/${filename}`
}

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

export function ReporterView() {
  const {
    submitReport,
    incidentId,
    incident,
    record,
    responders,
    backendOnline,
    pushToast,
    lang,
    adoptIncident,
    selectedVillage,
    setSelectedVillage,
  } = useCockpit()

  const [activeTab, setActiveTab] = useState<'report' | 'history'>('report')
  const [showFormEvenIfActive, setShowFormEvenIfActive] = useState(false)

  const [villageId, setVillageId] = useState(selectedVillage || 'TAMMAN')
  const [photo, setPhoto] = useState('')
  const [voice, setVoice] = useState('')
  const [reporterId] = useState('REP-USER-001')
  const [distressText, setDistressText] = useState('')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [result, setResult] = useState<ReportResponse | null>(null)

  // Incident photo upload state
  const [uploadedPhotoFile, setUploadedPhotoFile] = useState<File | null>(null)
  const [photoPreviewUrl, setPhotoPreviewUrl] = useState<string | null>(null)
  const [isUploadingPhoto, setIsUploadingPhoto] = useState(false)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  // Audio recording state (Native MediaRecorder)
  const [isRecordingAudio, setIsRecordingAudio] = useState(false)
  const [recordingSeconds, setRecordingSeconds] = useState(0)
  const [recordedAudioBlob, setRecordedAudioBlob] = useState<Blob | null>(null)
  const [recordedAudioFile, setRecordedAudioFile] = useState<File | null>(null)
  const [recordedAudioUrl, setRecordedAudioUrl] = useState<string | null>(null)
  const [micPermissionError, setMicPermissionError] = useState<string | null>(null)
  const [hasSubmittedVoice, setHasSubmittedVoice] = useState(false)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const audioChunksRef = useRef<Blob[]>([])
  const timerIntervalRef = useRef<number | null>(null)
  const audioStreamRef = useRef<MediaStream | null>(null)

  // Web Speech API real-time Urdu dictation streaming
  const {
    startListening: startSpeechRecognition,
    stopListening: stopSpeechRecognition,
    isListening: isSpeechListening,
    activeLang: speechLang,
  } = useSpeechToText({
    lang: 'ur-PK',
    fallbackLang: 'ur',
    retryLangs: ['en-US'],
    continuous: true,
    interimResults: true,
    onTranscript: (spokenText) => {
      // Immediately pipe the incoming transcript into the textarea's controlled state
      if (spokenText) {
        setDistressText(spokenText)
        const hit = matchScenario(spokenText)
        if (hit && !(hit.photo_ref === photo && hit.voice_ref === voice)) {
          alignToScenario(hit)
        }
      }
    },
    onError: (err) => {
      console.warn('[ReporterView Web Speech]', err)
    },
  })

  // Gemini Multimodal Triage Anticipation state
  const [triageAnalysis, setTriageAnalysis] = useState<TriageAnalysisResponse | null>(null)
  const [isAnalyzingTriage, setIsAnalyzingTriage] = useState(false)
  const [triageError, setTriageError] = useState<string | null>(null)

  // Self-care guardrail override: if user explicitly taps "call anyway" on minor injury
  const [selfCareOverride, setSelfCareOverride] = useState(false)

  const village = villageById(villageId)
  const [lat, setLat] = useState(String(village?.default_report_gps.lat ?? 31.5204))
  const [lng, setLng] = useState(String(village?.default_report_gps.lng ?? 74.3587))

  // -------------------------------------------------------------------------
  // Gemini Multimodal Condition Anticipation & Triage
  // -------------------------------------------------------------------------
  const triggerGeminiAnalysis = useCallback(
    async (opts?: {
      overrideText?: string
      photoFile?: File | null
      photoPath?: string
      photoRefStr?: string
      audioBlob?: Blob | null
      audioFile?: File | null
      voicePath?: string
      clearPhoto?: boolean
      clearAudio?: boolean
    }) => {
      const currentText = opts?.overrideText !== undefined ? opts.overrideText : distressText
      const currentPhotoFile = opts?.clearPhoto
        ? null
        : opts?.photoFile !== undefined
          ? opts.photoFile
          : uploadedPhotoFile
      const currentPhotoRef = opts?.clearPhoto
        ? ''
        : opts?.photoPath || opts?.photoRefStr || (uploadedPhotoFile || photoPreviewUrl ? photo : '')
      const currentAudio = opts?.clearAudio
        ? null
        : opts?.audioBlob !== undefined
          ? opts.audioBlob
          : (opts?.audioFile || recordedAudioFile || recordedAudioBlob)
      const currentVoiceRef = opts?.clearAudio
        ? ''
        : opts?.voicePath || voice

      if (!currentText.trim() && !currentAudio && !currentPhotoFile && !currentPhotoRef) {
        return
      }

      setIsAnalyzingTriage(true)
      setTriageError(null)
      try {
        const res = await analyzeTriage({
          transcript: currentText.trim() || undefined,
          photo_file: currentPhotoFile || undefined,
          audio_file: currentAudio || undefined,
          photo_ref: currentPhotoRef || undefined,
          voice_ref: currentVoiceRef || undefined,
        })
        setTriageAnalysis(res)
        if (res.voice_transcript && !currentText.trim()) {
          setDistressText(res.voice_transcript)
        }
      } catch (err) {
        console.warn('Gemini triage analysis warning:', err)
        setTriageError(err instanceof Error ? err.message : 'Triage analysis unavailable')
      } finally {
        setIsAnalyzingTriage(false)
      }
    },
    [distressText, uploadedPhotoFile, photo, recordedAudioFile, recordedAudioBlob, voice]
  )

  // -------------------------------------------------------------------------
  // Native MediaRecorder Audio Recording (No Web Speech API)
  // -------------------------------------------------------------------------
  function getSupportedAudioMimeType(): string {
    if (typeof MediaRecorder === 'undefined') return ''
    const candidates = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/ogg;codecs=opus',
      'audio/ogg',
      'audio/mp4',
    ]
    for (const cand of candidates) {
      if (MediaRecorder.isTypeSupported(cand)) {
        return cand
      }
    }
    return ''
  }

  async function startAudioRecording() {
    setMicPermissionError(null)

    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      try {
        mediaRecorderRef.current.stop()
      } catch {}
    }
    if (audioStreamRef.current) {
      audioStreamRef.current.getTracks().forEach((t) => t.stop())
      audioStreamRef.current = null
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      audioStreamRef.current = stream

      const preferredMime = getSupportedAudioMimeType()
      const recorder = preferredMime
        ? new MediaRecorder(stream, { mimeType: preferredMime })
        : new MediaRecorder(stream)

      mediaRecorderRef.current = recorder
      audioChunksRef.current = []

      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          audioChunksRef.current.push(event.data)
        }
      }

      recorder.onstop = async () => {
        const mime = preferredMime || 'audio/webm'
        const audioBlob = new Blob(audioChunksRef.current, { type: mime })
        const ext = mime.includes('ogg') ? '.ogg' : '.webm'
        const audioFile = new File([audioBlob], `voice_note_${Date.now()}${ext}`, { type: mime })
        const objectUrl = URL.createObjectURL(audioBlob)

        setRecordedAudioBlob(audioBlob)
        setRecordedAudioFile(audioFile)
        setRecordedAudioUrl(objectUrl)

        stream.getTracks().forEach((track) => track.stop())
        audioStreamRef.current = null

        try {
          const up = await uploadEmergencyMedia(audioBlob, audioFile.name, 'audio')
          setVoice(up.file_path)
          void triggerGeminiAnalysis({ audioBlob, audioFile, voicePath: up.file_path })
        } catch (err) {
          console.warn('Voice upload failed, analyzing directly:', err)
          void triggerGeminiAnalysis({ audioBlob, audioFile })
        }
      }

      recorder.start()
      setIsRecordingAudio(true)
      setRecordingSeconds(0)

      // Simultaneously activate browser speech recognition for live Urdu transcription
      try {
        startSpeechRecognition(distressText)
      } catch (speechErr) {
        console.warn('Speech recognition start non-fatal error:', speechErr)
      }

      timerIntervalRef.current = window.setInterval(() => {
        setRecordingSeconds((prev) => prev + 1)
      }, 1000)
    } catch (err: unknown) {
      console.warn('Microphone permission or hardware access error:', err)
      const errStr = String(err).toLowerCase()
      const errName = err && typeof err === 'object' && 'name' in err ? String(err.name) : ''
      const isDenied =
        errName === 'NotAllowedError' ||
        errName === 'PermissionDeniedError' ||
        errStr.includes('denied') ||
        errStr.includes('not allowed')

      const msgUr = isDenied
        ? 'مائیک کی اجازت نہیں ملی۔ براہ کرم براؤزر کی سیٹنگز میں مائیک کی اجازت دیں۔'
        : 'مائیکروفون تک رسائی ممکن نہیں ہے۔ براہ کرم مائیک کی سیٹنگز چیک کریں۔'
      const msgEn = isDenied
        ? 'Microphone permission denied. Please allow microphone access in your browser settings.'
        : 'Unable to access microphone. Please check your audio settings.'

      setMicPermissionError(`${msgUr}\n${msgEn}`)
      pushToast({
        tone: 'critical',
        title: isDenied ? 'مائیک کی اجازت درکار ہے' : 'مائیک کی خرابی',
        message: `${msgUr} ${msgEn}`,
      })
      setIsRecordingAudio(false)
      stopSpeechRecognition()
      if (timerIntervalRef.current) {
        clearInterval(timerIntervalRef.current)
        timerIntervalRef.current = null
      }
    }
  }

  function stopAudioRecording() {
    // Stop real-time Web Speech recognition
    try {
      stopSpeechRecognition()
    } catch {}

    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      try {
        mediaRecorderRef.current.stop()
      } catch {}
    }
    if (audioStreamRef.current) {
      audioStreamRef.current.getTracks().forEach((t) => t.stop())
      audioStreamRef.current = null
    }
    setIsRecordingAudio(false)
    if (timerIntervalRef.current) {
      clearInterval(timerIntervalRef.current)
      timerIntervalRef.current = null
    }
  }

  function handleDiscardAudio() {
    stopAudioRecording()
    setRecordedAudioBlob(null)
    setRecordedAudioFile(null)
    if (recordedAudioUrl) {
      URL.revokeObjectURL(recordedAudioUrl)
      setRecordedAudioUrl(null)
    }
    setVoice('')
    if (triageAnalysis) {
      void triggerGeminiAnalysis({ clearAudio: true })
    }
  }

  async function handlePhotoFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setUploadedPhotoFile(file)
    const localUrl = URL.createObjectURL(file)
    setPhotoPreviewUrl(localUrl)
    setIsUploadingPhoto(true)
    try {
      const up = await uploadEmergencyMedia(file, file.name, 'image')
      setPhoto(up.file_path)
      void triggerGeminiAnalysis({ photoFile: file, photoPath: up.file_path })
    } catch (err) {
      console.warn('Media upload failed, analyzing directly:', err)
      void triggerGeminiAnalysis({ photoFile: file })
    } finally {
      setIsUploadingPhoto(false)
    }
  }

  function handleRemovePhoto() {
    setUploadedPhotoFile(null)
    setPhotoPreviewUrl(null)
    setPhoto('')
    if (fileInputRef.current) fileInputRef.current.value = ''
    if (triageAnalysis) {
      void triggerGeminiAnalysis({ clearPhoto: true })
    }
  }

  useEffect(() => {
    if (selectedVillage && selectedVillage !== villageId) {
      setVillageId(selectedVillage)
      const geo = villageById(selectedVillage)
      if (geo) {
        setLat(String(geo.default_report_gps.lat))
        setLng(String(geo.default_report_gps.lng))
      }
    }
  }, [selectedVillage])

  function onVillageChange(next: string) {
    setVillageId(next)
    setSelectedVillage?.(next)
    const geo = villageById(next)
    if (geo) {
      setLat(String(geo.default_report_gps.lat))
      setLng(String(geo.default_report_gps.lng))
    }
  }

  function alignToScenario(next: Scenario) {
    setPhoto(next.photo_ref)
    setVoice(next.voice_ref)
    const preferred = REPORTABLE_VILLAGES.find((v) => v.coverage_village_id === next.village_id)?.village_id ?? next.village_id
    if (villageId !== preferred) onVillageChange(preferred)
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
    if (scenario) {
      alignToScenario(scenario)
      setPhotoPreviewUrl(getIncidentPhotoUrl(scenario.photo_ref))
      setUploadedPhotoFile(null)
      void triggerGeminiAnalysis({
        overrideText: preset.transcript_ur,
        photoRefStr: scenario.photo_ref,
        voicePath: scenario.voice_ref,
      })
    }
  }

  async function onSubmit() {
    setFailure(null)
    const latNum = Number.parseFloat(lat)
    const lngNum = Number.parseFloat(lng)
    if (Number.isNaN(latNum) || Number.isNaN(lngNum)) {
      setFailure('Latitude and longitude must be numeric.')
      return null
    }

    const hasVoice = Boolean(recordedAudioFile || recordedAudioBlob || voice.trim())
    const hasPhoto = Boolean(uploadedPhotoFile || photoPreviewUrl || photo.trim())
    const hasText = Boolean(distressText.trim())

    // Photo is now mandatory — block submission if missing
    if (!hasPhoto) {
      setFailure(
        lang === 'ur'
          ? 'براہ کرم آگے بڑھنے سے پہلے زخم یا متاثرہ جگہ کی تصویر ضرور لگائیں۔'
          : 'Please attach a photo of the injury to proceed.'
      )
      return null
    }

    if (!hasVoice && !hasPhoto && !hasText) {
      setFailure(
        lang === 'ur'
          ? 'براہ کرم کم از کم آواز کا پیغام، تصویر، یا تحریری تفصیل درج کریں۔'
          : 'Please provide at least a voice note, photo, or description.'
      )
      return null
    }

    setHasSubmittedVoice(hasVoice)
    setBusy(true)
    try {
      const res = await submitReport({
        latitude: latNum,
        longitude: lngNum,
        village_id: villageId,
        reporter_id: reporterId.trim() || 'REP-USER-001',
        photo_ref: photo.trim() || undefined,
        voice_ref: voice.trim() || undefined,
        voice_file:
          recordedAudioFile ||
          (recordedAudioBlob
            ? new File([recordedAudioBlob], 'voice_note.webm', { type: recordedAudioBlob.type })
            : undefined),
        photo_file: uploadedPhotoFile || undefined,
        voice_transcript: distressText.trim() || undefined,
        text_description: distressText.trim() || undefined,
        detected_emergency: triageAnalysis?.detected_emergency || undefined,
        anticipated_condition: triageAnalysis?.anticipated_condition || undefined,
        severity_tier: triageAnalysis?.severity_tier || undefined,
        first_aid_guidance: triageAnalysis?.first_aid_guidance || undefined,
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
  // Post-submit / Active incident: the form is replaced by the tracker
  // -------------------------------------------------------------------------
  const tracked = useMemo<ReportResponse | null>(() => {
    if (showFormEvenIfActive) return null
    if (result && result.incident.incident_id === incidentId) return result
    if (incident && incidentId === incident.incident_id) {
      const assigned = responders.find((r) => r.responder_id === incident.responder_assigned_id) ?? null
      return {
        incident,
        dispatch: {
          status: record?.dispatch_status ?? (incident.responder_assigned_id ? 'dispatched' : 'escalated_bhu_only'),
          responder: assigned,
          bhu: null,
          notify_bhu: incident.bhu_notified,
          bhu_urgency: incident.severity_tier === 'critical' ? 'urgent' : 'standby',
          ambulance_requested: incident.ambulance_requested,
          reasoning: 'Active incident in progress',
        },
        db_persisted: true,
      }
    }
    return null
  }, [result, incidentId, incident, record, responders, showFormEvenIfActive])

  if (activeTab === 'history') {
    return (
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
        <ReporterBackground />
        <EmergencyHistoryView
          lang={lang}
          onBack={() => setActiveTab('report')}
          onSelectIncident={(id) => {
            adoptIncident(id)
            setActiveTab('report')
            setShowFormEvenIfActive(false)
          }}
        />
      </div>
    )
  }

  if (tracked) {
    return (
      <>
        <ReporterBackground />
        <DistressStatusTracker
        report={tracked}
        lang={lang}
        hasVoiceInput={hasSubmittedVoice || Boolean(tracked.incident.voice_ref)}
        onReportAnother={() => {
          setResult(null)
          setDistressText('')
          handleDiscardAudio()
          handleRemovePhoto()
          setHasSubmittedVoice(false)
          setShowFormEvenIfActive(true)
        }}
        onViewHistory={() => setActiveTab('history')}
      />
      </>
    )
  }

  /** Show the real Tamman-area locality catalog. Coverage is resolved by the backend. */
  const villageChoices = REPORTABLE_VILLAGES

  // -------------------------------------------------------------------------
  // Render — Screen 1: The clean distress intake form
  // -------------------------------------------------------------------------
  const availableCount = responders.filter(
    (r) => matchesVillage(r.village, villageId) && r.current_availability_status === 'available',
  ).length

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-5">
      <ReporterBackground />
      {/* ---------------- Top Readiness Bar ---------------- */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-800 bg-surface px-5 py-3 text-xs">
        <div className="flex items-center gap-2">
          <StatusDot tone={availableCount > 0 ? 'mint' : 'ash'} pulse={availableCount > 0} />
          <span className="font-semibold text-ink">
            {village?.label_en}
          </span>
          <span className="text-ink-muted">·</span>
          <span className="text-sky-300">
            {availableCount > 0
              ? `${availableCount} ${lang === 'ur' ? 'رضاکار دستیاب ہیں' : 'responders on standby'}`
              : (lang === 'ur' ? 'کوئی رضاکار فارغ نہیں — براہِ راست BHU رابطہ' : 'No local responders available')}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {incidentId && (
            <button
              type="button"
              onClick={() => setShowFormEvenIfActive(false)}
              className="text-xs font-semibold text-rose-300 hover:text-rose-200 underline"
            >
              {lang === 'ur' ? 'فعال ایمرجنسی ٹریکر' : 'Active Tracker →'}
            </button>
          )}
          <button
            type="button"
            onClick={() => setActiveTab('history')}
            className="rounded-full border border-slate-700 bg-sunken px-3 py-1 text-[11px] font-semibold text-ink-muted hover:border-slate-600 hover:text-ink"
          >
            {lang === 'ur' ? '📜 سابقہ ریکارڈ' : '📜 History'}
          </button>
        </div>
      </div>

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
                {v.label_en} / {v.label_ur}
              </option>
            ))}
          </select>
          <p className="mt-2 text-[11px] leading-5 text-ink-dim">
            {lang === 'ur'
              ? 'ٹمن اور اس کے آس پاس دستیاب مقامات دکھائے جا رہے ہیں۔'
              : 'Showing supported localities around Tamman; the selected village determines the linked health facility.'}
          </p>
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-0.5 text-[11px] font-medium text-emerald-300">
              <StatusDot tone="mint" />
              {lang === 'ur' ? 'مرکزِ صحت' : 'Linked BHU'}:{' '}
              <span className="font-bold">
                {bhuById(village?.linked_bhu_id)?.name ?? village?.linked_bhu_id ?? 'BHU'}
              </span>
            </span>

            {/* Live Responder Availability Badge */}
            {availableCount >= 2 ? (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-0.5 text-[11px] font-medium text-emerald-300">
                <span className="text-[12px]">🟢</span>
                <span dir="rtl" className="font-urdu text-[12px] leading-5">
                  {availableCount} رسپانڈرز دستیاب ہیں ({availableCount} Responders Available)
                </span>
              </span>
            ) : availableCount === 1 ? (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/30 bg-amber-500/10 px-2.5 py-0.5 text-[11px] font-medium text-amber-300">
                <span className="text-[12px]">🟡</span>
                <span dir="rtl" className="font-urdu text-[12px] leading-5">
                  صرف 1 رسپانڈر دستیاب ہے (Only 1 Responder Available)
                </span>
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-rose-500/30 bg-rose-500/10 px-2.5 py-0.5 text-[11px] font-medium text-rose-300">
                <span className="text-[12px]">🔴</span>
                <span dir="rtl" className="font-urdu text-[12px] leading-5">
                  کوئی رسپانڈر دستیاب نہیں (0 Responders Available - BHU Escalation Ready)
                </span>
              </span>
            )}
          </div>
        </div>

        {/* ---------------- 2. Audio dictation & transcription ---------------- */}
        <div className="mt-6">
          {micPermissionError && (
            <div className="mb-3 rounded-2xl border border-rose-500/40 bg-rose-950/30 p-3.5 text-xs text-rose-200">
              <p className="font-urdu text-[14px] leading-6 font-semibold" dir="rtl">
                مائیک کی اجازت نہیں ملی۔ براہ کرم براؤزر کی سیٹنگز میں مائیک کی اجازت دیں۔
              </p>
              <p className="mt-1 text-slate-300 font-sans">
                Microphone permission denied. Please allow microphone access in your browser settings.
              </p>
            </div>
          )}

          {!isRecordingAudio ? (
            <div className="space-y-2.5">
              <button
                type="button"
                onClick={startAudioRecording}
                className={`flex w-full items-center justify-center gap-3 rounded-2xl border px-5 py-4 text-[15px] font-semibold transition-all hover:-translate-y-px active:translate-y-0 ${
                  recordedAudioFile || recordedAudioBlob
                    ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-300 shadow-glow hover:bg-emerald-500/20'
                    : 'border-accent/45 bg-accent/10 text-sky-200 shadow-glow hover:bg-accent/20'
                }`}
              >
                <span className="text-xl" aria-hidden="true">
                  {recordedAudioFile || recordedAudioBlob ? '✓' : '🎙️'}
                </span>
                <span dir="rtl" className="font-urdu text-[18px] leading-8">
                  {recordedAudioFile || recordedAudioBlob
                    ? 'آواز ریکارڈ ہو چکی ہے (دوبارہ کریں)'
                    : 'آواز ریکارڈ کریں'}
                </span>
                <span className="text-xs font-normal opacity-75">
                  {recordedAudioFile || recordedAudioBlob
                    ? '(Voice Ready - Click to re-record)'
                    : '(Record Voice)'}
                </span>
              </button>

              {/* Audio player preview if audio was recorded */}
              {recordedAudioUrl && (
                <div className="flex items-center justify-between gap-3 rounded-2xl border border-emerald-500/30 bg-emerald-950/20 px-4 py-2.5 shadow-glow">
                  <span className="text-xs font-semibold text-emerald-300 flex items-center gap-1.5">
                    <span>🎙️</span>
                    <span>{lang === 'ur' ? 'ریکارڈ شدہ آواز سنیں:' : 'Preview Voice Note:'}</span>
                  </span>
                  <div className="flex items-center gap-2">
                    <audio src={recordedAudioUrl} controls className="h-8 max-w-[200px] sm:max-w-[260px]" />
                    <button
                      type="button"
                      onClick={handleDiscardAudio}
                      title={lang === 'ur' ? 'آواز حذف کریں' : 'Remove voice note'}
                      className="rounded-lg border border-slate-700 bg-sunken px-2 py-1 text-[11px] font-medium text-rose-400 hover:text-rose-300"
                    >
                      ✕
                    </button>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <button
              type="button"
              onClick={stopAudioRecording}
              className="flex w-full animate-pulse items-center justify-center gap-3 rounded-2xl border border-rose-500 bg-critical px-5 py-4 text-[15px] font-semibold text-white shadow-rose transition-all hover:bg-rose-700"
            >
              <span className="text-xl" aria-hidden="true">⏹️</span>
              <span dir="rtl" className="font-urdu text-[18px] leading-8">
                ریکارڈنگ جاری ہے... (روکنے کے لیے کلک کریں)
              </span>
              <span className="font-mono text-sm tabular-nums rounded-full bg-black/40 px-2.5 py-0.5">
                00:{recordingSeconds < 10 ? `0${recordingSeconds}` : recordingSeconds}
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
              className={`w-full resize-none rounded-2xl border bg-sunken px-4 py-3 font-urdu text-[16px] leading-9 text-ink placeholder:text-ink-dim focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/40 transition-colors ${
                isSpeechListening ? 'border-rose-500/60 ring-1 ring-rose-500/30' : 'border-slate-800'
              }`}
            />
            {isSpeechListening && (
              <div className="mt-1.5 flex items-center justify-between px-1 text-[11px] text-sky-400">
                <span className="flex items-center gap-1.5 font-medium">
                  <span className="inline-block h-2 w-2 animate-ping rounded-full bg-rose-500" />
                  <span className="font-urdu text-[13px] text-rose-300" dir="rtl">
                    اردو آواز لائیو لکھی جا رہی ہے...
                  </span>
                </span>
                <span className="rounded bg-slate-800/80 px-2 py-0.5 font-mono text-[10px] text-slate-300">
                  {speechLang} (Live)
                </span>
              </div>
            )}
          </div>
        </div>

        {/* ---------------- 3. Incident Photo Upload (جائے حادثہ کی تصویر) — MANDATORY ---------------- */}
        <div className="mt-6">
          <div className="flex items-center justify-between mb-2">
            <label className="label m-0 flex items-center gap-1.5">
              <span>📷</span>
              <span>{lang === 'ur' ? 'جائے حادثہ / زخم کی تصویر' : 'Incident / Injury Photo'}</span>
              <span className="text-[10px] font-bold text-rose-400 font-sans">
                ★ {lang === 'ur' ? 'لازمی (ضروری ہے)' : 'Required'}
              </span>
            </label>
            {photoPreviewUrl && (
              <button
                type="button"
                onClick={handleRemovePhoto}
                className="text-[11px] font-medium text-rose-400 hover:text-rose-300"
              >
                {lang === 'ur' ? 'تصویر ہٹائیں ✕' : 'Remove Photo ✕'}
              </button>
            )}
          </div>

          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            capture="environment"
            onChange={handlePhotoFileChange}
            className="hidden"
            id="photo-upload-input"
          />

          {!photoPreviewUrl ? (
            <div
              onClick={() => fileInputRef.current?.click()}
              className="group relative flex flex-col items-center justify-center gap-2.5 rounded-2xl border-2 border-dashed border-slate-700 bg-surface/60 p-6 text-center transition-all hover:border-accent/60 hover:bg-surface/90 cursor-pointer"
            >
              <div className="grid h-12 w-12 place-items-center rounded-full border border-sky-500/30 bg-sky-500/10 text-2xl transition-transform group-hover:scale-105">
                📸
              </div>
              <div>
                <p className="text-sm font-semibold text-ink">
                  {lang === 'ur' ? 'تصویر منتخب کریں یا کیمرے سے فوٹو لیں' : 'Upload photo or take picture'}
                </p>
                <p className="mt-0.5 text-xs text-ink-muted">
                  {lang === 'ur'
                    ? 'جیمینائی AI تصویر دیکھ کر زخم کی قسم اور شدت کا تخمینہ لگائے گا'
                    : 'Gemini AI will inspect the photo to classify injury depth, bleeding, and severity'}
                </p>
              </div>
              <span className="inline-flex items-center gap-1 rounded-full border border-slate-700 bg-sunken px-3 py-1 text-[11px] font-semibold text-sky-300">
                + {lang === 'ur' ? 'فائل یا کیمرہ کھولیں' : 'Browse or Camera'}
              </span>
            </div>
          ) : (
            <div className="relative overflow-hidden rounded-2xl border border-sky-500/30 bg-surface p-3 shadow-glow">
              <div className="flex items-center gap-4">
                <div className="relative h-24 w-24 shrink-0 overflow-hidden rounded-xl border border-slate-700 bg-black">
                  <img
                    src={photoPreviewUrl}
                    alt="Incident injury"
                    className="h-full w-full object-cover"
                  />
                  {isUploadingPhoto && (
                    <div className="absolute inset-0 grid place-items-center bg-black/60">
                      <Spinner />
                    </div>
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-bold text-emerald-300">
                      <StatusDot tone="mint" />
                      {lang === 'ur' ? 'تصویر منسلک ہے' : 'Photo Attached'}
                    </span>
                    {isAnalyzingTriage && (
                      <span className="inline-flex items-center gap-1 text-[10px] text-sky-300 animate-pulse">
                        <Spinner /> {lang === 'ur' ? 'جیمینائی تجزیہ…' : 'Gemini analyzing…'}
                      </span>
                    )}
                  </div>
                  <p className="mt-1.5 truncate text-xs text-ink font-mono font-medium">
                    {uploadedPhotoFile ? uploadedPhotoFile.name : photo.split(/[\\/]/).pop()}
                  </p>
                  <div className="mt-2 flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      className="rounded-lg border border-slate-700 bg-sunken px-2.5 py-1 text-[11px] font-medium text-ink-muted hover:text-ink"
                    >
                      {lang === 'ur' ? 'تبدیل کریں' : 'Change Photo'}
                    </button>
                    <button
                      type="button"
                      onClick={() => triggerGeminiAnalysis()}
                      disabled={isAnalyzingTriage}
                      className="rounded-lg border border-accent/40 bg-accent/10 px-2.5 py-1 text-[11px] font-semibold text-sky-200 hover:bg-accent/20"
                    >
                      ✨ {lang === 'ur' ? 'دوبارہ تجزیہ' : 'Re-analyze'}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}


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

        {/* ---------------- 5. Gemini Multimodal Triage Card ---------------- */}
        <div className="mt-6">
          {isAnalyzingTriage ? (
            <div className="rounded-2xl border border-sky-500/40 bg-sky-500/5 p-5 shadow-glow animate-pulse">
              <div className="flex items-center gap-3">
                <div className="grid h-10 w-10 place-items-center rounded-xl bg-sky-500/20 text-xl">
                  ✨
                </div>
                <div>
                  <h3 className="text-sm font-bold text-sky-200">
                    {lang === 'ur' ? 'جیمینائی لائیو ایمرجنسی تشخیص…' : 'Gemini Multimodal Triage in Progress…'}
                  </h3>
                  <p className="text-xs text-sky-300/80">
                    {lang === 'ur'
                      ? 'آواز اور تصویر سے مریض کی حالت اور فوری خطرات کا تخمینہ لگایا جا رہا ہے'
                      : 'Analyzing speech and image to anticipate patient condition and vital risks'}
                  </p>
                </div>
              </div>
            </div>
          ) : triageAnalysis ? (
            <div className={`rounded-2xl border p-5 shadow-glow transition-all ${
              triageAnalysis.severity_tier === 'critical'
                ? 'border-rose-500/50 bg-rose-950/20 shadow-rose'
                : triageAnalysis.severity_tier === 'moderate'
                  ? 'border-amber-500/40 bg-amber-950/20'
                  : 'border-emerald-500/40 bg-emerald-950/20'
            }`}>
              {/* Header */}
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800/80 pb-3">
                <div className="flex items-center gap-2">
                  <span className="text-lg">✨</span>
                  <span className="text-xs font-bold uppercase tracking-wider text-sky-300">
                    {lang === 'ur' ? 'جیمینائی ایمرجنسی تشخیص' : 'Gemini Multimodal Triage'}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <TierBadge tier={triageAnalysis.severity_tier} />
                  <button
                    type="button"
                    onClick={() => triggerGeminiAnalysis()}
                    className="rounded-full border border-slate-700 bg-sunken px-2.5 py-0.5 text-[10px] font-semibold text-ink-muted hover:text-ink"
                  >
                    ↻ {lang === 'ur' ? 'دوبارہ' : 'Refresh'}
                  </button>
                </div>
              </div>

              {/* Detected Emergency — use 🩹 icon for minor/trivial tier, 🚨 for serious */}
              <div className="mt-3.5">
                <p className="text-[11px] font-bold uppercase text-ink-muted">
                  {lang === 'ur' ? 'شناخت شدہ حالت' : 'Assessed Condition'}
                </p>
                <p className="mt-0.5 text-base font-bold text-ink flex items-center gap-2">
                  <span>{triageAnalysis.severity_tier === 'minor' ? '🩹' : '🚨'}</span>
                  <span>{triageAnalysis.detected_emergency}</span>
                </p>
              </div>

              {/* Anticipated Condition */}
              {triageAnalysis.anticipated_condition && (
                <div className="mt-3 rounded-xl border border-sky-500/20 bg-sky-500/10 p-3.5">
                  <p className="text-[11px] font-bold uppercase tracking-wider text-sky-300 flex items-center gap-1.5 mb-1">
                    <span>⚠️</span>
                    <span>{lang === 'ur' ? 'مریض کی متوقع حالت اور خطرات' : 'Anticipated Patient Condition & Risks'}</span>
                  </p>
                  <p className="text-xs leading-relaxed text-slate-200">
                    {triageAnalysis.anticipated_condition}
                  </p>
                </div>
              )}

              {/* Signals Breakdown */}
              <div className="mt-3 grid gap-2 sm:grid-cols-2 text-[11px]">
                {triageAnalysis.voice_signals && (
                  <div className="rounded-xl border border-slate-800 bg-sunken/60 p-2.5">
                    <span className="font-semibold text-sky-300">🎙️ {lang === 'ur' ? 'آواز:' : 'Voice Signals:'}</span>{' '}
                    <span className="text-slate-300">{triageAnalysis.voice_signals}</span>
                  </div>
                )}
                {triageAnalysis.image_signals && (
                  <div className="rounded-xl border border-slate-800 bg-sunken/60 p-2.5">
                    <span className="font-semibold text-emerald-300">📸 {lang === 'ur' ? 'تصویر:' : 'Image Signals:'}</span>{' '}
                    <span className="text-slate-300">{triageAnalysis.image_signals}</span>
                  </div>
                )}
              </div>

              {/* Reassurance — for serious injuries show dispatch notice;
                  for trivial minor injuries show inline home-care note (no false ambulance promise) */}
              <div className="mt-3.5 border-t border-slate-800/80 pt-3">
                {getTrivialInjuryType(triageAnalysis) ? (
                  <TrivialCareNote injuryType={getTrivialInjuryType(triageAnalysis)!} lang={lang} />
                ) : triageAnalysis.request_ambulance || triageAnalysis.clinical_category === 'CATEGORY_A' || triageAnalysis.severity_tier === 'critical' ? (
                  <>
                    <p className="text-[11px] font-bold uppercase tracking-wider text-emerald-400 flex items-center gap-1.5 mb-1.5">
                      <span>🛡️</span>
                      <span>{lang === 'ur' ? 'آپ کی مدد راستے میں ہے (Dual Dispatch: Responder + Ambulance)' : 'Help is on the way (Dual Dispatch)'}</span>
                    </p>
                    <div className="rounded-xl border border-emerald-500/30 bg-emerald-950/25 p-3 text-xs text-emerald-100 shadow-sm">
                      <p dir={lang === 'ur' ? 'rtl' : 'ltr'} className={lang === 'ur' ? 'font-urdu text-[15px] leading-7 font-bold text-emerald-200' : 'leading-relaxed font-semibold'}>
                        {lang === 'ur'
                          ? 'آپ کی مدد راستے میں ہے — قریبی مددگار اور ایمبولینس دونوں کو مطلع کر دیا گیا ہے'
                          : 'Help is on the way — Both nearest responder and ambulance have been dispatched.'}
                      </p>
                      <p className="mt-1 text-[11px] text-emerald-300/80">
                        {lang === 'ur' ? 'پرسکون رہیں اور مریض کو محفوظ جگہ پر رکھیں۔' : 'Stay calm and keep the patient in a safe, resting position.'}
                      </p>
                    </div>
                  </>
                ) : (
                  <>
                    <p className="text-[11px] font-bold uppercase tracking-wider text-sky-400 flex items-center gap-1.5 mb-1.5">
                      <span>🛡️</span>
                      <span>{lang === 'ur' ? 'قریبی رضاکار کو اطلاع (Single Dispatch: Local Responder)' : 'Local Responder Dispatched'}</span>
                    </p>
                    <div className="rounded-xl border border-sky-500/30 bg-sky-950/25 p-3 text-xs text-sky-100 shadow-sm">
                      <p dir={lang === 'ur' ? 'rtl' : 'ltr'} className={lang === 'ur' ? 'font-urdu text-[15px] leading-7 font-bold text-sky-200' : 'leading-relaxed font-semibold'}>
                        {lang === 'ur'
                          ? 'قریبی رضاکار طبی مدد کے لیے راستے میں ہے'
                          : 'Local Responder dispatched for on-scene first aid.'}
                      </p>
                      <p className="mt-1 text-[11px] text-sky-300/80">
                        {lang === 'ur' ? 'رضاکار ابتدائی طبی امداد، پٹی اور بحالی کے لیے آ رہا ہے۔' : 'Volunteer is en route for on-scene stabilization, splinting, and dressing.'}
                      </p>
                    </div>
                  </>
                )}
              </div>
            </div>
          ) : (
            (distressText.trim() || uploadedPhotoFile || photoPreviewUrl) && (
              <button
                type="button"
                onClick={() => triggerGeminiAnalysis()}
                className="flex w-full items-center justify-center gap-2.5 rounded-2xl border border-sky-500/40 bg-sky-500/10 px-4 py-3 text-xs font-semibold text-sky-200 transition-all hover:bg-sky-500/20 shadow-glow"
              >
                <span>✨</span>
                <span dir="rtl" className="font-urdu text-[15px] leading-6">
                  جیمینائی AI سے ایمرجنسی تشخیص کروائیں
                </span>
                <span className="text-[11px] opacity-80">(Analyze with Gemini AI)</span>
              </button>
            )
          )}
        </div>

        {triageError && (
          <p className="mt-3 rounded-2xl border border-amber-500/35 bg-amber-500/10 px-4 py-2.5 text-xs font-semibold text-amber-300">
            ⚠️ {triageError}
          </p>
        )}

        {/* ---------------- Mandatory photo warning (shown inline before submit) ---------------- */}
        {!photoPreviewUrl && (
          <div className="mt-4 flex items-start gap-3 rounded-2xl border border-rose-500/50 bg-rose-950/30 px-4 py-3.5">
            <span className="mt-0.5 shrink-0 text-lg">📷</span>
            <div className="min-w-0 flex-1">
              <p className="font-urdu text-[15px] leading-7 font-semibold text-rose-300" dir="rtl">
                براہ کرم آگے بڑھنے سے پہلے زخم یا متاثرہ جگہ کی تصویر ضرور لگائیں۔
              </p>
              <p className="mt-0.5 text-xs text-rose-300/80">
                Please attach a photo of the injury to proceed.
              </p>
            </div>
          </div>
        )}

        {failure && (
          <p className="mt-4 rounded-2xl border border-rose-500/35 bg-rose-500/10 px-4 py-3 text-xs font-semibold text-rose-300">
            {failure}
          </p>
        )}

        {/* ---------------- 6. Self-care guardrail OR full dispatch submit ---------------- */}
        {getTrivialInjuryType(triageAnalysis) !== null && !selfCareOverride ? (
          <SelfCareCard
            triage={triageAnalysis}
            onCallAnyway={() => setSelfCareOverride(true)}
          />
        ) : (
          <>
            {/* Bystander intervention card for life-threatening emergencies */}
            {getCriticalBystanderType(triageAnalysis) !== null && (
              <BystanderInterventionCard
                criticalType={getCriticalBystanderType(triageAnalysis)!}
                lang={lang}
              />
            )}

            <button
              type="button"
              onClick={onSubmit}
              disabled={busy || !backendOnline || !photoPreviewUrl}
              className={`mt-4 flex w-full items-center justify-center gap-3 rounded-2xl px-5 py-4 text-[16px] font-bold text-white transition-all active:translate-y-0 disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:translate-y-0 ${
                getCriticalBystanderType(triageAnalysis) !== null
                  ? 'animate-pulse bg-rose-600 shadow-[0_0_20px_rgba(239,68,68,0.55)] hover:bg-rose-500 hover:shadow-[0_0_28px_rgba(239,68,68,0.7)]'
                  : 'bg-critical shadow-rose hover:-translate-y-px hover:bg-rose-600'
              }`}
            >
              {busy ? (
                <>
                  <Spinner /> {lang === 'ur' ? 'ٹرائی ایج ہو رہا ہے…' : 'Triaging…'}
                </>
              ) : getCriticalBystanderType(triageAnalysis) !== null ? (
                <>
                  <span className="text-xl" aria-hidden="true">🚨</span>
                  <span dir="rtl" className="font-urdu text-[19px] leading-8">
                    ایمرجنسی فوری بھیجیں
                  </span>
                  <span className="text-xs font-semibold opacity-90">(Send Emergency Immediately)</span>
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
          </>
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
  hasVoiceInput,
  onReportAnother,
  onViewHistory,
}: {
  report: ReportResponse
  lang: 'ur' | 'en'
  hasVoiceInput?: boolean
  onReportAnother: () => void
  onViewHistory?: () => void
}) {
  const { incident } = report
  const { timeline, record } = useCockpit()
  const dispatch = report.dispatch ?? null
  const isCritical = incident.severity_tier === 'critical'
  const isModerate = incident.severity_tier === 'moderate'
  const responderName = dispatch?.responder?.name ?? null
  const hasLowConfidence = incident.injury_type_flags?.includes('low_confidence_triage')
  const voiceWasProvided = Boolean((hasVoiceInput ?? Boolean(incident.voice_ref)) && incident.voice_transcript)

  const isAccepted = useMemo(() => {
    const events = incident?.dispatch_events ?? record?.incident?.dispatch_events ?? []
    const acknowledged = events.some((e: any) => {
      const name = String(e?.event ?? e?.type ?? e?.stage ?? '').toLowerCase()
      return (
        name.includes('accept') ||
        name.includes('ack') ||
        name.includes('en_route') ||
        name.includes('arrived')
      )
    })
    const enRouteUpdate = (timeline?.updates ?? []).some(
      (u) =>
        u.stage === 'responder_en_route' ||
        u.stage === 'en_route' ||
        u.stage === 'responder_arrived' ||
        u.stage === 'arrived',
    )
    const status = String(timeline?.status ?? '').toLowerCase()
    return (
      acknowledged ||
      enRouteUpdate ||
      status === 'responder_en_route' ||
      status === 'responder_arrived' ||
      status === 'arrived' ||
      Boolean(incident?.responder_arrived_timestamp)
    )
  }, [incident, record, timeline])

  const isBackendResponderArrived = useMemo(() => {
    const events = incident?.dispatch_events ?? record?.incident?.dispatch_events ?? []
    const acknowledged = events.some((e: any) => {
      const name = String(e?.event ?? e?.type ?? e?.stage ?? '').toLowerCase()
      return name.includes('arrived')
    })
    const arrivedUpdate = (timeline?.updates ?? []).some(
      (u) =>
        u.stage === 'responder_arrived' ||
        u.stage === 'arrived',
    )
    const status = String(timeline?.status ?? '').toLowerCase()
    return (
      acknowledged ||
      arrivedUpdate ||
      status === 'responder_arrived' ||
      status === 'arrived' ||
      status === 'closed' ||
      Boolean(incident?.responder_arrived_timestamp)
    )
  }, [incident, record, timeline])

  const [mapArrivals, setMapArrivals] = useState({
    responderArrived: false,
    ambulanceArrived: false,
  })

  const handleArrivalChange = useCallback(
    (arrivals: { responderArrived: boolean; ambulanceArrived: boolean }) => {
      setMapArrivals((prev) => {
        if (
          prev.responderArrived === arrivals.responderArrived &&
          prev.ambulanceArrived === arrivals.ambulanceArrived
        ) {
          return prev
        }
        return arrivals
      })
    },
    [],
  )

  const isResponderArrived = isBackendResponderArrived || mapArrivals.responderArrived
  const isAmbulanceArrived =
    Boolean(incident.ambulance_requested) &&
    (String(timeline?.status ?? '').toLowerCase() === 'closed' || mapArrivals.ambulanceArrived)
  const isBothArrived = Boolean(incident.ambulance_requested) && isResponderArrived && isAmbulanceArrived

  return (
    <div className="mx-auto flex w-full max-w-2xl animate-fade-rise flex-col gap-5">
      {/* ---------------- Headline verdict & Large Severity Badge ---------------- */}
      <div
        className={`card-panel p-6 sm:p-8 ${
          isCritical ? 'border-rose-500/45 shadow-rose' : ''
        }`}
      >
        <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4 border-b border-slate-800/80 pb-5">
          <div className="min-w-0 flex-1">
            <h2 className="text-xl sm:text-2xl font-bold tracking-tight text-ink">
              {incident.ambulance_requested ? (
                isBothArrived ? (
                  lang === 'ur' ? (
                    <span dir="rtl" className="font-urdu text-[22px] leading-10 text-emerald-300">
                      آپ کی مدد پہنچ چکی ہے — قریبی مددگار اور ایمبولینس دونوں پہنچ چکے ہیں
                    </span>
                  ) : (
                    <span className="text-emerald-300">
                      Help has arrived — Both nearest responder and ambulance have arrived
                    </span>
                  )
                ) : isResponderArrived ? (
                  lang === 'ur' ? (
                    <span dir="rtl" className="font-urdu text-[22px] leading-10 text-emerald-300">
                      قریبی مددگار پہنچ چکے ہیں — ایمبولینس راستے میں ہے
                    </span>
                  ) : (
                    <span className="text-emerald-300">
                      Nearest responder has arrived — Ambulance is en route
                    </span>
                  )
                ) : (
                  lang === 'ur' ? (
                    <span dir="rtl" className="font-urdu text-[22px] leading-10 text-rose-300">
                      آپ کی مدد راستے میں ہے — قریبی مددگار اور ایمبولینس دونوں کو مطلع کر دیا گیا ہے
                    </span>
                  ) : (
                    <span className="text-rose-300">
                      Help is on the way — Both nearest responder and ambulance have been dispatched
                    </span>
                  )
                )
              ) : incident.responder_assigned_id || incident.dispatch_responder !== false ? (
                isResponderArrived ? (
                  lang === 'ur' ? (
                    <span dir="rtl" className="font-urdu text-[22px] leading-10 text-emerald-300">
                      قریبی رضاکار طبی مدد کے لیے پہنچ چکا ہے
                    </span>
                  ) : (
                    <span className="text-emerald-300">
                      Local Responder has arrived for on-scene first aid
                    </span>
                  )
                ) : (
                  lang === 'ur' ? (
                    <span dir="rtl" className="font-urdu text-[22px] leading-10 text-emerald-400">
                      قریبی رضاکار طبی مدد کے لیے راستے میں ہے
                    </span>
                  ) : (
                    <span className="text-emerald-400">
                      Local Responder dispatched for on-scene first aid
                    </span>
                  )
                )
              ) : (
                lang === 'ur' ? (
                  <span dir="rtl" className="font-urdu text-[22px] leading-10 text-slate-300">
                    ایمرجنسی ڈسپیچ غیر فعال ہے — گھریلو دیکھ بھال کافی ہے
                  </span>
                ) : (
                  <span className="text-slate-300">
                    Zero Dispatch — Self-Care Home Guidance
                  </span>
                )
              )}
            </h2>
            <p className="mt-1 text-xs text-ink-muted">
              {lang === 'ur'
                ? `ایمرجنسی شناخت نمبر: ${incident.incident_id}`
                : `Incident ID: ${incident.incident_id}`}
            </p>
          </div>

          {/* 1. Large Color-Coded Severity Badge */}
          <div className="flex flex-wrap items-center gap-2">
            <div
              className={`inline-flex items-center gap-2 rounded-2xl px-4 py-2.5 text-sm sm:text-base font-bold text-white shadow-lg ${
                isCritical
                  ? 'bg-rose-600 border border-rose-400 shadow-rose-600/40'
                  : isModerate
                    ? 'bg-amber-600 border border-amber-400 shadow-amber-600/40'
                    : 'bg-emerald-600 border border-emerald-400 shadow-emerald-600/40'
              }`}
            >
              <span className="text-lg">
                {isCritical ? '🚨' : isModerate ? '⚠️' : '✅'}
              </span>
              <span>
                {isCritical
                  ? 'شدید خطرناک / CRITICAL'
                  : isModerate
                    ? 'اعتدال / MODERATE'
                    : 'معمولی / MINOR'}
              </span>
            </div>

            {hasLowConfidence && (
              <span className="inline-flex items-center gap-1 rounded-xl border border-slate-600 bg-slate-800 px-3 py-1.5 text-xs font-semibold text-slate-300">
                <span>ℹ️</span>
                <span dir="rtl" className="font-urdu text-[13px] leading-4">کم اعتماد</span>
                <span className="text-[10px] font-sans text-slate-400">(Low Confidence)</span>
              </span>
            )}
          </div>
        </div>

        {/* Assigned volunteer — appears only once the responder accepts the request */}
        {responderName && isAccepted ? (
          <div className="mt-5 rounded-2xl border border-sky-500/30 bg-sky-500/10 p-5 shadow-glow animate-fade-rise">
            <p className="label mb-3">
              {lang === 'ur' ? 'تخصیص شدہ رضاکار' : 'Assigned First Responder'}
            </p>
            <div className="flex flex-wrap items-center gap-4">
              <span className="grid h-12 w-12 place-items-center rounded-full border border-sky-400/50 bg-sky-500/20 text-lg font-bold text-sky-200 shadow-glow">
                {responderName.trim().charAt(0)}
              </span>
              <div className="min-w-0">
                <p className="text-base font-bold tracking-tight text-ink">{responderName}</p>
                <p className="text-xs text-sky-300 font-medium">
                  {isResponderArrived
                    ? (lang === 'ur' ? 'جائے وقوعہ پر پہنچ چکے ہیں' : 'Arrived at Emergency Site')
                    : (lang === 'ur' ? 'مطلع کیا جا چکا ہے' : 'En Route to Emergency Site')}
                </p>
              </div>
              <span className="ml-auto inline-flex items-center gap-1.5 rounded-full border border-emerald-500/40 bg-emerald-500/20 px-3 py-1 text-xs font-bold text-emerald-300">
                <StatusDot tone="mint" pulse={!isResponderArrived} />
                {isResponderArrived
                  ? (lang === 'ur' ? 'پہنچ گئے' : 'On Scene')
                  : (lang === 'ur' ? 'فعال' : 'En Route')}
              </span>
            </div>
          </div>
        ) : responderName && !isAccepted ? (
          <div className="mt-5 rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4 shadow-glow">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-sm font-bold text-amber-300">
                  {lang === 'ur'
                    ? 'قریبی رضاکار کو الرٹ بھیج دیا گیا ہے'
                    : 'Alert sent to nearest first responder'}
                </p>
                <p className="text-xs text-amber-200/80 font-medium mt-0.5">
                  {lang === 'ur'
                    ? 'رضاکار کی جانب سے قبول کرنے کا انتظار ہے...'
                    : 'Awaiting responder acceptance of dispatch invite...'}
                </p>
              </div>
              <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/40 bg-amber-500/20 px-3 py-1 text-xs font-bold text-amber-300">
                <StatusDot tone="critical" pulse />
                {lang === 'ur' ? 'قبولیت کا انتظار' : 'Awaiting Acceptance'}
              </span>
            </div>
          </div>
        ) : (
          <div className="mt-5 rounded-2xl border border-amber-500/30 bg-amber-500/10 p-5 shadow-glow">
            <div className="space-y-1">
              <p className="font-urdu text-[15px] leading-7 font-bold text-amber-300" dir="rtl">
                علاقے میں کوئی رضاکار دستیاب نہیں — براہ راست بنیادی مرکز صحت (BHU) کو ایمرجنسی بھیج دی گئی ہے۔
              </p>
              <p className="text-xs text-amber-200/80 font-sans">
                (No local responder available — incident escalated directly to BHU).
              </p>
            </div>
          </div>
        )}

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
            on={Boolean(incident.ambulance_requested)}
            labelEn="Ambulance Transfer"
            labelUr="ایمبولینس"
            detail={
              incident.ambulance_requested
                ? isAmbulanceArrived
                  ? (lang === 'ur' ? 'پہنچ چکی ہے (جائے وقوعہ)' : 'Arrived on Scene')
                  : 'Dispatched (Urgent)'
                : 'Not Required'
            }
            urgency={incident.ambulance_requested && !isAmbulanceArrived ? 'urgent' : null}
          />
        </div>

        {/* 2. Urdu transcript (only if voice was provided and STT ran) */}
        {voiceWasProvided && (
          <div className="mt-4 rounded-2xl border border-amber-500/40 bg-amber-950/25 p-4 shadow-glow">
            <p className="font-urdu text-[14px] font-bold text-amber-300 mb-1 flex items-center gap-1.5" dir="rtl">
              <span>🎙️</span>
              <span>AI نے آپ کی بات سمجھی:</span>
            </p>
            <p
              dir="rtl"
              className="font-urdu text-[17px] leading-9 text-amber-200 font-semibold tracking-wide"
            >
              {incident.voice_transcript}
            </p>
          </div>
        )}

        {/* 3. Injury flags tag badges */}
        {incident.injury_type_flags && incident.injury_type_flags.length > 0 && (
          <div className="mt-4">
            <p className="text-[11px] font-bold uppercase tracking-wider text-ink-muted mb-2">
              {lang === 'ur' ? 'انجری کی علامات / اقسام (Injury Flags):' : 'Injury Type Flags:'}
            </p>
            <div className="flex flex-wrap gap-1.5">
              {incident.injury_type_flags.map((flag, idx) => (
                <span
                  key={idx}
                  className={`inline-flex items-center rounded-lg border px-2.5 py-1 text-xs font-mono font-medium ${
                    flag === 'low_confidence_triage'
                      ? 'border-slate-700 bg-slate-800/80 text-slate-400'
                      : 'border-sky-500/40 bg-sky-500/15 text-sky-200'
                  }`}
                >
                  #{flag}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Gemini Clinical Assessment Card */}
        {(incident.detected_emergency || incident.anticipated_condition) && (
          <div className="mt-4 rounded-2xl border border-sky-500/35 bg-sky-500/10 p-4 shadow-glow">
            <p className="text-[11px] font-bold uppercase tracking-wider text-sky-300 flex items-center gap-1.5 mb-1.5">
              <span>✨</span>
              <span>{lang === 'ur' ? 'جیمینائی ایمرجنسی تشخیص و متوقع کیفیت' : 'Gemini Clinical Triage Assessment'}</span>
            </p>
            {incident.detected_emergency && (
              <p className="text-base font-bold text-ink mb-1 flex items-center gap-2">
                <span>🚨</span>
                <span>{incident.detected_emergency}</span>
              </p>
            )}
            {incident.anticipated_condition && (
              <p className="text-xs text-slate-200 leading-relaxed">
                {incident.anticipated_condition}
              </p>
            )}
          </div>
        )}

        {/* Incident Evidence Photo Preview */}
        {incident.photo_ref && (
          <div className="mt-4 flex items-center gap-4 rounded-2xl border border-slate-800 bg-sunken p-3">
            <img
              src={getIncidentPhotoUrl(incident.photo_ref) || ''}
              alt="Incident evidence"
              className="h-20 w-20 shrink-0 rounded-xl object-cover border border-slate-700 bg-black"
              onError={(e) => {
                ;(e.target as HTMLElement).style.display = 'none'
              }}
            />
            <div className="min-w-0 flex-1">
              <p className="text-[10px] font-bold uppercase tracking-wider text-ink-muted mb-1">
                {lang === 'ur' ? 'جائے حادثہ کی تصویر' : 'Incident Photo Evidence'}
              </p>
              <p className="text-xs text-sky-300 font-mono truncate">
                {incident.photo_ref.split(/[\\/]/).pop()}
              </p>
              <span className="mt-1 inline-flex items-center gap-1 text-[10px] text-emerald-300 font-medium">
                <StatusDot tone="mint" /> {lang === 'ur' ? 'جیمینائی AI کے ذریعے ٹرائی ایج شدہ' : 'Analyzed by Gemini AI'}
              </span>
            </div>
          </div>
        )}

        {/* Layperson Bystander Reassurance Card */}
        <div className="mt-5">
          <BystanderReassuranceCard
            lang={lang}
            ambulanceRequested={Boolean(incident.ambulance_requested)}
            responderArrived={isResponderArrived}
            ambulanceArrived={isAmbulanceArrived}
          />
        </div>

        <div className="mt-5">
          <SituationMap heightClass="h-[260px] sm:h-[320px]" onArrivalChange={handleArrivalChange} />
        </div>

        <div className="mt-6 flex flex-wrap gap-3 border-t border-slate-800/80 pt-5">
          <Pill variant="primary" size="lg" onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}>
            {lang === 'ur' ? (
              <span dir="rtl" className="font-urdu text-[16px] leading-7">
                موجودہ صورتحال دیکھیں
              </span>
            ) : (
              'View Current Status'
            )}
          </Pill>
          <Pill variant="ghost" size="lg" onClick={onReportAnother}>
            {lang === 'ur' ? 'نئی رپورٹ' : 'Report another'}
          </Pill>
          {onViewHistory && (
            <Pill variant="ghost" size="lg" onClick={onViewHistory}>
              {lang === 'ur' ? '📜 سابقہ تاریخچہ' : '📜 History'}
            </Pill>
          )}
        </div>
      </div>

      {/* ---------------- Progressive Urdu timeline feed ---------------- */}
      <TimelineFeed />
    </div>
  )
}

function BystanderReassuranceCard({
  lang,
  ambulanceRequested = false,
  responderArrived = false,
  ambulanceArrived = false,
}: {
  lang: 'ur' | 'en'
  ambulanceRequested?: boolean
  responderArrived?: boolean
  ambulanceArrived?: boolean
}) {
  const isBothArrived = ambulanceRequested && responderArrived && ambulanceArrived

  const bulletPoints = [
    {
      ur: 'پرسکون رہیں اور مریض کو محفوظ جگہ پر لٹائیں۔',
      en: 'Stay calm and keep the patient in a safe place.',
    },
    {
      ur: 'مریض کو اکیلا نہ چھوڑیں۔',
      en: 'Do not leave the patient alone.',
    },
    ambulanceRequested
      ? isBothArrived
        ? {
            ur: 'قریبی مددگار اور ایمبولینس دونوں پہنچ چکے ہیں — مکمل طبی امداد میسر ہے۔',
            en: 'Both nearest responder and ambulance have arrived at your location.',
          }
        : responderArrived
          ? {
              ur: 'قریبی مددگار پہنچ چکے ہیں اور ایمبولینس بھی جلد پہنچ رہی ہے۔',
              en: 'Nearest responder has arrived on scene, ambulance is arriving soon.',
            }
          : {
              ur: 'آپ کی مدد راستے میں ہے — قریبی مددگار اور ایمبولینس دونوں کو مطلع کر دیا گیا ہے۔',
              en: 'Help is on the way — Both nearest responder and ambulance have been dispatched to your location.',
            }
      : responderArrived
        ? {
            ur: 'قریبی رضاکار جائے وقوعہ پر پہنچ چکا ہے — ابتدائی طبی امداد جاری ہے۔',
            en: 'Local volunteer responder has arrived — first aid is underway.',
          }
        : {
            ur: 'قریبی رضاکار طبی مدد کے لیے راستے میں ہے۔',
            en: 'Nearest volunteer responder is on the way for on-scene first aid.',
          },
  ]

  return (
    <div className="rounded-2xl border border-emerald-500/30 bg-emerald-950/25 p-5 shadow-sm">
      <div className="flex items-center gap-3 border-b border-emerald-500/20 pb-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-emerald-500/20 text-xl text-emerald-300">
          {isBothArrived || (!ambulanceRequested && responderArrived) ? '✅' : '🛡️'}
        </span>
        <div>
          <h3 className="text-base font-bold text-emerald-200">
            {ambulanceRequested ? (
              isBothArrived ? (
                <span dir="rtl" className="font-urdu text-[17px] leading-7">
                  {lang === 'ur'
                    ? 'آپ کی مدد پہنچ چکی ہے — قریبی مددگار اور ایمبولینس دونوں پہنچ چکے ہیں'
                    : 'Help has arrived — Both responder and ambulance are on scene'}
                </span>
              ) : responderArrived ? (
                <span dir="rtl" className="font-urdu text-[17px] leading-7">
                  {lang === 'ur'
                    ? 'قریبی مددگار پہنچ چکے ہیں — ایمبولینس راستے میں ہے'
                    : 'Responder on Scene — Ambulance en route'}
                </span>
              ) : (
                <span dir="rtl" className="font-urdu text-[17px] leading-7">
                  {lang === 'ur'
                    ? 'آپ کی مدد راستے میں ہے — قریبی مددگار اور ایمبولینس دونوں کو مطلع کر دیا گیا ہے'
                    : 'Help is on the way — Dual Dispatch (Responder + Ambulance)'}
                </span>
              )
            ) : responderArrived ? (
              <span dir="rtl" className="font-urdu text-[17px] leading-7">
                {lang === 'ur'
                  ? 'قریبی رضاکار طبی مدد کے لیے پہنچ چکا ہے'
                  : 'Local responder has arrived on scene'}
              </span>
            ) : (
              <span dir="rtl" className="font-urdu text-[17px] leading-7">
                {lang === 'ur'
                  ? 'قریبی رضاکار طبی مدد کے لیے راستے میں ہے'
                  : 'Help is on the way — Single Dispatch (Local Responder)'}
              </span>
            )}
          </h3>
          <p className="text-[11px] text-emerald-300/80">
            {ambulanceRequested
              ? isBothArrived
                ? (lang === 'ur' ? 'قریبی رضاکار اور ایمبولینس دونوں جائے وقوعہ پر پہنچ چکے ہیں' : 'Both responder and ambulance have arrived at your location')
                : responderArrived
                  ? (lang === 'ur' ? 'رضاکار جائے وقوعہ پر پہنچ چکا ہے، ایمبولینس بھی جلد پہنچ جائے گی' : 'First responder has reached you, ambulance is arriving soon')
                  : (lang === 'ur' ? 'قریبی رضاکار اور ایمبولینس کو الرٹ کر دیا گیا ہے' : 'Both responder and ambulance dispatched to your location')
              : responderArrived
                ? (lang === 'ur' ? 'رضاکار ابتدائی طبی امداد کے لیے جائے وقوعہ پر پہنچ چکا ہے' : 'Local volunteer responder has arrived at your location')
                : (lang === 'ur' ? 'ابتدائی طبی امداد کے لیے رضاکار کو مطلع کر دیا گیا ہے' : 'Local volunteer responder dispatched for on-scene first aid')}
          </p>
        </div>
      </div>

      <ul className="mt-4 space-y-3 text-xs">
        {bulletPoints.map((pt, idx) => (
          <li key={idx} className="flex items-start gap-2.5 text-emerald-100">
            <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-emerald-400" />
            <span
              dir={lang === 'ur' ? 'rtl' : 'ltr'}
              className={lang === 'ur' ? 'font-urdu text-[15px] leading-7 text-slate-100' : 'leading-relaxed text-slate-200'}
            >
              {lang === 'ur' ? `${pt.ur} (${pt.en})` : `${pt.ur} (${pt.en})`}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function EmergencyHistoryView({
  onSelectIncident,
  onBack,
  lang,
}: {
  onSelectIncident: (id: string) => void
  onBack: () => void
  lang: 'ur' | 'en'
}) {
  const { fetchIncidents } = useCockpit()
  const [incidents, setIncidents] = useState<IncidentRecord[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetchIncidents()
      .then((items) => setIncidents(items))
      .finally(() => setLoading(false))
  }, [fetchIncidents])

  return (
    <div className="card-panel p-6 sm:p-8 animate-fade-rise">
      <div className="flex items-center justify-between border-b border-slate-800 pb-4 mb-5">
        <div>
          <h2 className="text-xl font-bold tracking-tight text-ink">
            {lang === 'ur' ? (
              <span dir="rtl" className="font-urdu text-[22px] leading-9">گزشتہ ایمرجنسیز کا ریکارڈ</span>
            ) : (
              'Emergency History'
            )}
          </h2>
          <p className="text-xs text-ink-muted">
            {lang === 'ur' ? 'تمام سابقہ رپورٹس اور ان کے نتائج' : 'Log of all reported incidents and their outcomes'}
          </p>
        </div>
        <Pill variant="ghost" size="sm" onClick={onBack}>
          {lang === 'ur' ? '← واپس جائیں' : '← Back'}
        </Pill>
      </div>

      {loading ? (
        <div className="py-12 text-center text-xs text-ink-muted">
          <Spinner /> {lang === 'ur' ? 'ریکارڈ لوڈ ہو رہا ہے…' : 'Loading history…'}
        </div>
      ) : incidents.length === 0 ? (
        <EmptyState
          title="No past emergencies"
          titleUr="کوئی سابقہ ایمرجنسی ریکارڈ نہیں"
          message="When emergencies are submitted, they will appear here with outcome records."
        />
      ) : (
        <div className="flex flex-col gap-3">
          {incidents.map((rec) => {
            const inc = rec.incident
            const isClosed = Boolean(inc.incident_closed_timestamp)
            return (
              <div
                key={inc.incident_id}
                onClick={() => onSelectIncident(inc.incident_id)}
                className="flex flex-wrap items-center justify-between gap-3 p-4 rounded-2xl border border-slate-800 bg-surface hover:border-slate-700 cursor-pointer transition-colors"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs font-bold text-sky-400">{inc.incident_id}</span>
                    <TierBadge tier={inc.severity_tier} size="sm" />
                    <span className="text-[11px] text-ink-dim">
                      {inc.timestamp_reported ? new Date(inc.timestamp_reported).toLocaleDateString() : ''}
                    </span>
                  </div>
                  <p className="mt-1 truncate text-xs text-ink-muted font-urdu" dir="rtl">
                    {inc.voice_transcript || inc.injury_type_flags.join(', ') || 'Emergency report'}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <span className={`px-2.5 py-1 text-[10px] font-bold rounded-full ${isClosed ? 'bg-emerald-500/10 text-emerald-300 border border-emerald-500/30' : 'bg-sky-500/10 text-sky-300 border border-sky-500/30'}`}>
                    {isClosed ? (lang === 'ur' ? 'مکمل شدہ' : 'Closed') : (lang === 'ur' ? 'جاری' : 'Active')}
                  </span>
                </div>
              </div>
            )
          })}
        </div>
      )}
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

// ---------------------------------------------------------------------------
// Trivial injury detection helper
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Trivial injury classification
// ---------------------------------------------------------------------------

const BRUISE_FLAGS = new Set(['bruise', 'contusion', 'superficial_bruise', 'minor_bruise'])
const CUT_FLAGS    = new Set(['minor_scrape', 'small_cut', 'minor_cut', 'superficial_abrasion', 'abrasion', 'scratch'])

const BRUISE_KEYWORDS = ['bruise', 'contusion', 'چوٹ', 'نیلاہٹ', 'نیل']
const CUT_KEYWORDS    = ['scrape', 'scratch', 'abrasion', 'paper cut', 'small cut', 'minor cut',
                          'superficial', 'خراش', 'ہلکا کٹ', 'معمولی کٹ']

/**
 * Returns the trivial sub-type for guardrail routing:
 *  'bruise' → contusion/bruise instructions
 *  'cut'    → scrape/cut/scratch instructions
 *  'minor'  → generic minor (severity tier minor but no specific flag match)
 *  null     → NOT a trivial injury; normal dispatch should proceed
 */
function getTrivialInjuryType(
  triage: import('../lib/types').TriageAnalysisResponse | null
): 'bruise' | 'cut' | 'minor' | null {
  if (!triage) return null
  // Only suppress dispatch for severity_tier 'minor'
  if (triage.severity_tier !== 'minor') return null

  const flags = triage.injury_type_flags?.map((f) => f.toLowerCase()) ?? []
  const desc  = (triage.detected_emergency ?? '').toLowerCase()

  if (flags.some((f) => BRUISE_FLAGS.has(f)) || BRUISE_KEYWORDS.some((kw) => desc.includes(kw)))
    return 'bruise'
  if (flags.some((f) => CUT_FLAGS.has(f)) || CUT_KEYWORDS.some((kw) => desc.includes(kw)))
    return 'cut'

  // Minor tier but no specific flag — still trivial, use generic guidance
  return 'minor'
}

// ---------------------------------------------------------------------------
// Inline trivial-care note (shown INSIDE the triage card, replaces reassurance)
// ---------------------------------------------------------------------------

function TrivialCareNote({
  injuryType,
  lang,
}: {
  injuryType: 'bruise' | 'cut' | 'minor'
  lang: 'ur' | 'en'
}) {
  const isBruise = injuryType === 'bruise'
  const isCut    = injuryType === 'cut'

  return (
    <div className="rounded-xl border border-emerald-500/25 bg-emerald-950/20 px-3.5 py-3 text-xs">
      <p className="mb-2 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-emerald-400">
        <span>🩹</span>
        <span>{lang === 'ur' ? 'گھریلو دیکھ بھال کافی ہے' : 'Home Care Sufficient'}</span>
      </p>
      {isBruise && (
        <p dir="rtl" className="font-urdu text-[13px] leading-7 text-emerald-100">
          متاثرہ جگہ پر کپڑے میں لپٹی برف سے ہلکی ٹکور کریں۔ مالش یا سخت دباؤ سے گریز کریں۔
        </p>
      )}
      {isCut && (
        <p dir="rtl" className="font-urdu text-[13px] leading-7 text-emerald-100">
          زخم کو صاف پانی اور صابن سے دھو کر اینٹی سیپٹک اور سنی پلاسٹ (Bandage) لگائیں۔
        </p>
      )}
      {!isBruise && !isCut && (
        <p dir="rtl" className="font-urdu text-[13px] leading-7 text-emerald-100">
          یہ معمولی چوٹ ہے۔ آرام کریں اور علامات پر نظر رکھیں۔
        </p>
      )}
      <p className="mt-2 text-[11px] font-semibold text-emerald-400/80" dir="rtl">
        اس معمولی تکلیف کے لیے ہسپتال یا ایمرجنسی کال کی ضرورت نہیں ہے۔
      </p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Self-Care Card — full replacement of the dispatch button for trivial injuries
// ---------------------------------------------------------------------------

const BRUISE_STEPS: Array<{ ur: string; en: string }> = [
  {
    ur: 'متاثرہ جگہ پر کپڑے میں لپٹی برف سے 10 سے 15 منٹ ہلکی ٹکور کریں۔',
    en: 'Apply an ice pack wrapped in cloth to the area for 10–15 minutes.',
  },
  {
    ur: 'چوٹ والی جگہ پر بلاوجہ مالش یا سخت دباؤ نہ ڈالیں۔',
    en: 'Avoid massaging or applying firm pressure directly on the bruise.',
  },
  {
    ur: 'سوجن کم کرنے کے لیے عضو کو ہلکا اونچا رکھیں۔',
    en: 'Elevate the affected limb slightly to reduce swelling.',
  },
]

const CUT_STEPS: Array<{ ur: string; en: string }> = [
  {
    ur: 'زخم کو صاف پانی اور صابن سے دھو لیں۔',
    en: 'Rinse the wound thoroughly with clean water and soap.',
  },
  {
    ur: 'اینٹی سیپٹک لگا کر سنی پلاسٹ (Saniplast / Bandage) چپکا دیں۔',
    en: 'Apply antiseptic and cover with a bandage (Saniplast).',
  },
]

const GENERIC_STEPS: Array<{ ur: string; en: string }> = [
  {
    ur: 'آرام کریں اور متاثرہ جگہ کو غیر ضروری حرکت سے بچائیں۔',
    en: 'Rest and avoid unnecessary movement of the affected area.',
  },
  {
    ur: 'علامات پر نظر رکھیں۔ اگر درد یا سوجن بڑھے تو ڈاکٹر سے رجوع کریں۔',
    en: 'Monitor symptoms. Consult a doctor if pain or swelling increases.',
  },
]

function SelfCareCard({
  triage,
  onCallAnyway,
}: {
  triage: import('../lib/types').TriageAnalysisResponse | null
  onCallAnyway: () => void
}) {
  const { lang } = useCockpit()
  const injuryType = getTrivialInjuryType(triage)
  const steps =
    injuryType === 'bruise' ? BRUISE_STEPS
    : injuryType === 'cut'  ? CUT_STEPS
    : GENERIC_STEPS

  const titleUr =
    injuryType === 'bruise' ? 'فوری گھریلو دیکھ بھال — چوٹ / نیلاہٹ (ضروری تدابیر)'
    : injuryType === 'cut'  ? 'فوری گھریلو دیکھ بھال — معمولی کٹ / خراش (ضروری تدابیر)'
    : 'فوری گھریلو دیکھ بھال (ضروری تدابیر)'

  return (
    <div className="mt-6 overflow-hidden rounded-2xl border border-emerald-500/40 bg-emerald-950/25 shadow-sm">

      {/* ── Disabled dispatch indicator ─────────────────────────────── */}
      <div className="flex w-full cursor-not-allowed items-center justify-center gap-3 bg-slate-700/60 px-5 py-4 opacity-55">
        <span className="text-xl">🚫</span>
        <span dir="rtl" className="font-urdu text-[17px] leading-8 font-bold text-slate-300">
          ایمرجنسی ڈسپیچ غیر فعال ہے
        </span>
        <span className="text-xs font-semibold text-slate-400">(Dispatch not required)</span>
      </div>

      {/* ── Home-care action pill ────────────────────────────────────── */}
      <div className="flex items-center gap-3 border-b border-emerald-500/20 bg-emerald-500/10 px-5 py-4">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-emerald-500/30 bg-emerald-500/20 text-2xl">
          🩹
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-base font-bold text-emerald-200">
            <span dir="rtl" className="font-urdu text-[16px] leading-7">
              {titleUr}
            </span>
          </h3>
          <p className="text-[11px] text-emerald-300/80">
            {lang === 'ur' ? 'گھریلو طبی امداد کافی ہے (Home Care Sufficient)' : 'Home Care Sufficient — Minor Injury'}
          </p>
        </div>
        <span className="shrink-0 rounded-full border border-emerald-500/40 bg-emerald-500/20 px-2.5 py-1 text-[10px] font-bold text-emerald-300">
          ✅ MINOR
        </span>
      </div>

      {/* ── Dynamic per-injury instructions ─────────────────────────── */}
      <ul className="space-y-3 px-5 py-4">
        {steps.map((step, idx) => (
          <li key={idx} className="flex items-start gap-3">
            <span className="mt-2 h-2 w-2 shrink-0 rounded-full bg-emerald-400" />
            <div className="min-w-0 flex-1">
              <p dir="rtl" className="font-urdu text-[14px] leading-7 text-emerald-100">
                {step.ur}
              </p>
              <p className="mt-0.5 text-[11px] leading-5 text-emerald-300/70">{step.en}</p>
            </div>
          </li>
        ))}
      </ul>

      {/* ── Bottom disclaimer ───────────────────────────────────────── */}
      <div className="border-t border-emerald-500/20 bg-emerald-950/30 px-5 py-3">
        <p dir="rtl" className="font-urdu text-[13px] leading-6 font-semibold text-emerald-300">
          اس معمولی تکلیف کے لیے ہسپتال یا ایمرجنسی کال کی ضرورت نہیں ہے۔
        </p>
        <p className="mt-0.5 text-[11px] text-emerald-400/70">
          This minor condition does not require emergency dispatch.
        </p>
      </div>

      {/* ── Override text-link ──────────────────────────────────────── */}
      <div className="border-t border-slate-700/50 px-5 py-3 text-center">
        <button
          type="button"
          onClick={onCallAnyway}
          className="text-[12px] font-medium text-slate-500 underline underline-offset-2 transition-colors hover:text-rose-300"
        >
          <span dir="rtl" className="font-urdu text-[13px] leading-6">
            اگر درد یا سوجن بگڑ جائے تو مدد طلب کریں
          </span>
          <span className="ml-1 font-sans text-[11px]">(Request help only if symptoms worsen)</span>
        </button>
      </div>
    </div>
  )
}

// ===========================================================================
// Critical time-sensitive bystander intervention
// ===========================================================================

type CriticalBystanderType =
  | 'cardiac_arrest'
  | 'heart_attack'
  | 'stroke'
  | 'seizure'
  | 'choking'
  | 'unresponsive'

const CARDIAC_ARREST_FLAGS = new Set(['cardiac_arrest', 'cardiac arrest', 'heart stopped', 'no pulse'])
const HEART_ATTACK_FLAGS   = new Set(['heart_attack', 'heart attack', 'myocardial_infarction'])
const STROKE_FLAGS         = new Set(['stroke', 'cva', 'cerebrovascular_accident', 'paralysis'])
const SEIZURE_FLAGS        = new Set(['seizure', 'fits', 'convulsion', 'epilepsy'])
const CHOKING_FLAGS        = new Set(['choking', 'airway_obstruction', 'foreign_body_airway'])
const UNRESPONSIVE_FLAGS   = new Set(['unresponsive', 'unconscious', 'not_breathing', 'no_breathing'])

/**
 * Returns the critical bystander type for life-threatening time-sensitive
 * emergencies. Returns null for non-critical / minor injuries.
 * Order matters: cardiac_arrest (CPR) checked before heart_attack.
 */
function getCriticalBystanderType(
  triage: import('../lib/types').TriageAnalysisResponse | null
): CriticalBystanderType | null {
  if (!triage) return null
  if (triage.severity_tier === 'minor') return null

  const flags = (triage.injury_type_flags ?? []).map((f) => f.toLowerCase())
  const desc  = (triage.detected_emergency ?? '').toLowerCase()

  const hit = (flagSet: Set<string>, keywords: string[]): boolean =>
    flags.some((f) => flagSet.has(f)) || keywords.some((kw) => desc.includes(kw))

  if (hit(CARDIAC_ARREST_FLAGS, ['cardiac arrest', 'heart stopped', 'no pulse', 'no heartbeat',
      'دل بند', 'سی پی آر', 'نبض نہیں']))
    return 'cardiac_arrest'
  if (hit(UNRESPONSIVE_FLAGS, ['unresponsive', 'unconscious', 'not breathing', 'no breathing',
      'بے ہوش', 'سانس نہیں', 'بے ہوشی']))
    return 'unresponsive'
  if (hit(HEART_ATTACK_FLAGS, ['heart attack', 'chest pain', 'دل کا دورہ', 'سینے میں درد',
      'سینے میں شدید درد']))
    return 'heart_attack'
  if (hit(STROKE_FLAGS, ['stroke', 'paralysis', 'facial droop', 'فالج', 'لقوہ',
      'فالج کا حملہ', 'چہرے کا ٹیڑھا ہونا']))
    return 'stroke'
  if (hit(SEIZURE_FLAGS, ['seizure', 'fits', 'convulsion', 'دورہ', 'مرگی', 'جھٹکے',
      'دورے پڑنا']))
    return 'seizure'
  if (hit(CHOKING_FLAGS, ['choking', 'airway', 'دم گھٹنا', 'گلے میں پھنسنا', 'سانس بند']))
    return 'choking'

  return null
}

// ---------------------------------------------------------------------------
// Per-type step content
// ---------------------------------------------------------------------------

const BYSTANDER_STEPS: Record<CriticalBystanderType, Array<{ ur: string; en: string }>> = {
  cardiac_arrest: [
    { ur: 'مریض کے کندھے کو تھپتھپا کر پکاریں۔ اگر مریض بے ہوش ہے اور سانس نہیں لے رہا تو فوراً سی پی آر (CPR) شروع کریں۔',
      en: 'Tap shoulder and shout. If unresponsive and not breathing normally, start CPR immediately.' },
    { ur: 'مریض کو سخت فرش پر سیدھا لٹائیں، ایک ہاتھ کی ہتھیلی سینے کے بالکل درمیان (سینے کی ہڈی پر) رکھیں اور دوسرا ہاتھ اوپر جکڑ لیں۔',
      en: 'Place heel of one hand in the center of the chest (sternum), interlock the other hand on top.' },
    { ur: 'کہنیاں سیدھی رکھ کر سینے کو 2 انچ گہرا اور تیز رفتار سے دبائیں (100 سے 120 بار فی منٹ)۔ سینے کو ہر بار اوپر آنے دیں۔',
      en: 'Push hard and fast (100–120 compressions/min, 2 inches deep), letting chest fully recoil.' },
    { ur: 'جب تک ایمبولینس یا مددگار نہ پہنچ جائے، سینہ دبانا ہرگز مت روکیں۔ اگر مریض ہوش میں ہے تو اسے ٹیک لگا کر بٹھائے رکھیں۔',
      en: 'Do not stop compressions until emergency help arrives. If conscious, keep them rested semi-reclined.' },
  ],
  unresponsive: [
    { ur: 'مریض کے کندھے کو تھپتھپا کر پکاریں۔ اگر مریض بے ہوش ہے اور سانس نہیں لے رہا تو فوراً سی پی آر (CPR) شروع کریں۔',
      en: 'Tap shoulder and shout. If unresponsive and not breathing normally, start CPR immediately.' },
    { ur: 'مریض کو سخت فرش پر سیدھا لٹائیں، ایک ہاتھ کی ہتھیلی سینے کے بالکل درمیان (سینے کی ہڈی پر) رکھیں اور دوسرا ہاتھ اوپر جکڑ لیں۔',
      en: 'Place heel of one hand in the center of the chest (sternum), interlock the other hand on top.' },
    { ur: 'اگر سانس چل رہی ہو تو مریض کو ایک کروٹ پر لٹائیں (Recovery Position) تاکہ قے یا لعاب سے دم نہ گھٹے۔',
      en: 'If breathing normally, turn onto side (Recovery Position) to keep airway clear.' },
  ],
  heart_attack: [
    { ur: 'مریض کے کندھے کو تھپتھپا کر پکاریں۔ اگر مریض بے ہوش ہے اور سانس نہیں لے رہا تو فوراً سی پی آر (CPR) شروع کریں۔',
      en: 'Tap shoulder and shout. If unresponsive and not breathing normally, start CPR immediately.' },
    { ur: 'مریض کو سخت فرش پر سیدھا لٹائیں، ایک ہاتھ کی ہتھیلی سینے کے بالکل درمیان (سینے کی ہڈی پر) رکھیں اور دوسرا ہاتھ اوپر جکڑ لیں۔',
      en: 'Place heel of one hand in the center of the chest (sternum), interlock the other hand on top.' },
    { ur: 'کہنیاں سیدھی رکھ کر سینے کو 2 انچ گہرا اور تیز رفتار سے دبائیں (100 سے 120 بار فی منٹ)۔ سینے کو ہر بار اوپر آنے دیں۔',
      en: 'Push hard and fast (100–120 compressions/min, 2 inches deep), letting chest fully recoil.' },
    { ur: 'جب تک ایمبولینس یا مددگار نہ پہنچ جائے، سینہ دبانا ہرگز مت روکیں۔ اگر مریض ہوش میں ہے تو اسے ٹیک لگا کر بٹھائے رکھیں۔',
      en: 'Do not stop compressions until emergency help arrives. If conscious, keep them rested semi-reclined.' },
  ],
  stroke: [
    { ur: 'چہرہ، بازو، بولنا چیک کریں (FAST): چہرہ ٹیڑھا؟ ایک بازو کمزور؟ بولنے میں دشواری؟',
      en: 'Check FAST — Face droop, Arm weakness, Speech difficulty, Time to call.' },
    { ur: 'مریض کو لٹائیں — سر اور کندھے ہلکے اونچے رکھیں۔',
      en: 'Lay the patient down with head and shoulders slightly raised.' },
    { ur: 'منہ میں کچھ نہ دیں، پانی بھی نہیں — نگلنے کی صلاحیت متاثر ہو سکتی ہے۔',
      en: 'Do not give anything by mouth — swallowing may be impaired.' },
  ],
  seizure: [
    { ur: 'مریض کے آس پاس سے خطرناک، سخت اور تیز دھار چیزیں فوراً ہٹا دیں تاکہ چوٹ نہ لگے۔',
      en: 'Clear the area of hard, sharp, or dangerous objects around the patient to prevent injury.' },
    { ur: 'منہ میں چمچ، کپڑا یا انگلیاں ٹھونسنے کی ہرگز کوشش نہ کریں۔',
      en: 'Never put anything (spoon, cloth, fingers) in the patient\'s mouth during a seizure.' },
    { ur: 'دورہ (جھٹکے) رکنے کے بعد مریض کو ایک کروٹ پر لٹائیں (Recovery Position) تاکہ سانس کی نالی صاف رہے۔',
      en: 'After shaking stops, turn the patient onto their side (recovery position) to keep airway clear.' },
  ],
  choking: [
    { ur: 'مریض کی پشت پر دونوں کندھوں کے درمیان 5 بار زور سے ہتھیلی سے ماریں (Back blows)۔',
      en: 'Give 5 firm back blows between the shoulder blades with the heel of your hand.' },
    { ur: 'اگر رکاوٹ دور نہ ہو تو پیچھے سے مریض کے پیٹ کے اوپری حصے کو اندر اور اوپر کی طرف زور سے دبائیں (Heimlich Maneuver)۔',
      en: 'If still blocked, perform abdominal thrusts from behind — push inward and upward firmly (Heimlich Maneuver).' },
    { ur: 'اگر مریض بے ہوش ہو جائے تو فوری زمین پر لٹا کر CPR (سینہ دبانا) شروع کریں۔',
      en: 'If the patient loses consciousness, lay them flat and begin CPR compressions immediately.' },
  ],
}

const CRITICAL_TITLE_UR: Record<CriticalBystanderType, string> = {
  cardiac_arrest: 'فوری لائف سیونگ تدابیر — دل کی حرکت بند (CPR)',
  unresponsive:   'فوری لائف سیونگ تدابیر — بے ہوش / سانس نہیں',
  heart_attack:   'فوری لائف سیونگ تدابیر — دل کا دورہ',
  stroke:         'فوری لائف سیونگ تدابیر — فالج کا حملہ',
  seizure:        'فوری لائف سیونگ تدابیر — مرگی / دورہ',
  choking:        'فوری لائف سیونگ تدابیر — گلے میں کچھ پھنسنا',
}

const CRITICAL_TITLE_EN: Record<CriticalBystanderType, string> = {
  cardiac_arrest: 'Immediate Life-Saving Steps — Cardiac Arrest (CPR)',
  unresponsive:   'Immediate Life-Saving Steps — Unresponsive / Not Breathing',
  heart_attack:   'Immediate Life-Saving Steps — Heart Attack',
  stroke:         'Immediate Life-Saving Steps — Stroke',
  seizure:        'Immediate Life-Saving Steps — Seizure / Fits',
  choking:        'Immediate Life-Saving Steps — Choking',
}

// ---------------------------------------------------------------------------
// BystanderInterventionCard component
// ---------------------------------------------------------------------------

function BystanderInterventionCard({
  criticalType,
  lang,
}: {
  criticalType: CriticalBystanderType
  lang: 'ur' | 'en'
}) {
  const steps = BYSTANDER_STEPS[criticalType]

  return (
    <div className="mt-5 overflow-hidden rounded-2xl border-2 border-rose-500/70 bg-rose-950/30 shadow-[0_0_24px_rgba(239,68,68,0.35)]">

      {/* ── Header ─────────────────────────────────────────────────── */}
      <div className="flex items-start gap-3 border-b border-rose-500/30 bg-rose-900/40 px-5 py-4">
        <span className="mt-0.5 flex h-11 w-11 shrink-0 animate-pulse items-center justify-center rounded-xl bg-rose-500/25 text-2xl">
          🚨
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="font-bold text-rose-200">
            <span dir="rtl" className="font-urdu text-[16px] leading-7">
              {CRITICAL_TITLE_UR[criticalType]}
            </span>
          </h3>
          <p className="mt-0.5 text-[11px] font-semibold uppercase tracking-wide text-rose-300/80">
            {CRITICAL_TITLE_EN[criticalType]}
          </p>
        </div>
      </div>

      {/* ── Urgency subheading ─────────────────────────────────────── */}
      <div className="bg-amber-900/20 px-5 py-2.5">
        <p dir="rtl" className="font-urdu text-[13px] font-bold leading-6 text-amber-300">
          🕐 مدد پہنچنے تک خود یہ کریں:
        </p>
        <p className="text-[10px] font-semibold text-amber-400/70">
          Act NOW while help is on the way
        </p>
      </div>

      {/* ── Numbered steps ─────────────────────────────────────────── */}
      <ol className="space-y-3 px-5 py-4">
        {steps.map((step, idx) => (
          <li key={idx} className="flex items-start gap-3">
            <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-rose-500/30 text-[12px] font-extrabold text-rose-200">
              {idx + 1}
            </span>
            <div className="min-w-0 flex-1">
              <p dir="rtl" className="font-urdu text-[14px] leading-7 font-semibold text-rose-50">
                {step.ur}
              </p>
              <p className="mt-0.5 text-[11px] leading-5 italic text-rose-300/70">{step.en}</p>
            </div>
          </li>
        ))}
      </ol>

      {/* ── Footer call-to-action ──────────────────────────────────── */}
      <div className="border-t border-rose-500/30 bg-rose-950/40 px-5 py-3">
        <p dir="rtl" className={`font-urdu text-[13px] leading-6 font-bold text-rose-300 ${lang === 'ur' ? '' : 'hidden'}`}>
          ⬇️ نیچے بٹن دبا کر ایمرجنسی فوری رجسٹر کریں — مدد راستے میں ہے۔
        </p>
        <p className="text-[10px] text-rose-400/70">
          Tap the button below to dispatch emergency services immediately.
        </p>
      </div>
    </div>
  )
}
