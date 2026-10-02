import stylex from "@stylexjs/unplugin/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

export default defineConfig({
  // StyleX compiles stylex.create() calls away and collects their CSS into the bundle; in dev it
  // injects that CSS into index.html and hot-reloads it.
  plugins: [stylex(), react()],
})
