import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The cockpit talks to the FastAPI backend directly (CORS is enabled in
// backend/main.py). VITE_API_URL overrides the default at build time.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true,
  },
  preview: {
    port: 4173,
    host: true,
  },
})
