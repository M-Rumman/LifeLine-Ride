/**
 * Live Situation Map.
 *
 * Owned by the BHU console (`/bhu`), where it is the top half of the screen.
 * It is deliberately absent from the reporter view so that screen stays
 * single-focus and panic-free.
 *
 * Leaflet + OpenStreetMap with smooth route-based mock movement simulation:
 *  - Static State: Markers remain completely static at origins while awaiting acceptance.
 *  - En Route: Marker smoothly traverses sampled route waypoints toward the incident over ~11s.
 *  - Ambulance: Departs from linked BHU along route toward the incident when requested.
 *  - Arrived: Marker snaps directly onto the incident site coordinates and halts.
 *
 * Direct `marker.setLatLng()` updates avoid full-map re-renders and panning jitter.
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

/** Brand palette. Rose is only ever the reporter pin or an ambulance transfer. */
const CYAN = '#0ea5e9'
const MINT = '#10b981'
const CRITICAL = '#ef4444'
const AMBULANCE = '#f59e0b'
const IDLE = '#64748b'

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
      html: `<div class="ll-marker ll-marker--ambulance flex items-center justify-center text-[10px] shadow-lg" style="height:${size + 4}px;width:${size + 4}px;border-radius:9999px;background:#f59e0b;border:2px solid #0a0f1d;color:#0a0f1d;display:flex;align-items:center;justify-content:center;">🚑</div>`,
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

/**
 * Sample 50–100 intermediate LatLng steps via linear interpolation along the vector
 */
function sampleRouteWaypoints(from: LatLng, to: LatLng, steps = 80): LatLng[] {
  const waypoints: LatLng[] = []
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    waypoints.push({
      lat: from.lat + (to.lat - from.lat) * t,
      lng: from.lng + (to.lng - from.lng) * t,
    })
  }
  return waypoints
}

/**
 * Parametric interpolation along sampled waypoints (progress: 0 -> 1)
 */
function interpolateAtProgress(waypoints: LatLng[], progress: number): LatLng {
  if (waypoints.length === 0) return { lat: 0, lng: 0 }
  const clamped = Math.max(0, Math.min(1, progress))
  const total = waypoints.length - 1
  const exact = clamped * total
  const idx = Math.floor(exact)
  const rem = exact - idx
  if (idx >= total) return waypoints[total]
  const p1 = waypoints[idx]
  const p2 = waypoints[idx + 1]
  return {
    lat: p1.lat + (p2.lat - p1.lat) * rem,
    lng: p1.lng + (p2.lng - p1.lng) * rem,
  }
}

export function SituationMap({
  heightClass = 'h-[300px]',
}: {
  heightClass?: string
} = {}) {
  const { incident, responders, timeline, lastReport } = useCockpit()

  const containerRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<L.Map | null>(null)
  const staticLayerRef = useRef<L.LayerGroup | null>(null)
  const dynamicLayerRef = useRef<L.LayerGroup | null>(null)
  const fittedSignature = useRef<string>('')

  // Dynamic Leaflet object references for direct setLatLng / coordinate updates
  const responderMarkerRef = useRef<L.Marker | null>(null)
  const ambulanceMarkerRef = useRef<L.Marker | null>(null)
  const approachPolylineRef = useRef<L.Polyline | null>(null)
  const ambulancePolylineRef = useRef<L.Polyline | null>(null)
  const rafIdRef = useRef<number | null>(null)

  const status = timeline?.status ?? null
  const isArrived =
    Boolean(incident?.responder_arrived_timestamp) ||
    status === 'responder_arrived' ||
    status === 'arrived' ||
    status === 'closed'

  const isAccepted = useMemo(() => {
    const events = incident?.dispatch_events ?? []
    const acknowledged = events.some((e) => {
      const name = String(e.event ?? e.type ?? '').toLowerCase()
      return name.includes('ack') || name.includes('accept') || name.includes('en_route')
    })
    const enRouteUpdate = (timeline?.updates ?? []).some(
      (u) => u.stage === 'responder_en_route' || u.stage === 'en_route',
    )
    return (
      acknowledged ||
      enRouteUpdate ||
      status === 'responder_en_route' ||
      Boolean(incident?.responder_arrived_timestamp)
    )
  }, [incident, timeline, status])

  const isEnRoute = isAccepted && !isArrived
  const isAmbulanceRequested = Boolean(incident?.ambulance_requested)

  // -------------------------------------------------------------------------
  // Compute Key Actor Coordinates
  // -------------------------------------------------------------------------
  const villageId = incident?.gps_location?.village_id ?? null

  const reporterPos = useMemo<LatLng | null>(() => {
    if (!incident?.gps_location) return null
    return {
      lat: incident.gps_location.latitude,
      lng: incident.gps_location.longitude,
    }
  }, [incident])

  const bhu = useMemo(() => {
    const bhuId =
      lastReport?.dispatch?.bhu?.bhu_id ??
      (villageId ? villageById(villageId)?.linked_bhu_id : null)
    return bhuId ? bhuById(bhuId) : null
  }, [lastReport, villageId])

  const bhuPos = useMemo<LatLng | null>(() => bhu?.location ?? null, [bhu])

  const assignedResponder = useMemo(() => {
    const assignedId =
      incident?.responder_assigned_id ?? timeline?.assigned_responder ?? null
    if (!assignedId) return null
    const known = responders.find((r) => r.responder_id === assignedId)
    const basePos = responderPosition(
      assignedId,
      known?.village ?? villageId ?? 'VILLAGE-A',
    )
    return {
      id: assignedId,
      name: known?.name ?? assignedId,
      basePos,
    }
  }, [incident, responders, timeline, villageId])

  const baseResponderPos = assignedResponder?.basePos ?? null

  // -------------------------------------------------------------------------
  // Static registry idle responders
  // -------------------------------------------------------------------------
  const idleActors = useMemo<Actor[]>(() => {
    const assignedId = assignedResponder?.id ?? null
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
  }, [responders, assignedResponder])

  // -------------------------------------------------------------------------
  // Map Lifecycle Setup
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

    staticLayerRef.current = L.layerGroup().addTo(map)
    dynamicLayerRef.current = L.layerGroup().addTo(map)
    mapRef.current = map

    const ro = new ResizeObserver(() => map.invalidateSize())
    ro.observe(containerRef.current)

    return () => {
      if (rafIdRef.current) cancelAnimationFrame(rafIdRef.current)
      ro.disconnect()
      map.remove()
      mapRef.current = null
      staticLayerRef.current = null
      dynamicLayerRef.current = null
      responderMarkerRef.current = null
      ambulanceMarkerRef.current = null
      approachPolylineRef.current = null
      ambulancePolylineRef.current = null
    }
  }, [])

  // -------------------------------------------------------------------------
  // Redraw Static Overlays (Reporter, BHU, Idle Responders, Transfer Vector)
  // -------------------------------------------------------------------------
  useEffect(() => {
    const staticLayer = staticLayerRef.current
    if (!staticLayer) return
    staticLayer.clearLayers()

    // 1. Reporter Marker
    if (reporterPos && incident) {
      L.marker([reporterPos.lat, reporterPos.lng], {
        icon: markerIcon('reporter', 16),
        title: 'Reporter (Emergency Site)',
        zIndexOffset: 700,
      })
        .bindPopup(
          `<div style="min-width:150px; font-family:inherit;">
             <div style="font-weight:700; color:#f8fafc; font-size:13px;">Reporter (Emergency Site)</div>
             <div style="color:#94a3b8; font-size:11px; margin-top:2px">${incident.incident_id} · ${incident.gps_location.village_id}</div>
             <div style="color:#10b981; font-size:10px; margin-top:4px; font-weight:600;">live GPS from report</div>
           </div>`,
        )
        .addTo(staticLayer)
    }

    // 2. BHU Marker
    if (bhu && bhuPos) {
      L.marker([bhuPos.lat, bhuPos.lng], {
        icon: markerIcon('bhu', 16),
        title: bhu.name,
        zIndexOffset: 500,
      })
        .bindPopup(
          `<div style="min-width:150px; font-family:inherit;">
             <div style="font-weight:700; color:#f8fafc; font-size:13px;">${bhu.name}</div>
             <div style="color:#94a3b8; font-size:11px; margin-top:2px">${bhu.bhu_id} · ${bhu.union_council}</div>
             <div style="color:#64748b; font-size:10px; margin-top:4px; font-style:italic;">linked health center</div>
           </div>`,
        )
        .addTo(staticLayer)
    }

    // 3. Static BHU Transfer Route Vector (when notified / ambulance requested)
    if (reporterPos && bhuPos && (incident?.bhu_notified || incident?.ambulance_requested)) {
      L.polyline(
        [
          [reporterPos.lat, reporterPos.lng],
          [bhuPos.lat, bhuPos.lng],
        ],
        {
          color: incident?.ambulance_requested ? CRITICAL : MINT,
          weight: 3.5,
          opacity: 0.85,
          className: status !== 'closed' ? 'route-vector' : 'route-vector--static',
        },
      ).addTo(staticLayer)
    }

    // 4. Idle Responder Registry Markers
    for (const actor of idleActors) {
      L.marker([actor.position.lat, actor.position.lng], {
        icon: markerIcon('idle', 10),
        title: actor.title,
        zIndexOffset: 0,
      })
        .bindPopup(
          `<div style="min-width:150px; font-family:inherit;">
             <div style="font-weight:700; color:#f8fafc; font-size:13px;">${actor.title}</div>
             <div style="color:#94a3b8; font-size:11px; margin-top:2px">${actor.detail}</div>
           </div>`,
        )
        .addTo(staticLayer)
    }
  }, [reporterPos, bhu, bhuPos, incident, idleActors, status])

  // -------------------------------------------------------------------------
  // Route-Based Dynamic Movement & Interpolation Animation
  // -------------------------------------------------------------------------
  useEffect(() => {
    const dynamicLayer = dynamicLayerRef.current
    if (!dynamicLayer) return

    // Clean up any existing running animation frame
    if (rafIdRef.current) {
      cancelAnimationFrame(rafIdRef.current)
      rafIdRef.current = null
    }

    dynamicLayer.clearLayers()
    responderMarkerRef.current = null
    ambulanceMarkerRef.current = null
    approachPolylineRef.current = null
    ambulancePolylineRef.current = null

    if (!incident || !reporterPos) return

    // 1. Initialize Responder Layer Elements
    if (assignedResponder && baseResponderPos) {
      const approachLine = L.polyline(
        [
          [baseResponderPos.lat, baseResponderPos.lng],
          [reporterPos.lat, reporterPos.lng],
        ],
        {
          color: CYAN,
          weight: 3.5,
          opacity: 0.9,
          className: status !== 'closed' ? 'route-vector' : 'route-vector--static',
        },
      ).addTo(dynamicLayer)
      approachPolylineRef.current = approachLine

      const respMarker = L.marker([baseResponderPos.lat, baseResponderPos.lng], {
        icon: markerIcon('responder', 16),
        title: assignedResponder.name,
        zIndexOffset: 600,
      })
        .bindPopup(
          `<div style="min-width:150px; font-family:inherit;">
             <div style="font-weight:700; color:#f8fafc; font-size:13px;">${assignedResponder.name}</div>
             <div style="color:#94a3b8; font-size:11px; margin-top:2px">${assignedResponder.id} · Active Dispatch</div>
           </div>`,
        )
        .addTo(dynamicLayer)
      responderMarkerRef.current = respMarker
    }

    // 2. Initialize Ambulance Layer Elements
    if (isAmbulanceRequested && bhuPos) {
      const ambLine = L.polyline(
        [
          [bhuPos.lat, bhuPos.lng],
          [reporterPos.lat, reporterPos.lng],
        ],
        {
          color: AMBULANCE,
          weight: 3,
          opacity: 0.85,
          dashArray: '6, 8',
          className: status !== 'closed' ? 'route-vector' : 'route-vector--static',
        },
      ).addTo(dynamicLayer)
      ambulancePolylineRef.current = ambLine

      const ambMarker = L.marker([bhuPos.lat, bhuPos.lng], {
        icon: markerIcon('ambulance', 18),
        title: 'Ambulance Unit',
        zIndexOffset: 650,
      })
        .bindPopup(
          `<div style="min-width:150px; font-family:inherit;">
             <div style="font-weight:700; color:#f8fafc; font-size:13px;">Ambulance Unit</div>
             <div style="color:#94a3b8; font-size:11px; margin-top:2px">Urgent Transfer Dispatch</div>
           </div>`,
        )
        .addTo(dynamicLayer)
      ambulanceMarkerRef.current = ambMarker
    }

    // 3. Apply State Rules:
    // A. Arrived: Snap to scene coordinates and halt
    if (isArrived) {
      if (responderMarkerRef.current) {
        responderMarkerRef.current.setLatLng([
          reporterPos.lat + 0.00015,
          reporterPos.lng + 0.00015,
        ])
      }
      if (ambulanceMarkerRef.current) {
        ambulanceMarkerRef.current.setLatLng([
          reporterPos.lat - 0.00015,
          reporterPos.lng - 0.00015,
        ])
      }
      if (approachPolylineRef.current) {
        approachPolylineRef.current.setLatLngs([
          [reporterPos.lat + 0.00015, reporterPos.lng + 0.00015],
          [reporterPos.lat, reporterPos.lng],
        ])
      }
      return
    }

    // B. Static State: Awaiting response / newly reported (remain at origin)
    if (!isEnRoute) {
      if (responderMarkerRef.current && baseResponderPos) {
        responderMarkerRef.current.setLatLng([baseResponderPos.lat, baseResponderPos.lng])
      }
      if (ambulanceMarkerRef.current && bhuPos) {
        ambulanceMarkerRef.current.setLatLng([bhuPos.lat, bhuPos.lng])
      }
      return
    }

    // C. Responder En Route: Animate along 80-step sampled waypoints over 11s duration
    if (isEnRoute && baseResponderPos) {
      const respWaypoints = sampleRouteWaypoints(baseResponderPos, reporterPos, 80)
      const ambWaypoints = bhuPos
        ? sampleRouteWaypoints(bhuPos, reporterPos, 80)
        : []

      const durationMs = 11_000
      const startTime = performance.now()

      const animateLoop = (now: number) => {
        const elapsed = now - startTime
        const rawProgress = elapsed / durationMs
        // Smoothly approach doorstep (up to 95% travel) until explicit arrived status
        const progress = Math.min(rawProgress, 0.95)

        // Interpolate responder
        if (responderMarkerRef.current && respWaypoints.length > 0) {
          const pt = interpolateAtProgress(respWaypoints, progress)
          responderMarkerRef.current.setLatLng([pt.lat, pt.lng])
          if (approachPolylineRef.current) {
            approachPolylineRef.current.setLatLngs([
              [pt.lat, pt.lng],
              [reporterPos.lat, reporterPos.lng],
            ])
          }
        }

        // Interpolate ambulance
        if (ambulanceMarkerRef.current && ambWaypoints.length > 0) {
          const ambProgress = Math.min(progress * 0.9 + 0.05, 0.93)
          const pt = interpolateAtProgress(ambWaypoints, ambProgress)
          ambulanceMarkerRef.current.setLatLng([pt.lat, pt.lng])
          if (ambulancePolylineRef.current) {
            ambulancePolylineRef.current.setLatLngs([
              [pt.lat, pt.lng],
              [reporterPos.lat, reporterPos.lng],
            ])
          }
        }

        if (rawProgress < 0.95) {
          rafIdRef.current = requestAnimationFrame(animateLoop)
        }
      }

      rafIdRef.current = requestAnimationFrame(animateLoop)
    }

    return () => {
      if (rafIdRef.current) {
        cancelAnimationFrame(rafIdRef.current)
        rafIdRef.current = null
      }
    }
  }, [
    incident,
    reporterPos,
    bhuPos,
    assignedResponder,
    baseResponderPos,
    isAmbulanceRequested,
    isEnRoute,
    isArrived,
    status,
  ])

  // -------------------------------------------------------------------------
  // Fit Map Bounds (Only when incident base locations change)
  // -------------------------------------------------------------------------
  useEffect(() => {
    const map = mapRef.current
    if (!map || !reporterPos) return

    const keyPoints: [number, number][] = [[reporterPos.lat, reporterPos.lng]]
    if (bhuPos) keyPoints.push([bhuPos.lat, bhuPos.lng])
    if (baseResponderPos) keyPoints.push([baseResponderPos.lat, baseResponderPos.lng])

    const signature = keyPoints.map((p) => `${p[0].toFixed(4)},${p[1].toFixed(4)}`).join('|')
    if (signature === fittedSignature.current) return
    fittedSignature.current = signature

    const bounds = L.latLngBounds(keyPoints)
    map.fitBounds(bounds.pad(0.45), { animate: true, maxZoom: 14 })
  }, [reporterPos, bhuPos, baseResponderPos])

  // -------------------------------------------------------------------------
  // Render Telemetry & UI
  // -------------------------------------------------------------------------
  const legKm =
    reporterPos && baseResponderPos
      ? distanceKm(baseResponderPos, reporterPos)
      : null
  const transferKm =
    reporterPos && bhuPos ? distanceKm(reporterPos, bhuPos) : null

  return (
    <div className="card overflow-hidden">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 border-b border-slate-800 px-5 pt-4 pb-3">
        <div>
          <h2 className="text-[15px] font-bold tracking-tight text-ink">
            Live Situation Map
          </h2>
          <p dir="rtl" className="font-urdu text-[12px] leading-5 text-ink-muted">
            براہِ راست نقشہ
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
          <LegendItem color={CRITICAL} label="Reporter" />
          <LegendItem color={CYAN} label="Responder" />
          <LegendItem color={MINT} label="BHU" />
          {isAmbulanceRequested && <LegendItem color={AMBULANCE} label="Ambulance" />}
          <LegendItem color={IDLE} label="Registry" dim />
        </div>
      </div>

      <div
        ref={containerRef}
        className={`${heightClass} w-full border-b border-slate-800`}
        role="application"
        aria-label="Situation map"
      />

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 bg-sunken px-5 py-3 text-[11px] text-ink-muted">
        {legKm !== null && (
          <span className="inline-flex items-center gap-1.5 font-medium">
            <StatusDot tone="cyan" />
            Responder leg:
            <span className="font-bold text-sky-400 tabular-nums">
              {legKm.toFixed(1)} km
            </span>
          </span>
        )}
        {transferKm !== null && (
          <span className="inline-flex items-center gap-1.5 font-medium">
            <StatusDot tone="mint" />
            BHU transfer:
            <span className="font-bold text-emerald-400 tabular-nums">
              {transferKm.toFixed(1)} km
            </span>
          </span>
        )}
        {legKm === null && transferKm === null && (
          <span className="italic text-ink-dim">
            Awaiting an incident — reporting one pins the reporter, responder and
            BHU with animated route vectors.
          </span>
        )}
        <span className="ml-auto font-medium text-ink-dim">
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
    <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
      <span
        className="h-2.5 w-2.5 rounded-full border border-slate-900"
        style={{ background: color, opacity: dim ? 0.6 : 1 }}
      />
      {label}
    </span>
  )
}
