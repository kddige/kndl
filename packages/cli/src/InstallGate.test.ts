import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { InstallLine } from "./Actions.ts"
import { needsInstallMessage, requireCheckoutCli } from "./InstallGate.ts"
import { resolveLayout } from "./Layout.ts"

const layout = resolveLayout({}, "/home/ada")

describe("an operator command in a binary installed from a Hub", () => {
  test("with no install here, says it needs one, and how to get it", () => {
    expect(needsInstallMessage("hub start", layout, { installed: false, wrapper: false })).toBe(
      [
        "`claude-hub hub start` needs a claude-hub install, and there is none in /home/ada/.claude-hub.",
        "This claude-hub, installed from a Hub, doesn't set up or run a Hub or a Runner itself. To make this machine one, install claude-hub with:",
        "",
        `  ${InstallLine}`,
        "",
        "or set CLAUDE_HUB_HOME to the home you installed.",
      ].join("\n"),
    )
  })

  test("with an install here, says to run the install's own command", () => {
    expect(needsInstallMessage("status", layout, { installed: true, wrapper: true })).toBe(
      [
        "`claude-hub status` runs on the claude-hub install in /home/ada/.claude-hub, with its own command. This claude-hub, installed from a Hub, doesn't set up or run a Hub or a Runner itself. Run:",
        "",
        "  /home/ada/.local/bin/claude-hub status",
      ].join("\n"),
    )
  })

  test("with an install whose command is gone, says to run its CLI with Bun", () => {
    expect(needsInstallMessage("doctor", layout, { installed: true, wrapper: false })).toContain(
      "\n\n  bun /home/ada/.claude-hub/app/packages/cli/src/main.ts doctor",
    )
  })

  test("goes on run from a checkout, where the command checks what it needs itself", async () => {
    // Tests run from the checkout, with no build compiled in.
    expect(await Effect.runPromise(requireCheckoutCli("status"))).toBeUndefined()
  })
})
