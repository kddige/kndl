import stylex from "@stylexjs/unplugin/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

// The dev server passes the Hub's routes through, so the web UI and the Hub share one origin:
// the sign-in cookie stays host-only, and the Hub's Origin check sees this server's origin.
const hub = process.env.HUB_URL ?? "http://127.0.0.1:7777"

export default defineConfig({
  // StyleX compiles stylex.create() calls away and collects their CSS into the bundle; in dev it
  // injects that CSS into index.html and hot-reloads it.
  plugins: [stylex(), react()],
  server: {
    proxy: {
      "/auth": hub,
      "^/cli(?:/|$)": hub,
      "/health": hub,
      "/runner/": hub,
      "/ws": { target: hub, ws: true },
    },
  },
})
