/**
 * Application entry.
 *
 * StrictMode is kept ON deliberately: it double-invokes effects, which is what
 * surfaced (and now guards against) duplicate Leaflet map instances and the
 * `usePoll` mount-flag race. Shipping with StrictMode means those regressions
 * cannot come back unnoticed.
 */

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import App from './App'
import './index.css'

const container = document.getElementById('root')
if (!container) {
  throw new Error('LifeLine Ride: #root mount node is missing from index.html')
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
