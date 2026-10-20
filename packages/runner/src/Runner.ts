import { Effect, Layer } from "effect"
import { HubClaudeCredentialLive } from "./HubClaudeCredential.ts"
import { type Backoff, DefaultBackoff, runHubConnection } from "./HubConnection.ts"
import { HubGitLive } from "./HubGit.ts"
import { HubLinkLive } from "./HubLink.ts"
import { HubVariablesLive } from "./HubVariables.ts"
import { OpenPortsLive } from "./OpenPorts.ts"
import { PiBundleLive } from "./PiBundle.ts"
import { ModRelayLive } from "./relay/ModRelay.ts"
import { SessionTokensLive } from "./relay/SessionTokens.ts"
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

/** The mod relay for Sessions in Sandboxes, serving from the Runner's start, over the Session tokens. */
export const ModRelayHost = ModRelayLive.pipe(Layer.provide(SessionTokensLive))

/**
 * Sessions on this host: each Session's durable agent runs in tmux in its own microsandbox VM,
 * beside a shell for its terminal, with a Session token for the mod relay and, for its Claude
 * bridge, its Creator's setup token, and its Workspace is cloned with host git. Tunnels into those
 * Sandboxes (#177) share the Sessions' sandbox backend.
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
  Layer.provideMerge(PiBundleLive),
  Layer.provideMerge(HubLinkLive),
  Layer.provideMerge(ModRelayHost),
)
