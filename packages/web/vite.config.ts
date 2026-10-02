import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

// The dev server passes the Hub's routes through, so the web UI and the Hub share one origin:
// the sign-in cookie stays host-only, and the Hub's Origin check sees this server's origin.
const hub = process.env.HUB_URL ?? "http://127.0.0.1:7777"

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/auth": hub,
      "/health": hub,
      "/ws": { target: hub, ws: true },
    },
  },
})
