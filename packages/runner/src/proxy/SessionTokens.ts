// Session tokens (ADR 0013): the only credential a Session's Claude Code and mod hold. Every
// guest reaches the credential proxy from the same loopback address (spike #142), so the token
// alone says which Session a request is from. The proxy swaps it for the Session's Claude
// credential on the way to Anthropic, and for its mod token on the way to the Hub.
//
// A token is `chp_` and 32 random bytes. It is issued when a Session starts or wakes, replaced
// when it starts again, and revoked when it sleeps, is archived or exits. Tokens, and the
// credentials and mod tokens they stand for, live in this process's memory alone: never on disk.
//
// A Runner restart keeps running Sessions running (#157): the Runner reads each one's token back
// from its Claude Code's environment in the Sandbox and holds it, for that Session alone. A held
// token is answered "not yet" until the Hub has given the Session a new mod token, and is then
// let in again, standing for the Session's new grant.

import { createHash, randomBytes } from "node:crypto"
import type { ClaudeCredential, SessionId } from "@kndl/protocol"
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
    /**
     * The Session's token, standing for the grant: the one held for it after a Runner restart,
     * if any, otherwise a new one, revoking any it had before.
     */
    readonly issue: (grant: SessionGrant) => Effect.Effect<Redacted.Redacted<string>>
    /**
     * Holds the token a Session's Claude Code runs with, read back after a Runner restart, until
     * {@link issue} lets it in again. False for one that isn't a Session token, or is another's.
     */
    readonly hold: (sessionId: SessionId, token: string) => Effect.Effect<boolean>
    /** Revokes the Session's token, held or live, forgetting its credential and mod token. */
    readonly revoke: (sessionId: SessionId) => Effect.Effect<void>
    /**
     * What a presented token stands for: its grant, `"Held"` for a held one, or undefined for one
     * that isn't live.
     */
    readonly find: (token: string) => Effect.Effect<SessionGrant | "Held" | undefined>
  }
>()("@kndl/runner/SessionTokens") {}

/** What a Session token starts with, so a leaked one is recognisable. */
export const SessionTokenPrefix = "chp_"

const digest = (token: string) => createHash("sha256").update(token).digest("hex")

/** A live token's grant, or a held token itself, for {@link SessionTokens.issue} to let in. */
type Entry =
  | { readonly grant: SessionGrant }
  | { readonly heldFor: SessionId; readonly token: Redacted.Redacted<string> }

/**
 * Keeps the live tokens by their SHA-256. A lookup by hash takes the same time however much of a
 * guessed token is right, so no constant-time compare is needed.
 */
export const makeSessionTokens = () => {
  const entries = new Map<string, Entry>()
  const hashes = new Map<SessionId, string>()

  const revokeNow = (sessionId: SessionId) => {
    const hash = hashes.get(sessionId)
    if (hash !== undefined) entries.delete(hash)
    hashes.delete(sessionId)
  }

  return SessionTokens.of({
    issue: (grant) =>
      Effect.sync(() => {
        const hash = hashes.get(grant.sessionId)
        const entry = hash === undefined ? undefined : entries.get(hash)
        if (hash !== undefined && entry !== undefined && "heldFor" in entry) {
          entries.set(hash, { grant })
          return entry.token
        }
        revokeNow(grant.sessionId)
        const token = `${SessionTokenPrefix}${randomBytes(32).toString("base64url")}`
        const issued = digest(token)
        entries.set(issued, { grant })
        hashes.set(grant.sessionId, issued)
        return Redacted.make(token)
      }),
    hold: (sessionId, token) =>
      Effect.sync(() => {
        if (!token.startsWith(SessionTokenPrefix)) return false
        const hash = digest(token)
        if (entries.has(hash) && hashes.get(sessionId) !== hash) return false
        revokeNow(sessionId)
        entries.set(hash, { heldFor: sessionId, token: Redacted.make(token) })
        hashes.set(sessionId, hash)
        return true
      }),
    revoke: (sessionId) => Effect.sync(() => revokeNow(sessionId)),
    find: (token) =>
      Effect.sync(() => {
        const entry = token.startsWith(SessionTokenPrefix) ? entries.get(digest(token)) : undefined
        if (entry === undefined) return undefined
        return "heldFor" in entry ? "Held" : entry.grant
      }),
  })
}

export const SessionTokensLive = Layer.sync(SessionTokens, makeSessionTokens)
