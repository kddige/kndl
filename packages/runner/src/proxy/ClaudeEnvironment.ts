// What Claude Code in a Sandbox is told about its credential and where to send requests (ADR
// 0013, spike #142). It holds only the Session token, and sends both inference and the mod's
// calls to the credential proxy on the Runner's host.

import type { ClaudeCredential } from "@kndl/protocol"
import { Redacted } from "effect"
import { ModEnvironment } from "../ClaudeLaunch.ts"

/**
 * The scopes a `claude setup-token` token has, which Claude Code can't ask Anthropic for through
 * the proxy. `user:inference` is what lets it run Turns on the subscription.
 */
export const ClaudeOAuthScopes =
  "user:inference user:profile user:sessions:claude_code user:mcp_servers user:file_upload user:plugins"

/** For every Session in a Sandbox: no updates, and no traffic but inference. */
const quiet = {
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  DISABLE_AUTOUPDATER: "1",
} as const

/**
 * What tells Claude Code which kind of credential it runs on, holding the Session token in its
 * place. A subscription token is `CLAUDE_CODE_OAUTH_TOKEN`, with the base URL taken as Anthropic's
 * own and the plan stated, since Claude Code can't fetch its profile through the proxy. An API key
 * is `ANTHROPIC_AUTH_TOKEN`, a plain bearer: Claude Code runs as on the API, with none of the
 * subscription's settings, and no prompt to approve a key. Without a credential, as when the
 * Runner has none either, it is told as for a subscription token with no plan.
 */
export function credentialEnvironment(
  credential: ClaudeCredential | undefined,
  token: Redacted.Redacted<string>,
): Record<string, string> {
  if (credential?._tag === "ApiKey") return { ANTHROPIC_AUTH_TOKEN: Redacted.value(token) }
  const plan = credential?.plan
  return {
    CLAUDE_CODE_OAUTH_TOKEN: Redacted.value(token),
    _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL: "1",
    CLAUDE_CODE_OAUTH_SCOPES: ClaudeOAuthScopes,
    ...(plan === undefined ? {} : { CLAUDE_CODE_SUBSCRIPTION_TYPE: plan.subscriptionType }),
    ...(plan?.rateLimitTier === undefined
      ? {}
      : { CLAUDE_CODE_RATE_LIMIT_TIER: plan.rateLimitTier }),
  }
}

/**
 * The environment Claude Code and its mod run with in the Sandbox: the proxy for Anthropic's API
 * and for the Hub, the Session token for both, and the credential's kind. The launch adds the rest
 * (ClaudeLaunch.ts).
 */
export function sandboxClaudeEnvironment(options: {
  /** The proxy as the guest reaches it, such as `http://host.microsandbox.internal:7778`. */
  readonly proxyUrl: string
  readonly token: Redacted.Redacted<string>
  /** The credential the proxy will use: the Session's own, or else the Runner's. */
  readonly credential: ClaudeCredential | undefined
}): Record<string, string> {
  return {
    ANTHROPIC_BASE_URL: options.proxyUrl,
    [ModEnvironment.hubUrl]: options.proxyUrl,
    [ModEnvironment.modToken]: Redacted.value(options.token),
    ...quiet,
    ...credentialEnvironment(options.credential, options.token),
  }
}
