/**
 * Subtle Background Elements for LifeLine Ride Cockpit Views.
 *
 * Tasteful, ultra-low opacity (3% - 6%) static vector graphics placed behind cards
 * to eliminate stark empty space without creating visual clutter or distraction
 * during emergency operations.
 */


/**
 * Reporter View Background (Distress Intake):
 * - Top-right: Stylized radial radar circle / range rings wireframe.
 * - Bottom-left: Gentle topography contour line wireframe.
 * - Lower margin: Ultra-faint rhythmic ECG/pulse waveform drifting horizontally.
 */
export function ReporterBackground() {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 z-0 select-none overflow-hidden"
    >
      {/* Top-Right: Stylized Radial Radar & Range Rings */}
      <svg
        className="absolute -top-16 -right-16 h-[440px] w-[440px] stroke-sky-700 opacity-[0.045]"
        viewBox="0 0 400 400"
        fill="none"
      >
        {/* Concentric radar rings */}
        <circle cx="200" cy="200" r="60" strokeWidth="1" strokeDasharray="3 3" />
        <circle cx="200" cy="200" r="110" strokeWidth="1" />
        <circle cx="200" cy="200" r="160" strokeWidth="1" strokeDasharray="4 4" />
        <circle cx="200" cy="200" r="195" strokeWidth="1.2" />

        {/* Radar crosshairs & angular bearings */}
        <line x1="200" y1="5" x2="200" y2="395" strokeWidth="1" strokeDasharray="2 2" />
        <line x1="5" y1="200" x2="395" y2="200" strokeWidth="1" strokeDasharray="2 2" />
        <line x1="60" y1="60" x2="340" y2="340" strokeWidth="0.8" strokeDasharray="2 4" />
        <line x1="340" y1="60" x2="60" y2="340" strokeWidth="0.8" strokeDasharray="2 4" />

        {/* Range labels */}
        <text x="206" y="94" fill="currentColor" className="font-mono text-[9px] font-semibold">5 KM</text>
        <text x="206" y="44" fill="currentColor" className="font-mono text-[9px] font-semibold">10 KM</text>
        <text x="320" y="196" fill="currentColor" className="font-mono text-[9px] font-semibold">RADAR 01</text>
      </svg>

      {/* Bottom-Left: Topography Contour Lines */}
      <svg
        className="absolute -bottom-10 -left-10 h-[400px] w-[420px] stroke-slate-600 opacity-[0.04]"
        viewBox="0 0 400 400"
        fill="none"
      >
        <path
          d="M -20,380 C 60,340 120,360 200,310 C 280,260 320,290 420,240"
          strokeWidth="1.2"
        />
        <path
          d="M -20,330 C 50,290 140,310 220,250 C 300,190 350,230 420,180"
          strokeWidth="1"
          strokeDasharray="4 2"
        />
        <path
          d="M -20,280 C 80,240 150,270 230,200 C 310,130 360,170 420,120"
          strokeWidth="1.2"
        />
        <path
          d="M -20,220 C 70,180 160,210 250,140 C 320,80 370,110 420,60"
          strokeWidth="1"
        />
        <path
          d="M -20,160 C 90,120 170,150 260,80 C 330,20 380,50 420,0"
          strokeWidth="0.8"
          strokeDasharray="3 3"
        />
        {/* Elevation marker tags */}
        <text x="30" y="270" fill="currentColor" className="font-mono text-[9px]">480m</text>
        <text x="90" y="210" fill="currentColor" className="font-mono text-[9px]">520m</text>
        <text x="140" y="145" fill="currentColor" className="font-mono text-[9px]">560m</text>
      </svg>

      {/* Lower Margin: Ultra-faint Rhythmic ECG / Pulse Waveform */}
      <div className="absolute bottom-3 left-0 right-0 flex justify-center opacity-[0.045]">
        <svg
          className="h-14 w-full max-w-5xl stroke-sky-400"
          viewBox="0 0 1000 60"
          fill="none"
          preserveAspectRatio="none"
        >
          <path
            d="M 0 30 L 120 30 L 135 30 L 142 22 L 148 30 L 158 30 L 165 6 L 174 54 L 182 18 L 190 30 L 202 30 L 212 24 L 220 30 L 360 30 L 375 30 L 382 22 L 388 30 L 398 30 L 405 6 L 414 54 L 422 18 L 430 30 L 442 30 L 452 24 L 460 30 L 600 30 L 615 30 L 622 22 L 628 30 L 638 30 L 645 6 L 654 54 L 662 18 L 670 30 L 682 30 L 692 24 L 700 30 L 840 30 L 855 30 L 862 22 L 868 30 L 878 30 L 885 6 L 894 54 L 902 18 L 910 30 L 922 30 L 932 24 L 940 30 L 1000 30"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>
    </div>
  )
}

/**
 * Responder View Background (Guidance & Action):
 * - Outer margins: Minimal geometric safety crosses (+) and dotted grid matrix.
 * - Tactical corner brackets giving a field-ready tactical HUD feel.
 */
export function ResponderBackground() {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 z-0 select-none overflow-hidden"
    >
      {/* Dotted Grid Matrix (Tactical Dot Grid) */}
      <div
        className="absolute inset-0 opacity-[0.04]"
        style={{
          backgroundImage: 'radial-gradient(rgba(56, 189, 248, 0.4) 1px, transparent 1px)',
          backgroundSize: '28px 28px',
        }}
      />

      {/* Top-Left: Tactical HUD Bracket + Medical Safety Cross */}
      <div className="absolute top-6 left-6 flex items-start gap-3 stroke-sky-700 text-sky-700 opacity-[0.055]">
        <svg className="h-20 w-20" viewBox="0 0 80 80" fill="none">
          {/* Corner frame */}
          <path d="M 5 35 L 5 5 L 35 5" strokeWidth="1.5" strokeLinecap="square" />
          {/* Safety Cross (+) */}
          <path
            d="M 22 17 h 6 v -6 h 6 v 6 h 6 v 6 h -6 v 6 h -6 v -6 h -6 z"
            fill="currentColor"
            fillOpacity="0.4"
            stroke="currentColor"
            strokeWidth="0.8"
          />
          {/* Grid coordinates */}
          <text x="8" y="55" fill="currentColor" className="font-mono text-[8px] font-medium tracking-wider">
            32°43'N 72°15'E
          </text>
          <text x="8" y="66" fill="currentColor" className="font-mono text-[8px] tracking-wider">
            SEC-TAMMAN-R01
          </text>
        </svg>
      </div>

      {/* Top-Right: Minimal Safety Cross Cluster */}
      <div className="absolute top-8 right-8 stroke-sky-700 text-sky-700 opacity-[0.045]">
        <svg className="h-16 w-16" viewBox="0 0 60 60" fill="none">
          <path d="M 55 25 L 55 5 L 35 5" strokeWidth="1.5" strokeLinecap="square" />
          <line x1="25" y1="20" x2="35" y2="20" strokeWidth="1.5" />
          <line x1="30" y1="15" x2="30" y2="25" strokeWidth="1.5" />
          <line x1="42" y1="36" x2="48" y2="36" strokeWidth="1" />
          <line x1="45" y1="33" x2="45" y2="39" strokeWidth="1" />
        </svg>
      </div>

      {/* Bottom-Right: Tactical HUD Bracket + Compass Reticle */}
      <div className="absolute bottom-6 right-6 flex flex-col items-end stroke-emerald-700 text-emerald-700 opacity-[0.05]">
        <svg className="h-24 w-24" viewBox="0 0 100 100" fill="none">
          {/* Corner frame */}
          <path d="M 95 65 L 95 95 L 65 95" strokeWidth="1.5" strokeLinecap="square" />
          {/* Small orientation reticle */}
          <circle cx="50" cy="50" r="22" strokeWidth="1" strokeDasharray="3 3" />
          <circle cx="50" cy="50" r="12" strokeWidth="0.8" />
          <circle cx="50" cy="50" r="2" fill="currentColor" />
          <line x1="50" y1="22" x2="50" y2="78" strokeWidth="0.8" />
          <line x1="22" y1="50" x2="78" y2="50" strokeWidth="0.8" />
          <text x="25" y="90" fill="currentColor" className="font-mono text-[8px] tracking-wider">
            FIRST_AID_CAD
          </text>
        </svg>
      </div>

      {/* Bottom-Left: Subtle Safety Crosses */}
      <div className="absolute bottom-8 left-8 stroke-sky-700 text-sky-700 opacity-[0.045]">
        <svg className="h-16 w-16" viewBox="0 0 60 60" fill="none">
          <path d="M 5 35 L 5 55 L 25 55" strokeWidth="1.5" strokeLinecap="square" />
          <line x1="22" y1="38" x2="32" y2="38" strokeWidth="1.2" />
          <line x1="27" y1="33" x2="27" y2="43" strokeWidth="1.2" />
        </svg>
      </div>
    </div>
  )
}

/**
 * BHU & Audit View Background (Command & Logistics):
 * - Outer edges around the map card: Soft latitude/longitude grid intersections.
 * - Minimalist location pin silhouettes and dispatch beacon rings.
 */
export function BhuBackground() {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 z-0 select-none overflow-hidden"
    >
      {/* Latitude / Longitude Grid Intersections across outer margins */}
      <svg
        className="absolute inset-0 h-full w-full stroke-slate-700 opacity-[0.045]"
        fill="none"
      >
        <defs>
          <pattern id="lat-long-grid" width="180" height="180" patternUnits="userSpaceOnUse">
            {/* Grid line intersections */}
            <path d="M 90 0 L 90 180 M 0 90 L 180 90" strokeWidth="0.6" strokeDasharray="2 6" />
            {/* Crosshair at intersection */}
            <path d="M 82 90 L 98 90 M 90 82 L 90 98" strokeWidth="1.2" />
            <circle cx="90" cy="90" r="2.5" strokeWidth="0.8" />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#lat-long-grid)" />
      </svg>

      {/* Top-Right: Location Pin Silhouette & Radiating Dispatch Beacons */}
      <div className="absolute top-10 right-10 stroke-emerald-700 text-emerald-700 opacity-[0.05]">
        <svg className="h-32 w-32" viewBox="0 0 120 120" fill="none">
          {/* Dispatch concentric beacon waves */}
          <circle cx="60" cy="45" r="28" strokeWidth="1" strokeDasharray="3 3" />
          <circle cx="60" cy="45" r="42" strokeWidth="0.8" strokeDasharray="2 4" />
          <circle cx="60" cy="45" r="54" strokeWidth="0.6" />

          {/* Minimalist Location Pin Silhouette */}
          <path
            d="M 60 22 C 48 22 39 31 39 43 C 39 58 60 76 60 76 C 60 76 81 58 81 43 C 81 31 72 22 60 22 Z"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <circle cx="60" cy="43" r="5" fill="currentColor" fillOpacity="0.4" strokeWidth="1" />

          {/* Sector metadata text */}
          <text x="35" y="96" fill="currentColor" className="font-mono text-[8px] font-bold tracking-widest">
            BHU HUB 01
          </text>
          <text x="32" y="106" fill="currentColor" className="font-mono text-[7px] tracking-wider">
            PRIMARY CLINIC
          </text>
        </svg>
      </div>

      {/* Top-Left: Tactical Latitude / Sector Coordinates */}
      <div className="absolute top-12 left-10 text-slate-500 opacity-[0.045]">
        <p className="font-mono text-[9px] font-semibold tracking-widest">BHU_COMMAND_DISPATCH</p>
        <p className="font-mono text-[8px] tracking-wider">LAT 32.7167° N · LON 72.2500° E</p>
        <p className="font-mono text-[8px] tracking-wider">CHAKWAL CLUSTER · ELEV 512M</p>
      </div>

      {/* Bottom-Left: Location Pin Silhouette Secondary */}
      <div className="absolute bottom-8 left-8 stroke-sky-700 text-sky-700 opacity-[0.045]">
        <svg className="h-24 w-24" viewBox="0 0 100 100" fill="none">
          <circle cx="50" cy="40" r="20" strokeWidth="0.8" strokeDasharray="2 3" />
          <circle cx="50" cy="40" r="32" strokeWidth="0.6" />
          <path
            d="M 50 25 C 42 25 35 32 35 40 C 35 52 50 66 50 66 C 50 66 65 52 65 40 C 65 32 58 25 50 25 Z"
            strokeWidth="1.2"
          />
          <circle cx="50" cy="40" r="3.5" fill="currentColor" fillOpacity="0.3" strokeWidth="0.8" />
          <text x="26" y="82" fill="currentColor" className="font-mono text-[7px] tracking-wider">
            AMBULANCE_UNIT_1122
          </text>
        </svg>
      </div>
    </div>
  )
}
