// A context handoff after the Session switched Harness (ADR 0030): Claude reads it with the next
// prompt, as a note, and reads further back with the history tool.

import { describe, expect, mock, test } from "claude-code/testing"
import { ada, deliveredWrites, hubUrl, linkedSession } from "./support.ts"

const handoff = {
  _tag: "DeliverHandoff",
  sessionId: "s1",
  from: "Pi",
  text: "Turn #12, prompted by Ada Lovelace\nPrompt: Add a health check.\nAnswer: Added GET /health.",
  earlierBefore: 12,
}
const prompt = {
  _tag: "DeliverPrompt",
  sessionId: "s1",
  promptId: "pr-1",
  text: "Now test it.",
  sender: ada,
}
const noteText = (appended: ReadonlyArray<unknown>) =>
  appended.map(
    (row) => (row as { message: { content: Array<{ text: string }> } }).message.content[0]?.text,
  )

describe("a context handoff (ADR 0030)", () => {
  test("one that comes while Claude is idle is a note Claude reads with the next prompt, not a prompt or a Turn of its own", async ($, on) => {
    const { posted } = linkedSession(on, [handoff, prompt])
    const clock = mock.clock(on)
    const session = mock.session(on)
    const order: Array<string> = []
    on("session.append", { door: "note" }, (_, e, next) => {
      order.push("note")
      return next(e)
    })
    on("prompt.submit", (_, e) => {
      order.push(`prompt: ${e.text}`)
      return { text: e.text }
    })

    await $.session.start({ cwd: "/tmp/session", surface: null, isInteractive: true })
    await clock.advance(200)

    expect(order).toEqual(["note", "prompt: [Ada Lovelace] Now test it."])
    expect(session.appended()).toEqual([
      expect.objectContaining({
        door: "note",
        message: { type: "user", content: [{ type: "text", text: expect.any(String) }] },
      }),
    ])
    const [note] = noteText(session.appended())
    expect(note).toStartWith("<context-handoff>\n")
    expect(note).toContain("ran on another agent harness, pi,")
    expect(note).toContain(
      "call mcp__hub-link-commands__session_history with before=12 to read them",
    )
    expect(note).toContain(handoff.text)
    expect(posted()).toEqual([])
  })

  test("an empty one adds nothing", async ($, on) => {
    linkedSession(on, [{ ...handoff, text: "", earlierBefore: undefined }])
    const clock = mock.clock(on)
    const session = mock.session(on)

    await $.session.start({ cwd: "/tmp/session", surface: null, isInteractive: true })
    await clock.advance(200)

    expect(session.appended()).toEqual([])
  })

  test("one Claude Code won't append goes with the next prompt from the Hub instead, out of sight, once", async ($, on) => {
    linkedSession(on, [handoff, prompt, { ...prompt, promptId: "pr-2", text: "And ship it." }])
    const clock = mock.clock(on)
    const writes = deliveredWrites(on)
    on("session.append", { door: "note" }, () => ({ deny: "the session is closing" }))
    on("prompt.submit", (_, e) => ({ text: e.text }))

    await $.session.start({ cwd: "/tmp/session", surface: null, isInteractive: true })
    await clock.advance(200)

    expect(writes).toEqual([
      {
        promptId: "pr-1",
        sender: ada,
        text: "[Ada Lovelace] Now test it.",
        context: expect.stringContaining(handoff.text),
      },
      { promptId: "pr-2", sender: ada, text: "[Ada Lovelace] And ship it." },
    ])
  })

  test("one that waits is kept when the prompt it went with fails, for the prompt after it", async ($, on) => {
    linkedSession(on, [handoff, prompt])
    const clock = mock.clock(on)
    on("session.append", { door: "note" }, () => ({ deny: "the session is closing" }))
    const contexts: Array<unknown> = []
    on("prompt.submit", (_, e) => {
      if (e.text === "[Ada Lovelace] Now test it.") return { drop: "not now" }
      contexts.push(e.context)
      return { text: e.text }
    })

    await $.session.start({ cwd: "/tmp/session", surface: null, isInteractive: true })
    await clock.advance(200)
    await $.prompt.submit({ text: "what changed?" } as never)

    expect(contexts).toEqual([[expect.stringContaining(handoff.text)]])
  })

  test("one that waits goes no more once a later one is appended", async ($, on) => {
    linkedSession(on, [handoff, { ...handoff, text: "Turn #13, prompted by Ada Lovelace" }])
    const clock = mock.clock(on)
    const session = mock.session(on)
    let denied = false
    on("session.append", { door: "note" }, (_, e, next) => {
      if (denied) return next(e)
      denied = true
      return { deny: "the session is closing" }
    })
    const contexts: Array<unknown> = []
    on("prompt.submit", (_, e) => {
      contexts.push(e.context)
      return { text: e.text }
    })

    await $.session.start({ cwd: "/tmp/session", surface: null, isInteractive: true })
    await clock.advance(200)
    await $.prompt.submit({ text: "what changed?" } as never)

    expect(session.appended()).toHaveLength(1)
    expect(contexts).toEqual([undefined])
  })

  test("one Claude Code won't append goes with a prompt typed at the terminal, if that comes first", async ($, on) => {
    linkedSession(on, [handoff])
    const clock = mock.clock(on)
    on("session.append", { door: "note" }, () => ({ deny: "the session is closing" }))
    const contexts: Array<unknown> = []
    on("prompt.submit", (_, e) => {
      contexts.push(e.context)
      return { text: e.text }
    })

    await $.session.start({ cwd: "/tmp/session", surface: null, isInteractive: true })
    await clock.advance(200)
    await $.prompt.submit({ text: "what changed?" } as never)
    await $.prompt.submit({ text: "and then?" } as never)

    expect(contexts).toEqual([[expect.stringContaining(handoff.text)], undefined])
  })
})

describe("the history tool (ADR 0030)", () => {
  const tool = "mcp__hub-link-commands__session_history"
  const turns = {
    turns: [
      {
        seq: 10,
        by: "Ada Lovelace",
        prompt: "Add a server.",
        tools: ["write: src/server.ts"],
        answer: "Added it.",
        model: "openai/gpt-6-sol",
      },
      {
        seq: 11,
        by: "terminal",
        prompt: "run it",
        tools: ["bash: bun src/server.ts"],
        answer: "Up.",
      },
    ],
    earlierBefore: 10,
  }

  test("is in the tool list beside the attachment tool once the session is linked", async ($, on) => {
    linkedSession(on)
    const registered: Array<unknown> = []
    on("tool.register", (_, e) => {
      registered.push(e)
      return { value: { tool: `mcp__hub-link-commands__${e.name}` } }
    })

    await $.session.start({ cwd: "/tmp/session", surface: null, isInteractive: true })

    expect(registered).toEqual([
      expect.objectContaining({ name: "attachment", isDeferred: false }),
      expect.objectContaining({
        name: "session_history",
        isDeferred: false,
        description: expect.stringContaining("<context-handoff>"),
      }),
    ])
  })

  test("reads the Turns before one from the Hub, and hands them Claude as text", async ($, on) => {
    const { requests } = linkedSession(on, [], undefined, {}, {}, undefined, {
      "before=12&limit=2": { status: 200, text: JSON.stringify(turns) },
      "limit=10": { status: 200, text: JSON.stringify({ turns: [] }) },
    })
    on("tool.register", (_, e) => ({ value: { tool: `mcp__hub-link-commands__${e.name}` } }))

    await $.session.start({ cwd: "/tmp/session", surface: null, isInteractive: true })
    const read = await $.tool.call({ tool, before: 12, limit: 2 } as never)
    const latest = await $.tool.call({ tool } as never)
    const refused = await $.tool.call({ tool, before: 99 } as never)
    const wrong = await $.tool.call({ tool, before: "yesterday" } as never)

    expect(requests.map((request) => request.url)).toEqual(
      expect.arrayContaining([
        `${hubUrl}/mod/history?before=12&limit=2`,
        `${hubUrl}/mod/history?limit=10`,
      ]),
    )
    expect(read.result).toEqual([
      {
        type: "text",
        text: expect.stringMatching(
          /^Turn #10, prompted by Ada Lovelace, on openai\/gpt-6-sol\n[\s\S]*- bash: bun src\/server\.ts\nAnswer: Up\.\n\nThere are earlier Turns: call mcp__hub-link-commands__session_history with before=10 to read them\.$/,
        ),
      },
    ])
    expect(latest.result).toEqual([{ type: "text", text: "This session has no Turns yet." }])
    expect(refused.deny).toBe("Could not read the session's history: There is no such Session.")
    expect(wrong.deny).toBe("`before` must be a Turn number, a whole number from 0 up.")
  })
})
