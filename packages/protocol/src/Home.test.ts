import { describe, expect, test } from "bun:test"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { ConfigProvider, Effect } from "effect"
import { devHome, HomeConfig } from "./Home.ts"

const homeIn = (env: Record<string, string>) =>
  Effect.runSync(HomeConfig.parse(ConfigProvider.fromEnv({ env })))

describe("the home", () => {
  test("from a checkout is the dev home, apart from an installed kndl's", () => {
    expect(homeIn({})).toEqual({
      dir: join(homedir(), ".kndl-dev"),
      tmuxSocket: "kndl-dev",
      dev: true,
    })
    expect(homeIn({ KNDL_HOME: "" })).toEqual(devHome)
  })

  test("is the one KNDL_HOME names, with tmux socket kndl", () => {
    const installed = join(homedir(), ".kndl")

    expect(homeIn({ KNDL_HOME: installed })).toEqual({
      dir: installed,
      tmuxSocket: "kndl",
      dev: false,
    })
    expect(homeIn({ KNDL_HOME: "relative/home" }).dir).toBe(resolve("relative/home"))
  })
})
