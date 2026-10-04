import { describe, expect, test } from "bun:test"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { ConfigProvider, Effect } from "effect"
import { devHome, HomeConfig } from "./Home.ts"

const homeIn = (env: Record<string, string>) =>
  Effect.runSync(HomeConfig.parse(ConfigProvider.fromEnv({ env })))

describe("the home", () => {
  test("from a checkout is the dev home, apart from an installed claude-hub's", () => {
    expect(homeIn({})).toEqual({
      dir: join(homedir(), ".claude-hub-dev"),
      tmuxSocket: "claude-hub-dev",
      dev: true,
    })
    expect(homeIn({ CLAUDE_HUB_HOME: "" })).toEqual(devHome)
  })

  test("is the one CLAUDE_HUB_HOME names, with tmux socket claude-hub", () => {
    const installed = join(homedir(), ".claude-hub")

    expect(homeIn({ CLAUDE_HUB_HOME: installed })).toEqual({
      dir: installed,
      tmuxSocket: "claude-hub",
      dev: false,
    })
    expect(homeIn({ CLAUDE_HUB_HOME: "relative/home" }).dir).toBe(resolve("relative/home"))
  })
})
