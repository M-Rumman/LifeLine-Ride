import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * Dev server: port 3000, same-origin API proxy.
 *
 * WHY A PROXY (not the direct CORS call the app used to make)
 *   The cockpit fetches `/api/v1/...`, `/health` and `/media/...` as RELATIVE
 *   URLs, so the browser only ever talks to this dev server and there is no
 *   cross-origin request to preflight at all — one less thing that can break
 *   mid-demo. backend/main.py still whitelists :3000 in CORS_ORIGINS, so the
 *   direct mode keeps working if VITE_API_URL is set to an absolute origin.
 *
 * WHY THE TARGET IS READ FROM THE REPO-ROOT .env
 *   The backend port is whatever `PORT` says there (currently 5050, NOT the
 *   5000 some docs assume). Deriving the proxy target from the same file the
 *   backend reads means the two can never silently disagree; if PORT changes,
 *   this follows with no edit here. Override with BACKEND_ORIGIN when you need
 *   to point the cockpit at a remote or differently-ported instance.
 */
function backendOrigin(): string {
  const override = process.env.BACKEND_ORIGIN
  if (override) return override.replace(/\/+$/, '')

  try {
    // process.cwd() is frontend/ under `npm run dev`; `__dirname` is not
    // reliably defined in an ESM-loaded Vite config, so cwd is the portable
    // anchor here.
    const env = readFileSync(resolve(process.cwd(), '../.env'), 'utf8')
    const port = /^\s*PORT\s*=\s*(\d+)\s*$/m.exec(env)?.[1]
    if (port) return `http://localhost:${port}`
  } catch {
    // No readable .env — fall through to the documented default.
  }
  return 'http://localhost:5050'
}

const TARGET = backendOrigin()

/** Everything the cockpit consumes from FastAPI, proxied same-origin. */
const proxy = {
  '/api': { target: TARGET, changeOrigin: true },
  '/health': { target: TARGET, changeOrigin: true },
  '/responder': { target: TARGET, changeOrigin: true },
  // Cached help-bot TTS wavs served by main.py's /media static mount.
  '/media': { target: TARGET, changeOrigin: true },
}

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    host: true,
    proxy,
  },
  preview: {
    port: 3000,
    host: true,
    proxy,
  },
})
