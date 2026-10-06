import { describe, expect, test } from "bun:test"
import { type HostFacts, MicrosandboxInstaller, prerequisitePlan } from "./Prerequisites.ts"
import { describeStep } from "./Shell.ts"

const everything = { git: true, gh: true, curl: true }

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
  kvm: { device: true, accessible: true },
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

  test("macOS: installs with Homebrew, without sudo", () => {
    const facts = { ...mac, tools: { ...everything, git: false, gh: false } }

    expect(commands(facts, ["runner"])).toEqual(["brew install git gh"])
    expect(prerequisitePlan(facts, ["runner"]).needsSudo).toBe(false)
  })

  test("apt: refreshes the lists, then installs, with sudo", () => {
    const facts = { ...linux, tools: { ...everything, gh: false } }

    expect(commands(facts, ["runner"])).toEqual([
      "sudo apt-get update",
      "sudo apt-get install -y gh",
    ])
    expect(prerequisitePlan(facts, ["runner"]).needsSudo).toBe(true)
  })

  test("dnf: installs with sudo", () => {
    const facts: HostFacts = {
      ...linux,
      packageManager: "dnf",
      tools: { ...everything, git: false, gh: false },
    }

    expect(commands(facts, ["runner"])).toEqual(["sudo dnf install -y git gh"])
  })

  test("as root, runs without sudo", () => {
    const facts = { ...linux, root: true, tools: { ...everything, gh: false } }

    expect(commands(facts, ["runner"])).toEqual(["apt-get update", "apt-get install -y gh"])
    expect(prerequisitePlan(facts, ["runner"]).needsSudo).toBe(false)
  })

  test("a Hub needs no microsandbox", () => {
    const facts = { ...linux, microsandbox: false }

    expect(prerequisitePlan(facts, ["hub"]).steps).toEqual([])
  })

  test("a Runner without microsandbox gets microsandbox's own installer", () => {
    const facts = { ...mac, microsandbox: false }

    expect(commands(facts, ["runner"])).toEqual([`sh -c '${MicrosandboxInstaller}'`])
  })

  test("microsandbox's installer brings curl along when it's missing", () => {
    const facts = { ...linux, microsandbox: false, tools: { ...everything, curl: false } }

    expect(commands(facts, ["runner"])).toEqual([
      "sudo apt-get update",
      "sudo apt-get install -y curl",
      `sh -c '${MicrosandboxInstaller}'`,
    ])
  })

  test("Linux: adds the user to the kvm group when /dev/kvm is closed to them", () => {
    const facts = { ...linux, kvm: { device: true, accessible: false } }
    const plan = prerequisitePlan(facts, ["runner"])

    expect(commands(facts, ["runner"])).toEqual(["sudo usermod -aG kvm ada"])
    expect(plan.afterwards[0]).toContain("Reboot")
  })

  test("Linux: no /dev/kvm can't be fixed, only reported", () => {
    const facts = { ...linux, kvm: { device: false, accessible: false } }
    const plan = prerequisitePlan(facts, ["runner"])

    expect(plan.steps).toEqual([])
    expect(plan.missing).toMatchObject([{ name: "KVM", fixable: false }])
  })

  test("an Intel Mac can't run a Runner", () => {
    const plan = prerequisitePlan({ ...mac, arch: "x64" }, ["runner"])

    expect(plan.missing).toMatchObject([{ name: "Apple Silicon", fixable: false }])
  })

  test("no package manager: what's missing is reported, not installed", () => {
    const facts = { ...linux, packageManager: undefined, tools: { ...everything, gh: false } }
    const plan = prerequisitePlan(facts, ["hub"])

    expect(plan.steps).toEqual([])
    expect(plan.missing).toMatchObject([{ name: "gh", fixable: false }])
  })

  test("every Step is a system Step, which a dry run only prints", () => {
    const facts: HostFacts = {
      ...linux,
      microsandbox: false,
      tools: { git: false, gh: false, curl: false },
      kvm: { device: true, accessible: false },
    }

    expect(prerequisitePlan(facts, ["runner"]).steps.every((s) => s.system === true)).toBe(true)
  })
})
