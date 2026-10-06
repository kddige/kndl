import { Redacted, Schema } from "effect"
import { SecretValue } from "./Environment.ts"
import { CredentialRequestId, RequestId, SessionId } from "./Ids.ts"
import { EpochMillis } from "./Session.ts"

// The Claude credential a Session's Claude Code runs on (ADR 0013, ADR 0015). Claude Code in the
// Sandbox holds only a Session token; the Runner's credential proxy swaps it for the credential
// on each request to Anthropic. A Session uses its Creator's credential, or else the Runner's own.

/** The Claude plans a subscription credential can be on, as Claude Code names them. */
export const ClaudeSubscriptionType = Schema.Literals(["pro", "max", "team", "enterprise"])
export type ClaudeSubscriptionType = typeof ClaudeSubscriptionType.Type

/**
 * The plan a subscription credential is on. Claude Code can't ask Anthropic for it through the
 * proxy, which forwards inference alone, so it is told: `CLAUDE_CODE_SUBSCRIPTION_TYPE` and
 * `CLAUDE_CODE_RATE_LIMIT_TIER`.
 */
export const ClaudePlan = Schema.Struct({
  subscriptionType: ClaudeSubscriptionType,
  /** As Claude Code's login records it, such as `default_claude_max_5x`. */
  rateLimitTier: Schema.optional(Schema.NonEmptyString),
})
export type ClaudePlan = typeof ClaudePlan.Type

/** A Claude credential, by how Anthropic takes it. */
export const ClaudeCredential = Schema.Union([
  /**
   * A subscription token, as `claude setup-token` prints (`sk-ant-oat…`), or the access token of
   * Claude Code's own login: sent as `Authorization: Bearer`.
   */
  Schema.TaggedStruct("OAuthToken", {
    token: Schema.RedactedFromValue(Schema.NonEmptyString),
    /** The plan it is on; Claude Code runs without one as on no plan. */
    plan: Schema.optional(ClaudePlan),
  }),
  /** An Anthropic API key (`sk-ant-api…`), billed per token: sent as `x-api-key`. */
  Schema.TaggedStruct("ApiKey", {
    key: Schema.RedactedFromValue(Schema.NonEmptyString),
  }),
]).pipe(Schema.toTaggedUnion("_tag"))
export type ClaudeCredential = typeof ClaudeCredential.Type

/** What every Anthropic API key starts with. */
export const ApiKeyPrefix = "sk-ant-api"

/** What every subscription token starts with, such as one `claude setup-token` prints. */
export const OAuthTokenPrefix = "sk-ant-oat"

/**
 * The credential a pasted secret is: an API key by its prefix, else a subscription token, on
 * `plan` when given. Undefined for a blank secret.
 */
export function credentialFromSecret(
  secret: string,
  plan?: ClaudePlan,
): ClaudeCredential | undefined {
  const value = secret.trim()
  if (value === "") return undefined
  if (value.startsWith(ApiKeyPrefix))
    return ClaudeCredential.cases.ApiKey.make({ key: Redacted.make(value) })
  return ClaudeCredential.cases.OAuthToken.make({
    token: Redacted.make(value),
    ...(plan === undefined ? {} : { plan }),
  })
}

/**
 * The rate-limit tier Claude Code's login records for a plan when none is given: Max's is the 5x
 * one, the smaller. Undefined for Team and Enterprise, whose tier depends on the seat.
 */
export function defaultRateLimitTier(subscriptionType: ClaudeSubscriptionType): string | undefined {
  switch (subscriptionType) {
    case "pro":
      return "default_claude_ai"
    case "max":
      return "default_claude_max_5x"
    default:
      return undefined
  }
}

// ── A person's own credential, stored on the Hub (ADR 0015) ────────────────

/** The two kinds of Claude credential, by their `_tag`. */
export const ClaudeCredentialKind = Schema.Literals(["OAuthToken", "ApiKey"])
export type ClaudeCredentialKind = typeof ClaudeCredentialKind.Type

/**
 * The plans a person picks for a subscription token. Max has two tiers that Claude Code tells
 * apart; Team and Enterprise are told apart by the plan alone.
 */
export const ClaudePlanChoice = Schema.Literals(["pro", "max5x", "max20x", "team", "enterprise"])
export type ClaudePlanChoice = typeof ClaudePlanChoice.Type

/** Each plan choice, in the order offered, with how it is shown. */
export const claudePlanChoices: ReadonlyArray<{
  readonly choice: ClaudePlanChoice
  readonly label: string
}> = [
  { choice: "pro", label: "Pro" },
  { choice: "max5x", label: "Max 5x" },
  { choice: "max20x", label: "Max 20x" },
  { choice: "team", label: "Team" },
  { choice: "enterprise", label: "Enterprise" },
]

/** How a plan choice is shown, such as "Max 5x". */
export function claudePlanLabel(choice: ClaudePlanChoice): string {
  return claudePlanChoices.find((each) => each.choice === choice)?.label ?? choice
}

/** The plan Claude Code is told for a plan choice. */
export function claudePlanOf(choice: ClaudePlanChoice): ClaudePlan {
  switch (choice) {
    case "pro":
      return { subscriptionType: "pro", rateLimitTier: "default_claude_ai" }
    case "max5x":
      return { subscriptionType: "max", rateLimitTier: "default_claude_max_5x" }
    case "max20x":
      return { subscriptionType: "max", rateLimitTier: "default_claude_max_20x" }
    case "team":
      return { subscriptionType: "team" }
    case "enterprise":
      return { subscriptionType: "enterprise" }
  }
}

/** The kind a pasted secret is, by its prefix: undefined for one that is neither. */
export function claudeCredentialKindOf(secret: string): ClaudeCredentialKind | undefined {
  const value = secret.trim()
  if (value.startsWith(ApiKeyPrefix)) return "ApiKey"
  if (value.startsWith(OAuthTokenPrefix)) return "OAuthToken"
  return undefined
}

/**
 * Why a pasted secret can't be stored as a Claude credential on `plan`, or undefined when it can.
 * Checks its shape only; the Hub then asks Anthropic whether it is valid.
 */
export function claudeCredentialProblem(
  secret: string,
  plan: ClaudePlanChoice | undefined,
): string | undefined {
  const value = secret.trim()
  if (value === "") return "Paste a token or an API key."
  const kind = claudeCredentialKindOf(value)
  if (kind === undefined)
    return `That isn't a Claude token or API key: a token starts with ${OAuthTokenPrefix}, a key with ${ApiKeyPrefix}.`
  if (/\s/.test(value) || value.length < 24)
    return "That doesn't look like a whole token or key. Copy it again, all on one line."
  if (kind === "OAuthToken" && plan === undefined) return "Pick the plan your Claude account is on."
  return undefined
}

/** The credential a pasted secret is stored as, with the plan picked for a token. */
export function claudeCredentialOf(
  secret: string,
  plan: ClaudePlanChoice | undefined,
): ClaudeCredential | undefined {
  return credentialFromSecret(secret, plan === undefined ? undefined : claudePlanOf(plan))
}

/**
 * A stored credential, as its owner sees it: write-only, so never the value, only its last
 * characters to tell it apart.
 */
export const ClaudeCredentialInfo = Schema.Struct({
  kind: ClaudeCredentialKind,
  /** The last 4 characters of the token or key. */
  last4: Schema.String,
  /** The plan picked for a subscription token. */
  plan: Schema.optionalKey(ClaudePlanChoice),
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
  /** The token or API key, as pasted. */
  secret: SecretValue,
  /** The plan, for a subscription token. */
  plan: Schema.optionalKey(ClaudePlanChoice),
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
 * Answers {@link FetchClaudeCredential}: the Session's Creator's credential, or for a Child
 * Session its Parent Session's Creator's. Absent when they have stored none: the Runner then
 * uses its own.
 */
export const ClaudeCredentialFetched = Schema.TaggedStruct("ClaudeCredentialFetched", {
  requestId: CredentialRequestId,
  credential: Schema.optionalKey(ClaudeCredential),
})
export type ClaudeCredentialFetched = typeof ClaudeCredentialFetched.Type

/** Answers {@link FetchClaudeCredential} the Hub refused, such as for a Session not the Runner's. */
export const ClaudeCredentialRefused = Schema.TaggedStruct("ClaudeCredentialRefused", {
  requestId: CredentialRequestId,
  message: Schema.String,
})
export type ClaudeCredentialRefused = typeof ClaudeCredentialRefused.Type
