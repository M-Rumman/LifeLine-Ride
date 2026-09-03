/**
 * Persistent Live Situation Map (right panel, top).
 *
 * Leaflet + OpenStreetMap with smooth client-side mock movement simulation:
 *  - En route responders smoothly advance toward the incident pin along the polyline.
 *  - When ambulance_requested is true, an ambulance marker departs from the BHU pin.
 *  - When arrived, responder marker snaps directly onto the incident pin.
 *  - Palette inverted to clean white card surface with high-contrast labels.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import L from 'leaflet'

import { useCockpit } from '../state/CockpitContext'
import {
  BHUS,
  bhuById,
  distanceKm,
  responderPosition,
  villageById,
  VILLAGES,
  type LatLng,
} from '../lib/geography'
import { StatusDot } from './ui'

const CYAN = '#00b1ff'
const MINT = '#00c885'
const CRITICAL = '#e11d48'
const AMBULANCE = '#f59e0b'
const IDLE = '#818cf8'

interface Actor {
  key: string
  position: LatLng
  kind: 'reporter' | 'responder' | 'bhu' | 'ambulance' | 'idle'
  title: string
  detail: string
  derived: boolean
}

function markerIcon(kind: Actor['kind'], size = 16) {
  if (kind === 'ambulance') {
    return L.divIcon({
      className: '',
      html: `<div class="ll-marker ll-marker--ambulance flex items-center justify-center text-[10px] shadow-lg" style="height:${size + 4}px;width:${size + 4}px;border-radius:9999px;background:#f59e0b;border:2px solid #ffffff;color:#ffffff;display:flex;align-items:center;justify-content:center;">🚑</div>`,
      iconSize: [size + 4, size + 4],
      iconAnchor: [(size + 4) / 2, (size + 4) / 2],
    })
  }

  return L.divIcon({
    className: '',
    html: `<span class="ll-marker ll-marker--${kind}" style="display:block;height:${size}px;width:${size}px"></span>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  })
}

export function SituationMap() {
  const { incident, responders, timeline, lastReport } = useCockpit()

  const containerRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<L.Map | null>(null)
  const layerRef = useRef<L.LayerGroup | null>(null)
  const fittedSignature = useRef<string>('')

  // Animation progress: 0 to 1 for responder & ambulance movement
  const [animProgress, setAnimProgress] = useState(0)

  const status = timeline?.status ?? null
  const isEnRoute = status === 'dispatched' || status === 'responder_en_route' || status === 'en_route'
  const isArrived = Boolean(incident?.responder_arrived_timestamp) || status === 'arrived' || status === 'closed'
  const isAmbulanceRequested = Boolean(incident?.ambulance_requested)

  // -------------------------------------------------------------------------
  // Interpolation Animation Loop (18-second smooth cycle)
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (!isEnRoute && !isAmbulanceRequested) {
      setAnimProgress(0)
      return
    }

    const durationMs = 18_000
    const start = performance.now()

    let frameId: number
    const tick = (now: number) => {
      const elapsed = (now - start) % durationMs
      setAnimProgress(elapsed / durationMs)
      frameId = requestAnimationFrame(tick)
    }

    frameId = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frameId)
  }, [isEnRoute, isAmbulanceRequested])

  // -------------------------------------------------------------------------
  // Derive the actors currently on the map with simulated movement
  // -------------------------------------------------------------------------

  const actors = useMemo<Actor[]>(() => {
    const list: Actor[] = []
    const villageId = incident?.gps_location?.village_id ?? null

    // Reporter — real submitted GPS.
    let reporterPos: LatLng | null = null
    if (incident?.gps_location) {
      reporterPos = {
        lat: incident.gps_location.latitude,
        lng: incident.gps_location.longitude,
      }
      list.push({
        key: 'reporter',
        position: reporterPos,
        kind: 'reporter',
        title: 'Reporter (Emergency Site)',
        detail: `${incident.incident_id} · ${incident.gps_location.village_id}`,
        derived: false,
      })
    }

    // Linked BHU
    const bhuId =
      lastReport?.dispatch?.bhu?.bhu_id ??
      (villageId ? villageById(villageId)?.linked_bhu_id : null)
    const bhu = bhuId ? bhuById(bhuId) : null
    let bhuPos: LatLng | null = null
    if (bhu) {
      bhuPos = bhu.location
      list.push({
        key: bhu.bhu_id,
        position: bhu.location,
        kind: 'bhu',
        title: bhu.name,
        detail: `${bhu.bhu_id} · ${bhu.union_council}`,
        derived: true,
      })
    }

    // Assigned responder — with animated coordinate interpolation along polyline
    const assignedId =
      incident?.responder_assigned_id ?? timeline?.assigned_responder ?? null
    if (assignedId) {
      const known = responders.find((r) => r.responder_id === assignedId)
      const basePos = responderPosition(
        assignedId,
        known?.village ?? villageId ?? 'VILLAGE-A',
      )
      if (basePos) {
        let currentPos = basePos

        if (isArrived && reporterPos) {
          // Snap directly onto the incident pin on arrived
          currentPos = { lat: reporterPos.lat + 0.0002, lng: reporterPos.lng + 0.0002 }
        } else if (isEnRoute && reporterPos) {
          // Smooth interpolated progress toward incident location (e.g. 10% to 90% travel)
          const fraction = Math.min(Math.max(animProgress * 0.9 + 0.05, 0), 0.95)
          currentPos = {
            lat: basePos.lat + (reporterPos.lat - basePos.lat) * fraction,
            lng: basePos.lng + (reporterPos.lng - basePos.lng) * fraction,
          }
        }

        list.push({
          key: `responder-${assignedId}`,
          position: currentPos,
          kind: 'responder',
          title: `${known?.name ?? assignedId} ${isArrived ? '(On Scene)' : isEnRoute ? '(En Route)' : ''}`,
          detail: `${assignedId} · ${isArrived ? 'On Scene' : isEnRoute ? 'Simulated En Route' : 'Assigned'}`,
          derived: true,
        })
      }
    }

    // Ambulance — when requested, departs BHU pin toward incident
    if (isAmbulanceRequested && bhuPos && reporterPos) {
      const fraction = Math.min(Math.max(animProgress * 0.85 + 0.08, 0), 0.92)
      const ambPos: LatLng = {
        lat: bhuPos.lat + (reporterPos.lat - bhuPos.lat) * fraction,
        lng: bhuPos.lng + (reporterPos.lng - bhuPos.lng) * fraction,
      }
      list.push({
        key: 'ambulance-unit',
        position: ambPos,
        kind: 'ambulance',
        title: 'Ambulance Unit (Dispatching from BHU)',
        detail: 'Urgent transfer en route to incident site',
        derived: true,
      })
    }

    return list
  }, [incident, responders, timeline, lastReport, isEnRoute, isArrived, isAmbulanceRequested, animProgress])

  /** Other registered responders, shown dimmed so coverage reads at a glance. */
  const idleActors = useMemo<Actor[]>(() => {
    const assignedId = incident?.responder_assigned_id ?? null
    return responders
      .filter((r) => r.responder_id !== assignedId)
      .map((r): Actor | null => {
        const pos = responderPosition(r.responder_id, r.village)
        if (!pos) return null
        return {
          key: `idle-${r.responder_id}`,
          position: pos,
          kind: 'idle',
          title: r.name,
          detail: `${r.responder_id} · ${r.current_availability_status}`,
          derived: true,
        }
      })
      .filter((a): a is Actor => a !== null)
  }, [responders, incident])

  // -------------------------------------------------------------------------
  // Route vectors
  // -------------------------------------------------------------------------

  const routes = useMemo(() => {
    const reporter = actors.find((a) => a.kind === 'reporter')
    const responder = actors.find((a) => a.kind === 'responder')
    const bhu = actors.find((a) => a.kind === 'bhu')
    if (!reporter) return []

    const out: { key: string; from: LatLng; to: LatLng; color: string; live: boolean }[] = []

    // Responder -> incident: live approach vector while the case is open.
    if (responder) {
      out.push({
        key: 'responder-to-reporter',
        from: responder.position,
        to: reporter.position,
        color: CYAN,
        live: timeline?.status !== 'closed',
      })
    }
    // Incident -> BHU: transfer vector, armed once BHU is notified.
    if (bhu && (incident?.bhu_notified || incident?.ambulance_requested)) {
      out.push({
        key: 'reporter-to-bhu',
        from: reporter.position,
        to: bhu.position,
        color: incident?.ambulance_requested ? CRITICAL : MINT,
        live: timeline?.status !== 'closed',
      })
    }
    return out
  }, [actors, incident, timeline])

  // -------------------------------------------------------------------------
  // Map lifecycle
  // -------------------------------------------------------------------------

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return

    const map = L.map(containerRef.current, {
      center: [VILLAGES[0].center.lat, VILLAGES[0].center.lng],
      zoom: 12,
      zoomControl: true,
      attributionControl: true,
      preferCanvas: false,
    })

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors',
    }).addTo(map)

    layerRef.current = L.layerGroup().addTo(map)
    mapRef.current = map

    const ro = new ResizeObserver(() => map.invalidateSize())
    ro.observe(containerRef.current)

    return () => {
      ro.disconnect()
      map.remove()
      mapRef.current = null
      layerRef.current = null
    }
  }, [])

  // Redraw overlays whenever the actor/route set changes.
  useEffect(() => {
    const layer = layerRef.current
    if (!layer) return
    layer.clearLayers()

    for (const route of routes) {
      L.polyline(
        [
          [route.from.lat, route.from.lng],
          [route.to.lat, route.to.lng],
        ],
        {
          color: route.color,
          weight: 3.5,
          opacity: 0.9,
          className: route.live ? 'route-vector' : 'route-vector--static',
        },
      ).addTo(layer)
    }

    for (const actor of [...idleActors, ...actors]) {
      L.marker([actor.position.lat, actor.position.lng], {
        icon: markerIcon(actor.kind, actor.kind === 'idle' ? 10 : actor.kind === 'ambulance' ? 18 : 16),
        title: actor.title,
        zIndexOffset: actor.kind === 'idle' ? 0 : actor.kind === 'ambulance' ? 600 : 500,
      })
        .bindPopup(
          `<div style="min-width:150px; font-family:inherit;">
             <div style="font-weight:700; color:#0f172a; font-size:13px;">${actor.title}</div>
             <div style="color:#64748b; font-size:11px; margin-top:2px">${actor.detail}</div>
             ${
               actor.derived
                 ? '<div style="color:#64748b; font-size:10px; margin-top:4px; font-style:italic;">live simulated route</div>'
                 : '<div style="color:#059669; font-size:10px; margin-top:4px; font-weight:600;">live GPS from report</div>'
             }
           </div>`,
        )
        .addTo(layer)
    }
  }, [actors, idleActors, routes])

  // Fit bounds only when incident changes
  useEffect(() => {
    const map = mapRef.current
    if (!map || actors.length === 0) return

    const baseActors = actors.filter((a) => a.kind !== 'ambulance')
    const signature = baseActors
      .map((a) => `${a.key}`)
      .sort()
      .join('|')
    if (signature === fittedSignature.current) return
    fittedSignature.current = signature

    const bounds = L.latLngBounds(baseActors.map((a) => [a.position.lat, a.position.lng]))
    map.fitBounds(bounds.pad(0.45), { animate: true, maxZoom: 14 })
  }, [actors])

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  const reporter = actors.find((a) => a.kind === 'reporter')
  const responder = actors.find((a) => a.kind === 'responder')
  const bhu = actors.find((a) => a.kind === 'bhu')
  const legKm =
    reporter && responder ? distanceKm(responder.position, reporter.position) : null
  const transferKm =
    reporter && bhu ? distanceKm(reporter.position, bhu.position) : null

  return (
    <div className="card overflow-hidden">
      <div className="flex items-center justify-between gap-3 px-5 pt-4 pb-3 border-b border-slate-100">
        <div>
          <h2 className="text-[15px] font-bold tracking-tight text-slate-900">
            Live Situation Map
          </h2>
          <p dir="rtl" className="text-[12px] text-slate-500 font-urdu leading-5">
            براہِ راست نقشہ
          </p>
        </div>
        <div className="flex items-center gap-2">
          <LegendItem color={CRITICAL} label="Reporter" />
          <LegendItem color={CYAN} label="Responder" />
          <LegendItem color={MINT} label="BHU" />
          {isAmbulanceRequested && <LegendItem color={AMBULANCE} label="Ambulance" />}
          <LegendItem color={IDLE} label="Registry" dim />
        </div>
      </div>

      <div
        ref={containerRef}
        className="h-[300px] w-full border-b border-slate-200"
        role="application"
        aria-label="Situation map"
      />

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-5 py-3 text-[11px] text-slate-600 bg-slate-50/50">
        {legKm !== null && (
          <span className="inline-flex items-center gap-1.5 font-medium">
            <StatusDot tone="cyan" />
            Responder leg:
            <span className="font-bold text-sky-700 tabular-nums">
              {legKm.toFixed(1)} km
            </span>
          </span>
        )}
        {transferKm !== null && (
          <span className="inline-flex items-center gap-1.5 font-medium">
            <StatusDot tone="mint" />
            BHU transfer:
            <span className="font-bold text-emerald-700 tabular-nums">
              {transferKm.toFixed(1)} km
            </span>
          </span>
        )}
        {legKm === null && transferKm === null && (
          <span className="text-slate-500 italic">
            Awaiting an incident — reporting one pins the reporter, responder and
            BHU with animated route vectors.
          </span>
        )}
        <span className="ml-auto font-medium text-slate-500">
          {BHUS.length} BHUs · {VILLAGES.length} villages
        </span>
      </div>
    </div>
  )
}

function LegendItem({
  color,
  label,
  dim = false,
}: {
  color: string
  label: string
  dim?: boolean
}) {
  return (
    <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-slate-600">
      <span
        className="h-2.5 w-2.5 rounded-full border border-slate-300"
        style={{ background: color, opacity: dim ? 0.6 : 1 }}
      />
      {label}
    </span>
  )
}
