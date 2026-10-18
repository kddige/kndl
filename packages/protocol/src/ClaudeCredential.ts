import { Redacted, Schema } from "effect"
import { SecretValue } from "./Environment.ts"
import { CredentialRequestId, RequestId, SessionId } from "./Ids.ts"
import { EpochMillis } from "./Session.ts"

// The Claude credential a Session's Claude Code runs on (ADR 0026): its Creator's own setup token,
// stored on the Hub and handed to the Runner as the Session starts or wakes. Claude Code in the
// Sandbox holds it in its own environment and talks to Anthropic directly. There is no fallback:
// a Session whose Creator has none doesn't start. API keys aren't taken for now (#334).

/** A Claude credential: a subscription token, the only kind taken for now (#334). */
export const ClaudeCredential = Schema.Union([
  /**
   * A subscription token, as `claude setup-token` prints (`sk-ant-oat…`), which Claude Code reads
   * from `CLAUDE_CODE_OAUTH_TOKEN`.
   */
  Schema.TaggedStruct("OAuthToken", {
    token: Schema.RedactedFromValue(Schema.NonEmptyString),
  }),
]).pipe(Schema.toTaggedUnion("_tag"))
export type ClaudeCredential = typeof ClaudeCredential.Type

/** What every Anthropic API key starts with: refused for now (#334). */
export const ApiKeyPrefix = "sk-ant-api"

/** What every subscription token starts with, such as one `claude setup-token` prints. */
export const OAuthTokenPrefix = "sk-ant-oat"

/**
 * The credential a pasted secret is: a subscription token. Undefined for a blank secret, or an API
 * key (#334).
 */
export function credentialFromSecret(secret: string): ClaudeCredential | undefined {
  const value = secret.trim()
  if (value === "" || value.startsWith(ApiKeyPrefix)) return undefined
  return ClaudeCredential.cases.OAuthToken.make({ token: Redacted.make(value) })
}

/**
 * The variables that would sign Claude Code in some other way than its Creator's setup token, or
 * send its requests somewhere else: kept out of every Claude Code kndl runs, from wherever they
 * came, as from a Variable or the Login environment. The Runner keeps them out of a Session's
 * Harness's own process, pi's too, as pi passes its environment on to the Claude Code its Claude
 * bridge runs (ADR 0029), and the bridge keeps them out of that Claude Code. Other processes in the
 * Sandbox still get them.
 */
export const ClaudeCodeSignInVariables: ReadonlyArray<string> = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
]

// ── A person's own credential, stored on the Hub (ADR 0015) ────────────────

/** The kinds of Claude credential, by their `_tag`: a subscription token alone for now (#334). */
export const ClaudeCredentialKind = Schema.Literals(["OAuthToken"])
export type ClaudeCredentialKind = typeof ClaudeCredentialKind.Type

/** The kind a pasted secret is, by its prefix: undefined for one that isn't a subscription token. */
export function claudeCredentialKindOf(secret: string): ClaudeCredentialKind | undefined {
  return secret.trim().startsWith(OAuthTokenPrefix) ? "OAuthToken" : undefined
}

/**
 * Why a pasted secret can't be stored as a Claude credential, or undefined when it can. Checks its
 * shape only; the Hub then asks Anthropic whether it is valid.
 */
export function claudeCredentialProblem(secret: string): string | undefined {
  const value = secret.trim()
  if (value === "") return "Paste the token `claude setup-token` printed."
  if (value.startsWith(ApiKeyPrefix))
    return "API keys aren't taken for now. Run `claude setup-token` and paste the token it prints."
  if (claudeCredentialKindOf(value) === undefined)
    return `That isn't a Claude setup token: it starts with ${OAuthTokenPrefix}.`
  if (/\s/.test(value) || value.length < 24)
    return "That doesn't look like a whole token. Copy it again, all on one line."
  return undefined
}

/**
 * A stored credential, as its owner sees it: write-only, so never the value, only its last
 * characters to tell it apart.
 */
export const ClaudeCredentialInfo = Schema.Struct({
  kind: ClaudeCredentialKind,
  /** The last 4 characters of the token. */
  last4: Schema.String,
  addedAt: EpochMillis,
})
export type ClaudeCredentialInfo = typeof ClaudeCredentialInfo.Type

// ── Web to Hub ─────────────────────────────────────────────────────────────

/**
 * Store the signed-in person's Claude credential, replacing any before. The Hub checks it with
 * Anthropic first and refuses one Anthropic rejects. Answered with {@link ClaudeCredentialState}
 * or a CommandFailed saying why.
 */
export const SetClaudeCredential = Schema.TaggedStruct("SetClaudeCredential", {
  requestId: RequestId,
  /** The token, as pasted. */
  secret: SecretValue,
})
export type SetClaudeCredential = typeof SetClaudeCredential.Type

/** Remove the signed-in person's Claude credential. Answered with {@link ClaudeCredentialState}. */
export const RemoveClaudeCredential = Schema.TaggedStruct("RemoveClaudeCredential", {
  requestId: RequestId,
})
export type RemoveClaudeCredential = typeof RemoveClaudeCredential.Type

// ── Hub to web ─────────────────────────────────────────────────────────────

/**
 * The signed-in person's Claude credential, or null when they have stored none. Sent to them
 * alone: after the welcome, and to each of their connections when it changes. Answers
 * {@link SetClaudeCredential} and {@link RemoveClaudeCredential} with their `requestId`.
 */
export const ClaudeCredentialState = Schema.TaggedStruct("ClaudeCredentialState", {
  requestId: Schema.optionalKey(RequestId),
  credential: Schema.NullOr(ClaudeCredentialInfo),
  /** Present when it was stored without Anthropic confirming it, such as when it was unreachable. */
  warning: Schema.optionalKey(Schema.String),
})
export type ClaudeCredentialState = typeof ClaudeCredentialState.Type

// ── Runner to Hub ──────────────────────────────────────────────────────────

/**
 * Ask for the Claude credential of a Session this Runner runs, just before starting its Claude
 * Code, to keep in memory only. Answered with {@link ClaudeCredentialFetched} or
 * {@link ClaudeCredentialRefused}.
 */
export const FetchClaudeCredential = Schema.TaggedStruct("FetchClaudeCredential", {
  requestId: CredentialRequestId,
  sessionId: SessionId,
})
export type FetchClaudeCredential = typeof FetchClaudeCredential.Type

// ── Hub to Runner ──────────────────────────────────────────────────────────

/**
 * Answers {@link FetchClaudeCredential}: the Session's Creator's credential. A Creator with none,
 * or who isn't a Member any more, is answered with a {@link ClaudeCredentialRefused}: the Session
 * doesn't start.
 */
export const ClaudeCredentialFetched = Schema.TaggedStruct("ClaudeCredentialFetched", {
  requestId: CredentialRequestId,
  credential: ClaudeCredential,
})
export type ClaudeCredentialFetched = typeof ClaudeCredentialFetched.Type

/**
 * Answers {@link FetchClaudeCredential} the Hub refused: for a Session not the Runner's, or whose
 * Creator has no credential or isn't a Member any more.
 */
export const ClaudeCredentialRefused = Schema.TaggedStruct("ClaudeCredentialRefused", {
  requestId: CredentialRequestId,
  message: Schema.String,
})
export type ClaudeCredentialRefused = typeof ClaudeCredentialRefused.Type
