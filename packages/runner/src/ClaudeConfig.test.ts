import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect } from "effect"
import {
  claudeConfigPath,
  isTrusted,
  loginFromClaudeConfig,
  resolveRunnerLogin,
} from "./ClaudeConfig.ts"

describe("isTrusted", () => {
  const config = { projects: { "/home/a/.claude-hub": { hasTrustDialogAccepted: true } } }

  test("inherits trust from a parent directory", () => {
    expect(isTrusted(config, "/home/a/.claude-hub/sessions/s-1/claude")).toBe(true)
    expect(isTrusted(config, "/home/a/.claude-hub")).toBe(true)
  })

  test("is false elsewhere, and for a missing or odd config", () => {
    expect(isTrusted(config, "/home/a")).toBe(false)
    expect(isTrusted(config, "/home/a/.claude-hubby")).toBe(false)
    expect(isTrusted(undefined, "/home/a/.claude-hub")).toBe(false)
    expect(
      isTrusted({ projects: { "/": { hasTrustDialogAccepted: false } } }, "/home/a/.claude-hub"),
    ).toBe(false)
  })
})

describe("Runner login", () => {
  test("is the signed-in account", () => {
    expect(loginFromClaudeConfig({ oauthAccount: { emailAddress: "a@example.com" } })).toEqual({
      account: "a@example.com",
    })
    expect(loginFromClaudeConfig({})).toBeUndefined()
  })

  test("comes from RUNNER_LOGIN when set, else the config file, else fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-hub-config-"))
    const path = join(dir, ".claude.json")
    const resolve = (configured: string | undefined) =>
      Effect.runPromise(
        resolveRunnerLogin(configured, path).pipe(Effect.result, Effect.provide(BunServices.layer)),
      )

    expect(await resolve(undefined)).toMatchObject({ _tag: "Failure" })
    writeFileSync(path, JSON.stringify({ oauthAccount: { emailAddress: "b@example.com" } }))
    expect(await resolve(undefined)).toMatchObject({ success: { account: "b@example.com" } })
    expect(await resolve("c@example.com")).toMatchObject({ success: { account: "c@example.com" } })
  })

  test("reads Claude Code's config from CLAUDE_CONFIG_DIR when set", () => {
    expect(claudeConfigPath({ CLAUDE_CONFIG_DIR: "/cfg" })).toBe("/cfg/.claude.json")
  })
})
