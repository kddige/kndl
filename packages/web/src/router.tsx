import type { RunnerId, SessionId } from "@claude-hub/protocol"
import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Outlet,
  type RouterHistory,
} from "@tanstack/react-router"
import { HubShell } from "./app/HubShell.tsx"
import { EnvironmentList } from "./environment/EnvironmentList.tsx"
import { EnvironmentView } from "./environment/EnvironmentView.tsx"
import { RunnersView } from "./runners/RunnersView.tsx"
import { type SessionTab, SessionView } from "./session/SessionView.tsx"
import { AllArchivedSessions, ArchivedSessions } from "./sessions/ArchivedSessions.tsx"
import { Home } from "./sessions/Home.tsx"
import type { ThemeMode } from "./ui/theme.ts"
import { UIProvider } from "./ui/UIProvider.tsx"
import { SharedVariablesView } from "./variables/SharedVariablesView.tsx"

const rootRoute = createRootRoute({
  component: () => (
    <UIProvider>
      <Outlet />
    </UIProvider>
  ),
})

/** Everything that needs the Hub: signed in and connected, beside the app's sidebar. */
const hubRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "hub",
  component: HubShell,
})

const homeRoute = createRoute({
  getParentRoute: () => hubRoute,
  path: "/",
  component: Home,
})

const sessionRoute = createRoute({
  getParentRoute: () => hubRoute,
  path: "/sessions/$sessionId",
  // ?tab=terminal opens the terminal, so it can be linked to and stays open on reload.
  validateSearch: (search: Record<string, unknown>): { tab?: SessionTab } =>
    search["tab"] === "terminal" ? { tab: "terminal" } : {},
  component: function SessionRoute() {
    const { sessionId } = sessionRoute.useParams()
    const { tab } = sessionRoute.useSearch()
    const navigate = sessionRoute.useNavigate()
    // Remount per Session, so the composer's draft and the scroll position don't carry over.
    return (
      <SessionView
        key={sessionId}
        sessionId={sessionId as SessionId}
        tab={tab ?? "chat"}
        onTabChange={(next) =>
          void navigate({ search: next === "terminal" ? { tab: next } : {}, replace: true })
        }
      />
    )
  },
})

/** A Repo's Archived Sessions, restorable until they're purged. */
const archivedRoute = createRoute({
  getParentRoute: () => hubRoute,
  path: "/repos/$owner/$repo/archived",
  component: function ArchivedRoute() {
    const { owner, repo } = archivedRoute.useParams()
    return <ArchivedSessions repo={`${owner}/${repo}`} />
  },
})

/** Every Repo's Archived Sessions, grouped by Repo. */
const allArchivedRoute = createRoute({
  getParentRoute: () => hubRoute,
  path: "/archive",
  component: AllArchivedSessions,
})

/** A way to each Repo's Environment. */
const environmentsRoute = createRoute({
  getParentRoute: () => hubRoute,
  path: "/environments",
  component: EnvironmentList,
})

/** The Session to start once a Repo's first Environment is applied. */
interface SetupSearch {
  /** Its base branch. */
  branch?: string
  runner?: string
}

/**
 * A Repo's Environment (ADR 0009). With ?branch=, it's the setup before the Repo's first Session,
 * which starts on that branch (and ?runner=) once the Environment is applied.
 */
const environmentRoute = createRoute({
  getParentRoute: () => hubRoute,
  path: "/repos/$owner/$repo/environment",
  validateSearch: (search: Record<string, unknown>): SetupSearch => {
    const { branch, runner } = search
    return typeof branch === "string" && branch !== ""
      ? { branch, ...(typeof runner === "string" && runner !== "" && { runner }) }
      : {}
  },
  component: function EnvironmentRoute() {
    const { owner, repo } = environmentRoute.useParams()
    const { branch, runner } = environmentRoute.useSearch()
    return (
      <EnvironmentView
        key={`${owner}/${repo}`}
        repo={`${owner}/${repo}`}
        pendingSession={
          branch === undefined
            ? undefined
            : { baseBranch: branch, ...(runner !== undefined && { runnerId: runner as RunnerId }) }
        }
      />
    )
  },
})

/** The Hub-wide shared variables that Environments link. */
const variablesRoute = createRoute({
  getParentRoute: () => hubRoute,
  path: "/variables",
  component: SharedVariablesView,
})

/** The Runners paired with the Hub: adding, Re-pairing and removing them (issue #85). */
const runnersRoute = createRoute({
  getParentRoute: () => hubRoute,
  path: "/runners",
  component: RunnersView,
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
  hubRoute.addChildren([
    homeRoute,
    sessionRoute,
    allArchivedRoute,
    archivedRoute,
    environmentsRoute,
    environmentRoute,
    variablesRoute,
    runnersRoute,
  ]),
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
