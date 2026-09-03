/**
 * Unified single-page cockpit.
 *
 * Layout contract from the directive:
 *   Left  (60%) — the active role's workflow view.
 *   Right (40%) — persistent situation map + live Urdu timeline feed.
 *
 * The right column never unmounts when the stepper changes role, and the
 * active incident lives in `CockpitContext` rather than in any view, so all
 * three roles inspect the exact same live record.
 */

import { CockpitProvider, ROLES, useCockpit, type Role } from './state/CockpitContext'
import { Header } from './components/Header'
import { SituationMap } from './components/SituationMap'
import { TimelineFeed } from './components/TimelineFeed'
import { ReporterView } from './views/ReporterView'
import { ResponderView } from './views/ResponderView'
import { BhuView } from './views/BhuView'
import type { ToastTone } from './state/CockpitContext'

/** One-line narration cue per stage, shown above the active view. */
const ROLE_HINT: Record<Role, string> = {
  reporter:
    'Register an Urdu distress report, then read the AI triage verdict and dispatch decision.',
  responder:
    'Accept the dispatch, follow the voice-first help bot, and escalate the moment the patient deteriorates.',
  bhu: 'Verify candidate responders, sign off the outcome, and read the accountability scorecard.',
}

const TOAST_TONE: Record<ToastTone, string> = {
  info: 'border-iris-glow bg-iris-shadow text-pearl',
  success: 'border-mint-vital/55 bg-iris-shadow text-pearl',
  error: 'border-tier-critical/55 bg-iris-shadow text-pearl',
  critical: 'border-tier-critical/70 bg-iris-shadow text-pearl shadow-glow',
}

const TOAST_DOT: Record<ToastTone, string> = {
  info: 'bg-iris-glow',
  success: 'bg-mint-vital',
  error: 'bg-tier-critical',
  critical: 'bg-tier-critical animate-pulse-ring-critical',
}

export default function App() {
  return (
    <CockpitProvider>
      <Cockpit />
    </CockpitProvider>
  )
}

function Cockpit() {
  const { role } = useCockpit()
  const stage = ROLES.find((r) => r.id === role) ?? ROLES[0]

  return (
    <div className="flex min-h-screen flex-col">
      <Header />

      <main className="mx-auto grid w-full max-w-[1800px] flex-1 gap-5 px-5 py-5 lg:grid-cols-[minmax(0,60fr)_minmax(0,40fr)]">
        {/* ---------------- Left panel (60%): active role workflow ---------------- */}
        <div className="flex min-w-0 flex-col gap-4">
          <RoleBanner
            step={stage.step}
            labelEn={stage.label_en}
            labelUr={stage.label_ur}
            hint={ROLE_HINT[role]}
          />
          <RolePanel role={role} />
        </div>

        {/* ---------------- Right panel (40%): persistent map + feed ---------------- */}
        <aside className="flex min-w-0 flex-col gap-4 lg:sticky lg:top-[86px] lg:h-[calc(100vh-106px)] lg:self-start">
          <SituationMap />
          <TimelineFeed />
        </aside>
      </main>

      <ToastStack />
    </div>
  )
}

function RoleBanner({
  step,
  labelEn,
  labelUr,
  hint,
}: {
  step: number
  labelEn: string
  labelUr: string
  hint: string
}) {
  return (
    <div className="card-panel flex items-center gap-4 px-5 py-3.5">
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full border border-clinical-cyan/55 bg-clinical-cyan/12 text-sm font-semibold text-clinical-cyan">
        {step}
      </span>
      <div className="min-w-0">
        <h2 className="truncate text-base font-semibold tracking-tighter text-pearl">
          {labelEn}
          <span dir="rtl" className="ml-2 text-sm font-normal text-ash font-urdu">
            {labelUr}
          </span>
        </h2>
        <p className="truncate text-xs text-ash/85">{hint}</p>
      </div>
    </div>
  )
}

/**
 * Only the active view mounts. That is safe because every piece of shared
 * demo state — incident id, triage result, help-bot transcript, timeline —
 * lives in `CockpitContext`, not in the views.
 */
function RolePanel({ role }: { role: Role }) {
  switch (role) {
    case 'reporter':
      return <ReporterView />
    case 'responder':
      return <ResponderView />
    case 'bhu':
      return <BhuView />
  }
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
          className={`pointer-events-auto flex animate-fade-rise items-start gap-3 rounded-card border px-4 py-3 shadow-panel ${TOAST_TONE[t.tone]}`}
        >
          <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${TOAST_DOT[t.tone]}`} />
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-semibold tracking-tight">{t.title}</p>
            {t.message && (
              <p className="mt-0.5 text-[11px] leading-5 text-ash">{t.message}</p>
            )}
          </div>
          <button
            type="button"
            onClick={() => dismissToast(t.id)}
            aria-label="Dismiss notification"
            className="shrink-0 rounded-full px-1.5 text-ash transition-colors hover:text-pearl"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  )
}
