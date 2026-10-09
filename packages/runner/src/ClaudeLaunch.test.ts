import { expect, test } from "bun:test"
import { InstallationId, type SessionId } from "@kndl/protocol"
import { claudeLaunch, gatewayMcpServers, ModEnvironment } from "./ClaudeLaunch.ts"
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
  // The Hub's URL and the mod token are the credential proxy's to give.
  expect(env).not.toHaveProperty(ModEnvironment.hubUrl)
  expect(env).not.toHaveProperty(ModEnvironment.modToken)
})

test("the Session's model and effort go as flags, so they never reach settings.json", () => {
  const { argv } = claudeLaunch({ ...options, model: "opus[1m]", effort: "xhigh" })
  expect(argv.slice(-4)).toEqual(["--model", "opus[1m]", "--effort", "xhigh"])
  expect(claudeLaunch({ ...options, effort: "low" }).argv.slice(-2)).toEqual(["--effort", "low"])
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
  // Claude Code fills in the variables: the credential proxy's URL, and the Session token.
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
