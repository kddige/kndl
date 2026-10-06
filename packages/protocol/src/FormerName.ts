// The name kndl had until #196 (ADR 0017), and what an install made under it is called. Only the
// one-time move of such an install reads these: the CLI's `update`, and a Hub or Runner that a
// service written under the former name starts (packages/cli/src/Rename.ts). Once an install has
// moved, nothing on it carries the former name, so nothing else may read it.
//
// Imported as `@kndl/protocol/former-name`, not from the package's index: it runs the CLI, which
// the web UI and the mod's bundle have no use for.
import { join, resolve } from "node:path"
import { thisCheckout } from "./Checkout.ts"

const name = "claude-hub"
const variable = (rest: string) => `${name.toUpperCase().replace("-", "_")}_${rest}`

export const FormerName = {
  name,
  /** The default home: `~/<home>`. */
  home: `.${name}`,
  /** Named a home other than the default one. */
  homeVariable: variable("HOME"),
  /** Started every variable of the former name's own, in `hub.env`, `runner.env` and services. */
  variablePrefix: variable(""),
  /** Set by a service written under the former name to the role it runs. */
  serviceVariable: variable("SERVICE"),
  /** Set by a Runner of the former name on the Runner it starts only to check it loads. */
  loadCheckVariable: variable("RUNNER_LOAD_CHECK"),
  /** The launchd label of a role's service. */
  launchdLabel: (role: string) => `io.github.kddige.${name}.${role}`,
  /** The systemd user unit of a role's service. */
  systemdUnit: (role: string) => `${name}-${role}.service`,
  /** The tmux server of an installed home's Runner, on the host before ADR 0013. */
  tmuxSocket: name,
  /** The command, in `~/.local/bin`: the install's wrapper, or the binary a Hub serves. */
  command: name,
  /** The line after the shebang of the wrapper install.sh wrote. */
  wrapperMark: `# ${name}: written by install.sh.`,
  /** The CLI's own directory in `${XDG_CONFIG_HOME:-~/.config}`. */
  configDir: name,
  /** What a Runner's Sandboxes, volumes and snapshot groups were named under. */
  sandboxPrefix: `${name}-`,
  /** The label carrying the mark of the Runner that made a Sandbox or volume. */
  runnerLabel: `${name}.runner`,
  /** The header a CLI of the former name reads the commit of the binary a Hub serves from. */
  cliCommitHeader: `x-${name}-commit`,
} as const

/**
 * Where an install made under the former name is: the home {@link FormerName.homeVariable} names,
 * as the former name's command and services set it, or else `~/.claude-hub`.
 */
export function formerHomeDir(env: Record<string, string | undefined>, userHome: string): string {
  return resolve(env[FormerName.homeVariable] || join(userHome, FormerName.home))
}

/**
 * The role a service written under the former name started this process as, if one did: its
 * service file sets {@link FormerName.serviceVariable}, and not `KNDL_SERVICE`, which the
 * services written since set.
 */
export function formerServiceRole(
  env: Record<string, string | undefined>,
): "hub" | "runner" | undefined {
  if (env.KNDL_SERVICE !== undefined) return undefined
  const role = env[FormerName.serviceVariable]
  return role === "hub" || role === "runner" ? role : undefined
}

/** The CLI's entry point that moves an install from the former name. */
export const renameEntryPoint = join(thisCheckout, "packages", "cli", "src", "renameMain.ts")

/**
 * For a Hub or Runner a service of the former name started, as on the commit the first update
 * moved it to: instead of starting, it moves the install to kndl's names with the CLI's move,
 * which registers the services again under them and stops this one. It never returns: it exits
 * with the move's exit code, and a failure is tried again when the old service restarts it.
 */
export function moveFromFormerService(role: "hub" | "runner"): never {
  console.log(
    `${name} is now kndl: this ${role === "hub" ? "Hub" : "Runner"} was started by a ${name} service, so it moves the install to kndl's names first.`,
  )
  const moved = Bun.spawnSync([process.execPath, renameEntryPoint, "--service", role], {
    stdio: ["ignore", "inherit", "inherit"],
    env: process.env,
  })
  process.exit(moved.exitCode ?? 1)
}
