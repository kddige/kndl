import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Outlet,
} from "@tanstack/react-router"
import { App } from "./App.tsx"
import type { ThemeMode } from "./ui/theme.ts"
import { UIProvider } from "./ui/UIProvider.tsx"

const rootRoute = createRootRoute({
  component: () => (
    <UIProvider>
      <Outlet />
    </UIProvider>
  ),
})

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: App,
})

/** Every UI component in every state, for building and reviewing the kit. Loaded on demand. */
const kitRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/kit",
  // ?theme=light|dark forces a palette, so both can be reviewed (and screenshotted) by URL.
  validateSearch: (search: Record<string, unknown>): { theme?: ThemeMode } =>
    search["theme"] === "light" || search["theme"] === "dark" ? { theme: search["theme"] } : {},
  component: lazyRouteComponent(() => import("./kit/KitPage.tsx"), "KitPage"),
})

const routeTree = rootRoute.addChildren([indexRoute, kitRoute])

export const router = createRouter({ routeTree })

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router
  }
}
