import { describe, expect, test } from "bun:test"
import { type DoctorFacts, diagnose } from "./Doctor.ts"

const healthy: DoctorFacts = {
  home: "/home/ada/.claude-hub",
  installed: true,
  wrapper: { path: "/home/ada/.local/bin/claude-hub", exists: true, current: true, onPath: true },
  roles: ["hub", "runner"],
  oldData: undefined,
  prerequisites: { missing: [], steps: [], needsSudo: false, afterwards: [] },
  envFiles: [
    { role: "hub", path: "/home/ada/.claude-hub/hub.env", mode: 0o100600 },
    { role: "runner", path: "/home/ada/.claude-hub/runner.env", mode: 0o100600 },
  ],
  hubConfigError: undefined,
  runnerConfigError: undefined,
  services: [
    { role: "hub", state: { _tag: "Running", pid: 1 } },
    { role: "runner", state: { _tag: "Running", pid: 2 } },
  ],
  modBuilt: true,
  webBuilt: true,
  trust: "trusted",
  cookieWarning: undefined,
  hubHealth: { url: "http://127.0.0.1:7777", ok: true, detail: "" },
  runnerReachesHub: { url: "http://127.0.0.1:7777", ok: true, detail: "" },
  linger: undefined,
}

const failing = (facts: DoctorFacts) => diagnose(facts).filter((c) => c.status !== "ok")

describe("doctor", () => {
  test("a healthy install passes every check", () => {
    expect(failing(healthy)).toEqual([])
  })

  test("no install: one check, saying how to get one", () => {
    const checks = diagnose({ ...healthy, installed: false })

    expect(checks).toHaveLength(1)
    expect(checks[0]).toMatchObject({ name: "Install", status: "fail" })
  })

  test("an env file others can read fails, and --fix restricts it", () => {
    const facts = {
      ...healthy,
      envFiles: [{ role: "hub" as const, path: "/h/hub.env", mode: 0o100644 }],
    }

    expect(failing(facts)).toMatchObject([
      { name: "hub.env", status: "fail", fix: { _tag: "RestrictEnvFile", path: "/h/hub.env" } },
    ])
    expect(failing(facts)[0]?.detail).toContain("mode 644")
  })

  test("missing prerequisites: --fix installs what it can, the rest is reported", () => {
    const facts: DoctorFacts = {
      ...healthy,
      prerequisites: {
        missing: [
          { name: "tmux", detail: "tmux is missing.", fixable: true },
          { name: "Claude Code", detail: "Install Claude Code.", fixable: false },
        ],
        steps: [],
        needsSudo: false,
        afterwards: [],
      },
    }

    expect(failing(facts)).toMatchObject([
      { name: "Prerequisites", fix: { _tag: "InstallPrerequisites" } },
      { name: "Claude Code", status: "fail" },
    ])
    expect(failing(facts)[1]?.fix).toBeUndefined()
  })

  test("a service not installed, or stopped, has a fix", () => {
    const facts: DoctorFacts = {
      ...healthy,
      services: [
        { role: "hub", state: { _tag: "NotInstalled" } },
        { role: "runner", state: { _tag: "Stopped", detail: "exited 1" } },
      ],
    }

    expect(failing(facts)).toMatchObject([
      { name: "Hub service", fix: { _tag: "InstallService", role: "hub" } },
      { name: "Runner service", fix: { _tag: "StartService", role: "runner" } },
    ])
  })

  test("unbuilt UI and mod each have a fix", () => {
    expect(failing({ ...healthy, webBuilt: false, modBuilt: false })).toMatchObject([
      { name: "Web UI build", fix: { _tag: "BuildWeb" } },
      { name: "Mod build", fix: { _tag: "BuildMod" } },
    ])
  })

  test("a role's checks only run when it's set up", () => {
    const hubOnly: DoctorFacts = {
      ...healthy,
      roles: ["hub"],
      modBuilt: false,
      runnerConfigError: "RUNNER_TOKEN is missing",
    }

    expect(failing(hubOnly)).toEqual([])
  })

  test("a refused configuration fails, with the Hub's own reason", () => {
    expect(failing({ ...healthy, hubConfigError: "HUB_PUBLIC_URL is missing" })).toMatchObject([
      { name: "Hub configuration", status: "fail", detail: "HUB_PUBLIC_URL is missing" },
    ])
  })

  test("nothing set up yet points at onboard", () => {
    expect(failing({ ...healthy, roles: [], envFiles: [], services: [] })[0]?.detail).toContain(
      "claude-hub onboard",
    )
  })

  test("an unreachable Hub fails", () => {
    const facts = {
      ...healthy,
      runnerReachesHub: { url: "http://10.0.0.1:7777", ok: false, detail: "connection refused" },
    }

    expect(failing(facts)).toMatchObject([
      { name: "Hub from the Runner", detail: "http://10.0.0.1:7777/health: connection refused" },
    ])
  })

  test("Linux without linger warns, and --fix enables it", () => {
    expect(failing({ ...healthy, linger: false })).toMatchObject([
      { name: "Linger", status: "warn", fix: { _tag: "EnableLinger" } },
    ])
  })

  test("an untrusted sessions root warns, and --fix trusts it", () => {
    expect(failing({ ...healthy, trust: "untrusted" })).toMatchObject([
      { name: "Claude Code trust", status: "warn", fix: { _tag: "TrustSessionsRoot" } },
    ])
  })

  test("old data in the home warns, and --fix offers to move it aside", () => {
    const facts: DoctorFacts = {
      ...healthy,
      roles: ["hub"],
      envFiles: healthy.envFiles.filter((file) => file.role === "hub"),
      services: healthy.services.filter((service) => service.role === "hub"),
      runnerReachesHub: undefined,
      oldData: { entries: ["sessions", "claude-code"], tmuxSessions: 0 },
    }

    expect(failing(facts)).toMatchObject([
      {
        name: "Old data",
        status: "warn",
        fix: { _tag: "MoveOldData", entries: ["sessions", "claude-code"] },
      },
    ])
    expect(failing(facts)[0]?.detail).toContain("sessions, claude-code with no runner.env")
  })

  test("a wrapper that runs another home's CLI is rewritten", () => {
    const facts = { ...healthy, wrapper: { ...healthy.wrapper, current: false } }

    expect(failing(facts)).toMatchObject([{ fix: { _tag: "WriteWrapper" } }])
  })
})
