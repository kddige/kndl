// Attachments (#276, ADR 0024): the files Participants attach to prompts, over HTTP beside the
// web channel, whose WebSocket stays at Bun's message limit.
//
// - `POST /sessions/<id>/attachments`: a Participant who may prompt the Session uploads one file,
//   the raw body, named in `x-kndl-filename`. Read up to MaxImageBytes and no further; kept as the
//   type its bytes are, which must be an image Claude reads, whatever `Content-Type` says.
// - `GET /sessions/<id>/attachments/<attachmentId>`: the file, to anyone who can see the Session.
//   Served as the type its bytes were sniffed as, which the browser must not second-guess, and
//   sandboxed, as MCP server icons are (ADR 0021).
// - `GET /mod/attachments/<attachmentId>?offset=<n>`: the file, base64 in parts the mod runtime's
//   fetch can read, to the Session's own mod, for the tool that shows it Claude. Through the
//   Runner's relay, like every `/mod/*` call.

import {
  AttachmentId,
  attachmentName,
  AttachmentNameHeader,
  AttachmentUploaded,
  MaxImageBytes,
  MaxModAttachmentPartBytes,
  ModAttachment,
  ModAttachmentQuery,
  SessionId,
  sendPromptRefusal,
} from "@kndl/protocol"
import { Clock, Effect, Option } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { Attachments, sniffImage } from "./Attachments.ts"
import { authenticateMod, authenticateParticipant, requireSameOrigin } from "./Auth.ts"
import { readAtMost } from "./ReadAtMost.ts"
import { authorizeAccessFor } from "./SessionAccess.ts"

const errorResponse = (status: number, error: string) =>
  HttpServerResponse.jsonUnsafe({ error }, { status })

const tooLarge = errorResponse(
  413,
  `An image may be ${MaxImageBytes / 1024 / 1024} MB at most, the most Claude reads.`,
)

/** The name the upload gave its file, URI-encoded; "" for none, or one that doesn't decode. */
const sentName = (header: string | undefined) => {
  try {
    return decodeURIComponent(header ?? "")
  } catch {
    return ""
  }
}

/** The Session in the path, if the person may reach it; else the answer refusing them. */
const sessionFrom = Effect.fn(function* (you: Parameters<typeof authorizeAccessFor>[0]) {
  const { sessionId } = yield* HttpRouter.params
  return yield* authorizeAccessFor(you, SessionId.make(sessionId ?? "-")).pipe(
    Effect.map((access) => ({ session: access.session })),
    Effect.catchTag("SessionAccessRefused", (refusal) =>
      Effect.succeed({
        refused: errorResponse(refusal.reason === "AccessUnknown" ? 503 : 404, refusal.message),
      }),
    ),
  )
})

export const AttachmentRoutes = HttpRouter.use(
  Effect.fn(function* (router) {
    const attachments = yield* Attachments

    yield* router.add(
      "POST",
      "/sessions/:sessionId/attachments",
      Effect.gen(function* () {
        yield* requireSameOrigin
        const you = yield* authenticateParticipant
        const access = yield* sessionFrom(you)
        if ("refused" in access) return access.refused
        // Anyone who may prompt the Session may attach.
        const cantSend = sendPromptRefusal(access.session)
        if (cantSend !== undefined) return errorResponse(409, cantSend.refusal)
        const request = yield* HttpServerRequest.HttpServerRequest
        if (Number(request.headers["content-length"] ?? 0) > MaxImageBytes) return tooLarge
        const incoming = yield* HttpServerRequest.toWeb(request)
        const bytes = yield* Effect.tryPromise(() => readAtMost(incoming.body, MaxImageBytes)).pipe(
          Effect.option,
        )
        if (Option.isNone(bytes)) return errorResponse(400, "The file could not be read.")
        if (bytes.value === undefined) return tooLarge
        const mediaType = sniffImage(bytes.value)
        if (mediaType === undefined) {
          return errorResponse(415, "Only JPEG, PNG, GIF and WebP images can be attached.")
        }
        const attachment = yield* attachments
          .add({
            sessionId: access.session.id,
            name: attachmentName(sentName(request.headers[AttachmentNameHeader])),
            mediaType,
            bytes: bytes.value,
            by: you.id,
            at: yield* Clock.currentTimeMillis,
          })
          .pipe(Effect.orDie)
        return yield* HttpServerResponse.schemaJson(AttachmentUploaded)(
          { id: attachment.id },
          { status: 201 },
        )
      }),
    )

    yield* router.add(
      "GET",
      "/sessions/:sessionId/attachments/:attachmentId",
      Effect.gen(function* () {
        const you = yield* authenticateParticipant
        const access = yield* sessionFrom(you)
        if ("refused" in access) return access.refused
        const { attachmentId } = yield* HttpRouter.params
        const stored = yield* attachments
          .get(access.session.id, AttachmentId.make(attachmentId ?? "-"))
          .pipe(Effect.orDie)
        if (Option.isNone(stored)) return errorResponse(404, "There is no such attachment.")
        const { attachment, bytes } = stored.value
        return HttpServerResponse.uint8Array(bytes, {
          contentType: attachment.mediaType,
          headers: {
            "content-security-policy": "sandbox",
            "x-content-type-options": "nosniff",
            "cross-origin-resource-policy": "same-origin",
            "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(attachment.name)}`,
            // An attachment never changes: a new file is a new id.
            "cache-control": "private, max-age=31536000, immutable",
          },
        })
      }),
    )

    yield* router.add(
      "GET",
      "/mod/attachments/:attachmentId",
      Effect.gen(function* () {
        const grant = yield* authenticateMod
        const { attachmentId } = yield* HttpRouter.params
        const query = yield* HttpServerRequest.schemaSearchParams(ModAttachmentQuery).pipe(
          Effect.option,
        )
        const offset = Option.match(query, { onNone: () => -1, onSome: (q) => q.offset ?? 0 })
        const stored = yield* attachments
          .get(grant.sessionId, AttachmentId.make(attachmentId ?? "-"))
          .pipe(Effect.orDie)
        if (Option.isNone(stored)) return errorResponse(404, "There is no such attachment.")
        const { attachment, bytes } = stored.value
        if (offset < 0 || offset > bytes.byteLength)
          return errorResponse(400, "The offset is not in the file.")
        // In parts, since the mod reads at most 4 MiB of a body.
        const end = Math.min(offset + MaxModAttachmentPartBytes, bytes.byteLength)
        return yield* HttpServerResponse.schemaJson(ModAttachment)({
          id: attachment.id,
          name: attachment.name,
          mediaType: attachment.mediaType,
          data: Buffer.from(bytes.subarray(offset, end)).toString("base64"),
          ...(end < bytes.byteLength && { next: end }),
        })
      }),
    )
  }),
)
