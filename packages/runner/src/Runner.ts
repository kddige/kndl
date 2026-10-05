import { Effect, Layer } from "effect"
import { claudeConfigPath, resolveRunnerLogin } from "./ClaudeConfig.ts"
import { ClaudeModelsLive } from "./ClaudeModels.ts"
import { ClaudeTrust, ClaudeTrustLive } from "./ClaudeTrust.ts"
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
 * The Runner: settles an update it restarted for (see Updater.ts), reads its Runner login, trusts
 * its sessions root, re-adopts the Sessions still running in tmux, and stays connected to the Hub.
 * Never ends on its own.
 */
export const runRunner = (
  options: { readonly claudeConfigPath?: string; readonly backoff?: Backoff } = {},
) =>
  Effect.gen(function* () {
    const config = yield* RunnerConfig
    const sessions = yield* Sessions
    const trust = yield* ClaudeTrust
    const configPath = options.claudeConfigPath ?? claudeConfigPath()
    yield* (yield* Updater).boot

    const login = yield* resolveRunnerLogin(config.login, configPath)
    yield* trust.ensure
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
 * Sessions on this host: Claude Code in tmux, Workspaces cloned and committed to with host git,
 * and each Session's tools run in its own microsandbox VM. The sessions root is kept trusted in
 * Claude Code's config file. Each Session is given a Session token for the credential proxy.
 */
export const SessionsHost = SessionsLive.pipe(
  Layer.provide([
    TmuxLive,
    WorkspacesGitClone,
    SessionSandboxesLive.pipe(Layer.provide(MicrosandboxBackend.layer)),
  ]),
  Layer.provideMerge(WorkspaceGitLive),
  Layer.provideMerge(HubGitLive),
  Layer.provideMerge(HubVariablesLive),
  Layer.provideMerge(ClaudeTrustLive(claudeConfigPath())),
  Layer.provideMerge(ClaudeModelsLive),
  Layer.provideMerge(HubLinkLive),
  Layer.provideMerge(CredentialProxyHost),
)
