import {
  type AgentId,
  type ThreadId,
  type TurnId,
  branchNameProblem,
  InviteOnlyPath,
  InvitePath,
  newBranchProblem,
  type RunnerId,
  type SessionId,
  SetupPath,
  type ThinkingLevel,
  ThinkingLevels,
} from "@kndl/protocol"
import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Outlet,
  type RouterHistory,
} from "@tanstack/react-router"
import { AccountView } from "./account/AccountView.tsx"
import { CliLoginDonePage, CliLoginPage, readCliLoginSearch } from "./account/CliLogin.tsx"
import { HubShell } from "./app/HubShell.tsx"
import { EnvironmentList } from "./environment/EnvironmentList.tsx"
import { EnvironmentView } from "./environment/EnvironmentView.tsx"
import { HubPage } from "./hubpage/HubPage.tsx"
import { McpServersView } from "./mcp/McpServersView.tsx"
import { AdmissionPage, InviteOnlyPage } from "./people/AdmissionPages.tsx"
import { PeopleView } from "./people/PeopleView.tsx"
import { RunnersView } from "./runners/RunnersView.tsx"
import { type SessionTab, SessionView } from "./session/SessionView.tsx"
import { AllArchivedSessions, ArchivedSessions } from "./sessions/ArchivedSessions.tsx"
import { branchFromSearch } from "./sessions/branches.ts"
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

const nonEmpty = (value: unknown): value is string => typeof value === "string" && value !== ""

/** Where the Session view is: its chat, one of its agents' views or threads, or its terminal. */
interface SessionSearch {
  tab?: SessionTab
  /** A subagent whose view is open (ADR 0014), in the chat. */
  agent?: string
  /** A thread whose panel is open (docs/design/durable-harness.md), beside the chat. */
  thread?: string
  /** A Turn a new thread is being written off, in the thread panel. */
  fork?: string
}

const sessionRoute = createRoute({
  getParentRoute: () => hubRoute,
  path: "/sessions/$sessionId",
  // ?tab=terminal opens the terminal, ?agent= an agent's view, ?thread= a thread and ?fork= a new
  // one off a Turn, so each can be linked to and stays open on reload.
  validateSearch: (search: Record<string, unknown>): SessionSearch =>
    search["tab"] === "terminal"
      ? { tab: "terminal" }
      : nonEmpty(search["agent"])
        ? { agent: search["agent"] }
        : nonEmpty(search["thread"])
          ? { thread: search["thread"] }
          : nonEmpty(search["fork"])
            ? { fork: search["fork"] }
            : {},
  component: function SessionRoute() {
    const { sessionId } = sessionRoute.useParams()
    const { tab, agent, thread, fork } = sessionRoute.useSearch()
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
        {...(agent !== undefined && { agentId: agent as AgentId })}
        onAgentChange={(next) =>
          void navigate({ search: next === undefined ? {} : { agent: next } })
        }
        {...(thread !== undefined && { threadId: thread as ThreadId })}
        {...(fork !== undefined && { forkOf: fork as TurnId })}
        onThreadChange={(next, options) =>
          void navigate({
            search:
              next === undefined ? {} : "thread" in next ? { thread: next.thread } : { fork: next.fork },
            ...(options?.replace === true && { replace: true }),
          })
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
  /** Its branch choice (ADR 0023): the branch, and `from` or `direct` as `branchSearch` says. */
  branch?: string
  from?: string
  direct?: true
  runner?: string
  /** Its model and thinking level (#128); the Hub checks them when it starts it. */
  model?: string
  thinking?: ThinkingLevel
}

/**
 * The setup's search, read: a branch git would refuse is left out, as if the search had none.
 */
function readSetupSearch(search: Record<string, unknown>): SetupSearch {
  const { branch, from, direct, runner, model, thinking } = search
  const refused = nonEmpty(from)
    ? newBranchProblem(String(branch), from) !== undefined || branchNameProblem(from) !== undefined
    : branchNameProblem(String(branch)) !== undefined
  return nonEmpty(branch) && !refused
    ? {
        branch,
        ...(nonEmpty(from) && { from }),
        ...((direct === true || direct === "true") && !nonEmpty(from) && { direct: true as const }),
        ...(nonEmpty(runner) && { runner }),
        ...(nonEmpty(model) && { model }),
        ...(ThinkingLevels.some((level) => level === thinking) && {
          thinking: thinking as ThinkingLevel,
        }),
      }
    : {}
}

/**
 * A Repo's Environment (ADR 0009). With ?branch=, it's the setup before the Repo's first Session,
 * which starts on that branch (and ?from=, ?direct=, ?runner=, ?model=, ?thinking=)
 * once the Environment is applied.
 */
const environmentRoute = createRoute({
  getParentRoute: () => hubRoute,
  path: "/repos/$owner/$repo/environment",
  validateSearch: readSetupSearch,
  component: function EnvironmentRoute() {
    const { owner, repo } = environmentRoute.useParams()
    // Read again: the router merges in its parents' search as the URL had it, whatever this refused.
    const { branch, from, direct, runner, model, thinking } = readSetupSearch(
      environmentRoute.useSearch(),
    )
    return (
      <EnvironmentView
        key={`${owner}/${repo}`}
        repo={`${owner}/${repo}`}
        pendingSession={
          branch === undefined
            ? undefined
            : {
                branch: branchFromSearch({
                  branch,
                  ...(from !== undefined && { from }),
                  ...(direct !== undefined && { direct }),
                }),
                ...(runner !== undefined && { runnerId: runner as RunnerId }),
                ...(model !== undefined && { model }),
                ...(thinking !== undefined && { thinkingLevel: thinking }),
              }
        }
      />
    )
  },
})

/** The signed-in person's own settings: their Claude credential (ADR 0015). */
const accountRoute = createRoute({
  getParentRoute: () => hubRoute,
  path: "/account",
  component: AccountView,
})

/** The Hub-wide shared variables that Environments link. */
const variablesRoute = createRoute({
  getParentRoute: () => hubRoute,
  path: "/variables",
  component: SharedVariablesView,
})

/**
 * The MCP page: remote MCP servers, and their Installations on Repos (ADR 0020). With
 * ?installation=, that Installation's dialog opens, to fix one that keeps a Session from starting
 * (#216). With ?connected=1 or ?connectError= too, the Hub sent the browser back from connecting
 * it (#217): the page says how that came out instead.
 */
const mcpServersRoute = createRoute({
  getParentRoute: () => hubRoute,
  path: "/mcp",
  validateSearch: (
    search: Record<string, unknown>,
  ): { installation?: string; connected?: boolean; connectError?: string } => ({
    ...(nonEmpty(search["installation"]) && { installation: search["installation"] }),
    ...((search["connected"] === 1 || search["connected"] === "1") && { connected: true }),
    ...(nonEmpty(search["connectError"]) && { connectError: search["connectError"] }),
  }),
  component: function McpServersRoute() {
    const { installation, connected, connectError } = mcpServersRoute.useSearch()
    const returned = connected === true || connectError !== undefined
    return returned ? (
      <McpServersView returned={{ installation, connected, connectError }} />
    ) : (
      <McpServersView opening={installation} />
    )
  },
})

/** The Runners paired with the Hub: adding, Re-pairing and removing them (issue #85). */
const runnersRoute = createRoute({
  getParentRoute: () => hubRoute,
  path: "/runners",
  component: RunnersView,
})

/** Who can sign in, for the Hub's Owner: Members and Invites (issue #209). */
const peopleRoute = createRoute({
  getParentRoute: () => hubRoute,
  path: "/people",
  component: PeopleView,
})

/** The kndl the Hub runs, and whether a newer one is out, for the Hub's Owner (ADR 0028). */
const hubPageRoute = createRoute({
  getParentRoute: () => hubRoute,
  path: "/hub",
  component: HubPage,
})

/**
 * Where a Setup link and an Invite land (issue #209): on their own, without the sidebar, since
 * whoever opens one isn't signed in yet. The secret is in the fragment, which the router leaves be.
 */
const setupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: SetupPath,
  component: () => <AdmissionPage kind="setup" />,
})

const inviteRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: InvitePath,
  component: () => <AdmissionPage kind="invite" />,
})

/** Where the Hub sends anyone GitHub sign-in didn't let in. */
const inviteOnlyRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: InviteOnlyPath,
  component: InviteOnlyPage,
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

/**
 * Approving `kndl login` on a machine (issue #179): on its own, without the sidebar, and
 * signed in or not.
 */
const cliLoginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/cli-login",
  validateSearch: readCliLoginSearch,
  component: function CliLoginRoute() {
    return <CliLoginPage search={cliLoginRoute.useSearch()} />
  },
})

/** Where the CLI sends the browser once it is signed in. */
const cliLoginDoneRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/cli-login/done",
  validateSearch: (search: Record<string, unknown>): { machine?: string } =>
    nonEmpty(search["machine"]) ? { machine: search["machine"] } : {},
  component: function CliLoginDoneRoute() {
    const { machine } = cliLoginDoneRoute.useSearch()
    return <CliLoginDonePage {...(machine !== undefined && { machine })} />
  },
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
    mcpServersRoute,
    accountRoute,
    runnersRoute,
    peopleRoute,
    hubPageRoute,
  ]),
  setupRoute,
  inviteRoute,
  inviteOnlyRoute,
  cliLoginRoute,
  cliLoginDoneRoute,
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
