// kndl's Claude bridge (ADR 0029, docs/design/durable-harness.md): Claude's Models in a Session's
// durable agent, run by Claude Code in the Sandbox on the Session's Creator's Claude credential, as
// a model only, with the agent's tools.
//
// A pi-ai provider for `anthropic`, which the agent sets on its Models (`setProvider`). It runs
// the pinned Claude Code through the Agent SDK with `tools: []`, serves the agent's tools to it
// over in-process MCP, holds each tool call open across the run's requests, and mirrors each
// conversation into a Claude Code session to resume (Bridge.ts).
//
// kndl's own port of pi-claude-bridge 0.9.3 by Eli Dickinson (MIT; its notice is in
// THIRD_PARTY_NOTICES.md), by way of the pi extension's (`packages/mod/pi/src/claude/`). Left out:
// its AskClaude tool, its config file (the Runner's environment says all there is), and its startup
// notices. Changed: a message the caller holds is never changed again (QueryState.ts), which the
// reference broke after an abort (docs/research/claude-bridge-spike.md).

import { join } from "node:path"
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk"
import { createProvider } from "@earendil-works/pi-ai"
import type { Api, Model, Provider } from "@earendil-works/pi-ai"
import { createBridge } from "./Bridge.ts"
import type { Bridge, QueryFn } from "./Bridge.ts"
import { createLog } from "./Log.ts"
import { anthropicCatalogue, claudeModels } from "./Models.ts"
import type { CatalogueModel, ListedModel } from "./Models.ts"
import { ClaudeProvider } from "./Names.ts"
import { SessionMirrors } from "./SessionMirror.ts"
import {
  ClaudeCodeVariable,
  claudeCodeEnvironment,
  ClaudeConfigVariable,
  ClaudeDebugVariable,
  ClaudeTokenVariable,
} from "./Settings.ts"

export type { ClaudeQuery, QueryFn } from "./Bridge.ts"
export type { ListedModel } from "./Models.ts"
export { ClaudeApi, ClaudeProvider } from "./Names.ts"

/** How long a query held at a tool call waits for the request bringing its results, by default. */
export const DefaultIdleQueryMs = 30 * 60_000

export interface ClaudeBridgeOptions {
  /** The pinned Claude Code's executable (`KNDL_CLAUDE_CODE`), never the SDK's bundled one. */
  readonly claudeCodePath: string
  /**
   * Claude Code's state directory (`CLAUDE_CONFIG_DIR`), on the Session's volume: the bridge's
   * Claude Code sessions live there, and which conversation each mirrors.
   */
  readonly configDir: string
  /** The Session's Creator's setup token (`CLAUDE_CODE_OAUTH_TOKEN`). */
  readonly oauthToken: string
  /**
   * Where Claude Code runs: the Workspace, or each conversation's own directory, by its provider
   * session id (Pi Durable's `pi.provider` document); undefined for a call that names none.
   */
  readonly cwd: string | ((sessionId: string | undefined) => string)
  /**
   * The Claude Models the Hub listed for the Creator (`/mod/providers`), in its order: each one
   * pi-ai's catalogue knows is listed, at the context window Claude Code serves it at, and at no
   * price. One of another Provider is skipped.
   */
  readonly models: ReadonlyArray<ListedModel>
  /** pi-ai's `anthropic` catalogue; pi-ai's own by default. */
  readonly catalogue?: ReadonlyArray<CatalogueModel>
  /**
   * The environment Claude Code's is made from, less what would sign it in otherwise, send it
   * elsewhere or reach the Hub (Settings.ts); the process's by default.
   */
  readonly env?: Readonly<Record<string, string | undefined>>
  /** Writes the bridge's debug log, as `KNDL_CLAUDE_DEBUG=1` asks. */
  readonly debug?: boolean
  /** The debug log; `kndl-claude-bridge.log` in `configDir` by default. */
  readonly logPath?: string
  /** What should never happen; to stderr by default. */
  readonly report?: (text: string) => void
  /** A notice for the people watching the Session: a rate limit reached or near. */
  readonly onNotice?: (text: string, level: "info" | "warning" | "error") => void
  /** How long a query held at a tool call waits for its results; {@link DefaultIdleQueryMs}. */
  readonly idleQueryMs?: number
  /** How a query starts: the SDK's query(), or a test's fake Claude Code. */
  readonly query?: QueryFn
}

/** The bridge's provider: pi-ai's, and what ends the Claude Codes it holds. */
export type ClaudeBridgeProvider = Provider & {
  /** The Models it lists, as `getModels()` does. */
  readonly models: ReadonlyArray<Model<Api>>
  /** The Hub's Claude Models that pi-ai's catalogue doesn't know, so it can't run. */
  readonly missing: ReadonlyArray<string>
  /**
   * The conversation of provider session id `sessionId` is gone (a thread deleted): its held
   * query, if any, is stopped, and its Claude Code session deleted.
   */
  forget(sessionId: string): void
  /** Stops every query, and waits for their Claude Codes to exit: before the agent exits. */
  close(): Promise<void>
}

/**
 * The bridge's options from the durable agent's environment, as the Runner sets it, with the
 * Models and directory the agent gives; undefined when the Session's Creator has no Claude
 * credential (no setup token) or the Runner gave no Claude Code: then the Session has no Claude
 * Models (ADR 0026: a Session spends only its Creator's).
 */
export function claudeBridgeOptionsFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  rest: Omit<ClaudeBridgeOptions, "claudeCodePath" | "configDir" | "oauthToken" | "debug">,
): ClaudeBridgeOptions | undefined {
  const oauthToken = env[ClaudeTokenVariable]
  const claudeCodePath = env[ClaudeCodeVariable]
  const configDir = env[ClaudeConfigVariable]
  if (!oauthToken || !claudeCodePath || !configDir) return undefined
  return {
    env,
    ...rest,
    claudeCodePath,
    configDir,
    oauthToken,
    debug: env[ClaudeDebugVariable] === "1",
  }
}

/**
 * The `anthropic` provider for the Claude Models the Hub listed, run through Claude Code, for
 * `models.setProvider()`. Its api is its own (`kndl-claude-code`), and its auth is the setup
 * token, which it reports configured.
 */
export function createClaudeBridgeProvider(options: ClaudeBridgeOptions): ClaudeBridgeProvider {
  const log = createLog({
    debug: options.debug ?? false,
    path: options.logPath ?? join(options.configDir, "kndl-claude-bridge.log"),
    report: options.report ?? ((text) => process.stderr.write(`${text}\n`)),
  })
  const { models, missing } = claudeModels(
    options.models,
    options.catalogue ?? anthropicCatalogue(),
  )
  if (missing.length > 0)
    log.diag("unknown_models", { missing, note: "pi-ai's catalogue doesn't know them" })
  const cwd = options.cwd
  const bridge: Bridge = createBridge({
    claudeCodePath: options.claudeCodePath,
    childEnv: {
      ...claudeCodeEnvironment(options.env ?? process.env),
      [ClaudeTokenVariable]: options.oauthToken,
      [ClaudeConfigVariable]: options.configDir,
    },
    cwd: typeof cwd === "string" ? () => cwd : cwd,
    mirrors: new SessionMirrors({
      claudeDir: options.configDir,
      log,
      savePath: join(options.configDir, "kndl-claude-bridge", "sessions.json"),
    }),
    log,
    notice: options.onNotice ?? (() => {}),
    query: options.query ?? sdkQuery,
    idleQueryMs: options.idleQueryMs ?? DefaultIdleQueryMs,
  })
  const provider = createProvider({
    id: ClaudeProvider,
    name: "Claude (Claude Code)",
    // Claude Code signs in with the setup token itself: there's nothing for pi-ai to add to a
    // request, only to say the provider is configured, without which it refuses every request.
    auth: {
      apiKey: {
        name: "Claude Code",
        resolve: async () =>
          options.oauthToken ? { auth: {}, source: ClaudeTokenVariable } : undefined,
      },
    },
    models,
    api: { stream: bridge.streamSimple, streamSimple: bridge.streamSimple },
  })
  return Object.assign(provider, {
    models,
    missing,
    forget: bridge.forget,
    close: bridge.close,
  })
}
