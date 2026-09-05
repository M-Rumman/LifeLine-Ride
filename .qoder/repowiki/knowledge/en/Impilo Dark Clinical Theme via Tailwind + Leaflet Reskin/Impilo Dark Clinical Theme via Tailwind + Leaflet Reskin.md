---
kind: frontend_style
name: Impilo Dark Clinical Theme via Tailwind + Leaflet Reskin
category: frontend_style
scope:
    - '**'
source_files:
    - frontend/tailwind.config.js
    - frontend/src/index.css
    - frontend/postcss.config.js
    - frontend/package.json
    - frontend/src/components/ui.tsx
    - frontend/src/views/ResponderView.tsx
---

## What system/approach is used

The frontend styling is built on **Tailwind CSS 3.4** (PostCSS pipeline with `autoprefixer`) inside a Vite/React project. There is no component library — the UI is composed from hand-written React components in `src/components/ui.tsx` that wrap shared Tailwind utility classes. A single global stylesheet (`src/index.css`) declares the design tokens, base layer, reusable component primitives, and a full reskin of the Leaflet map to match the dark theme.

The visual identity is called **"Impilo Clinical Observatory"** in comments and config: a deep indigo/iris canvas (`#16165c`) with cyan/mint/critical accent colors, pill geometry (`rounded-full`), and large card radii (`24px`, `32px`). Urdu text is first-class — a dedicated `urdu` font stack (`Noto Naskh Arabic`, Jameel Noori Nastaleeq) and RTL direction are applied via `[dir='rtl']` and per-element `dir="rtl"` attributes.

## Key files and packages

- `frontend/tailwind.config.js` — design-token source of truth: color palette (`iris-canvas`, `iris-shadow`, `iris-border`, `clinical-cyan`, `mint-vital`, `tier-critical`/`tier-moderate`/`tier-minor`, `pearl`, `ash`), fonts (`gilroy`, `urdu`, `nastaliq`), radii (`card`, `panel`), shadows (`panel`, `glow`, `mint`), keyframes/animations (`pulse-ring`, `pulse-ring-mint`, `pulse-ring-critical`, `route-flow`, `wave-bar`, `fade-rise`), and animation aliases.
- `frontend/src/index.css` — entry point that imports Leaflet CSS, emits `@tailwind base/components/utilities`, defines the `base` layer (dark `color-scheme`, body gradient background, scrollbar, focus ring, RTL Urdu block), the `components` layer (`.card`, `.card-panel`, `.pill*`, `.tag`, `.field`, `.field-select`, `.label`, `.metric-value`), the `utilities` layer (`.text-balance`, `.wave-bar`, `.hairline-top`), and a complete Leaflet reskin (tile filter, attribution, bar, popup, marker halos, animated route vectors).
- `frontend/postcss.config.js` — PostCSS pipeline registering `tailwindcss` and `autoprefixer`.
- `frontend/package.json` — pins Tailwind 3.4.13, PostCSS 8.4.47, Autoprefixer 10.4.20, Leaflet 1.9.4, React 18.3.1; build script runs `tsc --noEmit && vite build`.
- `frontend/src/components/ui.tsx` — primitive React components (`Card`, `Pill`, `Tag`, `TierBadge`, `UrduChip`, `StatusDot`, `Spinner`, `AudioWave`, `Metric`, `EmptyState`, `ErrorNote`) that encode the style rules as props/classes so views never write raw CSS directly.
- `frontend/src/views/*.tsx` — view-level composition that consumes the primitives and applies Tailwind utilities for layout (e.g. `sm:grid-cols-2 lg:grid-cols-4` responsive grids).

## Architecture and conventions

1. **Design tokens live only in `tailwind.config.js`**. Colors, fonts, radii, shadows, and animations are extended there and consumed everywhere via Tailwind's `bg-*`, `text-*`, `font-*`, `rounded-*`, `shadow-*`, `animate-*` utilities. No arbitrary values or inline hex literals are used for theming except in the Leaflet reskin section of `index.css` (which targets third-party DOM nodes).

2. **Layered CSS organization** (`@layer base / components / utilities`) in `index.css` mirrors Tailwind's cascade. Base sets global defaults (dark mode, body gradient, RTL Urdu, focus ring); Components defines semantic class names (`.card`, `.pill`, `.field`, `.tag`); Utilities adds small helpers (`.text-balance`, `.wave-bar`, `.hairline-top`).

3. **Component primitives centralize styling**. `ui.tsx` exposes typed React components (`Pill` with `variant` prop mapping to `pill-primary|cyan|mint|danger|ghost`, `Tag` with `tone`, `StatusDot` with `tone`, `TierBadge` driven by `TIER_META` from `lib/urdu`). Views compose these instead of writing ad-hoc class strings, keeping the pill geometry and severity palette consistent.

4. **Severity scale is explicit and inspectable**. The tier colors (`tier-critical`, `tier-moderate`, `tier-minor`) plus `TIER_META` drive badges, tags, and alert cards uniformly across views.

5. **Leaflet is fully reskinned**. `index.css` overrides Leaflet's tile pane with a brightness/contrast/saturation/hue-rotate filter to dim OSM tiles, recolors attribution, bars, popups, and defines `.ll-marker--reporter/--responder/--bhu/--idle` marker halos using the clinical palette. Animated route vectors use a custom `@keyframes ll-route-flow` because Leaflet injects `<path>` elements outside Tailwind's purging scope.

6. **Urdu-first typography and RTL**. The `urdu` font stack is declared in Tailwind config; `[dir='rtl']` in base applies it globally when an RTL context is detected; individual Urdu snippets use `dir="rtl"` and `font-urdu leading-7`. English labels stay LTR with the Gilroy/Inter stack.

7. **Animations are tokenized**. Pulse rings for live data, audio waves, route flow, and fade-rises are defined once in `tailwind.config.js` under `keyframes`/`animation` and reused via `animate-*` utilities.

## Conventions and constraints

- **Canvas is always Deep Iris** — comments in both `tailwind.config.js` and `index.css` state "Canvas is always Deep Iris — never neutral black or gray", and the body uses `bg-iris-canvas` with radial gradients rather than plain black.
- **Every interactive element is pill geometry** — `ui.tsx` enforces this through the `Pill` component and the shared `.pill` base class (`rounded-full`); buttons, tags, and status chips all derive from it.
- **Cards use two radii**: 24px (`rounded-card`) for content cards and 32px (`rounded-panel`) for top-level panels, controlled via the `panel` prop on `Card`.
- **Severity must be expressed through the tier system** — `TierBadge` looks up `TIER_META[tier]` and renders the corresponding color/dot/pulse; ad-hoc severity colors are not introduced in views.
- **Leaflet styles are isolated to `index.css`** — because Leaflet injects DOM at runtime, its overrides are placed after the Tailwind directives and use `!important` where necessary to beat third-party styles.
- **No external UI framework** — the project does not import any component library (MUI, Chakra, Radix, etc.); all UI primitives are local to `src/components/ui.tsx`.
- **Build-time typecheck is part of the build** — `npm run build` runs `tsc --noEmit` before `vite build`, so TypeScript errors block production builds.