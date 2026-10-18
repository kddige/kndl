// How a pi Session's pi runs in its Sandbox (ADR 0029): pi's TUI in tmux, as Claude Code's is,
// from the Runner's read-only bundle (sandbox/SandboxPi.ts), with the mod's pi extension, which
// links it to the Hub as hub-link links Claude Code.
//
// pi reaches every Provider through the Hub's Gateway, on the Session token alone, so a pi Session
// runs without its Creator's Claude credential. When it has one, pi gets it too, with the pinned
// Claude Code, which the extension's Claude bridge runs for Claude's Models: on pi's own process
// alone (`tmux -e`), as Claude Code gets it (ClaudeEnvironment.ts). pi passes its environment on to
// Claude Code, so what is kept out of Claude Code's is kept out of pi's.

import { posix } from "node:path"
import type {
  ClaudeCredential,
  GatewayServer,
  ModelName,
  SessionId,
  ThinkingLevel,
} from "@kndl/protocol"
import { Redacted } from "effect"
import { ClaudeTokenVariable, KeptOutOfClaude, QuietClaude } from "./ClaudeEnvironment.ts"
import { ModEnvironment } from "./ClaudeLaunch.ts"
import { claudeStateEnv } from "./sandbox/ClaudeState.ts"
import { piExtension, piStateGuestPath } from "./sandbox/SessionLayout.ts"

/**
 * The variable that says which Harness a Session's process is (ADR 0029), `Pi` for pi: read back
 * from it after a Runner restart, as its Session token is, to know how to start it again.
 */
export const HarnessVariable = "KNDL_HARNESS"

/** The variable pi's Claude bridge finds the pinned Claude Code by. */
export const ClaudeCodeVariable = "KNDL_CLAUDE_CODE"

/**
 * The variable the extension finds the Session's MCP servers in (the mod's pi/src/RepoSetup.ts):
 * the {@link GatewayServer}s, as JSON.
 */
export const McpServersVariable = "KNDL_MCP_SERVERS"

/**
 * The ids pi's `--session-id` takes: anything else, it refuses to start with. A UUID, which the
 * Runner picks for a new conversation, is one.
 */
export const PiSessionIdPattern = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/

export interface PiLaunchOptions {
  /** Node.js's executable in the Sandbox. */
  readonly nodePath: string
  /** pi's CLI in the Sandbox. */
  readonly cliPath: string
  readonly sessionId: SessionId
  /** The Session's copy of the mod in the Sandbox (SessionMod.ts), holding the {@link piExtension}. */
  readonly mod: string
  /**
   * pi's session id: its conversation, which `--session-id` creates when pi has none of that id,
   * and resumes when it has.
   */
  readonly conversationId: string
  /** The model, `<provider>/<id>`; pi's default when absent. */
  readonly model?: ModelName
  /** The thinking level; pi's default when absent. */
  readonly thinkingLevel?: ThinkingLevel
  /**
   * The pinned Claude Code's executable in the Sandbox, given when the Session's Creator has a
   * Claude credential, for the extension's Claude bridge; absent when they don't.
   */
  readonly claudePath?: string
  /** The MCP servers of the Installations it runs with (ADR 0020); none when absent. */
  readonly mcpServers?: ReadonlyArray<GatewayServer>
}

export interface PiLaunch {
  readonly argv: ReadonlyArray<string>
  /** Added to pi's environment in the Sandbox. */
  readonly env: Readonly<Record<string, string>>
}

/**
 * The command line that runs a Session's pi in its Sandbox, in the Workspace (ADR 0029).
 *
 * `--approve` trusts the Repo's own `.pi/` for the run, as a Claude Code Session takes the Repo's
 * settings. `--session-id` creates the conversation or resumes it, so starting and waking are the
 * same command. pi's state lives on the Session's `claude` volume, and pi makes no network calls
 * of its own at startup (`PI_OFFLINE`), and reports nothing to pi.dev (`PI_TELEMETRY`).
 *
 * With a Claude credential, the Claude bridge gets what Claude Code itself runs with: its state
 * directory, `IS_SANDBOX`, as it runs as root, and the pinned Claude Code.
 *
 * The Session's MCP servers go to the extension, which adds them to pi at the Gateway, as Claude
 * Code's are (ADR 0020): their Installations and names only, as pi reaches them with the Session
 * token it already has.
 */
export function piLaunch(options: PiLaunchOptions): PiLaunch {
  return {
    argv: [
      options.nodePath,
      options.cliPath,
      "--approve",
      "-e",
      posix.join(options.mod, piExtension),
      "--session-id",
      options.conversationId,
      ...(options.model === undefined ? [] : ["--model", options.model]),
      ...(options.thinkingLevel === undefined ? [] : ["--thinking", options.thinkingLevel]),
    ],
    env: {
      PI_CODING_AGENT_DIR: piStateGuestPath,
      PI_OFFLINE: "1",
      PI_TELEMETRY: "0",
      [ModEnvironment.sessionId]: options.sessionId,
      [ModEnvironment.conversationId]: options.conversationId,
      [HarnessVariable]: "Pi",
      ...(options.mcpServers?.length
        ? { [McpServersVariable]: JSON.stringify(options.mcpServers) }
        : {}),
      ...(options.claudePath === undefined
        ? {}
        : { ...claudeStateEnv, [ClaudeCodeVariable]: options.claudePath }),
    },
  }
}

/**
 * The variables kept out of pi's own process's environment: {@link KeptOutOfClaude}, and, without
 * its Creator's Claude credential, a setup token from anywhere else, as from a Variable, which
 * would have the Claude bridge spend someone else's (ADR 0026).
 */
export const keptOutOfPi = (credential: ClaudeCredential | undefined): ReadonlyArray<string> =>
  credential === undefined ? [...KeptOutOfClaude, ClaudeTokenVariable] : KeptOutOfClaude

/**
 * The environment pi and its extension run with in the Sandbox: `base`, what the Sandbox and the
 * launch give it, less {@link keptOutOfPi}, then the relay and the Session token for the
 * extension, and, when the Creator has one, their Claude credential for the Claude bridge, with
 * what keeps Claude Code quiet.
 */
export function piEnvironment(options: {
  readonly base: Readonly<Record<string, string>>
  /** The relay as the guest reaches it, such as `http://host.microsandbox.internal:7778`. */
  readonly relayUrl: string
  readonly sessionToken: Redacted.Redacted<string>
  /** The Session's Creator's, when the Hub gave it as the Session started or woke. */
  readonly credential?: ClaudeCredential
}): Record<string, string> {
  const env: Record<string, string> = { ...options.base }
  for (const name of keptOutOfPi(options.credential)) delete env[name]
  return {
    ...env,
    [ModEnvironment.hubUrl]: options.relayUrl,
    [ModEnvironment.modToken]: Redacted.value(options.sessionToken),
    ...(options.credential === undefined
      ? {}
      : { ...QuietClaude, [ClaudeTokenVariable]: Redacted.value(options.credential.token) }),
  }
}
