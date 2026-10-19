// Attachments (#276, ADR 0024): the files Participants attach to prompts, over HTTP beside the
// web channel, whose WebSocket stays at Bun's message limit.
//
// - `POST /sessions/<id>/attachments`: the Session's Creator, who alone prompts it (ADR 0026),
//   uploads one file, the raw body, named in `x-kndl-filename`. Read up to MaxAttachmentBytes and no further; kept as
//   the type its bytes are, which must be an image Claude reads or a PDF (#277), whatever
//   `Content-Type` says, and within the limit for that type.
// - `GET /sessions/<id>/attachments/<attachmentId>`: the file, to anyone who can see the Session.
//   Served as the type its bytes were sniffed as, which the browser must not second-guess, and
//   sandboxed, as MCP server icons are (ADR 0021): an image inline, a PDF as a download.
// - `GET /mod/attachments/<attachmentId>?offset=<n>`: the file, base64 in parts the mod runtime's
//   fetch can read, to the Session's own mod, for the tool that shows it Claude. Through the
//   Runner's relay, like every `/mod/*` call.

import {
  AttachmentId,
  attachmentName,
  AttachmentNameHeader,
  AttachmentUploaded,
  attachmentRules,
  driveRefusal,
  MaxAttachmentBytes,
  MaxModAttachmentPartBytes,
  ModAttachment,
  ModAttachmentQuery,
  SessionId,
  sendPromptRefusal,
  tooLargeForAnyReason,
  unsupportedAttachmentReason,
} from "@kndl/protocol"
import { Clock, Effect, Option } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { Attachments, sniffAttachment } from "./Attachments.ts"
import { authenticateMod, authenticateParticipant, requireSameOrigin } from "./Auth.ts"
import { readAtMost } from "./ReadAtMost.ts"
import { authorizeAccessFor } from "./SessionAccess.ts"

const errorResponse = (status: number, error: string) =>
  HttpServerResponse.jsonUnsafe({ error }, { status })

/** Past the limit for any kind of attachment: which kind it is doesn't matter. */
const tooLarge = errorResponse(413, tooLargeForAnyReason)

/** The name the upload gave its file, URI-encoded; "" for none, or one that doesn't decode. */
const sentName = (header: string | undefined) => {
  try {
    return decodeURIComponent(header ?? "")
  } catch {
    return ""
  }
}

/**
 * A name as `filename*` takes it (RFC 8187): percent-encoded, `'` and the rest that
 * `encodeURIComponent` leaves as they are included.
 */
const headerName = (name: string) =>
  encodeURIComponent(name).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  )

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
        // Whoever may prompt the Session may attach: anyone who sees it, in the Pi Durable spike.
        const notYours = driveRefusal(you, access.session.creator, access.session.harness)
        if (notYours !== undefined) return errorResponse(403, notYours.refusal)
        const cantSend = sendPromptRefusal(access.session)
        if (cantSend !== undefined) return errorResponse(409, cantSend.refusal)
        const request = yield* HttpServerRequest.HttpServerRequest
        if (Number(request.headers["content-length"] ?? 0) > MaxAttachmentBytes) return tooLarge
        const incoming = yield* HttpServerRequest.toWeb(request)
        const bytes = yield* Effect.tryPromise(() =>
          readAtMost(incoming.body, MaxAttachmentBytes),
        ).pipe(Effect.option)
        if (Option.isNone(bytes)) return errorResponse(400, "The file could not be read.")
        if (bytes.value === undefined) return tooLarge
        const mediaType = sniffAttachment(bytes.value)
        if (mediaType === undefined) return errorResponse(415, unsupportedAttachmentReason)
        // The limit for its kind, now its bytes say which.
        const rules = attachmentRules(mediaType)
        if (bytes.value.byteLength > rules.maxBytes) return errorResponse(413, rules.tooLarge)
        const attachment = yield* attachments
          .add({
            sessionId: access.session.id,
            name: attachmentName(
              sentName(request.headers[AttachmentNameHeader]),
              rules.fallbackName,
            ),
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
            // A PDF downloads: the sandbox would keep the browser's viewer from showing it.
            "content-disposition": `${attachmentRules(attachment.mediaType).disposition}; filename*=UTF-8''${headerName(attachment.name)}`,
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
        // No attachment is that long: said before the database is asked.
        if (offset < 0 || offset > MaxAttachmentBytes)
          return errorResponse(400, "The offset is not in the file.")
        // In parts, since the mod reads at most 4 MiB of a body: each part alone is held in memory.
        const stored = yield* attachments
          .part(
            grant.sessionId,
            AttachmentId.make(attachmentId ?? "-"),
            offset,
            MaxModAttachmentPartBytes,
          )
          .pipe(Effect.orDie)
        if (Option.isNone(stored)) return errorResponse(404, "There is no such attachment.")
        const { attachment, bytes } = stored.value
        if (offset > attachment.size) return errorResponse(400, "The offset is not in the file.")
        const end = offset + bytes.byteLength
        return yield* HttpServerResponse.schemaJson(ModAttachment)({
          id: attachment.id,
          name: attachment.name,
          mediaType: attachment.mediaType,
          data: Buffer.from(bytes).toString("base64"),
          ...(end < attachment.size && { next: end }),
        })
      }),
    )
  }),
)
