// What the Claude Code that a Session's agent runs in its Sandbox is signed in with (ADR 0026): its
// Creator's Claude credential, a setup token, with which it talks to Anthropic directly, as the
// agent's Claude bridge runs it for Claude's Models. Set on the agent's own process alone
// (HarnessEnvironment.ts).

import { ClaudeCodeSignInVariables } from "@kndl/protocol"

/** Where Claude Code reads a setup token from. */
export const ClaudeTokenVariable = "CLAUDE_CODE_OAUTH_TOKEN"

/** For every Claude Code in a Sandbox: no updates, and no traffic but what it needs. */
export const QuietClaude = {
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  DISABLE_AUTOUPDATER: "1",
} as const

/**
 * The variables that would sign Claude Code in some other way than its Creator's setup token, or
 * send its requests somewhere else: kept out of the agent's own process's environment, from
 * wherever they came, as from a Variable or the Login environment (HarnessEnvironment.ts). Other
 * processes the Runner starts in the Sandbox, its terminal among them, still get them.
 */
export const KeptOutOfClaude: ReadonlyArray<string> = ClaudeCodeSignInVariables
