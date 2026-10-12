// What the commands do to the machine, shared by onboard, `doctor --fix`, update and the service
// commands: run a plan's Steps, build, install and start the services, issue a token. Each is thin:
// the decisions are made in the pure modules, and the Steps run through Shell.
import { existsSync } from "node:fs"
import { chmod, mkdir, readFile } from "node:fs/promises"
import { homedir, userInfo } from "node:os"
import { delimiter, dirname, join } from "node:path"
import { issueRunnerToken, issueSetupLink } from "@kndl/hub/src/Admin.ts"
import { requestRunnerUpdates } from "@kndl/hub/src/RunnerUpdatePush.ts"
import {
  resetSecrets,
  type SecretsResetPlan,
  secretsResetDoneText,
  secretsResetPlanText,
} from "@kndl/hub/src/SecretsReset.ts"
import { FormerName, formerHomeDir } from "@kndl/protocol/former-name"
import { Cause, ConfigProvider, Console, Effect, Option } from "effect"
import { fail } from "./Failure.ts"
import {
  bunPath,
  configuredRoles,
  errorMessage,
  health,
  homeEnvironment,
  hubLocalUrl,
  isInstalled,
  readEnvValues,
  serviceState,
  serviceTarget,
  writeFileWhole,
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
import { describeStep, Shell, type Step, step } from "./Shell.ts"
import { Ui } from "./Ui.ts"
import { buildSteps } from "./Update.ts"

export const RoleTitle: Record<Role, string> = { hub: "Hub", runner: "Runner" }

/** The install line, for the commands that need an install and find none. */
export const InstallLine =
  "curl -fsSL https://raw.githubusercontent.com/kddige/kndl/main/install.sh | sh"

/**
 * Fails unless the home holds an installed checkout. An install made under kndl's former name,
 * which `update` moves to kndl's names, is pointed out.
 */
export const requireInstall = (layout: Layout) => {
  if (isInstalled(layout)) return Effect.void
  const former = formerHomeDir(process.env, homedir())
  if (existsSync(join(former, "app", ".git"))) {
    return Effect.fail(
      fail(
        `The install in ${former} is still under kndl's former name, ${FormerName.name}. Move it to kndl's names with \`${FormerName.command} update\`, then use \`kndl\`.`,
      ),
    )
  }
  return Effect.fail(
    fail(
      `No kndl install in ${layout.home.dir} (no ${layout.app}). Install it with:\n\n  ${InstallLine}\n\nor set KNDL_HOME to the home you installed.`,
    ),
  )
}

/** Fails on a platform kndl doesn't run services on. */
export const requirePlatform = (on: Platform | undefined) =>
  on === undefined
    ? Effect.fail(fail(`kndl runs on macOS and Linux, not ${process.platform}.`))
    : Effect.succeed(on)

/**
 * Runs Steps in order. On a terminal they run under spinners, their output captured and shown only
 * when one fails: all under one spinner named `label`, or else each under its own, named by what
 * it is for. Without a terminal they run attached to the output, each line saying what it is for.
 */
export const runSteps = (steps: ReadonlyArray<Step>, label?: string) =>
  Effect.gen(function* () {
    const shell = yield* Shell
    const ui = yield* Ui
    if (!ui.spins) {
      for (const s of steps) {
        if (s.why !== undefined && !(shell.dryRun && s.system)) yield* ui.log("step", s.why)
        yield* shell.attached(s)
      }
      return
    }
    // A spinner has the terminal, so sudo can't ask for a password under one: ask it up front.
    if (steps.some((s) => s.sudo === true) && process.getuid?.() !== 0) {
      yield* ui.log("info", "sudo may ask for your password.")
      yield* shell.attached(step("sudo", ["-v"], { system: true }))
    }
    const run = (s: Step) => shell.capture(s)
    if (label !== undefined) {
      yield* ui.spin(label, (progress) =>
        Effect.forEach(steps, (s) => Effect.andThen(progress(s.why ?? s.command), run(s)), {
          discard: true,
        }),
      )
      return
    }
    for (const s of steps) yield* ui.spin(sentence(s.why ?? describeStep(s)), () => run(s))
  }).pipe(Effect.mapError((error) => fail(error.message)))

/** `install dependencies` as `Install dependencies`. */
const sentence = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1)}`

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
  options: { readonly approved: boolean | undefined },
) =>
  Effect.gen(function* () {
    if (plan.steps.length === 0) return false
    const ui = yield* Ui
    yield* ui.note(
      describePlan(plan),
      `To install what's missing, kndl would run${plan.needsSudo ? " (with sudo)" : ""}:`,
    )
    const approved =
      options.approved ??
      (ui.interactive ? yield* ui.confirm({ message: "Run these now?", initial: true }) : false)
    if (!approved) {
      yield* ui.log("warn", "Skipped: run them yourself, or `kndl doctor --fix`.")
      return false
    }
    yield* runSteps(plan.steps)
    for (const line of plan.afterwards) yield* ui.log("warn", line)
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
        `The ${RoleTitle[role]} isn't set up here (${layout.envFile(role)} is missing): run \`kndl onboard\`.`,
      )
    }
    const target = serviceTarget(layout, role, on)
    const path = serviceFilePath(target)
    const text = serviceFile(on, { role, layout, bun: bunPath(), path: servicePath() })
    yield* Effect.promise(() => mkdir(layout.logs, { recursive: true }))
    yield* writeFileWhole(path, text, 0o644)
    yield* (yield* Ui).log("step", `${RoleTitle[role]} service: ${path}`)
    yield* runSteps(installSteps(target), `Start the ${RoleTitle[role]}'s service`)
  })

export const startService = (layout: Layout, role: Role, on: Platform) =>
  Effect.gen(function* () {
    const target = serviceTarget(layout, role, on)
    if (!existsSync(serviceFilePath(target))) {
      return yield* fail(
        `The ${RoleTitle[role]} service isn't installed: \`kndl ${role} install\`.`,
      )
    }
    yield* runSteps(startSteps(target), `Start the ${RoleTitle[role]}'s service`)
  })

export const stopService = (layout: Layout, role: Role, on: Platform) =>
  runSteps(stopSteps(serviceTarget(layout, role, on)), `Stop the ${RoleTitle[role]}'s service`)

/**
 * Rewrites and reloads the installed services, as after an update; but not `except`'s, which
 * restarts some other way (the Runner on the Hub's machine, which the Hub drains).
 */
export const restartInstalledServices = (layout: Layout, on: Platform, except?: Role) =>
  Effect.gen(function* () {
    for (const role of configuredRoles(layout)) {
      if (role === except) continue
      if (!(yield* serviceInstalled(layout, role, on))) continue
      yield* installService(layout, role, on)
    }
  })

/** Whether a role's service is installed here. */
export const serviceInstalled = (layout: Layout, role: Role, on: Platform) =>
  Effect.map(
    serviceState(serviceTarget(layout, role, on)),
    (state) => state._tag !== "NotInstalled",
  )

/** Whether the installed service file of a role differs from the one the CLI writes now. */
export const serviceFileChanged = (layout: Layout, role: Role, on: Platform) =>
  Effect.promise(async () => {
    const path = serviceFilePath(serviceTarget(layout, role, on))
    const text = serviceFile(on, { role, layout, bun: bunPath(), path: servicePath() })
    try {
      return (await readFile(path, "utf8")) !== text
    } catch {
      return true
    }
  })

/**
 * Leaves this home's Hub the commit `update` moved it to, for its Runners to follow once it runs
 * it (issue #87). Says, of the Runner on this machine, whether the Hub knows it and whether it
 * updates itself. `undefined` when no Hub is set up here, or the database couldn't be written,
 * which it warns of: the update goes on, and the Runners page updates Runners by hand.
 *
 * It opens the database as issuing a token does, migrating it, while the old Hub still runs on
 * it: migrations only add, and the Hub restarts right after.
 */
export const leaveRunnerUpdatePush = (
  layout: Layout,
  options: { readonly commit: string; readonly now: boolean; readonly allRunners: boolean },
) =>
  Effect.gen(function* () {
    const env = homeEnvironment(layout, "hub")
    if (!existsSync(layout.envFile("hub")) && env.HUB_DATABASE === undefined) return undefined
    const localToken = configuredRoles(layout).includes("runner")
      ? readEnvValues(layout.envFile("runner")).RUNNER_TOKEN
      : undefined
    return yield* requestRunnerUpdates({ ...options, localToken }).pipe(
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
      Effect.catchCause((cause) =>
        Effect.flatMap(Ui, (ui) =>
          Effect.as(
            ui.log(
              "warn",
              `Couldn't ask the Hub to update its Runners: ${errorMessage(Cause.squash(cause))}. Update them from the Runners page.`,
            ),
            undefined,
          ),
        ),
      ),
    )
  })

/** Lets the user's services run while they're logged out (Linux), or says how. */
export const enableLinger = Effect.gen(function* () {
  const user = userInfo().username
  const shell = yield* Shell
  const ran = yield* shell.attached({ ...enableLingerStep(user), mayFail: true })
  if (ran !== 0) {
    yield* (yield* Ui).log(
      "warn",
      `Couldn't turn on lingering: run \`sudo loginctl enable-linger ${user}\`.`,
    )
  }
}).pipe(Effect.mapError((error) => fail(error.message)))

/** Restricts an env file to this user: it holds secrets. */
export const restrictEnvFile = (path: string) => Effect.promise(() => chmod(path, 0o600))

/**
 * Issues a Runner's token in this home's Hub database, the one the Hub's service opens. Refuses
 * when no Hub is set up here.
 */
export const issueToken = (layout: Layout, name: string) =>
  Effect.gen(function* () {
    const env = homeEnvironment(layout, "hub")
    if (!existsSync(layout.envFile("hub")) && env.HUB_DATABASE === undefined) {
      return yield* fail(
        `No Hub is set up in ${layout.home.dir}: issue the token on the Hub's machine, or run \`kndl onboard\` here first.`,
      )
    }
    return yield* issueRunnerToken(name).pipe(
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
      Effect.mapError((error) => fail(`Could not issue a token for ${name}: ${String(error)}`)),
    )
  })

/**
 * A new Setup link for this home's Hub (Admin.ts, which `bun run setup-link` shares), replacing
 * any earlier one: whoever signs in with it first becomes the Hub's Owner. None once the Hub has
 * an Owner. Refuses when no Hub is set up here.
 */
export const newSetupLink = (layout: Layout) =>
  Effect.gen(function* () {
    const env = homeEnvironment(layout, "hub")
    if (!existsSync(layout.envFile("hub")) && env.HUB_DATABASE === undefined) {
      return yield* fail(
        `No Hub is set up in ${layout.home.dir}: make the Setup link on the Hub's machine, or run \`kndl onboard\` here first.`,
      )
    }
    return yield* issueSetupLink.pipe(
      Effect.map(Option.some),
      Effect.catchTag("SetupLinkRefused", () => Effect.succeed(Option.none<string>())),
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
      Effect.mapError((error) => fail(`Could not make a Setup link: ${String(error)}`)),
    )
  })

/**
 * Clears the Sensitive values in this home's Hub database after its HUB_SECRETS_KEY is lost
 * (SecretsReset.ts, which `bun run secrets-reset` shares). Says what it clears and asks first,
 * unless `yes`; without a terminal it needs `yes`. Refused while the Hub runs on the database.
 */
export const resetHubSecrets = (layout: Layout, options: { readonly yes: boolean }) =>
  Effect.gen(function* () {
    const env = homeEnvironment(layout, "hub")
    if (!existsSync(layout.envFile("hub")) && env.HUB_DATABASE === undefined) {
      return yield* fail(
        `No Hub is set up in ${layout.home.dir}: reset its secrets on the Hub's machine.`,
      )
    }
    const ui = yield* Ui
    const confirm = (plan: SecretsResetPlan) =>
      Effect.gen(function* () {
        yield* Console.log(secretsResetPlanText(plan))
        return (
          options.yes ||
          (ui.interactive &&
            (yield* ui.confirm({ message: "Clear these values?", initial: false })))
        )
      })
    const outcome = yield* resetSecrets(confirm).pipe(
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
      Effect.mapError((error) => {
        switch (error._tag) {
          case "Cancelled":
            return error
          case "HubLockRefused":
            return fail(`${error.message} The Hub's service stops with \`kndl hub stop\`.`)
          case "NoHubDatabase":
            return fail(error.message)
          default:
            return fail(`Could not reset the Sensitive values: ${String(error)}`)
        }
      }),
    )
    if (outcome._tag === "NothingToReset") {
      yield* Console.log(
        "Nothing to reset: the Hub stores no Sensitive values, so a new key works as it is. Make one with `kndl secrets key`.",
      )
    } else if (outcome._tag === "Kept") {
      return yield* fail(
        ui.interactive
          ? "Nothing was cleared."
          : "Nothing was cleared: pass --yes to reset without a terminal.",
      )
    } else {
      yield* Console.log(secretsResetDoneText(outcome.plan, "`kndl secrets key`"))
    }
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
