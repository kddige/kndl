import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { ConfigProvider, Effect } from "effect"
import { ModBundles, RunnerConfig, RunnerConfigLive } from "./RunnerConfig.ts"

// A mod directory with its bundles in place, as RunnerConfigLive refuses to start without one.
let modDir: string

beforeAll(async () => {
  modDir = await mkdtemp(join(tmpdir(), "claude-hub-runner-config-"))
  for (const bundle of ModBundles) {
    await mkdir(dirname(join(modDir, bundle)), { recursive: true })
    await writeFile(join(modDir, bundle), "")
  }
})

afterAll(() => rm(modDir, { recursive: true, force: true }))

const settingsIn = (env: Record<string, string>) =>
  Effect.runPromise(
    Effect.service(RunnerConfig).pipe(
      Effect.provide(RunnerConfigLive),
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromEnv({
            env: { RUNNER_TOKEN: "chr_x", RUNNER_MOD_DIR: modDir, ...env },
          }),
        ),
      ),
    ),
  )

describe("the Runner's defaults", () => {
  test("from a checkout are the dev home's", async () => {
    const settings = await settingsIn({})

    expect(settings.sessionsRoot).toBe(join(homedir(), ".claude-hub-dev", "sessions"))
    expect(settings.tmuxSocket).toBe("claude-hub-dev")
  })

  test("follow CLAUDE_HUB_HOME", async () => {
    const settings = await settingsIn({ CLAUDE_HUB_HOME: "/srv/claude-hub" })

    expect(settings.sessionsRoot).toBe("/srv/claude-hub/sessions")
    expect(settings.tmuxSocket).toBe("claude-hub")
  })

  test("give way to RUNNER_SESSIONS_ROOT and RUNNER_TMUX_SOCKET", async () => {
    const settings = await settingsIn({
      CLAUDE_HUB_HOME: "/srv/claude-hub",
      RUNNER_SESSIONS_ROOT: "/tmp/sessions",
      RUNNER_TMUX_SOCKET: "mine",
    })

    expect(settings.sessionsRoot).toBe("/tmp/sessions")
    expect(settings.tmuxSocket).toBe("mine")
  })
})
