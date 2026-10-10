// hub-link-commands in Claude Code's own mod runtime (`claude plugin test`): the hooks module,
// loading the bundle (`bun run build` first), with the world beneath it and the Hub faked.

import type { On } from "claude-code"
import { describe, expect, mock, test } from "claude-code/testing"

const hubUrl = "http://hub.test"

type Fetched = { url: string; body?: string }

const welcome = { status: 200, text: JSON.stringify({ _tag: "ModWelcome", protocolVersion: 2 }) }

/** The Hub's answer to a fetch. */
const answer = (status: number, text: string) => ({
  value: { status, ok: status >= 200 && status < 300, headers: {}, text },
})

/**
 * A session a Runner started, linked to a Hub whose first poll answers `commands` once `ready`
 * settles, and whose later ones are held, as its long poll does; it answers for the attachments in
 * `files`, by id and then offset, and 404 for any other. Returns the requests, and the events posted.
 */
const linkedSession = (
  on: On,
  commands: Array<Record<string, unknown>> = [],
  ready: Promise<void> = Promise.resolve(),
  env: Record<string, string> = {},
  files: Record<string, Record<number, Record<string, unknown>>> = {},
) => {
  mock.env(on, {
    KNDL_URL: hubUrl,
    KNDL_SESSION_ID: "s1",
    KNDL_MOD_TOKEN: "secret",
    ...env,
  })
  on("session.id", () => ({ value: "0b6d6c1e-2f4a-4c3b-9d8e-7a6b5c4d3e2f" }))
  on("session.model", () => ({ value: "claude-test" }))
  on("ui.log", () => ({ value: undefined }))
  on("session.start", (_, e) => ({ cwd: e.cwd }))
  const requests: Array<Fetched> = []
  let polled = 0
  on("http.fetch", async (_, e) => {
    requests.push({
      url: e.url,
      ...(typeof e.init?.body === "string" ? { body: e.init.body } : {}),
    })
    if (e.url.endsWith("/mod/hello")) return answer(welcome.status, welcome.text)
    if (e.url.endsWith("/mod/events")) return answer(204, "")
    const [, attachment, offset] = /\/mod\/attachments\/([^?]+)\?offset=(\d+)$/.exec(e.url) ?? []
    if (attachment !== undefined) {
      const file = files[attachment]?.[Number(offset)]
      return file === undefined
        ? answer(404, JSON.stringify({ error: "There is no such attachment." }))
        : answer(200, JSON.stringify(file))
    }
    polled++
    if (polled > 1) return new Promise(() => undefined)
    await ready
    const messages = commands.map((message, index) => ({ seq: index + 1, message }))
    return answer(200, JSON.stringify({ messages }))
  })
  const posted = () =>
    requests
      .filter((request) => request.url === `${hubUrl}/mod/events`)
      .flatMap((request) => JSON.parse(request.body ?? "").messages as Array<unknown>)
  return { requests, posted }
}

const ada = { id: "p1", login: "ada", name: "Ada Lovelace" }

/** What the plugin says it delivered, each time it says it. */
const deliveredWrites = (on: On) => {
  const writes: Array<unknown> = []
  on("state.set", { plugin: "hub-link-commands", key: "delivered" }, (_, e, next) => {
    writes.push(e.value)
    return next(e)
  })
  return writes
}

describe("the Hub link", () => {
  test("says hello with the mod token, then polls for commands", async ($, on) => {
    const { requests } = linkedSession(on)
    const clock = mock.clock(on)

    await $.session.start({ cwd: "/tmp/session", surface: null, isInteractive: true })
    await clock.advance(0)

    expect(requests[0]?.url).toBe(`${hubUrl}/mod/hello`)
    expect(JSON.parse(requests[0]?.body ?? "")).toEqual({
      _tag: "ModHello",
      protocolVersion: 2,
      sessionId: "s1",
      claudeSessionId: "0b6d6c1e-2f4a-4c3b-9d8e-7a6b5c4d3e2f",
      model: "claude-test",
      steers: true,
    })
    expect(requests[1]?.url).toBe(`${hubUrl}/mod/commands?after=0&waitMs=25000`)
  })

  test("runs no commands in a background job of Claude Code's (#191)", async ($, on) => {
    const prompt = { _tag: "DeliverPrompt", promptId: "q1", sender: ada, text: "hi" }
    const { requests } = linkedSession(on, [prompt], undefined, {
      CLAUDE_CODE_SESSION_KIND: "bg",
    })
    const clock = mock.clock(on)

    await $.session.start({ cwd: "/tmp/session", surface: null, isInteractive: false })
    await clock.advance(1000)

    expect(requests).toEqual([])
  })

  test("shows the Participants the Hub reports in the band above the prompt", async ($, on) => {
    linkedSession(on, [
      {
        _tag: "PresenceChanged",
        sessionId: "s1",
        participants: [
          ada,
          { id: "p2", login: "alan", name: "Alan Turing", forwardingFrom: ["macbook"] },
        ],
      },
    ])
    const clock = mock.clock(on)

    await $.session.start({ cwd: "/tmp/session", surface: null, isInteractive: true })
    await clock.advance(0)
    const band = await $.ui.mount({
      plugin: "hub-link-commands",
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

    expect(
      await band.find({ text: /Ada Lovelace, Alan Turing \(forwarding from macbook\)/ }),
    ).toBeDefined()
  })
})

describe("prompts", () => {
  const deliver = {
    _tag: "DeliverPrompt",
    sessionId: "s1",
    promptId: "pr-1",
    text: "Split the release notes.",
    sender: ada,
  }

  test("one from the queue is said to be delivered, then submitted with its sender's name", async ($, on) => {
    linkedSession(on, [deliver])
    const clock = mock.clock(on)
    const writes = deliveredWrites(on)
    const submitted: Array<{ text: string; delivered: Array<unknown> }> = []
    on("prompt.submit", (_, e) => {
      submitted.push({ text: e.text, delivered: [...writes] })
      return { text: e.text }
    })

    await $.session.start({ cwd: "/tmp/session", surface: null, isInteractive: true })
    await clock.advance(0)

    const text = "[Ada Lovelace] Split the release notes."
    expect(submitted).toEqual([{ text, delivered: [{ promptId: "pr-1", sender: ada, text }] }])
  })

  test("one a hook drops fails, and is no longer said to be delivered", async ($, on) => {
    const { posted } = linkedSession(on, [deliver])
    const clock = mock.clock(on)
    const writes = deliveredWrites(on)
    on("prompt.submit", () => ({ drop: "not now" }))

    await $.session.start({ cwd: "/tmp/session", surface: null, isInteractive: true })
    await clock.advance(200)

    expect(posted()).toEqual([
      {
        _tag: "PromptFailed",
        promptId: "pr-1",
        message: "a hook dropped the prompt: not now",
      },
    ])
    expect(writes.at(-1)).toBeNull()
  })

  test("StopTurn stops the Turn on the main loop", async ($, on) => {
    let turnStarted: (() => void) | undefined
    linkedSession(
      on,
      [{ _tag: "StopTurn", sessionId: "s1" }],
      new Promise((resolve) => (turnStarted = resolve)),
    )
    const clock = mock.clock(on)
    on("turn.start", (_, e) => ({ turnId: e.turnId }))
    const aborted: Array<string> = []
    on("turn.abort", (_, e) => {
      aborted.push(e.turnId)
      return {} as never
    })

    await $.session.start({ cwd: "/tmp/session", surface: null, isInteractive: true })
    await clock.advance(0)
    await $.turn.start({ turnId: "t1", text: "long job" } as never)
    turnStarted?.()
    await clock.advance(0)

    expect(aborted).toEqual(["t1"])
  })
})

/** What the plugin says it is steering, each time it says it. */
function steeringWrites(on: On) {
  const writes: Array<unknown> = []
  on("state.set", { plugin: "hub-link-commands", key: "steering" }, (_, e, next) => {
    writes.push(e.value)
    return next(e)
  })
  return writes
}

describe("steering a prompt into the running Turn (#195)", () => {
  const steer = {
    _tag: "DeliverIntoTurn",
    sessionId: "s1",
    promptId: "pr-2",
    text: "Also the changelog.",
    sender: ada,
  }

  test("fails with no Turn running, adding nothing", async ($, on) => {
    const { posted } = linkedSession(on, [steer])
    const clock = mock.clock(on)
    const writes = steeringWrites(on)

    await $.session.start({ cwd: "/tmp/session", surface: null, isInteractive: true })
    await clock.advance(200)

    expect(posted()).toEqual([
      { _tag: "PromptFailed", promptId: "pr-2", message: "no Turn is running" },
    ])
    expect(writes).toEqual([])
  })

  // The row itself is Claude Code's to keep: `claude plugin test` has nothing beneath a plugin's
  // own session.append (a test's hook there is skipped), so it fails here, as a refused one does.
  test("says what it steers while it adds the row, and reports a row not kept", async ($, on) => {
    let turnStarted: (() => void) | undefined
    const { posted } = linkedSession(on, [steer], new Promise((resolve) => (turnStarted = resolve)))
    const clock = mock.clock(on)
    const writes = steeringWrites(on)
    on("turn.start", (_, e) => ({ turnId: e.turnId }))

    await $.session.start({ cwd: "/tmp/session", surface: null, isInteractive: true })
    await clock.advance(0)
    await $.turn.start({ turnId: "t1", text: "long job" } as never)
    turnStarted?.()
    await clock.advance(200)

    expect(writes).toEqual([{ promptId: "pr-2", sender: ada, text: "Also the changelog." }, null])
    expect(posted()).toEqual([
      {
        _tag: "PromptFailed",
        promptId: "pr-2",
        message: expect.stringContaining("session.append"),
      },
    ])
  })
})

describe("subagents (ADR 0014)", () => {
  test("a message goes to the agent with its sender's name", async ($, on) => {
    const { posted } = linkedSession(on, [
      {
        _tag: "DeliverAgentMessage",
        sessionId: "s1",
        agentId: "a1",
        text: "Stop at 3.",
        sender: ada,
      },
    ])
    const clock = mock.clock(on)
    const sent: Array<{ to: string; text: string }> = []
    on("session.send", (_, e) => {
      sent.push({ to: e.to, text: e.text })
      return { isDelivered: true }
    })

    await $.session.start({ cwd: "/tmp/session", surface: null, isInteractive: true })
    await clock.advance(200)

    expect(sent).toEqual([{ to: expect.stringContaining("a1"), text: "[Ada Lovelace] Stop at 3." }])
    expect(posted()).toEqual([])
  })

  test("a message Claude Code can't deliver is reported to its sender", async ($, on) => {
    const { posted } = linkedSession(on, [
      { _tag: "DeliverAgentMessage", sessionId: "s1", agentId: "a9", text: "Hi.", sender: ada },
    ])
    const clock = mock.clock(on)
    on("session.send", () => ({ isDelivered: false, reason: "no agent a9" }))

    await $.session.start({ cwd: "/tmp/session", surface: null, isInteractive: true })
    await clock.advance(200)

    expect(posted()).toEqual([
      {
        _tag: "AgentCommandFailed",
        agentId: "a9",
        command: "MessageAgent",
        senderId: "p1",
        message: "no agent a9",
      },
    ])
  })

  test("StopAgent stops it with TaskStop, and says when that's refused", async ($, on) => {
    const { posted } = linkedSession(on, [
      { _tag: "StopAgent", sessionId: "s1", agentId: "a1" },
      { _tag: "StopAgent", sessionId: "s1", agentId: "a2" },
    ])
    const clock = mock.clock(on)
    const stopped: Array<unknown> = []
    on("tool.call", (_, e) => {
      stopped.push(e)
      const taskId = (e as unknown as { task_id: string }).task_id
      return (taskId === "a1" ? { result: "stopped" } : { deny: "no task a2" }) as never
    })

    await $.session.start({ cwd: "/tmp/session", surface: null, isInteractive: true })
    await clock.advance(200)

    expect(stopped).toEqual([
      expect.objectContaining({ tool: "TaskStop", task_id: "a1" }),
      expect.objectContaining({ tool: "TaskStop", task_id: "a2" }),
    ])
    expect(posted()).toEqual([
      { _tag: "AgentCommandFailed", agentId: "a2", command: "StopAgent", message: "no task a2" },
    ])
  })
})

/**
 * A session whose Hub answers the first AskUserQuestion call with `webAnswer` from Ada, once
 * Claude Code's dialog for it is open; the dialog answers with `atTerminal`, or stays open.
 * Returns the call's id, the dialog's signal, and the events posted.
 */
const askedSession = (
  on: On,
  webAnswer: Record<string, unknown>,
  atTerminal?: Record<string, unknown>,
) => {
  const commands: Array<Record<string, unknown>> = []
  let opened: ((id: string) => void) | undefined
  const dialog = { id: "", signal: undefined as AbortSignal | undefined }
  const { posted } = linkedSession(
    on,
    commands,
    new Promise<void>((resolve) => {
      opened = (id) => {
        commands.push({
          _tag: "DeliverAnswer",
          sessionId: "s1",
          toolCallId: id,
          answer: webAnswer,
          sender: ada,
        })
        resolve()
      }
    }),
  )
  on("turn.start", (_, e) => ({ turnId: e.turnId }))
  on("tool.call", (_, e, next) => {
    dialog.id = e.tool_use_id ?? ""
    dialog.signal = next.signal
    opened?.(dialog.id)
    return (atTerminal === undefined ? new Promise(() => undefined) : atTerminal) as never
  })
  return { dialog, posted }
}

describe("Open questions (#193)", () => {
  /** What the dialog's call ends with once its Turn is stopped. */
  const refused = "Error: The user doesn't want to proceed with this tool use."
  const questions = [
    {
      question: "Which library?",
      header: "Library",
      options: [
        { label: "date-fns", description: "Small and familiar" },
        { label: "Temporal", description: "The platform's own" },
      ],
      multiSelect: false,
    },
  ]
  const asked = {
    _tag: "QuestionAsked",
    turnId: "t1",
    questions: [
      {
        question: "Which library?",
        header: "Library",
        options: [
          { label: "date-fns", description: "Small and familiar" },
          { label: "Temporal", description: "The platform's own" },
        ],
        multiSelect: false,
      },
    ],
  }

  test("a Participant's answer is Claude's, and closes the dialog", async ($, on) => {
    const { dialog, posted } = askedSession(on, {
      _tag: "Answered",
      answers: { "Which library?": "Temporal" },
    })
    const clock = mock.clock(on)

    await $.session.start({ cwd: "/tmp/session", surface: null, isInteractive: true })
    await clock.advance(0)
    await $.turn.start({ turnId: "t1", text: "Pick a date library." } as never)
    const call = $.tool.call({ tool: "AskUserQuestion", questions } as never)
    await clock.advance(200)

    expect(await call).toEqual(
      expect.objectContaining({
        result: expect.objectContaining({
          answers: { "Which library?": "Temporal" },
          annotations: {},
        }),
      }),
    )
    expect(dialog.signal?.aborted).toBe(true)
    expect(posted()).toEqual([
      { ...asked, toolCallId: dialog.id },
      {
        _tag: "QuestionClosed",
        turnId: "t1",
        toolCallId: dialog.id,
        outcome: { _tag: "Answered", answers: { "Which library?": "Temporal" } },
        by: ada,
      },
    ])
  })

  test("one dismissed is refused, as Esc refuses it", async ($, on) => {
    const { dialog, posted } = askedSession(on, { _tag: "Dismissed" })
    const clock = mock.clock(on)

    await $.session.start({ cwd: "/tmp/session", surface: null, isInteractive: true })
    await clock.advance(0)
    await $.turn.start({ turnId: "t1", text: "Pick a date library." } as never)
    const call = $.tool.call({ tool: "AskUserQuestion", questions } as never)
    await clock.advance(200)

    expect(await call).toEqual(
      expect.objectContaining({
        deny: expect.stringContaining("The user doesn't want to proceed with this tool use."),
      }),
    )
    expect(posted().at(-1)).toEqual({
      _tag: "QuestionClosed",
      turnId: "t1",
      toolCallId: dialog.id,
      outcome: { _tag: "Dismissed" },
      by: ada,
    })
  })

  test("one answered at the terminal first is reported, and a later one refused", async ($, on) => {
    const atTerminal = {
      result: { questions, answers: { "Which library?": "date-fns" }, annotations: {} },
    }
    const { dialog, posted } = askedSession(on, { _tag: "Replied", text: "Neither" }, atTerminal)
    const clock = mock.clock(on)

    await $.session.start({ cwd: "/tmp/session", surface: null, isInteractive: true })
    await clock.advance(0)
    await $.turn.start({ turnId: "t1", text: "Pick a date library." } as never)
    const done = await $.tool.call({ tool: "AskUserQuestion", questions } as never)
    await clock.advance(200)

    expect(done).toEqual(expect.objectContaining(atTerminal))
    expect(posted()).toEqual([
      { ...asked, toolCallId: dialog.id },
      {
        _tag: "QuestionClosed",
        turnId: "t1",
        toolCallId: dialog.id,
        outcome: { _tag: "Answered", answers: { "Which library?": "date-fns" } },
      },
      {
        _tag: "AnswerFailed",
        toolCallId: dialog.id,
        senderId: "p1",
        message: "The question was answered or closed already.",
      },
    ])
  })

  test("one dismissed with Esc at the terminal, which stops the Turn, is dismissed (#206)", async ($, on) => {
    const escaped = { isError: true, result: refused }
    const { dialog, posted } = askedSession(on, { _tag: "Dismissed" }, escaped)
    const clock = mock.clock(on)

    await $.session.start({ cwd: "/tmp/session", surface: null, isInteractive: true })
    await clock.advance(0)
    await $.turn.start({ turnId: "t1", text: "Pick a date library." } as never)
    await $.tool.call({ tool: "AskUserQuestion", questions } as never)
    await clock.advance(200)

    expect(posted()[1]).toEqual({
      _tag: "QuestionClosed",
      turnId: "t1",
      toolCallId: dialog.id,
      outcome: { _tag: "Dismissed" },
    })
  })

  test("one whose Turn is stopped from the web UI is cancelled (#206)", async ($, on) => {
    let opened: (() => void) | undefined
    const { posted } = linkedSession(
      on,
      [{ _tag: "StopTurn", sessionId: "s1" }],
      new Promise((resolve) => (opened = resolve)),
    )
    const clock = mock.clock(on)
    on("turn.start", (_, e) => ({ turnId: e.turnId }))
    // Claude Code's Stop ends the dialog's call refused, as Esc does.
    let stop: (() => void) | undefined
    on("turn.abort", () => {
      stop?.()
      return {} as never
    })
    on("tool.call", () => {
      opened?.()
      return new Promise((resolve) => {
        stop = () => resolve({ isError: true, result: refused })
      }) as never
    })

    await $.session.start({ cwd: "/tmp/session", surface: null, isInteractive: true })
    await clock.advance(0)
    await $.turn.start({ turnId: "t1", text: "Pick a date library." } as never)
    await $.tool.call({ tool: "AskUserQuestion", questions } as never)
    await clock.advance(200)

    expect(posted()[1]).toEqual({
      _tag: "QuestionClosed",
      turnId: "t1",
      toolCallId: expect.any(String),
      outcome: { _tag: "Cancelled" },
    })
  })

  test("one whose dialog timed out on its own is cancelled, not skipped at the terminal (#206)", async ($, on) => {
    const timedOut = { result: { questions, answers: {}, afkTimeoutMs: 60_000 } }
    const { dialog, posted } = askedSession(on, { _tag: "Dismissed" }, timedOut)
    const clock = mock.clock(on)

    await $.session.start({ cwd: "/tmp/session", surface: null, isInteractive: true })
    await clock.advance(0)
    await $.turn.start({ turnId: "t1", text: "Pick a date library." } as never)
    const done = await $.tool.call({ tool: "AskUserQuestion", questions } as never)
    await clock.advance(200)

    expect(done).toEqual(expect.objectContaining(timedOut))
    expect(posted()[1]).toEqual({
      _tag: "QuestionClosed",
      turnId: "t1",
      toolCallId: dialog.id,
      outcome: { _tag: "Cancelled" },
    })
  })

  test("one asked with no Turn on the main loop, a background agent's, is the terminal's alone", async ($, on) => {
    const { posted } = askedSession(on, { _tag: "Dismissed" })
    const clock = mock.clock(on)

    await $.session.start({ cwd: "/tmp/session", surface: null, isInteractive: true })
    await clock.advance(0)
    void $.tool.call({ tool: "AskUserQuestion", questions } as never)
    await clock.advance(200)

    expect(posted()).toEqual([expect.objectContaining({ _tag: "AnswerFailed", senderId: "p1" })])
  })
})

describe("attachments (#276)", () => {
  const tool = "mcp__hub-link-commands__attachment"
  const shot = { id: "att-1", name: "shot.png", mediaType: "image/png", size: 12 }
  const photo = { id: "att-2", name: "photo.jpg", mediaType: "image/jpeg", size: 34 }

  test("the tool is in the model's tool list once the session is linked", async ($, on) => {
    linkedSession(on)
    const registered: Array<unknown> = []
    on("tool.register", (_, e) => {
      registered.push(e)
      return { value: { tool } }
    })

    await $.session.start({ cwd: "/tmp/session", surface: null, isInteractive: true })

    expect(registered).toEqual([expect.objectContaining({ name: "attachment", isDeferred: false })])
  })

  test("a prompt with attachments marks each, and says what Claude is to be told of them", async ($, on) => {
    linkedSession(on, [
      {
        _tag: "DeliverPrompt",
        sessionId: "s1",
        promptId: "pr-1",
        text: "What broke?",
        sender: ada,
        attachments: [shot, photo],
      },
    ])
    const clock = mock.clock(on)
    on("tool.register", () => ({ value: { tool } }))
    const writes = deliveredWrites(on)
    const submitted: Array<string> = []
    on("prompt.submit", (_, e) => {
      submitted.push(e.text)
      return { text: e.text }
    })

    await $.session.start({ cwd: "/tmp/session", surface: null, isInteractive: true })
    await clock.advance(0)

    const text = [
      "[Ada Lovelace] What broke?",
      "[Image #1: shot.png (attachment att-1)]",
      "[Image #2: photo.jpg (attachment att-2)]",
    ].join("\n")
    expect(submitted).toEqual([text])
    // hub-link knows its Turn by the text submitted, and adds what Claude is told of the files.
    expect(writes).toEqual([
      {
        promptId: "pr-1",
        sender: ada,
        text,
        context: expect.stringMatching(
          /2 images.*Image #1 shot\.png: id att-1; Image #2 photo\.jpg: id att-2/,
        ),
      },
    ])
  })

  test("the tool hands Claude the file the Hub keeps, in its parts, as an image or a PDF", async ($, on) => {
    const file = { id: "att-1", name: "shot.png", mediaType: "image/png" }
    const parts = { 0: { ...file, data: "iVBO", next: 3 }, 3: { ...file, data: "Rw0K" } }
    // A 10 MB PDF comes in five parts of 2.4 MB (#277).
    const pdf = { id: "att-3", name: "spec.pdf", mediaType: "application/pdf" }
    const pdfParts = Object.fromEntries(
      Array.from({ length: 5 }, (_, index) => [
        index * 3,
        { ...pdf, data: `AAA${index}`, ...(index < 4 && { next: (index + 1) * 3 }) },
      ]),
    )
    const { requests } = linkedSession(
      on,
      [],
      undefined,
      {},
      {
        "att-1": parts,
        "att-3": pdfParts,
      },
    )
    on("tool.register", () => ({ value: { tool } }))

    await $.session.start({ cwd: "/tmp/session", surface: null, isInteractive: true })
    const opened = await $.tool.call({ tool, id: "att-1" } as never)
    const document = await $.tool.call({ tool, id: "att-3" } as never)
    const missing = await $.tool.call({ tool, id: "att-9" } as never)

    expect(requests.map((request) => request.url)).toEqual(
      expect.arrayContaining([
        `${hubUrl}/mod/attachments/att-1?offset=0`,
        `${hubUrl}/mod/attachments/att-1?offset=3`,
      ]),
    )
    expect(opened.result).toEqual([
      { type: "text", text: "shot.png" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0K" } },
    ])
    expect(document.result).toEqual([
      { type: "text", text: "spec.pdf" },
      {
        type: "document",
        title: "spec.pdf",
        source: {
          type: "base64",
          media_type: "application/pdf",
          data: Array.from({ length: 5 }, (_, index) => `AAA${index}`).join(""),
        },
      },
    ])
    expect(missing.deny).toBe("Could not open the attachment: There is no such attachment.")
  })
})
