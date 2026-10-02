import { Effect, FileSystem, Layer } from "effect"
import {
  claudeConfigPath,
  isTrusted,
  readClaudeConfig,
  resolveRunnerLogin,
} from "./ClaudeConfig.ts"
import { type Backoff, DefaultBackoff, runHubConnection } from "./HubConnection.ts"
import { HubLinkLive } from "./HubLink.ts"
import { RunnerConfig } from "./RunnerConfig.ts"
import { NoSandboxes } from "./Sandbox.ts"
import { Sessions, SessionsLive } from "./Sessions.ts"
import { TmuxLive } from "./Tmux.ts"
import { WorkspacesGitClone } from "./Workspace.ts"

/**
 * The Runner: reads its Runner login, re-adopts the Sessions still running in tmux, and stays
 * connected to the Hub. Ends only if the Hub turns it away for good.
 */
export const runRunner = (
  options: { readonly claudeConfigPath?: string; readonly backoff?: Backoff } = {},
) =>
  Effect.gen(function* () {
    const config = yield* RunnerConfig
    const sessions = yield* Sessions
    const fs = yield* FileSystem.FileSystem
    const configPath = options.claudeConfigPath ?? claudeConfigPath()

    const login = yield* resolveRunnerLogin(config.login, configPath)
    yield* fs.makeDirectory(config.sessionsRoot, { recursive: true })
    if (!isTrusted(yield* readClaudeConfig(configPath), config.sessionsRoot)) {
      yield* Effect.logWarning(
        `Claude Code does not trust ${config.sessionsRoot} yet, so each Session will ask. ` +
          `Run \`claude\` in that directory once and accept the trust prompt; every Session under it inherits that.`,
      )
    }
    yield* Effect.logInfo(
      `Runner ${config.name} (${login.account}) starting; Hub at ${config.hubUrl.href}`,
    )
    yield* sessions.adopt
    return yield* runHubConnection(login, options.backoff ?? DefaultBackoff)
  })

/**
 * Sessions on this host: Claude Code in tmux, Workspaces cloned with the host's git, and no
 * Sandbox yet (#9).
 */
export const SessionsHost = SessionsLive.pipe(
  Layer.provideMerge(HubLinkLive),
  Layer.provide([TmuxLive, WorkspacesGitClone, NoSandboxes]),
)
