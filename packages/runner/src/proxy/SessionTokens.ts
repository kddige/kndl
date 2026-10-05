// Session tokens (ADR 0013): the only credential a Session's Claude Code and mod hold. Every
// guest reaches the credential proxy from the same loopback address (spike #142), so the token
// alone says which Session a request is from. The proxy swaps it for the Session's Claude
// credential on the way to Anthropic, and for its mod token on the way to the Hub.
//
// A token is `chp_` and 32 random bytes. It is issued when a Session starts or wakes, replaced
// when it starts again, and revoked when it sleeps, is archived or exits. Tokens, and the
// credentials and mod tokens they stand for, live in this process's memory alone: never on disk,
// so a Runner restart revokes them all.

import { createHash, randomBytes } from "node:crypto"
import type { ClaudeCredential, SessionId } from "@claude-hub/protocol"
import { Context, Effect, Layer, Redacted } from "effect"

/** What a Session token stands for. */
export interface SessionGrant {
  readonly sessionId: SessionId
  /** The mod token the Hub gave the Session; the relay calls the Hub with it. */
  readonly modToken: Redacted.Redacted<string>
  /**
   * The Claude credential of the Session's Creator. Without one, the Session runs on the Runner's
   * own (see RunnerCredential.ts).
   */
  readonly credential?: ClaudeCredential
}

export class SessionTokens extends Context.Service<
  SessionTokens,
  {
    /** A new token for the Session, revoking any it had before. */
    readonly issue: (grant: SessionGrant) => Effect.Effect<Redacted.Redacted<string>>
    /** Revokes the Session's token, forgetting its credential and mod token. */
    readonly revoke: (sessionId: SessionId) => Effect.Effect<void>
    /** What a presented token stands for, or undefined for one that isn't live. */
    readonly find: (token: string) => Effect.Effect<SessionGrant | undefined>
  }
>()("@claude-hub/runner/SessionTokens") {}

/** What a Session token starts with, so a leaked one is recognisable. */
export const SessionTokenPrefix = "chp_"

const digest = (token: string) => createHash("sha256").update(token).digest("hex")

/**
 * Keeps the live tokens by their SHA-256. A lookup by hash takes the same time however much of a
 * guessed token is right, so no constant-time compare is needed.
 */
export const makeSessionTokens = () => {
  const grants = new Map<string, SessionGrant>()
  const hashes = new Map<SessionId, string>()

  const revokeNow = (sessionId: SessionId) => {
    const hash = hashes.get(sessionId)
    if (hash !== undefined) grants.delete(hash)
    hashes.delete(sessionId)
  }

  return SessionTokens.of({
    issue: (grant) =>
      Effect.sync(() => {
        revokeNow(grant.sessionId)
        const token = `${SessionTokenPrefix}${randomBytes(32).toString("base64url")}`
        const hash = digest(token)
        grants.set(hash, grant)
        hashes.set(grant.sessionId, hash)
        return Redacted.make(token)
      }),
    revoke: (sessionId) => Effect.sync(() => revokeNow(sessionId)),
    find: (token) =>
      Effect.sync(() =>
        token.startsWith(SessionTokenPrefix) ? grants.get(digest(token)) : undefined,
      ),
  })
}

export const SessionTokensLive = Layer.sync(SessionTokens, makeSessionTokens)
