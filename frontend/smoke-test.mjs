/**
 * Live end-to-end smoke test for the cockpit.
 *
 * Replays EXACTLY the payloads src/lib/api.ts puts on the wire (form-encoded
 * report, `action`-based respond, JSON close) against a running backend, so a
 * pass here means the browser will get the same answers.
 *
 * Usage:  node smoke-test.mjs [baseUrl]      (default http://localhost:5050)
 */

const BASE = (process.argv[2] ?? 'http://localhost:5050').replace(/\/+$/, '')
const V1 = `${BASE}/api/v1`
const MEDIA_ROOT = 'D:\\LifeLine Ride\\mockdata'

/** Same construction as src/lib/scenarios.ts -> photoRef()/voiceRef(). */
const PHOTO = `${MEDIA_ROOT}\\media\\photos\\PhotoshopExtension_Image (1).png`
const VOICE = `${MEDIA_ROOT}\\media\\voice\\ungli.mp3`

/** Verified step_done utterance for the heavy_bleeding branch. */
const STEP_DONE = 'ٹھیک ہے، زخم پر کپڑا رکھ کر دباؤ ڈال دیا ہے'
/** Verified escalation utterance for the heavy_bleeding branch. */
const ESCALATE = 'خون نہیں رک رہا اور مریض بے ہوش ہو رہا ہے'

let pass = 0
let fail = 0
const failures = []

function ok(name, detail = '') {
  pass += 1
  console.log(`  PASS  ${name}${detail ? `  — ${detail}` : ''}`)
}
function bad(name, detail) {
  fail += 1
  failures.push(`${name}: ${detail}`)
  console.log(`  FAIL  ${name}  — ${detail}`)
}
function check(name, cond, detail = '') {
  if (cond) ok(name, detail)
  else bad(name, detail || 'assertion failed')
}

async function call(method, url, { body, form, headers = {}, timeoutMs = 90_000 } = {}) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  const started = Date.now()
  try {
    const res = await fetch(url, {
      method,
      signal: ctrl.signal,
      headers: {
        ...(form
          ? { 'Content-Type': 'application/x-www-form-urlencoded' }
          : body !== undefined
            ? { 'Content-Type': 'application/json' }
            : {}),
        ...headers,
      },
      body: form ? form.toString() : body !== undefined ? JSON.stringify(body) : undefined,
    })
    const ms = Date.now() - started
    const text = await res.text()
    let json = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      /* non-JSON body (e.g. audio) */
    }
    return { res, status: res.status, json, text, ms }
  } finally {
    clearTimeout(timer)
  }
}

console.log(`\nLifeLine Ride cockpit smoke test -> ${BASE}\n`)

// ---------------------------------------------------------------------------
// 1. Liveness + CORS preflight
// ---------------------------------------------------------------------------

const health = await call('GET', `${BASE}/health`, { timeoutMs: 8_000 })
check('GET /health', health.status === 200 && health.json?.status === 'ok',
  `status=${health.status} db=${health.json?.db_reachable} responders=${health.json?.responders_loaded}`)

// Starlette's CORSMiddleware only answers a preflight that carries BOTH
// `Origin` and `Access-Control-Request-Method`. Omit them and the OPTIONS
// falls through to the router as an unsupported method (405), which measures
// nothing about CORS. See cors-check.mjs for the full matrix.
const preflight = await call('OPTIONS', `${V1}/emergency/report`, {
  timeoutMs: 8_000,
  headers: {
    Origin: 'http://localhost:5173',
    'Access-Control-Request-Method': 'POST',
    'Access-Control-Request-Headers': 'content-type',
  },
})
const allowOrigin = preflight.res.headers.get('access-control-allow-origin')
check('CORS preflight on /emergency/report',
  preflight.status >= 200 && preflight.status < 300 && allowOrigin !== null,
  `${preflight.status} allow-origin=${allowOrigin ?? 'MISSING'}`)

// ---------------------------------------------------------------------------
// 2. Registry reads used by the BHU view
// ---------------------------------------------------------------------------

const list = await call('GET', `${V1}/responders`)
check('GET /responders', list.status === 200 && Array.isArray(list.json?.responders),
  `${list.json?.responders?.length ?? 0} responders`)

const pending = await call('GET', `${V1}/responders/pending`)
check('GET /responders/pending', pending.status === 200,
  `${pending.json?.count ?? pending.json?.responders?.length ?? '?'} pending`)

// ---------------------------------------------------------------------------
// 3. Report -> triage -> dispatch (form-encoded, cache-backed media)
// ---------------------------------------------------------------------------

/** Build the exact form body src/lib/api.ts:reportEmergency() sends. */
function reportForm(villageId = 'VILLAGE-A') {
  const form = new URLSearchParams()
  form.set('latitude', '30.5833')
  form.set('longitude', '71.4167')
  form.set('village_id', villageId)
  form.set('reporter_id', 'REP-USER-001')
  form.set('photo_ref', PHOTO)
  form.set('voice_ref', VOICE)
  return form
}

const report = await call('POST', `${V1}/emergency/report`, { form: reportForm('VILLAGE-A') })
const incidentId = report.json?.incident?.incident_id
const tier = report.json?.incident?.severity_tier
// 201 Created, not 200 — the route registers a new resource. fetch's res.ok
// (200-299) already accepts it, which is what src/lib/api.ts relies on.
const reportOk = report.status >= 200 && report.status < 300
check('POST /emergency/report', reportOk && Boolean(incidentId),
  reportOk
    ? `${incidentId} tier=${tier} dispatch=${report.json?.dispatch?.status} in ${report.ms}ms (HTTP ${report.status})`
    : `${report.status} ${report.text?.slice(0, 220)}`)

check('triage served from cache (fast, zero quota)', report.ms < 20_000,
  `${report.ms}ms — a live Gemini call would be far slower`)

if (!incidentId) {
  console.log('\nCannot continue without an incident id. Aborting.\n')
  process.exit(1)
}

// ---------------------------------------------------------------------------
// 4. Timeline polling (the 2.5s feed)
// ---------------------------------------------------------------------------

const timeline = await call('GET', `${V1}/emergency/incident/${incidentId}/timeline`, {
  timeoutMs: 8_000,
})
const updates = timeline.json?.updates ?? []
check('GET .../timeline', timeline.status === 200 && updates.length > 0,
  `${updates.length} update(s), status=${timeline.json?.status}`)
check('timeline carries localised message_urdu',
  updates.every((u) => typeof u.message_urdu === 'string' && u.message_urdu.length > 0),
  updates[0]?.message_urdu ? `first: "${updates[0].message_urdu.slice(0, 48)}…"` : 'none')

const record = await call('GET', `${V1}/emergency/incident/${incidentId}`)
check('GET .../incident/{id}', record.status === 200 && Boolean(record.json?.incident),
  `responder=${record.json?.incident?.responder_assigned_id ?? 'none'}`)

// ---------------------------------------------------------------------------
// 5. Responder acknowledgement + arrival
// ---------------------------------------------------------------------------

const responderId =
  record.json?.incident?.responder_assigned_id ??
  report.json?.dispatch?.responder?.responder_id

if (responderId) {
  const accept = await call('POST', `${V1}/responder/respond`, {
    body: { incident_id: incidentId, responder_id: responderId, action: 'accept' },
  })
  check('POST /responder/respond action=accept', accept.status === 200,
    accept.status === 200 ? `in ${accept.ms}ms` : `${accept.status} ${accept.text?.slice(0, 200)}`)

  const arrived = await call('POST', `${V1}/responder/arrived`, {
    body: { incident_id: incidentId, responder_id: responderId },
  })
  check('POST /responder/arrived', arrived.status === 200,
    arrived.json?.arrival_update?.message_urdu?.slice(0, 48) ?? `${arrived.status}`)
} else {
  bad('responder assigned', 'no responder_assigned_id — coverage gap; cannot test accept/arrived')
}

// ---------------------------------------------------------------------------
// 6. Help-bot guidance + TTS audio streaming
// ---------------------------------------------------------------------------

const step1 = await call('POST', `${V1}/helpbot/step`, {
  body: { incident_id: incidentId, responder_transcript: STEP_DONE },
})
check('POST /helpbot/step (step_done)', step1.status === 200 && Boolean(step1.json?.spoken_text_urdu),
  step1.status === 200
    ? `intent=${step1.json?.intent} audio=${step1.json?.audio_url ?? 'none'}`
    : `${step1.status} ${step1.text?.slice(0, 200)}`)

const audioUrl = step1.json?.audio_url
if (audioUrl) {
  const resolved = /^https?:/i.test(audioUrl) ? audioUrl : `${BASE}${audioUrl}`
  const audio = await call('GET', resolved, { timeoutMs: 15_000 })
  check('help-bot audio_url streams', audio.status === 200 && audio.text.length > 0,
    `${audio.status} ${audio.res.headers.get('content-type')} ${audio.text.length}B`)
} else {
  bad('help-bot audio_url', 'response carried no audio_url — the <audio> player would be empty')
}

const step2 = await call('POST', `${V1}/helpbot/step`, {
  body: { incident_id: incidentId, responder_transcript: ESCALATE },
})
check('POST /helpbot/step (escalation)', step2.status === 200,
  `intent=${step2.json?.intent} escalated=${step2.json?.escalated}`)
check('escalation flag drives the ambulance badge', step2.json?.escalated === true,
  `escalated=${step2.json?.escalated}`)

const afterEsc = await call('GET', `${V1}/emergency/incident/${incidentId}/timeline`, {
  timeoutMs: 8_000,
})
check('timeline reflects mid_incident_escalated',
  afterEsc.json?.mid_incident_escalated === true,
  `mid_incident_escalated=${afterEsc.json?.mid_incident_escalated}`)

// ---------------------------------------------------------------------------
// 7. Accountability scorecard
// ---------------------------------------------------------------------------

if (responderId) {
  const perf = await call('GET', `${V1}/accountability/responder/${responderId}/performance`)
  const dm = perf.json?.dispatch_metrics
  check('GET /accountability/.../performance', perf.status === 200 && Boolean(dm),
    perf.status === 200
      ? `accept=${dm?.acceptance_rate_pct}% avg=${perf.json?.average_response_time_seconds}s timeouts=${perf.json?.timeout_count}`
      : `${perf.status} ${perf.text?.slice(0, 200)}`)
}

// ---------------------------------------------------------------------------
// 8. Closure + Module 5 fraud gate
// ---------------------------------------------------------------------------

const close = await call('POST', `${V1}/emergency/incident/${incidentId}/close`, {
  body: { outcome: 'taken_to_bhu', confirmed_by: 'bhu_staff', closed_by_id: 'bhu_staff_01' },
})
const snap = close.json?.incident
check('POST .../close (bhu_staff)', close.status === 200 && Boolean(snap),
  close.status === 200
    ? `HTTP 200`
    : `${close.status} ${close.text?.slice(0, 200)}`)

// Incident carries no `status` field — closure is expressed through these three.
check('closure recorded on the incident snapshot',
  snap?.outcome === 'taken_to_bhu' &&
    snap?.outcome_confirmed_by === 'bhu_staff' &&
    Boolean(snap?.incident_closed_timestamp),
  `outcome=${snap?.outcome} confirmed_by=${snap?.outcome_confirmed_by} closed_at=${snap?.incident_closed_timestamp ?? 'MISSING'}`)

// BHU-verified closure MUST award Module 5 metrics (the fraud gate's positive case).
check('bhu_staff closure awarded Module 5 outcome record',
  close.json?.outcome_recorded !== null && close.json?.outcome_recorded !== undefined,
  close.json?.outcome_recorded ? 'outcome_recorded present' : 'outcome_recorded was null')

check('closed_by_id echoed for the audit trail',
  close.json?.closed_by_id === 'bhu_staff_01', `closed_by_id=${close.json?.closed_by_id}`)

// Re-closing must be refused: closed records are immutable.
const reClose = await call('POST', `${V1}/emergency/incident/${incidentId}/close`, {
  body: { outcome: 'taken_to_bhu', confirmed_by: 'bhu_staff', closed_by_id: 'bhu_staff_01' },
})
check('closed incident is immutable', reClose.status === 409 && reClose.json?.code === 'ALREADY_CLOSED',
  `${reClose.status} ${reClose.json?.code ?? ''}`)

// --- Phase 2: a FRESH open incident, so outcome validation is actually reached.
// Testing these on the already-closed incident above would short-circuit at
// ALREADY_CLOSED and pass for the wrong reason.
const report2 = await call('POST', `${V1}/emergency/report`, { form: reportForm('VILLAGE-B') })
const incident2 = report2.json?.incident?.incident_id
check('second incident registered for fraud-gate test', Boolean(incident2),
  `${incident2 ?? report2.text?.slice(0, 160)}`)

if (incident2) {
  // The brief used underscore literals; the backend tuple uses a HYPHEN.
  // types.ts encodes the hyphenated form — prove the underscore one is refused.
  const badOutcome = await call('POST', `${V1}/emergency/incident/${incident2}/close`, {
    body: { outcome: 'self_resolved', confirmed_by: 'bhu_staff', closed_by_id: 'bhu_staff_01' },
  })
  check('underscore outcome literal "self_resolved" is rejected',
    badOutcome.status === 400 && badOutcome.json?.code === 'VALIDATION_ERROR',
    `${badOutcome.status} ${badOutcome.json?.code ?? ''} ${badOutcome.json?.message?.slice(0, 90) ?? ''}`)

  // Self-reported closure succeeds but must NOT count toward metrics.
  const selfClose = await call('POST', `${V1}/emergency/incident/${incident2}/close`, {
    body: { outcome: 'self-resolved', confirmed_by: 'responder', closed_by_id: 'RESP-01' },
  })
  check('hyphenated "self-resolved" accepted', selfClose.status === 200,
    selfClose.status === 200 ? `HTTP 200` : `${selfClose.status} ${selfClose.text?.slice(0, 160)}`)
  check('fraud gate: responder-confirmed closure awards NO metrics',
    selfClose.json?.outcome_recorded === null,
    `outcome_recorded=${JSON.stringify(selfClose.json?.outcome_recorded)}`)
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${'-'.repeat(64)}`)
console.log(`  ${pass} passed, ${fail} failed`)
if (failures.length) {
  console.log('\n  Failures:')
  for (const f of failures) console.log(`   - ${f}`)
}
console.log(`${'-'.repeat(64)}\n`)

process.exit(fail === 0 ? 0 : 1)
