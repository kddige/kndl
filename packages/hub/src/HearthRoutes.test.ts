// A Member's Hearth (spike, ADR 0032), end to end: a real Hub, a fake Runner that relays MCP
// servers, the web UI over WebSockets, and the kndl MCP server at `/gateway/kndl`, reached as the
// Hearth's Harness reaches it, with its mod token.

import { afterEach, describe, expect, test } from "bun:test"
import { hearthRepoOf } from "@kndl/protocol"
import { issueRunnerToken, openRunner, openWeb, stopAll } from "./testChannels.ts"
import { bearer, seedEnvironment, startHub, type TestHub } from "./testSupport.ts"

afterEach(stopAll)

const repo = "kddige/kndl"

let requests = 0
let calls = 0

async function scene() {
  const hub = await startHub({ config: { devLogin: true } })
  const runner = await openRunner(hub, (await issueRunnerToken(hub)).token, [], undefined, true, {
    relaysMcpServers: true,
  })
  const web = await openWeb(hub, "alice")
  await seedEnvironment(hub, repo, "dev:alice")
  return { hub, runner, web }
}

/** A JSON-RPC call to the kndl MCP server, as the Session of `token`. */
async function rpc(hub: TestHub, token: string, method: string, params?: unknown) {
  const response = await fetch(`${hub.url}/gateway/kndl`, {
    method: "POST",
    headers: {
      ...bearer(token),
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++calls, method, params }),
  })
  // oxlint-disable-next-line typescript/no-explicit-any -- JSON-RPC answers, read loosely
  return { status: response.status, body: (await response.json()) as Record<string, any> }
}

/** A tool's answer: its text, parsed when it is JSON, and whether it failed. */
async function tool(hub: TestHub, token: string, name: string, args: Record<string, unknown>) {
  const { body } = await rpc(hub, token, "tools/call", { name, arguments: args })
  const text: string = body.result.content[0].text
  let value: unknown = text
  try {
    value = JSON.parse(text)
  } catch {}
  return { value, isError: body.result.isError === true }
}

describe("a Hearth", () => {
  test("is lit once, on its own Workspace, with the kndl MCP server", async () => {
    const { hub, runner, web } = await scene()
    web.send({
      _tag: "CreateSession",
      requestId: `h-${++requests}`,
      repo: hearthRepoOf("alice"),
      branch: { _tag: "Existing", name: "anything", newWorkBranch: true },
    })
    const start = await runner.take("StartSession")
    expect(start.repo).toBe("~/alice")
    expect(start.baseBranch).toBe("main")
    expect(start.workBranch).toBe("main")
    expect(start.mcpServers).toEqual([{ installationId: "kndl", server: "kndl" }])
    expect(start.environment).toBeUndefined()
    runner.send({ _tag: "SessionStarted", sessionId: start.sessionId })
    const created = await web.take("SessionCreated")
    expect(created.session.name).toBe("Hearth")

    // There is only ever one.
    web.send({
      _tag: "CreateSession",
      requestId: `h-${++requests}`,
      repo: hearthRepoOf("alice"),
      branch: { _tag: "Existing", name: "main", newWorkBranch: false },
    })
    const refused = await web.take("CommandFailed", (m) => m.command === "CreateSession")
    expect(refused.message).toContain("only have one")

    // Nor is it archived.
    web.send({ _tag: "ArchiveSession", sessionId: start.sessionId })
    const notArchived = await web.take("CommandFailed", (m) => m.command === "ArchiveSession")
    expect(notArchived.message).toContain("can't be archived")

    // Nobody else sees it, or lights it.
    const bob = await openWeb(hub, "bob")
    expect(bob.sessions.sessions.map((session) => session.id)).not.toContain(start.sessionId)
    bob.send({
      _tag: "CreateSession",
      requestId: `h-${++requests}`,
      repo: hearthRepoOf("alice"),
      branch: { _tag: "Existing", name: "main", newWorkBranch: false },
    })
    await bob.take("CommandFailed", (m) => m.command === "CreateSession")
  })

  test("drives its Creator's other Sessions through the kndl MCP server", async () => {
    const { hub, runner, web } = await scene()
    web.send({
      _tag: "CreateSession",
      requestId: `h-${++requests}`,
      repo: hearthRepoOf("alice"),
      branch: { _tag: "Existing", name: "main", newWorkBranch: false },
    })
    const hearth = await runner.take("StartSession")
    runner.send({ _tag: "SessionStarted", sessionId: hearth.sessionId })

    const init = await rpc(hub, hearth.modToken, "initialize", { protocolVersion: "2025-06-18" })
    expect(init.status).toBe(200)
    expect(init.body.result.serverInfo.name).toBe("kndl")
    const listed = await rpc(hub, hearth.modToken, "tools/list")
    expect(listed.body.result.tools.map((t: { name: string }) => t.name)).toContain(
      "create_session",
    )

    // It creates a Session on a Repo, as alice, and prompts it.
    const pending = tool(hub, hearth.modToken, "create_session", { repo, prompt: "Hello there" })
    const child = await runner.take("StartSession")
    expect(child.repo).toBe(repo)
    expect(child.mcpServers).toBeUndefined()
    runner.send({ _tag: "SessionStarted", sessionId: child.sessionId })
    const created = await pending
    expect(created.isError).toBe(false)
    expect(created.value).toMatchObject({ created: { id: child.sessionId, repo }, prompted: true })

    const sessions = await tool(hub, hearth.modToken, "list_sessions", {})
    expect(sessions.value).toEqual([
      expect.objectContaining({ id: child.sessionId, creator: "alice" }),
    ])
    const status = await tool(hub, hearth.modToken, "get_session", {
      session_id: child.sessionId,
    })
    expect(status.value).toMatchObject({ id: child.sessionId, queuedPrompts: 1 })

    // It doesn't prompt itself.
    const itself = await tool(hub, hearth.modToken, "send_prompt", {
      session_id: hearth.sessionId,
      text: "loop",
    })
    expect(itself.isError).toBe(true)

    // Another Session doesn't reach the server.
    const refused = await rpc(hub, child.modToken, "tools/list")
    expect(refused.status).toBe(403)
  })
})
