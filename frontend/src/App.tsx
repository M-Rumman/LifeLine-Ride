/**
 * Three-panel demo cockpit.
 *
 * The demo directive is explicit: all three views are visible on ONE screen so
 * a judge watches state change across them in real time — report in View 1,
 * the responder flipping busy in View 2, dispatch/closure in View 3. A routed
 * one-screen-at-a-time shell cannot show that, so every panel mounts at once.
 *
 * The panels are self-contained: `ReporterView` owns the live timeline feed and
 * `BhuView` owns the situation map, so no separate aside is needed — mounting
 * the three views keeps both persistently on screen as a side effect.
 *
 * Geometry: three equal columns from `xl` up, each internally scrollable and
 * sticky under the header, so all three panel headings stay in view while any
 * one of them is scrolled. Below `xl` they stack — this is a laptop demo, so
 * the wide layout is the one that matters.
 *
 * Shared state still lives entirely in `CockpitContext`; the panels are pure
 * consumers, which is what makes mounting all three at once safe.
 */

import type { ReactNode } from 'react'

import {
  CockpitProvider,
  ROLES,
  useCockpit,
  type Role,
} from './state/CockpitContext'
import { Header, PANEL_ANCHOR } from './components/Header'
import { ReporterView } from './views/ReporterView'
import { ResponderView } from './views/ResponderView'
import { BhuView } from './views/BhuView'
import type { ToastTone } from './state/CockpitContext'

/** One-line narration cue per panel, shown under the panel title. */
const ROLE_HINT_EN: Record<Role, string> = {
  reporter: 'Capture the injury, confirm the village, and dispatch help.',
  responder: 'Accept the dispatch, navigate in, and follow voice-first first-aid guidance.',
  bhu: 'Track the live situation, verify candidates, and sign the outcome off.',
}

const ROLE_HINT_UR: Record<Role, string> = {
  reporter: 'حادثہ رپورٹ کریں، گاؤں کی تصدیق کریں اور مدد روانہ کریں۔',
  responder: 'ڈسپیچ قبول کریں، موقع پر پہنچیں اور آواز میں پہلی طبی امداد کی ہدایات لیں۔',
  bhu: 'براہِ راست صورتحال دیکھیں، رضاکاروں کی تصدیق کریں اور نتیجہ منظور کریں۔',
}

/**
 * DOM ids of the three panels live in `Header.tsx` next to the role tabs that
 * scroll to them, so a panel and its anchor cannot drift apart.
 */

const TOAST_TONE: Record<ToastTone, string> = {
  info: 'border-slate-700 bg-surface text-slate-100 shadow-panel',
  success: 'border-emerald-500/40 bg-surface text-slate-100 shadow-panel',
  error: 'border-rose-500/40 bg-surface text-slate-100 shadow-panel',
  critical: 'border-rose-500/60 bg-rose-950/80 text-rose-50 shadow-rose',
}

const TOAST_DOT: Record<ToastTone, string> = {
  info: 'bg-sky-500',
  success: 'bg-emerald-500',
  error: 'bg-rose-500',
  critical: 'bg-rose-500',
}

export default function App() {
  return (
    <CockpitProvider>
      <Shell />
    </CockpitProvider>
  )
}

function Shell() {
  return (
    <div className="flex min-h-screen flex-col bg-canvas font-sans" dir="ltr">
      <Header />
      <main className="mx-auto w-full max-w-[1900px] flex-1 px-4 py-5">
        <div className="grid gap-4 xl:grid-cols-3 xl:items-start">
          <Panel role="reporter">
            <ReporterView />
          </Panel>
          <Panel role="responder">
            <ResponderView />
          </Panel>
          <Panel role="bhu">
            <BhuView />
          </Panel>
        </div>
      </main>
      <ToastStack />
    </div>
  )
}

/**
 * One cockpit column: banner + view, in a hairline-bordered well that scrolls
 * internally so the three headings stay level with each other.
 */
function Panel({ role, children }: { role: Role; children: ReactNode }) {
  const stage = ROLES.find((r) => r.id === role) ?? ROLES[0]

  return (
    <section
      id={PANEL_ANCHOR[role]}
      aria-label={stage.label_en}
      className="flex min-w-0 scroll-mt-24 flex-col gap-3 xl:sticky xl:top-[84px] xl:max-h-[calc(100vh-104px)]"
    >
      <RoleBanner
        step={stage.step}
        labelEn={stage.label_en}
        labelUr={stage.label_ur}
        hint={ROLE_HINT_EN[role]}
        hintUr={ROLE_HINT_UR[role]}
      />
      <div className="min-h-0 flex-1 xl:overflow-y-auto xl:pr-1">{children}</div>
    </section>
  )
}

function RoleBanner({
  step,
  labelEn,
  labelUr,
  hint,
  hintUr,
}: {
  step: number
  labelEn: string
  labelUr: string
  hint: string
  hintUr: string
}) {
  const { lang } = useCockpit()
  const primary = lang === 'ur' ? labelUr : labelEn
  const secondary = lang === 'ur' ? labelEn : labelUr

  return (
    <div className="flex items-center gap-3">
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full border border-accent/40 bg-accent/10 text-sm font-bold text-sky-300 tabular-nums">
        {step}
      </span>
      <div className="min-w-0">
        <h2 className="truncate text-base font-bold tracking-tight text-ink">
          <span className={lang === 'ur' ? 'font-urdu text-[17px] leading-8' : ''}>
            {primary}
          </span>
          <span
            className={
              lang === 'ur'
                ? 'ml-2 text-xs font-normal text-ink-dim'
                : 'ml-2 text-xs font-normal text-ink-dim font-urdu'
            }
            dir={lang === 'ur' ? 'ltr' : 'rtl'}
          >
            {secondary}
          </span>
        </h2>
        <p className="truncate text-[11px] text-ink-muted">
          {lang === 'ur' ? hintUr : hint}
        </p>
      </div>
    </div>
  )
}

/** Non-blocking notifications, bottom-right, capped at four by the provider. */
function ToastStack() {
  const { toasts, dismissToast } = useCockpit()
  if (toasts.length === 0) return null

  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed bottom-5 right-5 z-50 flex w-[min(360px,calc(100vw-2.5rem))] flex-col gap-2"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`pointer-events-auto flex animate-fade-rise items-start gap-3 rounded-card border px-4 py-3 ${TOAST_TONE[t.tone]}`}
        >
          <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${TOAST_DOT[t.tone]}`} />
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-bold tracking-tight">{t.title}</p>
            {t.message && (
              <p className="mt-0.5 text-[11px] leading-5 text-ink-muted">{t.message}</p>
            )}
          </div>
          <button
            type="button"
            onClick={() => dismissToast(t.id)}
            aria-label="Dismiss notification"
            className="shrink-0 rounded-full px-1.5 text-ink-dim transition-colors hover:text-ink"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  )
}
