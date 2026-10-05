import { describe, expect, test } from "bun:test"
import { resolveLayout } from "./Layout.ts"
import {
  installSteps,
  launchdPlist,
  parseServiceState,
  serviceFilePath,
  servicePathIn,
  type ServiceTarget,
  startSteps,
  stopSteps,
  systemdUnitFile,
  systemdWord,
  uninstallSteps,
} from "./Services.ts"
import { describeStep } from "./Shell.ts"

const layout = resolveLayout({}, "/home/ada")
const spec = (role: "hub" | "runner") => ({
  role,
  layout,
  bun: "/home/ada/.bun/bin/bun",
  path: "/home/ada/.bun/bin:/usr/bin:/bin",
})
const commands = (steps: ReadonlyArray<Parameters<typeof describeStep>[0]>) =>
  steps.map((s) => describeStep(s))
const target = (platform: "darwin" | "linux", role: "hub" | "runner"): ServiceTarget => ({
  platform,
  role,
  uid: 501,
  configHome: "/home/ada/.config",
  userHome: "/home/ada",
})

describe("the launchd LaunchAgent", () => {
  const plist = launchdPlist(spec("hub"))

  test("runs the Hub with Bun, loading hub.env, from the installed checkout", () => {
    expect(plist).toContain(
      [
        "  <key>ProgramArguments</key>",
        "  <array>",
        "    <string>/home/ada/.bun/bin/bun</string>",
        "    <string>--env-file=/home/ada/.claude-hub/hub.env</string>",
        "    <string>/home/ada/.claude-hub/app/packages/hub/src/main.ts</string>",
        "  </array>",
      ].join("\n"),
    )
  })

  test("sets CLAUDE_HUB_HOME and the PATH, and runs in the home", () => {
    expect(plist).toContain(
      "<key>CLAUDE_HUB_HOME</key>\n    <string>/home/ada/.claude-hub</string>",
    )
    expect(plist).toContain(
      "<key>PATH</key>\n    <string>/home/ada/.bun/bin:/usr/bin:/bin</string>",
    )
    expect(plist).toContain("<key>WorkingDirectory</key>\n  <string>/home/ada/.claude-hub</string>")
  })

  test("starts at login and restarts after a crash", () => {
    expect(plist).toContain("<key>RunAtLoad</key>\n  <true/>")
    expect(plist).toContain(
      "<key>KeepAlive</key>\n  <dict>\n    <key>SuccessfulExit</key>\n    <false/>",
    )
  })

  test("logs to the home's logs directory", () => {
    expect(plist).toContain(
      "<key>StandardOutPath</key>\n  <string>/home/ada/.claude-hub/logs/hub.log</string>",
    )
    expect(plist).toContain(
      "<key>StandardErrorPath</key>\n  <string>/home/ada/.claude-hub/logs/hub.log</string>",
    )
  })

  test("is labelled per role", () => {
    expect(plist).toContain("<string>io.github.kddige.claude-hub.hub</string>")
    expect(launchdPlist(spec("runner"))).toContain(
      "<string>io.github.kddige.claude-hub.runner</string>",
    )
  })

  test("lets the Runner's Sessions outlive it, and only the Runner's", () => {
    expect(launchdPlist(spec("runner"))).toContain("<key>AbandonProcessGroup</key>\n  <true/>")
    expect(plist).not.toContain("AbandonProcessGroup")
  })

  test("escapes XML in paths", () => {
    const odd = launchdPlist({ ...spec("hub"), bun: "/opt/a&b/<bun>" })

    expect(odd).toContain("<string>/opt/a&amp;b/&lt;bun&gt;</string>")
  })

  test("is a well-formed plist", () => {
    expect(plist.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true)
    expect(plist.trimEnd().endsWith("</plist>")).toBe(true)
  })
})

describe("the systemd user unit", () => {
  const unit = systemdUnitFile(spec("runner"))

  test("runs the Runner with Bun, loading runner.env, from the installed checkout", () => {
    expect(unit).toContain(
      "ExecStart=/home/ada/.bun/bin/bun --env-file=/home/ada/.claude-hub/runner.env /home/ada/.claude-hub/app/packages/runner/src/main.ts",
    )
  })

  test("sets CLAUDE_HUB_HOME and the PATH, and runs in the home", () => {
    expect(unit).toContain("Environment=CLAUDE_HUB_HOME=/home/ada/.claude-hub")
    expect(unit).toContain("Environment=PATH=/home/ada/.bun/bin:/usr/bin:/bin")
    expect(unit).toContain("WorkingDirectory=/home/ada/.claude-hub")
  })

  test("restarts on failure and starts with the user's session", () => {
    expect(unit).toContain("Restart=on-failure")
    expect(unit).toContain("[Install]\nWantedBy=default.target")
  })

  test("appends to the home's logs", () => {
    expect(unit).toContain("StandardOutput=append:/home/ada/.claude-hub/logs/runner.log")
    expect(unit).toContain("StandardError=append:/home/ada/.claude-hub/logs/runner.log")
  })

  test("stops only the Runner's own process, so its Sessions outlive it", () => {
    expect(unit).toContain("KillMode=process")
    expect(systemdUnitFile(spec("hub"))).not.toContain("KillMode")
  })

  test("quotes words with spaces, and escapes specifiers and expansions", () => {
    expect(systemdWord("/home/ada/My Bun/bun")).toBe('"/home/ada/My Bun/bun"')
    expect(systemdWord("100%")).toBe("100%%")
    expect(systemdWord("$HOME")).toBe("$$HOME")
  })

  test("doesn't quote paths that take no quotes", () => {
    const spaced = systemdUnitFile({
      ...spec("hub"),
      layout: resolveLayout({ CLAUDE_HUB_HOME: "/srv/claude hub" }, "/home/ada"),
    })

    expect(spaced).toContain("WorkingDirectory=/srv/claude hub\n")
    expect(spaced).toContain("StandardOutput=append:/srv/claude hub/logs/hub.log\n")
    expect(spaced).toContain('Environment="CLAUDE_HUB_HOME=/srv/claude hub"')
  })
})

describe("the PATH a service file runs with, read back", () => {
  test("from either platform's file, however it was escaped", () => {
    for (const path of ["/home/ada/.bun/bin:/usr/bin:/bin", "/odd dir/$HOME/100%/a&b<c>:/bin"]) {
      expect(servicePathIn(launchdPlist({ ...spec("runner"), path }))).toBe(path)
      expect(servicePathIn(systemdUnitFile({ ...spec("runner"), path }))).toBe(path)
    }
  })

  test("is undefined for a file without one", () => {
    expect(servicePathIn("[Service]\nExecStart=/bin/true\n")).toBeUndefined()
  })
})

describe("where the service files go", () => {
  test("a LaunchAgent in ~/Library/LaunchAgents", () => {
    expect(serviceFilePath(target("darwin", "hub"))).toBe(
      "/home/ada/Library/LaunchAgents/io.github.kddige.claude-hub.hub.plist",
    )
  })

  test("a systemd user unit in the config home", () => {
    expect(serviceFilePath(target("linux", "runner"))).toBe(
      "/home/ada/.config/systemd/user/claude-hub-runner.service",
    )
  })
})

describe("the service commands", () => {
  test("launchd: install unloads any earlier version, then enables and loads", () => {
    expect(commands(installSteps(target("darwin", "hub")))).toEqual([
      "launchctl bootout gui/501/io.github.kddige.claude-hub.hub",
      "launchctl enable gui/501/io.github.kddige.claude-hub.hub",
      "launchctl bootstrap gui/501 /home/ada/Library/LaunchAgents/io.github.kddige.claude-hub.hub.plist",
    ])
    expect(installSteps(target("darwin", "hub"))[0]?.mayFail).toBe(true)
  })

  test("launchd: stop unloads, so KeepAlive doesn't restart it", () => {
    expect(commands(stopSteps(target("darwin", "runner")))).toEqual([
      "launchctl bootout gui/501/io.github.kddige.claude-hub.runner",
    ])
  })

  test("launchd: start loads the agent and kicks it", () => {
    expect(commands(startSteps(target("darwin", "hub")))).toEqual([
      "launchctl enable gui/501/io.github.kddige.claude-hub.hub",
      "launchctl bootstrap gui/501 /home/ada/Library/LaunchAgents/io.github.kddige.claude-hub.hub.plist",
      "launchctl kickstart gui/501/io.github.kddige.claude-hub.hub",
    ])
  })

  test("systemd: install reloads, enables and restarts the user unit", () => {
    expect(commands(installSteps(target("linux", "hub")))).toEqual([
      "systemctl --user daemon-reload",
      "systemctl --user enable --now claude-hub-hub.service",
      "systemctl --user restart claude-hub-hub.service",
    ])
  })

  test("systemd: uninstall disables and stops it", () => {
    expect(commands(uninstallSteps(target("linux", "runner")))).toEqual([
      "systemctl --user disable --now claude-hub-runner.service",
    ])
  })

  test("never run with sudo, and are all system Steps a dry run skips", () => {
    const all = [
      ...installSteps(target("darwin", "hub")),
      ...installSteps(target("linux", "hub")),
      ...startSteps(target("linux", "hub")),
      ...stopSteps(target("linux", "hub")),
    ]

    expect(all.every((s) => s.sudo !== true && s.system === true)).toBe(true)
  })
})

describe("reading how a service is doing", () => {
  test("launchd: running, with its pid", () => {
    const stdout = "gui/501/io.github.kddige.claude-hub.hub = {\n\tstate = running\n\tpid = 4242\n}"

    expect(parseServiceState("darwin", { exitCode: 0, stdout })).toEqual({
      _tag: "Running",
      pid: 4242,
    })
  })

  test("launchd: not running, with its last exit", () => {
    const stdout = "\tstate = not running\n\tlast exit code = 1\n"

    expect(parseServiceState("darwin", { exitCode: 0, stdout })).toEqual({
      _tag: "Stopped",
      detail: "not running, last exit 1",
    })
  })

  test("launchd: not loaded", () => {
    expect(parseServiceState("darwin", { exitCode: 113, stdout: "" })).toEqual({
      _tag: "NotLoaded",
    })
  })

  test("systemd: active", () => {
    const stdout =
      "LoadState=loaded\nActiveState=active\nSubState=running\nMainPID=99\nResult=success\n"

    expect(parseServiceState("linux", { exitCode: 0, stdout })).toEqual({
      _tag: "Running",
      pid: 99,
    })
  })

  test("systemd: failed", () => {
    const stdout =
      "LoadState=loaded\nActiveState=failed\nSubState=failed\nMainPID=0\nResult=exit-code\n"

    expect(parseServiceState("linux", { exitCode: 0, stdout })).toEqual({
      _tag: "Stopped",
      detail: "failed, failed, exit-code",
    })
  })

  test("systemd: no such unit", () => {
    const stdout = "LoadState=not-found\nActiveState=inactive\nSubState=dead\nMainPID=0\n"

    expect(parseServiceState("linux", { exitCode: 0, stdout })).toEqual({ _tag: "NotLoaded" })
  })
})
