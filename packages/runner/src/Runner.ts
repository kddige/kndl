import { Effect, Layer } from "effect"
import { claudeConfigPath, resolveRunnerLogin } from "./ClaudeConfig.ts"
import { ClaudeModelsLive } from "./ClaudeModels.ts"
import { HubClaudeCredentialLive } from "./HubClaudeCredential.ts"
import { type Backoff, DefaultBackoff, runHubConnection } from "./HubConnection.ts"
import { HubGitLive } from "./HubGit.ts"
import { HubLinkLive } from "./HubLink.ts"
import { HubVariablesLive } from "./HubVariables.ts"
import { CredentialProxyLive } from "./proxy/CredentialProxy.ts"
import { RunnerCredentialLive } from "./proxy/RunnerCredential.ts"
import { SessionTokensLive } from "./proxy/SessionTokens.ts"
import { RunnerConfig } from "./RunnerConfig.ts"
import * as MicrosandboxBackend from "./sandbox/MicrosandboxBackend.ts"
import { Sessions, SessionsLive } from "./Sessions.ts"
import { SessionSandboxesLive } from "./SessionSandboxes.ts"
import { TmuxLive } from "./Tmux.ts"
import { Updater } from "./Updater.ts"
import { WorkspacesGitClone } from "./Workspace.ts"
import { WorkspaceGitLive } from "./WorkspaceGit.ts"

/**
 * The Runner: settles an update it restarted for (see Updater.ts), reads its Runner login, puts
 * to sleep the Sessions an earlier Runner left running, and stays connected to the Hub. Never ends on its own.
 */
export const runRunner = (
  options: { readonly claudeConfigPath?: string; readonly backoff?: Backoff } = {},
) =>
  Effect.gen(function* () {
    const config = yield* RunnerConfig
    const sessions = yield* Sessions
    const configPath = options.claudeConfigPath ?? claudeConfigPath()
    yield* (yield* Updater).boot

    const login = yield* resolveRunnerLogin(config.login, configPath)
    yield* Effect.logInfo(
      `Runner ${config.name} (${login.account}) starting; Hub at ${config.hubUrl.href}`,
    )
    yield* sessions.adopt
    return yield* runHubConnection(login, options.backoff ?? DefaultBackoff)
  })

/**
 * The credential proxy and mod relay for Sessions in Sandboxes, serving from the Runner's start,
 * over the Session tokens and the Runner's own Claude credential.
 */
export const CredentialProxyHost = CredentialProxyLive.pipe(
  Layer.provide([SessionTokensLive, RunnerCredentialLive]),
)

/**
 * Sessions on this host: each Session's Claude Code runs in tmux in its own microsandbox VM, with
 * a Session token for the credential proxy, and its Workspace is cloned and committed to with host
 * git.
 */
export const SessionsHost = SessionsLive.pipe(
  Layer.provide([TmuxLive, WorkspacesGitClone, SessionSandboxesLive]),
  Layer.provide(MicrosandboxBackend.layer),
  Layer.provideMerge(WorkspaceGitLive),
  Layer.provideMerge(HubGitLive),
  Layer.provideMerge(HubVariablesLive),
  Layer.provideMerge(HubClaudeCredentialLive),
  Layer.provideMerge(ClaudeModelsLive),
  Layer.provideMerge(HubLinkLive),
  Layer.provideMerge(CredentialProxyHost),
)
