import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { InstallLine } from "./Actions.ts"
import { needsInstallMessage, requireCheckoutCli } from "./InstallGate.ts"
import { resolveLayout } from "./Layout.ts"

const layout = resolveLayout({}, "/home/ada")

describe("an operator command in a binary installed from a Hub", () => {
  test("says how to run it: install kndl, or run the install's own command, or its CLI with Bun", () => {
    const none = needsInstallMessage("hub start", layout, { installed: false, wrapper: false })
    expect(none).toContain("needs a kndl install, and there is none in /home/ada/.kndl.")
    expect(none).toContain(`\n  ${InstallLine}\n`)
    expect(none).toContain("or set KNDL_HOME to the home you installed.")

    expect(needsInstallMessage("status", layout, { installed: true, wrapper: true })).toContain(
      "\n\n  /home/ada/.local/bin/kndl status",
    )
    // An install whose command is gone.
    expect(needsInstallMessage("doctor", layout, { installed: true, wrapper: false })).toContain(
      "\n\n  bun /home/ada/.kndl/app/packages/cli/src/main.ts doctor",
    )
  })

  test("goes on run from a checkout, where the command checks what it needs itself", async () => {
    // Tests run from the checkout, with no build compiled in.
    expect(await Effect.runPromise(requireCheckoutCli("status"))).toBeUndefined()
  })
})
