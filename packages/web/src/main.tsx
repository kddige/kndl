import { RouterProvider } from "@tanstack/react-router"
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { router } from "./router.tsx"
import { setTheme } from "./ui/theme.ts"
import "./ui/reset.css"

const root = document.getElementById("root")
if (!root) throw new Error("index.html has no #root element")

setTheme("system")

createRoot(root).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
)
