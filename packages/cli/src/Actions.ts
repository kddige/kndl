// What the commands do to the machine, shared by onboard, `doctor --fix`, update and the service
// commands: run a plan's Steps, build, install and start the services, issue a token. Each is thin:
// the decisions are made in the pure modules, and the Steps run through Shell.
import { existsSync } from "node:fs"
import { chmod, mkdir, writeFile } from "node:fs/promises"
import { userInfo } from "node:os"
import { delimiter, dirname } from "node:path"
import { issueRunnerToken } from "@claude-hub/hub/src/Admin.ts"
import { claudeConfigPath, trustDirectory } from "@claude-hub/runner/src/ClaudeConfig.ts"
import { ConfigProvider, Console, Effect } from "effect"
import { Prompt } from "effect/cli"
import { fail } from "./Failure.ts"
import {
  bunPath,
  configuredRoles,
  health,
  homeEnvironment,
  hubLocalUrl,
  isInstalled,
  readEnvValues,
  serviceState,
  serviceTarget,
} from "./Host.ts"
import type { Layout, Role } from "./Layout.ts"
import type { PrerequisitePlan } from "./Prerequisites.ts"
import {
  enableLingerStep,
  installSteps,
  type Platform,
  serviceFile,
  serviceFilePath,
  startSteps,
  stopSteps,
} from "./Services.ts"
import { describeStep, Shell, type Step } from "./Shell.ts"
import { buildSteps } from "./Update.ts"

export const RoleTitle: Record<Role, string> = { hub: "Hub", runner: "Runner" }

/** The install line, for the commands that need an install and find none. */
export const InstallLine =
  "gh api repos/kddige/claude-hub/contents/install.sh -H 'Accept: application/vnd.github.raw' | sh"

/** Fails unless the home holds an installed checkout. */
export const requireInstall = (layout: Layout) =>
  isInstalled(layout)
    ? Effect.void
    : Effect.fail(
        fail(
          `No claude-hub install in ${layout.home.dir} (no ${layout.app}). Install it with:\n\n  ${InstallLine}\n\nor set CLAUDE_HUB_HOME to the home you installed.`,
        ),
      )

/** Fails on a platform claude-hub doesn't run services on. */
export const requirePlatform = (on: Platform | undefined) =>
  on === undefined
    ? Effect.fail(fail(`claude-hub runs on macOS and Linux, not ${process.platform}.`))
    : Effect.succeed(on)

/** Runs Steps in order, attached to the terminal, saying what each is for. */
export const runSteps = (steps: ReadonlyArray<Step>) =>
  Effect.gen(function* () {
    const shell = yield* Shell
    for (const s of steps) {
      if (s.why !== undefined && !(shell.dryRun && s.system)) yield* Console.log(`- ${s.why}`)
      yield* shell.attached(s)
    }
  }).pipe(Effect.mapError((error) => fail(error.message)))

/** Prints what a prerequisite plan would run, for a confirmation or a refusal. */
export function describePlan(plan: PrerequisitePlan): string {
  return plan.steps.map((s) => `  ${describeStep(s)}`).join("\n")
}

/**
 * Installs the prerequisites the plan can, after one confirmation that names sudo when it is
 * needed. `approved` answers it without asking (`--install-prerequisites`, `--yes`). Returns
 * whether it ran.
 */
export const installPrerequisites = (
  plan: PrerequisitePlan,
  options: { readonly approved: boolean | undefined; readonly interactive: boolean },
) =>
  Effect.gen(function* () {
    if (plan.steps.length === 0) return false
    yield* Console.log(
      `To install what's missing, claude-hub would run${plan.needsSudo ? " (with sudo)" : ""}:\n${describePlan(plan)}`,
    )
    const approved =
      options.approved ??
      (options.interactive
        ? yield* Prompt.Confirm({ message: "Run these now?", initial: true })
        : false)
    if (!approved) {
      yield* Console.log("Skipped: run them yourself, or `claude-hub doctor --fix`.")
      return false
    }
    yield* runSteps(plan.steps)
    for (const line of plan.afterwards) yield* Console.log(line)
    return true
  })

/** Builds what the roles run: dependencies, the mod for a Runner, the web UI for a Hub. */
export const build = (layout: Layout, roles: ReadonlyArray<Role>) =>
  runSteps(buildSteps(layout.app, bunPath(), roles))

/** The PATH a service runs with: Bun's directory first, then this one's. */
function servicePath(): string {
  const entries = [dirname(bunPath()), ...(process.env.PATH ?? "").split(delimiter)]
  return [...new Set(entries.filter((entry) => entry.length > 0))].join(delimiter)
}

/** Writes a role's service file and loads it, which starts it. */
export const installService = (layout: Layout, role: Role, on: Platform) =>
  Effect.gen(function* () {
    if (!existsSync(layout.envFile(role))) {
      return yield* fail(
        `The ${RoleTitle[role]} isn't set up here (${layout.envFile(role)} is missing): run \`claude-hub onboard\`.`,
      )
    }
    const target = serviceTarget(layout, role, on)
    const path = serviceFilePath(target)
    const text = serviceFile(on, { role, layout, bun: bunPath(), path: servicePath() })
    yield* Effect.promise(async () => {
      await mkdir(layout.logs, { recursive: true })
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, text, { mode: 0o644 })
    })
    yield* Console.log(`- ${RoleTitle[role]} service: ${path}`)
    yield* runSteps(installSteps(target))
  })

export const startService = (layout: Layout, role: Role, on: Platform) =>
  Effect.gen(function* () {
    const target = serviceTarget(layout, role, on)
    if (!existsSync(serviceFilePath(target))) {
      return yield* fail(
        `The ${RoleTitle[role]} service isn't installed: \`claude-hub ${role} install\`.`,
      )
    }
    yield* runSteps(startSteps(target))
  })

export const stopService = (layout: Layout, role: Role, on: Platform) =>
  runSteps(stopSteps(serviceTarget(layout, role, on)))

/** Rewrites and reloads the installed services, as after an update. */
export const restartInstalledServices = (layout: Layout, on: Platform) =>
  Effect.gen(function* () {
    for (const role of configuredRoles(layout)) {
      const state = yield* serviceState(serviceTarget(layout, role, on))
      if (state._tag === "NotInstalled") continue
      yield* installService(layout, role, on)
    }
  })

/** Lets the user's services run while they're logged out (Linux), or says how. */
export const enableLinger = Effect.gen(function* () {
  const user = userInfo().username
  const shell = yield* Shell
  const ran = yield* shell.attached({ ...enableLingerStep(user), mayFail: true })
  if (ran !== 0) {
    yield* Console.log(`Couldn't turn on lingering: run \`sudo loginctl enable-linger ${user}\`.`)
  }
}).pipe(Effect.mapError((error) => fail(error.message)))

/** Restricts an env file to this user: it holds secrets. */
export const restrictEnvFile = (path: string) => Effect.promise(() => chmod(path, 0o600))

/** Trusts the Runner's sessions root in Claude Code's config file, as the Runner does on start. */
export const trustSessionsRoot = (layout: Layout) =>
  Effect.gen(function* () {
    const root = readEnvValues(layout.envFile("runner")).RUNNER_SESSIONS_ROOT ?? layout.sessions
    yield* Effect.promise(() => mkdir(root, { recursive: true }))
    const outcome = yield* trustDirectory(claudeConfigPath(), root)
    if (outcome._tag === "NoConfigFile") {
      yield* Console.log("Claude Code's config file doesn't exist: run `claude` once and sign in.")
    }
  }).pipe(Effect.mapError((error) => fail(error.message)))

/**
 * Issues a Runner's token in this home's Hub database, the one the Hub's service opens. Refuses
 * when no Hub is set up here.
 */
export const issueToken = (layout: Layout, name: string) =>
  Effect.gen(function* () {
    const env = homeEnvironment(layout, "hub")
    if (!existsSync(layout.envFile("hub")) && env.HUB_DATABASE === undefined) {
      return yield* fail(
        `No Hub is set up in ${layout.home.dir}: issue the token on the Hub's machine, or run \`claude-hub onboard\` here first.`,
      )
    }
    return yield* issueRunnerToken(name).pipe(
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
      Effect.mapError((error) => fail(`Could not issue a token for ${name}: ${String(error)}`)),
    )
  })

/**
 * Waits for the Hub's `/health` from this machine, up to `seconds`. A dry run, which started
 * nothing, doesn't wait.
 */
export const waitForHub = (layout: Layout, seconds = 30) =>
  Effect.gen(function* () {
    const url = hubLocalUrl(layout)
    if ((yield* Shell).dryRun) return { url, ok: false, detail: "not checked in a dry run" }
    for (let waited = 0; ; waited += 1) {
      const result = yield* health(url)
      if (result.ok || waited >= seconds) return result
      yield* Effect.sleep("1 second")
    }
  })
