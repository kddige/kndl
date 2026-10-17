// How the Hub starts `kndl update` for its Owner (ADR 0028, #362): outside its own service, so the
// update outlives the Hub it restarts. The update runs as the kndl services do (the CLI's
// Services.ts): the Bun that runs the Hub, on the installed checkout's CLI, in the home, with
// KNDL_HOME and the Hub's PATH set.
//
//   Linux   a transient systemd user unit, `kndl-update-<id>`, collected once it ends:
//           systemd-run --user --unit kndl-update-<id> --collect ... -- <bun> <cli> update ...
//   macOS   a launchd job with no KeepAlive, which runs once as it is loaded: its plist is written
//           to `<home>/update/launchd.plist`, the last update's job unloaded, and this one loaded.
//
// Its output goes to `<home>/logs/update.log`, beside the services' logs: what `kndl update`
// printed, as `update/update.log` holds what its steps ran. Behind a seam, so tests start nothing.

import { mkdir, writeFile } from "node:fs/promises"
import { userInfo } from "node:os"
import { dirname, join } from "node:path"
import type { Channel } from "@kndl/protocol"
import { Context, Effect, Layer } from "effect"

/** One `kndl update` the Hub starts. */
export interface UpdateJob {
  /** Tells this update's unit or job from the last one's. */
  readonly id: string
  /** The home, `KNDL_HOME`. */
  readonly home: string
  /** The Bun executable, absolute: the one that runs the Hub. */
  readonly bun: string
  /** The CLI's entry point in the installed checkout. */
  readonly cli: string
  /** The PATH it runs with: the Hub's, which its service set. */
  readonly path: string
  /** `--now`: Runners stop their running Turns at once. */
  readonly now: boolean
  /** `--channel`: follow it from now on. */
  readonly channel: Channel | undefined
}

/** The command line the update runs. */
export function updateCommandLine(job: UpdateJob): ReadonlyArray<string> {
  return [
    job.bun,
    job.cli,
    "update",
    "--source",
    "hub",
    ...(job.now ? ["--now"] : []),
    ...(job.channel === undefined ? [] : ["--channel", job.channel]),
  ]
}

/** Where the update's own output goes. */
export const updateOutput = (home: string) => join(home, "logs", "update.log")

/** The systemd unit an update runs as: `kndl-update-<id>`. */
export const updateUnit = (job: UpdateJob) => `kndl-update-${job.id}`

/** The launchd label every update's job has: the last one's is unloaded before the next loads. */
export const UpdateJobLabel = "io.github.kddige.kndl.update"

/** Where the launchd job's plist is written. */
export const updateJobPlistPath = (home: string) => join(home, "update", "launchd.plist")

/** A command a launch runs; one that `mayFail` doesn't stop it. */
export interface LaunchCommand {
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly mayFail?: boolean
}

/** What launching an update takes on a platform: the files it writes, then the commands it runs. */
export interface LaunchPlan {
  readonly files: ReadonlyArray<{ readonly path: string; readonly text: string }>
  readonly commands: ReadonlyArray<LaunchCommand>
}

/**
 * `systemd-run` it as a transient user service. `--service-type=exec` has systemd-run wait until
 * the update's process has started, so that a Bun that can't be run fails the launch; it returns
 * then, not when the update ends.
 */
export function systemdLaunch(job: UpdateJob): LaunchPlan {
  const output = updateOutput(job.home)
  return {
    files: [],
    commands: [
      {
        command: "systemd-run",
        args: [
          "--user",
          "--unit",
          updateUnit(job),
          "--collect",
          "--service-type=exec",
          "--quiet",
          `--description=kndl update, from the Hub`,
          `--working-directory=${job.home}`,
          `--setenv=KNDL_HOME=${job.home}`,
          `--setenv=PATH=${job.path}`,
          `--property=StandardOutput=append:${output}`,
          `--property=StandardError=append:${output}`,
          "--",
          ...updateCommandLine(job),
        ],
      },
    ],
  }
}

/**
 * Waits, up to 3 seconds, until launchd no longer knows the job `$1`: `launchctl bootout` returns
 * while launchd still unloads it (see the CLI's Services.ts). The last update's job has ended, so
 * this is quick.
 */
const untilUnloaded =
  'i=0; while launchctl print "$1" >/dev/null 2>&1; do [ "$i" -ge 30 ] && exit 1; sleep 0.1; i=$((i + 1)); done'

/**
 * A launchd job that runs once as it is loaded: RunAtLoad, and no KeepAlive, so launchd doesn't
 * start it again when it exits. It stays loaded, ended, until the next update unloads it.
 */
export function launchdLaunch(job: UpdateJob, uid: number): LaunchPlan {
  const service = `gui/${uid}/${UpdateJobLabel}`
  const plist = updateJobPlistPath(job.home)
  return {
    files: [{ path: plist, text: launchdJobPlist(job) }],
    commands: [
      { command: "launchctl", args: ["bootout", service], mayFail: true },
      { command: "sh", args: ["-c", untilUnloaded, "sh", service], mayFail: true },
      { command: "launchctl", args: ["bootstrap", `gui/${uid}`, plist] },
    ],
  }
}

/** The update's launchd job. */
export function launchdJobPlist(job: UpdateJob): string {
  const output = updateOutput(job.home)
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<!-- kndl update ${xml(job.id)}, started by the Hub. -->`,
    `<plist version="1.0">`,
    `<dict>`,
    `  <key>Label</key>`,
    `  <string>${UpdateJobLabel}</string>`,
    `  <key>ProgramArguments</key>`,
    `  <array>`,
    ...updateCommandLine(job).map((arg) => `    <string>${xml(arg)}</string>`),
    `  </array>`,
    `  <key>WorkingDirectory</key>`,
    `  <string>${xml(job.home)}</string>`,
    `  <key>EnvironmentVariables</key>`,
    `  <dict>`,
    `    <key>KNDL_HOME</key>`,
    `    <string>${xml(job.home)}</string>`,
    `    <key>PATH</key>`,
    `    <string>${xml(job.path)}</string>`,
    `  </dict>`,
    `  <key>RunAtLoad</key>`,
    `  <true/>`,
    `  <key>StandardOutPath</key>`,
    `  <string>${xml(output)}</string>`,
    `  <key>StandardErrorPath</key>`,
    `  <string>${xml(output)}</string>`,
    `</dict>`,
    `</plist>`,
    ``,
  ].join("\n")
}

/** Escapes XML's special characters. */
function xml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
}

/** How long one launch command may take. */
const commandTimeoutMs = 30_000

/** Runs a plan: its files written, then its commands in order. Fails with what went wrong. */
const runPlan = (plan: LaunchPlan) =>
  Effect.tryPromise({
    try: async () => {
      for (const file of plan.files) {
        await mkdir(dirname(file.path), { recursive: true })
        await writeFile(file.path, file.text)
      }
      for (const { command, args, mayFail } of plan.commands) {
        const child = Bun.spawn([command, ...args], {
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          timeout: commandTimeoutMs,
        })
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ])
        if (exitCode !== 0 && mayFail !== true) {
          const said = (stderr.trim() || stdout.trim()).slice(-1000)
          throw new Error(`${command} exited with ${exitCode}${said === "" ? "" : `: ${said}`}`)
        }
      }
    },
    catch: (error) => (error instanceof Error ? error.message : String(error)),
  })

export class HubUpdateLauncher extends Context.Service<
  HubUpdateLauncher,
  {
    /** Starts the update and returns once it has started; fails, saying why, when it couldn't. */
    readonly launch: (job: UpdateJob) => Effect.Effect<void, string>
  }
>()("@kndl/hub/HubUpdateLauncher") {
  /** systemd-run on Linux, a launchd job on macOS. */
  static readonly layer = Layer.sync(HubUpdateLauncher, () =>
    HubUpdateLauncher.of({
      launch: (job) => {
        switch (process.platform) {
          case "linux":
            return runPlan(systemdLaunch(job))
          case "darwin":
            return runPlan(launchdLaunch(job, userInfo().uid))
          default:
            return Effect.fail(`kndl runs updates on macOS and Linux, not ${process.platform}.`)
        }
      },
    }),
  )

  /** For tests: hands each job to `launched`, which may fail it with a message, and starts nothing. */
  static readonly fake = (launched: (job: UpdateJob) => string | void) =>
    Layer.succeed(
      HubUpdateLauncher,
      HubUpdateLauncher.of({
        launch: (job) =>
          Effect.suspend(() => {
            const refused = launched(job)
            return typeof refused === "string" ? Effect.fail(refused) : Effect.void
          }),
      }),
    )
}
