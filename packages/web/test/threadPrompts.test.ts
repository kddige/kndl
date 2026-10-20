import { expect, test } from "bun:test"
import { RequestId, ThreadId } from "@kndl/protocol"
import {
  failedThreadPrompt,
  pendingThreadPrompts,
  type PendingThreadPrompt,
  unconfirmedThreadPrompts,
} from "../src/session/threadPrompts.ts"
import { alice, entries } from "./fixtures.ts"

const thread = ThreadId.make("thread")
const pending = (requestId: string, after?: number): PendingThreadPrompt => ({
  requestId: RequestId.make(requestId),
  after: after as never,
  text: "again",
  attachments: [],
})
// The Hub redacts the text it logs, so an echo is told by its request id alone.
const echo = (requestId: string | undefined, text = "*****", threadId = thread) =>
  ({
    _tag: "ThreadPromptSent",
    threadId,
    promptId: "p",
    ...(requestId !== undefined && { requestId }),
    sender: alice,
    text,
  }) as const

test("a logged echo takes over from its preview, whatever its text, and even when a Turn has started", () => {
  expect(
    pendingThreadPrompts(
      [pending("req-1")],
      entries([
        echo("req-1", "use *****"),
        {
          _tag: "TurnStarted",
          threadId: thread,
          turnId: "turn",
          sender: { _tag: "FromParticipant", participant: alice },
          text: "use *****",
          promptId: "p",
        },
      ]),
      thread,
    ),
  ).toEqual([])
})

test("two identical sends are told apart by their request ids, and each echo takes only its own", () => {
  const both = [pending("req-1"), pending("req-2")]
  const log = entries([echo("req-2")])
  const remaining = pendingThreadPrompts(both, log, thread)
  expect(remaining.map((prompt) => prompt.requestId)).toEqual([RequestId.make("req-1")])
  expect(pendingThreadPrompts(remaining, log, thread)).toBe(remaining)
  expect(pendingThreadPrompts(remaining, [...log, ...entries([echo("req-1")], 1)], thread)).toEqual(
    [],
  )
})

test("an echo of another reply, of another thread, or with no request id isn't ours", () => {
  const local = [pending("req-1")]
  expect(
    pendingThreadPrompts(
      local,
      entries([
        echo("req-9"),
        echo("req-1", "again", ThreadId.make("other")),
        echo(undefined, "again"),
      ]),
      thread,
    ),
  ).toBe(local)
})

test("history from before the send cannot acknowledge a new reply", () => {
  const log = entries([echo("req-1")])
  const local = [pending("req-1", log[0]?.seq)]
  expect(pendingThreadPrompts(local, log, thread)).toBe(local)
})

test("a refusal fails only the reply it names, not the first one waiting", () => {
  const local = [pending("req-1"), pending("req-2"), pending("req-3")]
  const failed = failedThreadPrompt(
    local,
    RequestId.make("req-2"),
    "The Session has no such thread.",
  )
  expect(failed.map((prompt) => prompt.failed)).toEqual([
    undefined,
    "The Session has no such thread.",
    undefined,
  ])
  // One already failed keeps its reason, and an unknown request id changes nothing.
  expect(failedThreadPrompt(failed, RequestId.make("req-2"), "later")[1]?.failed).toBe(
    "The Session has no such thread.",
  )
  expect(failedThreadPrompt(failed, RequestId.make("req-9"), "?")).toEqual(failed)
})

test("a dropped connection marks the unanswered replies as unconfirmed, not as not sent", () => {
  const local = [pending("req-1"), { ...pending("req-2"), failed: "No." }]
  const marked = unconfirmedThreadPrompts(local)
  expect(marked[0]).toMatchObject({ unconfirmed: true })
  expect(marked[1]).not.toHaveProperty("unconfirmed")
  expect(unconfirmedThreadPrompts(marked)).toBe(marked)
})
