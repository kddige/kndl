// What `claude-hub doctor` checks, and what `--fix` can repair. Host.ts gathers the facts; this
// turns them into checks, pure and tested; Cli.ts prints them and runs the fixes.
import { describeDrift } from "@claude-hub/hub/src/AppPermissions.ts"
import { type AppPermissionsCheck, hasPermissionDrift } from "@claude-hub/protocol"
import { DataEntries, type OldData } from "./HomeData.ts"
import type { Role } from "./Layout.ts"
import type { PrerequisitePlan } from "./Prerequisites.ts"
import { describeServiceState, type ServiceState } from "./Services.ts"

/** What doctor found on this machine. */
export interface DoctorFacts {
  readonly home: string
  /** Whether `<home>/app` is a git checkout. */
  readonly installed: boolean
  readonly wrapper: {
    readonly path: string
    readonly exists: boolean
    /** Runs this home's CLI, as install.sh writes it. */
    readonly current: boolean
    /** Whether `claude-hub` on PATH is this wrapper. */
    readonly onPath: boolean
  }
  /** The roles set up here: which env files exist. */
  readonly roles: ReadonlyArray<Role>
  /** Data in the home that no role set up here owns: see HomeData.ts. */
  readonly oldData: OldData | undefined
  readonly prerequisites: PrerequisitePlan
  /** Each set-up role's env file: its path and permission bits. */
  readonly envFiles: ReadonlyArray<{
    readonly role: Role
    readonly path: string
    readonly mode: number
  }>
  /** Why the Hub would refuse its configuration, if it would. */
  readonly hubConfigError: string | undefined
  /**
   * The GitHub App's permissions, checked against the Hub's, when hub.env has an App; or that it
   * has GitHub sign-in without one. `undefined` with neither.
   */
  readonly githubApp: AppPermissionsFact | undefined
  /** Why the Runner would refuse its configuration, if it would. */
  readonly runnerConfigError: string | undefined
  readonly services: ReadonlyArray<{ readonly role: Role; readonly state: ServiceState }>
  readonly modBuilt: boolean
  readonly webBuilt: boolean
  /** The Runner's sessions root in Claude Code's config file. */
  readonly trust: "trusted" | "untrusted" | "no-config" | undefined
  /** The Hub's own warning about its cookies, if it would give one. */
  readonly cookieWarning: string | undefined
  /** The Hub's `/health`, from this machine, when a Hub is set up here. */
  readonly hubHealth: Health | undefined
  /** The Hub's `/health` at the Runner's HUB_URL, when a Runner is set up here. */
  readonly runnerReachesHub: Health | undefined
  /** Linux: whether the user's services keep running while they're logged out. */
  readonly linger: boolean | undefined
  /** The tmux server on the Runner's socket, when a Runner is set up here and one runs. */
  readonly tmuxServer: TmuxServerFact | undefined
}

/**
 * The tmux server the Runner starts its Sessions in. One another process started, as a Runner run
 * from a checkout since deleted, keeps that process's working directory, `PWD` and `PATH`, and a
 * Runner from before #105 launched Claude Code with them.
 */
export interface TmuxServerFact {
  readonly socket: string
  /** How many tmux sessions it has: the Runner never stops a server with any. */
  readonly sessions: number
  /** The directory it runs in, when it could be read, and whether that still exists. */
  readonly cwd: Place | undefined
  /** `PWD` in its global environment, and whether that directory exists; undefined when unset. */
  readonly pwd: Place | undefined
  /** `PATH` in its global environment. */
  readonly path: string | undefined
  /** The PATH the Runner's service runs with, from its service file, when it has one. */
  readonly servicePath: string | undefined
}

export interface Place {
  readonly path: string
  readonly exists: boolean
}

/**
 * What checking the GitHub App's permissions on GitHub found, or why it couldn't; or that hub.env
 * turns GitHub sign-in on with no App to check who can see a Repo.
 */
export type AppPermissionsFact =
  | { readonly _tag: "Checked"; readonly check: AppPermissionsCheck }
  | { readonly _tag: "Unchecked"; readonly detail: string }
  | { readonly _tag: "SignInWithoutApp" }

export interface Health {
  readonly url: string
  readonly ok: boolean
  readonly detail: string
}

/** What `--fix` can do about a check. */
export type Fix =
  | { readonly _tag: "InstallPrerequisites" }
  | { readonly _tag: "WriteWrapper" }
  | { readonly _tag: "RestrictEnvFile"; readonly path: string }
  | { readonly _tag: "BuildMod" }
  | { readonly _tag: "BuildWeb" }
  | { readonly _tag: "TrustSessionsRoot" }
  | { readonly _tag: "InstallService"; readonly role: Role }
  | { readonly _tag: "StartService"; readonly role: Role }
  | { readonly _tag: "EnableLinger" }
  /** Renames the old data aside, only once the person running doctor confirms it. */
  | { readonly _tag: "MoveOldData"; readonly entries: ReadonlyArray<string> }

export interface Check {
  readonly name: string
  readonly status: "ok" | "warn" | "fail"
  readonly detail: string
  readonly fix?: Fix
}

/** Every check, in the order doctor prints them. */
export function diagnose(facts: DoctorFacts): ReadonlyArray<Check> {
  const checks: Array<Check> = []
  if (!facts.installed) {
    return [
      {
        name: "Install",
        status: "fail",
        detail: `No claude-hub install in ${facts.home}: run install.sh, or set CLAUDE_HUB_HOME to the home you installed.`,
      },
    ]
  }
  checks.push({ name: "Install", status: "ok", detail: `${facts.home}/app` })

  checks.push(
    !facts.wrapper.exists || !facts.wrapper.current
      ? {
          name: "claude-hub command",
          status: "warn",
          detail: facts.wrapper.exists
            ? `${facts.wrapper.path} doesn't run this home's CLI.`
            : `${facts.wrapper.path} is missing.`,
          fix: { _tag: "WriteWrapper" },
        }
      : !facts.wrapper.onPath
        ? {
            name: "claude-hub command",
            status: "warn",
            detail: `${facts.wrapper.path} isn't what \`claude-hub\` runs: put its directory first on PATH.`,
          }
        : { name: "claude-hub command", status: "ok", detail: facts.wrapper.path },
  )

  if (facts.oldData !== undefined && facts.oldData.entries.length > 0) {
    const envFiles = [...new Set(facts.oldData.entries.map((entry) => `${DataEntries[entry]}.env`))]
    checks.push({
      name: "Old data",
      status: "warn",
      detail: `${facts.home} holds ${facts.oldData.entries.join(", ")} with no ${envFiles.join(" or ")}: claude-hub data that onboard didn't set up here, likely a checkout's from before ~/.claude-hub-dev. A Runner or Hub set up over it would take it over. Move it aside with \`claude-hub onboard --move-old-data\`, or \`claude-hub doctor --fix\`, which asks first; or set CLAUDE_HUB_HOME to another directory.`,
      fix: { _tag: "MoveOldData", entries: facts.oldData.entries },
    })
  }

  if (facts.roles.length === 0) {
    checks.push({
      name: "Setup",
      status: "warn",
      detail: "Neither a Hub nor a Runner is set up here: run `claude-hub onboard`.",
    })
  }

  const fixable = facts.prerequisites.missing.filter((m) => m.fixable)
  const manual = facts.prerequisites.missing.filter((m) => !m.fixable)
  if (fixable.length > 0) {
    checks.push({
      name: "Prerequisites",
      status: "fail",
      detail: fixable.map((m) => m.detail).join(" "),
      fix: { _tag: "InstallPrerequisites" },
    })
  }
  for (const m of manual) checks.push({ name: m.name, status: "fail", detail: m.detail })
  if (facts.prerequisites.missing.length === 0) {
    checks.push({ name: "Prerequisites", status: "ok", detail: "all found" })
  }

  for (const file of facts.envFiles) {
    const open = (file.mode & 0o077) !== 0
    checks.push(
      open
        ? {
            name: `${file.role}.env`,
            status: "fail",
            detail: `${file.path} is readable by others (mode ${(file.mode & 0o777).toString(8)}); it holds secrets and should be 600.`,
            fix: { _tag: "RestrictEnvFile", path: file.path },
          }
        : { name: `${file.role}.env`, status: "ok", detail: file.path },
    )
  }

  if (facts.roles.includes("hub")) {
    checks.push(
      facts.hubConfigError === undefined
        ? { name: "Hub configuration", status: "ok", detail: "the Hub accepts it" }
        : { name: "Hub configuration", status: "fail", detail: facts.hubConfigError },
    )
    if (facts.githubApp !== undefined) checks.push(appCheck(facts.githubApp))
    if (facts.cookieWarning !== undefined) {
      checks.push({ name: "LAN cookies", status: "warn", detail: facts.cookieWarning })
    }
    checks.push(
      facts.webBuilt
        ? { name: "Web UI build", status: "ok", detail: "built" }
        : {
            name: "Web UI build",
            status: "fail",
            detail: "The web UI isn't built, so the Hub's pages answer 503.",
            fix: { _tag: "BuildWeb" },
          },
    )
  }

  if (facts.roles.includes("runner")) {
    checks.push(
      facts.runnerConfigError === undefined
        ? { name: "Runner configuration", status: "ok", detail: "the Runner accepts it" }
        : { name: "Runner configuration", status: "fail", detail: facts.runnerConfigError },
    )
    checks.push(
      facts.modBuilt
        ? { name: "Mod build", status: "ok", detail: "built" }
        : {
            name: "Mod build",
            status: "fail",
            detail: "The hub-link mod isn't built, so the Runner won't start.",
            fix: { _tag: "BuildMod" },
          },
    )
    if (facts.trust === "untrusted") {
      checks.push({
        name: "Claude Code trust",
        status: "warn",
        detail:
          "The sessions root isn't trusted in Claude Code's config file yet. The Runner trusts it when it starts; until then each Session asks.",
        fix: { _tag: "TrustSessionsRoot" },
      })
    } else if (facts.trust === "no-config") {
      checks.push({
        name: "Claude Code trust",
        status: "warn",
        detail: "Claude Code's config file doesn't exist: run `claude` once and sign in.",
      })
    } else if (facts.trust === "trusted") {
      checks.push({
        name: "Claude Code trust",
        status: "ok",
        detail: "the sessions root is trusted",
      })
    }
  }

  for (const { role, state } of facts.services) {
    const name = `${role === "hub" ? "Hub" : "Runner"} service`
    switch (state._tag) {
      case "Running":
        checks.push({ name, status: "ok", detail: describeServiceState(state) })
        break
      case "NotInstalled":
        checks.push({
          name,
          status: "fail",
          detail: `not installed: \`claude-hub ${role} install\``,
          fix: { _tag: "InstallService", role },
        })
        break
      default:
        checks.push({
          name,
          status: "fail",
          detail: `${describeServiceState(state)}; its log: claude-hub logs ${role}`,
          fix: { _tag: "StartService", role },
        })
    }
  }

  if (facts.hubHealth !== undefined) checks.push(healthCheck("Hub health", facts.hubHealth))
  if (facts.runnerReachesHub !== undefined) {
    checks.push(healthCheck("Hub from the Runner", facts.runnerReachesHub))
  }

  if (facts.tmuxServer !== undefined) checks.push(tmuxServerCheck(facts.tmuxServer, facts.home))

  if (facts.linger === false) {
    checks.push({
      name: "Linger",
      status: "warn",
      detail: "The services stop when you log out, and don't start at boot until you log in.",
      fix: { _tag: "EnableLinger" },
    })
  }
  return checks
}

/**
 * The GitHub App against the permissions the Hub needs. GitHub has no API to change them, so
 * there's no fix: the detail links to where the App's owner adds them, and where each account
 * accepts them.
 */
function appCheck(fact: AppPermissionsFact): Check {
  const name = "GitHub App"
  if (fact._tag === "SignInWithoutApp") {
    // Repo access (RepoAccess.ts) asks GitHub, as the App, who is a Repo's collaborator.
    return {
      name,
      status: "fail",
      detail:
        "GitHub sign-in is on (GITHUB_CLIENT_ID), but hub.env has no GitHub App, so nobody signed in with GitHub can see any Session: the Hub asks GitHub, as the App, who can access each Repo. Create one with `claude-hub onboard --github-app create`, or set up one you made yourself with `claude-hub onboard --github-app manual`.",
    }
  }
  if (fact._tag === "Unchecked") {
    return { name, status: "warn", detail: `Couldn't check its permissions: ${fact.detail}` }
  }
  const { check } = fact
  if (hasPermissionDrift(check)) {
    return {
      name,
      status: "fail",
      detail: `${describeDrift(check).join("\n")}\nUntil then, what needs it fails: see https://kddige.github.io/claude-hub/how-to/set-up-the-github-app/.`,
    }
  }
  if (check.installed === 0) {
    return {
      name,
      status: "warn",
      detail: `${check.slug} has the permissions it needs, but isn't installed anywhere: install it on your Repos at ${check.installUrl}`,
    }
  }
  return {
    name,
    status: "ok",
    detail: `${check.slug} and its ${check.installed === 1 ? "installation have" : `${check.installed} installations have`} the permissions the Hub needs`,
  }
}

/**
 * Whether the tmux server on the Runner's socket looks like one the Runner service runs: no `PWD`
 * but the home, the service's PATH, and a working directory that still exists. A server that
 * runs elsewhere but has both of those right is fine: the Runner sets each Session's own `PWD`.
 * No fix: stopping a server is only safe with nothing in it, so the detail says what to run.
 */
export function tmuxServerCheck(server: TmuxServerFact, home: string): Check {
  const name = "tmux server"
  const sessions = `${server.sessions} session${server.sessions === 1 ? "" : "s"}`
  const problems: Array<string> = []
  if (server.cwd !== undefined && !server.cwd.exists) {
    problems.push(`runs in ${server.cwd.path}, which was deleted`)
  }
  if (server.pwd !== undefined && server.pwd.path !== home) {
    problems.push(`has PWD ${server.pwd.path}${server.pwd.exists ? "" : ", which was deleted"}`)
  }
  if (server.servicePath !== undefined && server.path !== server.servicePath) {
    problems.push(
      server.path === undefined
        ? "has no PATH"
        : `has a PATH other than the Runner service's: ${server.path}`,
    )
  }
  if (problems.length === 0) {
    const elsewhere =
      server.cwd !== undefined && server.cwd.path !== home
        ? `, started in ${server.cwd.path}`
        : ""
    return { name, status: "ok", detail: `socket ${server.socket}, ${sessions}${elsewhere}` }
  }
  const restart = "`claude-hub runner stop`, then `claude-hub runner start`"
  const fix =
    server.sessions === 0
      ? `Nothing runs in it: restart the Runner (${restart}), which replaces it, or stop it with \`tmux -L ${server.socket} kill-server\`.`
      : `It has ${sessions}, so the Runner keeps it: restarting the Runner (${restart}) gives it the Runner's PATH and unsets PWD. Once no Session runs in it, stop it with \`tmux -L ${server.socket} kill-server\` to start it fresh.`
  return {
    name,
    status: "warn",
    detail: `The tmux server on socket ${server.socket} ${problems.join("; ")}. Another process started it, as a Runner from another checkout or home, and Claude Code started with its environment can exit at once. ${fix}`,
  }
}

function healthCheck(name: string, health: Health): Check {
  return health.ok
    ? { name, status: "ok", detail: `${health.url}/health answers` }
    : { name, status: "fail", detail: `${health.url}/health: ${health.detail}` }
}

/** The mark doctor prints before a check. */
export const statusMark: Record<Check["status"], string> = { ok: "ok", warn: "!!", fail: "XX" }

/** The lines doctor prints: a check's mark, name and detail, its detail's own lines lined up. */
export function formatChecks(checks: ReadonlyArray<Check>): ReadonlyArray<string> {
  const width = Math.max(...checks.map((check) => check.name.length))
  const indent = " ".repeat(2 + 2 + width + 2)
  return checks.flatMap((check) => {
    const [first, ...rest] = check.detail.split("\n")
    return [
      `${statusMark[check.status]}  ${check.name.padEnd(width)}  ${first ?? ""}`,
      ...rest.map((line) => `${indent}${line}`),
    ]
  })
}
