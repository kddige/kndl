// hub-link in Claude Code's own mod runtime (`claude plugin test`): the hooks module, loading the
// bundle (`bun run build` first), with the world beneath it faked.

import type { On, PromptComposeInput, PromptEditInput, PromptEditResult } from "claude-code"
import { describe, expect, mock, test } from "claude-code/testing"

const socket = "/sessions/s1/tools.sock"
const hubUrl = "http://hub.test"

type Fetched = { url: string; method: string; socketPath?: string; body?: string }

/** Answers `$.http.fetch` with `answer`, noting each request. */
const fakeFetch = (
  on: On,
  answer: (
    request: Fetched,
  ) => { status: number; text: string } | Promise<{ status: number; text: string }>,
) => {
  const requests: Array<Fetched> = []
  on("http.fetch", async (_, e) => {
    const request: Fetched = {
      url: e.url,
      method: e.init?.method ?? "GET",
      ...(e.init?.socketPath === undefined ? {} : { socketPath: e.init.socketPath }),
      ...(typeof e.init?.body === "string" ? { body: e.init.body } : {}),
    }
    requests.push(request)
    const { status, text } = await answer(request)
    return { value: { status, ok: status >= 200 && status < 300, headers: {}, text } }
  })
  return requests
}

/**
 * Raises `prompt.edit` as the prompt box does. The test engine raises it, but its typed `$` leaves
 * it out, so it is reached through this one cast.
 */
const editPrompt = ($: unknown, e: PromptEditInput) =>
  ($ as { prompt: { edit: (e: PromptEditInput) => Promise<PromptEditResult> } }).prompt.edit(e)

const ran = (result: unknown) => ({
  status: 200,
  text: JSON.stringify({ _tag: "ToolRan", result }),
})

describe("tools", () => {
  test("runs Bash in the Sandbox through the tool bridge", async ($, on) => {
    mock.env(on, { CLAUDE_HUB_TOOLS_SOCKET: socket })
    const requests = fakeFetch(on, () =>
      ran({ stdout: "hello from the vm", stderr: "", interrupted: false }),
    )
    let reachedCore = false
    on("tool.call", () => {
      reachedCore = true
      return { deny: "core ran it" }
    })

    const answer = await $.tool.call({ tool: "Bash", command: "echo hello", description: "say hi" })

    expect(reachedCore).toBe(false)
    expect(answer.isError).toBeFalsy()
    expect(answer.result).toMatchObject({ stdout: "hello from the vm" })
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      url: "http://tool-bridge/tools/calls?waitMs=20000",
      method: "POST",
      socketPath: socket,
    })
    expect(JSON.parse(requests[0]?.body ?? "")).toEqual({
      callId: expect.stringMatching(/^[A-Za-z0-9_.-]+$/),
      tool: "Bash",
      input: { command: "echo hello", description: "say hi" },
    })
  })

  test("waits for a long call in steps, past what one fetch allows", async ($, on) => {
    mock.env(on, { CLAUDE_HUB_TOOLS_SOCKET: socket })
    let waits = 0
    const requests = fakeFetch(on, (request) => {
      if (request.method === "POST")
        return {
          status: 202,
          text: JSON.stringify({
            _tag: "ToolRunning",
            callId: JSON.parse(request.body ?? "").callId,
          }),
        }
      waits += 1
      return waits < 3
        ? { status: 202, text: JSON.stringify({ _tag: "ToolRunning", callId: "c" }) }
        : ran({ stdout: "149 pass", stderr: "", interrupted: false })
    })
    on("tool.call", () => ({ deny: "core ran it" }))

    const answer = await $.tool.call({ tool: "Bash", command: "bun test", timeout: 600000 })

    expect(answer.result).toMatchObject({ stdout: "149 pass" })
    const callId = JSON.parse(requests[0]?.body ?? "").callId as string
    expect(requests.slice(1).map((request) => `${request.method} ${request.url}`)).toEqual([
      `GET http://tool-bridge/tools/calls/${callId}?waitMs=20000`,
      `GET http://tool-bridge/tools/calls/${callId}?waitMs=20000`,
      `GET http://tool-bridge/tools/calls/${callId}?waitMs=20000`,
    ])
  })

  test("says a call whose answer was lost may have run", async ($, on) => {
    mock.env(on, { CLAUDE_HUB_TOOLS_SOCKET: socket })
    fakeFetch(on, (request) => {
      if (request.method === "POST")
        return { status: 202, text: JSON.stringify({ _tag: "ToolRunning", callId: "c" }) }
      throw new Error("no complete answer within 30000ms")
    })
    on("tool.call", () => ({ deny: "core ran it" }))

    const answer = await $.tool.call({ tool: "Bash", command: "git stash && git stash pop" })

    expect(answer.deny).toContain("may have run")
    expect(answer.deny).toContain("Check before running it again")
    expect(answer.deny).not.toContain("did not run")
  })

  test("runs a call through a Runner from before long calls", async ($, on) => {
    mock.env(on, { CLAUDE_HUB_TOOLS_SOCKET: socket })
    const requests = fakeFetch(on, (request) =>
      request.url === "http://tool-bridge/tools/call"
        ? ran({ stdout: "old", stderr: "", interrupted: false })
        : { status: 404, text: "not found" },
    )
    on("tool.call", () => ({ deny: "core ran it" }))

    const answer = await $.tool.call({ tool: "Bash", command: "echo old" })

    expect(answer.result).toMatchObject({ stdout: "old" })
    expect(requests.map((request) => request.url)).toEqual([
      "http://tool-bridge/tools/calls?waitMs=20000",
      "http://tool-bridge/tools/call",
    ])
  })

  // The test runtime hides a fetch hook's throw behind "no implementation for http.fetch", so this
  // is a failure the mod can't explain: it must not say the call didn't run. (Claude Code's own
  // fetch names the cause, such as connect ENOENT, which ToolBridgeClient.spec.ts covers.)
  test("refuses a call whose bridge fails unexplained as may have run, never on the host", async ($, on) => {
    mock.env(on, { CLAUDE_HUB_TOOLS_SOCKET: socket })
    fakeFetch(on, () => {
      throw new Error("connect ENOENT")
    })
    let reachedCore = false
    on("tool.call", () => {
      reachedCore = true
      return { deny: "core ran it" }
    })

    const answer = await $.tool.call({ tool: "Read", file_path: "/workspace/a.txt" })

    expect(reachedCore).toBe(false)
    expect(answer.deny).toBeDefined()
    expect(answer.deny).toContain("Check before running it again")
    expect(answer.deny).toContain("never runs on the host")
  })

  test("refuses a call when the bridge answers BridgeUnavailable", async ($, on) => {
    mock.env(on, { CLAUDE_HUB_TOOLS_SOCKET: socket })
    fakeFetch(on, () => ({
      status: 503,
      text: JSON.stringify({ _tag: "BridgeUnavailable", message: "the Sandbox is down" }),
    }))
    on("tool.call", () => ({ deny: "core ran it" }))

    const answer = await $.tool.call({ tool: "Bash", command: "ls" })

    expect(answer.deny).toBeDefined()
    expect(answer.deny).toContain("the Sandbox is down")
    expect(answer.deny).toContain("did not run at all")
  })

  test("refuses every call when no Runner gave it a bridge", async ($, on) => {
    mock.env(on, {})
    const requests = fakeFetch(on, () => ran({}))
    on("tool.call", () => ({ deny: "core ran it" }))

    const answer = await $.tool.call({ tool: "Bash", command: "ls" })

    expect(requests).toHaveLength(0)
    expect(answer.deny).toBeDefined()
    expect(answer.deny).toContain("no tool bridge")
  })

  test("denies tools that would run on the host", async ($, on) => {
    mock.env(on, { CLAUDE_HUB_TOOLS_SOCKET: socket })
    const requests = fakeFetch(on, () => ran({}))
    let reachedCore = 0
    on("tool.call", () => {
      reachedCore++
      return { deny: "core ran it" }
    })

    const fetched = await $.tool.call({ tool: "WebFetch", url: "https://example.com", prompt: "x" })
    const agent = await $.tool.call({
      tool: "Agent",
      description: "x",
      prompt: "x",
      subagent_type: "general-purpose",
    } as never)
    const mcp = await $.tool.call({ tool: "mcp__github__create_issue", title: "x" } as never)

    expect(reachedCore).toBe(0)
    expect(requests).toHaveLength(0)
    for (const answer of [fetched, agent, mcp]) {
      expect(answer.deny).toBeDefined()
      expect(answer.deny).toContain("not available in this Claude Hub Session")
    }
    expect(fetched.deny).toContain("curl through Bash")
  })

  test("leaves WebSearch to Claude Code, without asking (#126)", async ($, on) => {
    mock.env(on, { CLAUDE_HUB_TOOLS_SOCKET: socket })
    const requests = fakeFetch(on, () => ran({}))
    let reachedCore = 0
    on("tool.call", () => {
      reachedCore++
      return { result: { query: "bun", results: [], durationSeconds: 1 } } as never
    })
    on("tool.check", () => ({ decision: "ask", reason: "WebSearchTool requires permission." }))

    const answer = await $.tool.call({ tool: "WebSearch", query: "bun" })
    const checked = await $.tool.check({ tool: "WebSearch", input: { query: "bun" } })
    const other = await $.tool.check({ tool: "WebFetch", input: { url: "https://example.com" } })

    expect(reachedCore).toBe(1)
    expect(requests).toHaveLength(0)
    expect(answer.deny).toBeUndefined()
    expect(answer.result).toMatchObject({ query: "bun" })
    expect(checked.decision).toBe("allow")
    expect(other.decision).toBe("ask")
  })

  test("refuses a background command", async ($, on) => {
    mock.env(on, { CLAUDE_HUB_TOOLS_SOCKET: socket })
    const requests = fakeFetch(on, () => ran({}))
    on("tool.call", () => ({ deny: "core ran it" }))

    const answer = await $.tool.call({ tool: "Bash", command: "sleep 60", run_in_background: true })

    expect(requests).toHaveLength(0)
    expect(answer.deny).toBeDefined()
  })
})

describe("the ! shell shortcut", () => {
  test("is refused at the start of the prompt", async ($, on) => {
    on("prompt.edit", (_, e) => ({ text: e.text, cursor: e.cursor }))
    on("ui.toast", () => ({ value: undefined }))

    const edited = await editPrompt($, {
      origin: { kind: "composer" },
      text: "",
      cursor: 0,
      start: 0,
      end: 0,
      inputText: "!",
    })

    expect(edited.text).toBe("")
  })

  test("leaves a ! elsewhere alone", async ($, on) => {
    on("prompt.edit", (_, e) => ({
      text: e.text.slice(0, e.start) + e.inputText + e.text.slice(e.end),
      cursor: e.start + e.inputText.length,
    }))

    const edited = await editPrompt($, {
      origin: { kind: "composer" },
      text: "hi",
      cursor: 2,
      start: 2,
      end: 2,
      inputText: "!",
    })

    expect(edited.text).toBe("hi!")
  })
})

describe("the Hub link", () => {
  test("is off when no Runner started the session", async ($, on) => {
    mock.env(on, {})
    const lines: Array<string> = []
    on("ui.log", (_, e) => {
      lines.push(e.text)
      return { value: undefined }
    })
    on("session.start", (_, e) => ({ cwd: e.cwd }))

    await $.session.start({ cwd: "/tmp/session", surface: null, isInteractive: false })

    expect(lines).toEqual(["hub-link: not started by a Runner, so not linked to a Hub"])
  })

  test("says hello with the mod token, then polls for commands", async ($, on) => {
    mock.env(on, {
      CLAUDE_HUB_URL: hubUrl,
      CLAUDE_HUB_SESSION_ID: "s1",
      CLAUDE_HUB_MOD_TOKEN: "secret",
    })
    const clock = mock.clock(on)
    on("session.id", () => ({ value: "claude-1" }))
    on("session.model", () => ({ value: "claude-test" }))
    on("ui.log", () => ({ value: undefined }))
    let polled = 0
    const requests = fakeFetch(on, (request) => {
      if (request.url.endsWith("/mod/hello"))
        return { status: 200, text: JSON.stringify({ _tag: "ModWelcome", protocolVersion: 1 }) }
      polled++
      // Hold later polls, as the Hub's long poll does.
      return polled === 1
        ? { status: 200, text: JSON.stringify({ messages: [] }) }
        : new Promise(() => undefined)
    })
    on("session.start", (_, e) => ({ cwd: e.cwd }))

    await $.session.start({ cwd: "/tmp/session", surface: null, isInteractive: true })
    await clock.advance(0)

    expect(requests[0]?.url).toBe(`${hubUrl}/mod/hello`)
    expect(JSON.parse(requests[0]?.body ?? "")).toEqual({
      _tag: "ModHello",
      protocolVersion: 1,
      sessionId: "s1",
      claudeSessionId: "claude-1",
      model: "claude-test",
    })
    expect(requests[1]?.url).toBe(`${hubUrl}/mod/commands?after=0&waitMs=25000`)
  })

  test("shows the Participants the Hub reports in the band above the prompt", async ($, on) => {
    mock.env(on, {
      CLAUDE_HUB_URL: hubUrl,
      CLAUDE_HUB_SESSION_ID: "s1",
      CLAUDE_HUB_MOD_TOKEN: "secret",
    })
    const clock = mock.clock(on)
    on("session.id", () => ({ value: "claude-1" }))
    on("session.model", () => ({ value: "claude-test" }))
    on("ui.log", () => ({ value: undefined }))
    let polled = 0
    fakeFetch(on, (request) => {
      if (request.url.endsWith("/mod/hello"))
        return { status: 200, text: JSON.stringify({ _tag: "ModWelcome", protocolVersion: 1 }) }
      polled++
      if (polled > 1) return new Promise(() => undefined)
      const participants = [
        { id: "p1", login: "ada", name: "Ada Lovelace" },
        { id: "p2", login: "alan", name: "Alan Turing" },
      ]
      return {
        status: 200,
        text: JSON.stringify({
          messages: [
            { seq: 1, message: { _tag: "PresenceChanged", sessionId: "s1", participants } },
          ],
        }),
      }
    })
    on("session.start", (_, e) => ({ cwd: e.cwd }))

    await $.session.start({ cwd: "/tmp/session", surface: null, isInteractive: true })
    await clock.advance(0)
    const band = await $.ui.mount({
      plugin: "hub-link",
      surface: "terminal",
      component: "AbovePrompt",
      props: {
        hasSurvey: false,
        isWorking: false,
        maxRows: 3,
        bodyColumns: 80,
        scroll: { offset: 0, bodyRows: 3 },
        view: {},
      },
    })

    expect(await band.find({ text: /Ada Lovelace, Alan Turing/ })).toBeDefined()
  })

  test("posts a Turn's events in one batch", async ($, on) => {
    mock.env(on, {
      CLAUDE_HUB_URL: hubUrl,
      CLAUDE_HUB_SESSION_ID: "s1",
      CLAUDE_HUB_MOD_TOKEN: "secret",
      CLAUDE_HUB_TOOLS_SOCKET: socket,
    })
    const clock = mock.clock(on)
    on("session.id", () => ({ value: "claude-1" }))
    on("session.model", () => ({ value: "claude-test" }))
    on("ui.log", () => ({ value: undefined }))
    const requests = fakeFetch(on, (request) => {
      if (request.url.endsWith("/mod/hello"))
        return { status: 200, text: JSON.stringify({ _tag: "ModWelcome", protocolVersion: 1 }) }
      if (request.url.endsWith("/mod/events")) return { status: 204, text: "" }
      if (request.socketPath === socket)
        return ran({ stdout: "a.txt", stderr: "", interrupted: false })
      return new Promise(() => undefined)
    })
    on("session.start", (_, e) => ({ cwd: e.cwd }))
    on("turn.start", () => ({ turnId: "t1" }))
    on("turn.complete", () => ({ text: "done" }))
    on("tool.call", () => ({ deny: "core ran it" }))

    await $.session.start({ cwd: "/tmp/session", surface: null, isInteractive: true })
    await clock.advance(0)
    await $.turn.start({ turnId: "t1", text: "list the files" } as never)
    await $.tool.call({ tool: "Bash", command: "ls", tool_use_id: "toolu_1" } as never)
    await $.turn.complete({
      turnId: "t1",
      answer: "done",
      durationMs: 1200,
      isAborted: false,
      reason: "answer",
    } as never)
    await clock.advance(200)

    const posts = requests.filter((request) => request.url === `${hubUrl}/mod/events`)
    expect(posts).toHaveLength(1)
    expect(JSON.parse(posts[0]?.body ?? "")).toEqual({
      messages: [
        {
          _tag: "TurnStarted",
          turnId: "t1",
          text: "list the files",
          sender: { _tag: "FromTerminal" },
        },
        {
          _tag: "ToolCallStarted",
          turnId: "t1",
          toolCallId: expect.any(String),
          tool: "Bash",
          input: '{"command":"ls"}',
        },
        {
          _tag: "ToolCallEnded",
          turnId: "t1",
          toolCallId: expect.any(String),
          tool: "Bash",
          outcome: "Succeeded",
          output: "a.txt",
        },
        { _tag: "TurnEnded", turnId: "t1", reason: "Answered", durationMs: 1200 },
      ],
    })
  })
})

const welcome = { status: 200, text: JSON.stringify({ _tag: "ModWelcome", protocolVersion: 1 }) }

/**
 * A session a Runner started, linked to the Hub; `env` adds to the Runner's variables. Returns
 * the names of the tools the mod registers.
 */
const linkedSession = (on: On, env: Record<string, string> = {}) => {
  mock.env(on, {
    CLAUDE_HUB_URL: hubUrl,
    CLAUDE_HUB_SESSION_ID: "s1",
    CLAUDE_HUB_MOD_TOKEN: "secret",
    CLAUDE_HUB_TOOLS_SOCKET: socket,
    ...env,
  })
  on("session.id", () => ({ value: "claude-1" }))
  on("session.model", () => ({ value: "claude-test" }))
  on("ui.log", () => ({ value: undefined }))
  on("session.start", (_, e) => ({ cwd: e.cwd }))
  const registered: Array<string> = []
  on("tool.register", (_, e) => {
    registered.push(e.name)
    return { value: { tool: `mcp__hub-link__${e.name}` } }
  })
  return registered
}

describe("Child Sessions", () => {
  test("a Parent Session gets the tools", async ($, on) => {
    const registered = linkedSession(on)
    const clock = mock.clock(on)
    fakeFetch(on, (request) =>
      request.url.endsWith("/mod/hello") ? welcome : new Promise(() => undefined),
    )

    await $.session.start({ cwd: "/tmp/session", surface: null, isInteractive: true })
    await clock.advance(0)

    expect(registered).toEqual([
      "create_child",
      "message_child",
      "list_children",
      "read_child",
      "archive_child",
    ])
  })

  test("a Child Session gets only message_parent in their place", async ($, on) => {
    const registered = linkedSession(on, { CLAUDE_HUB_PARENT_SESSION_ID: "s-parent" })
    const clock = mock.clock(on)
    fakeFetch(on, (request) =>
      request.url.endsWith("/mod/hello") ? welcome : new Promise(() => undefined),
    )

    await $.session.start({ cwd: "/tmp/session", surface: null, isInteractive: true })
    await clock.advance(0)

    expect(registered).toEqual(["message_parent"])
  })

  test("message_parent asks the Hub, and says when the parent reads it", async ($, on) => {
    linkedSession(on, { CLAUDE_HUB_PARENT_SESSION_ID: "s-parent" })
    const clock = mock.clock(on)
    const requests = fakeFetch(on, (request) => {
      if (request.url.endsWith("/mod/hello")) return welcome
      if (request.url.endsWith("/mod/children"))
        return {
          status: 200,
          text: JSON.stringify({
            _tag: "ParentMessaged",
            parent: { id: "s-parent", title: "Release 0.4" },
            working: true,
          }),
        }
      return new Promise(() => undefined)
    })
    on("tool.call", () => ({ deny: "core ran it" }))

    await $.session.start({ cwd: "/tmp/session", surface: null, isInteractive: true })
    await clock.advance(0)
    const answer = await $.tool.call({
      tool: "mcp__hub-link__message_parent",
      message: "Should the reference cover the deprecated v0 messages?",
    } as never)

    const asked = requests.find((request) => request.url === `${hubUrl}/mod/children`)
    expect(JSON.parse(asked?.body ?? "")).toEqual({
      _tag: "MessageParent",
      text: "Should the reference cover the deprecated v0 messages?",
    })
    expect(answer.isError).toBeFalsy()
    expect(answer.result).toBe(
      'Queued your message for your Parent Session "Release 0.4" (id s-parent). It reads it once its current Turn ends. Any answer reaches you as a prompt after this Turn ends, and your Report still goes to it then.',
    )
  })

  test("create_child asks the Hub, and answers with the child's id and name", async ($, on) => {
    linkedSession(on)
    const clock = mock.clock(on)
    const child = {
      id: "s-2",
      title: "API docs",
      baseBranch: "main",
      workBranch: "claude/s-2",
      state: "Active",
      working: true,
      queued: 1,
    }
    const requests = fakeFetch(on, (request) => {
      if (request.url.endsWith("/mod/hello")) return welcome
      if (request.url.endsWith("/mod/children"))
        return { status: 200, text: JSON.stringify({ _tag: "ChildCreated", child }) }
      return new Promise(() => undefined)
    })
    let reachedCore = false
    on("tool.call", () => {
      reachedCore = true
      return { deny: "core ran it" }
    })

    await $.session.start({ cwd: "/tmp/session", surface: null, isInteractive: true })
    await clock.advance(0)
    const answer = await $.tool.call({
      tool: "mcp__hub-link__create_child",
      task: "Document the API.",
      name: " API docs ",
    } as never)

    expect(reachedCore).toBe(false)
    const asked = requests.find((request) => request.url === `${hubUrl}/mod/children`)
    expect(JSON.parse(asked?.body ?? "")).toEqual({
      _tag: "CreateChild",
      prompt: "Document the API.",
      name: "API docs",
    })
    expect(answer.isError).toBeFalsy()
    expect(answer.result).toContain('Created Child Session "API docs" (id s-2): Active, working')
  })

  test("a refused request is an error result", async ($, on) => {
    linkedSession(on)
    const clock = mock.clock(on)
    const refused = "Session s-9 is not one of your Child Sessions."
    fakeFetch(on, (request) => {
      if (request.url.endsWith("/mod/hello")) return welcome
      if (request.url.endsWith("/mod/children"))
        return { status: 200, text: JSON.stringify({ _tag: "ChildRefused", message: refused }) }
      return new Promise(() => undefined)
    })
    on("tool.call", () => ({ deny: "core ran it" }))

    await $.session.start({ cwd: "/tmp/session", surface: null, isInteractive: true })
    await clock.advance(0)
    const answer = await $.tool.call({
      tool: "mcp__hub-link__archive_child",
      child_id: "s-9",
    } as never)

    expect(answer.deny).toBe(refused)
  })

  for (const { kind, tag, note } of [
    { kind: "Report", tag: "FromChildSession", note: "Report from Child Session" },
    { kind: "message", tag: "FromChildSessionMessage", note: "Message from Child Session" },
  ])
    test(`a ${kind} starts a Turn as the Hub wrote it, reported as from the Child Session`, async ($, on) => {
      linkedSession(on)
      const clock = mock.clock(on)
      const fromSession = { _tag: tag, session: { id: "s-2", title: "API docs" } }
      const report = `[${note} "API docs" (s-2)]\n\nDone.`
      let polled = 0
      const requests = fakeFetch(on, (request) => {
        if (request.url.endsWith("/mod/hello")) return welcome
        if (request.url.endsWith("/mod/events")) return { status: 204, text: "" }
        polled++
        if (polled > 1) return new Promise(() => undefined)
        const deliver = {
          _tag: "DeliverPrompt",
          sessionId: "s1",
          promptId: "pr-1",
          text: report,
          sender: { id: "p1", login: "ada", name: "Ada Lovelace" },
          fromSession,
        }
        return { status: 200, text: JSON.stringify({ messages: [{ seq: 1, message: deliver }] }) }
      })
      const submitted: Array<string> = []
      on("prompt.submit", (_, e) => {
        submitted.push(e.text)
        return { text: e.text }
      })
      on("turn.start", () => ({ turnId: "t1" }))

      await $.session.start({ cwd: "/tmp/session", surface: null, isInteractive: true })
      await clock.advance(0)
      await $.turn.start({ turnId: "t1", text: report } as never)
      await clock.advance(200)

      expect(submitted).toEqual([report])
      const posted = requests.find((request) => request.url === `${hubUrl}/mod/events`)
      expect(JSON.parse(posted?.body ?? "").messages[0]).toEqual({
        _tag: "TurnStarted",
        turnId: "t1",
        text: report,
        sender: fromSession,
        promptId: "pr-1",
      })
    })
})

const sandbox = {
  CLAUDE_HUB_WORKSPACE: "/workspace",
  CLAUDE_HUB_REPO: "acme/app",
  CLAUDE_HUB_WORK_BRANCH: "claude/fix-login",
}

/** Claude Code's own environment block, as it describes the host. */
const hostEnvironment = [
  "# Environment",
  "You have been invoked in the following environment: ",
  " - Primary working directory: /Users/ada/.claude-hub/sessions/s1/claude",
  " - Is a git repository: false",
  " - Platform: darwin",
  " - Shell: zsh",
  " - OS Version: Darwin 27.0.0",
].join("\n")

const composeInput = {
  model: "claude-test",
  promptModel: "claude-test",
  surfaces: [],
  tools: ["Bash", "Read"],
  outputStyle: null,
  traits: ["lean"],
} satisfies PromptComposeInput

/** Claude Code's own system prompt, as one section. */
const engineSections = (on: On) =>
  on("prompt.compose", () => ({
    sections: [{ id: "env_info_simple", text: "# Environment", scope: "session" }],
  }))

describe("what the model is told about its environment", () => {
  test("the system prompt describes the Sandbox, from the first request", async ($, on) => {
    mock.env(on, sandbox)
    engineSections(on)

    const { sections } = await $.prompt.compose(composeInput)

    const environment = sections.find((section) => section.id === "hub-link:sandbox-environment")
    expect(environment?.scope).toBe("session")
    expect(environment?.text).toContain("Primary working directory: /workspace")
    expect(environment?.text).toContain("Is a git repository: true")
    expect(environment?.text).toContain("Repository: acme/app")
    expect(environment?.text).toContain("Work branch: claude/fix-login")
    expect(environment?.text).toContain("Platform: linux")
    expect(sections.map((section) => section.id)).toEqual([
      "env_info_simple",
      "hub-link:shared-session",
      "hub-link:sandbox-environment",
    ])
  })

  test("Claude Code's description of the host is left out", async ($, on) => {
    mock.env(on, sandbox)
    on("prompt.attachment", (_, e) => ({ text: e.text }))

    const environment = await $.prompt.attachment({
      type: "environment",
      text: hostEnvironment,
      origin: { kind: "engine" },
    })
    const date = await $.prompt.attachment({
      type: "date_change",
      text: "The date is now 2026-10-05.",
      origin: { kind: "engine" },
    })

    expect(environment.text).toBeNull()
    expect(date.text).toBe("The date is now 2026-10-05.")
  })

  test("outside a Runner, Claude Code's own environment stands", async ($, on) => {
    mock.env(on, {})
    engineSections(on)
    on("prompt.attachment", (_, e) => ({ text: e.text }))

    const { sections } = await $.prompt.compose(composeInput)
    const environment = await $.prompt.attachment({
      type: "environment",
      text: hostEnvironment,
      origin: { kind: "engine" },
    })

    expect(sections.map((section) => section.id)).toEqual([
      "env_info_simple",
      "hub-link:shared-session",
    ])
    expect(environment.text).toBe(hostEnvironment)
  })
})

const repoFiles = "/sessions/s1/repo"

/** Answers `$.fs.read` from `files`, rejecting a path not among them as missing. */
const fakeFiles = (on: On, files: Record<string, string>) => {
  const read: Array<string> = []
  on("fs.read", async (_, e) => {
    read.push(e.path)
    const text = files[e.path]
    if (text === undefined) throw new Error(`ENOENT: no such file, open '${e.path}'`)
    return { value: text }
  })
  return read
}

/** What Claude Code loaded from the host, as the engine hands it to `prompt.context`. */
const hostInstructions = [
  { path: "/etc/claude-code/CLAUDE.md", kind: "managed" as const, content: "Policy." },
  { path: "/Users/ada/.claude/CLAUDE.md", kind: "user" as const, content: "Mine." },
]

/** Claude Code's own context: what it was handed. */
const engineContext = (on: On) =>
  on("prompt.context", (_, e) => ({
    blocks: e.blocks,
    ...(e.instructionFiles === undefined ? {} : { instructionFiles: e.instructionFiles }),
  }))

describe("the Repo's CLAUDE.md and skills (#125)", () => {
  test("the Repo's instruction files stand in for the host's, but the managed policy", async ($, on) => {
    mock.env(on, { ...sandbox, CLAUDE_HUB_REPO_FILES: repoFiles })
    const read = fakeFiles(on, {
      [`${repoFiles}/instructions.json`]: JSON.stringify({
        instructions: [
          { path: "/workspace/CLAUDE.md", content: "Use bun." },
          { path: "/workspace/a.md", content: "A.", parent: "/workspace/CLAUDE.md" },
        ],
      }),
    })

    engineContext(on)
    const context = await $.prompt.context({ blocks: [], instructionFiles: hostInstructions })

    expect(read).toEqual([`${repoFiles}/instructions.json`])
    expect(context.instructionFiles).toEqual([
      { path: "/etc/claude-code/CLAUDE.md", kind: "managed", content: "Policy." },
      { path: "/workspace/CLAUDE.md", kind: "project", content: "Use bun." },
      { path: "/workspace/a.md", kind: "project", content: "A.", parent: "/workspace/CLAUDE.md" },
    ])
  })

  test("without the Runner's list, the host's are still left out", async ($, on) => {
    mock.env(on, { ...sandbox, CLAUDE_HUB_REPO_FILES: repoFiles })
    fakeFiles(on, {})

    engineContext(on)
    const context = await $.prompt.context({ blocks: [], instructionFiles: hostInstructions })

    expect(context.instructionFiles).toEqual([hostInstructions[0]])
  })

  test("outside a Runner, Claude Code's own instruction files stand", async ($, on) => {
    mock.env(on, {})
    const read = fakeFiles(on, {})

    engineContext(on)
    const context = await $.prompt.context({ blocks: [], instructionFiles: hostInstructions })

    expect(read).toEqual([])
    expect(context.instructionFiles).toEqual(hostInstructions)
  })

  test("instruction files a hook above made unknown stay unknown", async ($, on) => {
    mock.env(on, { ...sandbox, CLAUDE_HUB_REPO_FILES: repoFiles })
    const read = fakeFiles(on, {})
    engineContext(on)

    const context = await $.prompt.context({ blocks: [{ name: "claudeMd", text: "Rewritten." }] })

    expect(read).toEqual([])
    expect(context).toEqual({ blocks: [{ name: "claudeMd", text: "Rewritten." }] })
  })

  test("a Repo skill points at its directory in the Workspace", async ($, on) => {
    mock.env(on, { ...sandbox, CLAUDE_HUB_REPO_FILES: repoFiles })
    on("skill.prompt", (_, e) => ({ text: e.text }))

    const { text } = await $.skill.prompt({
      skill: "repo:deploy",
      text: `Base directory for this skill: ${repoFiles}/.claude/skills/deploy\n\nShip it.`,
    })

    expect(text).toBe("Base directory for this skill: /workspace/.claude/skills/deploy\n\nShip it.")
  })
})
