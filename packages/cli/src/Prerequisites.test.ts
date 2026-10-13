import { describe, expect, test } from "bun:test"
import { type HostFacts, MicrosandboxInstaller, prerequisitePlan } from "./Prerequisites.ts"
import { describeStep } from "./Shell.ts"

const everything = { git: true, curl: true }

const mac: HostFacts = {
  platform: "darwin",
  arch: "arm64",
  root: false,
  user: "ada",
  packageManager: "brew",
  tools: everything,
  microsandbox: true,
  kvm: undefined,
}

const linux: HostFacts = {
  ...mac,
  platform: "linux",
  arch: "x64",
  packageManager: "apt",
  kvm: { device: true, accessible: true, member: true },
}

const commands = (facts: HostFacts, roles: ReadonlyArray<"hub" | "runner">) =>
  prerequisitePlan(facts, roles).steps.map((s) => describeStep(s, facts.root))

describe("the prerequisite plan", () => {
  test("is empty when nothing is missing", () => {
    expect(prerequisitePlan(mac, ["hub", "runner"])).toEqual({
      missing: [],
      steps: [],
      needsSudo: false,
      afterwards: [],
    })
  })

  test("installs with the package manager there is, with sudo only where it's needed", () => {
    const cases: ReadonlyArray<[string, HostFacts, Array<string>, boolean]> = [
      ["macOS", { ...mac, tools: { ...everything, git: false } }, ["brew install git"], false],
      // apt refreshes the lists first.
      [
        "apt",
        { ...linux, tools: { ...everything, git: false } },
        ["sudo apt-get update", "sudo apt-get install -y git"],
        true,
      ],
      [
        "dnf",
        { ...linux, packageManager: "dnf", tools: { ...everything, git: false } },
        ["sudo dnf install -y git"],
        true,
      ],
      [
        "root",
        { ...linux, root: true, tools: { ...everything, git: false } },
        ["apt-get update", "apt-get install -y git"],
        false,
      ],
    ]
    for (const [name, facts, expected, needsSudo] of cases)
      expect({
        name,
        commands: commands(facts, ["runner"]),
        needsSudo: prerequisitePlan(facts, ["runner"]).needsSudo,
      }).toEqual({ name, commands: expected, needsSudo })
  })

  test("a Runner without microsandbox gets its own installer, and curl for it; a Hub needs none", () => {
    expect(prerequisitePlan({ ...linux, microsandbox: false }, ["hub"]).steps).toEqual([])
    expect(commands({ ...mac, microsandbox: false }, ["runner"])).toEqual([
      `sh -c '${MicrosandboxInstaller}'`,
    ])
    const noCurl = { ...linux, microsandbox: false, tools: { ...everything, curl: false } }
    expect(commands(noCurl, ["runner"])).toEqual([
      "sudo apt-get update",
      "sudo apt-get install -y curl",
      `sh -c '${MicrosandboxInstaller}'`,
    ])
  })

  test("Linux: adds the user to the kvm group when /dev/kvm is closed to them", () => {
    const facts = { ...linux, kvm: { device: true, accessible: false, member: false } }
    const plan = prerequisitePlan(facts, ["runner"])

    expect(commands(facts, ["runner"])).toEqual(["sudo usermod -aG kvm ada"])
    expect(plan.afterwards[0]).toContain("Reboot")
  })

  test("Linux: a user already in the kvm group, whose login predates it, is told to reboot", () => {
    const facts = { ...linux, kvm: { device: true, accessible: false, member: true } }
    const plan = prerequisitePlan(facts, ["runner"])

    expect(plan.steps).toEqual([])
    expect(plan.missing).toMatchObject([{ name: "KVM access", fixable: false }])
    expect(plan.missing[0]?.detail).toContain("reboot")
  })

  test("what can't be fixed is reported, not installed: no /dev/kvm, an Intel Mac, no package manager", () => {
    const noKvm = prerequisitePlan(
      { ...linux, kvm: { device: false, accessible: false, member: false } },
      ["runner"],
    )
    expect(noKvm.steps).toEqual([])
    expect(noKvm.missing).toMatchObject([{ name: "KVM", fixable: false }])

    const intel = prerequisitePlan({ ...mac, arch: "x64" }, ["runner"])
    expect(intel.missing).toMatchObject([{ name: "Apple Silicon", fixable: false }])

    const noManager = prerequisitePlan(
      { ...linux, packageManager: undefined, tools: { ...everything, git: false } },
      ["hub"],
    )
    expect(noManager.steps).toEqual([])
    expect(noManager.missing).toMatchObject([{ name: "git", fixable: false }])
  })

  test("every Step is a system Step, which a dry run only prints", () => {
    const facts: HostFacts = {
      ...linux,
      microsandbox: false,
      tools: { git: false, curl: false },
      kvm: { device: true, accessible: false, member: false },
    }

    expect(prerequisitePlan(facts, ["runner"]).steps.every((s) => s.system === true)).toBe(true)
  })
})
