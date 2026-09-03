/** @type {import('tailwindcss').Config} */
// Impilo Clinical Observatory dark-theme design language.
// Canvas is always Deep Iris — never neutral black or gray.
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Core surfaces
        'iris-canvas': '#16165c', // viewport background, edge-to-edge
        'iris-shadow': '#232269', // elevated cards & panels
        'iris-border': '#4846c6', // 1px hairlines
        'iris-pulse': '#5350cc', // primary buttons, active tabs
        'iris-glow': '#6a67e0', // hover / emphasis

        // Clinical data accents
        'clinical-cyan': '#00b1ff', // live data, metrics, audio waves, routes
        'mint-vital': '#00ffaa', // verified / success / completed

        // Severity scale
        'tier-critical': '#ff4d6d',
        'tier-moderate': '#00b1ff',
        'tier-minor': '#c9c9e8',

        // Neutral text on iris
        pearl: '#f2f2ff',
        ash: '#a9a9d4',
      },
      fontFamily: {
        // Gilroy with a neutral geometric fallback stack.
        gilroy: ['Gilroy', 'Inter', 'Segoe UI', 'system-ui', 'sans-serif'],
        sans: ['Gilroy', 'Inter', 'Segoe UI', 'system-ui', 'sans-serif'],
        // Urdu-first: Naskh stays legible at dashboard sizes, Nastaliq is
        // reserved for large display headings.
        urdu: ['"Noto Naskh Arabic"', '"Segoe UI"', '"Jameel Noori Nastaleeq"', 'Tahoma', 'sans-serif'],
        nastaliq: ['"Noto Nastaliq Urdu"', '"Jameel Noori Nastaleeq"', 'serif'],
      },
      borderRadius: {
        card: '24px',
        panel: '32px',
      },
      letterSpacing: {
        tight: '-0.02em',
        tighter: '-0.035em',
      },
      boxShadow: {
        panel: '0 24px 60px -24px rgba(9, 9, 46, 0.85)',
        glow: '0 0 0 1px #4846c6, 0 0 28px -6px rgba(0, 177, 255, 0.45)',
        mint: '0 0 0 1px #4846c6, 0 0 28px -6px rgba(0, 255, 170, 0.45)',
      },
      keyframes: {
        // Live-data pulse used by badges, the ambulance alert and audio waves.
        'pulse-ring': {
          '0%': { boxShadow: '0 0 0 0 rgba(0, 177, 255, 0.55)' },
          '70%': { boxShadow: '0 0 0 12px rgba(0, 177, 255, 0)' },
          '100%': { boxShadow: '0 0 0 0 rgba(0, 177, 255, 0)' },
        },
        'pulse-ring-mint': {
          '0%': { boxShadow: '0 0 0 0 rgba(0, 255, 170, 0.5)' },
          '70%': { boxShadow: '0 0 0 12px rgba(0, 255, 170, 0)' },
          '100%': { boxShadow: '0 0 0 0 rgba(0, 255, 170, 0)' },
        },
        'pulse-ring-critical': {
          '0%': { boxShadow: '0 0 0 0 rgba(255, 77, 109, 0.6)' },
          '70%': { boxShadow: '0 0 0 14px rgba(255, 77, 109, 0)' },
          '100%': { boxShadow: '0 0 0 0 rgba(255, 77, 109, 0)' },
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
