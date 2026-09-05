import { useEffect, useRef } from 'react'
import L from 'leaflet'
import { BHUS, TALAGANG_VILLAGES, responderPosition } from '../lib/geography'
import type { Responder } from '../lib/types'
import { StatusDot } from './ui'

const VILLAGE = '#38bdf8'
const BHU = '#10b981'
const RESPONDER = '#a78bfa'

function dotIcon(color: string, size: number, pulse = false) {
  return L.divIcon({
    className: '',
    html: `<span style="display:block;width:${size}px;height:${size}px;border-radius:9999px;background:${color};border:2px solid #0a0f1d;box-shadow:0 0 0 3px rgba(10,15,29,.45);${pulse ? `animation:pulse 1.6s infinite;` : ''}"></span>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  })
}

export function NetworkMap({ responders = [], heightClass = 'h-[430px]' }: { responders?: Responder[]; heightClass?: string }) {
  const ref = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<L.Map | null>(null)

  useEffect(() => {
    if (!ref.current || mapRef.current) return

    const map = L.map(ref.current, { zoomControl: true, scrollWheelZoom: true, attributionControl: true })
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 18,
      attribution: '&copy; OpenStreetMap contributors',
    }).addTo(map)

    const points: [number, number][] = []

    TALAGANG_VILLAGES.forEach((v) => {
      points.push([v.center.lat, v.center.lng])
      L.marker([v.center.lat, v.center.lng], { icon: dotIcon(VILLAGE, 11) })
        .bindPopup(`<strong>${v.label_en}</strong><br/><span>${v.label_ur}</span><br/><small>Mapped locality</small>`)
        .addTo(map)
    })

    BHUS.forEach((b) => {
      points.push([b.location.lat, b.location.lng])
      L.marker([b.location.lat, b.location.lng], { icon: dotIcon(BHU, 15) })
        .bindPopup(`<strong>${b.name}</strong><br/><span>${b.name_ur}</span><br/><small>${b.approximate_location ? 'Locality-based map pin' : 'Facility location'}</small>`)
        .addTo(map)
    })

    responders.forEach((r) => {
      const pos = responderPosition(r.responder_id, r.village)
      if (!pos) return
      points.push([pos.lat, pos.lng])
      const live = r.current_availability_status === 'available'
      L.marker([pos.lat, pos.lng], { icon: dotIcon(RESPONDER, 9, live) })
        .bindPopup(`<strong>${r.name}</strong><br/><span>${r.current_availability_status}</span><br/><small>Coverage position: ${r.village}</small>`)
        .addTo(map)
    })

    if (points.length) map.fitBounds(L.latLngBounds(points).pad(0.18), { maxZoom: 11 })
    mapRef.current = map

    return () => {
      map.remove()
      mapRef.current = null
    }
  }, [responders])

  return (
    <section className="overflow-hidden rounded-[22px] border border-slate-800 bg-surface">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 px-5 py-4">
        <div>
          <h2 className="text-[15px] font-bold text-ink">Talagang response network</h2>
          <p dir="rtl" className="font-urdu text-[12px] leading-6 text-ink-muted">ٹمن اور تلہ گنگ کا ریسپانس نیٹ ورک</p>
        </div>
        <div className="flex flex-wrap gap-3 text-[10px] font-semibold text-ink-muted">
          <span className="inline-flex items-center gap-1.5"><StatusDot tone="cyan" /> Villages</span>
          <span className="inline-flex items-center gap-1.5"><StatusDot tone="mint" /> BHUs</span>
          <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-violet-400" /> Responders</span>
          <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-rose-500" /> Incident</span>
        </div>
      </div>
      <div ref={ref} className={`${heightClass} w-full`} aria-label="Talagang response network map" role="application" />
      <div className="border-t border-slate-800 bg-sunken px-5 py-3 text-[10px] leading-5 text-ink-dim">
        Village points use mapped locality coordinates. Facility points use the locality center where an exact facility coordinate is not available; this is intentionally shown as a map aid rather than a claimed survey-grade GPS position.
      </div>
    </section>
  )
}
