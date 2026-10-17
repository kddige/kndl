// How the Hub launches `kndl update` outside its own service (#362): the systemd-run command on
// Linux, and the launchd job on macOS. Nothing here starts anything.

import { describe, expect, test } from "bun:test"
import {
  launchdJobPlist,
  launchdLaunch,
  systemdLaunch,
  type UpdateJob,
  updateCommandLine,
} from "./HubUpdateLauncher.ts"

const job: UpdateJob = {
  id: "1a2b3c4d",
  home: "/home/kai/.kndl",
  bun: "/home/kai/.bun/bin/bun",
  cli: "/home/kai/.kndl/app/packages/cli/src/main.ts",
  path: "/home/kai/.bun/bin:/usr/local/bin:/usr/bin:/bin",
  now: false,
  channel: undefined,
}

describe("the update the Hub runs", () => {
  test("is kndl update from the Hub, with --now and --channel as asked", () => {
    expect(updateCommandLine(job)).toEqual([
      "/home/kai/.bun/bin/bun",
      "/home/kai/.kndl/app/packages/cli/src/main.ts",
      "update",
      "--source",
      "hub",
    ])
    expect(updateCommandLine({ ...job, now: true, channel: "stable" }).slice(2)).toEqual([
      "update",
      "--source",
      "hub",
      "--now",
      "--channel",
      "stable",
    ])
  })
})

describe("on Linux", () => {
  test("is a transient systemd user unit, collected once it ends, with the services' env", () => {
    expect(systemdLaunch(job)).toEqual({
      files: [],
      commands: [
        {
          command: "systemd-run",
          args: [
            "--user",
            "--unit",
            "kndl-update-1a2b3c4d",
            "--collect",
            "--service-type=exec",
            "--quiet",
            "--description=kndl update, from the Hub",
            "--working-directory=/home/kai/.kndl",
            "--setenv=KNDL_HOME=/home/kai/.kndl",
            "--setenv=PATH=/home/kai/.bun/bin:/usr/local/bin:/usr/bin:/bin",
            "--property=StandardOutput=append:/home/kai/.kndl/logs/update.log",
            "--property=StandardError=append:/home/kai/.kndl/logs/update.log",
            "--",
            "/home/kai/.bun/bin/bun",
            "/home/kai/.kndl/app/packages/cli/src/main.ts",
            "update",
            "--source",
            "hub",
          ],
        },
      ],
    })
  })
})

describe("on macOS", () => {
  test("unloads the last update's launchd job, and loads this one's", () => {
    const plan = launchdLaunch(job, 501)
    expect(plan.files.map((file) => file.path)).toEqual(["/home/kai/.kndl/update/launchd.plist"])
    expect(plan.commands.map(({ command, args, mayFail }) => [command, args[0], mayFail])).toEqual([
      ["launchctl", "bootout", true],
      ["sh", "-c", true],
      ["launchctl", "bootstrap", undefined],
    ])
    expect(plan.commands[0]?.args).toEqual(["bootout", "gui/501/io.github.kddige.kndl.update"])
    expect(plan.commands[2]?.args).toEqual([
      "bootstrap",
      "gui/501",
      "/home/kai/.kndl/update/launchd.plist",
    ])
  })

  test("runs it once as it loads, with KNDL_HOME and PATH, and never again", () => {
    const plist = launchdJobPlist({ ...job, home: "/Users/kai/kndl & co", now: true })
    expect(plist).toContain("<string>io.github.kddige.kndl.update</string>")
    expect(plist).toContain(
      [
        "  <array>",
        "    <string>/home/kai/.bun/bin/bun</string>",
        "    <string>/home/kai/.kndl/app/packages/cli/src/main.ts</string>",
        "    <string>update</string>",
        "    <string>--source</string>",
        "    <string>hub</string>",
        "    <string>--now</string>",
        "  </array>",
      ].join("\n"),
    )
    expect(plist).toContain("<key>KNDL_HOME</key>\n    <string>/Users/kai/kndl &amp; co</string>")
    expect(plist).toContain(`<key>PATH</key>\n    <string>${job.path}</string>`)
    expect(plist).toContain("<key>RunAtLoad</key>\n  <true/>")
    expect(plist).not.toContain("KeepAlive")
    expect(plist).toContain("<string>/Users/kai/kndl &amp; co/logs/update.log</string>")
  })
})
