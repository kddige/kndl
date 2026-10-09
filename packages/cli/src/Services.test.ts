import { describe, expect, test } from "bun:test"
import { resolveLayout } from "./Layout.ts"
import {
  installSteps,
  launchdPlist,
  parseServiceState,
  serviceFilePath,
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

  test("runs the Hub with Bun and hub.env in the home, at login, after a crash, logging there", () => {
    // From the installed checkout.
    expect(plist).toContain(
      [
        "  <key>ProgramArguments</key>",
        "  <array>",
        "    <string>/home/ada/.bun/bin/bun</string>",
        "    <string>--env-file=/home/ada/.kndl/hub.env</string>",
        "    <string>/home/ada/.kndl/app/packages/hub/src/main.ts</string>",
        "  </array>",
      ].join("\n"),
    )
    expect(plist).toContain("<key>KNDL_HOME</key>\n    <string>/home/ada/.kndl</string>")
    expect(plist).toContain(
      "<key>PATH</key>\n    <string>/home/ada/.bun/bin:/usr/bin:/bin</string>",
    )
    // Tells a Runner its service starts it again, so it may restart to update itself (#87).
    expect(plist).toContain("<key>KNDL_SERVICE</key>\n    <string>hub</string>")
    expect(plist).toContain("<key>WorkingDirectory</key>\n  <string>/home/ada/.kndl</string>")
    expect(plist).toContain("<key>RunAtLoad</key>\n  <true/>")
    expect(plist).toContain(
      "<key>KeepAlive</key>\n  <dict>\n    <key>SuccessfulExit</key>\n    <false/>",
    )
    expect(plist).toContain(
      "<key>StandardOutPath</key>\n  <string>/home/ada/.kndl/logs/hub.log</string>",
    )
    expect(plist).toContain(
      "<key>StandardErrorPath</key>\n  <string>/home/ada/.kndl/logs/hub.log</string>",
    )
    // Labelled per role.
    expect(plist).toContain("<string>io.github.kddige.kndl.hub</string>")
    expect(launchdPlist(spec("runner"))).toContain("<string>io.github.kddige.kndl.runner</string>")
  })

  test("lets the Runner's Sessions outlive it, and only the Runner's", () => {
    expect(launchdPlist(spec("runner"))).toContain("<key>AbandonProcessGroup</key>\n  <true/>")
    expect(plist).not.toContain("AbandonProcessGroup")
  })

  test("escapes XML in paths", () => {
    const odd = launchdPlist({ ...spec("hub"), bun: "/opt/a&b/<bun>" })

    expect(odd).toContain("<string>/opt/a&amp;b/&lt;bun&gt;</string>")
  })
})

describe("the systemd user unit", () => {
  const unit = systemdUnitFile(spec("runner"))

  test("runs the Runner with Bun and runner.env in the home, with the session, after a failure, logging there", () => {
    // From the installed checkout.
    expect(unit).toContain(
      "ExecStart=/home/ada/.bun/bin/bun --env-file=/home/ada/.kndl/runner.env /home/ada/.kndl/app/packages/runner/src/main.ts",
    )
    expect(unit).toContain("Environment=KNDL_HOME=/home/ada/.kndl")
    expect(unit).toContain("Environment=PATH=/home/ada/.bun/bin:/usr/bin:/bin")
    expect(unit).toContain("Environment=KNDL_SERVICE=runner")
    expect(unit).toContain("WorkingDirectory=/home/ada/.kndl")
    expect(unit).toContain("Restart=on-failure")
    expect(unit).toContain("[Install]\nWantedBy=default.target")
    expect(unit).toContain("StandardOutput=append:/home/ada/.kndl/logs/runner.log")
    expect(unit).toContain("StandardError=append:/home/ada/.kndl/logs/runner.log")
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
      layout: resolveLayout({ KNDL_HOME: "/srv/kndl home" }, "/home/ada"),
    })

    expect(spaced).toContain("WorkingDirectory=/srv/kndl home\n")
    expect(spaced).toContain("StandardOutput=append:/srv/kndl home/logs/hub.log\n")
    expect(spaced).toContain('Environment="KNDL_HOME=/srv/kndl home"')
  })
})

test("a LaunchAgent goes in ~/Library/LaunchAgents, a systemd user unit in the config home", () => {
  expect(serviceFilePath(target("darwin", "hub"))).toBe(
    "/home/ada/Library/LaunchAgents/io.github.kddige.kndl.hub.plist",
  )
  expect(serviceFilePath(target("linux", "runner"))).toBe(
    "/home/ada/.config/systemd/user/kndl-runner.service",
  )
})

describe("the service commands", () => {
  test("load, unload and kick the service as launchd and systemd do", () => {
    expect({
      "launchd install": commands(installSteps(target("darwin", "hub"))),
      "launchd stop": commands(stopSteps(target("darwin", "runner"))),
      "launchd start": commands(startSteps(target("darwin", "hub"))),
      "systemd install": commands(installSteps(target("linux", "hub"))),
      "systemd uninstall": commands(uninstallSteps(target("linux", "runner"))),
    }).toEqual({
      // Unloads any earlier version first.
      "launchd install": [
        "launchctl bootout gui/501/io.github.kddige.kndl.hub",
        "launchctl enable gui/501/io.github.kddige.kndl.hub",
        "launchctl bootstrap gui/501 /home/ada/Library/LaunchAgents/io.github.kddige.kndl.hub.plist",
      ],
      // Unloads, so KeepAlive doesn't restart it.
      "launchd stop": ["launchctl bootout gui/501/io.github.kddige.kndl.runner"],
      "launchd start": [
        "launchctl enable gui/501/io.github.kddige.kndl.hub",
        "launchctl bootstrap gui/501 /home/ada/Library/LaunchAgents/io.github.kddige.kndl.hub.plist",
        "launchctl kickstart gui/501/io.github.kddige.kndl.hub",
      ],
      "systemd install": [
        "systemctl --user daemon-reload",
        "systemctl --user enable --now kndl-hub.service",
        "systemctl --user restart kndl-hub.service",
      ],
      "systemd uninstall": ["systemctl --user disable --now kndl-runner.service"],
    })
    // Unloading an agent that isn't loaded is fine.
    expect(installSteps(target("darwin", "hub"))[0]?.mayFail).toBe(true)
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

test("reading how a service is doing, from launchd and systemd", () => {
  const cases: ReadonlyArray<
    [Parameters<typeof parseServiceState>, ReturnType<typeof parseServiceState>]
  > = [
    [
      [
        "darwin",
        {
          exitCode: 0,
          stdout: "gui/501/io.github.kddige.kndl.hub = {\n\tstate = running\n\tpid = 4242\n}",
        },
      ],
      { _tag: "Running", pid: 4242 },
    ],
    [
      ["darwin", { exitCode: 0, stdout: "\tstate = not running\n\tlast exit code = 1\n" }],
      { _tag: "Stopped", detail: "not running, last exit 1" },
    ],
    [["darwin", { exitCode: 113, stdout: "" }], { _tag: "NotLoaded" }],
    [
      [
        "linux",
        {
          exitCode: 0,
          stdout:
            "LoadState=loaded\nActiveState=active\nSubState=running\nMainPID=99\nResult=success\n",
        },
      ],
      { _tag: "Running", pid: 99 },
    ],
    [
      [
        "linux",
        {
          exitCode: 0,
          stdout:
            "LoadState=loaded\nActiveState=failed\nSubState=failed\nMainPID=0\nResult=exit-code\n",
        },
      ],
      { _tag: "Stopped", detail: "failed, failed, exit-code" },
    ],
    [
      [
        "linux",
        {
          exitCode: 0,
          stdout: "LoadState=not-found\nActiveState=inactive\nSubState=dead\nMainPID=0\n",
        },
      ],
      { _tag: "NotLoaded" },
    ],
  ]
  for (const [input, state] of cases) expect(parseServiceState(...input)).toEqual(state)
})
