import { MaxCommandWaitMs } from "@kndl/protocol"
import { Layer } from "effect"
import { AuthRoutes } from "./AuthRoutes.ts"
import { ChannelRoutes } from "./Channels.ts"
import { ClaudeCredentials } from "./ClaudeCredentials.ts"
import { CliLoginRoutes } from "./CliLoginRoutes.ts"
import { CliRoutes } from "./CliRoutes.ts"
import { CliTokens } from "./CliTokens.ts"
import { Environments } from "./Environments.ts"
import { ForwardRoutes } from "./ForwardRoutes.ts"
import { HealthRoute } from "./Health.ts"
import { HubShutdown } from "./HubShutdown.ts"
import { Members } from "./Members.ts"
import { ModOutbox } from "./ModOutbox.ts"
import { ModRoutes } from "./ModRoutes.ts"
import { ModTokens } from "./ModTokens.ts"
import { PairingCodes } from "./PairingCodes.ts"
import { PairingRoutes } from "./PairingRoutes.ts"
import { PermissionDrift } from "./PermissionDrift.ts"
import { PromptQueue } from "./PromptQueue.ts"
import { RepoAccess } from "./RepoAccess.ts"
import { Runners } from "./Runners.ts"
import { RunnerTokens } from "./RunnerTokens.ts"
import { RunnerUpdatePush } from "./RunnerUpdatePush.ts"
import { Secrets } from "./Secrets.ts"
import { SessionGit } from "./SessionGit.ts"
import { SessionLog } from "./SessionLog.ts"
import { SessionRelay } from "./SessionRelay.ts"
import { Sessions } from "./Sessions.ts"
import { SignIns } from "./SignIns.ts"
import { TunnelRoutes } from "./TunnelRoutes.ts"
import { Tunnels } from "./Tunnels.ts"
import { WebUiRoutes } from "./WebUi.ts"

/** Every route the Hub serves: its own, and the web UI's build on every other GET path. */
export const HubRoutes = Layer.mergeAll(
  HealthRoute,
  AuthRoutes,
  CliLoginRoutes,
  ChannelRoutes,
  CliRoutes,
  ForwardRoutes,
  ModRoutes,
  PairingRoutes,
  TunnelRoutes,
  WebUiRoutes,
)

/**
 * The credential stores, each person's Claude credential, the mod outbox, Environments, Repo
 * access, the GitHub App's permission check, the Pairing codes, the Session relay, the tunnels
 * waiting for their Runner and the shutdown signal the routes use, given a database, the GitHub App (GitHubApp.ts), the check of
 * Claude credentials (ClaudeCheck) and the Hub's version (HubVersion.ts).
 */
export const HubServices = SessionRelay.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(SessionGit.layer, RepoAccess.layer, PermissionDrift.layer, Members.layer),
  ),
  Layer.provideMerge(
    Layer.mergeAll(
      SignIns.layer,
      RunnerTokens.layer,
      ModTokens.layer,
      CliTokens.layer,
      ModOutbox.layer,
      Sessions.layer,
      SessionLog.layer,
      PromptQueue.layer,
      Runners.layer,
      PairingCodes.layer,
      HubShutdown.layer,
      Environments.layer,
      RunnerUpdatePush.layer,
      ClaudeCredentials.layer,
      Tunnels.layer,
    ),
  ),
  // Checks HUB_SECRETS_KEY against the Sensitive values stored, so a Hub with the wrong key
  // refuses to start.
  Layer.provideMerge(Secrets.layer),
)

/**
 * How long Bun keeps a quiet connection open, in seconds. Bun's default of 10 would cut off the
 * mod's long poll of `GET /mod/commands`, which can be quiet for MaxCommandWaitMs.
 */
export const idleTimeoutSeconds = Math.ceil(MaxCommandWaitMs / 1000) + 10

/**
 * The Hub's WebSockets, its channels and tunnels (#177): one quiet for `idleTimeout` seconds is
 * pinged, and closed only if the peer doesn't answer, so a tunnel to a quiet connection, such as
 * a WebSocket served in the Sandbox, stays up. Said here, not left to Bun's defaults.
 */
export const websocketOptions = { idleTimeout: 120, sendPings: true } as const
