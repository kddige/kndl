import { Redacted, Schema } from "effect"

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
