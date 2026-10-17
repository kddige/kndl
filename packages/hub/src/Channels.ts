// The WebSocket channels to Runners and web clients. Each authenticates before the upgrade
// (a request without a valid credential gets 401 and no socket), then opens with the peer's
// hello, answered by a welcome or a HandshakeRejected. After the welcome, the SessionRelay
// handles every message, and sends the peer what it needs to know.
//
// The mod, which can't open a WebSocket, talks to the Hub over plain HTTP instead: see
// ModRoutes.ts.

import {
  type BuildVersion,
  checkHandshake,
  HandshakeRejected,
  HubToRunner,
  HubToWeb,
  ProtocolVersion,
  RunnerHello,
  RunnerToHub,
  WebHello,
  WebToHub,
} from "@kndl/protocol"
import { Duration, Effect, Option, Queue, Schema, type Scope } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { Socket } from "effect/socket"
import { authenticateParticipant, authenticateRunner, requireSameOrigin } from "./Auth.ts"
import { HubShutdown } from "./HubShutdown.ts"
import { HubUpdates } from "./HubUpdates.ts"
import { HubVersion } from "./HubVersion.ts"
import { Members } from "./Members.ts"
import { type Peer, type Receive, SessionRelay } from "./SessionRelay.ts"

/** How long a peer has to send its hello once the socket is open. */
const helloTimeout = Duration.seconds(10)

/** Close codes the Hub uses, beside the standard 1000 and 1008. */
export const CloseCode = {
  /** No hello in time. */
  HelloTimeout: 4408,
  /** The Hub is shutting down. */
  GoingAway: 1001,
} as const

/**
 * Upgrades the request and runs the handshake: reads the hello, checks its protocol version,
 * decodes it with `hello`, and sends what `welcome` makes of it. Then `connect` gets the peer
 * and returns what to do with each message after the hello; its scope closes with the socket.
 *
 * Messages to the peer are queued and written by a fiber of their own, so sending never waits
 * on the peer.
 */
export const serveChannel = <Hello, In, Out>(options: {
  readonly hello: Schema.Codec<Hello, unknown>
  readonly incoming: Schema.Codec<In, unknown>
  readonly outgoing: Schema.Codec<Out, unknown>
  readonly welcome: (hello: Hello) => Out
  readonly connect: (
    hello: Hello,
    peer: Peer<Out>,
  ) => Effect.Effect<Receive<In>, never, Scope.Scope>
  /**
   * The Hub's commit, said in a rejection: a Runner turned away for its protocol version can
   * still update to it (ADR 0011).
   */
  readonly hubVersion?: BuildVersion | undefined
}) =>
  Effect.gen(function* () {
    const shutdown = yield* HubShutdown
    const request = yield* HttpServerRequest.HttpServerRequest
    const socket = yield* request.upgrade
    yield* Effect.scoped(
      Effect.gen(function* () {
        const writer = yield* socket.writer
        const pull = yield* Socket.readerString(socket)
        const reject = (rejection: HandshakeRejected) =>
          writer
            .write(JSON.stringify(Schema.encodeSync(HandshakeRejected)(rejection)))
            .pipe(Effect.andThen(writer.write(new Socket.CloseEvent(1008, rejection.reason))))

        const [first, ...rest] = yield* pull.pipe(
          Effect.timeoutOrElse({
            duration: helloTimeout,
            orElse: () =>
              writer
                .write(new Socket.CloseEvent(CloseCode.HelloTimeout, "No hello"))
                .pipe(Effect.andThen(Effect.interrupt)),
          }),
        )
        const message = parseJson(first)
        const mismatch = checkHandshake(message, options.hubVersion)
        if (mismatch !== undefined) return yield* reject(mismatch)
        const hello = Schema.decodeUnknownExit(options.hello)(message)
        if (hello._tag === "Failure") {
          return yield* reject(
            HandshakeRejected.make({
              reason: "MalformedHandshake",
              protocolVersion: ProtocolVersion,
              message: "The hello is not one this channel accepts.",
              ...(options.hubVersion !== undefined && { hubVersion: options.hubVersion }),
            }),
          )
        }

        const outbox = yield* Queue.unbounded<string | Socket.CloseEvent>()
        yield* Effect.forkScoped(
          Effect.forever(Effect.flatMap(Queue.take(outbox), (chunk) => writer.write(chunk))),
        )
        const encode = Schema.encodeSync(options.outgoing)
        const peer: Peer<Out> = {
          send: (out) => void Queue.offerUnsafe(outbox, JSON.stringify(encode(out))),
          close: (code, reason) =>
            void Queue.offerUnsafe(outbox, new Socket.CloseEvent(code, reason)),
        }
        peer.send(options.welcome(hello.value))
        const receive = yield* options.connect(hello.value, peer)

        const decode = Schema.decodeUnknownExit(options.incoming)
        const receiveAll = Effect.fnUntraced(function* (texts: ReadonlyArray<string>) {
          for (const text of texts) {
            const decoded = decode(parseJson(text))
            if (decoded._tag === "Failure") {
              // Only its tag: the text may hold a Sensitive value.
              yield* Effect.logWarning("Dropped a message the channel doesn't accept", tagOf(text))
            } else {
              yield* receive(decoded.value)
            }
          }
        })
        yield* receiveAll(rest)
        yield* Effect.forever(Effect.flatMap(pull, receiveAll))
      }).pipe(
        // A shutting-down Hub closes the socket, or the server would wait for the peer to.
        Effect.raceFirst(
          Effect.andThen(
            shutdown.started,
            Effect.flatMap(socket.writer, (writer) =>
              writer.write(new Socket.CloseEvent(CloseCode.GoingAway, "The Hub is shutting down")),
            ),
          ),
        ),
        Effect.catchTag("SocketError", () => Effect.void),
        Effect.catchCause(Effect.logDebug),
      ),
    )
    return HttpServerResponse.empty()
  })

/** The `_tag` of a JSON message, or `undefined`, for logging a message without its contents. */
function tagOf(text: string): string | undefined {
  const message = parseJson(text)
  if (typeof message !== "object" || message === null || !("_tag" in message)) return undefined
  return typeof message._tag === "string" ? message._tag.slice(0, 64) : undefined
}

function parseJson(text: string | undefined): unknown {
  try {
    return JSON.parse(text ?? "")
  } catch {
    return undefined
  }
}

export const ChannelRoutes = HttpRouter.use(
  Effect.fn(function* (router) {
    const relay = yield* SessionRelay
    const members = yield* Members
    const hub = (yield* HubVersion).version
    const hubUpdates = yield* HubUpdates

    // A Runner, by its Runner token. Its RunnerId comes from the token, not the hello.
    yield* router.add(
      "GET",
      "/ws/runner",
      Effect.gen(function* () {
        const runner = yield* authenticateRunner
        return yield* serveChannel({
          hello: RunnerHello,
          incoming: RunnerToHub,
          outgoing: HubToRunner,
          welcome: () =>
            HubToRunner.cases.RunnerWelcome.make({
              protocolVersion: ProtocolVersion,
              runnerId: runner.runnerId,
            }),
          connect: (hello, peer) => relay.connectRunner(runner, hello, peer),
          hubVersion: hub,
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
        // Only for the web UI to show the People page or not: the relay checks each command.
        const owner = Option.contains(yield* Effect.orDie(members.owner), you.id)
        // The update check (ADR 0028) is the Owner's alone, and their only way to the Hub page.
        const update = owner ? Option.getOrUndefined(yield* hubUpdates.latest) : undefined
        return yield* serveChannel({
          hello: WebHello,
          incoming: WebToHub,
          outgoing: HubToWeb,
          welcome: () =>
            HubToWeb.cases.WebWelcome.make({
              protocolVersion: ProtocolVersion,
              you,
              ...(owner && { owner }),
              ...(hub !== undefined && { hub }),
              ...(update !== undefined && { hubUpdate: update }),
            }),
          connect: (_hello, peer) => relay.connectWeb(you, peer),
        })
      }),
    )
  }),
)
