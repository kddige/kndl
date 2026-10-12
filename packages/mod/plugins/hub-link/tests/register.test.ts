// hub-link in Claude Code's own mod runtime (`claude plugin test`): the hooks module, loading the
// bundle (`bun run build` first), with the world beneath it, hub-link-commands' state included,
// faked.

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

  test("Claude's question is left to Claude Code, which opens its dialog (#206)", async ($, on) => {
    on("tool.check", () => ({ decision: "ask", reason: "Answer questions?" }))

    const check = await $.tool.check({ tool: "AskUserQuestion", input: { questions: [] } } as never)

    expect(check.decision).toBe("ask")
  })
})

const welcome = { status: 200, text: JSON.stringify({ _tag: "ModWelcome", protocolVersion: 2 }) }

/**
 * A session a Runner started, linked to the Hub. Returns the requests, and the events posted.
 * `model` answers what the session's model is, as Claude Code does.
 */
const linkedSession = (
  on: On,
  model: () => { value: string } | Promise<{ value: string }> = () => ({ value: "claude-test" }),
) => {
  mock.env(on, {
    KNDL_URL: hubUrl,
    KNDL_SESSION_ID: "s1",
    KNDL_MOD_TOKEN: "secret",
    KNDL_CONVERSATION_ID: "0b6d6c1e-2f4a-4c3b-9d8e-7a6b5c4d3e2f",
  })
  on("session.id", () => ({ value: "0b6d6c1e-2f4a-4c3b-9d8e-7a6b5c4d3e2f" }))
  on("session.model", model)
  on("ui.log", () => ({ value: undefined }))
  on("session.start", (_, e) => ({ cwd: e.cwd }))
  const requests = fakeFetch(on, (request) => {
    if (request.url.endsWith("/mod/hello")) return welcome
    if (request.url.endsWith("/mod/events")) return { status: 204, text: "" }
    return new Promise(() => undefined)
  })
  const posted = () =>
    requests
      .filter((request) => request.url === `${hubUrl}/mod/events`)
      .flatMap((request) => JSON.parse(request.body ?? "").messages as Array<{ _tag: string }>)
  return { requests, posted }
}

/** What hub-link-commands says it delivered last. */
const delivered = (on: On, value: unknown) =>
  on("state.get", () => ({ value: { value, version: 1 } }) as never)

const turnEnded = (turnId: string, extra: Record<string, unknown> = {}) =>
  ({ turnId, answer: "", durationMs: 1000, isAborted: false, reason: "answer", ...extra }) as never

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

  test("is off in a background job of Claude Code's, which inherits the mod token (#191)", async ($, on) => {
    mock.env(on, {
      KNDL_URL: hubUrl,
      KNDL_SESSION_ID: "s1",
      KNDL_MOD_TOKEN: "secret",
      CLAUDE_CODE_SESSION_KIND: "bg",
    })
    const lines: Array<string> = []
    on("ui.log", (_, e) => {
      lines.push(e.text)
      return { value: undefined }
    })
    on("session.start", (_, e) => ({ cwd: e.cwd }))
    const requests = fakeFetch(on, () => welcome)
    const clock = mock.clock(on)

    await $.session.start({ cwd: "/tmp/session", surface: null, isInteractive: false })
    await clock.advance(1000)

    expect(requests).toEqual([])
    expect(lines).toEqual(["hub-link: a Claude Code bg process, so not linked to the Hub"])
  })

  test("a claude run inside the Session, as another conversation, isn't linked (#321)", async ($, on) => {
    // It inherits the Session's mod token. Linked, its conversation would become the one the
    // Session resumes when it wakes, and the Session's own would be lost.
    mock.env(on, {
      KNDL_URL: hubUrl,
      KNDL_SESSION_ID: "s1",
      KNDL_MOD_TOKEN: "secret",
      KNDL_CONVERSATION_ID: "0b6d6c1e-2f4a-4c3b-9d8e-7a6b5c4d3e2f",
    })
    on("session.id", () => ({ value: "5f0c2a9e-1d3b-4e6f-8a7c-9b8d7e6f5a4b" }))
    const lines: Array<string> = []
    on("ui.log", (_, e) => {
      lines.push(e.text)
      return { value: undefined }
    })
    on("session.start", (_, e) => ({ cwd: e.cwd }))
    const requests = fakeFetch(on, () => welcome)
    const clock = mock.clock(on)

    await $.session.start({ cwd: "/tmp/session", surface: null, isInteractive: false })
    await clock.advance(1000)

    expect(requests).toEqual([])
    expect(lines).toEqual([
      "hub-link: conversation 5f0c2a9e-1d3b-4e6f-8a7c-9b8d7e6f5a4b isn't the one the Runner launched, so not linked to the Hub",
    ])
  })

  test("says hello with the mod token, and polls for no commands", async ($, on) => {
    const { requests } = linkedSession(on)
    const clock = mock.clock(on)

    await $.session.start({ cwd: "/tmp/session", surface: null, isInteractive: true })
    await clock.advance(1000)

    // hub-link-commands runs the Hub's commands.
    expect(requests.map((request) => request.url)).toEqual([`${hubUrl}/mod/hello`])
    expect(JSON.parse(requests[0]?.body ?? "")).toEqual({
      _tag: "ModHello",
      protocolVersion: 2,
      sessionId: "s1",
      claudeSessionId: "0b6d6c1e-2f4a-4c3b-9d8e-7a6b5c4d3e2f",
      model: "claude-test",
      steers: true,
      attaches: true,
    })
  })

  test("posts a Turn's events in one batch", async ($, on) => {
    const { requests, posted } = linkedSession(on)
    const clock = mock.clock(on)
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
    await $.turn.complete(turnEnded("t1", { answer: "done", durationMs: 1200 }))
    await clock.advance(200)

    expect(requests.filter((request) => request.url === `${hubUrl}/mod/events`)).toHaveLength(1)
    expect(posted()).toEqual([
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
    ])
  })

  test("a Bash call a Stop moved to the background has no outcome (#165)", async ($, on) => {
    const { posted } = linkedSession(on)
    const clock = mock.clock(on)
    on("turn.start", () => ({ turnId: "t1" }))
    on("turn.complete", () => ({ text: "" }))
    on(
      "tool.call",
      () =>
        ({
          result: {
            stdout: "",
            stderr: "",
            interrupted: false,
            backgroundTaskId: "b1",
            backgroundedByTurnAbort: true,
          },
        }) as never,
    )

    await $.session.start({ cwd: "/tmp/session", surface: null, isInteractive: true })
    await clock.advance(0)
    await $.turn.start({ turnId: "t1", text: "sleep a minute" } as never)
    await $.tool.call({ tool: "Bash", command: "sleep 60", tool_use_id: "toolu_1" } as never)
    await $.turn.complete(turnEnded("t1", { reason: "aborted", isAborted: true }))
    await clock.advance(200)

    expect(posted().map((event) => event._tag)).toEqual([
      "TurnStarted",
      "ToolCallStarted",
      "TurnEnded",
    ])
    expect(posted().at(-1)).toMatchObject({ reason: "Stopped" })
  })
})

describe("who a Turn is from", () => {
  const ada = { id: "p1", login: "ada", name: "Ada Lovelace" }

  test("the prompt hub-link-commands delivered is its sender's, for one Turn", async ($, on) => {
    const { posted } = linkedSession(on)
    const clock = mock.clock(on)
    const text = "[Ada Lovelace] Split the release notes."
    delivered(on, { promptId: "pr-1", sender: ada, text })
    on("turn.start", (_, e) => ({ turnId: e.turnId }))

    await $.session.start({ cwd: "/tmp/session", surface: null, isInteractive: true })
    await clock.advance(0)
    await $.turn.start({ turnId: "t1", text } as never)
    await $.turn.start({ turnId: "t2", text: "and the changelog" } as never)
    await clock.advance(200)

    expect(posted()).toEqual([
      {
        _tag: "TurnStarted",
        turnId: "t1",
        text,
        sender: { _tag: "FromParticipant", participant: ada },
        promptId: "pr-1",
      },
      {
        _tag: "TurnStarted",
        turnId: "t2",
        text: "and the changelog",
        sender: { _tag: "FromTerminal" },
      },
    ])
  })

  test("a Turn that starts before the link does is still posted, as its prompt's", async ($, on) => {
    // A woken Session: hub-link-commands says hello first, and the Hub delivers the queued prompt
    // while hub-link still reads what its hello says. Lost, its prompt stayed queued for good.
    let answerModel: ((model: { value: string }) => void) | undefined
    const model = new Promise<{ value: string }>((resolve) => (answerModel = resolve))
    const { posted } = linkedSession(on, () => model)
    const clock = mock.clock(on)
    const text = "[Ada Lovelace] yo"
    delivered(on, { promptId: "pr-1", sender: ada, text })
    on("turn.start", (_, e) => ({ turnId: e.turnId }))

    const started = $.session.start({ cwd: "/tmp/session", surface: null, isInteractive: true })
    const turn = $.turn.start({ turnId: "t1", text } as never)
    await clock.advance(50)
    answerModel?.({ value: "claude-test" })
    await Promise.all([started, turn])
    await clock.advance(200)

    expect(posted()).toEqual([
      {
        _tag: "TurnStarted",
        turnId: "t1",
        text,
        sender: { _tag: "FromParticipant", participant: ada },
        promptId: "pr-1",
      },
    ])
  })

  test("the prompt delivered with files tells Claude out of sight to open them, once (#276)", async ($, on) => {
    const text = "[Ada Lovelace] What broke?\n[Image #1: shot.png (attachment att-1)]"
    const context = "This message has 1 image attached. …"
    delivered(on, { promptId: "pr-1", sender: ada, text, context })
    const submitted: Array<unknown> = []
    on("prompt.submit", (_, e) => {
      submitted.push(e.context)
      return { text: e.text }
    })

    on("turn.start", (_, e) => ({ turnId: e.turnId }))

    await $.prompt.submit({ text } as never)
    await $.turn.start({ turnId: "t1", text } as never)
    await $.prompt.submit({ text: "typed at the terminal" } as never)
    // The same text again, from the terminal's history, is the terminal's.
    await $.prompt.submit({ text } as never)

    expect(submitted).toEqual([[context], undefined, undefined])
  })

  test("a turn started from the delivered prompt with files is still its sender's (#276)", async ($, on) => {
    const { posted } = linkedSession(on)
    const clock = mock.clock(on)
    const text = "[Ada Lovelace] [Image #1: shot.png (attachment att-1)]"
    delivered(on, { promptId: "pr-1", sender: ada, text, context: "Open it." })
    on("turn.start", (_, e) => ({ turnId: e.turnId }))

    await $.session.start({ cwd: "/tmp/session", surface: null, isInteractive: true })
    await clock.advance(0)
    await $.turn.start({ turnId: "t1", text } as never)
    await clock.advance(200)

    expect(posted()).toEqual([
      expect.objectContaining({
        _tag: "TurnStarted",
        sender: { _tag: "FromParticipant", participant: ada },
        promptId: "pr-1",
      }),
    ])
  })

  test("a background agent's task notification is from the agent", async ($, on) => {
    const { posted } = linkedSession(on)
    const clock = mock.clock(on)
    // A delivered prompt the notification came ahead of waits for its own Turn.
    delivered(on, { promptId: "pr-1", sender: ada, text: "[Ada Lovelace] Next." })
    on("turn.start", (_, e) => ({ turnId: e.turnId }))
    const text =
      "<task-notification>\n<task-id>a1</task-id>\n<status>completed</status>\n</task-notification>"

    await $.session.start({ cwd: "/tmp/session", surface: null, isInteractive: true })
    await clock.advance(0)
    await $.turn.start({ turnId: "t1", text } as never)
    await clock.advance(200)

    expect(posted()).toEqual([
      { _tag: "TurnStarted", turnId: "t1", text, sender: { _tag: "FromAgent", agentId: "a1" } },
    ])
  })
})

describe("a prompt steered into the running Turn (#195)", () => {
  const ada = { id: "p1", login: "ada", name: "Ada Lovelace" }
  const framed = [
    "<system-reminder>",
    "Ada Lovelace sent a new message while you were working:",
    "[Ada Lovelace] Also the changelog.",
    "",
    "Address the message above as you continue this turn.",
    "</system-reminder>",
  ].join("\n")

  // A kept row is reported as joining the Turn; `claude plugin test` has nothing beneath
  // session.append to keep one, so the refusals are what is tested here.
  test("is refused once the Turn has ended, so it waits in the queue", async ($, on) => {
    const { posted } = linkedSession(on)
    const clock = mock.clock(on)
    on("state.get", (_, e) => {
      const value =
        e.key === "steering"
          ? { promptId: "pr-2", sender: ada, text: "Also the changelog.", appended: framed }
          : null
      return { value: { value, version: 1 } } as never
    })
    on("turn.start", (_, e) => ({ turnId: e.turnId }))
    on("turn.complete", () => ({ text: "done" }) as never)

    await $.session.start({ cwd: "/tmp/session", surface: null, isInteractive: true })
    await clock.advance(0)
    await $.turn.start({ turnId: "t1", text: "long job" } as never)
    await $.turn.complete(turnEnded("t1"))
    const appended = await $.session.append({
      message: {
        type: "user",
        role: "user",
        isMeta: true,
        content: [{ type: "text", text: framed }],
      },
      door: "note",
      origin: { kind: "plugin", plugin: "hub-link-commands" },
      uuid: "u1",
    } as never)
    await clock.advance(200)

    expect(appended).toEqual({ deny: "the Turn ended before the prompt could join it" })
    expect(posted().map((event) => event._tag)).toEqual(["TurnStarted", "TurnEnded"])
  })
})

const spawnInput = (extra: Record<string, unknown> = {}) =>
  ({
    tool_use_id: "toolu_agent",
    prompt: "Read the README.",
    description: "Read the README",
    subagentType: "general-purpose",
    background: true,
    ...extra,
  }) as never

describe("subagents (ADR 0014)", () => {
  test("one is reported under its Agent call, Running, then Done", async ($, on) => {
    const { posted } = linkedSession(on)
    const clock = mock.clock(on)
    on("turn.start", (_, e) => ({ turnId: e.turnId }))
    on("agent.spawn", () => ({ model: "claude-haiku", agentId: "a1" }))
    on("classic.SubagentStop", () => ({}))

    await $.session.start({ cwd: "/tmp/session", surface: null, isInteractive: true })
    await clock.advance(0)
    await $.turn.start({ turnId: "t1", text: "look around" } as never)
    await $.agent.spawn(spawnInput())
    await $.classic.SubagentStop({ agent_id: "a1", agent_type: "general-purpose" } as never)
    await clock.advance(200)

    expect(posted().slice(1)).toEqual([
      {
        _tag: "AgentStarted",
        turnId: "t1",
        agentId: "a1",
        toolCallId: "toolu_agent",
        agentType: "general-purpose",
        description: "Read the README",
        model: "claude-haiku",
        background: true,
      },
      { _tag: "AgentStatusChanged", agentId: "a1", status: "Running" },
      { _tag: "AgentStatusChanged", agentId: "a1", status: "Done" },
    ])
  })

  test("one that started before its spawn resolved keeps its worktree", async ($, on) => {
    const { posted } = linkedSession(on)
    const clock = mock.clock(on)
    on("turn.start", (_, e) => ({ turnId: e.turnId }))
    on("classic.SubagentStart", () => ({}))
    on("agent.spawn", async () => {
      await $.classic.SubagentStart({
        agent_id: "a1",
        agent_type: "general-purpose",
        cwd: "/workspace/.claude/worktrees/agent-a1",
      } as never)
      return { model: "claude-haiku", agentId: "a1" }
    })

    await $.session.start({ cwd: "/tmp/session", surface: null, isInteractive: true })
    await clock.advance(0)
    await $.turn.start({ turnId: "t1", text: "look around" } as never)
    await $.agent.spawn(spawnInput())
    await clock.advance(200)

    const worktree = {
      path: "/workspace/.claude/worktrees/agent-a1",
      branch: "worktree-agent-a1",
    }
    expect(posted().slice(-2)).toEqual([
      expect.objectContaining({ _tag: "AgentStarted", agentId: "a1" }),
      { _tag: "AgentStatusChanged", agentId: "a1", status: "Running", worktree },
    ])
  })

  test("one whose run TaskStop aborted is Stopped", async ($, on) => {
    const { posted } = linkedSession(on)
    const clock = mock.clock(on)
    on("turn.complete", () => ({ text: "" }))

    await $.session.start({ cwd: "/tmp/session", surface: null, isInteractive: true })
    await clock.advance(0)
    await $.turn.complete(turnEnded("r1", { agentId: "a1", reason: "aborted" }))
    await clock.advance(200)

    expect(posted()).toEqual([
      { _tag: "TurnEnded", turnId: "r1", agentId: "a1", reason: "Stopped", durationMs: 1000 },
      { _tag: "AgentStatusChanged", agentId: "a1", status: "Stopped" },
    ])
  })

  test("one TaskStop stopped is Stopped once, its run ending or not", async ($, on) => {
    const { posted } = linkedSession(on)
    const clock = mock.clock(on)
    on("tool.call", () => ({
      result: { message: "Stopped", task_id: "a1", task_type: "local_agent" },
    }))
    on("turn.complete", () => ({ text: "" }))

    await $.session.start({ cwd: "/tmp/session", surface: null, isInteractive: true })
    await clock.advance(0)
    // By name, as the model may: the result names it by id.
    await $.tool.call({ tool: "TaskStop", task_id: "watcher" })
    await $.turn.complete(turnEnded("r1", { agentId: "a1", reason: "aborted" }))
    await clock.advance(200)

    expect(posted().filter((event) => event._tag === "AgentStatusChanged")).toEqual([
      { _tag: "AgentStatusChanged", agentId: "a1", status: "Stopped" },
    ])
  })

  test("a teammate is not reported", async ($, on) => {
    const { posted } = linkedSession(on)
    const clock = mock.clock(on)
    on("turn.start", (_, e) => ({ turnId: e.turnId }))
    on("agent.spawn", () => ({ model: "claude-haiku", agentId: "a1" }))

    await $.session.start({ cwd: "/tmp/session", surface: null, isInteractive: true })
    await clock.advance(0)
    await $.turn.start({ turnId: "t1", text: "form a team" } as never)
    await $.agent.spawn(spawnInput({ isTeammate: true }))
    await clock.advance(200)

    expect(posted().map((event) => event._tag)).toEqual(["TurnStarted"])
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
    expect(shared?.text).toContain("shared through kndl")
  })
})
