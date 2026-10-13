import {
  PromptAttachments,
  ParticipantId,
  PromptId,
  QueuedPrompt,
  type SessionId,
} from "@kndl/protocol"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { SqlClient } from "effect/sql"
import type { SqlError } from "effect/sql/SqlError"

const AttachmentsJson = Schema.fromJsonString(PromptAttachments)
const encodeAttachments = Schema.encodeSync(AttachmentsJson)
const decodeAttachments = Schema.decodeUnknownSync(AttachmentsJson)

/**
 * Each Session's Prompt queue, in SQLite so that a Hub restart keeps it: the prompts its
 * Creator sent (ADR 0026), in the order they were sent, each with its sender and the attachments
 * it carries (#276), which stay the Session's when it leaves. A prompt leaves the queue
 * when the Turn it starts begins, when it is cancelled, or when its delivery fails.
 *
 * Which prompt is out for delivery is the SessionRelay's business, not stored here.
 */
export class PromptQueue extends Context.Service<
  PromptQueue,
  {
    /** Adds a prompt at the end of the Session's queue. */
    readonly add: (sessionId: SessionId, prompt: QueuedPrompt) => Effect.Effect<void, SqlError>
    /** Removes a prompt from the Session's queue, returning it, or none if it isn't queued. */
    readonly remove: (
      sessionId: SessionId,
      promptId: PromptId,
    ) => Effect.Effect<Option.Option<QueuedPrompt>, SqlError>
    /** The Session's queue, in order. */
    readonly list: (sessionId: SessionId) => Effect.Effect<ReadonlyArray<QueuedPrompt>, SqlError>
  }
>()("@kndl/hub/PromptQueue") {
  static readonly layer = Layer.effect(
    PromptQueue,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient

      const add = Effect.fn("PromptQueue.add")(function* (
        sessionId: SessionId,
        prompt: QueuedPrompt,
      ) {
        yield* sql`
          INSERT INTO queued_prompts (id, session_id, text, sender_id, queued_at, attachments)
          VALUES (${prompt.id}, ${sessionId}, ${prompt.text}, ${prompt.sender.id}, ${prompt.queuedAt},
            ${prompt.attachments === undefined ? null : encodeAttachments(prompt.attachments)})
        `
      })

      const list = Effect.fn("PromptQueue.list")(function* (sessionId: SessionId) {
        const rows = yield* sql<{
          readonly id: string
          readonly text: string
          readonly queuedAt: number
          readonly senderId: string
          readonly senderLogin: string
          readonly senderName: string
          readonly senderAvatarUrl: string | null
          readonly attachments: string | null
        }>`
          SELECT q.id, q.text, q.queued_at AS queuedAt, q.attachments,
            p.id AS senderId, p.login AS senderLogin, p.name AS senderName,
            p.avatar_url AS senderAvatarUrl
          FROM queued_prompts q JOIN participants p ON p.id = q.sender_id
          WHERE q.session_id = ${sessionId}
          ORDER BY q.position
        `
        return rows.map((row) =>
          QueuedPrompt.make({
            id: PromptId.make(row.id),
            text: row.text,
            sender: {
              id: ParticipantId.make(row.senderId),
              login: row.senderLogin,
              name: row.senderName,
              ...(row.senderAvatarUrl !== null && { avatarUrl: row.senderAvatarUrl }),
            },
            queuedAt: row.queuedAt,
            ...(row.attachments !== null && { attachments: decodeAttachments(row.attachments) }),
          }),
        )
      })

      const remove = Effect.fn("PromptQueue.remove")(function* (
        sessionId: SessionId,
        promptId: PromptId,
      ) {
        const queued = (yield* list(sessionId)).find((prompt) => prompt.id === promptId)
        if (queued === undefined) return Option.none<QueuedPrompt>()
        yield* sql`DELETE FROM queued_prompts WHERE id = ${promptId} AND session_id = ${sessionId}`
        return Option.some(queued)
      })

      return PromptQueue.of({ add, remove, list })
    }),
  )
}
