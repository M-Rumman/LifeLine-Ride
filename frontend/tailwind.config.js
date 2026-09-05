/** @type {import('tailwindcss').Config} */
// LifeLine Ride — Rozgaar-pattern dark utility theme.
//
// Palette discipline (do not widen these roles):
//   canvas   #0a0f1d  Deep Midnight Slate — the only viewport background.
//   surface  #111827  Slate 900 cards, always behind a slate-800 hairline.
//   accent   #0ea5e9  Cyan — primary actions, inputs, live data.
//   critical #ef4444  Rose — RESERVED for active critical emergencies and
//                           escalation banners. Never decorative.
//   verified #10b981  Emerald — RESERVED for verified status and resolved
//                           incidents. Never decorative.
//
// The legacy Impilo token names are retained and RE-POINTED at the new hex
// values on purpose: lib/urdu.ts bakes classes such as `text-tier-critical`
// and `bg-clinical-cyan/12` into TIER_META / AVAILABILITY_META, so remapping
// the palette retints them without touching that data layer.
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // ---- Current semantic tokens -----------------------------------
        canvas: '#0a0f1d', // viewport background, edge-to-edge
        surface: '#111827', // card / panel surface
        sunken: '#0d1424', // recessed wells: inputs, feeds, chat log
        raised: '#1e293b', // nested tiles, table head, hover surface
        hairline: '#1e293b', // slate-800 hairline border
        accent: '#0ea5e9', // cyan — primary active elements
        'accent-bright': '#38bdf8', // cyan hover / emphasis
        critical: '#ef4444', // rose — critical emergency only
        verified: '#10b981', // emerald — verified / resolved only
        ink: '#f8fafc', // primary text
        'ink-muted': '#94a3b8', // labels, secondary text
        'ink-dim': '#64748b', // timestamps, fine print

        // ---- Legacy names, re-pointed (see header note) ----------------
        'iris-canvas': '#0a0f1d',
        'iris-shadow': '#111827', // was: elevated white cards
        'iris-subtle': '#0d1424', // was: nested light tiles
        'iris-border': '#1e293b',
        'iris-dark-border': '#1e293b',
        'iris-pulse': '#0ea5e9', // primary buttons, active tabs
        'iris-glow': '#38bdf8', // hover / emphasis

        'clinical-cyan': '#0ea5e9',
        'mint-vital': '#10b981',

        'tier-critical': '#ef4444',
        'tier-moderate': '#0ea5e9',
        'tier-minor': '#94a3b8',

        'slate-dark': '#f8fafc', // was: primary text on white cards
        'slate-muted': '#94a3b8',
        pearl: '#f8fafc',
        ash: '#94a3b8',
      },
      fontFamily: {
        // English / numbers: Inter with a neutral system fallback.
        sans: ['Inter', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        gilroy: ['Inter', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        // Urdu body AND headings: Nastaliq first, Noto Sans Arabic as the
        // legibility fallback. Both are loaded with font-display: swap.
        urdu: ['"Noto Nastaliq Urdu"', '"Noto Sans Arabic"', '"Jameel Noori Nastaleeq"', 'serif'],
        nastaliq: ['"Noto Nastaliq Urdu"', '"Noto Sans Arabic"', '"Jameel Noori Nastaleeq"', 'serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
      borderRadius: {
        // Containers land on Tailwind's rounded-2xl geometry.
        card: '1rem',
        panel: '1.25rem',
      },
      letterSpacing: {
        tight: '-0.02em',
        tighter: '-0.035em',
      },
      boxShadow: {
        panel: '0 18px 40px -24px rgba(2, 6, 23, 0.95)',
        card: '0 10px 30px -18px rgba(2, 6, 23, 0.9)',
        glow: '0 0 0 1px rgba(14, 165, 233, 0.45), 0 0 28px -8px rgba(14, 165, 233, 0.5)',
        mint: '0 0 0 1px rgba(16, 185, 129, 0.45), 0 0 28px -8px rgba(16, 185, 129, 0.45)',
        rose: '0 0 0 1px rgba(239, 68, 68, 0.5), 0 0 28px -8px rgba(239, 68, 68, 0.5)',
      },
      keyframes: {
        // Live-data pulse used by badges, the ambulance alert and audio waves.
        'pulse-ring': {
          '0%': { boxShadow: '0 0 0 0 rgba(14, 165, 233, 0.55)' },
          '70%': { boxShadow: '0 0 0 12px rgba(14, 165, 233, 0)' },
          '100%': { boxShadow: '0 0 0 0 rgba(14, 165, 233, 0)' },
        },
        'pulse-ring-mint': {
          '0%': { boxShadow: '0 0 0 0 rgba(16, 185, 129, 0.5)' },
          '70%': { boxShadow: '0 0 0 12px rgba(16, 185, 129, 0)' },
          '100%': { boxShadow: '0 0 0 0 rgba(16, 185, 129, 0)' },
        },
        'pulse-ring-critical': {
          '0%': { boxShadow: '0 0 0 0 rgba(239, 68, 68, 0.6)' },
          '70%': { boxShadow: '0 0 0 14px rgba(239, 68, 68, 0)' },
          '100%': { boxShadow: '0 0 0 0 rgba(239, 68, 68, 0)' },
        },
        // Animated route vector on the situation map (SVG dash travel).
        'route-flow': {
          to: { strokeDashoffset: '-24' },
        },
        'wave-bar': {
          '0%, 100%': { transform: 'scaleY(0.35)' },
          '50%': { transform: 'scaleY(1)' },
        },
        'fade-rise': {
          '0%': { opacity: '0', transform: 'translateY(8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        'pulse-ring': 'pulse-ring 2s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'pulse-ring-mint': 'pulse-ring-mint 2.4s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'pulse-ring-critical': 'pulse-ring-critical 1.4s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'route-flow': 'route-flow 0.9s linear infinite',
        'wave-bar': 'wave-bar 1s ease-in-out infinite',
        'fade-rise': 'fade-rise 0.35s ease-out both',
      },
    },
  },
  plugins: [],
}
