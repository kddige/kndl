import { expect, test } from "bun:test"
import { ThreadId } from "@kndl/protocol"
import { pendingThreadPrompts, type PendingThreadPrompt } from "../src/session/threadPrompts.ts"
import { alice, bob, entries } from "./fixtures.ts"

const thread = ThreadId.make("thread")
const pending = (key = 0): PendingThreadPrompt => ({
  key,
  after: undefined,
  text: "again",
  attachments: [],
})
const echo = (sender = alice, threadId = thread) =>
  ({ _tag: "ThreadPromptSent", threadId, promptId: "p", sender, text: "again" }) as const

test("a logged echo takes over from its preview, even when a Turn has already started", () => {
  expect(
    pendingThreadPrompts(
      [pending()],
      entries([
        echo(),
        {
          _tag: "TurnStarted",
          threadId: thread,
          turnId: "turn",
          sender: { _tag: "FromParticipant", participant: alice },
          text: "again",
          promptId: "p",
        },
      ]),
      thread,
      alice.id,
    ),
  ).toEqual([])
})

test("two identical sends consume one echo each, not the same echo twice on another render", () => {
  const log = entries([echo()])
  const remaining = pendingThreadPrompts([pending(0), pending(1)], log, thread, alice.id)
  expect(remaining.map((prompt) => prompt.key)).toEqual([1])
  expect(pendingThreadPrompts(remaining, log, thread, alice.id)).toBe(remaining)
  expect(
    pendingThreadPrompts(remaining, [...log, ...entries([echo()], 1)], thread, alice.id),
  ).toEqual([])
})

test("an identical message from someone else or another thread isn't our echo", () => {
  expect(
    pendingThreadPrompts(
      [pending()],
      entries([echo(bob), echo(alice, ThreadId.make("other"))]),
      thread,
      alice.id,
    ),
  ).toHaveLength(1)
})

test("history from before the send cannot acknowledge a new reply", () => {
  const log = entries([echo()])
  const local = [{ ...pending(), after: log[0]?.seq }]
  expect(pendingThreadPrompts(local, log, thread, alice.id)).toBe(local)
})
