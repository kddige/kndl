import { describe, expect, test } from "bun:test"
import { resolveLayout, shellQuote, wrapperScript } from "./Layout.ts"

describe("the installed home", () => {
  test("is ~/.claude-hub by default, never the dev home", () => {
    const layout = resolveLayout({}, "/Users/ada")

    expect(layout.home.dir).toBe("/Users/ada/.claude-hub")
    expect(layout.home.tmuxSocket).toBe("claude-hub")
    expect(layout.app).toBe("/Users/ada/.claude-hub/app")
    expect(layout.wrapper).toBe("/Users/ada/.local/bin/claude-hub")
  })

  test("is CLAUDE_HUB_HOME when set", () => {
    const layout = resolveLayout({ CLAUDE_HUB_HOME: "/srv/hub" }, "/Users/ada")

    expect(layout.home.dir).toBe("/srv/hub")
    expect(layout.envFile("runner")).toBe("/srv/hub/runner.env")
    expect(layout.logFile("hub")).toBe("/srv/hub/logs/hub.log")
    expect(layout.entryPoint("runner")).toBe("/srv/hub/app/packages/runner/src/main.ts")
  })
})

describe("the claude-hub wrapper", () => {
  test("runs the home's CLI with Bun, in this home unless CLAUDE_HUB_HOME says otherwise", () => {
    const script = wrapperScript(resolveLayout({}, "/Users/ada"), "/Users/ada/.bun/bin/bun")

    expect(script).toBe(
      [
        "#!/bin/sh",
        "# claude-hub: written by install.sh. Runs the CLI from the installed checkout.",
        ': "${CLAUDE_HUB_HOME:=/Users/ada/.claude-hub}"',
        "export CLAUDE_HUB_HOME",
        'exec /Users/ada/.bun/bin/bun "$CLAUDE_HUB_HOME/app/packages/cli/src/main.ts" "$@"',
        "",
      ].join("\n"),
    )
  })

  test("quotes words for sh", () => {
    expect(shellQuote("/usr/bin/bun")).toBe("/usr/bin/bun")
    expect(shellQuote("/My Apps/bun")).toBe("'/My Apps/bun'")
    expect(shellQuote("it's")).toBe("'it'\\''s'")
  })
})
