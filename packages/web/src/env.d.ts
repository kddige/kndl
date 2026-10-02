/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** `1` runs the UI against the in-process fake Hub; `signed-out` starts it signed out. */
  readonly VITE_FAKE_HUB?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
