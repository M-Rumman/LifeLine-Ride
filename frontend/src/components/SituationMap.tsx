/**
 * Live incident situation map shared by role-specific screens.
 *
 * The map is intentionally contextual: Reporter, Responder and BHU each see
 * the same authoritative incident geometry, but normal users do not get the
 * all-network operations view. The separate `/operations` surface owns the
 * full village/BHU/responder network map.
 *
 * Leaflet + OpenStreetMap with smooth route-based mock movement simulation:
 *  - Static State: Markers remain completely static at origins while awaiting acceptance.
 *  - En Route: Marker smoothly traverses sampled route waypoints toward the incident over ~11s.
 *  - Ambulance: Departs from linked BHU along route toward the incident when requested.
 *  - Arrived: Marker snaps directly onto the incident site coordinates and halts.
 *
 * Direct `marker.setLatLng()` updates avoid full-map re-renders and panning jitter.
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

// Persistent start timestamps keyed by incident_id across tab transitions & remounts
const incidentStartTimestamps = new Map<string, number>()
const responderAcceptTimestamps = new Map<string, number>()

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
  const [roadRoute, setRoadRoute] = useState<LatLng[] | null>(null)

  // Real-time animation progress state (0 to 1) for live distance countdown
  const [respProgress, setRespProgress] = useState<number>(0)
  const [ambProgress, setAmbProgress] = useState<number>(0)

  const status = timeline?.status ?? null
  const isIncidentClosed = status === 'closed'
  const isResponderArrived =
    Boolean(incident?.responder_arrived_timestamp) ||
    status === 'responder_arrived' ||
    status === 'arrived'

  const isAccepted = useMemo(() => {
    if (!incident) return false
    const events = incident?.dispatch_events ?? []
    const acknowledged = events.some((e: any) => {
      const name = String(e?.event ?? e?.type ?? e?.stage ?? '').toLowerCase()
      return (
        name.includes('accept') ||
        name.includes('ack') ||
        name.includes('en_route') ||
        name.includes('arrived')
      )
    })
    const enRouteUpdate = (timeline?.updates ?? []).some(
      (u) =>
        u.stage === 'responder_en_route' ||
        u.stage === 'en_route' ||
        u.stage === 'responder_arrived' ||
        u.stage === 'arrived',
    )
    return (
      acknowledged ||
      enRouteUpdate ||
      status === 'responder_en_route' ||
      status === 'responder_arrived' ||
      status === 'arrived' ||
      isResponderArrived
    )
  }, [incident, timeline, status, isResponderArrived])

  const isAmbulanceRequested = Boolean(
    incident?.ambulance_requested || incident?.bhu_notified,
  )

  // Track emergency start & responder accept timestamps in session map
  useEffect(() => {
    if (!incident?.incident_id) return
    const incId = incident.incident_id
    if (!incidentStartTimestamps.has(incId)) {
      incidentStartTimestamps.set(incId, performance.now())
    }
    if (isAccepted && !responderAcceptTimestamps.has(incId)) {
      responderAcceptTimestamps.set(incId, performance.now())
    }
  }, [incident?.incident_id, isAccepted])

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
    if (incident) return []
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
  // Best-effort road routing (OSRM)
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (!reporterPos) {
      setRoadRoute(null)
      return
    }

    const origin = baseResponderPos ?? bhuPos
    if (!origin) {
      setRoadRoute(null)
      return
    }

    const controller = new AbortController()
    const url = `https://router.project-osrm.org/route/v1/driving/${origin.lng},${origin.lat};${reporterPos.lng},${reporterPos.lat}?overview=full&geometries=geojson&steps=false`

    fetch(url, { signal: controller.signal })
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error('routing unavailable'))))
      .then((data) => {
        const coords = data?.routes?.[0]?.geometry?.coordinates
        if (!Array.isArray(coords) || coords.length < 2) throw new Error('route missing')
        const points = coords
          .map((pair: unknown) => {
            if (!Array.isArray(pair) || pair.length < 2) return null
            const [lng, lat] = pair
            return typeof lat === 'number' && typeof lng === 'number' ? { lat, lng } : null
          })
          .filter((point: LatLng | null): point is LatLng => point !== null)
        setRoadRoute(points.length >= 2 ? points : null)
      })
      .catch(() => {
        if (!controller.signal.aborted) setRoadRoute(null)
      })

    return () => controller.abort()
  }, [reporterPos, baseResponderPos, bhuPos])

  // -------------------------------------------------------------------------
  // Redraw Static Overlays
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
             <div style="color:#94a3b8; font-size:11px; margin-top:2px">${villageById(incident.gps_location.village_id)?.label_en ?? incident.gps_location.village_id}</div>
             <div style="color:#10b981; font-size:10px; margin-top:4px; font-weight:600;">live GPS from report</div>
           </div>`,
        )
        .addTo(staticLayer)
    }

    // 2. BHU / Hospital Marker
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
             <div style="color:#64748b; font-size:10px; margin-top:4px; font-style:italic;">linked health facility</div>
           </div>`,
        )
        .addTo(staticLayer)
    }

    // 3. Static BHU Transfer Route Vector (Background)
    if (reporterPos && bhuPos && (incident?.bhu_notified || incident?.ambulance_requested)) {
      L.polyline(
        [
          [reporterPos.lat, reporterPos.lng],
          [bhuPos.lat, bhuPos.lng],
        ],
        {
          color: incident?.ambulance_requested ? CRITICAL : MINT,
          weight: 2,
          opacity: 0.35,
          dashArray: '4, 6',
          className: 'route-vector--static',
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
  // Coordinated Real-Time Map Path Animation & Live Distance Updates
  // -------------------------------------------------------------------------
  useEffect(() => {
    const dynamicLayer = dynamicLayerRef.current
    if (!dynamicLayer) return

    // Clean up any existing animation loop
    if (rafIdRef.current) {
      cancelAnimationFrame(rafIdRef.current)
      rafIdRef.current = null
    }

    dynamicLayer.clearLayers()
    responderMarkerRef.current = null
    ambulanceMarkerRef.current = null
    approachPolylineRef.current = null
    ambulancePolylineRef.current = null

    if (!incident || !reporterPos) {
      setRespProgress(0)
      setAmbProgress(0)
      return
    }

    const incId = incident.incident_id

    // 1. Initialize Responder Layer Elements
    if (assignedResponder && baseResponderPos) {
      const approachPoints = (roadRoute ?? sampleRouteWaypoints(baseResponderPos, reporterPos, 80))
        .map((point) => [point.lat, point.lng] as [number, number])
      const approachLine = L.polyline(approachPoints, {
        color: CYAN,
        weight: 3.5,
        opacity: 0.9,
        className: status !== 'closed' ? 'route-vector' : 'route-vector--static',
      }).addTo(dynamicLayer)
      approachPolylineRef.current = approachLine

      const respMarker = L.marker([baseResponderPos.lat, baseResponderPos.lng], {
        icon: markerIcon('responder', 16),
        title: assignedResponder.name,
        zIndexOffset: 600,
      })
        .bindPopup(
          `<div style="min-width:150px; font-family:inherit;">
             <div style="font-weight:700; color:#f8fafc; font-size:13px;">${assignedResponder.name}</div>
             <div style="color:#94a3b8; font-size:11px; margin-top:2px">Active response · assigned responder</div>
           </div>`,
        )
        .addTo(dynamicLayer)
      responderMarkerRef.current = respMarker
    }

    // 2. Initialize Ambulance Layer Elements
    if (isAmbulanceRequested && bhuPos) {
      const ambPoints = sampleRouteWaypoints(bhuPos, reporterPos, 80)
        .map((point) => [point.lat, point.lng] as [number, number])
      const ambLine = L.polyline(ambPoints, {
        color: AMBULANCE,
        weight: 3.5,
        opacity: 0.9,
        dashArray: '6, 8',
        className: status !== 'closed' ? 'route-vector' : 'route-vector--static',
      }).addTo(dynamicLayer)
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

    // 3. Complete Incident Closure: Snap all to scene coordinates
    if (isIncidentClosed) {
      setRespProgress(1)
      setAmbProgress(1)
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
      return
    }

    // 4. Real-time Coordinated Animation Loop
    // Timing Parameters:
    // - Ambulance starts moving 4s after emergency registration (completely independent of responder).
    // - Responder starts moving once invite is accepted.
    // - Responder duration: 10s (reaches patient first).
    // - Ambulance duration: 40s (slowed down for smooth long-distance observation from hospital).
    const RESPONDER_DURATION_MS = 10_000
    const AMBULANCE_DELAY_MS = 4_000
    const AMBULANCE_DURATION_MS = 40_000

    const respWaypoints =
      baseResponderPos && reporterPos
        ? roadRoute ?? sampleRouteWaypoints(baseResponderPos, reporterPos, 80)
        : []
    const ambWaypoints =
      bhuPos && reporterPos ? sampleRouteWaypoints(bhuPos, reporterPos, 80) : []

    const animateLoop = (now: number) => {
      const emergStart = incidentStartTimestamps.get(incId) ?? now
      const elapsedEmerg = Math.max(0, now - emergStart)

      // --- Ambulance Movement (4s delay, completely independent) ---
      let alphaAmb = 0
      if (isAmbulanceRequested && bhuPos) {
        if (elapsedEmerg >= AMBULANCE_DELAY_MS) {
          alphaAmb = Math.min(1, (elapsedEmerg - AMBULANCE_DELAY_MS) / AMBULANCE_DURATION_MS)
        }
        const ambPt =
          ambWaypoints.length > 0
            ? interpolateAtProgress(ambWaypoints, alphaAmb)
            : bhuPos
        if (ambulanceMarkerRef.current) {
          ambulanceMarkerRef.current.setLatLng([ambPt.lat, ambPt.lng])
        }
        if (ambulancePolylineRef.current) {
          ambulancePolylineRef.current.setLatLngs([
            [ambPt.lat, ambPt.lng],
            [reporterPos.lat, reporterPos.lng],
          ])
        }
        setAmbProgress(alphaAmb)
      }

      // --- Responder Movement (Moves only once accepted) ---
      let alphaResp = 0
      if ((isAccepted || isResponderArrived) && baseResponderPos) {
        if (isResponderArrived) {
          alphaResp = 1
        } else {
          if (!responderAcceptTimestamps.has(incId)) {
            responderAcceptTimestamps.set(incId, now)
          }
          const acceptStart = responderAcceptTimestamps.get(incId) ?? now
          const elapsedResp = Math.max(0, now - acceptStart)
          alphaResp = Math.min(1, elapsedResp / RESPONDER_DURATION_MS)
        }

        const respPt =
          respWaypoints.length > 0
            ? interpolateAtProgress(respWaypoints, alphaResp)
            : baseResponderPos
        if (responderMarkerRef.current) {
          responderMarkerRef.current.setLatLng([respPt.lat, respPt.lng])
        }
        if (approachPolylineRef.current) {
          approachPolylineRef.current.setLatLngs([
            [respPt.lat, respPt.lng],
            [reporterPos.lat, reporterPos.lng],
          ])
        }
        setRespProgress(alphaResp)
      } else if (baseResponderPos) {
        // Awaiting acceptance: remains at base
        if (responderMarkerRef.current) {
          responderMarkerRef.current.setLatLng([baseResponderPos.lat, baseResponderPos.lng])
        }
        if (approachPolylineRef.current) {
          approachPolylineRef.current.setLatLngs([
            [baseResponderPos.lat, baseResponderPos.lng],
            [reporterPos.lat, reporterPos.lng],
          ])
        }
        setRespProgress(0)
      }

      const ambulanceStillMoving = isAmbulanceRequested && alphaAmb < 1
      const responderStillMoving = isAccepted && !isResponderArrived && alphaResp < 1
      const awaitingAcceptance = !isAccepted

      if (ambulanceStillMoving || responderStillMoving || awaitingAcceptance) {
        rafIdRef.current = requestAnimationFrame(animateLoop)
      }
    }

    rafIdRef.current = requestAnimationFrame(animateLoop)

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
    isAccepted,
    isResponderArrived,
    isIncidentClosed,
    status,
    roadRoute,
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
  // Render Telemetry & UI: Dynamic Distance Decrement
  // -------------------------------------------------------------------------
  const initialLegKm =
    reporterPos && baseResponderPos
      ? distanceKm(baseResponderPos, reporterPos)
      : null
  const initialTransferKm =
    reporterPos && bhuPos ? distanceKm(reporterPos, bhuPos) : null

  const effectiveRespAlpha = isIncidentClosed || isResponderArrived ? 1 : isAccepted ? respProgress : 0
  const effectiveAmbAlpha = isIncidentClosed ? 1 : ambProgress

  const currentLegKm =
    initialLegKm !== null
      ? Math.max(0, initialLegKm * (1 - effectiveRespAlpha))
      : null

  const currentTransferKm =
    initialTransferKm !== null
      ? Math.max(0, initialTransferKm * (1 - effectiveAmbAlpha))
      : null

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
          {!incident && <LegendItem color={IDLE} label="Responders" dim />}
        </div>
      </div>

      <div
        ref={containerRef}
        className={`${heightClass} w-full border-b border-slate-800`}
        role="application"
        aria-label="Situation map"
      />

      {/* Dynamic Telemetry Footer */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 bg-sunken px-5 py-3 text-[11px] text-ink-muted">
        {/* Responder Metric */}
        {initialLegKm !== null && currentLegKm !== null && (
          <div className="inline-flex items-center gap-2 font-medium">
            <StatusDot
              tone={effectiveRespAlpha >= 1 ? 'mint' : isAccepted ? 'cyan' : 'critical'}
              pulse={isAccepted && effectiveRespAlpha < 1}
            />
            <span>Responder leg:</span>
            {effectiveRespAlpha >= 1 ? (
              <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-bold text-emerald-300">
                <span>🟢</span>
                <span dir="rtl" className="font-urdu">مقام پر پہنچ گیا</span>
                <span>(Arrived at Scene · 0.0 km)</span>
              </span>
            ) : isAccepted ? (
              <span className="font-bold text-sky-400 tabular-nums">
                {currentLegKm.toFixed(1)} km
                <span className="ml-1 text-[10px] font-normal text-sky-300/80 animate-pulse">
                  (en route · روانہ ہو چکا ہے)
                </span>
              </span>
            ) : (
              <span className="font-bold text-amber-400 tabular-nums">
                {currentLegKm.toFixed(1)} km
                <span className="ml-1 text-[10px] font-normal text-amber-300/80">
                  (awaiting acceptance · قبولیت کا انتظار)
                </span>
              </span>
            )}
          </div>
        )}

        {/* BHU Transfer / Ambulance Metric */}
        {initialTransferKm !== null && currentTransferKm !== null && (
          <div className="inline-flex items-center gap-2 font-medium">
            <StatusDot
              tone={
                effectiveAmbAlpha >= 1
                  ? 'mint'
                  : isAmbulanceRequested
                    ? 'critical'
                    : 'mint'
              }
              pulse={isAmbulanceRequested && effectiveAmbAlpha > 0 && effectiveAmbAlpha < 1}
            />
            <span>BHU transfer:</span>
            {isAmbulanceRequested && effectiveAmbAlpha >= 1 ? (
              <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-bold text-emerald-300">
                <span>🟢</span>
                <span>Ambulance on Scene (0.0 km)</span>
              </span>
            ) : isAmbulanceRequested && effectiveAmbAlpha > 0 ? (
              <span className="font-bold text-amber-400 tabular-nums">
                {currentTransferKm.toFixed(1)} km
                <span className="ml-1 text-[10px] font-normal text-amber-300/90 animate-pulse">
                  (ambulance en route · روانہ ہو چکی ہے)
                </span>
              </span>
            ) : isAmbulanceRequested ? (
              <span className="font-bold text-amber-300 tabular-nums">
                {currentTransferKm.toFixed(1)} km
                <span className="ml-1 text-[10px] font-normal text-amber-200/80">
                  (departs in 4s · تیاری جاری ہے)
                </span>
              </span>
            ) : (
              <span className="font-bold text-emerald-400 tabular-nums">
                {currentTransferKm.toFixed(1)} km
                <span className="ml-1 text-[10px] font-normal text-emerald-300/80">
                  (linked BHU · مرکزِ صحت)
                </span>
              </span>
            )}
          </div>
        )}

        {initialLegKm === null && initialTransferKm === null && (
          <span className="italic text-ink-dim">
            Awaiting an incident — reporting one will show only the people and
            facility relevant to that emergency.
          </span>
        )}

        <span className="ml-auto font-medium text-ink-dim">
          {incident
            ? 'Incident view · local context'
            : `${BHUS.length} mapped facilities · ${VILLAGES.length} localities`}
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
