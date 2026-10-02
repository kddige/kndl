import { RouterProvider } from "@tanstack/react-router"
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { createHubClient, HubProvider } from "./app/hub.tsx"
import { createAppRouter } from "./router.tsx"
import { setTheme } from "./ui/theme.ts"
import "./ui/reset.css"

const root = document.getElementById("root")
if (!root) throw new Error("index.html has no #root element")

setTheme("system")

const hub = await createHubClient()
const router = createAppRouter()

createRoot(root).render(
  <StrictMode>
    <HubProvider client={hub}>
      <RouterProvider router={router} />
    </HubProvider>
  </StrictMode>,
)
