import type { Role } from '../state/CockpitContext'
import { useCockpit } from '../state/CockpitContext'
import { REPORTABLE_VILLAGES, BHUS } from '../lib/geography'

const ROLES: Array<{
  role: Role
  icon: string
  titleEn: string
  titleUr: string
  bodyEn: string
  bodyUr: string
  ctaEn: string
  ctaUr: string
  className: string
}> = [
  {
    role: 'reporter',
    icon: '🚨',
    titleEn: 'I Need Emergency Help',
    titleUr: 'مجھے ہنگامی مدد چاہیے',
    bodyEn: 'Report an emergency in Urdu and get connected to nearby help.',
    bodyUr: 'اردو میں ایمرجنسی رپورٹ کریں اور قریبی مدد سے منسلک ہوں۔',
    ctaEn: 'Report Emergency',
    ctaUr: 'ایمرجنسی رپورٹ کریں',
    className: 'border-rose-500/35 hover:border-rose-500/70 hover:bg-rose-500/5',
  },
  {
    role: 'responder',
    icon: '🛵',
    titleEn: 'I Am a Responder',
    titleUr: 'میں رسپانڈر ہوں',
    bodyEn: 'Receive nearby emergencies, navigate to the scene, and help safely.',
    bodyUr: 'قریبی ایمرجنسیز حاصل کریں، جائے وقوعہ تک پہنچیں اور مدد فراہم کریں۔',
    ctaEn: 'Open Responder',
    ctaUr: 'رسپانڈر کھولیں',
    className: 'border-sky-500/35 hover:border-sky-500/70 hover:bg-sky-500/5',
  },
  {
    role: 'bhu',
    icon: '🏥',
    titleEn: 'I Work at a Health Facility',
    titleUr: 'میں مرکزِ صحت میں کام کرتا ہوں',
    bodyEn: 'Monitor incoming cases, prepare for arrival, and close verified outcomes.',
    bodyUr: 'آنے والے کیسز دیکھیں، تیاری کریں اور تصدیق شدہ نتیجہ درج کریں۔',
    ctaEn: 'Open BHU',
    ctaUr: 'مرکزِ صحت کھولیں',
    className: 'border-emerald-500/35 hover:border-emerald-500/70 hover:bg-emerald-500/5',
  },
]

export function LandingView() {
  const { lang, enterRole, navigate } = useCockpit()

  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6 sm:py-16">
      <section className="mx-auto max-w-3xl text-center">
        <div className="mx-auto inline-flex items-center gap-2 rounded-full border border-slate-800 bg-surface px-3 py-1.5 text-[11px] font-semibold text-ink-muted">
          <span className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
          {lang === 'ur' ? 'ٹمن، تلہ گنگ کے لیے اردو فرسٹ نیٹ ورک' : 'Urdu-first emergency network for Tamman, Talagang'}
        </div>

        <h1 className="mt-6 text-balance text-4xl font-extrabold tracking-[-0.04em] text-ink sm:text-6xl">
          {lang === 'ur' ? (
            <span dir="rtl" className="font-urdu text-[37px] leading-[2.1] sm:text-[48px]">
              مشکل وقت میں مدد، آپ کے قریب
            </span>
          ) : (
            <>Emergency help, <span className="text-sky-400">closer to home.</span></>
          )}
        </h1>

        <p className="mx-auto mt-5 max-w-2xl text-[15px] leading-7 text-ink-muted sm:text-base">
          {lang === 'ur' ? (
            <span dir="rtl" className="font-urdu text-[16px] leading-9">
              LifeLine Ride دیہی علاقوں میں ایمرجنسی رپورٹ، تصدیق شدہ رسپانڈر اور قریبی مرکزِ صحت کو ایک مربوط نظام میں جوڑتا ہے۔
            </span>
          ) : (
            'LifeLine Ride connects rural emergency reporting, verified responders, and nearby health facilities in one coordinated flow.'
          )}
        </p>
      </section>

      <section className="mt-10 grid gap-4 md:grid-cols-3" aria-label="Choose your role">
        {ROLES.map((item) => {
          const title = lang === 'ur' ? item.titleUr : item.titleEn
          const body = lang === 'ur' ? item.bodyUr : item.bodyEn
          const cta = lang === 'ur' ? item.ctaUr : item.ctaEn
          return (
            <button
              key={item.role}
              type="button"
              onClick={() => enterRole(item.role)}
              className={`group flex min-h-[265px] flex-col rounded-[22px] border bg-surface p-6 text-left transition-all hover:-translate-y-0.5 ${item.className}`}
            >
              <span className="grid h-12 w-12 place-items-center rounded-2xl border border-slate-700 bg-sunken text-xl" aria-hidden="true">
                {item.icon}
              </span>
              <h2 className="mt-6 text-xl font-bold tracking-tight text-ink">
                {lang === 'ur' ? <span dir="rtl" className="block font-urdu text-[22px] leading-10">{title}</span> : title}
              </h2>
              <p className="mt-3 flex-1 text-sm leading-6 text-ink-muted">
                {lang === 'ur' ? <span dir="rtl" className="block font-urdu text-[14px] leading-9">{body}</span> : body}
              </p>
              <span className="mt-6 inline-flex items-center justify-between rounded-xl bg-raised px-4 py-3 text-sm font-semibold text-ink transition group-hover:bg-accent/15 group-hover:text-sky-300">
                <span>{cta}</span>
                <span aria-hidden="true">→</span>
              </span>
            </button>
          )
        })}
      </section>

      <section className="mx-auto mt-10 max-w-4xl rounded-[22px] border border-slate-800 bg-surface/70 p-5 sm:p-6">
        <div className="grid gap-4 sm:grid-cols-3">
          <MiniStep no="1" titleEn="Report" titleUr="رپورٹ" bodyEn="Urdu voice, photo and location." bodyUr="اردو آواز، تصویر اور مقام۔" />
          <MiniStep no="2" titleEn="Respond" titleUr="مدد" bodyEn="A verified responder is dispatched." bodyUr="تصدیق شدہ رسپانڈر روانہ ہوتا ہے۔" />
          <MiniStep no="3" titleEn="Receive care" titleUr="علاج" bodyEn="The linked health facility is prepared." bodyUr="منسلک مرکزِ صحت تیار رہتا ہے۔" />
        </div>
      </section>

      <section className="mx-auto mt-8 max-w-4xl rounded-2xl border border-slate-800 bg-sunken/60 px-5 py-4 text-center">
        <p className="text-xs font-semibold text-ink-muted">
          {lang === 'ur' ? `ٹمن کے آس پاس ${REPORTABLE_VILLAGES.length} رپورٹنگ مقامات اور ${BHUS.length} صحت سہولیات کا پائلٹ نقشہ` : `Pilot network: ${REPORTABLE_VILLAGES.length} reportable localities around Tamman and ${BHUS.length} mapped health facilities`}
        </p>
        <button type="button" onClick={() => navigate('/operations')} className="mt-2 text-[11px] font-semibold text-sky-400 hover:text-sky-300">
          {lang === 'ur' ? 'ڈیمو / آپریشنز ویو کھولیں' : 'Open demo / operations view'}
        </button>
      </section>

      <p className="mx-auto mt-8 max-w-2xl text-center text-[11px] leading-6 text-ink-dim">
        {lang === 'ur' ? (
          <span dir="rtl" className="font-urdu text-[13px] leading-8">یہ نظام مدد اور رسپانس کو مربوط کرتا ہے؛ طبی تشخیص کا حتمی فیصلہ مرکزِ صحت کے عملے کا ہے۔</span>
        ) : (
          'LifeLine Ride coordinates emergency response; final medical judgement remains with qualified health staff.'
        )}
      </p>
    </main>
  )
}

function MiniStep({ no, titleEn, titleUr, bodyEn, bodyUr }: { no: string; titleEn: string; titleUr: string; bodyEn: string; bodyUr: string }) {
  const { lang } = useCockpit()
  return (
    <div className="flex gap-3">
      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-accent/10 text-xs font-bold text-sky-300">{no}</span>
      <div className="min-w-0">
        <p className="text-sm font-bold text-ink">{lang === 'ur' ? <span dir="rtl" className="font-urdu text-[15px]">{titleUr}</span> : titleEn}</p>
        <p className="mt-1 text-xs leading-5 text-ink-muted">{lang === 'ur' ? <span dir="rtl" className="font-urdu text-[12px] leading-7">{bodyUr}</span> : bodyEn}</p>
      </div>
    </div>
  )
}
