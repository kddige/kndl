import { describe, expect, test } from "bun:test"
import { ConfigProvider, Effect } from "effect"
import { RelayConfig, RelayConfigLive } from "./RelayConfig.ts"

const settingsIn = (env: Record<string, string>) =>
  Effect.runPromise(
    Effect.service(RelayConfig).pipe(
      Effect.provide(RelayConfigLive),
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
    ),
  )

describe("the relay's settings", () => {
  test("default to the dev home's port, or the installed one's", async () => {
    expect(await settingsIn({})).toEqual({ port: 7779 })
    expect((await settingsIn({ KNDL_HOME: "/srv/kndl" })).port).toBe(7778)
  })

  test("follow RUNNER_RELAY_PORT, and else RUNNER_PROXY_PORT, its name from before", async () => {
    expect((await settingsIn({ RUNNER_RELAY_PORT: "9000" })).port).toBe(9000)
    expect((await settingsIn({ RUNNER_PROXY_PORT: "9001" })).port).toBe(9001)
    expect((await settingsIn({ RUNNER_RELAY_PORT: "9000", RUNNER_PROXY_PORT: "9001" })).port).toBe(
      9000,
    )
  })

  test("refuse a port that isn't one", async () => {
    await expect(settingsIn({ RUNNER_RELAY_PORT: "http" })).rejects.toThrow()
  })

  test("ignore the Runner's own Claude credential and plan, which it no longer has", async () => {
    expect(
      await settingsIn({
        RUNNER_CLAUDE_CREDENTIAL: "sk-ant-oat01-FAKE",
        RUNNER_CLAUDE_PLAN: "free",
        RUNNER_CLAUDE_RATE_LIMIT_TIER: "default_claude_max_5x",
      }),
    ).toEqual({ port: 7779 })
  })
})
