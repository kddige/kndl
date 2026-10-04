// Looking after an install: `doctor [--fix]`, `update` and `uninstall [--purge]`.
import { existsSync, realpathSync } from "node:fs"
import { rm } from "node:fs/promises"
import { Console, Effect } from "effect"
import { Prompt } from "effect/cli"
import {
  enableLinger,
  installPrerequisites,
  installService,
  requireInstall,
  requirePlatform,
  restartInstalledServices,
  restrictEnvFile,
  RoleTitle,
  runSteps,
  startService,
  trustSessionsRoot,
  waitForHub,
} from "./Actions.ts"
import { type Check, diagnose, type Fix, statusMark } from "./Doctor.ts"
import { fail } from "./Failure.ts"
import { entryRemoval, homeRemoval } from "./Guards.ts"
import {
  bunPath,
  canAsk,
  configuredRoles,
  doctorFacts,
  homeFacts,
  isOurWrapper,
  platform,
  readCheckout,
  serviceTarget,
  writeWrapper,
} from "./Host.ts"
import { type Layout, Roles } from "./Layout.ts"
import { afterUninstallSteps, type Platform, serviceFilePath, uninstallSteps } from "./Services.ts"
import { Shell, step } from "./Shell.ts"
import {
  buildSteps,
  describeCheckout,
  gitSteps,
  parseLsRemote,
  pinnedNotice,
  RefNotFound,
  updateTarget,
} from "./Update.ts"

/** Prints doctor's checks. Returns whether none failed. */
const report = (checks: ReadonlyArray<Check>) =>
  Effect.gen(function* () {
    const width = Math.max(...checks.map((check) => check.name.length))
    for (const check of checks) {
      yield* Console.log(
        `${statusMark[check.status]}  ${check.name.padEnd(width)}  ${check.detail}`,
      )
    }
    return checks.every((check) => check.status !== "fail")
  })

/** Runs doctor; with `fix`, repairs what it can and checks again. Returns whether all passed. */
export const doctor = (layout: Layout, options: { readonly fix: boolean; readonly yes: boolean }) =>
  Effect.gen(function* () {
    const on = yield* requirePlatform(platform())
    const facts = yield* doctorFacts(layout, on)
    const checks = diagnose(facts)
    const passed = yield* report(checks)
    const fixes = checks.flatMap((check) => (check.fix === undefined ? [] : [check.fix]))
    if (!options.fix) {
      if (fixes.length > 0)
        yield* Console.log("\n`claude-hub doctor --fix` can repair some of this.")
      return passed
    }
    if (fixes.length === 0) return passed
    yield* Console.log("\nFixing:")
    const interactive = canAsk(options.yes)
    for (const fix of fixes) {
      yield* applyFix(layout, on, fix, { yes: options.yes, interactive, facts }).pipe(
        Effect.catchTag("CliFailure", (error) => Console.log(`! ${error.message}`)),
      )
    }
    yield* Console.log("\nAfter fixing:")
    return yield* report(diagnose(yield* doctorFacts(layout, on)))
  })

const applyFix = (
  layout: Layout,
  on: Platform,
  fix: Fix,
  context: {
    readonly yes: boolean
    readonly interactive: boolean
    readonly facts: Effect.Success<ReturnType<typeof doctorFacts>>
  },
) =>
  Effect.gen(function* () {
    switch (fix._tag) {
      case "InstallPrerequisites":
        yield* installPrerequisites(context.facts.prerequisites, {
          approved: context.yes ? true : undefined,
          interactive: context.interactive,
        })
        return
      case "WriteWrapper":
        yield* writeWrapper(layout)
        yield* Console.log(`- wrote ${layout.wrapper}`)
        return
      case "RestrictEnvFile":
        yield* restrictEnvFile(fix.path)
        yield* Console.log(`- made ${fix.path} readable only by you`)
        return
      case "BuildMod":
        yield* runSteps([
          step(bunPath(), ["run", "mod:build"], { cwd: layout.app, why: "build the hub-link mod" }),
        ])
        return
      case "BuildWeb":
        yield* runSteps([
          step(bunPath(), ["run", "web:build"], { cwd: layout.app, why: "build the web UI" }),
        ])
        return
      case "TrustSessionsRoot":
        yield* trustSessionsRoot(layout)
        yield* Console.log("- trusted the sessions root in Claude Code's config file")
        return
      case "InstallService":
        yield* installService(layout, fix.role, on)
        return
      case "StartService":
        yield* startService(layout, fix.role, on)
        return
      case "EnableLinger": {
        const approved =
          context.yes ||
          (context.interactive &&
            (yield* Prompt.Confirm({
              message:
                "Keep the services running while you're logged out (loginctl enable-linger)?",
              initial: true,
            })))
        if (approved) yield* enableLinger
        return
      }
    }
  })

/**
 * Moves the install to `ref`, or along the branch it follows; then installs, builds, restarts the
 * installed services and runs doctor.
 */
export const update = (layout: Layout, ref: string | undefined) =>
  Effect.gen(function* () {
    yield* requireInstall(layout)
    const on = yield* requirePlatform(platform())
    const shell = yield* Shell
    const before = yield* readCheckout(layout.app)
    const remote =
      ref === undefined
        ? { branches: [], tags: [] }
        : parseLsRemote(
            (yield* shell
              .capture(
                step("git", ["ls-remote", "--heads", "--tags", "origin"], { cwd: layout.app }),
              )
              .pipe(
                Effect.mapError((error) =>
                  fail(`Could not ask origin for its refs: ${error.message}`),
                ),
              )).stdout,
          )
    const target = updateTarget(before, ref, remote)
    if (target instanceof RefNotFound) return yield* fail(target.message)
    if (target._tag === "Pinned") {
      yield* Console.log(pinnedNotice(target))
      return true
    }
    yield* Console.log(`Updating ${layout.app} (${describeCheckout(before)}):`)
    yield* runSteps(gitSteps(layout.app, target))
    yield* runSteps(buildSteps(layout.app, bunPath(), configuredRoles(layout)))
    const after = yield* readCheckout(layout.app)
    yield* Console.log(`Now at ${describeCheckout(after)}.`)
    yield* restartInstalledServices(layout, on)
    // The Hub runs its migrations as it starts: give it the time before checking on it.
    if (configuredRoles(layout).includes("hub")) yield* waitForHub(layout)
    yield* Console.log("")
    return yield* doctor(layout, { fix: false, yes: false })
  })

/**
 * Stops and removes the services and the `claude-hub` command, and the installed checkout; the
 * home's data stays, unless `purge`, which removes the whole home. The guards decide what may be
 * deleted before anything is.
 */
export const uninstall = (
  layout: Layout,
  options: { readonly purge: boolean; readonly yes: boolean },
) =>
  Effect.gen(function* () {
    const on = platform()
    const facts = homeFacts(layout)
    let requested = layout.home.dir
    try {
      requested = realpathSync(layout.home.dir)
    } catch {
      // A home that doesn't exist is refused by the guards.
    }
    const removal = options.purge ? homeRemoval(requested, facts) : entryRemoval("app", facts)
    if (removal._tag === "Refused") return yield* fail(removal.reason)

    const services =
      on === undefined
        ? []
        : Roles.map((role) => ({
            role,
            path: serviceFilePath(serviceTarget(layout, role, on)),
          })).filter((service) => existsSync(service.path))
    const wrapper = isOurWrapper(layout.wrapper)
    const plan = [
      ...services.map((service) => `the ${RoleTitle[service.role]} service (${service.path})`),
      ...(wrapper ? [`the claude-hub command (${layout.wrapper})`] : []),
      options.purge
        ? `the whole home, ${removal.path}, with its data`
        : `the installed checkout, ${removal.path}`,
    ]
    yield* Console.log(`This removes:\n${plan.map((line) => `  - ${line}`).join("\n")}`)
    if (options.purge) {
      yield* Console.log(
        "Including the Hub's database (hub.db) and its HUB_SECRETS_KEY, and the Runner's Session workspaces: this can't be undone. Archive or finish your Sessions first: Sessions still running keep their tmux sessions and Sandboxes.",
      )
    } else {
      yield* Console.log(
        `It keeps ${layout.home.dir}'s data: hub.env, runner.env, hub.db, sessions/, logs/.`,
      )
    }
    const approved =
      options.yes ||
      (canAsk(false) &&
        (yield* Prompt.Confirm({
          message: options.purge ? "Purge everything?" : "Uninstall?",
          initial: false,
        })))
    if (!approved) {
      return yield* fail(
        canAsk(false)
          ? "Nothing was removed."
          : "Nothing was removed: pass --yes to uninstall without a terminal.",
      )
    }

    if (on !== undefined) {
      for (const service of services) {
        const target = serviceTarget(layout, service.role, on)
        yield* runSteps(uninstallSteps(target))
        yield* Effect.promise(() => rm(service.path, { force: true }))
        yield* runSteps(afterUninstallSteps(target))
        yield* Console.log(`- removed the ${RoleTitle[service.role]} service`)
      }
    }
    if (wrapper) {
      yield* Effect.promise(() => rm(layout.wrapper, { force: true }))
      yield* Console.log(`- removed ${layout.wrapper}`)
    }
    yield* Effect.promise(() => rm(removal.path, { recursive: true, force: true }))
    yield* Console.log(`- removed ${removal.path}`)
    return true
  })
