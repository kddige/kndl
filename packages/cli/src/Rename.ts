// The one-time move of an install made under kndl's former name, claude-hub, to kndl's names
// (ADR 0017): its home, `~/.claude-hub` to `~/.kndl`; the `CLAUDE_HUB_*` variables in its env
// files; its services, under their new labels and units; and its command, `~/.local/bin/kndl`.
//
// Two things run it. The first update to kndl runs the former name's own CLI, which restarts the
// former services on the new code; a Hub or Runner a former service starts doesn't start, but runs
// this (renameMain.ts), and is stopped by it once the services are registered under the new names.
// And `update` runs it first, for an install whose services didn't move it. It is idempotent:
// a move cut short is finished by the next one. A lock keeps two from running at once, as a Hub's
// and a Runner's on one machine would.
//
// Running Sessions are put to sleep, as a Runner restart puts those it doesn't take back: their
// Sandboxes are stopped under the former names (the Runner's stopFormerSandboxes.ts), their
// Workspaces move with the home, and the Hub marks them Asleep when the Runner says hello without
// them. They wake under the new names. Nothing is destroyed: the former Sandboxes, their volumes
// and their Environments' snapshots stay in microsandbox until someone removes them.
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { mkdir, rename, rm, rmdir } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { holdHubLock } from "@kndl/hub/src/HubLock.ts"
import { FormerName, formerHomeDir } from "@kndl/protocol/former-name"
import { HomeVariable } from "@kndl/protocol/home"
import { runnerMark } from "@kndl/runner/src/sandbox/Naming.ts"
import { Cause, Effect, Schedule } from "effect"
import { installService, RoleTitle, runSteps } from "./Actions.ts"
import { type EnvLine, parseEnv, renderEnv } from "./EnvFile.ts"
import { type CliFailure, fail } from "./Failure.ts"
import { bunPath, errorMessage, platform, writeFileWhole, writeWrapper } from "./Host.ts"
import { HomeEntries, type Layout, resolveLayout, type Role, Roles } from "./Layout.ts"
import type { Platform } from "./Services.ts"
import { Shell, type Step, step } from "./Shell.ts"
import { Ui } from "./Ui.ts"

/** Where the move looks, on this machine. */
export interface MoveSetting {
  readonly userHome: string
  /** The environment: the former home's variable, and kndl's. */
  readonly env: Record<string, string | undefined>
  readonly platform: Platform
  /** The user's id, for launchd's `gui/<uid>` domain. */
  readonly uid: number
  /** Where systemd user units go: `$XDG_CONFIG_HOME`, else `~/.config`. */
  readonly configHome: string
}

/** What the move would do. */
export type MovePlan =
  /** No install made under the former name, and nothing of one left. */
  | { readonly _tag: "Nothing" }
  /** The home moves from `from` to `to`, and everything else is renamed. */
  | { readonly _tag: "Move"; readonly from: string; readonly to: string }
  /**
   * The home stays where it is, `home`, and only the rest is renamed: a home the former variable
   * named somewhere of its own, or one moved already by a move cut short.
   */
  | { readonly _tag: "InPlace"; readonly home: string }
  /** Both homes hold an install: the move leaves both alone. */
  | { readonly _tag: "Conflict"; readonly from: string; readonly to: string }

/** What {@link planMove} decides from. */
export interface HomeSighting {
  /** The former home: the one the former variable names, or `~/.claude-hub`. */
  readonly from: string
  /** Where the home is to be: `KNDL_HOME`, else `~/.kndl` for the default former home, else `from`. */
  readonly to: string
  /** Whether `from` holds a home: any of a home's entries. */
  readonly fromIsHome: boolean
  /** Whether `to` exists and isn't empty. */
  readonly toUsed: boolean
  /** Whether anything else is left under the former name: a service, the command, a variable. */
  readonly leftovers: boolean
}

export function planMove(sighting: HomeSighting): MovePlan {
  const { from, to } = sighting
  if (sighting.fromIsHome && from !== to) {
    return sighting.toUsed ? { _tag: "Conflict", from, to } : { _tag: "Move", from, to }
  }
  return sighting.leftovers ? { _tag: "InPlace", home: to } : { _tag: "Nothing" }
}

/** Where a role's service file of the former name is. */
export function formerServiceFile(setting: MoveSetting, role: Role): string {
  return setting.platform === "darwin"
    ? join(setting.userHome, "Library", "LaunchAgents", `${FormerName.launchdLabel(role)}.plist`)
    : join(setting.configHome, "systemd", "user", FormerName.systemdUnit(role))
}

/** The former name's command: `~/.local/bin/claude-hub`. */
export const formerCommand = (setting: Pick<MoveSetting, "userHome">) =>
  join(setting.userHome, ".local", "bin", FormerName.command)

/** Whether the file at `path` is the wrapper the former name's install.sh wrote. */
export function isFormerWrapper(path: string): boolean {
  try {
    return readFileSync(path, "utf8").split("\n")[1]?.startsWith(FormerName.wrapperMark) === true
  } catch {
    return false
  }
}

/** Whether an env file's text sets any variable of the former name's own. */
const hasFormerVariable = (text: string) =>
  parseEnv(text).some(
    (line) => line._tag === "Variable" && line.key.startsWith(FormerName.variablePrefix),
  )

const readText = (path: string) => {
  try {
    return readFileSync(path, "utf8")
  } catch {
    return undefined
  }
}

/** A directory's entries; none for one that doesn't exist. */
const entries = (dir: string): ReadonlyArray<string> => {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

/** What the move finds on this machine. */
export function sightHome(setting: MoveSetting): HomeSighting {
  const from = formerHomeDir(setting.env, setting.userHome)
  const named = setting.env[HomeVariable]
  const to = named
    ? resolve(named)
    : from === join(resolve(setting.userHome), FormerName.home)
      ? resolve(setting.userHome, ".kndl")
      : from
  const leftovers =
    Roles.some((role) => existsSync(formerServiceFile(setting, role))) ||
    isFormerWrapper(formerCommand(setting)) ||
    Roles.some((role) => hasFormerVariable(readText(join(to, `${role}.env`)) ?? ""))
  return {
    from,
    to,
    fromIsHome: entries(from).some((entry) =>
      (HomeEntries as ReadonlyArray<string>).includes(entry),
    ),
    toUsed: entries(to).length > 0,
    leftovers,
  }
}

/**
 * An env file's text with the former name's variables renamed to kndl's (`CLAUDE_HUB_X` to
 * `KNDL_X`), and values naming the former home, or a path in it, naming the new one. Every other
 * line stays as it was, byte for byte.
 */
export function renameEnvText(text: string, from: string, to: string): string {
  const lines = text.split("\n")
  return lines
    .map((line) => {
      const [parsed] = parseEnv(line)
      if (parsed?._tag !== "Variable") return line
      const key = parsed.key.startsWith(FormerName.variablePrefix)
        ? `KNDL_${parsed.key.slice(FormerName.variablePrefix.length)}`
        : parsed.key
      const value =
        from !== to && (parsed.value === from || parsed.value.startsWith(`${from}/`))
          ? `${to}${parsed.value.slice(from.length)}`
          : parsed.value
      if (key === parsed.key && value === parsed.value) return line
      const renamed: EnvLine = { _tag: "Variable", key, value }
      return renderEnv([renamed]).slice(0, -1)
    })
    .join("\n")
}

/**
 * The mark of the Runner set up in the former home, which its Sandboxes carry: from its tmux
 * socket and sessions root, as the Runner's own config reads them from `runner.env`.
 */
export function formerRunnerMark(runnerEnv: Record<string, string>, home: string): string {
  return runnerMark({
    tmuxSocket: runnerEnv.RUNNER_TMUX_SOCKET || FormerName.tmuxSocket,
    sessionsRoot: resolve(home, runnerEnv.RUNNER_SESSIONS_ROOT || "sessions"),
  })
}

/**
 * The Steps that stop a service of the former name and unregister it; its file is removed after
 * them. A launchd agent is unloaded; a systemd unit is disabled and stopped.
 */
export function formerServiceRemovalSteps(setting: MoveSetting, role: Role): ReadonlyArray<Step> {
  const why = `stop the ${RoleTitle[role]}'s service of the former name`
  return setting.platform === "darwin"
    ? [
        step("launchctl", ["bootout", `gui/${setting.uid}/${FormerName.launchdLabel(role)}`], {
          system: true,
          mayFail: true,
          why,
        }),
      ]
    : [
        step("systemctl", ["--user", "disable", "--now", FormerName.systemdUnit(role)], {
          system: true,
          mayFail: true,
          why,
        }),
      ]
}

/**
 * For the service this move runs under, the Steps that keep it from starting again: a systemd
 * unit is disabled. Its file is removed after them, and then {@link ownServiceStopSteps} run.
 */
export function ownServiceDisableSteps(setting: MoveSetting, role: Role): ReadonlyArray<Step> {
  return setting.platform === "darwin"
    ? []
    : [
        step("systemctl", ["--user", "disable", FormerName.systemdUnit(role)], {
          system: true,
          mayFail: true,
        }),
      ]
}

/**
 * For the service this move runs under, the Steps that stop it, last of all: stopping it stops
 * this process.
 */
export function ownServiceStopSteps(setting: MoveSetting, role: Role): ReadonlyArray<Step> {
  return setting.platform === "darwin"
    ? [
        step("launchctl", ["bootout", `gui/${setting.uid}/${FormerName.launchdLabel(role)}`], {
          system: true,
          mayFail: true,
        }),
      ]
    : [
        step("systemctl", ["--user", "daemon-reload"], { system: true, mayFail: true }),
        step("systemctl", ["--user", "stop", FormerName.systemdUnit(role)], {
          system: true,
          mayFail: true,
        }),
      ]
}

/** What the move does to the machine beyond its files, standing in for the real thing in tests. */
export interface MoveEdges {
  /** Writes a role's service under kndl's names and starts it. */
  readonly installService: (
    layout: Layout,
    role: Role,
  ) => Effect.Effect<void, CliFailure, Shell | Ui>
  /** Writes the `kndl` command for the home. */
  readonly writeWrapper: (layout: Layout) => Effect.Effect<void>
  /** The Bun that runs the Runner's stopFormerSandboxes.ts. */
  readonly bun: string
  /** What keeps two moves apart: a lock on the file `<lock>.lock`, as HubLock.ts takes it. */
  readonly lock: string
}

/** This machine's setting, or `undefined` on a platform kndl doesn't install on. */
export function thisMachine(
  env: Record<string, string | undefined> = process.env,
): MoveSetting | undefined {
  const on = platform()
  if (on === undefined) return undefined
  const userHome = homedir()
  return {
    userHome,
    env,
    platform: on,
    uid: process.getuid?.() ?? 0,
    configHome: env.XDG_CONFIG_HOME || join(userHome, ".config"),
  }
}

/** The move's edges on this machine. */
export const machineEdges = (setting: MoveSetting): MoveEdges => ({
  installService: (layout, role) => installService(layout, role, setting.platform),
  writeWrapper,
  bun: bunPath(),
  lock: join(tmpdir(), `kndl-move-${setting.uid}`),
})

/** What a move did. */
export interface MoveOutcome {
  readonly plan: MovePlan
  /** The home after it: where the install now is. */
  readonly home: string | undefined
  /** What went wrong after the home moved, which `kndl doctor --fix` may repair. */
  readonly problems: ReadonlyArray<string>
}

/** How long a move waits for another to finish: up to 15 minutes. */
const LockWait = { schedule: Schedule.spaced("1 second"), times: 15 * 60 }

/**
 * Moves the install made under the former name to kndl's names, as {@link planMove} plans. Under
 * `service`, it runs in the process that role's former service started, which the last step stops.
 */
export const moveFromFormerName = (
  setting: MoveSetting,
  edges: MoveEdges,
  options: { readonly service?: Role | undefined } = {},
) =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* holdHubLock(edges.lock, "Can't move the install").pipe(
        Effect.retry(LockWait),
        Effect.mapError(() =>
          fail(`Another move of this install from ${FormerName.name} didn't finish in time.`),
        ),
      )
      const ui = yield* Ui
      const shell = yield* Shell
      const plan = planMove(sightHome(setting))
      if (plan._tag === "Nothing") return { plan, home: undefined, problems: [] } as MoveOutcome
      if (plan._tag === "Conflict") {
        yield* ui.log(
          "error",
          `${FormerName.name} is now kndl, but its install in ${plan.from} can't move to ${plan.to}, which is in use. Move one of them away, or set ${HomeVariable} to the one to keep, and run \`kndl update\`.`,
        )
        return { plan, home: undefined, problems: [] } as MoveOutcome
      }
      const from = plan._tag === "Move" ? plan.from : plan.home
      const home = plan._tag === "Move" ? plan.to : plan.home
      yield* ui.log(
        "info",
        plan._tag === "Move"
          ? `${FormerName.name} is now kndl: moving this install from ${from} to ${home}.`
          : `${FormerName.name} is now kndl: renaming this install in ${home}.`,
      )
      if (shell.dryRun) {
        yield* ui.log("info", "[dry run] would move the install; nothing was changed.")
        return { plan, home: undefined, problems: [] } as MoveOutcome
      }

      // The services of the former name: stopped first, so neither starts again under it. The
      // one this runs under is stopped last, as that stops this.
      const services = Roles.filter((role) => existsSync(formerServiceFile(setting, role)))
      for (const role of services) {
        if (role === options.service) continue
        yield* runSteps(formerServiceRemovalSteps(setting, role))
        yield* Effect.promise(() => rm(formerServiceFile(setting, role), { force: true }))
      }
      if (setting.platform === "linux" && services.some((role) => role !== options.service)) {
        yield* runSteps([
          step("systemctl", ["--user", "daemon-reload"], { system: true, mayFail: true }),
        ])
      }

      // The Runner's Sessions go to sleep: its Sandboxes stop under the former names, before
      // their Workspaces move. Its tmux server on the host, from before Sessions ran in
      // Sandboxes, goes too, unless runner.env names one, which the Runner retires itself.
      const runnerEnvText = readText(join(from, "runner.env"))
      const left: Array<string> = []
      if (runnerEnvText !== undefined) {
        const runnerEnv = Object.fromEntries(
          parseEnv(runnerEnvText).flatMap((line) =>
            line._tag === "Variable" ? [[line.key, line.value] as const] : [],
          ),
        )
        if (!runnerEnv.RUNNER_TMUX_SOCKET) {
          yield* shell
            .capture(
              step("tmux", ["-L", FormerName.tmuxSocket, "kill-server"], {
                system: true,
                mayFail: true,
              }),
            )
            .pipe(Effect.ignore)
        }
        const stopped = yield* shell
          .capture(
            step(
              edges.bun,
              [
                `--env-file=${join(from, "runner.env")}`,
                join(from, "app", "packages", "runner", "src", "stopFormerSandboxes.ts"),
                formerRunnerMark(runnerEnv, from),
              ],
              { system: true, mayFail: true, cwd: from },
            ),
          )
          .pipe(
            Effect.catchTag("StepFailed", (error) =>
              Effect.succeed({ exitCode: 1, stdout: "", stderr: error.message }),
            ),
          )
        if (stopped.exitCode === 0) {
          left.push(...stopped.stdout.split("\n").filter((line) => line.trim() !== ""))
        } else {
          yield* ui.log(
            "warn",
            `Couldn't stop the Runner's Sandboxes of the former name (${stopped.stderr.trim() || `exit ${stopped.exitCode}`}): any still running keep running. List them with \`bun x msb list\` in ${join(home, "app", "packages", "runner")}, and stop those named ${FormerName.sandboxPrefix}… with \`bun x msb stop\`.`,
          )
        }
      }

      if (plan._tag === "Move") {
        yield* Effect.tryPromise({
          try: async () => {
            // An empty directory where the home goes is taken over.
            if (existsSync(home)) await rmdir(home)
            await mkdir(dirname(home), { recursive: true })
            await rename(from, home)
          },
          catch: (error) =>
            fail(`Couldn't move ${from} to ${home}: ${errorMessage(error)}. Nothing was moved.`),
        })
        yield* ui.log("step", `moved ${from} to ${home}`)
      }

      // From here the home has moved: a step that fails is reported, and the rest still run, so
      // the services of the former name are gone at the end, rather than restarting into nothing.
      const layout = resolveLayout({ [HomeVariable]: home }, setting.userHome)
      const problems: Array<string> = []
      const attempt = <E>(what: string, effect: Effect.Effect<void, E, Shell | Ui>) =>
        effect.pipe(
          Effect.catchCause((cause) =>
            Effect.suspend(() => {
              const problem = `${what}: ${errorMessage(Cause.squash(cause))}`
              problems.push(problem)
              return ui.log("error", problem)
            }),
          ),
        )

      for (const role of Roles) {
        const path = layout.envFile(role)
        const text = readText(path)
        if (text === undefined) continue
        const renamed = renameEnvText(text, from, home)
        if (renamed === text) continue
        yield* attempt(`Couldn't rewrite ${path}`, writeFileWhole(path, renamed, 0o600))
        yield* ui.log("step", `renamed the variables in ${path}`)
      }

      const command = formerCommand(setting)
      if (isFormerWrapper(command)) {
        yield* attempt(
          `Couldn't replace ${command} with ${layout.wrapper}`,
          Effect.andThen(
            edges.writeWrapper(layout),
            Effect.promise(() => rm(command, { force: true })),
          ),
        )
        yield* ui.log("step", `the command is now kndl: ${layout.wrapper}`)
      }

      for (const role of services) {
        yield* attempt(
          `Couldn't start the ${RoleTitle[role]}'s service under kndl's name`,
          edges.installService(layout, role),
        )
      }

      if (left.length > 0) {
        yield* ui.note(
          left.join("\n"),
          `Stopped and kept, under the former name: the Sessions' Sandboxes and volumes (a woken Session starts its agent afresh, with the Hub's history). Remove them with \`bun x msb remove\` and then \`bun x msb volume remove\` in ${join(layout.app, "packages", "runner")} once you no longer need them:`,
        )
      }
      if (setting.env[FormerName.homeVariable] && home === from) {
        yield* ui.log(
          "warn",
          `Your shell sets ${FormerName.homeVariable}=${from}: set ${HomeVariable} instead, for the kndl command.`,
        )
      }
      if (problems.length > 0) {
        yield* ui.log("warn", "Run `kndl doctor --fix` for what didn't move.")
      }
      yield* ui.log("success", `The install is kndl's now, in ${home}.`)

      // Last: the service this runs under, which stops this process.
      const own = options.service
      if (own !== undefined && services.includes(own)) {
        yield* runSteps(ownServiceDisableSteps(setting, own))
        yield* Effect.promise(() => rm(formerServiceFile(setting, own), { force: true }))
        yield* runSteps(ownServiceStopSteps(setting, own))
      }
      return { plan, home, problems } as MoveOutcome
    }),
  )

/**
 * The processes running the CLI of the install in `home`, from `ps -A -o pid=,args=`'s output,
 * other than `self`: the former name's `update`, which restarted the services and waits for the
 * Hub, then checks on them.
 */
export function cliProcesses(ps: string, home: string, self: number): ReadonlyArray<number> {
  const cli = join(home, "app", "packages", "cli", "src", "main.ts")
  return ps.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line)
    if (match === null) return []
    const pid = Number(match[1])
    return pid !== self && (match[2] ?? "").includes(cli) ? [pid] : []
  })
}

/**
 * The CLI's own config directory, for a `kndl` a Hub served: moved from the former name's,
 * `${XDG_CONFIG_HOME:-~/.config}/claude-hub`, unless kndl's is there already. Says whether it moved.
 */
export async function moveFormerCliConfig(
  env: Record<string, string | undefined>,
  userHome: string,
): Promise<boolean> {
  const config = env.XDG_CONFIG_HOME || join(userHome, ".config")
  const former = join(config, FormerName.configDir)
  const current = join(config, "kndl")
  if (!existsSync(former) || existsSync(current)) return false
  try {
    await rename(former, current)
    return true
  } catch {
    return false
  }
}

/**
 * A binary a Hub served under the former name, which updated itself to kndl in its own place,
 * renames itself: `~/.local/bin/claude-hub` becomes `~/.local/bin/kndl`. Says what it did, if
 * anything; it leaves a `kndl` that is there already alone.
 */
export async function renameFormerBinary(exe: string): Promise<string | undefined> {
  if (basename(exe) !== FormerName.command) return undefined
  const renamed = join(dirname(exe), "kndl")
  if (existsSync(renamed)) {
    return `${FormerName.name} is now kndl, which is in ${renamed} already: remove ${exe}.`
  }
  try {
    await rename(exe, renamed)
    return `${FormerName.name} is now kndl: this command is ${renamed} now. Run it as kndl.`
  } catch (error) {
    return `${FormerName.name} is now kndl, but couldn't rename ${exe} to ${renamed}: ${errorMessage(error)}.`
  }
}
