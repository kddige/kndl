// The commands whose failure the Hub is told of (Commands.ts), over a Runtime whose Harness fails.

import { describe, expect, test } from "bun:test"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import type { Harness } from "@earendil-works/pi-durable"
import type { ModCommand } from "@kndl/protocol"
import { Commands } from "./Commands.ts"
import type { Questions } from "./Questions.ts"
import type { Runtime } from "./Runtime.ts"

const ada = { id: "p1", login: "ada", name: "Ada Lovelace" }

/** Commands over a Harness that fails whenever it is asked for a conversation. */
const failing = () => {
  let closing = false
  const reported: Array<Record<string, unknown>> = []
  const logged: Array<string> = []
  const harness = {
    root: async () => {
      throw new Error("The storage is gone.")
    },
    snapshot: async () => undefined,
  } as unknown as Harness
  const runtime = {
    harness: () => harness,
    report: (event: Record<string, unknown>) => reported.push(event),
    log: (text: string) => logged.push(text),
    context: BACKGROUND_CONTEXT,
    secrets: [],
    closing: () => closing,
  } as unknown as Runtime
  const questions = {
    answer: async () => {
      throw new Error("The question's conversation is gone.")
    },
  } as unknown as Questions
  const commands = new Commands({ runtime, questions, threadWithheld: () => [] })
  return {
    // Plain ids, as a test writes them; the Hub's are branded.
    run: (command: Record<string, unknown>) => commands.run(command as unknown as ModCommand),
    reported,
    logged,
    /** The agent is shutting down from now on. */
    close: () => {
      closing = true
    },
  }
}

describe("a command that fails", () => {
  test("to switch the model is a ModelSwitchFailed, with the model asked for", async () => {
    const { run, reported } = failing()
    await run({
      _tag: "SwitchModel",
      sessionId: "s-1",
      model: "openai/gpt-other",
    })
    expect(reported).toEqual([
      {
        _tag: "ModelSwitchFailed",
        asked: "openai/gpt-other",
        model: "openai/gpt-other",
        message: "Error: The storage is gone.",
      },
    ])
  })

  test("to switch a thread's model is a ModelSwitchFailed for that thread", async () => {
    const { run, reported } = failing()
    await run({
      _tag: "SwitchThreadModel",
      sessionId: "s-1",
      threadId: "t1",
      model: "openai/gpt-other",
    })
    expect(reported).toMatchObject([
      { _tag: "ModelSwitchFailed", asked: "openai/gpt-other", threadId: "t1" },
    ])
  })

  test("to deliver a prompt is a PromptFailed, so the Hub drops it", async () => {
    const { run, reported } = failing()
    await run({
      _tag: "DeliverPrompt",
      sessionId: "s-1",
      promptId: "q1",
      text: "Hi",
      sender: ada,
    })
    expect(reported).toEqual([
      { _tag: "PromptFailed", promptId: "q1", message: "Error: The storage is gone." },
    ])
  })

  test("to deliver a prompt as the agent shuts down is left to the next start, not failed", async () => {
    const { run, reported, close } = failing()
    close()
    // Thrown, the link leaves it unacknowledged: the Hub brings it again to the agent that starts.
    for (const _tag of ["DeliverPrompt", "DeliverIntoTurn", "StartThread"])
      await expect(
        run({
          _tag,
          sessionId: "s-1",
          promptId: "q1",
          threadId: "t1",
          anchorTurnId: "turn-1",
          text: "Hi",
          sender: ada,
        }),
      ).rejects.toThrow("The storage is gone.")
    expect(reported).toEqual([])
  })

  test("to deliver an answer is an AnswerFailed, to the one who answered", async () => {
    const { run, reported } = failing()
    await run({
      _tag: "DeliverAnswer",
      sessionId: "s-1",
      toolCallId: "call-1",
      answer: { _tag: "Replied", text: "Yes" },
      sender: ada,
    })
    expect(reported).toEqual([
      {
        _tag: "AnswerFailed",
        toolCallId: "call-1",
        senderId: "p1",
        message: "Error: The question's conversation is gone.",
      },
    ])
  })

  test("to stop a thread the Session doesn't have is logged: the protocol has no event for it", async () => {
    const { run, reported, logged } = failing()
    await run({ _tag: "StopThread", sessionId: "s-1", threadId: "t9" })
    expect(reported).toEqual([])
    expect(logged).toEqual(["kndl: StopThread: the Session has no thread t9"])
  })
})
