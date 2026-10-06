// The mod channel, over plain HTTP: Claude Code's mod runtime can `fetch`, with headers, but has
// no WebSockets and no streaming. Every route authenticates with the Session's mod token as
// `Authorization: Bearer` and acts only for that Session. See the protocol's Mod.ts for the
// contract. What the mod reports goes to the SessionRelay, which also fills the outbox.

import {
  checkHandshake,
  HandshakeRejected,
  MaxCommandWaitMs,
  ModCommands,
  ModCommandSeq,
  ModCommandsQuery,
  ModEvents,
  ModHello,
  ModHelloReply,
  ProtocolVersion,
  type SessionId,
} from "@kndl/protocol"
import { Duration, Effect, Schema } from "effect"
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerRespondable,
  HttpServerResponse,
} from "effect/http"
import { authenticateMod } from "./Auth.ts"
import { HubShutdown } from "./HubShutdown.ts"
import { ModOutbox } from "./ModOutbox.ts"
import { SessionRelay } from "./SessionRelay.ts"

const errorResponse = (status: number, error: string) =>
  HttpServerResponse.jsonUnsafe({ error }, { status })

/** The Hub hasn't heard this Session's hello since it started: answered with 409. */
// oxlint-disable-next-line unicorn/throw-new-error -- Effect makes error classes with a factory call
export class HelloFirst extends Schema.TaggedError<HelloFirst>()("HelloFirst", {}) {
  [HttpServerRespondable.symbol]() {
    return Effect.succeed(
      errorResponse(409, "Say hello first: the Hub hasn't heard from this mod since it started"),
    )
  }
}

/** Answers a request whose body or query doesn't decode. */
const badRequest = Effect.catchTags({
  SchemaError: (error: Schema.SchemaError) => Effect.succeed(errorResponse(400, error.message)),
  HttpServerError: () => Effect.succeed(errorResponse(400, "The body is not JSON")),
})

const replyToHello = HttpServerResponse.schemaJson(ModHelloReply)

export const ModRoutes = HttpRouter.use(
  Effect.fn(function* (router) {
    const outbox = yield* ModOutbox
    const relay = yield* SessionRelay
    const shutdown = yield* HubShutdown
    /** The Sessions whose mod has said hello since the Hub started. */
    const greeted = new Set<SessionId>()

    const requireHello = (sessionId: SessionId) =>
      greeted.has(sessionId) ? Effect.void : Effect.fail(new HelloFirst())

    yield* router.add(
      "POST",
      "/mod/hello",
      Effect.gen(function* () {
        const grant = yield* authenticateMod
        const request = yield* HttpServerRequest.HttpServerRequest
        const message = yield* request.json
        const mismatch = checkHandshake(message)
        if (mismatch !== undefined) return yield* replyToHello(mismatch, { status: 400 })
        const hello = Schema.decodeUnknownExit(ModHello)(message)
        if (hello._tag === "Failure") {
          return yield* replyToHello(
            HandshakeRejected.make({
              reason: "MalformedHandshake",
              protocolVersion: ProtocolVersion,
              message: "The hello is not a ModHello.",
            }),
            { status: 400 },
          )
        }
        if (hello.value.sessionId !== grant.sessionId) {
          return errorResponse(403, "This mod token is for another Session")
        }
        greeted.add(grant.sessionId)
        yield* relay.modHello(grant.sessionId, hello.value).pipe(Effect.orDie)
        return yield* replyToHello(
          ModHelloReply.cases.ModWelcome.make({ protocolVersion: ProtocolVersion }),
        )
      }).pipe(badRequest),
    )

    yield* router.add(
      "POST",
      "/mod/events",
      Effect.gen(function* () {
        const grant = yield* authenticateMod
        yield* requireHello(grant.sessionId)
        const events = yield* HttpServerRequest.schemaBodyJson(ModEvents)
        yield* relay.modEvents(grant.sessionId, events.messages).pipe(Effect.orDie)
        return HttpServerResponse.empty({ status: 204 })
      }).pipe(badRequest),
    )

    yield* router.add(
      "GET",
      "/mod/commands",
      Effect.gen(function* () {
        const grant = yield* authenticateMod
        yield* requireHello(grant.sessionId)
        const query = yield* HttpServerRequest.schemaSearchParams(ModCommandsQuery)
        const messages = yield* outbox
          .take(grant.sessionId, {
            after: query.after ?? ModCommandSeq.make(0),
            wait: Duration.millis(Math.min(query.waitMs ?? 0, MaxCommandWaitMs)),
          })
          .pipe(
            // A shutting-down Hub answers at once, or the server would wait out the poll. The mod
            // polls again and finds the Hub gone, as after any restart.
            Effect.raceFirst(Effect.as(shutdown.started, [])),
          )
        return yield* HttpServerResponse.schemaJson(ModCommands)({ messages })
      }).pipe(badRequest),
    )
  }),
)
