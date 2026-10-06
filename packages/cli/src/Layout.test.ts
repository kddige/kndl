import { describe, expect, test } from "bun:test"
import { isWrapperFor, resolveLayout, shellQuote, wrapperScript } from "./Layout.ts"

describe("the installed home", () => {
  test("is ~/.kndl by default, never the dev home", () => {
    const layout = resolveLayout({}, "/Users/ada")

    expect(layout.home.dir).toBe("/Users/ada/.kndl")
    expect(layout.home.tmuxSocket).toBe("kndl")
    expect(layout.app).toBe("/Users/ada/.kndl/app")
    expect(layout.wrapper).toBe("/Users/ada/.local/bin/kndl")
  })

  test("is KNDL_HOME when set", () => {
    const layout = resolveLayout({ KNDL_HOME: "/srv/hub" }, "/Users/ada")

    expect(layout.home.dir).toBe("/srv/hub")
    expect(layout.envFile("runner")).toBe("/srv/hub/runner.env")
    expect(layout.logFile("hub")).toBe("/srv/hub/logs/hub.log")
    expect(layout.entryPoint("runner")).toBe("/srv/hub/app/packages/runner/src/main.ts")
  })
})

describe("the kndl wrapper", () => {
  test("runs the home's CLI with Bun, in this home unless KNDL_HOME says otherwise", () => {
    const script = wrapperScript(resolveLayout({}, "/Users/ada"), "/Users/ada/.bun/bin/bun")

    expect(script).toBe(
      [
        "#!/bin/sh",
        "# kndl: written by install.sh. Runs the CLI from the installed checkout.",
        ': "${KNDL_HOME:=/Users/ada/.kndl}"',
        "export KNDL_HOME",
        'exec /Users/ada/.bun/bin/bun "$KNDL_HOME/app/packages/cli/src/main.ts" "$@"',
        "",
      ].join("\n"),
    )
  })

  test("is recognised whichever Bun it runs, but only for its own home", () => {
    const layout = resolveLayout({}, "/Users/ada")
    const other = resolveLayout({ KNDL_HOME: "/srv/hub" }, "/Users/ada")
    const script = wrapperScript(layout, "/opt/homebrew/bin/bun")

    expect(isWrapperFor(script, layout)).toBe(true)
    expect(isWrapperFor(wrapperScript(layout, "/My Apps/bun"), layout)).toBe(true)
    expect(isWrapperFor(script, other)).toBe(false)
    expect(isWrapperFor("#!/bin/sh\nexec something-else\n", layout)).toBe(false)
  })

  test("quotes words for sh", () => {
    expect(shellQuote("/usr/bin/bun")).toBe("/usr/bin/bun")
    expect(shellQuote("/My Apps/bun")).toBe("'/My Apps/bun'")
    expect(shellQuote("it's")).toBe("'it'\\''s'")
  })
})
