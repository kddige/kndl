import { describe, expect, test } from "bun:test"
import { homedir } from "node:os"
import { join } from "node:path"
import { ConfigProvider, Effect } from "effect"
import { ProxyConfig, ProxyConfigLive } from "./ProxyConfig.ts"

const settingsIn = (env: Record<string, string>) =>
  Effect.runPromise(
    Effect.service(ProxyConfig).pipe(
      Effect.provide(ProxyConfigLive),
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
    ),
  )

describe("the proxy's settings", () => {
  test("default to the dev home's port, a credential found on the host, and no plan", async () => {
    expect(await settingsIn({})).toEqual({
      port: 7779,
      credential: { _tag: "Auto" },
      plan: undefined,
      home: join(homedir(), ".kndl-dev"),
    })
    expect((await settingsIn({ KNDL_HOME: "/srv/kndl" })).port).toBe(7778)
  })

  test("follow RUNNER_PROXY_PORT and RUNNER_CLAUDE_CREDENTIAL", async () => {
    const settings = await settingsIn({
      RUNNER_PROXY_PORT: "9000",
      RUNNER_CLAUDE_CREDENTIAL: "file:/etc/kndl/token",
    })
    expect(settings.port).toBe(9000)
    expect(settings.credential).toEqual({ _tag: "File", path: "/etc/kndl/token" })
  })

  test("take a plan with Claude Code's tier for it, unless one is given", async () => {
    expect((await settingsIn({ RUNNER_CLAUDE_PLAN: "max" })).plan).toEqual({
      subscriptionType: "max",
      rateLimitTier: "default_claude_max_5x",
    })
    const twenty = await settingsIn({
      RUNNER_CLAUDE_PLAN: "max",
      RUNNER_CLAUDE_RATE_LIMIT_TIER: "default_claude_max_20x",
    })
    expect(twenty.plan).toEqual({
      subscriptionType: "max",
      rateLimitTier: "default_claude_max_20x",
    })
    expect((await settingsIn({ RUNNER_CLAUDE_PLAN: "team" })).plan).toEqual({
      subscriptionType: "team",
    })
  })

  test("refuse a credential source or plan they don't know", async () => {
    await expect(settingsIn({ RUNNER_CLAUDE_CREDENTIAL: "sk-ant-oat01-FAKE" })).rejects.toThrow(
      "RUNNER_CLAUDE_CREDENTIAL must be",
    )
    await expect(settingsIn({ RUNNER_CLAUDE_PLAN: "free" })).rejects.toThrow()
  })
})
