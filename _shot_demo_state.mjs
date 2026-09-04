/**
 * Temporary demo-evidence harness (same status as _verify_demo_flow.py).
 *
 * The IDE's embedded browser is locked to a 545x593 viewport, which is below
 * the cockpit's `xl:` (1280px) breakpoint, so it can only ever show the three
 * panels stacked. This script drives a real headless Chrome at 1600x1000
 * through the live 12-step demo over CDP (Node >=22 ships WebSocket + fetch,
 * so no puppeteer/playwright dependency is needed) and captures two full-page
 * screenshots: the populated mid-demo state and the post-closure scorecard.
 *
 * Usage:  node _shot_demo_state.mjs
 * Requires: backend on :5050 and frontend on :3000 already running, and a free
 * VILLAGE-A responder (run _reset_demo_state.py first if unsure).
 */
import { spawn, spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const CDP_PORT = 9223
const OUT_MID = 'd:\\LifeLine Ride\\verify_demo_mid.png'
const OUT_CLOSED = 'd:\\LifeLine Ride\\verify_demo_closed.png'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------- chrome boot
const chrome = spawn(CHROME, [
  '--headless=new',
  '--disable-gpu',
  '--hide-scrollbars',
  '--force-device-scale-factor=1',
  // Tall viewport: each cockpit column is its own overflow-y-auto container, so
  // extra window height reveals the help-bot log and the closure gate that a
  // 1000px viewport keeps below the fold.
  '--window-size=1600,2400',
  `--remote-debugging-port=${CDP_PORT}`,
  '--user-data-dir=d:\\LifeLine Ride\\.chrome-shot-profile',
  'about:blank',
], { stdio: 'ignore', detached: true })

function killChrome() {
  spawnSync('taskkill', ['/PID', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' })
}

async function pageTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)
      const list = await res.json()
      const t = list.find((x) => x.type === 'page' && x.webSocketDebuggerUrl)
      if (t) return t
    } catch { /* chrome still booting */ }
    await sleep(500)
  }
  throw new Error('no CDP page target on port ' + CDP_PORT)
}

// ------------------------------------------------------------------ cdp client
const target = await pageTarget()
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })

let nextId = 1
const pending = new Map()
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) {
    const p = pending.get(msg.id)
    pending.delete(msg.id)
    msg.error ? p.rej(new Error(JSON.stringify(msg.error))) : p.res(msg.result)
  }
}
function send(method, params = {}) {
  const id = nextId++
  const p = new Promise((res, rej) => pending.set(id, { res, rej }))
  ws.send(JSON.stringify({ id, method, params }))
  return p
}
async function evalJs(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true })
  if (r.exceptionDetails) {
    throw new Error('page exception: ' + JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text))
  }
  return r.result.value
}
const click = (label) => `(function(){
  const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes(${JSON.stringify(label)}) && !x.disabled);
  if(!b) return 'MISSING:${label}'; b.click(); return 'CLICKED:${label}';
})()`
async function waitFor(label, timeoutMs = 25000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    const ok = await evalJs(`!![...document.querySelectorAll('button')].find(b=>b.textContent.includes(${JSON.stringify(label)}) && !b.disabled)`)
    if (ok) return true
    await sleep(700)
  }
  return false
}
const probe = () => evalJs(`(function(){
  const t=document.body.innerText;
  const has=(s)=>!![...document.querySelectorAll('button')].find(b=>b.textContent.includes(s)&&!b.disabled);
  return JSON.stringify({
    accept: has('(Accept)'),
    markArrived: has('(Mark Arrived)'),
    send: has('(Send)'),
    escalation: t.includes('SEVERITY UPGRADED'),
    scorecard: t.includes('VERIFIED INCIDENTS RESPONDED TO') || t.includes('ACCEPTANCE RATE'),
    closed: t.includes('(Closed)'),
  });
})()`)
async function shot(file) {
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
  writeFileSync(file, Buffer.from(r.data, 'base64'))
  console.log('SHOT', file)
}

// ------------------------------------------------------------------ demo drive
try {
  await send('Page.enable')
  await send('Runtime.enable')
  await send('Page.navigate', { url: 'http://localhost:3000' })
  await sleep(5000)
  console.log('loaded:', await probe())

  // Step 2/3 — Quick Demo stages VILLAGE-A + cached media and submits.
  console.log(await evalJs(click('ڈیمو')))
  const gotAccept = await waitFor('(Accept)')
  console.log('dispatch visible:', gotAccept, await probe())

  // Step 5 — Accept.
  console.log(await evalJs(click('(Accept)')))
  await sleep(2000)

  // Step 8 — Mark Arrived.
  console.log('arrived btn:', await waitFor('(Mark Arrived)', 12000))
  console.log(await evalJs(click('(Mark Arrived)')))
  await sleep(2000)

  // Help bot: open the session, then the deterioration utterance (step 9).
  // The composer disables Send while a turn is in flight, so wait for it to
  // re-enable between the opening turn and the typed deterioration turn.
  console.log('start guidance:', await evalJs(click('(Start Guidance)')))
  console.log('send enabled:', await waitFor('(Send)', 20000))
  console.log(await evalJs(`(function(){
    const el=document.querySelector('#panel-responder input[aria-label="Responder Urdu transcript"]');
    if(!el) return 'NO INPUT';
    const set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
    set.call(el,'khoon band nahi ho raha');
    el.dispatchEvent(new Event('input',{bubbles:true}));
    return 'SET';
  })()`))
  console.log(await evalJs(click('(Send)')))
  await sleep(4000)
  console.log('mid-demo:', await probe())
  await shot(OUT_MID)

  // Step 10 — closure defaults are already taken_to_bhu + bhu_staff.
  console.log('close btn:', await waitFor('(Close Incident & Record Audit)', 12000))
  console.log(await evalJs(click('(Close Incident & Record Audit)')))
  await sleep(3500)
  console.log('post-closure:', await probe())
  await shot(OUT_CLOSED)
  console.log('DONE')
} catch (err) {
  console.error('DRIVER FAILED:', err.message)
  process.exitCode = 1
} finally {
  ws.close()
  killChrome()
}
