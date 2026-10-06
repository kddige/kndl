// The move of an install from kndl's former name, in throwaway homes laid out the old way. Nothing
// here runs a command or touches a service: Shell, and starting the new services, are stand-ins.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runnerMark } from "@kndl/runner/src/sandbox/Naming.ts"
import { Effect } from "effect"
import { writeWrapper } from "./Host.ts"
import type { Layout, Role } from "./Layout.ts"
import {
  cliProcesses,
  formerRunnerMark,
  type MoveEdges,
  moveFormerCliConfig,
  moveFromFormerName,
  type MoveSetting,
  planMove,
  renameEnvText,
  renameFormerBinary,
  sightHome,
} from "./Rename.ts"
import type { Platform } from "./Services.ts"
import { Shell, type Step, type StepResult } from "./Shell.ts"
import { scriptedUi, Ui } from "./Ui.ts"

let scratch: string
let userHome: string
let former: string
let moved: string

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "kndl-rename-"))
  userHome = join(scratch, "user")
  former = join(userHome, ".claude-hub")
  moved = join(userHome, ".kndl")
  mkdirSync(userHome, { recursive: true })
})

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true })
})

const settingFor = (
  platform: Platform,
  env: Record<string, string | undefined> = {},
): MoveSetting => ({
  userHome,
  env,
  platform,
  uid: 501,
  configHome: join(userHome, ".config"),
})

const write = (path: string, text: string) => {
  mkdirSync(join(path, ".."), { recursive: true })
  writeFileSync(path, text)
}

const FormerWrapper = (home: string) =>
  [
    "#!/bin/sh",
    "# claude-hub: written by install.sh. Runs the CLI from the installed checkout.",
    `: "\${CLAUDE_HUB_HOME:=${home}}"`,
    "export CLAUDE_HUB_HOME",
    'exec /usr/local/bin/bun "$CLAUDE_HUB_HOME/app/packages/cli/src/main.ts" "$@"',
    "",
  ].join("\n")

/** A home of the former name with a Hub and a Runner, their services and the command. */
function layOutFormerInstall(home: string, platform: Platform) {
  mkdirSync(join(home, "app", ".git"), { recursive: true })
  write(
    join(home, "hub.env"),
    [
      "# Written by claude-hub onboard.",
      "PORT=7777",
      `HUB_DATABASE=${home}/hub.db`,
      "CLAUDE_HUB_DEV_LOGIN=1",
      "HUB_SECRETS_KEY='not a real key'",
      "",
    ].join("\n"),
  )
  write(
    join(home, "runner.env"),
    ["HUB_URL=http://127.0.0.1:7777", "RUNNER_TOKEN=chr_not_a_real_token", ""].join("\n"),
  )
  write(join(home, "hub.db"), "")
  write(join(home, "sessions", "s-1", "workspace", "README.md"), "a Session's work\n")
  write(join(home, "logs", "hub.log"), "")
  for (const role of ["hub", "runner"] as const) {
    write(
      platform === "darwin"
        ? join(userHome, "Library", "LaunchAgents", `io.github.kddige.claude-hub.${role}.plist`)
        : join(userHome, ".config", "systemd", "user", `claude-hub-${role}.service`),
      `the former ${role} service\n`,
    )
  }
  write(join(userHome, ".local", "bin", "claude-hub"), FormerWrapper(home))
}

/** A Shell that runs nothing, recording what it was asked to, in order. */
function recordingShell(answer: (s: Step) => StepResult = () => ok("")) {
  const steps: Array<Step> = []
  const shell = Shell.of({
    dryRun: false,
    capture: (s) =>
      Effect.sync(() => {
        steps.push(s)
        return answer(s)
      }),
    attached: (s) =>
      Effect.sync(() => {
        steps.push(s)
        return answer(s).exitCode
      }),
  })
  return { shell, steps }
}

const ok = (stdout: string): StepResult => ({ exitCode: 0, stdout, stderr: "" })

const FakeBun = "/fake/bun"

/** Edges that start nothing: services started are recorded, the command is written for real. */
function standInEdges() {
  const started: Array<{ readonly home: string; readonly role: Role }> = []
  const edges: MoveEdges = {
    installService: (layout: Layout, role: Role) =>
      Effect.sync(() => void started.push({ home: layout.home.dir, role })),
    writeWrapper,
    bun: FakeBun,
    lock: join(scratch, "move"),
  }
  return { edges, started }
}

const run = (setting: MoveSetting, edges: MoveEdges, shell: Shell["Service"], service?: Role) => {
  const { ui, transcript } = scriptedUi([], { interactive: false })
  return Effect.runPromise(
    moveFromFormerName(setting, edges, { service }).pipe(
      Effect.provideService(Shell, shell),
      Effect.provideService(Ui, ui),
    ),
  ).then((outcome) => ({ outcome, transcript }))
}

const describeSteps = (steps: ReadonlyArray<Step>) =>
  steps.map((s) => [s.command, ...s.args].join(" "))

describe("planMove", () => {
  const sighting = {
    from: "/u/.claude-hub",
    to: "/u/.kndl",
    fromIsHome: true,
    toUsed: false,
    leftovers: true,
  }

  test("moves a former home to a free place", () => {
    expect(planMove(sighting)).toEqual({ _tag: "Move", from: "/u/.claude-hub", to: "/u/.kndl" })
  })

  test("leaves both homes alone when the new one is in use", () => {
    expect(planMove({ ...sighting, toUsed: true })._tag).toBe("Conflict")
  })

  test("renames in place a home that stays where it is, or has moved already", () => {
    expect(planMove({ ...sighting, to: sighting.from })).toEqual({
      _tag: "InPlace",
      home: "/u/.claude-hub",
    })
    expect(planMove({ ...sighting, fromIsHome: false })).toEqual({
      _tag: "InPlace",
      home: "/u/.kndl",
    })
  })

  test("does nothing once nothing is left of the former name", () => {
    expect(planMove({ ...sighting, fromIsHome: false, leftovers: false })).toEqual({
      _tag: "Nothing",
    })
    expect(planMove({ ...sighting, to: sighting.from, leftovers: false })._tag).toBe("Nothing")
  })
})

describe("sightHome", () => {
  test("finds the default former home, bound for ~/.kndl", () => {
    layOutFormerInstall(former, "darwin")
    expect(sightHome(settingFor("darwin"))).toEqual({
      from: former,
      to: moved,
      fromIsHome: true,
      toUsed: false,
      leftovers: true,
    })
  })

  test("keeps a home the former variable named somewhere of its own where it is", () => {
    const custom = join(scratch, "srv", "claude-hub")
    layOutFormerInstall(custom, "linux")
    const sighting = sightHome(settingFor("linux", { CLAUDE_HUB_HOME: custom }))
    expect(sighting.to).toBe(custom)
    expect(planMove(sighting)).toEqual({ _tag: "InPlace", home: custom })
  })

  test("moves to the home KNDL_HOME names", () => {
    layOutFormerInstall(former, "darwin")
    const elsewhere = join(scratch, "elsewhere")
    expect(planMove(sightHome(settingFor("darwin", { KNDL_HOME: elsewhere })))).toEqual({
      _tag: "Move",
      from: former,
      to: elsewhere,
    })
  })

  test("finds nothing on a machine without the former name", () => {
    expect(planMove(sightHome(settingFor("darwin")))).toEqual({ _tag: "Nothing" })
  })
})

describe("renameEnvText", () => {
  test("renames the former variables and paths in the former home, and keeps every other line", () => {
    const text = [
      "# a comment, about claude-hub",
      "PORT=7777",
      "CLAUDE_HUB_DEV_LOGIN=1",
      "export CLAUDE_HUB_DEV_USER=ada",
      "HUB_DATABASE=/u/.claude-hub/hub.db",
      "RUNNER_SESSIONS_ROOT=/u/.claude-hub",
      "HUB_WEB_DIR=/u/.claude-hub-elsewhere/dist",
      "HUB_SECRETS_KEY='kept, quoted as it was'",
      "",
    ].join("\n")
    expect(renameEnvText(text, "/u/.claude-hub", "/u/.kndl")).toBe(
      [
        "# a comment, about claude-hub",
        "PORT=7777",
        "KNDL_DEV_LOGIN=1",
        "KNDL_DEV_USER=ada",
        "HUB_DATABASE=/u/.kndl/hub.db",
        "RUNNER_SESSIONS_ROOT=/u/.kndl",
        "HUB_WEB_DIR=/u/.claude-hub-elsewhere/dist",
        "HUB_SECRETS_KEY='kept, quoted as it was'",
        "",
      ].join("\n"),
    )
  })

  test("changes nothing in a file already renamed", () => {
    const text = "KNDL_DEV_LOGIN=1\nHUB_DATABASE=/u/.kndl/hub.db\n"
    expect(renameEnvText(text, "/u/.claude-hub", "/u/.kndl")).toBe(text)
  })
})

test("the former Runner's mark is the one its Sandboxes carry", () => {
  expect(formerRunnerMark({}, "/u/.claude-hub")).toBe(
    runnerMark({ tmuxSocket: "claude-hub", sessionsRoot: "/u/.claude-hub/sessions" }),
  )
  expect(
    formerRunnerMark(
      { RUNNER_TMUX_SOCKET: "mine", RUNNER_SESSIONS_ROOT: "/data/sessions" },
      "/u/.claude-hub",
    ),
  ).toBe(runnerMark({ tmuxSocket: "mine", sessionsRoot: "/data/sessions" }))
})

test("cliProcesses finds the former CLI of the home, but not this process", () => {
  const ps = [
    "  101 /usr/local/bin/bun /u/.claude-hub/app/packages/cli/src/main.ts update",
    "  102 /usr/local/bin/bun /u/.claude-hub/app/packages/hub/src/main.ts",
    "  103 /usr/local/bin/bun /u/.claude-hub/app/packages/cli/src/main.ts status",
    "  104 /usr/local/bin/bun /other/app/packages/cli/src/main.ts update",
    "",
  ].join("\n")
  expect(cliProcesses(ps, "/u/.claude-hub", 103)).toEqual([101])
})

describe("moveFromFormerName", () => {
  test("moves a former install to kndl's names, putting its Sessions to sleep first", async () => {
    layOutFormerInstall(former, "darwin")
    const { shell, steps } = recordingShell((s) =>
      s.command === FakeBun
        ? ok("claude-hub-s-1: stopped now; volumes: claude-hub-s-1.claude\n")
        : ok(""),
    )
    const { edges, started } = standInEdges()
    const { outcome, transcript } = await run(settingFor("darwin"), edges, shell)

    expect(outcome).toEqual({
      plan: { _tag: "Move", from: former, to: moved },
      home: moved,
      problems: [],
    })
    // The home moved, whole.
    expect(existsSync(former)).toBe(false)
    expect(readFileSync(join(moved, "sessions", "s-1", "workspace", "README.md"), "utf8")).toBe(
      "a Session's work\n",
    )
    expect(existsSync(join(moved, "app", ".git"))).toBe(true)
    // Its variables are kndl's, and its paths the new home's.
    const hubEnv = readFileSync(join(moved, "hub.env"), "utf8")
    expect(hubEnv).toContain("KNDL_DEV_LOGIN=1")
    expect(hubEnv).toContain(`HUB_DATABASE=${moved}/hub.db`)
    expect(hubEnv).toContain("# Written by claude-hub onboard.")
    expect(hubEnv).not.toContain("CLAUDE_HUB_")
    expect(statSync(join(moved, "hub.env")).mode & 0o777).toBe(0o600)
    expect(readFileSync(join(moved, "runner.env"), "utf8")).toBe(
      "HUB_URL=http://127.0.0.1:7777\nRUNNER_TOKEN=chr_not_a_real_token\n",
    )
    // The former services are gone, and the new ones started in the new home.
    const agents = join(userHome, "Library", "LaunchAgents")
    expect(existsSync(join(agents, "io.github.kddige.claude-hub.hub.plist"))).toBe(false)
    expect(existsSync(join(agents, "io.github.kddige.claude-hub.runner.plist"))).toBe(false)
    expect(started).toEqual([
      { home: moved, role: "hub" },
      { home: moved, role: "runner" },
    ])
    // The command is kndl.
    expect(existsSync(join(userHome, ".local", "bin", "claude-hub"))).toBe(false)
    const command = readFileSync(join(userHome, ".local", "bin", "kndl"), "utf8")
    expect(command).toContain(`: "\${KNDL_HOME:=${moved}}"`)

    const mark = runnerMark({ tmuxSocket: "claude-hub", sessionsRoot: join(former, "sessions") })
    expect(describeSteps(steps)).toEqual([
      "launchctl bootout gui/501/io.github.kddige.claude-hub.hub",
      "launchctl bootout gui/501/io.github.kddige.claude-hub.runner",
      "tmux -L claude-hub kill-server",
      `${FakeBun} --env-file=${former}/runner.env ${former}/app/packages/runner/src/stopFormerSandboxes.ts ${mark}`,
    ])
    // The Sandboxes were stopped from the former home, before it moved.
    expect(steps[3]?.cwd).toBe(former)
    expect(transcript.join("\n")).toContain(
      "claude-hub-s-1: stopped now; volumes: claude-hub-s-1.claude",
    )
  })

  test("does nothing the second time", async () => {
    layOutFormerInstall(former, "darwin")
    const { edges } = standInEdges()
    await run(settingFor("darwin"), edges, recordingShell().shell)
    const again = recordingShell()
    const { outcome } = await run(settingFor("darwin"), standInEdges().edges, again.shell)
    expect(outcome.plan).toEqual({ _tag: "Nothing" })
    expect(again.steps).toEqual([])
  })

  test("under a former service, stops that service last, after starting the new ones", async () => {
    layOutFormerInstall(former, "linux")
    const { shell, steps } = recordingShell()
    const { edges, started } = standInEdges()
    const { outcome } = await run(settingFor("linux"), edges, shell, "runner")
    expect(outcome.home).toBe(moved)
    expect(started.map((s) => s.role)).toEqual(["hub", "runner"])
    const units = join(userHome, ".config", "systemd", "user")
    expect(existsSync(join(units, "claude-hub-hub.service"))).toBe(false)
    expect(existsSync(join(units, "claude-hub-runner.service"))).toBe(false)
    const described = describeSteps(steps)
    expect(described[0]).toBe("systemctl --user disable --now claude-hub-hub.service")
    expect(described[1]).toBe("systemctl --user daemon-reload")
    expect(described.slice(-3)).toEqual([
      "systemctl --user disable claude-hub-runner.service",
      "systemctl --user daemon-reload",
      "systemctl --user stop claude-hub-runner.service",
    ])
  })

  test("finishes a move cut short after the home moved", async () => {
    layOutFormerInstall(former, "darwin")
    // As if the last move stopped right after moving the home.
    const { rename } = await import("node:fs/promises")
    await rename(former, moved)
    const { edges, started } = standInEdges()
    const { shell, steps } = recordingShell()
    const { outcome } = await run(settingFor("darwin"), edges, shell)
    expect(outcome.plan).toEqual({ _tag: "InPlace", home: moved })
    expect(readFileSync(join(moved, "hub.env"), "utf8")).toContain("KNDL_DEV_LOGIN=1")
    expect(started.map((s) => s.role)).toEqual(["hub", "runner"])
    // The former services go; the Sandboxes were stopped before the home moved, and stopping them
    // again from the moved home finds none of its mark.
    expect(describeSteps(steps).slice(0, 2)).toEqual([
      "launchctl bootout gui/501/io.github.kddige.claude-hub.hub",
      "launchctl bootout gui/501/io.github.kddige.claude-hub.runner",
    ])
    expect(steps[3]?.cwd).toBe(moved)
  })

  test("renames a home of its own in place, and says to rename the shell's variable", async () => {
    const custom = join(scratch, "srv", "claude-hub")
    layOutFormerInstall(custom, "linux")
    const { edges, started } = standInEdges()
    const { outcome, transcript } = await run(
      settingFor("linux", { CLAUDE_HUB_HOME: custom }),
      edges,
      recordingShell().shell,
    )
    expect(outcome.plan).toEqual({ _tag: "InPlace", home: custom })
    expect(readFileSync(join(custom, "hub.env"), "utf8")).toContain(`HUB_DATABASE=${custom}/hub.db`)
    expect(readFileSync(join(custom, "hub.env"), "utf8")).toContain("KNDL_DEV_LOGIN=1")
    expect(started).toEqual([
      { home: custom, role: "hub" },
      { home: custom, role: "runner" },
    ])
    expect(transcript.join("\n")).toContain(`set KNDL_HOME instead`)
  })

  test("leaves both homes alone when kndl's is in use", async () => {
    layOutFormerInstall(former, "darwin")
    write(join(moved, "hub.env"), "PORT=7777\n")
    const { shell, steps } = recordingShell()
    const { outcome, transcript } = await run(settingFor("darwin"), standInEdges().edges, shell)
    expect(outcome.plan._tag).toBe("Conflict")
    expect(steps).toEqual([])
    expect(existsSync(join(former, "hub.env"))).toBe(true)
    expect(transcript.join("\n")).toContain("in use")
  })

  test("goes on when the Sandboxes can't be listed, and says how to stop them", async () => {
    layOutFormerInstall(former, "darwin")
    const { shell } = recordingShell((s) =>
      s.command === FakeBun ? { exitCode: 1, stdout: "", stderr: "msb is missing" } : ok(""),
    )
    const { outcome, transcript } = await run(settingFor("darwin"), standInEdges().edges, shell)
    expect(outcome.home).toBe(moved)
    expect(transcript.join("\n")).toContain("Couldn't stop the Runner's Sandboxes")
  })

  test("reports a service that doesn't start, and still finishes", async () => {
    layOutFormerInstall(former, "darwin")
    const { edges } = standInEdges()
    const failing: MoveEdges = {
      ...edges,
      installService: (_layout, role) =>
        role === "runner" ? Effect.die(new Error("launchctl said no")) : Effect.void,
    }
    const { outcome } = await run(settingFor("darwin"), failing, recordingShell().shell)
    expect(outcome.home).toBe(moved)
    expect(outcome.problems).toEqual([
      "Couldn't start the Runner's service under kndl's name: launchctl said no",
    ])
  })

  test("changes nothing in a dry run", async () => {
    layOutFormerInstall(former, "darwin")
    const { shell, steps } = recordingShell()
    const { outcome } = await run(settingFor("darwin"), standInEdges().edges, {
      ...shell,
      dryRun: true,
    })
    expect(outcome).toEqual({
      plan: { _tag: "Move", from: former, to: moved },
      home: undefined,
      problems: [],
    })
    expect(steps).toEqual([])
    expect(existsSync(join(former, "hub.env"))).toBe(true)
    expect(existsSync(moved)).toBe(false)
  })
})

describe("a binary a Hub served under the former name", () => {
  test("moves its config to kndl's directory, unless kndl's is there already", async () => {
    write(
      join(userHome, ".config", "claude-hub", "cli.json"),
      '{"hub":"https://hub.example.com"}\n',
    )
    expect(await moveFormerCliConfig({}, userHome)).toBe(true)
    expect(readFileSync(join(userHome, ".config", "kndl", "cli.json"), "utf8")).toContain("hub")
    write(join(userHome, ".config", "claude-hub", "cli.json"), "{}\n")
    expect(await moveFormerCliConfig({}, userHome)).toBe(false)
    expect(existsSync(join(userHome, ".config", "claude-hub", "cli.json"))).toBe(true)
  })

  test("renames itself to kndl", async () => {
    const exe = join(userHome, ".local", "bin", "claude-hub")
    write(exe, "a binary")
    expect(await renameFormerBinary(exe)).toContain("Run it as kndl")
    expect(existsSync(exe)).toBe(false)
    expect(readFileSync(join(userHome, ".local", "bin", "kndl"), "utf8")).toBe("a binary")
    expect(await renameFormerBinary(join(userHome, ".local", "bin", "kndl"))).toBeUndefined()
  })
})
