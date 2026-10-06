// The CLI's reads of the machine: what's installed, the env files, the services, the Hub's health.
// The decisions made from them (Doctor.ts, Prerequisites.ts, Onboard.ts) are pure; this is where
// the facts come from.
import {
  accessSync,
  constants,
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs"
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { homedir, userInfo } from "node:os"
import { dirname, join } from "node:path"
import { GitHubApp } from "@claude-hub/hub/src/GitHubApp.ts"
import { HubConfig, cookieSecurity } from "@claude-hub/hub/src/HubConfig.ts"
import {
  missingModBundle,
  RunnerConfig,
  RunnerConfigLive,
} from "@claude-hub/runner/src/RunnerConfig.ts"
import { Cause, ConfigProvider, Effect, Exit, Option } from "effect"
import { FetchHttpClient } from "effect/http"
import type { AppPermissionsFact, DoctorFacts, Health } from "./Doctor.ts"
import { type EnvFile, envValues, parseEnv, renderEnv } from "./EnvFile.ts"
import { fail } from "./Failure.ts"
import type { HomeFacts } from "./Guards.ts"
import {
  asideRenames,
  DataEntries,
  findOldData,
  type HomeDataFacts,
  type Rename,
} from "./HomeData.ts"
import { isWrapperFor, type Layout, type Role, Roles, wrapperScript } from "./Layout.ts"
import { localHubUrl } from "./Onboard.ts"
import { type HostFacts, type PackageManager, prerequisitePlan } from "./Prerequisites.ts"
import {
  lingers,
  lingerStatusStep,
  type Platform,
  parseServiceState,
  type ServiceState,
  type ServiceTarget,
  serviceFilePath,
  statusStep,
} from "./Services.ts"
import { Shell, step } from "./Shell.ts"
import type { Checkout } from "./Update.ts"

/** This machine's platform, or a failure on one claude-hub doesn't install on. */
export function platform(): Platform | undefined {
  return process.platform === "darwin" || process.platform === "linux"
    ? process.platform
    : undefined
}

/** The Bun running the CLI, which the services and the wrapper run too. */
export const bunPath = (): string => process.execPath

export const isInstalled = (layout: Layout) => existsSync(join(layout.app, ".git"))

/** The roles set up in this home: those with an env file. */
export function configuredRoles(layout: Layout): ReadonlyArray<Role> {
  return Roles.filter((role) => existsSync(layout.envFile(role)))
}

/** The env file's lines, or none when it doesn't exist. */
export function readEnvFile(path: string): EnvFile {
  return existsSync(path) ? parseEnv(readFileSync(path, "utf8")) : []
}

/** The env file's variables, or none when it doesn't exist. */
export const readEnvValues = (path: string) => envValues(readEnvFile(path))

/**
 * Writes `text` to `path` with permission bits `mode`, whole: it is written beside the path and
 * renamed over it, uninterruptibly, so the file is never seen half-written, even after Ctrl-C.
 */
export const writeFileWhole = (path: string, text: string, mode: number) =>
  Effect.promise(async () => {
    await mkdir(dirname(path), { recursive: true })
    const partial = `${path}.partial-${process.pid}`
    try {
      await writeFile(partial, text, { mode })
      await chmod(partial, mode)
      await rename(partial, path)
    } finally {
      await rm(partial, { force: true })
    }
  }).pipe(Effect.uninterruptible)

/** Writes an env file, whole and readable only by this user: it holds tokens and keys. */
export const writeEnvFile = (path: string, file: EnvFile) =>
  writeFileWhole(path, renderEnv(file), 0o600)

/** What HomeData.ts decides from. */
export function homeDataFacts(layout: Layout): HomeDataFacts {
  const data = Object.keys(DataEntries).filter((entry) => {
    const path = join(layout.home.dir, entry)
    try {
      return statSync(path).isDirectory() ? readdirSync(path).length > 0 : true
    } catch {
      return false
    }
  })
  return { data, envFiles: configuredRoles(layout) }
}

/** The renames that move the home's `entries` aside, as of now, avoiding names already taken. */
export function planMoveAside(layout: Layout, entries: ReadonlyArray<string>) {
  let existing: ReadonlyArray<string> = []
  try {
    existing = readdirSync(layout.home.dir)
  } catch {
    // A home that doesn't exist has nothing to move.
  }
  return asideRenames(entries, new Date(), existing)
}

/**
 * Renames entries within the home, each only when its new name is still free: a rename never
 * replaces anything. Uninterruptible, so Ctrl-C can't stop it between two entries.
 */
export const moveAside = (layout: Layout, renames: ReadonlyArray<Rename>) =>
  Effect.tryPromise({
    try: async () => {
      for (const { from, to } of renames) {
        const target = join(layout.home.dir, to)
        if (existsSync(target)) throw new Error(`${target} already exists`)
        await rename(join(layout.home.dir, from), target)
      }
    },
    catch: (error) => fail(`Could not move the old data aside: ${errorMessage(error)}`),
  }).pipe(Effect.uninterruptible)

/** Writes the `claude-hub` wrapper. */
export const writeWrapper = (layout: Layout) =>
  writeFileWhole(layout.wrapper, wrapperScript(layout, bunPath()), 0o755)

/** The first line install.sh and {@link wrapperScript} put after the shebang. */
const WrapperMark = "# claude-hub: written by install.sh."

/** Whether the file at the wrapper's path is one claude-hub wrote, so uninstall may remove it. */
export function isOurWrapper(path: string): boolean {
  try {
    return readFileSync(path, "utf8").split("\n")[1]?.startsWith(WrapperMark) === true
  } catch {
    return false
  }
}

/** What the destructive commands' guards look at, resolved through symlinks. */
export function homeFacts(layout: Layout): HomeFacts {
  let entries: ReadonlyArray<string> = []
  try {
    entries = readdirSync(layout.home.dir)
  } catch {
    // A home that doesn't exist holds nothing, and so is refused.
  }
  return { home: resolve(layout.home.dir), userHome: resolve(layout.userHome), entries }
}

/** Where a role's service is, on this machine. */
export function serviceTarget(layout: Layout, role: Role, on: Platform): ServiceTarget {
  return {
    platform: on,
    role,
    uid: process.getuid?.() ?? 0,
    configHome: process.env.XDG_CONFIG_HOME || join(layout.userHome, ".config"),
    userHome: layout.userHome,
  }
}

/** How a role's service is doing: not installed without its file, else what launchd or systemd says. */
export const serviceState = (target: ServiceTarget) =>
  Effect.gen(function* () {
    if (!existsSync(serviceFilePath(target))) return { _tag: "NotInstalled" } satisfies ServiceState
    const shell = yield* Shell
    if (shell.dryRun) return { _tag: "Unknown", detail: "dry run" } satisfies ServiceState
    const result = yield* shell.capture(statusStep(target))
    return parseServiceState(target.platform, result)
  }).pipe(
    Effect.catchTag("StepFailed", (error) =>
      Effect.succeed({ _tag: "Unknown", detail: error.message } satisfies ServiceState),
    ),
  )

/** The Hub's `/health` at `url`. */
export const health = (url: string): Effect.Effect<Health> =>
  Effect.promise(async () => {
    const origin = new URL(url).origin
    try {
      const response = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(3000) })
      return { url: origin, ok: response.ok, detail: `answered ${response.status}` }
    } catch (error) {
      return { url: origin, ok: false, detail: `no answer (${errorMessage(error)})` }
    }
  })

/** The Hub's URL from its own machine, from `hub.env`. */
export function hubLocalUrl(layout: Layout): string {
  const port = Number(readEnvValues(layout.envFile("hub")).PORT ?? 7777)
  return localHubUrl(Number.isSafeInteger(port) ? port : 7777)
}

/** Where the installed checkout is. */
export const readCheckout = (app: string) =>
  Effect.gen(function* () {
    const shell = yield* Shell
    const git = (...args: ReadonlyArray<string>) =>
      shell
        .capture(step("git", args, { cwd: app, mayFail: true }))
        .pipe(Effect.map((result) => (result.exitCode === 0 ? result.stdout.trim() : undefined)))
    const branch = yield* git("symbolic-ref", "--quiet", "--short", "HEAD")
    const commit = (yield* git("rev-parse", "HEAD")) ?? "unknown"
    const tag = branch === undefined ? yield* git("describe", "--tags", "--exact-match") : undefined
    return { branch: branch || undefined, commit, tag: tag || undefined } satisfies Checkout
  })

/** What Prerequisites.ts plans from. */
export const hostFacts = (layout: Layout) =>
  Effect.sync(() => {
    const on = platform() ?? "linux"
    const managers: ReadonlyArray<PackageManager> = on === "darwin" ? ["brew"] : ["apt", "dnf"]
    return {
      platform: on,
      arch: process.arch,
      root: process.getuid?.() === 0,
      user: userInfo().username,
      packageManager: managers.find((manager) => has(manager === "apt" ? "apt-get" : manager)),
      tools: { git: has("git"), gh: has("gh"), curl: has("curl") },
      microsandbox: microsandboxRuntime(layout),
      kvm: on === "linux" ? kvm() : undefined,
    } satisfies HostFacts
  })

/**
 * A complete microsandbox runtime: one in microsandbox's home (`MSB_HOME`, else `~/.microsandbox`),
 * which wins, or the one `bun install` brought with the app's microsandbox package.
 */
function microsandboxRuntime(layout: Layout): boolean {
  const msbHome = process.env.MSB_HOME || join(homedir(), ".microsandbox")
  if (existsSync(join(msbHome, "bin", "msb"))) return true
  const suffix = process.platform === "linux" ? "-gnu" : ""
  try {
    const fromRunner = createRequire(join(layout.app, "packages", "runner", "package.json"))
    const sdk = dirname(fromRunner.resolve("microsandbox/package.json"))
    const native = createRequire(join(sdk, "package.json")).resolve(
      `@superradcompany/microsandbox-${process.platform}-${process.arch}${suffix}/package.json`,
    )
    return existsSync(join(dirname(native), "bin", "msb"))
  } catch {
    return false
  }
}

function kvm(): { readonly device: boolean; readonly accessible: boolean } {
  if (!existsSync("/dev/kvm")) return { device: false, accessible: false }
  try {
    accessSync("/dev/kvm", constants.R_OK | constants.W_OK)
    return { device: true, accessible: true }
  } catch {
    return { device: true, accessible: false }
  }
}

/** Why the Hub would refuse `hub.env`, checked by the Hub's own HubConfig. */
export const hubConfigError = (layout: Layout) =>
  configError(
    Effect.gen(function* () {
      yield* HubConfig
    }).pipe(Effect.provide(HubConfig.layer)),
    homeEnvironment(layout, "hub"),
  )

/** Why the Runner would refuse `runner.env`, checked by the Runner's own RunnerConfig. */
export const runnerConfigError = (layout: Layout) =>
  configError(
    Effect.gen(function* () {
      yield* RunnerConfig
    }).pipe(Effect.provide(RunnerConfigLive)),
    homeEnvironment(layout, "runner"),
  )

/**
 * hub.env's GitHub App, checked against the permissions and events the Hub needs, as the Hub
 * checks it (AppPermissions.ts). Without an App, whether GitHub sign-in is on anyway; `undefined`
 * with neither, or with a configuration the Hub refuses, which the configuration check reports.
 * `apiUrl` is GitHub's API, unless a test's.
 */
export const appPermissionsFact = (layout: Layout, apiUrl?: URL) =>
  Effect.gen(function* () {
    const { github, githubApp } = yield* HubConfig
    if (Option.isNone(githubApp)) {
      return Option.isSome(github) ? ({ _tag: "SignInWithoutApp" } as const) : undefined
    }
    const app = yield* GitHubApp.make(
      apiUrl === undefined ? githubApp.value : { ...githubApp.value, apiUrl },
    )
    return yield* app.checkPermissions.pipe(
      Effect.map((check): AppPermissionsFact => ({ _tag: "Checked", check })),
      Effect.catchTag("GitHubAppError", (error) =>
        Effect.succeed<AppPermissionsFact>({ _tag: "Unchecked", detail: error.message }),
      ),
      Effect.timeoutOrElse({
        duration: "15 seconds",
        orElse: () =>
          Effect.succeed<AppPermissionsFact>({
            _tag: "Unchecked",
            detail: "GitHub didn't answer within 15 seconds",
          }),
      }),
    )
  }).pipe(
    Effect.provide(HubConfig.layer),
    Effect.provide(FetchHttpClient.layer),
    Effect.provide(
      ConfigProvider.layer(ConfigProvider.fromEnv({ env: homeEnvironment(layout, "hub") })),
    ),
    Effect.orElseSucceed(() => undefined),
  )

/** The environment a role's service runs with: its env file, in this home, from this app. */
export function homeEnvironment(layout: Layout, role: Role): Record<string, string> {
  return {
    RUNNER_MOD_DIR: join(layout.app, "packages", "mod"),
    HUB_WEB_DIR: join(layout.app, "packages", "web", "dist"),
    ...readEnvValues(layout.envFile(role)),
    CLAUDE_HUB_HOME: layout.home.dir,
  }
}

const configError = <A, E>(check: Effect.Effect<A, E>, env: Record<string, string>) =>
  check.pipe(
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
    Effect.exit,
    Effect.map((exit) =>
      Exit.isSuccess(exit) ? undefined : errorMessage(Cause.squash(exit.cause)),
    ),
  )

/** Everything doctor checks. */
export const doctorFacts = (layout: Layout, on: Platform) =>
  Effect.gen(function* () {
    const roles = configuredRoles(layout)
    const shell = yield* Shell
    const wrapperExists = existsSync(layout.wrapper)
    const onPath = Bun.which("claude-hub")
    const hub = roles.includes("hub")
    const runner = roles.includes("runner")
    const hubValues = readEnvValues(layout.envFile("hub"))
    const runnerValues = readEnvValues(layout.envFile("runner"))

    const modBuilt = missingModBundle(join(layout.app, "packages", "mod")) === undefined
    const services: Array<{ readonly role: Role; readonly state: ServiceState }> = []
    for (const role of roles) {
      services.push({ role, state: yield* serviceState(serviceTarget(layout, role, on)) })
    }

    let cookieWarning: string | undefined
    if (hub && hubValues.HUB_PUBLIC_URL !== undefined) {
      try {
        const warning = cookieSecurity(
          new URL(hubValues.HUB_PUBLIC_URL),
          /^(?:1|true|yes|on)$/i.test(hubValues.HUB_INSECURE_COOKIES ?? ""),
        ).warning
        cookieWarning = warning._tag === "Some" ? warning.value : undefined
      } catch {
        // An unparseable URL is the Hub configuration check's to report.
      }
    }

    const hubProblem = hub ? yield* hubConfigError(layout) : undefined

    let linger: boolean | undefined
    if (on === "linux" && roles.length > 0 && !shell.dryRun) {
      const result = yield* shell
        .capture(lingerStatusStep(userInfo().username))
        .pipe(Effect.orElseSucceed(() => undefined))
      linger = result === undefined ? undefined : lingers(result.stdout)
    }

    return {
      home: layout.home.dir,
      installed: isInstalled(layout),
      wrapper: {
        path: layout.wrapper,
        exists: wrapperExists,
        current: wrapperExists && isWrapperFor(readFileSync(layout.wrapper, "utf8"), layout),
        onPath: onPath !== null && samePath(onPath, layout.wrapper),
      },
      roles,
      oldData: findOldData(homeDataFacts(layout)),
      prerequisites: prerequisitePlan(yield* hostFacts(layout), roles),
      envFiles: roles.map((role) => ({
        role,
        path: layout.envFile(role),
        mode: statSync(layout.envFile(role)).mode,
      })),
      hubConfigError: hubProblem,
      githubApp: hub && hubProblem === undefined ? yield* appPermissionsFact(layout) : undefined,
      // Without the mod the Runner refuses any configuration: the mod check says so on its own.
      runnerConfigError: runner && modBuilt ? yield* runnerConfigError(layout) : undefined,
      services,
      modBuilt,
      webBuilt: existsSync(
        join(hubValues.HUB_WEB_DIR ?? join(layout.app, "packages", "web", "dist"), "index.html"),
      ),
      cookieWarning,
      hubHealth: hub ? yield* health(hubLocalUrl(layout)) : undefined,
      runnerReachesHub:
        runner && runnerValues.HUB_URL ? yield* health(runnerValues.HUB_URL) : undefined,
      linger,
    } satisfies DoctorFacts
  })

function samePath(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b)
  } catch {
    return a === b
  }
}

export function errorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { readonly message: unknown }).message
    if (typeof message === "string" && message.length > 0) return message
  }
  return String(error)
}

/** `path` through its symlinks, or as it is when it doesn't exist. */
function resolve(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

const has = (bin: string) => Bun.which(bin) !== null
