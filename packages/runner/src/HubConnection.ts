import {
  checkHandshake,
  HubToRunner,
  ProtocolVersion,
  type RunnerLogin,
  RunnerToHub,
} from "@claude-hub/protocol"
import { Data, Duration, Effect, Redacted, Schema } from "effect"
import { Socket } from "effect/socket"
import { HubLink } from "./HubLink.ts"
import { RunnerConfig, runnerSocketUrl } from "./RunnerConfig.ts"
import { Sessions } from "./Sessions.ts"

/** The Hub turned this Runner away for good, such as for speaking another protocol version. */
export class HubRejected extends Data.TaggedError("HubRejected")<{
  readonly message: string
}> {}

/** One connection ended, before or after the welcome; the Runner reconnects. */
class ConnectionLost extends Data.TaggedError("ConnectionLost")<{
  readonly message: string
  readonly welcomed: boolean
}> {}

export interface Backoff {
  /** The wait before the first reconnect. */
  readonly initial: Duration.Input
  /** The longest wait between reconnects. */
  readonly max: Duration.Input
}

export const DefaultBackoff: Backoff = { initial: "500 millis", max: "30 seconds" }

/** How long the Hub has to answer the hello. */
const WelcomeTimeout = Duration.seconds(10)

const encodeOutgoing = Schema.encodeSync(RunnerToHub)
const decodeIncoming = Schema.decodeUnknownExit(HubToRunner)

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/**
 * Stays connected to the Hub: connects with the Runner token, says hello, and on the welcome
 * hands the Hub's messages to {@link Sessions}. Reconnects with exponential backoff, which starts
 * over after every welcome. Fails only with {@link HubRejected}.
 */
export const runHubConnection = (login: RunnerLogin, backoff: Backoff = DefaultBackoff) =>
  Effect.gen(function* () {
    const initial = Duration.toMillis(Duration.fromInputUnsafe(backoff.initial))
    const max = Duration.toMillis(Duration.fromInputUnsafe(backoff.max))
    let delay = initial
    for (;;) {
      const welcomed = yield* connectOnce(login).pipe(
        Effect.catchTag("ConnectionLost", (lost) =>
          Effect.logWarning(`Hub connection: ${lost.message}`).pipe(Effect.as(lost.welcomed)),
        ),
      )
      if (welcomed) delay = initial
      yield* Effect.logInfo(`Reconnecting to the Hub in ${Math.round(delay)} ms`)
      yield* Effect.sleep(Duration.millis(delay))
      delay = Math.min(delay * 2, max)
    }
  })

const connectOnce = (login: RunnerLogin) =>
  Effect.scoped(
    Effect.gen(function* () {
      const config = yield* RunnerConfig
      const sessions = yield* Sessions
      const hub = yield* HubLink
      const makeWebSocket = yield* Socket.WebSocketConstructor
      const url = runnerSocketUrl(config.hubUrl)
      let welcomed = false
      const lost = (message: string) => new ConnectionLost({ message, welcomed })

      const socket = yield* Socket.fromWebSocket(
        Effect.acquireRelease(
          Effect.sync(() =>
            makeWebSocket(url, {
              headers: { authorization: `Bearer ${Redacted.value(config.token)}` },
            }),
          ),
          (ws) => Effect.sync(() => ws.close(1000)),
        ),
        { openTimeout: "10 seconds" },
      )
      const pull = yield* Socket.readerString(socket).pipe(
        Effect.mapError((error) => lost(`could not connect to ${url}: ${error.message}`)),
      )
      const writer = yield* socket.writer
      const write = (message: RunnerToHub) => writer.write(JSON.stringify(encodeOutgoing(message)))

      yield* write(
        RunnerToHub.cases.RunnerHello.make({
          protocolVersion: ProtocolVersion,
          name: config.name,
          login,
          sessions: [...(yield* sessions.running)],
        }),
      ).pipe(Effect.mapError((error) => lost(`could not send the hello: ${error.message}`)))

      const first = yield* pull.pipe(
        Effect.timeoutOrElse({
          duration: WelcomeTimeout,
          orElse: () => Effect.fail(lost("the Hub did not answer the hello in time")),
        }),
        Effect.mapError((error) =>
          error instanceof ConnectionLost
            ? error
            : lost(`the Hub closed the connection before welcoming: ${error.message}`),
        ),
      )
      const answer = parseJson(first[0])
      const welcome = decodeIncoming(answer)
      if (welcome._tag === "Success" && welcome.value._tag === "HandshakeRejected") {
        return yield* new HubRejected({ message: welcome.value.message })
      }
      const mismatch = checkHandshake(answer)
      if (mismatch !== undefined) return yield* new HubRejected({ message: mismatch.message })
      if (welcome._tag === "Failure" || welcome.value._tag !== "RunnerWelcome") {
        return yield* lost("the Hub's first message was not a welcome")
      }

      welcomed = true
      yield* Effect.logInfo(`Connected to the Hub as Runner ${welcome.value.runnerId}`)
      yield* hub.connect(write)
      yield* Effect.addFinalizer(() => hub.disconnect)
      yield* sessions.snapshotAll

      // Messages from the rest of the batch the welcome came in, then everything after it.
      yield* Effect.forEach(first.slice(1), (text) => dispatch(sessions, text), { discard: true })
      return yield* Effect.forever(
        pull.pipe(
          Effect.flatMap((batch) =>
            Effect.forEach(batch, (text) => dispatch(sessions, text), { discard: true }),
          ),
        ),
      ).pipe(Effect.mapError((error) => lost(`the connection closed: ${error.message}`)))
    }),
  )

const dispatch = (sessions: Sessions["Service"], text: string) => {
  const message = decodeIncoming(parseJson(text))
  return message._tag === "Success"
    ? sessions.handle(message.value)
    : Effect.logWarning("Ignored a message from the Hub the Runner could not decode")
}
