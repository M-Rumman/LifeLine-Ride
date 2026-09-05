/**
 * LifeLine Ride application shell.
 *
 * Normal product routes are role-isolated. The old synchronized cockpit is
 * deliberately preserved as /operations for judges, demos, and operators.
 */

import { CockpitProvider, useCockpit } from './state/CockpitContext'
import { Header } from './components/Header'
import { LandingView } from './views/LandingView'
import { ReporterView } from './views/ReporterView'
import { ResponderView } from './views/ResponderView'
import { BhuView } from './views/BhuView'
import { OperationsView } from './views/OperationsView'
import type { ToastTone } from './state/CockpitContext'

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
  const { route, sessionRole, currentRole } = useCockpit()
  const activeRole = currentRole ?? sessionRole

  // Root guard: if no role has been explicitly selected in this active session,
  // or on route '/', ALWAYS render the Role Gateway LandingView (except '/operations').
  const isGateway = !activeRole || route === '/'

  return (
    <div className="flex min-h-screen flex-col bg-canvas font-sans" dir="ltr">
      <Header />
      <main className="w-full flex-1 px-4 py-5 sm:px-6 sm:py-7">
        {route === '/operations' ? (
          <OperationsView />
        ) : isGateway ? (
          <LandingView />
        ) : route === '/report' && activeRole === 'reporter' ? (
          <ReporterView />
        ) : route === '/responder' && activeRole === 'responder' ? (
          <ResponderView />
        ) : route === '/bhu' && activeRole === 'bhu' ? (
          <BhuView />
        ) : (
          <LandingView />
        )}
      </main>
      <ToastStack />
    </div>
  )
}

function ToastStack() {
  const { toasts, dismissToast } = useCockpit()
  if (toasts.length === 0) return null

  return (
    <div aria-live="polite" className="pointer-events-none fixed bottom-5 right-5 z-50 flex w-[min(360px,calc(100vw-2.5rem))] flex-col gap-2">
      {toasts.map((t) => (
        <div key={t.id} className={`pointer-events-auto flex animate-fade-rise items-start gap-3 rounded-card border px-4 py-3 ${TOAST_TONE[t.tone]}`}>
          <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${TOAST_DOT[t.tone]}`} />
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-bold tracking-tight">{t.title}</p>
            {t.message && <p className="mt-0.5 text-[11px] leading-5 text-ink-muted">{t.message}</p>}
          </div>
          <button type="button" onClick={() => dismissToast(t.id)} aria-label="Dismiss notification" className="shrink-0 rounded-full px-1.5 text-ink-dim transition-colors hover:text-ink">×</button>
        </div>
      ))}
    </div>
  )
}
