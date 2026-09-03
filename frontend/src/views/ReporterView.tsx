/**
 * View 1 — Reporter View (Urdu distress reporting).
 *
 * Submits to POST /api/v1/emergency/report, which is FORM-ENCODED with six
 * fields and treats photo_ref + voice_ref as MANDATORY (400 MISSING_PHOTO /
 * MISSING_VOICE_INPUT otherwise). Both refs are server-side paths, not uploads:
 * the API has no file-upload endpoint, so the native pickers preview locally
 * and submit the file name as the ref — which correctly lands in Module 1's
 * fail-safe (moderate + low_confidence_triage) rather than pretending a
 * transfer happened.
 */

import { useMemo, useState } from 'react'

import { useCockpit } from '../state/CockpitContext'
import {
  REPORTABLE_VILLAGES,
  villageById,
  VILLAGES,
} from '../lib/geography'
import {
  photoRef,
  SCENARIOS,
  scenarioById,
  voiceRef,
  type Scenario,
} from '../lib/scenarios'
import { humaniseFlag, tierMeta } from '../lib/urdu'
import type { ReportResponse } from '../lib/types'
import { API_BASE } from '../lib/api'
import {
  Card,
  EmptyState,
  ErrorNote,
  Pill,
  Spinner,
  Tag,
  TierBadge,
} from '../components/ui'

/** Real assets under mockdata/media — the only refs that hit the triage cache. */
const PHOTO_ASSETS = [
  'PhotoshopExtension_Image.png',
  'PhotoshopExtension_Image (1).png',
  'PhotoshopExtension_Image (2).png',
]
const VOICE_ASSETS = ['saanp.mp3', 'taang.mp3', 'ungli.mp3']

export function ReporterView() {
  const { submitReport, incident, lastReport, backendOnline, setRole } = useCockpit()

  const [selectedScenario, setSelectedScenario] = useState<string | null>(null)
  const [villageId, setVillageId] = useState('VILLAGE-A')
  const [photo, setPhoto] = useState(photoRef(PHOTO_ASSETS[1]))
  const [voice, setVoice] = useState(voiceRef(VOICE_ASSETS[2]))
  const [photoPreview, setPhotoPreview] = useState<string | null>(null)
  const [voicePreview, setVoicePreview] = useState<string | null>(null)
  const [reporterId, setReporterId] = useState('REP-USER-001')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [result, setResult] = useState<ReportResponse | null>(null)

  const village = villageById(villageId)
  const [lat, setLat] = useState(String(village?.default_report_gps.lat ?? 31.5204))
  const [lng, setLng] = useState(String(village?.default_report_gps.lng ?? 74.3587))

  /** Presets are cache-backed when their media pair is in .triage_cache. */
  const isCacheBackedPair = useMemo(() => {
    return SCENARIOS.some(
      (s) => s.cache_backed && s.photo_ref === photo && s.voice_ref === voice,
    )
  }, [photo, voice])

  function applyScenario(s: Scenario) {
    setSelectedScenario(s.id)
    setPhoto(s.photo_ref)
    setVoice(s.voice_ref)
    setVillageId(s.village_id)
    const geo = villageById(s.village_id)
    if (geo) {
      setLat(String(geo.default_report_gps.lat))
      setLng(String(geo.default_report_gps.lng))
    }
    setPhotoPreview(null)
    setVoicePreview(null)
    setFailure(null)
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

  // Prefer the freshly submitted result; fall back to the polled record so the
  // panel stays populated after a role switch.
  const shownIncident = result?.incident ?? incident
  const shownDispatch = result?.dispatch ?? null
  const meta = tierMeta(shownIncident?.severity_tier ?? null)

  return (
    <div className="flex flex-col gap-4">
      {/* ---------------- Preset scenario selector ---------------- */}
      <Card
        title="Preset Scenarios"
        titleUr="تیار شدہ منظرنامے"
        subtitle="One click loads media that is already in the backend triage cache — instant and quota-free."
        right={
          <Tag tone={isCacheBackedPair ? 'mint' : 'ash'}>
            {isCacheBackedPair ? 'cache-backed' : 'live AI call'}
          </Tag>
        }
      >
        <div className="grid gap-2.5 sm:grid-cols-2">
          {SCENARIOS.map((s) => {
            const active = selectedScenario === s.id
            const accent =
              s.accent === 'critical'
                ? 'border-tier-critical/55 hover:bg-tier-critical/12'
                : 'border-clinical-cyan/50 hover:bg-clinical-cyan/12'
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => applyScenario(s)}
                className={`flex flex-col gap-1 rounded-card border px-4 py-3 text-left transition-all duration-150 ${accent} ${
                  active
                    ? 'bg-iris-pulse/30 border-iris-glow shadow-glow'
                    : 'bg-iris-canvas/45'
                }`}
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="text-[13px] font-semibold tracking-tight text-pearl">
                    {s.title_en}
                  </span>
                  {s.cache_backed ? (
                    <span className="shrink-0 rounded-full border border-mint-vital/45 bg-mint-vital/10 px-2 py-0.5 text-[9px] uppercase tracking-wider text-mint-vital">
                      instant
                    </span>
                  ) : (
                    <span className="shrink-0 rounded-full border border-clinical-cyan/45 bg-clinical-cyan/10 px-2 py-0.5 text-[9px] uppercase tracking-wider text-clinical-cyan">
                      live AI
                    </span>
                  )}
                </span>
                <span dir="rtl" className="text-[13px] text-ash font-urdu leading-6">
                  {s.title_ur}
                </span>
                <span className="text-[11px] text-ash/75">{s.subtitle_en}</span>
                <span className="mt-1 flex items-center gap-1.5">
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${tierMeta(s.expected_tier).dot}`}
                  />
                  <span className="text-[10px] uppercase tracking-wider text-ash">
                    expected {s.expected_tier} · {s.village_id} · branch{' '}
                    {s.expected_branch}
                  </span>
                </span>
              </button>
            )
          })}
        </div>
      </Card>

      {/* ---------------- Custom ingestion form ---------------- */}
      <Card
        title="Custom Ingestion"
        titleUr="اپنی رپورٹ درج کریں"
        subtitle="Both a photo ref and an Urdu voice-note ref are mandatory — Module 1 never merges STT and vision into one call."
      >
        <div className="grid gap-4 lg:grid-cols-2">
          {/* Photo */}
          <div className="flex flex-col gap-2">
            <label className="label" htmlFor="photo-asset">
              Patient photo
            </label>
            <select
              id="photo-asset"
              className="field-select"
              value={PHOTO_ASSETS.includes(basename(photo)) ? basename(photo) : ''}
              onChange={(e) => {
                if (e.target.value) {
                  setPhoto(photoRef(e.target.value))
                  setSelectedScenario(null)
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
              Upload from this device…
              <input
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  if (!f) return
                  setPhoto(f.name)
                  setSelectedScenario(null)
                  setPhotoPreview(URL.createObjectURL(f))
                }}
              />
            </label>

            {photoPreview ? (
              <img
                src={photoPreview}
                alt="Selected patient photo preview"
                className="h-28 w-full rounded-card border border-iris-border object-cover"
              />
            ) : (
              <p className="truncate font-mono text-[10px] text-ash/70" title={photo}>
                ref: {photo}
              </p>
            )}
          </div>

          {/* Voice */}
          <div className="flex flex-col gap-2">
            <label className="label" htmlFor="voice-asset">
              Urdu voice note
            </label>
            <select
              id="voice-asset"
              className="field-select"
              value={VOICE_ASSETS.includes(basename(voice)) ? basename(voice) : ''}
              onChange={(e) => {
                if (e.target.value) {
                  setVoice(voiceRef(e.target.value))
                  setSelectedScenario(null)
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

            <label className="pill-ghost cursor-pointer px-3.5 py-2 text-xs">
              <UploadIcon />
              Record / upload audio…
              <input
                type="file"
                accept="audio/*"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  if (!f) return
                  setVoice(f.name)
                  setSelectedScenario(null)
                  setVoicePreview(URL.createObjectURL(f))
                }}
              />
            </label>

            {voicePreview ? (
              <audio src={voicePreview} controls className="w-full" />
            ) : (
              <p className="truncate font-mono text-[10px] text-ash/70" title={voice}>
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

        <p className="mt-3 text-[11px] text-ash/75">
          Linked clinic:{' '}
          <span className="text-clinical-cyan">
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
            <span className="text-[11px] text-tier-critical">
              Backend unreachable at {API_BASE} — start it before reporting.
            </span>
          )}
        </div>
      </Card>

      {/* ---------------- Immediate triage display ---------------- */}
      <Card
        title="AI Triage Decision"
        titleUr="ٹرئیج کا نتیجہ"
        subtitle="Inspectable by design — the tier and its reasoning flags are never opaque."
        right={shownIncident ? <TierBadge tier={shownIncident.severity_tier} /> : undefined}
      >
        {!shownIncident ? (
          <EmptyState
            title="No triage result yet"
            titleUr="ابھی کوئی نتیجہ نہیں"
            message="Report an emergency to see the severity tier, extracted injury flags and the dispatch reasoning."
          />
        ) : (
          <div className="flex flex-col gap-4">
            <div
              className={`rounded-card border px-4 py-3.5 ${meta.bg} ${meta.border}`}
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="font-mono text-xs text-ash">
                    {shownIncident.incident_id}
                  </p>
                  <p className="mt-1 text-xl font-semibold tracking-tighter text-pearl">
                    {meta.label_en}
                    <span className="ml-2 text-sm font-medium opacity-75">
                      {meta.tier_no}
                    </span>
                    <span dir="rtl" className="ml-2.5 text-[15px] font-urdu opacity-90">
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
                    className={`tag normal-case tracking-normal ${
                      f === 'low_confidence_triage'
                        ? 'border-ash/45 bg-ash/10 text-ash'
                        : `${meta.border} ${meta.bg} ${meta.text}`
                    }`}
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
                  className="rounded-card border border-iris-border bg-iris-canvas/50 px-4 py-3 text-[15px] leading-8 text-pearl font-urdu"
                >
                  {shownIncident.voice_transcript}
                </p>
              </div>
            )}

            {shownDispatch && (
              <div>
                <p className="label">Module 3 dispatch reasoning</p>
                <div className="rounded-card border border-iris-border bg-iris-canvas/50 px-4 py-3">
                  <p className="text-xs text-pearl">{shownDispatch.reasoning}</p>
                  <div className="mt-2.5 flex flex-wrap gap-2">
                    <Tag tone="cyan">status: {shownDispatch.status}</Tag>
                    {shownDispatch.responder && (
                      <Tag tone="mint">
                        responder: {shownDispatch.responder.name} (
                        {shownDispatch.responder.responder_id})
                      </Tag>
                    )}
                    {shownDispatch.bhu && (
                      <Tag tone="cyan">bhu: {shownDispatch.bhu.name}</Tag>
                    )}
                    {shownDispatch.bhu_urgency && (
                      <Tag tone={shownDispatch.bhu_urgency === 'urgent' ? 'critical' : 'ash'}>
                        urgency: {shownDispatch.bhu_urgency}
                      </Tag>
                    )}
                    <Tag tone={shownDispatch.notify_bhu ? 'mint' : 'ash'}>
                      notify_bhu: {String(shownDispatch.notify_bhu)}
                    </Tag>
                  </div>
                </div>
              </div>
            )}

            {lastReport && (
              <p className="text-[11px] text-ash/75">
                PostgreSQL persistence:{' '}
                <span className={lastReport.db_persisted ? 'text-mint-vital' : 'text-tier-critical'}>
                  {lastReport.db_persisted ? 'written' : 'failed (in-memory only)'}
                </span>
              </p>
            )}

            <div className="flex flex-wrap gap-2">
              <Pill variant="cyan" onClick={() => setRole('responder')}>
                Continue to Responder View →
              </Pill>
              {selectedScenario && scenarioById(selectedScenario) && (
                <span className="self-center text-[11px] text-ash/70">
                  preset: {scenarioById(selectedScenario)?.title_en}
                </span>
              )}
            </div>
          </div>
        )}
      </Card>

      <p className="px-1 text-[10px] text-ash/55">
        {VILLAGES.length} villages registered · mockdata assets resolve against the
        backend's server-side paths.
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
