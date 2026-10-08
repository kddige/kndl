import {
  type BuildVersion,
  checkHandshake,
  HubToRunner,
  ProtocolVersion,
  RunnerToHub,
} from "@kndl/protocol"
import { readBuildVersion } from "@kndl/protocol/checkout"
import { Data, Duration, Effect, Redacted, Schema } from "effect"
import { Socket } from "effect/socket"
import { ClaudeModels } from "./ClaudeModels.ts"
import { HubLink } from "./HubLink.ts"
import { RunnerConfig, runnerConnectionUrl, runnerSocketUrl } from "./RunnerConfig.ts"
import { Sessions } from "./Sessions.ts"
import { Tunnels } from "./Tunnels.ts"
import { Updater } from "./Updater.ts"

/**
 * The Hub turned this Runner away, such as for speaking another protocol version: it says the
 * commit it runs, if it is new enough to (ADR 0011).
 */
export class HubRejected extends Data.TaggedError("HubRejected")<{
  readonly message: string
  readonly hubVersion?: BuildVersion | undefined
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
  /**
   * The wait after the Hub turned the Runner away. It never exits for that, which its service
   * would only restart in a loop: it retries this slowly, in case the Hub or it was updated.
   */
  readonly rejected?: Duration.Input
}

export const DefaultBackoff: Backoff = {
  initial: "500 millis",
  max: "30 seconds",
  rejected: "1 minute",
}

/** How long the Hub has to answer the hello. */
const WelcomeTimeout = Duration.seconds(10)

/** The commit this Runner runs, for its hello (ADR 0011). Read once: it doesn't change. */
const buildVersion = readBuildVersion()

/**
 * What the Runner logs when the Hub no longer takes its token: it was removed on the Runners
 * page, or a Re-pair gave another machine (or another `runner join` here) its place.
 */
export const TokenRefusedText =
  "The Hub doesn't accept this Runner's token: the Runner was removed on the Hub's Runners page, or paired again with a new token. To pair this machine again, make a code on the Runners page (Add a Runner, or Re-pair) and run `kndl runner join '<link>'`. Retrying meanwhile."

/** Whether the Hub refuses the Runner's token, by asking it over HTTP. */
const tokenRefused = Effect.gen(function* () {
  const config = yield* RunnerConfig
  return yield* Effect.tryPromise(() =>
    fetch(runnerConnectionUrl(config.hubUrl), {
      headers: { authorization: `Bearer ${Redacted.value(config.token)}` },
      signal: AbortSignal.timeout(5_000),
    }),
  ).pipe(
    Effect.map((response) => response.status === 401),
    Effect.orElseSucceed(() => false),
  )
})

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
 * hands the Hub's messages to {@link Sessions}, those about updating to the {@link Updater}, and
 * those opening tunnels to {@link Tunnels}.
 * Reconnects with exponential backoff, which starts over after every welcome. Never ends: when the
 * Hub turns it away, it says what to do, updates itself if it can, and retries slowly.
 */
export const runHubConnection = (backoff: Backoff = DefaultBackoff) =>
  Effect.gen(function* () {
    const updater = yield* Updater
    const initial = Duration.toMillis(Duration.fromInputUnsafe(backoff.initial))
    const max = Duration.toMillis(Duration.fromInputUnsafe(backoff.max))
    const rejectedWait = Duration.fromInputUnsafe(backoff.rejected ?? "1 minute")
    let delay = initial
    for (;;) {
      const welcomed = yield* connectOnce.pipe(
        Effect.catchTag("ConnectionLost", (lost) =>
          Effect.gen(function* () {
            yield* Effect.logWarning(`Hub connection: ${lost.message}`)
            if (yield* tokenRefused) yield* Effect.logError(TokenRefusedText)
            return lost.welcomed
          }),
        ),
        Effect.catchTag("HubRejected", (rejected) =>
          Effect.gen(function* () {
            yield* Effect.logError(`The Hub turned this Runner away: ${rejected.message}`)
            yield* updater.rejected(rejected.hubVersion)
            yield* Effect.logInfo(`Connecting to the Hub again in ${Duration.format(rejectedWait)}`)
            yield* Effect.sleep(rejectedWait)
            return "rejected" as const
          }),
        ),
      )
      if (welcomed === "rejected") {
        delay = initial
        continue
      }
      if (welcomed) delay = initial
      yield* Effect.logInfo(`Reconnecting to the Hub in ${Math.round(delay)} ms`)
      yield* Effect.sleep(Duration.millis(delay))
      delay = Math.min(delay * 2, max)
    }
  })

/** What the hello shows for a Runner with no Claude credential of its own. */
export const NoClaudeCredentialText = "No Claude credential"

const connectOnce = Effect.scoped(
  Effect.gen(function* () {
    const config = yield* RunnerConfig
    const sessions = yield* Sessions
    const updater = yield* Updater
    const tunnels = yield* Tunnels
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
    const hello = yield* updater.hello
    const models = yield* (yield* ClaudeModels).current
    const ownAccount = yield* sessions.ownClaudeAccount
    const write = (message: RunnerToHub) => writer.write(JSON.stringify(encodeOutgoing(message)))

    yield* write(
      RunnerToHub.cases.RunnerHello.make({
        protocolVersion: ProtocolVersion,
        name: config.name,
        // A Hub from before requires `login`: it shows the Runner's own credential, if any.
        login: { account: ownAccount ?? NoClaudeCredentialText },
        sessions: [...(yield* sessions.running)],
        ...(yield* Effect.map(sessions.withoutModToken, (ids) =>
          ids.length === 0 ? {} : { withoutModToken: [...ids] },
        )),
        ...(buildVersion !== undefined && { version: buildVersion }),
        asksCloneAccess: true,
        updater: hello.updater,
        ...(hello.lastUpdate !== undefined && { lastUpdate: hello.lastUpdate }),
        ...(models !== undefined && { models }),
        relaunches: true,
        forwardsPorts: true,
        relaysPlugins: true,
        ownClaudeCredential: ownAccount !== undefined,
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
      return yield* new HubRejected({
        message: welcome.value.message,
        hubVersion: welcome.value.hubVersion,
      })
    }
    const mismatch = checkHandshake(answer)
    if (mismatch !== undefined) return yield* new HubRejected({ message: mismatch.message })
    if (welcome._tag === "Failure" || welcome.value._tag !== "RunnerWelcome") {
      return yield* lost("the Hub's first message was not a welcome")
    }

    welcomed = true
    yield* Effect.logInfo(`Connected to the Hub as Runner ${welcome.value.runnerId}`)
    yield* updater.welcomed
    yield* hub.connect(write)
    yield* Effect.addFinalizer(() => hub.disconnect)
    yield* sessions.snapshotAll

    // Messages from the rest of the batch the welcome came in, then everything after it.
    const route = (text: string) => dispatch(sessions, updater, tunnels, text)
    yield* Effect.forEach(first.slice(1), route, { discard: true })
    return yield* Effect.forever(
      pull.pipe(Effect.flatMap((batch) => Effect.forEach(batch, route, { discard: true }))),
    ).pipe(Effect.mapError((error) => lost(`the connection closed: ${error.message}`)))
  }),
)

const dispatch = (
  sessions: Sessions["Service"],
  updater: Updater["Service"],
  tunnels: Tunnels["Service"],
  text: string,
) => {
  const message = decodeIncoming(parseJson(text))
  if (message._tag === "Failure") {
    return Effect.logWarning("Ignored a message from the Hub the Runner could not decode")
  }
  const incoming = message.value
  if (incoming._tag === "CheckUpdate" || incoming._tag === "ApplyUpdate") {
    return updater.handle(incoming)
  }
  if (incoming._tag === "OpenTunnel") return tunnels.open(incoming)
  return sessions.handle(incoming)
}
