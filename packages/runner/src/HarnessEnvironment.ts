// What a Session's Harness runs with in its Sandbox, whichever Harness it is (ADR 0026, ADR 0029):
// the variables its mod reaches the Hub by, the one that says which Harness it is, and the rest of
// its environment. The mod and its MCP traffic hold only the Session token, for the mod relay on the
// Runner's host; Claude Code, or pi's Claude bridge, holds the Creator's Claude credential, a setup
// token, and talks to Anthropic directly. All of it is set on the Harness's own process alone
// (`tmux -e`), never on the Sandbox or written to its disk.

import type { ClaudeCredential } from "@kndl/protocol"
import { Redacted } from "effect"
import { ClaudeTokenVariable, KeptOutOfClaude, QuietClaude } from "./ClaudeEnvironment.ts"

/**
 * The environment variables the mod reads to reach the Hub. The Hub's URL and the mod token are
 * the mod relay's and the Session token ({@link harnessEnvironment}); the launch sets the rest.
 *
 * The conversation is the one the Harness was launched as. A `claude` or `pi` run inside the
 * Session inherits all of them, but is another conversation, which the mod doesn't link (#321).
 */
export const ModEnvironment = {
  hubUrl: "KNDL_URL",
  sessionId: "KNDL_SESSION_ID",
  modToken: "KNDL_MOD_TOKEN",
  conversationId: "KNDL_CONVERSATION_ID",
} as const

/**
 * The variable that says which Harness a Session's process is (ADR 0029): `Pi` for pi, and
 * `ClaudeCode` for Claude Code. Read back from it after a Runner restart, as its Session token is,
 * to know how to start it again, its Harness being able to change while it runs (ADR 0030). A
 * Claude Code started before pi has none.
 */
export const HarnessVariable = "KNDL_HARNESS"

/**
 * The variables kept out of a Harness's own process's environment, from wherever they came, as
 * from a Variable or the Login environment; other processes the Runner starts in the Sandbox still
 * get them:
 *
 * - {@link KeptOutOfClaude}, which would sign Claude Code in some other way than its Creator's
 *   setup token, or send its requests somewhere else. pi passes its environment on to the Claude
 *   Code its Claude bridge runs, so pi is kept from them too.
 * - Without its Creator's Claude credential, a setup token from anywhere else, which would have
 *   pi's Claude bridge spend someone else's (ADR 0026). Claude Code always has its Creator's.
 */
export const keptOut = (credential: ClaudeCredential | undefined): ReadonlyArray<string> =>
  credential === undefined ? [...KeptOutOfClaude, ClaudeTokenVariable] : KeptOutOfClaude

/** What a Harness's process is started with: its environment, and what is unset from it. */
export interface HarnessEnvironment {
  readonly env: Record<string, string>
  /** {@link keptOut}: unset too, as `tmux -e` adds to the environment tmux has. */
  readonly unset: ReadonlyArray<string>
}

/**
 * The environment a Harness and its mod run with in the Sandbox, Claude Code's and pi's alike:
 * `base`, what the Sandbox and the launch give it, less {@link keptOut}; then the relay and the
 * Session token for the mod; and, when the Creator has one, their Claude credential, as
 * {@link ClaudeTokenVariable}, which wins over a Variable of that name, with what keeps Claude Code
 * quiet. Claude Code runs on it, and pi's Claude bridge for Claude's Models.
 */
export function harnessEnvironment(options: {
  readonly base: Readonly<Record<string, string>>
  /** The relay as the guest reaches it, such as `http://host.microsandbox.internal:7778`. */
  readonly relayUrl: string
  readonly sessionToken: Redacted.Redacted<string>
  /**
   * The Session's Creator's, fetched from the Hub as it starts or wakes: always for Claude Code,
   * and for pi when the Hub gave it.
   */
  readonly credential?: ClaudeCredential
}): HarnessEnvironment {
  const unset = keptOut(options.credential)
  const env: Record<string, string> = { ...options.base }
  for (const name of unset) delete env[name]
  return {
    env: {
      ...env,
      [ModEnvironment.hubUrl]: options.relayUrl,
      [ModEnvironment.modToken]: Redacted.value(options.sessionToken),
      ...(options.credential === undefined
        ? {}
        : { ...QuietClaude, [ClaudeTokenVariable]: Redacted.value(options.credential.token) }),
    },
    unset,
  }
}
