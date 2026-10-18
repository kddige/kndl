import { expect, test } from "bun:test"
import { ConversationId, InstallationId, type SessionId } from "@kndl/protocol"
import { claudeLaunch, gatewayMcpServers } from "./ClaudeLaunch.ts"
import { HarnessVariable, ModEnvironment } from "./HarnessEnvironment.ts"
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
  conversation: { _tag: "New", id: "3c1f6f0e-8a2b-4c7d-9e1f-2a3b4c5d6e7f" },
} as const

test("Claude Code runs in the Sandbox with the mod's plugins, never asking for a permission (ADR 0013)", () => {
  const { argv, env } = claudeLaunch(options)
  expect(argv).toEqual([
    "/opt/claude-code/2.1.289-musl/claude",
    "--session-id",
    "3c1f6f0e-8a2b-4c7d-9e1f-2a3b4c5d6e7f",
    "--plugin-dir",
    "/opt/kndl/mod/m1/hub-link",
    "--plugin-dir",
    "/opt/kndl/mod/m1/hub-link-commands",
    "--dangerously-skip-permissions",
  ])
  expect(env[ModEnvironment.sessionId]).toBe("s-1")
  // Read back after a Runner restart, as its Harness can change while it runs (ADR 0030).
  expect(env[HarnessVariable]).toBe("ClaudeCode")
  // The Hub's URL and the mod token are the mod relay's to give.
  expect(env).not.toHaveProperty(ModEnvironment.hubUrl)
  expect(env).not.toHaveProperty(ModEnvironment.modToken)
})

test("Claude Code is told which conversation it was launched as, new or resumed (#321)", () => {
  // The mod links only that one: a `claude` run inside the Session inherits the rest.
  expect(claudeLaunch(options).env[ModEnvironment.conversationId]).toBe(
    "3c1f6f0e-8a2b-4c7d-9e1f-2a3b4c5d6e7f",
  )
  const resumed = { _tag: "Resume", id: "9c528fab-0d1e-4f2a-8b3c-4d5e6f7a8b9c" } as never
  expect(claudeLaunch({ ...options, conversation: resumed }).env).toMatchObject({
    [ModEnvironment.conversationId]: "9c528fab-0d1e-4f2a-8b3c-4d5e6f7a8b9c",
  })
})

test("waking resumes the conversation by its id", () => {
  const resumed = {
    _tag: "Resume",
    id: ConversationId.make("9c528fab-0d1e-4f2a-8b3c-4d5e6f7a8b9c"),
  } as const
  expect(claudeLaunch({ ...options, conversation: resumed }).argv.slice(1, 3)).toEqual([
    "--resume",
    "9c528fab-0d1e-4f2a-8b3c-4d5e6f7a8b9c",
  ])
})

test("the Session's model and thinking level go as flags, so they never reach settings.json", () => {
  const { argv } = claudeLaunch({ ...options, model: "opus[1m]", thinkingLevel: "xhigh" })
  expect(argv.slice(-4)).toEqual(["--model", "opus[1m]", "--effort", "xhigh"])
  expect(claudeLaunch({ ...options, thinkingLevel: "low" }).argv.slice(-2)).toEqual([
    "--effort",
    "low",
  ])
})

test("a thinking level Claude Code doesn't take leaves its effort at its default", () => {
  // A Claude Code Runner never offers them, so the Hub refuses them first.
  for (const thinkingLevel of ["off", "minimal"] as const)
    expect(claudeLaunch({ ...options, thinkingLevel }).argv).not.toContain("--effort")
})

const servers = [
  { installationId: InstallationId.make("inst-1"), server: "docs" },
  { installationId: InstallationId.make("inst/2"), server: "linear" },
]

test("a Session's Installations come as one more plugin, kndl, after the mod's (ADR 0020)", () => {
  const { argv } = claudeLaunch({ ...options, mcpServers: servers })
  expect(argv.slice(3, 9)).toEqual([
    "--plugin-dir",
    "/opt/kndl/mod/m1/hub-link",
    "--plugin-dir",
    "/opt/kndl/mod/m1/hub-link-commands",
    "--plugin-dir",
    "/opt/kndl/mod/m1/kndl",
  ])
  expect(claudeLaunch({ ...options, mcpServers: [] }).argv).not.toContain("/opt/kndl/mod/m1/kndl")
})

test("each Installation's MCP server is the Gateway, reached with the Session token alone", () => {
  // Claude Code fills in the variables: the mod relay's URL, and the Session token.
  expect(gatewayMcpServers(servers)).toEqual({
    mcpServers: {
      docs: {
        type: "http",
        url: "${KNDL_URL}/gateway/inst-1",
        headers: { Authorization: "Bearer ${KNDL_MOD_TOKEN}" },
      },
      linear: {
        type: "http",
        url: "${KNDL_URL}/gateway/inst%2F2",
        headers: { Authorization: "Bearer ${KNDL_MOD_TOKEN}" },
      },
    },
  })
})
