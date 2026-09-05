/**
 * Focused CORS preflight verification.
 *
 * A browser preflight is only recognised by Starlette's CORSMiddleware when it
 * carries BOTH `Origin` and `Access-Control-Request-Method`. Without them the
 * request falls through to the router and yields 405 — which is what the first
 * smoke run measured, so it proved nothing about CORS. This replays the real
 * browser handshake.
 */

const BASE = (process.argv[2] ?? 'http://localhost:5050').replace(/\/+$/, '')
const V1 = `${BASE}/api/v1`
const ORIGIN = 'http://localhost:5173'

/** [method, path, requested headers] — mirrors what src/lib/api.ts sends. */
const CASES = [
  ['POST', `${V1}/emergency/report`, 'content-type'],
  ['GET', `${V1}/emergency/incident/INC-X/timeline`, ''],
  ['POST', `${V1}/responder/respond`, 'content-type'],
  ['POST', `${V1}/responder/arrived`, 'content-type'],
  ['POST', `${V1}/helpbot/step`, 'content-type'],
  ['POST', `${V1}/responders/RESP-01/verify`, 'content-type'],
  ['POST', `${V1}/emergency/incident/INC-X/close`, 'content-type'],
  ['GET', `${V1}/accountability/responder/RESP-01/performance`, ''],
  ['GET', `${V1}/responders/pending`, ''],
  ['GET', `${BASE}/health`, ''],
]

let pass = 0
let fail = 0

console.log(`\nCORS preflight check -> origin ${ORIGIN} against ${BASE}\n`)

for (const [method, url, reqHeaders] of CASES) {
  const headers = {
    Origin: ORIGIN,
    'Access-Control-Request-Method': method,
  }
  if (reqHeaders) headers['Access-Control-Request-Headers'] = reqHeaders

  const res = await fetch(url, { method: 'OPTIONS', headers })
  const allowOrigin = res.headers.get('access-control-allow-origin')
  const allowMethods = res.headers.get('access-control-allow-methods')
  const allowHeaders = res.headers.get('access-control-allow-headers')

  const good = res.status >= 200 && res.status < 300 && allowOrigin !== null
  if (good) {
    pass += 1
    console.log(`  PASS  ${method} ${url.replace(BASE, '')}`)
    console.log(`        allow-origin=${allowOrigin} methods=${allowMethods} headers=${allowHeaders}`)
  } else {
    fail += 1
    console.log(`  FAIL  ${method} ${url.replace(BASE, '')}`)
    console.log(`        status=${res.status} allow-origin=${allowOrigin ?? 'MISSING'}`)
  }
}

// A real cross-origin GET must also carry the header on the actual response,
// not only on the preflight — otherwise the browser still blocks the read.
const actual = await fetch(`${BASE}/health`, { headers: { Origin: ORIGIN } })
const actualOrigin = actual.headers.get('access-control-allow-origin')
if (actual.status === 200 && actualOrigin !== null) {
  pass += 1
  console.log(`\n  PASS  actual GET /health response is CORS-readable  — allow-origin=${actualOrigin}`)
} else {
  fail += 1
  console.log(`\n  FAIL  actual GET /health  — status=${actual.status} allow-origin=${actualOrigin ?? 'MISSING'}`)
}

console.log(`\n  ${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
