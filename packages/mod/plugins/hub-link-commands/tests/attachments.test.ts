// hub-link-commands in Claude Code's own mod runtime (`claude plugin test`): the files a steered
// prompt, a message to a subagent and a reply to a question carry (#278), marked for Claude.

import { describe, expect, mock, test } from "claude-code/testing"
import { ada, askedSession, linkedSession, shot, steeringWrites } from "./support.ts"

describe("attachments beyond prompts (#278)", () => {
  test("a steered prompt's are marked in the row it adds, and said to hub-link", async ($, on) => {
    let turnStarted: (() => void) | undefined
    linkedSession(
      on,
      [
        {
          _tag: "DeliverIntoTurn",
          sessionId: "s1",
          promptId: "pr-2",
          text: "",
          sender: ada,
          attachments: [shot],
        },
      ],
      new Promise((resolve) => (turnStarted = resolve)),
    )
    const clock = mock.clock(on)
    const writes = steeringWrites(on)
    on("turn.start", (_, e) => ({ turnId: e.turnId }))

    await $.session.start({ cwd: "/tmp/session", surface: null, isInteractive: true })
    await clock.advance(0)
    await $.turn.start({ turnId: "t1", text: "long job" } as never)
    turnStarted?.()
    await clock.advance(200)

    expect(writes[0]).toEqual({
      promptId: "pr-2",
      sender: ada,
      text: "",
      attachments: [shot],
      appended: expect.stringContaining(
        "\n[Ada Lovelace] [Image #1: shot.png (attachment att-1)]\n",
      ),
    })
  })

  test("a message to a subagent marks each, for one that has the tool to open them", async ($, on) => {
    linkedSession(on, [
      {
        _tag: "DeliverAgentMessage",
        sessionId: "s1",
        agentId: "a1",
        text: "",
        sender: ada,
        attachments: [shot],
      },
    ])
    const clock = mock.clock(on)
    const sent: Array<string> = []
    on("session.send", (_, e) => {
      sent.push(e.text)
      return { isDelivered: true }
    })

    await $.session.start({ cwd: "/tmp/session", surface: null, isInteractive: true })
    await clock.advance(200)

    expect(sent).toEqual(["[Ada Lovelace] [Image #1: shot.png (attachment att-1)]"])
  })

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

  test("a reply marks each for Claude, and closes the question with them", async ($, on) => {
    const reply = { _tag: "Replied", text: "Like this one", attachments: [shot] }
    const { dialog, posted } = askedSession(on, reply)
    const clock = mock.clock(on)

    await $.session.start({ cwd: "/tmp/session", surface: null, isInteractive: true })
    await clock.advance(0)
    await $.turn.start({ turnId: "t1", text: "Pick a date library." } as never)
    const call = $.tool.call({ tool: "AskUserQuestion", questions } as never)
    await clock.advance(200)

    expect(await call).toEqual(
      expect.objectContaining({
        deny: expect.stringContaining(
          "[Ada Lovelace] Like this one\n[Image #1: shot.png (attachment att-1)]",
        ),
      }),
    )
    expect(posted().at(-1)).toEqual({
      _tag: "QuestionClosed",
      turnId: "t1",
      toolCallId: dialog.id,
      outcome: reply,
      by: ada,
    })
  })
})
