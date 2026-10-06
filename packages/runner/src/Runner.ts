import { Effect, Layer } from "effect"
import { ClaudeModelsLive } from "./ClaudeModels.ts"
import { HubClaudeCredentialLive } from "./HubClaudeCredential.ts"
import { type Backoff, DefaultBackoff, runHubConnection } from "./HubConnection.ts"
import { HubGitLive } from "./HubGit.ts"
import { HubLinkLive } from "./HubLink.ts"
import { HubVariablesLive } from "./HubVariables.ts"
import { OpenPortsLive } from "./OpenPorts.ts"
import { CredentialProxyLive } from "./proxy/CredentialProxy.ts"
import { RunnerCredentialLive } from "./proxy/RunnerCredential.ts"
import { SessionTokensLive } from "./proxy/SessionTokens.ts"
import { RunnerConfig } from "./RunnerConfig.ts"
import * as MicrosandboxBackend from "./sandbox/MicrosandboxBackend.ts"
import { Sessions, SessionsLive } from "./Sessions.ts"
import { SessionSandboxesLive } from "./SessionSandboxes.ts"
import { TmuxLive } from "./Tmux.ts"
import { TunnelsLive } from "./Tunnels.ts"
import { Updater } from "./Updater.ts"
import { WorkspacesGitClone } from "./Workspace.ts"

/**
 * The Runner: settles an update it restarted for (see Updater.ts), takes up the Sessions an
 * earlier Runner left running, and stays connected to the Hub. Never ends on its own.
 */
export const runRunner = (options: { readonly backoff?: Backoff } = {}) =>
  Effect.gen(function* () {
    const config = yield* RunnerConfig
    const sessions = yield* Sessions
    yield* (yield* Updater).boot

    yield* Effect.logInfo(`Runner ${config.name} starting; Hub at ${config.hubUrl.href}`)
    yield* sessions.adopt
    return yield* runHubConnection(options.backoff ?? DefaultBackoff)
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
 * a Session token for the credential proxy, and its Workspace is cloned with host git. Tunnels into those Sandboxes (#177) share the Sessions' sandbox backend.
 */
export const SessionsHost = TunnelsLive.pipe(
  Layer.provideMerge(
    SessionsLive.pipe(
      Layer.provide([TmuxLive, WorkspacesGitClone, SessionSandboxesLive, OpenPortsLive]),
    ),
  ),
  Layer.provide(MicrosandboxBackend.layer),
  Layer.provideMerge(HubGitLive),
  Layer.provideMerge(HubVariablesLive),
  Layer.provideMerge(HubClaudeCredentialLive),
  Layer.provideMerge(ClaudeModelsLive),
  Layer.provideMerge(HubLinkLive),
  Layer.provideMerge(CredentialProxyHost),
)
