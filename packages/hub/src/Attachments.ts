import { randomBytes } from "node:crypto"
import {
  Attachment,
  AttachmentId,
  type AttachmentMediaType,
  type ParticipantId,
  type SessionId,
} from "@kndl/protocol"
import { Clock, Context, Duration, Effect, Layer, Option } from "effect"
import { SqlClient } from "effect/sql"
import type { SqlError } from "effect/sql/SqlError"

/** How long a file nobody sent is kept after it was uploaded (#280). */
export const unsentAttachmentLifetime = Duration.hours(24)

/** How often the Hub deletes the files nobody sent, besides as it starts. */
const unsentSweepInterval = Duration.hours(1)

/** An attachment with its bytes, as the Hub serves it. */
export interface StoredAttachment {
  readonly attachment: Attachment
  readonly bytes: Uint8Array
}

const startsWith = (bytes: Uint8Array, prefix: ReadonlyArray<number>, at = 0) =>
  prefix.every((byte, index) => bytes[at + index] === byte)

/**
 * What file the bytes are, if an image Claude reads or a PDF (#277): the Hub trusts them, never
 * the upload's `Content-Type`, since the Messages API refuses a file whose type doesn't match its
 * data.
 */
export function sniffAttachment(bytes: Uint8Array): AttachmentMediaType | undefined {
  // "%PDF-", as Claude Code's Read tells a PDF.
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf"
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png"
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg"
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return "image/gif"
  if (
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)
  ) {
    return "image/webp"
  }
  return undefined
}

interface Row {
  readonly id: string
  readonly name: string
  readonly mediaType: string
  readonly size: number
}

const decodeAttachment = (row: Row) =>
  Attachment.make({
    id: AttachmentId.make(row.id),
    name: row.name,
    mediaType: row.mediaType as AttachmentMediaType,
    size: row.size,
  })

/**
 * The files Participants attach to prompts (#276, ADR 0024), in SQLite. A file sent with a prompt
 * is kept for the life of the Session it was uploaded to: purging the Session deletes it (ON
 * DELETE CASCADE). One nobody sent, removed from the Composer or left in a closed tab, is deleted
 * {@link unsentAttachmentLifetime} after upload (#280), by a sweep as the Hub starts and hourly.
 */
export class Attachments extends Context.Service<
  Attachments,
  {
    /** Keeps a file uploaded to the Session, under a new random id. */
    readonly add: (upload: {
      readonly sessionId: SessionId
      readonly name: string
      readonly mediaType: AttachmentMediaType
      readonly bytes: Uint8Array
      readonly by: ParticipantId
      readonly at: number
    }) => Effect.Effect<Attachment, SqlError>
    /**
     * Marks the files `ids` names sent, by `sender` at `at`, so they are kept from then on for the
     * life of the Session: the attachments, in that order and each once, if each is a file
     * `sender` uploaded to the Session. If any isn't, or was deleted unsent, none, and nothing is
     * marked.
     */
    readonly markSent: (
      sessionId: SessionId,
      ids: ReadonlyArray<AttachmentId>,
      sender: ParticipantId,
      at: number,
    ) => Effect.Effect<Option.Option<ReadonlyArray<Attachment>>, SqlError>
    /** One of the Session's files, with its bytes. */
    readonly get: (
      sessionId: SessionId,
      id: AttachmentId,
    ) => Effect.Effect<Option.Option<StoredAttachment>, SqlError>
    /**
     * At most `length` bytes of one of the Session's files, from byte `offset` on: read alone, not
     * the whole file, since the mod fetches a 20 MB PDF in parts (#277).
     */
    readonly part: (
      sessionId: SessionId,
      id: AttachmentId,
      offset: number,
      length: number,
    ) => Effect.Effect<Option.Option<StoredAttachment>, SqlError>
  }
>()("@kndl/hub/Attachments") {
  static readonly layer = Layer.effect(
    Attachments,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const layerScope = yield* Effect.scope

      const add = Effect.fn("Attachments.add")(function* (upload: {
        readonly sessionId: SessionId
        readonly name: string
        readonly mediaType: AttachmentMediaType
        readonly bytes: Uint8Array
        readonly by: ParticipantId
        readonly at: number
      }) {
        const id = AttachmentId.make(randomBytes(16).toString("hex"))
        yield* sql`
          INSERT INTO attachments
            (id, session_id, name, media_type, size, data, uploaded_by, uploaded_at)
          VALUES (${id}, ${upload.sessionId}, ${upload.name}, ${upload.mediaType},
            ${upload.bytes.byteLength}, ${upload.bytes}, ${upload.by}, ${upload.at})
        `
        return Attachment.make({
          id,
          name: upload.name,
          mediaType: upload.mediaType,
          size: upload.bytes.byteLength,
        })
      })

      // In a transaction, so a sweep deletes a file before it is marked or not at all, and a
      // refusal marks nothing.
      const markSent = Effect.fn("Attachments.markSent")(function* (
        sessionId: SessionId,
        ids: ReadonlyArray<AttachmentId>,
        sender: ParticipantId,
        at: number,
      ) {
        // Each file once, however often it is named.
        const unique = [...new Set(ids)]
        if (unique.length === 0) return Option.some<ReadonlyArray<Attachment>>([])
        const rows = yield* sql<Row>`
          SELECT id, name, media_type AS mediaType, size FROM attachments
          WHERE session_id = ${sessionId} AND uploaded_by = ${sender} AND id IN ${sql.in(unique)}
        `
        if (rows.length !== unique.length) return Option.none<ReadonlyArray<Attachment>>()
        yield* sql`
          UPDATE attachments SET sent_at = ${at}
          WHERE id IN ${sql.in(unique)} AND sent_at IS NULL
        `
        const byId = new Map(rows.map((row) => [row.id, decodeAttachment(row)]))
        return Option.some(unique.flatMap((id) => byId.get(id) ?? []))
      }, sql.withTransaction)

      const get = Effect.fn("Attachments.get")(function* (sessionId: SessionId, id: AttachmentId) {
        const [row] = yield* sql<Row & { readonly data: Uint8Array }>`
          SELECT id, name, media_type AS mediaType, size, data FROM attachments
          WHERE session_id = ${sessionId} AND id = ${id}
        `
        if (row === undefined) return Option.none<StoredAttachment>()
        return Option.some({ attachment: decodeAttachment(row), bytes: new Uint8Array(row.data) })
      })

      const part = Effect.fn("Attachments.part")(function* (
        sessionId: SessionId,
        id: AttachmentId,
        offset: number,
        length: number,
      ) {
        // substr counts a blob's bytes from 1.
        const [row] = yield* sql<Row & { readonly data: Uint8Array }>`
          SELECT id, name, media_type AS mediaType, size,
            substr(data, ${offset + 1}, ${length}) AS data
          FROM attachments WHERE session_id = ${sessionId} AND id = ${id}
        `
        if (row === undefined) return Option.none<StoredAttachment>()
        return Option.some({ attachment: decodeAttachment(row), bytes: new Uint8Array(row.data) })
      })

      const sweepUnsent = Effect.fn("Attachments.sweepUnsent")(
        function* () {
          const before =
            (yield* Clock.currentTimeMillis) - Duration.toMillis(unsentAttachmentLifetime)
          yield* sql`DELETE FROM attachments WHERE sent_at IS NULL AND uploaded_at <= ${before}`
        },
        Effect.catchCause((cause) => Effect.logError("Could not delete unsent attachments", cause)),
      )()

      // As the Hub starts, for those that aged while it was down; then for as long as it runs.
      yield* sweepUnsent
      yield* Effect.sleep(unsentSweepInterval).pipe(
        Effect.andThen(sweepUnsent),
        Effect.forever,
        Effect.forkIn(layerScope),
      )

      return Attachments.of({ add, markSent, get, part })
    }),
  )
}
