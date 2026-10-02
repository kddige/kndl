import type { SessionId } from "@claude-hub/protocol"
import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Outlet,
  type RouterHistory,
} from "@tanstack/react-router"
import { HubShell } from "./app/HubShell.tsx"
import { SessionView } from "./session/SessionView.tsx"
import { SessionList } from "./sessions/SessionList.tsx"
import type { ThemeMode } from "./ui/theme.ts"
import { UIProvider } from "./ui/UIProvider.tsx"

const rootRoute = createRootRoute({
  component: () => (
    <UIProvider>
      <Outlet />
    </UIProvider>
  ),
})

/** Everything that needs the Hub: signed in and connected, under the app's header. */
const hubRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "hub",
  component: HubShell,
})

const sessionsRoute = createRoute({
  getParentRoute: () => hubRoute,
  path: "/",
  component: SessionList,
})

const sessionRoute = createRoute({
  getParentRoute: () => hubRoute,
  path: "/sessions/$sessionId",
  component: function SessionRoute() {
    const { sessionId } = sessionRoute.useParams()
    // Remount per Session, so the composer's draft and the scroll position don't carry over.
    return <SessionView key={sessionId} sessionId={sessionId as SessionId} />
  },
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

const routeTree = rootRoute.addChildren([
  hubRoute.addChildren([sessionsRoute, sessionRoute]),
  kitRoute,
])

export function createAppRouter(history?: RouterHistory) {
  return createRouter({ routeTree, ...(history && { history }) })
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createAppRouter>
  }
}
