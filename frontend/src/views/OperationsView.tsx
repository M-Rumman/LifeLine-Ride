import { NetworkMap } from '../components/NetworkMap'
import { useCockpit } from '../state/CockpitContext'
import { BhuView } from './BhuView'
import { ReporterView } from './ReporterView'
import { ResponderView } from './ResponderView'

/**
 * Judge/operator surface. This is the intentional home for the synchronized
 * three-role cockpit; ordinary users never need to see this view.
 */
export function OperationsView() {
  const { responders, lang } = useCockpit()

  return (
    <div className="mx-auto flex w-full max-w-[1600px] flex-col gap-5">
      <section className="rounded-[22px] border border-sky-500/20 bg-sky-500/5 px-5 py-4 sm:px-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-sky-400">Operations / Demo</p>
            <h1 className="mt-1 text-2xl font-extrabold tracking-tight text-ink">Live response network</h1>
            <p dir="rtl" className="font-urdu text-[13px] leading-7 text-ink-muted">جج یا آپریٹر کے لیے تینوں کردار ایک ہی واقعے کی حالت دیکھ سکتے ہیں۔</p>
          </div>
          <div className="rounded-xl border border-slate-800 bg-surface px-4 py-2 text-right">
            <p className="text-[10px] uppercase tracking-wider text-ink-dim">Purpose</p>
            <p className="mt-0.5 text-xs font-semibold text-ink">Demo / monitoring only</p>
          </div>
        </div>
      </section>

      <NetworkMap responders={responders} heightClass="h-[380px] md:h-[460px]" />

      <div className="grid items-start gap-5 xl:grid-cols-3">
        <section id="panel-reporter" className="min-w-0">
          <PanelLabel label={lang === 'ur' ? 'رپورٹر' : 'Reporter'} />
          <ReporterView />
        </section>
        <section id="panel-responder" className="min-w-0">
          <PanelLabel label={lang === 'ur' ? 'رسپانڈر' : 'Responder'} />
          <ResponderView />
        </section>
        <section id="panel-bhu" className="min-w-0">
          <PanelLabel label={lang === 'ur' ? 'مرکزِ صحت' : 'BHU'} />
          <BhuView />
        </section>
      </div>
    </div>
  )
}

function PanelLabel({ label }: { label: string }) {
  return (
    <div className="mb-2 flex items-center gap-2 px-1">
      <span className="h-1.5 w-1.5 rounded-full bg-accent" />
      <span className="text-[10px] font-bold uppercase tracking-[0.16em] text-ink-dim">{label}</span>
      <span className="h-px flex-1 bg-slate-800" />
    </div>
  )
}
