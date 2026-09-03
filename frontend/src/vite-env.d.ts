/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL?: string
  readonly VITE_POLL_MS?: string
  readonly VITE_MEDIA_ROOT?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
