// The WebSocket channels to Runners, mods and web clients. Each authenticates before the upgrade
// (a request without a valid credential gets 401 and no socket), then opens with the peer's
// hello, answered by a welcome or a HandshakeRejected.
//
// What flows after the welcome is for the Session relay (issue #8) and the Runner (issue #10);
// for now the Hub reads and drops it until the peer hangs up.

import {
  checkHandshake,
  HandshakeRejected,
  HubToMod,
  HubToRunner,
  HubToWeb,
  ModHello,
  ProtocolVersion,
  RunnerHello,
  WebHello,
} from "@claude-hub/protocol"
import { Duration, Effect, Schema } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { Socket } from "effect/socket"
import {
  authenticateMod,
  authenticateParticipant,
  authenticateRunner,
  requireSameOrigin,
} from "./Auth.ts"

/** How long a peer has to send its hello once the socket is open. */
const helloTimeout = Duration.seconds(10)

/** Close codes the Hub uses, beside the standard 1000 and 1008. */
export const CloseCode = {
  /** The hello was fine, but this credential may not do what it asks. */
  Forbidden: 4403,
  /** No hello in time. */
  HelloTimeout: 4408,
} as const

/** A hello the Hub won't welcome: the socket closes with this code and reason. */
export interface Refusal {
  readonly _tag: "Refusal"
  readonly code: number
  readonly reason: string
}

const refuse = (reason: string): Refusal => ({
  _tag: "Refusal",
  code: CloseCode.Forbidden,
  reason,
})

/**
 * Upgrades the request and runs the handshake: reads the hello, checks its protocol version,
 * decodes it with `hello`, and sends what `welcome` makes of it.
 */
const serveChannel = <Hello, Out, R>(options: {
  readonly hello: Schema.Codec<Hello, unknown>
  readonly outgoing: Schema.Codec<Out, unknown>
  readonly welcome: (hello: Hello) => Effect.Effect<Out | Refusal, never, R>
}) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const socket = yield* request.upgrade
    yield* Effect.scoped(
      Effect.gen(function* () {
        const writer = yield* socket.writer
        const pull = yield* Socket.readerString(socket)
        const send = (message: Out) =>
          writer.write(JSON.stringify(Schema.encodeSync(options.outgoing)(message)))
        const reject = (rejection: HandshakeRejected) =>
          writer
            .write(JSON.stringify(Schema.encodeSync(HandshakeRejected)(rejection)))
            .pipe(Effect.andThen(writer.write(new Socket.CloseEvent(1008, rejection.reason))))

        const first = yield* pull.pipe(
          Effect.timeoutOrElse({
            duration: helloTimeout,
            orElse: () =>
              writer
                .write(new Socket.CloseEvent(CloseCode.HelloTimeout, "No hello"))
                .pipe(Effect.andThen(Effect.interrupt)),
          }),
        )
        const message = parseJson(first[0])
        const mismatch = checkHandshake(message)
        if (mismatch !== undefined) return yield* reject(mismatch)
        const hello = Schema.decodeUnknownExit(options.hello)(message)
        if (hello._tag === "Failure") {
          return yield* reject(
            HandshakeRejected.make({
              reason: "MalformedHandshake",
              protocolVersion: ProtocolVersion,
              message: "The hello is not one this channel accepts.",
            }),
          )
        }
        const answer = yield* options.welcome(hello.value)
        if (isRefusal(answer)) {
          return yield* writer.write(new Socket.CloseEvent(answer.code, answer.reason))
        }
        yield* send(answer)
        yield* Effect.forever(pull)
      }).pipe(
        Effect.catchTag("SocketError", () => Effect.void),
        Effect.catchCause(Effect.logDebug),
      ),
    )
    return HttpServerResponse.empty()
  })

function parseJson(text: string | undefined): unknown {
  try {
    return JSON.parse(text ?? "")
  } catch {
    return undefined
  }
}

function isRefusal(answer: unknown): answer is Refusal {
  return (
    typeof answer === "object" && answer !== null && "_tag" in answer && answer._tag === "Refusal"
  )
}

export const ChannelRoutes = HttpRouter.use(
  Effect.fn(function* (router) {
    // A Runner, by its Runner token. Its RunnerId comes from the token, not the hello.
    yield* router.add(
      "GET",
      "/ws/runner",
      Effect.gen(function* () {
        const runner = yield* authenticateRunner
        return yield* serveChannel({
          hello: RunnerHello,
          outgoing: HubToRunner,
          welcome: () =>
            Effect.succeed(
              HubToRunner.cases.RunnerWelcome.make({
                protocolVersion: ProtocolVersion,
                runnerId: runner.runnerId,
              }),
            ),
        })
      }),
    )

    // One Session's mod, by that Session's mod token.
    yield* router.add(
      "GET",
      "/ws/mod",
      Effect.gen(function* () {
        const grant = yield* authenticateMod
        return yield* serveChannel({
          hello: ModHello,
          outgoing: HubToMod,
          welcome: (hello) =>
            Effect.succeed(
              hello.sessionId === grant.sessionId
                ? HubToMod.cases.ModWelcome.make({ protocolVersion: ProtocolVersion })
                : refuse("This mod token is for another Session"),
            ),
        })
      }),
    )

    // A person in the web UI, by their sign-in cookie, from the web UI's own origin.
    yield* router.add(
      "GET",
      "/ws/web",
      Effect.gen(function* () {
        yield* requireSameOrigin
        const you = yield* authenticateParticipant
        return yield* serveChannel({
          hello: WebHello,
          outgoing: HubToWeb,
          welcome: () =>
            Effect.succeed(
              HubToWeb.cases.WebWelcome.make({ protocolVersion: ProtocolVersion, you }),
            ),
        })
      }),
    )
  }),
)
