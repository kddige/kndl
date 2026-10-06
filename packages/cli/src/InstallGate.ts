// One `kndl` CLI, two ways to have it (issue #178): an install's, run from its checkout by
// the command install.sh writes, and a binary installed from a Hub (BuildInfo.ts). The commands
// that set up and run a Hub or a Runner (onboard, update, status, logs, doctor, the services...)
// run Bun on the install's checkout, so a binary from a Hub doesn't run them: it says they need a
// kndl install, and how to get one, or which command runs them when there is one.
import { readFileSync } from "node:fs"
import { Effect } from "effect"
import { InstallLine } from "./Actions.ts"
import { build } from "./BuildInfo.ts"
import { fail } from "./Failure.ts"
import { isInstalled, isOurWrapper } from "./Host.ts"
import { type Layout, isWrapperFor, resolveLayout, shellQuote } from "./Layout.ts"

/** What a binary from a Hub says to `kndl <command>`, given what this machine has. */
export function needsInstallMessage(
  command: string,
  layout: Layout,
  machine: {
    /** Whether the home holds an installed checkout. */
    readonly installed: boolean
    /** Whether the command install.sh writes is in its place, for this home. */
    readonly wrapper: boolean
  },
): string {
  const notHere = "This kndl, installed from a Hub, doesn't set up or run a Hub or a Runner itself."
  if (!machine.installed) {
    return [
      `\`kndl ${command}\` needs a kndl install, and there is none in ${layout.home.dir}.`,
      `${notHere} To make this machine one, install kndl with:`,
      "",
      `  ${InstallLine}`,
      "",
      "or set KNDL_HOME to the home you installed.",
    ].join("\n")
  }
  const installs = machine.wrapper ? shellQuote(layout.wrapper) : `bun ${shellQuote(layout.cli)}`
  return [
    `\`kndl ${command}\` runs on the kndl install in ${layout.home.dir}, with its own command. ${notHere} Run:`,
    "",
    `  ${installs} ${command}`,
  ].join("\n")
}

/**
 * Before an operator command: fails in a binary the Hub built, which can't run it. A CLI run from
 * a checkout goes on, and the command checks what it needs itself.
 */
export const requireCheckoutCli = (command: string) =>
  Effect.suspend(() => {
    if (build === undefined) return Effect.void
    const layout = resolveLayout()
    const wrapper =
      isOurWrapper(layout.wrapper) && isWrapperFor(readFileSync(layout.wrapper, "utf8"), layout)
    return Effect.fail(
      fail(needsInstallMessage(command, layout, { installed: isInstalled(layout), wrapper })),
    )
  })
