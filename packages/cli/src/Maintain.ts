// Looking after an install: `doctor [--fix]`, `update` and `uninstall [--purge]`.
import { existsSync, realpathSync } from "node:fs"
import { rm } from "node:fs/promises"
import { HomeVariable } from "@kndl/protocol/home"
import { Console, Effect } from "effect"
import {
  enableLinger,
  installPrerequisites,
  installService,
  leaveRunnerUpdatePush,
  requireInstall,
  requirePlatform,
  restartInstalledServices,
  restrictEnvFile,
  RoleTitle,
  runSteps,
  serviceFileChanged,
  serviceInstalled,
  startService,
  waitForHub,
} from "./Actions.ts"
import { type Check, diagnose, type Fix, formatChecks } from "./Doctor.ts"
import { fail } from "./Failure.ts"
import { entryRemoval, homeRemoval } from "./Guards.ts"
import {
  bunPath,
  configuredRoles,
  doctorFacts,
  homeFacts,
  isOurWrapper,
  moveAside,
  planMoveAside,
  platform,
  readCheckout,
  serviceTarget,
  writeWrapper,
} from "./Host.ts"
import { type Layout, resolveLayout, Roles } from "./Layout.ts"
import { machineEdges, moveFromFormerName, thisMachine } from "./Rename.ts"
import { afterUninstallSteps, type Platform, serviceFilePath, uninstallSteps } from "./Services.ts"
import { Shell, step } from "./Shell.ts"
import { Ui } from "./Ui.ts"
import {
  buildSteps,
  describeCheckout,
  gitSteps,
  localRunnerRestart,
  parseLsRemote,
  pinnedNotice,
  RefNotFound,
  runnersNotice,
  updateTarget,
} from "./Update.ts"

/** Prints doctor's checks. Returns whether none failed. */
const report = (checks: ReadonlyArray<Check>) =>
  Effect.gen(function* () {
    for (const line of formatChecks(checks)) yield* Console.log(line)
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
      if (fixes.length > 0) yield* Console.log("\n`kndl doctor --fix` can repair some of this.")
      return passed
    }
    if (fixes.length === 0) return passed
    yield* Console.log("\nFixing:")
    const ui = yield* Ui
    for (const fix of fixes) {
      yield* applyFix(layout, on, fix, { yes: options.yes, facts }).pipe(
        Effect.catchTag("CliFailure", (error) => ui.log("error", error.message)),
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
    readonly facts: Effect.Success<ReturnType<typeof doctorFacts>>
  },
) =>
  Effect.gen(function* () {
    const ui = yield* Ui
    switch (fix._tag) {
      case "InstallPrerequisites":
        yield* installPrerequisites(context.facts.prerequisites, {
          approved: context.yes ? true : undefined,
        })
        return
      case "WriteWrapper":
        yield* writeWrapper(layout)
        yield* ui.log("step", `wrote ${layout.wrapper}`)
        return
      case "RestrictEnvFile":
        yield* restrictEnvFile(fix.path)
        yield* ui.log("step", `made ${fix.path} readable only by you`)
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
      case "InstallService":
        yield* installService(layout, fix.role, on)
        return
      case "StartService":
        yield* startService(layout, fix.role, on)
        return
      case "EnableLinger": {
        const approved =
          context.yes ||
          (ui.interactive &&
            (yield* ui.confirm({
              message:
                "Keep the services running while you're logged out (loginctl enable-linger)?",
              initial: true,
            })))
        if (approved) yield* enableLinger
        return
      }
      case "MoveOldData": {
        // Never on --yes alone: the person running doctor confirms this one themselves.
        const renames = planMoveAside(layout, fix.entries)
        const listed = renames.map((rename) => `${rename.from} → ${rename.to}`).join(", ")
        if (!ui.interactive) {
          yield* ui.log(
            "warn",
            `The old data stays where it is: doctor moves it only when you confirm, in a terminal. Or run \`kndl onboard --move-old-data\`.`,
          )
          return
        }
        const approved = yield* ui.confirm({
          message: `Move the old data aside in ${layout.home.dir}: ${listed}? Nothing is deleted.`,
          initial: false,
        })
        if (!approved) {
          yield* ui.log("warn", "The old data stays where it is.")
          return
        }
        yield* moveAside(layout, renames)
        yield* ui.log("step", `moved aside: ${listed}`)
        return
      }
    }
  })

/** What `update` is asked to do. */
export interface UpdateOptions {
  /** `--ref`/`--branch`: where to move the install. */
  readonly ref: string | undefined
  /** On the Hub's machine, ask the Runners on other machines to follow (not `--no-update-runners`). */
  readonly updateRunners: boolean
  /** `--now`: Runners stop their running Turns at once, rather than letting them end. */
  readonly now: boolean
}

/**
 * Moves the install to `ref`, or along the branch it follows; then installs, builds, restarts the
 * installed services and runs doctor. On the Hub's machine, it leaves the Hub the commit for its
 * Runners to follow (issue #87); the Runner here, when it updates itself, is drained by the Hub
 * and restarts itself, rather than restarting under its Sessions.
 *
 * An install made under kndl's former name is moved to kndl's names first (Rename.ts), and then
 * updated where it moved to.
 */
export const update = (installed: Layout, options: UpdateOptions) =>
  Effect.gen(function* () {
    const ref = options.ref
    const setting = thisMachine()
    let layout = installed
    if (setting !== undefined) {
      const moved = yield* moveFromFormerName(setting, machineEdges(setting))
      if (moved.plan._tag === "Move" || moved.plan._tag === "InPlace") {
        // A dry run moved nothing, so has nothing to update.
        if (moved.home === undefined) return true
        layout = resolveLayout({ [HomeVariable]: moved.home }, setting.userHome)
        yield* Console.log("")
      }
    }
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
    const roles = configuredRoles(layout)
    const hubRestarts = roles.includes("hub") && (yield* serviceInstalled(layout, "hub", on))
    const pushed = hubRestarts
      ? yield* leaveRunnerUpdatePush(layout, {
          commit: after.commit,
          now: options.now,
          allRunners: options.updateRunners,
        })
      : undefined
    const local = roles.includes("runner")
      ? localRunnerRestart({
          installed: yield* serviceInstalled(layout, "runner", on),
          hubRestarts: pushed !== undefined,
          serviceFileChanged: yield* serviceFileChanged(layout, "runner", on),
          updatesItself: pushed?.localRunner?.updatesItself === true,
        })
      : "None"
    if (pushed !== undefined) {
      for (const line of runnersNotice({
        commit: after.commit,
        updateRunners: options.updateRunners,
        now: options.now,
        local,
        localName: pushed.localRunner?.name,
      })) {
        yield* Console.log(line)
      }
    }
    yield* restartInstalledServices(layout, on, local === "Hub" ? "runner" : undefined)
    // The Hub runs its migrations as it starts: give it the time before checking on it.
    if (configuredRoles(layout).includes("hub")) yield* waitForHub(layout)
    yield* Console.log("")
    return yield* doctor(layout, { fix: false, yes: false })
  })

/**
 * Stops and removes the services and the `kndl` command, and the installed checkout; the
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
      ...(wrapper ? [`the kndl command (${layout.wrapper})`] : []),
      options.purge
        ? `the whole home, ${removal.path}, with its data`
        : `the installed checkout, ${removal.path}`,
    ]
    yield* Console.log(`This removes:\n${plan.map((line) => `  - ${line}`).join("\n")}`)
    if (options.purge) {
      yield* Console.log(
        "Including the Hub's database (hub.db) and its HUB_SECRETS_KEY, and the Runner's Session workspaces: this can't be undone. Archive or finish your Sessions first: Sessions still running keep their Sandboxes.",
      )
    } else {
      yield* Console.log(
        `It keeps ${layout.home.dir}'s data: hub.env, runner.env, hub.db, sessions/, logs/.`,
      )
    }
    const ui = yield* Ui
    const approved =
      options.yes ||
      (ui.interactive &&
        (yield* ui.confirm({
          message: options.purge ? "Purge everything?" : "Uninstall?",
          initial: false,
        })))
    if (!approved) {
      return yield* fail(
        ui.interactive
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
