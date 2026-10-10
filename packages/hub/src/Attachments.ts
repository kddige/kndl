import { randomBytes } from "node:crypto"
import {
  Attachment,
  AttachmentId,
  type ImageMediaType,
  type ParticipantId,
  type SessionId,
} from "@kndl/protocol"
import { Context, Effect, Layer, Option } from "effect"
import { SqlClient } from "effect/sql"
import type { SqlError } from "effect/sql/SqlError"

/** An attachment with its bytes, as the Hub serves it. */
export interface StoredAttachment {
  readonly attachment: Attachment
  readonly bytes: Uint8Array
}

const startsWith = (bytes: Uint8Array, prefix: ReadonlyArray<number>, at = 0) =>
  prefix.every((byte, index) => bytes[at + index] === byte)

/**
 * What image the bytes are, if one Claude reads: the Hub trusts them, never the upload's
 * `Content-Type`, since the Messages API refuses an image whose type doesn't match its data.
 */
export function sniffImage(bytes: Uint8Array): ImageMediaType | undefined {
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
    mediaType: row.mediaType as ImageMediaType,
    size: row.size,
  })

/**
 * The files Participants attach to prompts (#276, ADR 0024), in SQLite, each kept for the life of
 * the Session it was uploaded to: purging the Session deletes them (ON DELETE CASCADE).
 */
export class Attachments extends Context.Service<
  Attachments,
  {
    /** Keeps a file uploaded to the Session, under a new random id. */
    readonly add: (upload: {
      readonly sessionId: SessionId
      readonly name: string
      readonly mediaType: ImageMediaType
      readonly bytes: Uint8Array
      readonly by: ParticipantId
      readonly at: number
    }) => Effect.Effect<Attachment, SqlError>
    /**
     * The attachments `ids` names, in that order and each once, if each is a file `sender`
     * uploaded to the Session; none if any isn't.
     */
    readonly ofSender: (
      sessionId: SessionId,
      ids: ReadonlyArray<AttachmentId>,
      sender: ParticipantId,
    ) => Effect.Effect<Option.Option<ReadonlyArray<Attachment>>, SqlError>
    /** One of the Session's files, with its bytes. */
    readonly get: (
      sessionId: SessionId,
      id: AttachmentId,
    ) => Effect.Effect<Option.Option<StoredAttachment>, SqlError>
  }
>()("@kndl/hub/Attachments") {
  static readonly layer = Layer.effect(
    Attachments,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient

      const add = Effect.fn("Attachments.add")(function* (upload: {
        readonly sessionId: SessionId
        readonly name: string
        readonly mediaType: ImageMediaType
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

      const ofSender = Effect.fn("Attachments.ofSender")(function* (
        sessionId: SessionId,
        ids: ReadonlyArray<AttachmentId>,
        sender: ParticipantId,
      ) {
        // Each file once, however often it is named.
        const unique = [...new Set(ids)]
        if (unique.length === 0) return Option.some<ReadonlyArray<Attachment>>([])
        const rows = yield* sql<Row>`
          SELECT id, name, media_type AS mediaType, size FROM attachments
          WHERE session_id = ${sessionId} AND uploaded_by = ${sender} AND id IN ${sql.in(unique)}
        `
        const byId = new Map(rows.map((row) => [row.id, decodeAttachment(row)]))
        const found = unique.flatMap((id) => {
          const attachment = byId.get(id)
          return attachment === undefined ? [] : [attachment]
        })
        return found.length === unique.length
          ? Option.some<ReadonlyArray<Attachment>>(found)
          : Option.none()
      })

      const get = Effect.fn("Attachments.get")(function* (sessionId: SessionId, id: AttachmentId) {
        const [row] = yield* sql<Row & { readonly data: Uint8Array }>`
          SELECT id, name, media_type AS mediaType, size, data FROM attachments
          WHERE session_id = ${sessionId} AND id = ${id}
        `
        if (row === undefined) return Option.none<StoredAttachment>()
        return Option.some({ attachment: decodeAttachment(row), bytes: new Uint8Array(row.data) })
      })

      return Attachments.of({ add, ofSender, get })
    }),
  )
}
