// The Hub and Runner as services: a launchd LaunchAgent on macOS, a systemd user unit on Linux.
// Everything here is pure: the service files' text, the commands that install, start, stop and
// query them, and reading what those commands answer. Cli.ts writes the files and runs the Steps.
//
// Both kinds run `bun --env-file=<home>/<role>.env <home>/app/packages/<role>/src/main.ts` in the
// home, with CLAUDE_HUB_HOME set, so the env file is read the same way, by Bun, on both platforms.
// Both log to `<home>/logs/<role>.log` and restart the process when it exits unsuccessfully, as
// when it crashes, or a Runner exits to restart on the commit it updated to (#87). They set
// CLAUDE_HUB_SERVICE to the role, which tells the Runner that something starts it again.
import { join } from "node:path"
import type { Layout, Role } from "./Layout.ts"
import { type Step, step } from "./Shell.ts"

export type Platform = "darwin" | "linux"

/** What a service file is generated from. */
export interface ServiceSpec {
  readonly role: Role
  readonly layout: Layout
  /** The Bun executable, absolute: a service doesn't get the user's shell PATH to find it. */
  readonly bun: string
  /**
   * The PATH the service runs with: the one onboard ran with. A launchd agent otherwise gets only
   * `/usr/bin:/bin:/usr/sbin:/sbin`, and the Runner needs tmux, git, gh and claude.
   */
  readonly path: string
}

/** How a service is addressed on this machine. */
export interface ServiceTarget {
  readonly platform: Platform
  readonly role: Role
  /** The user's id, for launchd's `gui/<uid>` domain. */
  readonly uid: number
  /** Where systemd user units go: `$XDG_CONFIG_HOME/systemd/user`, else `~/.config/systemd/user`. */
  readonly configHome: string
  readonly userHome: string
}

/** The launchd label: `io.github.kddige.claude-hub.hub`, `….runner`. */
export const launchdLabel = (role: Role) => `io.github.kddige.claude-hub.${role}`

/**
 * Set to the role on the process a service runs: the Runner updates itself only when it is set,
 * since exiting to restart is safe only under a service (see the Runner's SelfUpdate.ts).
 */
export const ServiceVariable = "CLAUDE_HUB_SERVICE"

/** The systemd unit: `claude-hub-hub.service`, `claude-hub-runner.service`. */
export const systemdUnit = (role: Role) => `claude-hub-${role}.service`

const RoleTitle: Record<Role, string> = { hub: "Hub", runner: "Runner" }

/** Where the service file goes. */
export function serviceFilePath(target: ServiceTarget): string {
  return target.platform === "darwin"
    ? join(target.userHome, "Library", "LaunchAgents", `${launchdLabel(target.role)}.plist`)
    : join(target.configHome, "systemd", "user", systemdUnit(target.role))
}

/** The service file's contents. */
export function serviceFile(platform: Platform, spec: ServiceSpec): string {
  return platform === "darwin" ? launchdPlist(spec) : systemdUnitFile(spec)
}

function programArguments(spec: ServiceSpec): ReadonlyArray<string> {
  return [
    spec.bun,
    `--env-file=${spec.layout.envFile(spec.role)}`,
    spec.layout.entryPoint(spec.role),
  ]
}

/**
 * The LaunchAgent. It starts at login (RunAtLoad) and again whenever it exits unsuccessfully
 * (KeepAlive, SuccessfulExit false); ThrottleInterval spaces the restarts. The Runner's agent
 * abandons its process group, so stopping the Runner leaves its Sessions' Sandboxes running until
 * the next Runner starts and puts them to sleep.
 */
export function launchdPlist(spec: ServiceSpec): string {
  const log = spec.layout.logFile(spec.role)
  const lines = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<!-- The claude-hub ${RoleTitle[spec.role]}, written by \`claude-hub ${spec.role} install\`. -->`,
    `<plist version="1.0">`,
    `<dict>`,
    `  <key>Label</key>`,
    `  <string>${xml(launchdLabel(spec.role))}</string>`,
    `  <key>ProgramArguments</key>`,
    `  <array>`,
    ...programArguments(spec).map((arg) => `    <string>${xml(arg)}</string>`),
    `  </array>`,
    `  <key>WorkingDirectory</key>`,
    `  <string>${xml(spec.layout.home.dir)}</string>`,
    `  <key>EnvironmentVariables</key>`,
    `  <dict>`,
    `    <key>CLAUDE_HUB_HOME</key>`,
    `    <string>${xml(spec.layout.home.dir)}</string>`,
    `    <key>${ServiceVariable}</key>`,
    `    <string>${spec.role}</string>`,
    `    <key>PATH</key>`,
    `    <string>${xml(spec.path)}</string>`,
    `  </dict>`,
    `  <key>RunAtLoad</key>`,
    `  <true/>`,
    `  <key>KeepAlive</key>`,
    `  <dict>`,
    `    <key>SuccessfulExit</key>`,
    `    <false/>`,
    `  </dict>`,
    `  <key>ThrottleInterval</key>`,
    `  <integer>10</integer>`,
    ...(spec.role === "runner" ? [`  <key>AbandonProcessGroup</key>`, `  <true/>`] : []),
    `  <key>StandardOutPath</key>`,
    `  <string>${xml(log)}</string>`,
    `  <key>StandardErrorPath</key>`,
    `  <string>${xml(log)}</string>`,
    `</dict>`,
    `</plist>`,
    ``,
  ]
  return lines.join("\n")
}

/**
 * The systemd user unit. It restarts on failure; the Runner's stops only its own process
 * (KillMode=process), so its Sessions' Sandboxes outlive it until the next Runner starts and
 * puts them to sleep.
 */
export function systemdUnitFile(spec: ServiceSpec): string {
  const log = spec.layout.logFile(spec.role)
  const lines = [
    `# The claude-hub ${RoleTitle[spec.role]}, written by \`claude-hub ${spec.role} install\`.`,
    `[Unit]`,
    `Description=claude-hub ${RoleTitle[spec.role]}`,
    `After=network-online.target`,
    ``,
    `[Service]`,
    `Type=simple`,
    `WorkingDirectory=${systemdPath(spec.layout.home.dir)}`,
    `Environment=${systemdWord(`CLAUDE_HUB_HOME=${spec.layout.home.dir}`)}`,
    `Environment=${ServiceVariable}=${spec.role}`,
    `Environment=${systemdWord(`PATH=${spec.path}`)}`,
    `ExecStart=${programArguments(spec).map(systemdWord).join(" ")}`,
    `Restart=on-failure`,
    `RestartSec=5`,
    ...(spec.role === "runner" ? [`KillMode=process`] : []),
    `StandardOutput=append:${systemdPath(log)}`,
    `StandardError=append:${systemdPath(log)}`,
    ``,
    `[Install]`,
    `WantedBy=default.target`,
    ``,
  ]
  return lines.join("\n")
}

/** The Steps that load the service file and start it (it must already be written). */
export function installSteps(target: ServiceTarget): ReadonlyArray<Step> {
  if (target.platform === "darwin") {
    const domain = `gui/${target.uid}`
    return [
      step("launchctl", ["bootout", `${domain}/${launchdLabel(target.role)}`], {
        system: true,
        mayFail: true,
        why: "unload an earlier version, if loaded",
      }),
      step("launchctl", ["enable", `${domain}/${launchdLabel(target.role)}`], { system: true }),
      step("launchctl", ["bootstrap", domain, serviceFilePath(target)], { system: true }),
    ]
  }
  return [
    step("systemctl", ["--user", "daemon-reload"], { system: true }),
    step("systemctl", ["--user", "enable", "--now", systemdUnit(target.role)], { system: true }),
    step("systemctl", ["--user", "restart", systemdUnit(target.role)], { system: true }),
  ]
}

/** The Steps that start an installed service. */
export function startSteps(target: ServiceTarget): ReadonlyArray<Step> {
  if (target.platform === "darwin") {
    const domain = `gui/${target.uid}`
    const service = `${domain}/${launchdLabel(target.role)}`
    return [
      step("launchctl", ["enable", service], { system: true }),
      // Loading starts it (RunAtLoad); it fails harmlessly when the agent is already loaded.
      step("launchctl", ["bootstrap", domain, serviceFilePath(target)], {
        system: true,
        mayFail: true,
      }),
      step("launchctl", ["kickstart", service], { system: true }),
    ]
  }
  return [step("systemctl", ["--user", "start", systemdUnit(target.role)], { system: true })]
}

/**
 * The Steps that stop a service. A launchd agent is unloaded, since KeepAlive would restart a
 * killed one; it loads again at the next login, as an enabled systemd unit starts again at boot.
 */
export function stopSteps(target: ServiceTarget): ReadonlyArray<Step> {
  if (target.platform === "darwin") {
    return [
      step("launchctl", ["bootout", `gui/${target.uid}/${launchdLabel(target.role)}`], {
        system: true,
        mayFail: true,
      }),
    ]
  }
  return [
    step("systemctl", ["--user", "stop", systemdUnit(target.role)], {
      system: true,
      mayFail: true,
    }),
  ]
}

/** The Steps that stop the service for good; the file is removed after them. */
export function uninstallSteps(target: ServiceTarget): ReadonlyArray<Step> {
  if (target.platform === "darwin") return stopSteps(target)
  return [
    step("systemctl", ["--user", "disable", "--now", systemdUnit(target.role)], {
      system: true,
      mayFail: true,
    }),
  ]
}

/** After the unit file is removed on Linux, systemd forgets it. */
export function afterUninstallSteps(target: ServiceTarget): ReadonlyArray<Step> {
  return target.platform === "linux"
    ? [step("systemctl", ["--user", "daemon-reload"], { system: true, mayFail: true })]
    : []
}

/** The read-only Step that asks how the service is doing; {@link parseServiceState} reads it. */
export function statusStep(target: ServiceTarget): Step {
  return target.platform === "darwin"
    ? step("launchctl", ["print", `gui/${target.uid}/${launchdLabel(target.role)}`], {
        system: true,
        mayFail: true,
      })
    : step(
        "systemctl",
        [
          "--user",
          "show",
          systemdUnit(target.role),
          "--property=LoadState,ActiveState,SubState,MainPID,Result",
        ],
        { system: true, mayFail: true },
      )
}

/** How a service is doing. */
export type ServiceState =
  | { readonly _tag: "NotInstalled" }
  | { readonly _tag: "NotLoaded" }
  | { readonly _tag: "Running"; readonly pid: number | undefined }
  | { readonly _tag: "Stopped"; readonly detail: string }
  | { readonly _tag: "Unknown"; readonly detail: string }

/** Reads what {@link statusStep} answered. */
export function parseServiceState(
  platform: Platform,
  result: { readonly exitCode: number; readonly stdout: string },
): ServiceState {
  if (platform === "darwin") {
    // `launchctl print` exits 113 for a service it doesn't know.
    if (result.exitCode !== 0) return { _tag: "NotLoaded" }
    const state = /^\s*state = (.+)$/m.exec(result.stdout)?.[1]?.trim()
    const pid = /^\s*pid = (\d+)$/m.exec(result.stdout)?.[1]
    const lastExit = /^\s*last exit code = (.+)$/m.exec(result.stdout)?.[1]?.trim()
    if (state === "running") return { _tag: "Running", pid: pid ? Number(pid) : undefined }
    if (state === undefined) return { _tag: "Unknown", detail: "launchctl didn't say" }
    return { _tag: "Stopped", detail: lastExit ? `${state}, last exit ${lastExit}` : state }
  }
  const props = Object.fromEntries(
    result.stdout
      .split("\n")
      .map((line) => line.split("="))
      .filter((parts) => parts.length >= 2)
      .map(([key, ...value]) => [key, value.join("=")]),
  )
  if (result.exitCode !== 0 || props.LoadState === undefined) {
    return { _tag: "Unknown", detail: "systemctl didn't say" }
  }
  if (props.LoadState === "not-found") return { _tag: "NotLoaded" }
  if (props.ActiveState === "active") {
    const pid = Number(props.MainPID)
    return { _tag: "Running", pid: pid > 0 ? pid : undefined }
  }
  const detail = [props.ActiveState, props.SubState, props.Result]
    .filter((part) => part && part !== "success")
    .join(", ")
  return { _tag: "Stopped", detail: detail || "inactive" }
}

/** How a service state reads in `status`. */
export function describeServiceState(state: ServiceState): string {
  switch (state._tag) {
    case "NotInstalled":
      return "not installed"
    case "NotLoaded":
      return "installed, not loaded"
    case "Running":
      return state.pid === undefined ? "running" : `running (pid ${state.pid})`
    case "Stopped":
      return `stopped (${state.detail})`
    case "Unknown":
      return `unknown (${state.detail})`
  }
}

/** The Step that asks whether the user's systemd instance lingers, so services run logged out. */
export const lingerStatusStep = (user: string) =>
  step("loginctl", ["show-user", user, "--property=Linger"], { system: true, mayFail: true })

/** Whether {@link lingerStatusStep} answered yes. */
export const lingers = (stdout: string) => /^Linger=yes$/m.test(stdout)

/**
 * Lets the user's services run while they're logged out, and start at boot. Most systems let a
 * user turn it on for themselves; others ask for sudo, which the Step then needs.
 */
export const enableLingerStep = (user: string) =>
  step("loginctl", ["enable-linger", user], {
    system: true,
    why: "keep the services running while you're logged out",
  })

/** Escapes XML's special characters. */
function xml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
}

/** A path systemd takes literally (WorkingDirectory, append:): only `%`, a specifier, is doubled. */
export function systemdPath(path: string): string {
  return path.replaceAll("%", "%%")
}

/**
 * Quotes one word for a systemd unit: `%` is a specifier and `$` an expansion, so both are
 * doubled; a word with spaces, quotes or backslashes is double-quoted.
 */
export function systemdWord(word: string): string {
  const escaped = word.replaceAll("%", "%%").replaceAll("$", "$$$$")
  if (!/[\s"'\\]/.test(escaped)) return escaped
  return `"${escaped.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
}

/**
 * The PATH a service file written by {@link serviceFile} runs its service with, read back: the
 * plist's `PATH` string or the unit's `Environment=PATH=…`. Undefined when it has none.
 */
export function servicePathIn(text: string): string | undefined {
  const plist = /<key>PATH<\/key>\s*<string>([^<]*)<\/string>/.exec(text)
  if (plist) {
    return (plist[1] ?? "")
      .replaceAll("&quot;", '"')
      .replaceAll("&gt;", ">")
      .replaceAll("&lt;", "<")
      .replaceAll("&amp;", "&")
  }
  for (const line of text.split("\n")) {
    if (!line.startsWith("Environment=")) continue
    let word = line.slice("Environment=".length).trim()
    if (word.startsWith('"') && word.endsWith('"')) {
      word = word.slice(1, -1).replaceAll('\\"', '"').replaceAll("\\\\", "\\")
    }
    word = word.replaceAll("$$", "$").replaceAll("%%", "%")
    if (word.startsWith("PATH=")) return word.slice("PATH=".length)
  }
  return undefined
}
