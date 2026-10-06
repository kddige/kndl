// hub-link in Claude Code's own mod runtime (`claude plugin test`): the hooks module, loading the
// bundle (`bun run build` first), with the world beneath it faked.

import type { On, PromptComposeInput } from "claude-code"
import { describe, expect, mock, test } from "claude-code/testing"

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

describe("tools", () => {
  test("Claude Code runs every tool, in the Sandbox (ADR 0013)", async ($, on) => {
    mock.env(on, {})
    const called: Array<string> = []
    on("tool.call", (_, e) => {
      called.push(String(e.tool))
      return { result: { stdout: "hello from the vm", stderr: "", interrupted: false } } as never
    })

    const bash = await $.tool.call({ tool: "Bash", command: "echo hello", description: "say hi" })
    const fetched = await $.tool.call({ tool: "WebFetch", url: "https://example.com", prompt: "x" })
    const agent = await $.tool.call({
      tool: "Agent",
      description: "x",
      prompt: "x",
      subagent_type: "general-purpose",
    } as never)

    expect(called).toEqual(["Bash", "WebFetch", "Agent"])
    for (const answer of [bash, fetched, agent]) expect(answer.deny).toBeUndefined()
    expect(bash.result).toMatchObject({ stdout: "hello from the vm" })
  })

  test("a tool Claude Code refuses stays refused", async ($, on) => {
    mock.env(on, {})
    on("tool.call", () => ({ deny: "no such file" }))

    const answer = await $.tool.call({ tool: "Read", file_path: "/workspace/missing.txt" })

    expect(answer.deny).toBe("no such file")
  })

  test("every tool is allowed without asking (ADR 0004)", async ($, on) => {
    on("tool.check", () => ({ decision: "ask", reason: "Bash requires permission." }))

    for (const tool of ["Bash", "WebFetch", "Agent", "mcp__github__create_issue"])
      expect((await $.tool.check({ tool, input: {} } as never)).decision).toBe("allow")
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
    })
    const clock = mock.clock(on)
    on("session.id", () => ({ value: "claude-1" }))
    on("session.model", () => ({ value: "claude-test" }))
    on("ui.log", () => ({ value: undefined }))
    const requests = fakeFetch(on, (request) => {
      if (request.url.endsWith("/mod/hello"))
        return { status: 200, text: JSON.stringify({ _tag: "ModWelcome", protocolVersion: 1 }) }
      if (request.url.endsWith("/mod/events")) return { status: 204, text: "" }
      return new Promise(() => undefined)
    })
    on("session.start", (_, e) => ({ cwd: e.cwd }))
    on("turn.start", () => ({ turnId: "t1" }))
    on("turn.complete", () => ({ text: "done" }))
    on(
      "tool.call",
      () => ({ result: { stdout: "a.txt", stderr: "", interrupted: false } }) as never,
    )

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

  // A new Session's first prompt is queued at the Hub before its Claude Code starts, and a Turn
  // only has the tools that were registered when it started.
  test("the tools are registered before the link can deliver a prompt (#139)", async ($, on) => {
    const registered = linkedSession(on)
    const clock = mock.clock(on)
    const registeredAtFetch: Array<number> = []
    let polled = 0
    fakeFetch(on, (request) => {
      registeredAtFetch.push(registered.length)
      if (request.url.endsWith("/mod/hello")) return welcome
      if (request.url.endsWith("/mod/events")) return { status: 204, text: "" }
      polled++
      if (polled > 1) return new Promise(() => undefined)
      const deliver = {
        _tag: "DeliverPrompt",
        sessionId: "s1",
        promptId: "pr-1",
        text: "Split the release notes.",
        sender: { id: "p1", login: "ada", name: "Ada Lovelace" },
      }
      return { status: 200, text: JSON.stringify({ messages: [{ seq: 1, message: deliver }] }) }
    })
    const registeredAtSubmit: Array<number> = []
    on("prompt.submit", (_, e) => {
      registeredAtSubmit.push(registered.length)
      return { text: e.text }
    })

    await $.session.start({ cwd: "/tmp/session", surface: null, isInteractive: true })
    await clock.advance(0)

    // All five, from the Hub's first request on.
    expect(registeredAtSubmit).toEqual([5])
    expect(registeredAtFetch.length).toBeGreaterThan(0)
    expect(registeredAtFetch.every((count) => count === 5)).toBe(true)
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

const composeInput = {
  model: "claude-test",
  promptModel: "claude-test",
  surfaces: [],
  tools: ["Bash", "Read"],
  outputStyle: null,
  traits: ["lean"],
} satisfies PromptComposeInput

describe("what the model is told", () => {
  test("the system prompt says the Session is shared, after Claude Code's own", async ($, on) => {
    on("prompt.compose", () => ({
      sections: [{ id: "env_info_simple", text: "# Environment", scope: "session" }],
    }))

    const { sections } = await $.prompt.compose(composeInput)

    expect(sections.map((section) => section.id)).toEqual([
      "env_info_simple",
      "hub-link:shared-session",
    ])
    const shared = sections.find((section) => section.id === "hub-link:shared-session")
    expect(shared?.scope).toBe("session")
    expect(shared?.text).toContain("shared through Claude Hub")
  })
})
