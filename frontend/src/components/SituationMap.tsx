/**
 * Persistent Live Situation Map (right panel, top).
 *
 * Leaflet + OpenStreetMap rather than Google Maps: the repo's
 * GOOGLE_MAPS_API_KEY lives in the server-side .env, and a browser bundle must
 * never carry it. OSM tiles need no key, so the demo cannot break on a quota or
 * a leaked credential.
 *
 * Marker provenance is deliberately explicit — the reporter pin is the real GPS
 * submitted with the report, while responder and clinic pins are derived from
 * the seed registry's village association because the backend does not stream
 * their live coordinates. The caption below the map says so.
 */

import { useEffect, useMemo, useRef } from 'react'
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
const MINT = '#00ffaa'
const CRITICAL = '#ff4d6d'
const IDLE = '#5350cc'

interface Actor {
  key: string
  position: LatLng
  kind: 'reporter' | 'responder' | 'bhu' | 'idle'
  title: string
  detail: string
  derived: boolean
}

function markerIcon(kind: Actor['kind'], size = 15) {
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

  // -------------------------------------------------------------------------
  // Derive the actors currently on the map
  // -------------------------------------------------------------------------

  const actors = useMemo<Actor[]>(() => {
    const list: Actor[] = []
    const villageId = incident?.gps_location?.village_id ?? null

    // Reporter — real submitted GPS.
    if (incident?.gps_location) {
      list.push({
        key: 'reporter',
        position: {
          lat: incident.gps_location.latitude,
          lng: incident.gps_location.longitude,
        },
        kind: 'reporter',
        title: 'Reporter',
        detail: `${incident.incident_id} · ${incident.gps_location.village_id}`,
        derived: false,
      })
    }

    // Assigned responder — position derived from its village.
    const assignedId =
      incident?.responder_assigned_id ?? timeline?.assigned_responder ?? null
    if (assignedId) {
      const known = responders.find((r) => r.responder_id === assignedId)
      const pos = responderPosition(
        assignedId,
        known?.village ?? villageId ?? 'VILLAGE-A',
      )
      if (pos) {
        list.push({
          key: `responder-${assignedId}`,
          position: pos,
          kind: 'responder',
          title: known?.name ?? assignedId,
          detail: `${assignedId} · ${known?.village ?? 'village unknown'}`,
          derived: true,
        })
      }
    }

    // Linked BHU — the fixed association for this village group.
    const bhuId =
      lastReport?.dispatch?.bhu?.bhu_id ??
      (villageId ? villageById(villageId)?.linked_bhu_id : null)
    const bhu = bhuId ? bhuById(bhuId) : null
    if (bhu) {
      list.push({
        key: bhu.bhu_id,
        position: bhu.location,
        kind: 'bhu',
        title: bhu.name,
        detail: `${bhu.bhu_id} · ${bhu.union_council}`,
        derived: true,
      })
    }

    return list
  }, [incident, responders, timeline, lastReport])

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
    // Incident -> clinic: transfer vector, armed once BHU is notified.
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

    // Leaflet needs an explicit invalidateSize when the panel is laid out
    // after a flex/grid reflow, otherwise tiles render half-blank.
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
          weight: 3,
          opacity: 0.9,
          className: route.live ? 'route-vector' : 'route-vector--static',
        },
      ).addTo(layer)
    }

    for (const actor of [...idleActors, ...actors]) {
      L.marker([actor.position.lat, actor.position.lng], {
        icon: markerIcon(actor.kind, actor.kind === 'idle' ? 10 : 15),
        title: actor.title,
        zIndexOffset: actor.kind === 'idle' ? 0 : 500,
      })
        .bindPopup(
          `<div style="min-width:150px">
             <div style="font-weight:600;letter-spacing:-0.02em">${actor.title}</div>
             <div style="color:#a9a9d4;font-size:11px;margin-top:2px">${actor.detail}</div>
             ${
               actor.derived
                 ? '<div style="color:#a9a9d4;font-size:10px;margin-top:4px;opacity:.8">position derived from village registry</div>'
                 : '<div style="color:#00ffaa;font-size:10px;margin-top:4px">live GPS from report</div>'
             }
           </div>`,
        )
        .addTo(layer)
    }
  }, [actors, idleActors, routes])

  // Fit bounds only when the cast of actors changes — never on every poll, or
  // the map would re-zoom every 2.5s and be unusable to look at.
  useEffect(() => {
    const map = mapRef.current
    if (!map || actors.length === 0) return

    const signature = actors
      .map((a) => `${a.key}@${a.position.lat.toFixed(3)},${a.position.lng.toFixed(3)}`)
      .sort()
      .join('|')
    if (signature === fittedSignature.current) return
    fittedSignature.current = signature

    const bounds = L.latLngBounds(actors.map((a) => [a.position.lat, a.position.lng]))
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
      <div className="flex items-center justify-between gap-3 px-4 pt-3.5 pb-2.5">
        <div>
          <h2 className="text-[13px] font-semibold tracking-tight text-pearl">
            Live Situation Map
          </h2>
          <p dir="rtl" className="text-[12px] text-ash font-urdu leading-6">
            براہِ راست نقشہ
          </p>
        </div>
        <div className="flex items-center gap-2.5">
          <LegendItem color={CRITICAL} label="Reporter" />
          <LegendItem color={CYAN} label="Responder" />
          <LegendItem color={MINT} label="BHU" />
          <LegendItem color={IDLE} label="Registry" dim />
        </div>
      </div>

      <div
        ref={containerRef}
        className="h-[300px] w-full border-y border-iris-border"
        role="application"
        aria-label="Situation map"
      />

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-4 py-2.5 text-[11px] text-ash">
        {legKm !== null && (
          <span className="inline-flex items-center gap-1.5">
            <StatusDot tone="cyan" pulse />
            Responder leg
            <span className="font-semibold text-clinical-cyan tabular-nums">
              {legKm.toFixed(1)} km
            </span>
          </span>
        )}
        {transferKm !== null && (
          <span className="inline-flex items-center gap-1.5">
            <StatusDot tone="mint" />
            BHU transfer
            <span className="font-semibold text-mint-vital tabular-nums">
              {transferKm.toFixed(1)} km
            </span>
          </span>
        )}
        {legKm === null && transferKm === null && (
          <span>
            Awaiting an incident — reporting one pins the reporter, responder and
            clinic and draws the route vectors.
          </span>
        )}
        <span className="ml-auto opacity-70">
          {BHUS.length} clinics · {VILLAGES.length} villages
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
    <span className="inline-flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-ash">
      <span
        className="h-2.5 w-2.5 rounded-full border border-pearl/70"
        style={{ background: color, opacity: dim ? 0.6 : 1 }}
      />
      {label}
    </span>
  )
}
