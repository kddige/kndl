import { randomUUID } from "node:crypto"
import {
  GitAnswer,
  type GitAsk,
  type GitReply,
  GitRequest,
  GitRequestId,
  type SessionId,
  WipPushFailed,
} from "@claude-hub/protocol"
import { Context, Deferred, Duration, Effect, Layer, Schema } from "effect"
import { HubLink } from "./HubLink.ts"

/** How long the Runner waits for the Hub to answer a GitRequest. */
export const GitRequestTimeout = Duration.seconds(30)

const newRequestId = () => Schema.decodeSync(GitRequestId)(randomUUID())

/**
 * The Runner's side of the git conversation with the Hub (issues #13, #73). Only the Hub holds the
 * GitHub App's key, so the Runner asks it for tokens per Session, and tells it about failed WIP
 * pushes.
 */
export class HubGit extends Context.Service<
  HubGit,
  {
    /** Asks the Hub; never fails: no answer in time is a `GitFailed`. */
    readonly ask: (sessionId: SessionId, ask: GitAsk) => Effect.Effect<GitAnswer>
    /** Hands the Hub's GitReply to the request waiting for it. */
    readonly receive: (reply: GitReply) => Effect.Effect<void>
    /** Pushing the WIP ref failed; the Hub records it in the Session's log. */
    readonly wipPushFailed: (sessionId: SessionId, message: string) => Effect.Effect<void>
  }
>()("@claude-hub/runner/HubGit") {}

export const HubGitLive = Layer.effect(
  HubGit,
  Effect.gen(function* () {
    const hub = yield* HubLink
    const pending = new Map<string, Deferred.Deferred<GitAnswer>>()

    const unanswered = GitAnswer.cases.GitFailed.make({
      message: "The Hub did not answer in time; it may be unreachable. Try again.",
    })

    const ask = (sessionId: SessionId, question: GitAsk) =>
      Effect.gen(function* () {
        const requestId = newRequestId()
        const answer = yield* Deferred.make<GitAnswer>()
        pending.set(requestId, answer)
        // While the Runner is offline the request waits in the HubLink, and the timeout runs.
        return yield* hub.send(GitRequest.make({ requestId, sessionId, ask: question })).pipe(
          Effect.andThen(Deferred.await(answer)),
          Effect.timeoutOrElse({
            duration: GitRequestTimeout,
            orElse: () => Effect.succeed(unanswered),
          }),
          Effect.ensuring(Effect.sync(() => pending.delete(requestId))),
        )
      })

    return HubGit.of({
      ask,
      receive: (reply) =>
        Effect.suspend(() => {
          const waiting = pending.get(reply.requestId)
          pending.delete(reply.requestId)
          return waiting === undefined
            ? Effect.logDebug(
                `Ignored the answer to git request ${reply.requestId}, no longer waited for`,
              )
            : Deferred.succeed(waiting, reply.answer)
        }),
      wipPushFailed: (sessionId, message) => hub.send(WipPushFailed.make({ sessionId, message })),
    })
  }),
)
