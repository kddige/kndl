import { expect, test } from "bun:test"
import type { SessionId } from "@kndl/protocol"
import { claudeLaunch, ModEnvironment } from "./ClaudeLaunch.ts"
import { modPlugins } from "./sandbox/SessionLayout.ts"

test("the mod's plugins read every variable the Runner sets for them, by the same name", async () => {
  // The loader lists a hooks module's variables from its literal `$.env.get` calls, so the mod
  // can't share these names as constants.
  for (const plugin of modPlugins) {
    const hooks = new URL(`../../mod/plugins/${plugin}/hooks/register.ts`, import.meta.url)
    const glue = await Bun.file(hooks).text()
    for (const name of Object.values(ModEnvironment)) expect(glue).toContain(`$.env.get("${name}")`)
  }
})

const options = {
  claudePath: "/opt/claude-code/2.1.289-musl/claude",
  sessionId: "s-1" as SessionId,
  mod: "/opt/kndl/mod/m1",
  conversation: { _tag: "New", id: "3c1f6f0e-claude" },
} as const

test("Claude Code runs in the Sandbox with the mod's plugins, never asking for a permission (ADR 0013)", () => {
  const { argv, env } = claudeLaunch(options)
  expect(argv).toEqual([
    "/opt/claude-code/2.1.289-musl/claude",
    "--session-id",
    "3c1f6f0e-claude",
    "--plugin-dir",
    "/opt/kndl/mod/m1/hub-link",
    "--plugin-dir",
    "/opt/kndl/mod/m1/hub-link-commands",
    "--dangerously-skip-permissions",
  ])
  expect(env[ModEnvironment.sessionId]).toBe("s-1")
  // The Hub's URL and the mod token are the credential proxy's to give.
  expect(env).not.toHaveProperty(ModEnvironment.hubUrl)
  expect(env).not.toHaveProperty(ModEnvironment.modToken)
})

test("Claude Code can't start a second Claude Code in the Session as a background job (#191)", () => {
  expect(claudeLaunch(options).env.CLAUDE_CODE_DISABLE_AGENT_VIEW).toBe("1")
})

test("waking resumes the conversation", () => {
  const { argv } = claudeLaunch({
    ...options,
    conversation: { _tag: "Resume", id: "c-1" as never },
  })
  expect(argv.slice(1, 3)).toEqual(["--resume", "c-1"])
})

test("Claude Code's default model and effort are left to it", () => {
  const { argv } = claudeLaunch(options)
  expect(argv).not.toContain("--model")
  expect(argv).not.toContain("--effort")
})

test("the Session's model and effort go as flags, so they never reach settings.json", () => {
  const { argv } = claudeLaunch({ ...options, model: "opus[1m]", effort: "xhigh" })
  expect(argv.slice(-4)).toEqual(["--model", "opus[1m]", "--effort", "xhigh"])
  expect(claudeLaunch({ ...options, effort: "low" }).argv.slice(-2)).toEqual(["--effort", "low"])
})
