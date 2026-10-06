// Who may reach a Session from outside the web channel, such as through a tunnel to one of its
// ports (#177, ADR 0016): anyone with access to its Repo, as for joining it (ADR 0003), checked on
// every connection. This is the one place that says who the caller is and whether they may: a
// new kind of credential is added to `identifyCaller` alone.

import type { Participant, SessionId, SessionSummary } from "@claude-hub/protocol"
import { Data, Effect, Option } from "effect"
import { HttpServerRequest } from "effect/http"
import { authenticateCli, authenticateParticipant, bearerToken, requireSameOrigin } from "./Auth.ts"
import { RepoAccess } from "./RepoAccess.ts"
import { Sessions } from "./Sessions.ts"

/**
 * The caller may not reach the Session. `NoSuchSession` alike whether it doesn't exist or is in
 * a Repo they have no access to, so a refusal says nothing of what exists.
 */
export class SessionAccessRefused extends Data.TaggedError("SessionAccessRefused")<{
  readonly reason: "NoSuchSession" | "AccessUnknown"
  readonly message: string
}> {}

/**
 * Who is calling: by a CLI token (#179), as `Authorization: Bearer`, or else by their sign-in
 * cookie. Each is checked against the database on every call, so a revoked token or a signed-out
 * cookie is refused from the next connection on. A browser always says which page a request
 * comes from, so a cookie is taken only from the web UI's own: another site's page can't use it
 * to open a tunnel. A request with no `Origin` isn't a browser's.
 */
const identifyCaller = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest
  if (Option.isSome(bearerToken(request))) {
    return (yield* authenticateCli).participant
  }
  if (request.headers.origin !== undefined) yield* requireSameOrigin
  return yield* authenticateParticipant
})

/**
 * Who is calling, and whether they may reach the Session: fails with `Unauthorized` (401) or
 * `ForeignOrigin` (403) for a credential that won't do, and with {@link SessionAccessRefused}
 * for one that will but has no access to the Session.
 */
export const authorizeSessionAccess = Effect.fn("authorizeSessionAccess")(function* (
  sessionId: SessionId,
) {
  const you = yield* identifyCaller
  const session = yield* (yield* Sessions).get(sessionId)
  const noSuchSession = new SessionAccessRefused({
    reason: "NoSuchSession",
    message: "There is no such Session.",
  })
  if (Option.isNone(session)) return yield* noSuchSession
  const allowed = yield* (yield* RepoAccess).check(you, session.value.repo).pipe(
    Effect.catchTag("RepoAccessUnknown", (error) =>
      Effect.andThen(
        Effect.logWarning(error.message),
        new SessionAccessRefused({
          reason: "AccessUnknown",
          message: "Could not check your access on GitHub; try again.",
        }),
      ),
    ),
  )
  if (!allowed) return yield* noSuchSession
  return { you, session: session.value } satisfies {
    readonly you: Participant
    readonly session: SessionSummary
  }
})
