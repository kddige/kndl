// A stopped reply in what the model reads (StoppedReplies.ts): the entry a stop writes for it.

import { describe, expect, test } from "bun:test"
import type { AssistantMessage } from "@earendil-works/pi-ai"
import type { ConversationId, EntryId, EntryRecord } from "@earendil-works/pi-durable"
import { StopMarker, StoppedEntry, stoppedReplyDraft } from "./StoppedReplies.ts"

const usage = {
  input: 10,
  output: 5,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 15,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

/** The entry of a reply that ended as `stopReason` says, with `content`. */
const reply = (
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"],
  provider = "xai",
): EntryRecord => ({
  id: 7 as EntryId,
  conversationId: 1 as ConversationId,
  kind: "pi.assistant",
  model: [
    {
      role: "assistant",
      content,
      api: "openai-responses",
      provider,
      model: "grok-4.3",
      usage,
      stopReason,
      errorMessage: "Request was aborted",
      timestamp: 1,
    },
  ],
})

describe("a reply someone stopped", () => {
  test("is given back as its text, then the marker that it was stopped", () => {
    const draft = stoppedReplyDraft(
      reply(
        [{ type: "text", text: "Upon the hills of morning light,", textSignature: "msg_1" }],
        "aborted",
      ),
      42,
    )
    expect(draft).toMatchObject({
      kind: StoppedEntry,
      data: { reply: 7 },
      model: [{ role: "user", content: StopMarker, timestamp: 42 }],
      edits: [
        {
          target: 7,
          action: "replace",
          messages: [
            {
              role: "assistant",
              content: [{ type: "text", text: "Upon the hills of morning light," }],
              stopReason: "stop",
            },
          ],
        },
      ],
    })
    // What went wrong is no part of what the model said.
    const message = draft?.edits?.[0]
    expect(message?.action === "replace" && "errorMessage" in (message.messages[0] ?? {})).toBe(
      false,
    )
  })

  test("leaves out its reasoning and its tool calls, which never ran", () => {
    const draft = stoppedReplyDraft(
      reply(
        [
          { type: "thinking", thinking: "Let me think", thinkingSignature: "sig" },
          { type: "text", text: "I'll look." },
          { type: "toolCall", id: "call_1", name: "read", arguments: { path: "a.ts" } },
        ],
        "aborted",
      ),
      1,
    )
    expect(draft?.edits).toMatchObject([
      { action: "replace", messages: [{ content: [{ type: "text", text: "I'll look." }] }] },
    ])
  })

  test("with nothing it said, is only the marker", () => {
    const draft = stoppedReplyDraft(
      reply(
        [
          { type: "thinking", thinking: "Hmm" },
          { type: "text", text: "  " },
        ],
        "aborted",
      ),
      1,
    )
    expect(draft).toMatchObject({
      model: [{ content: StopMarker }],
      edits: [{ target: 7, action: "omit" }],
    })
  })

  test("is left alone when it ended in an error, or was a Claude Model's", () => {
    expect(stoppedReplyDraft(reply([{ type: "text", text: "Half" }], "error"), 1)).toBeUndefined()
    expect(stoppedReplyDraft(reply([{ type: "text", text: "Done" }], "stop"), 1)).toBeUndefined()
    expect(
      stoppedReplyDraft(reply([{ type: "text", text: "Half" }], "aborted", "anthropic"), 1),
    ).toBeUndefined()
  })
})
