// What a Session's Claude Code in its Sandbox is signed in with, and where its mod reaches the Hub
// (ADR 0026). Claude Code holds its Creator's Claude credential, a setup token, and talks to
// Anthropic directly; the mod and Claude Code's MCP traffic hold only the Session token, for the
// mod relay on the Runner's host. Both are set on Claude Code's own process alone (`tmux -e`),
// never on the Sandbox or written to its disk.

import type { ClaudeCredential } from "@kndl/protocol"
import { Redacted } from "effect"
import { ModEnvironment } from "./ClaudeLaunch.ts"

/** Where Claude Code reads a setup token from. */
export const ClaudeTokenVariable = "CLAUDE_CODE_OAUTH_TOKEN"

/** For every Claude Code in a Sandbox: no updates, and no traffic but what it needs. */
export const QuietClaude = {
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  DISABLE_AUTOUPDATER: "1",
} as const

/**
 * The variables that would sign Claude Code in some other way than its Creator's setup token, or
 * send its requests somewhere else: kept out of its own process's environment, from wherever they
 * came, as from a Variable or the Login environment. Other processes the Runner starts in the
 * Sandbox still get them.
 */
export const KeptOutOfClaude: ReadonlyArray<string> = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
]

/**
 * The environment Claude Code and its mod run with in the Sandbox: `base`, what the Sandbox and
 * the launch give it, less {@link KeptOutOfClaude}, then the relay and the Session token for the
 * mod, and the Creator's setup token as {@link ClaudeTokenVariable}, which wins over a Variable of
 * that name.
 */
export function claudeEnvironment(options: {
  readonly base: Readonly<Record<string, string>>
  /** The relay as the guest reaches it, such as `http://host.microsandbox.internal:7778`. */
  readonly relayUrl: string
  readonly sessionToken: Redacted.Redacted<string>
  /** The Session's Creator's, fetched from the Hub as it starts or wakes. */
  readonly credential: ClaudeCredential
}): Record<string, string> {
  const env: Record<string, string> = { ...options.base }
  for (const name of KeptOutOfClaude) delete env[name]
  return {
    ...env,
    [ModEnvironment.hubUrl]: options.relayUrl,
    [ModEnvironment.modToken]: Redacted.value(options.sessionToken),
    ...QuietClaude,
    [ClaudeTokenVariable]: Redacted.value(options.credential.token),
  }
}
