import { describe, expect, test } from "bun:test"
import {
  type AppFacts,
  checkAppPermissions,
  type InstallationFacts,
  manifestPermissions,
} from "@kndl/hub/src/AppPermissions.ts"
import { type DoctorFacts, diagnose, formatChecks } from "./Doctor.ts"

const healthy: DoctorFacts = {
  home: "/home/ada/.kndl",
  installed: true,
  wrapper: { path: "/home/ada/.local/bin/kndl", exists: true, current: true, onPath: true },
  roles: ["hub", "runner"],
  oldData: undefined,
  prerequisites: { missing: [], steps: [], needsSudo: false, afterwards: [] },
  envFiles: [
    { role: "hub", path: "/home/ada/.kndl/hub.env", mode: 0o100600 },
    { role: "runner", path: "/home/ada/.kndl/runner.env", mode: 0o100600 },
  ],
  hubConfigError: undefined,
  githubApp: undefined,
  runnerConfigError: undefined,
  services: [
    { role: "hub", state: { _tag: "Running", pid: 1 } },
    { role: "runner", state: { _tag: "Running", pid: 2 } },
  ],
  modBuilt: true,
  webBuilt: true,
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
          { name: "git", detail: "git isn't installed.", fixable: true },
          { name: "KVM", detail: "There is no /dev/kvm.", fixable: false },
        ],
        steps: [],
        needsSudo: false,
        afterwards: [],
      },
    }

    expect(failing(facts)).toMatchObject([
      { name: "Prerequisites", fix: { _tag: "InstallPrerequisites" } },
      { name: "KVM", status: "fail" },
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
      "kndl onboard",
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

  test("old data in the home warns, and --fix offers to move it aside", () => {
    const facts: DoctorFacts = {
      ...healthy,
      roles: ["hub"],
      envFiles: healthy.envFiles.filter((file) => file.role === "hub"),
      services: healthy.services.filter((service) => service.role === "hub"),
      runnerReachesHub: undefined,
      oldData: { entries: ["sessions", "claude-code"] },
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

const check = (facts: DoctorFacts) => diagnose(facts).find((c) => c.name === "GitHub App")

describe("doctor and the GitHub App", () => {
  const app: AppFacts = {
    slug: "kndl-mac",
    htmlUrl: "https://github.com/apps/kndl-mac",
    owner: { login: "ada", type: "User" },
    permissions: manifestPermissions(),
    events: [],
  }
  const installation: InstallationFacts = {
    id: 7,
    account: "ada",
    htmlUrl: "https://github.com/settings/installations/7",
    permissions: manifestPermissions(),
    events: [],
    suspended: false,
    organization: false,
  }
  const withApp = (
    app_: AppFacts,
    installations: ReadonlyArray<InstallationFacts> = [installation],
  ): DoctorFacts => ({
    ...healthy,
    githubApp: { _tag: "Checked", check: checkAppPermissions(app_, installations, 0) },
  })

  test("an App with every permission, installed, passes", () => {
    expect(check(withApp(app))).toEqual({
      name: "GitHub App",
      status: "ok",
      detail: "kndl-mac and its installation have the permissions the Hub needs",
    })
  })

  test("a permission the App lacks fails, linking to its settings; there's no fix", () => {
    const { issues: _, ...lacking } = manifestPermissions()
    const found = check(
      withApp({ ...app, permissions: lacking }, [{ ...installation, permissions: lacking }]),
    )

    expect(found?.status).toBe("fail")
    expect(found?.fix).toBeUndefined()
    expect(found?.detail).toContain(
      "The App kndl-mac lacks Issues: read and write. Add it at https://github.com/settings/apps/kndl-mac/permissions",
    )
    expect(found?.detail).toContain(
      "Its installation on ada lacks Issues: read and write. Once the App has it, accept it at https://github.com/settings/installations/7/permissions/update",
    )
  })

  test("an installation that hasn't accepted the App's new permissions fails, linking to its review", () => {
    const found = check(
      withApp(app, [
        { ...installation, permissions: { ...manifestPermissions(), issues: "read" } },
      ]),
    )

    expect(found?.status).toBe("fail")
    expect(found?.detail).toStartWith(
      "Its installation on ada lacks Issues: read and write. Accept it at https://github.com/settings/installations/7/permissions/update",
    )
  })

  test("an App installed nowhere warns, linking to its install page", () => {
    expect(check(withApp(app, []))).toMatchObject({
      status: "warn",
      detail: expect.stringContaining("https://github.com/apps/kndl-mac/installations/new"),
    })
  })

  test("GitHub not answering warns, and doesn't fail doctor", () => {
    expect(
      check({ ...healthy, githubApp: { _tag: "Unchecked", detail: "GitHub answered 401" } }),
    ).toMatchObject({
      status: "warn",
      detail: "Couldn't check its permissions: GitHub answered 401",
    })
  })

  test("no App, or no Hub here: no check", () => {
    expect(check(healthy)).toBeUndefined()
  })

  test("GitHub sign-in without an App fails: nobody signed in with GitHub sees a Session", () => {
    const found = check({ ...healthy, githubApp: { _tag: "SignInWithoutApp" } })

    expect(found?.status).toBe("fail")
    expect(found?.fix).toBeUndefined()
    expect(found?.detail).toContain("nobody signed in with GitHub can see any Session")
    expect(found?.detail).toContain("kndl onboard --github-app create")
    expect(found?.detail).toContain("kndl onboard --github-app manual")
  })

  test("doctor prints a detail's lines under each other", () => {
    expect(
      formatChecks([
        { name: "Install", status: "ok", detail: "/home/ada/.kndl/app" },
        { name: "GitHub App", status: "fail", detail: "The App lacks one.\nIts installation too." },
      ]),
    ).toEqual([
      "ok  Install     /home/ada/.kndl/app",
      "XX  GitHub App  The App lacks one.",
      "                Its installation too.",
    ])
  })
})
