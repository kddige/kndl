// What a Hub or Runner needs on its machine, and the plan that installs what's missing: the
// commands, per platform and package manager, that onboard and `doctor --fix` run after one
// confirmation. The plan is pure, built from facts Host.ts gathers, so it is tested without
// installing anything; running it is Shell's job.
import type { Role } from "./Layout.ts"
import type { Platform } from "./Services.ts"
import { type Step, step } from "./Shell.ts"

export type PackageManager = "brew" | "apt" | "dnf"

/** A command-line tool a package manager installs. */
export type Tool = "git" | "gh" | "curl"

/** What Host.ts found on this machine. */
export interface HostFacts {
  readonly platform: Platform
  /** `process.arch`: `arm64`, `x64`, … */
  readonly arch: string
  readonly root: boolean
  readonly user: string
  /** The first package manager found, in the order brew, apt, dnf. */
  readonly packageManager: PackageManager | undefined
  /** Which tools are on PATH. */
  readonly tools: Readonly<Record<Tool, boolean>>
  /** Whether Claude Code (`claude`) is on PATH. */
  readonly claude: boolean
  /** Whether Claude Code's config file names a signed-in account. */
  readonly claudeSignedIn: boolean
  /** A complete microsandbox runtime: the one in `~/.microsandbox`, or the app's bundled one. */
  readonly microsandbox: boolean
  /** Linux only: `/dev/kvm`, and whether this user can open it. */
  readonly kvm: { readonly device: boolean; readonly accessible: boolean } | undefined
}

/** A missing prerequisite, as doctor and onboard show it. */
export interface Missing {
  readonly name: string
  /** True when the plan installs it; false when a person has to. */
  readonly fixable: boolean
  readonly detail: string
}

export interface PrerequisitePlan {
  readonly missing: ReadonlyArray<Missing>
  /** What to run, in order. Empty when nothing is fixable. */
  readonly steps: ReadonlyArray<Step>
  /** Whether any Step runs with sudo: the one confirmation names it. */
  readonly needsSudo: boolean
  /** What to do after the steps, such as logging in again for a new group. */
  readonly afterwards: ReadonlyArray<string>
}

/**
 * The tools a Hub and a Runner need: gh is how claude-hub itself is installed and updated. A
 * Runner's Sessions run in their Sandboxes, which bring their own tmux (ADR 0013).
 */
const Tools: ReadonlyArray<Tool> = ["git", "gh"]

/** microsandbox's own installer, for when no runtime is found. */
export const MicrosandboxInstaller = "curl -fsSL https://install.microsandbox.dev | sh"

/** What's missing for `roles` on this machine, and the plan that installs what it can. */
export function prerequisitePlan(facts: HostFacts, roles: ReadonlyArray<Role>): PrerequisitePlan {
  const runner = roles.includes("runner")
  const missing: Array<Missing> = []
  const steps: Array<Step> = []
  const afterwards: Array<string> = []

  const tools = Tools.filter((tool) => !facts.tools[tool])
  const installer = runner && !facts.microsandbox
  if (installer && !facts.tools.curl) tools.push("curl")
  if (tools.length > 0) {
    const manager = facts.packageManager
    for (const tool of tools) {
      missing.push({
        name: tool,
        fixable: manager !== undefined,
        detail:
          manager === undefined
            ? `${tool} isn't installed, and no package manager claude-hub knows (${facts.platform === "darwin" ? "Homebrew" : "apt or dnf"}) was found: install it yourself.`
            : `${tool} isn't installed.`,
      })
    }
    if (manager !== undefined) steps.push(...packageSteps(manager, tools))
  }

  if (runner && facts.platform === "darwin" && facts.arch !== "arm64") {
    missing.push({
      name: "Apple Silicon",
      fixable: false,
      detail:
        "A Runner on a Mac needs Apple Silicon: microsandbox's microVMs don't run on Intel Macs.",
    })
  }

  if (installer) {
    missing.push({
      name: "microsandbox",
      fixable: true,
      detail: "No microsandbox runtime was found.",
    })
    steps.push(
      step("sh", ["-c", MicrosandboxInstaller], {
        system: true,
        why: "install microsandbox's runtime (msb and libkrunfw)",
      }),
    )
  }

  if (runner && facts.platform === "linux" && facts.kvm !== undefined && !facts.kvm.accessible) {
    if (!facts.kvm.device) {
      missing.push({
        name: "KVM",
        fixable: false,
        detail:
          "There is no /dev/kvm: turn on virtualization (VT-x or AMD-V) in the firmware, or, in a VM, nested virtualization.",
      })
    } else {
      missing.push({
        name: "KVM access",
        fixable: true,
        detail: `${facts.user} can't open /dev/kvm.`,
      })
      steps.push(
        step("usermod", ["-aG", "kvm", facts.user], {
          sudo: true,
          system: true,
          why: `let ${facts.user} use /dev/kvm`,
        }),
      )
      afterwards.push(
        // A user's systemd manager keeps the groups it started with, and lingering keeps it
        // running across logins: only a reboot gives the Runner's service the new group.
        `Reboot so ${facts.user}'s new kvm group reaches the Runner's service (logging out isn't enough while the services linger), then run \`claude-hub doctor\`.`,
      )
    }
  }

  if (runner && !facts.claude) {
    missing.push({
      name: "Claude Code",
      fixable: false,
      detail:
        "Claude Code isn't installed: install it (https://docs.anthropic.com/en/docs/claude-code), then run `claude` and sign in.",
    })
  } else if (runner && !facts.claudeSignedIn) {
    missing.push({
      name: "Claude Code sign-in",
      fixable: false,
      detail: "No Claude account is signed in: run `claude` and sign in, as this user.",
    })
  }

  const neededSudo = steps.some((s) => s.sudo === true) && !facts.root
  return { missing, steps, needsSudo: neededSudo, afterwards }
}

/** Installs `tools` with the package manager: Homebrew as the user, apt and dnf with sudo. */
export function packageSteps(
  manager: PackageManager,
  tools: ReadonlyArray<Tool>,
): ReadonlyArray<Step> {
  const why = `install ${tools.join(", ")}`
  switch (manager) {
    case "brew":
      return [step("brew", ["install", ...tools], { system: true, why })]
    case "apt":
      return [
        step("apt-get", ["update"], {
          sudo: true,
          system: true,
          why: "refresh apt's package lists",
        }),
        step("apt-get", ["install", "-y", ...tools], { sudo: true, system: true, why }),
      ]
    case "dnf":
      return [step("dnf", ["install", "-y", ...tools], { sudo: true, system: true, why })]
  }
}
